package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"testing"
)

func TestWENNativeClaimConfiguredExecution(t *testing.T) {
	for _, mode := range []string{"execute-success", "execute-lost-success", "execute-failed", "execute-uncertain", "network-change"} {
		t.Run(mode, func(t *testing.T) {
			key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{17}, 32))
			wallet := solana.PublicKeyFromBytes(key.Public().(ed25519.PublicKey))
			v, pins, reader := nativeExecutorFixture(t, wallet)
			v.MaxRentLamports = "1000"
			raw, dp := nativeClaimDescriptorFixture(t, "ok")
			var d map[string]any
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.UseNumber()
			if e := dec.Decode(&d); e != nil {
				t.Fatal(e)
			}
			dep := d["deployment"].(map[string]any)["ownerClaim"].(map[string]any)
			p := solana.MustPublicKeyFromBase58(v.ProgramID)
			dep["program"] = hex.EncodeToString(p[:])
			dep["genesis"] = v.Genesis
			dep["deploymentSlot"] = "1"
			dep["deployedBytesHash"] = pins.CodeSHA256
			dep["upgradeAuthority"] = nil
			delete(d, "descriptorDigest")
			raw, _ = wenJSONV1(d)
			d["descriptorDigest"] = "sha256:" + wenHashV1(raw)
			raw, _ = wenJSONV1(d)
			pins.DescriptorSHA256 = wenHashV1(raw)
			pins.CapabilitySHA256 = dp.CapabilitySHA256
			v.DescriptorSHA256 = pins.DescriptorSHA256
			v.CapabilitySHA256 = pins.CapabilitySHA256
			store, keyManager := openTestSignerV2(t)
			db := store.db.Path()
			root := filepath.Join(filepath.Dir(db), "wen-native-claim", wenHashV1([]byte("miner")))
			if e := os.MkdirAll(root, 0700); e != nil {
				t.Fatal(e)
			}
			descriptor := filepath.Join(root, pins.DescriptorSHA256)
			if e := os.WriteFile(descriptor, raw, 0600); e != nil {
				t.Fatal(e)
			}
			review := wenNativeClaimReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: wallet.String(), Intent: v, Policy: solana.PublicKey{6}.String(), Pins: pins, MaxSlotLag: 2, MaxTotalCostLamports: 6000}
			reviewPath := filepath.Join(root, wenNativeClaimAdmissionNameV1(v))
			write := func() {
				b, _ := json.Marshal(review)
				if e := os.WriteFile(reviewPath, b, 0600); e != nil {
					t.Fatal(e)
				}
			}
			write()

			_, _, e := keyManager.storeNewKeyWithPolicy("miner", solana.PrivateKey(key), signerPolicyV2{WalletID: "miner", Role: "agent", Operations: []string{intentWENNativeClaimV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "6000", MaxDaily: "6000"}}}, 0)
			if e != nil {
				t.Fatal(e)
			}
			for _, scope := range []string{wenMiningNativeScopeV1("miner", v.Genesis), wenNativeClaimLaunchScopeV1("miner", v)} {
				if e = store.configureWENBudgetV1(scope, 6000); e != nil {
					t.Fatal(e)
				}
			}
			endpoint := "https://native-claim-fixture.invalid"
			keyManager.genesisHash = func(string) (string, error) { return v.Genesis, nil }
			if _, e = keyManager.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
				t.Fatal(e)
			}
			c := &nativeClaimExecutorFake{nativeJoinedCostFake: &nativeJoinedCostFake{nativeClaimCostFake: &nativeClaimCostFake{t: t}, reader: reader}, store: store, mode: mode}
			service := &signerServiceV2{store: store, keys: keyManager}
			cfg := signerConfig{stateDBPath: db, chains: []string{"solana"}}
			digest, outcome, e := service.executeConfiguredNativeClaimWithFactoryV1(context.Background(), cfg, "execution-claim", "miner", v, func(selected string) wenNativeClaimExecutionRPCV1 {
				if selected != endpoint {
					t.Fatal("caller replaced endpoint")
				}
				if mode == "network-change" {
					if _, e := keyManager.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://changed-native.invalid"}); e != nil {
						t.Fatal(e)
					}
				}
				return c
			})
			if mode == "network-change" {
				if e == nil || digest != "" || c.sends != 0 {
					t.Fatal("changed network executed", digest, outcome, e)
				}
				return
			}
			if digest == "" || c.sends != 1 {
				t.Fatal("execution identity/send", digest, c.sends, e)
			}
			wantOutcome := "finalized-success"
			want := uint64(5500)
			if mode == "execute-failed" {
				wantOutcome = "finalized-failed"
				want = 5000
			}
			if mode == "execute-uncertain" {
				wantOutcome = "submission-uncertain"
				want = 6000
			}
			if outcome != wantOutcome {
				t.Fatalf("outcome %s want %s: %v", outcome, wantOutcome, e)
			}
			if (e != nil) != (mode == "execute-uncertain") {
				t.Fatal(e)
			}
			if _, e = store.recoverWENNativeClaimExecutionV1(context.Background(), c, "execution-claim", digest); e != nil {
				t.Fatal(e)
			}
			if c.sends != 1 {
				t.Fatal("recovery resent")
			}
			if e = store.db.View(func(tx *bolt.Tx) error {
				for _, scope := range []string{wenMiningNativeScopeV1("miner", v.Genesis), wenNativeClaimLaunchScopeV1("miner", v)} {
					var b wenBudgetBalanceV1
					if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &b); e != nil {
						return e
					}
					if b.Reserved != want {
						t.Fatal("retained budget", b.Reserved, want)
					}
				}
				return nil
			}); e != nil {
				t.Fatal(e)
			}
			if _, _, e = service.executeConfiguredNativeClaimWithFactoryV1(context.Background(), cfg, "execution-claim", "miner", v, func(string) wenNativeClaimExecutionRPCV1 { return c }); e == nil {
				t.Fatal("duplicate execution")
			}
			if c.sends != 1 {
				t.Fatal("duplicate send")
			}
		})
	}
}
