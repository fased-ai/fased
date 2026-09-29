package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWENMiningClaimBootstrap(t *testing.T) {
	_, _, pins, _ := miningClaimRPCFixture(t, "sol")
	raw, pins := miningClaimReviewDescriptor(t, pins)
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "fresh", "symlink", "permissions", "application", "readonly", "descriptor", "state", "wallet", "budget", "lag", "network-change", "conflict", "cancelled"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				store, keys, v, _, client := miningClaimExecutionFixture(t, raw, pins, op, "success")
				service := &signerServiceV2{store: store, keys: keys}
				cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
				root := filepath.Join(filepath.Dir(store.db.Path()), "wen-mining-claim", wenHashV1([]byte("miner")))
				path := filepath.Join(root, wenMiningClaimAdmissionNameV1(v))
				original, e := os.ReadFile(path)
				if e != nil {
					t.Fatal(e)
				}
				var review wenMiningClaimReviewV1
				if json.Unmarshal(original, &review) != nil {
					t.Fatal("review")
				}
				body := wenMiningClaimBootstrapV1{Review: review, Descriptor: append([]byte(nil), raw...)}
				if e = os.Remove(path); e != nil {
					t.Fatal(e)
				}
				if mode == "fresh" || mode == "symlink" {
					if e = os.RemoveAll(root); e != nil {
						t.Fatal(e)
					}
					if mode == "symlink" {
						if e = os.Symlink(t.TempDir(), root); e != nil {
							t.Fatal(e)
						}
					}
				}
				if mode == "permissions" {
					if e = os.Chmod(root, 0755); e != nil {
						t.Fatal(e)
					}
				}
				if mode == "conflict" {
					if e = os.WriteFile(path, []byte("{}"), 0600); e != nil {
						t.Fatal(e)
					}
				}
				keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
				endpoint := "https://claim-review.invalid"
				if _, e = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
					t.Fatal(e)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				switch mode {
				case "readonly":
					cfg.readOnly = true
				case "descriptor":
					body.Descriptor[0] ^= 1
				case "state":
					body.Review.Intent.AccountStateSHA256 = wenHashV1([]byte("other"))
				case "wallet":
					body.Review.WalletPublicKey = body.Review.Intent.Economy
				case "budget":
					body.Review.MaxTotalCostLamports = 1
				case "lag":
					body.Review.MaxSlotLag = 0
				case "cancelled":
					cancel()
				}
				factory := func(selected string) wenMiningClaimExecutionRPCV1 {
					if selected != endpoint {
						t.Fatal("wrong RPC")
					}
					if mode == "network-change" {
						if _, e := keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://changed.invalid"}); e != nil {
							t.Fatal(e)
						}
					}
					return client
				}
				receipt, e := service.installMiningClaimBootstrapV1(ctx, cfg, "miner", body, mode != "application", factory)
				if (e == nil) != (mode == "ok" || mode == "fresh") {
					t.Fatal(mode, e)
				}
				if client.sends != 0 {
					t.Fatal("installer sent")
				}
				if mode == "ok" || mode == "fresh" {
					if receipt.SigningEnabled || receipt.ReviewSHA256 != wenHashV1(original) {
						t.Fatal("receipt")
					}
					again, e := service.installMiningClaimBootstrapV1(ctx, cfg, "miner", body, true, factory)
					if e != nil || again != receipt {
						t.Fatal("idempotence", e)
					}
					if _, _, e = loadWENMiningClaimAdmissionV1(cfg.stateDBPath, "miner", v); e != nil {
						t.Fatal(e)
					}
				} else if mode == "conflict" {
					b, _ := os.ReadFile(path)
					if string(b) != "{}" {
						t.Fatal("conflict overwritten")
					}
				} else if _, e = os.Stat(path); !os.IsNotExist(e) {
					t.Fatal("invalid review installed")
				}
			})
		}
	}
}
