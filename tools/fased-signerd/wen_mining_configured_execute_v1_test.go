package main

import (
	"context"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"os"
	"path/filepath"
	"testing"
)

type miningConfiguredHook struct {
	*miningExecutionFake
	at     int
	change func()
}

func (c *miningConfiguredHook) SimulateRawTransactionWithOpts(ctx context.Context, b []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	result, e := c.miningExecutionFake.SimulateRawTransactionWithOpts(ctx, b, o)
	if c.change != nil && c.simulations == c.at {
		c.change()
	}
	return result, e
}
func TestWENMiningConfiguredExecutionV1(t *testing.T) {
	for _, op := range []string{"commit", "reveal"} {
		for _, mode := range []string{"valid", "state", "chain", "missing-network", "genesis", "nil-client", "network-prepare", "network-pre-sign", "network-post-sign", "policy-post-sign", "review-post-sign", "descriptor-missing", "descriptor-prepare", "descriptor-pre-sign", "descriptor-post-sign"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				store, keys := openTestSignerV2(t)
				base := miningFixture(t)
				record, old := createTestSignerWalletV2(t, store, keys, "miner", base.Intent.Economy, 100, 100)
				wallet := solana.MustPublicKeyFromBase58(record.PublicKey)
				f := miningWalletFixture(t, wallet)
				policy, e := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: "agent", Operations: []string{intentWENMiningV1 + "." + op}, Programs: []string{f.Intent.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{f.Intent.Economy}, MaxPerTx: "5000", MaxDaily: "10000"}}}, old.Version)
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
				if mode == "genesis" {
					keys.genesisHash = func(string) (string, error) { return "11111111111111111111111111111111", nil }
				}
				const endpoint = "https://mining-configured.invalid"
				if mode != "missing-network" {
					if _, e = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
						t.Fatal(e)
					}
				}
				cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
				if mode == "state" {
					cfg.stateDBPath += "-other"
				}
				if mode == "chain" {
					cfg.chains = []string{"ethereum"}
				}
				client := &miningConfiguredHook{miningExecutionFake: &miningExecutionFake{miningPrepareFake: prep, store: store, request: "mining-execution", failure: "success"}}
				switch mode {
				case "network-prepare", "descriptor-prepare":
					client.at = 1
				case "network-pre-sign", "descriptor-pre-sign":
					client.at = 2
				case "network-post-sign", "policy-post-sign", "review-post-sign", "descriptor-post-sign":
					client.at = 3
				}
				client.change = func() {
					if mode == "descriptor-prepare" || mode == "descriptor-pre-sign" || mode == "descriptor-post-sign" {
						if e = os.Remove(filepath.Join(root, pins.DescriptorSHA256)); e != nil {
							t.Fatal(e)
						}
						return
					}
					if mode == "policy-post-sign" {
						policy.Operations = []string{"solana.nativeTransfer"}
						if _, e = store.putPolicy(policy, policy.Version); e != nil {
							t.Fatal(e)
						}
						return
					}
					if mode == "review-post-sign" {
						if e = os.Remove(filepath.Join(root, "admission.json")); e != nil {
							t.Fatal(e)
						}
						return
					}
					if _, e = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://different.invalid"}); e != nil {
						t.Fatal(e)
					}
				}
				if mode == "descriptor-missing" {
					if e = os.Remove(filepath.Join(root, pins.DescriptorSHA256)); e != nil {
						t.Fatal(e)
					}
				}
				service := &signerServiceV2{store: store, keys: keys}
				called := false
				_, status, e := service.executeConfiguredMiningWithFactoryV1(context.Background(), cfg, client.request, "miner", v, func(selected string) wenMiningExecutionRPCV1 {
					called = true
					if selected != endpoint {
						t.Fatal("endpoint override")
					}
					if mode == "nil-client" {
						return nil
					}
					return client
				})
				if mode == "valid" {
					if e != nil || status != "finalized-success" || client.sends != 1 {
						t.Fatal("configured execution", status, e)
					}
					if op == "commit" {
						testMiningRevealProposal(t, store, client.request)
						testMiningHandoff(t, service, cfg, client, v)
					}
					return
				}
				if e == nil || client.sends != 0 {
					t.Fatal("configuration change accepted", status, e)
				}
				if client.at > 0 {
					expected := "reserved"
					if client.at == 2 {
						expected = "signing"
					}
					if client.at == 3 {
						expected = "signed"
					}
					if status != expected {
						t.Fatal("unexpected signature boundary", status, expected)
					}
				} else if mode != "nil-client" && called {
					t.Fatal("invalid configuration reached RPC factory")
				}
			})
		}
	}
}
