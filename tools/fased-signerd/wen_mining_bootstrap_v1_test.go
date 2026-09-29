package main

import (
	"context"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"path/filepath"
	"testing"
)

func TestWENMiningBootstrapV1(t *testing.T) {
	for _, mode := range []string{"valid", "application", "readonly", "wallet", "descriptor", "missing-preimage", "conflict", "symlink", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			store, keys := openTestSignerV2(t)
			base := miningFixture(t)
			record, _ := createTestSignerWalletV2(t, store, keys, "miner", base.Intent.Economy, 100, 100)
			f := miningWalletFixture(t, solana.MustPublicKeyFromBase58(record.PublicKey))
			prep, pins, v := miningPrepareSetup(t, f, "commit", "ok")
			descriptor, pins := miningDescriptorFixture(t, pins)
			v.DescriptorSHA256 = pins.DescriptorSHA256
			v.CapabilitySHA256 = pins.CapabilitySHA256
			review := wenMiningReviewV1{Version: 2, WalletID: "miner", WalletPublicKey: f.Wallet, Intent: v, Pins: pins, MaxSlotLag: 2}
			root := filepath.Join(filepath.Dir(store.db.Path()), "wen-mining", wenHashV1([]byte("miner")))
			if e := os.MkdirAll(root, 0700); e != nil {
				t.Fatal(e)
			}
			secret, e := os.ReadFile(filepath.Join(prep.root, f.PreimageKey+".json"))
			if e != nil {
				t.Fatal(e)
			}
			defer zeroBytes(secret)
			if mode != "missing-preimage" {
				if e = os.WriteFile(filepath.Join(root, f.PreimageKey+".json"), secret, 0600); e != nil {
					t.Fatal(e)
				}
			}
			keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
			if _, e = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: "https://bootstrap.invalid"}); e != nil {
				t.Fatal(e)
			}
			cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
			body := wenMiningBootstrapV1{Review: review, Descriptor: descriptor}
			target := filepath.Join(root, wenMiningAdmissionNameV2(v))
			switch mode {
			case "readonly":
				cfg.readOnly = true
			case "wallet":
				body.Review.WalletPublicKey = base.Wallet
			case "descriptor":
				body.Descriptor = []byte("{}")
			case "conflict":
				if e = os.WriteFile(target, []byte("{}"), 0600); e != nil {
					t.Fatal(e)
				}
			case "symlink":
				if e = os.Symlink("unrelated", target); e != nil {
					t.Fatal(e)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancelled" {
				cancel()
			}
			client := &miningExecutionFake{miningPrepareFake: prep, store: store, request: "bootstrap", failure: "success"}
			service := &signerServiceV2{store: store, keys: keys}
			factory := func(string) wenMiningExecutionRPCV1 { return client }
			receipt, e := service.installMiningBootstrapV1(ctx, cfg, "miner", body, mode != "application", factory)
			if (e == nil) != (mode == "valid") {
				t.Fatal("bootstrap result", e)
			}
			if client.sends != 0 || client.simulations != 0 {
				t.Fatal("review performed transaction work")
			}
			if mode == "valid" {
				expected, _ := json.Marshal(review)
				if receipt.ReviewSHA256 != wenHashV1(expected) || receipt.SigningEnabled {
					t.Fatal("receipt mismatch")
				}
				again, e := service.installMiningBootstrapV1(ctx, cfg, "miner", body, true, factory)
				if e != nil || again != receipt {
					t.Fatal("retry", e)
				}
			} else if mode == "conflict" {
				raw, _ := os.ReadFile(target)
				if string(raw) != "{}" {
					t.Fatal("conflict replaced")
				}
			} else if mode == "symlink" {
				if link, e := os.Readlink(target); e != nil || link != "unrelated" {
					t.Fatal("symlink changed")
				}
			} else if _, e := os.Lstat(target); !os.IsNotExist(e) {
				t.Fatal("invalid request published review")
			}
		})
	}
}
