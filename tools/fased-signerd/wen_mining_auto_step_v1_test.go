package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWENMiningAutoStepV1(t *testing.T) {
	for _, op := range []string{"commit", "reveal"} {
		for _, mode := range []string{"valid", "missing", "failed", "signing", "cancelled", "corrupt", "scope", "waiting", "expired", "wake"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				store, keys := openTestSignerV2(t)
				base := miningFixture(t)
				record, old := createTestSignerWalletV2(t, store, keys, "miner", base.Intent.Economy, 100, 100)
				wallet := solana.MustPublicKeyFromBase58(record.PublicKey)
				f := miningWalletFixture(t, wallet)
				_, e := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: "agent", Operations: []string{intentWENMiningV1 + "." + op}, Programs: []string{f.Intent.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{f.Intent.Economy}, MaxPerTx: "5000", MaxDaily: "10000"}}}, old.Version)
				if e != nil {
					t.Fatal(e)
				}
				if e = store.configureWENBudgetV1(wenMiningNativeScopeV1("miner", f.Intent.Genesis), 10000); e != nil {
					t.Fatal(e)
				}
				prep, pins, v := miningPrepareSetup(t, f, op, "ok")
				descriptor, pins := miningDescriptorFixture(t, pins)
				v.DescriptorSHA256 = pins.DescriptorSHA256
				v.CapabilitySHA256 = pins.CapabilitySHA256
				review := wenMiningReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: f.Wallet, Intent: v, Pins: pins, MaxSlotLag: 2}
				root := writeMiningReviewFixture(t, store.db.Path(), review)
				if e = os.WriteFile(filepath.Join(root, pins.DescriptorSHA256), descriptor, 0600); e != nil {
					t.Fatal(e)
				}
				raw, e := os.ReadFile(filepath.Join(prep.root, f.PreimageKey+".json"))
				if e != nil {
					t.Fatal(e)
				}
				if e = os.WriteFile(filepath.Join(root, f.PreimageKey+".json"), raw, 0600); e != nil {
					t.Fatal(e)
				}
				prep.root = root
				keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
				const endpoint = "https://mining-configured.invalid"
				if mode != "missing-network" {
					if _, e = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
						t.Fatal(e)
					}
				}
				cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
				client := &miningConfiguredHook{miningExecutionFake: &miningExecutionFake{miningPrepareFake: prep, store: store, request: "mining-execution", failure: mode}}

				if mode == "waiting" || mode == "expired" || mode == "wake" {
					clock := append([]byte(nil), prep.page.Value[3].Data.GetBinary()...)
					now := uint64(999)
					if mode == "expired" {
						now = 1900
					}
					binary.LittleEndian.PutUint64(clock[32:], now)
					prep.page.Value[3].Data = rpc.DataBytesOrJSONFromBytes(clock)
				}
				service := &signerServiceV2{store: store, keys: keys}

				step := func(context.Context) (string, string, error) {
					return service.stepConfiguredMiningWithFactoryV1(context.Background(), cfg, client.request, "miner", v, func(selected string) wenMiningExecutionRPCV1 {
						if selected != endpoint {
							t.Fatal("endpoint override")
						}

						return client
					})
				}
				var digest, status string
				if mode == "wake" {
					waits := 0
					digest, status, e = runWENMiningOperationV1(context.Background(), time.Second, 2, step, func(context.Context, time.Duration) error {
						waits++
						if client.sends != 0 || client.simulations != 0 {
							t.Fatal("work before phase")
						}
						clock := append([]byte(nil), prep.page.Value[3].Data.GetBinary()...)
						now := uint64(1000)
						if op == "reveal" {
							now = 1180
						}
						binary.LittleEndian.PutUint64(clock[32:], now)
						prep.page.Value[3].Data = rpc.DataBytesOrJSONFromBytes(clock)
						return nil
					})
					if waits != 1 {
						t.Fatal("missing wakeup")
					}
				} else {
					digest, status, e = step(context.Background())
				}

				if mode == "waiting" || mode == "expired" {
					want := "waiting-open"
					if mode == "expired" {
						want = "expired"
					}
					if e != nil || status != want || client.sends != 0 || client.simulations != 0 {
						t.Fatal("idle phase did work", status, e)
					}
					if e = store.db.View(func(tx *bolt.Tx) error {
						if tx.Bucket(wenBudgetBucketV1).Get([]byte("request:"+client.request)) != nil {
							t.Fatal("idle phase reserved fees")
						}
						return nil
					}); e != nil {
						t.Fatal(e)
					}
					return
				}

				if mode != "missing" && e != nil {
					t.Fatal("initial step", status, e)
				}
				if client.sends != 1 {
					t.Fatal("initial send count")
				}
				if mode == "missing" {
					client.failure = "success"
				}
				if mode == "signing" || mode == "cancelled" || mode == "corrupt" || mode == "scope" {
					if e = store.db.Update(func(tx *bolt.Tx) error {
						b := tx.Bucket(wenBudgetBucketV1)
						var saved wenBudgetReservationV1
						if e := json.Unmarshal(b.Get([]byte("request:"+client.request)), &saved); e != nil {
							return e
						}
						switch mode {
						case "signing":
							saved.State = "signing"
							saved.Signature = ""
						case "cancelled":
							saved.State = "cancelled"
						case "corrupt":
							saved.Digest = "bad"
						case "scope":
							saved.WalletID = "other"
						}
						raw, _ := json.Marshal(saved)
						return b.Put([]byte("request:"+client.request), raw)
					}); e != nil {
						t.Fatal(e)
					}
				}
				// Recovery survives a master-key reopen and removed review. It
				// must not load a wallet private key, simulate or send again.
				keys.Close()
				keys, e = openSignerKeyManagerV2(store, filepath.Join(filepath.Dir(store.db.Path()), "master.key"))
				if e != nil {
					t.Fatal(e)
				}
				defer keys.Close()
				service.keys = keys
				keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
				if e = os.Remove(filepath.Join(root, "admission.json")); e != nil {
					t.Fatal(e)
				}
				if e = os.Remove(filepath.Join(root, pins.DescriptorSHA256)); e != nil {
					t.Fatal(e)
				}
				simulations := client.simulations
				nextDigest, nextStatus, e := service.stepConfiguredMiningWithFactoryV1(context.Background(), cfg, "different-request", "miner", v, func(selected string) wenMiningExecutionRPCV1 {
					if selected != endpoint {
						t.Fatal("wrong recovery endpoint")
					}
					return client
				})
				if mode == "corrupt" || mode == "scope" {
					if e == nil {
						t.Fatal("invalid journal accepted")
					}
				} else {
					expected := "finalized-success"
					if mode == "failed" {
						expected = "finalized-failed"
					}
					if mode == "signing" {
						expected = "recovery-required"
					}
					if mode == "cancelled" {
						expected = "cancelled"
					}
					if e != nil || nextStatus != expected || nextDigest != digest {
						t.Fatal("recovery step", nextStatus, e)
					}
				}
				if client.sends != 1 || client.simulations != simulations {
					t.Fatal("recovery executed new work")
				}
			})
		}
	}
}
