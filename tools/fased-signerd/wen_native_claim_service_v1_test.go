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

func TestWENNativeClaimConfiguredPreview(t *testing.T) {
	for _, mode := range []string{"success", "network-change", "review-change", "cancelled", "wrong-db", "disallowed-chain"} {
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
			c := &nativeClaimExecutorFake{nativeJoinedCostFake: &nativeJoinedCostFake{nativeClaimCostFake: &nativeClaimCostFake{t: t}, reader: reader}, store: store}
			service := &signerServiceV2{store: store, keys: keyManager}
			cfg := signerConfig{stateDBPath: db, chains: []string{"solana"}}
			if mode == "wrong-db" {
				cfg.stateDBPath += ".other"
			}
			if mode == "disallowed-chain" {
				cfg.chains = []string{"ethereum"}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancelled" {
				cancel()
			}
			snapshot := func() []byte {
				var b bytes.Buffer
				if err := store.db.View(func(tx *bolt.Tx) error { _, err := tx.WriteTo(&b); return err }); err != nil {
					t.Fatal(err)
				}
				return b.Bytes()
			}
			before := snapshot()
			selectedCount := 0
			result, err := service.prepareConfiguredNativeClaimWithFactoryV1(ctx, cfg, "miner", v, func(selected string) wenStakingPrepareRPCV1 {
				selectedCount++
				if selected != endpoint {
					t.Fatal("caller replaced endpoint")
				}
				if mode == "network-change" {
					if _, e := keyManager.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://changed-native.invalid"}); e != nil {
						t.Fatal(e)
					}
				}
				if mode == "review-change" {
					review.MaxTotalCostLamports--
					write()
				}
				return c
			})
			if c.sends != 0 {
				t.Fatal("preview sent transaction")
			}
			if mode != "network-change" && !bytes.Equal(before, snapshot()) {
				t.Fatal("preview mutated signer database")
			}
			if mode != "success" {
				if err == nil || result != (wenNativeClaimServicePreviewV1{}) {
					t.Fatal("invalid preview admitted", result, err)
				}
				if (mode == "wrong-db" || mode == "disallowed-chain") && selectedCount != 0 {
					t.Fatal("invalid configuration reached RPC")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.Operation != "native-staking-claim" || result.SigningEnabled || result.Status != "requires-signing-revalidation" || result.DescriptorSHA256 != v.DescriptorSHA256 || result.NetworkFee != 5000 || result.Rent != 1000 || result.GrossSAT == 0 || result.TransferFeeSAT == 0 || result.NetSAT+result.TransferFeeSAT != result.GrossSAT || len(result.MessageSHA256) != 64 {
				t.Fatal("wrong preview", result)
			}
			wire, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]any
			if err = json.Unmarshal(wire, &fields); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"slot", "networkFeeLamports", "rentLamports", "grossSatRaw", "transferFeeSatRaw", "netSatRaw", "computeUnits"} {
				if _, ok := fields[name].(string); !ok {
					t.Fatal("non-string quantity", name)
				}
			}
			if len(fields) != 12 {
				t.Fatal("unexpected preview fields", fields)
			}
		})
	}
}
