package main

import (
	"context"
	"encoding/json"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"testing"
)

func TestWENMiningClaimConfiguredReviewPreparation(t *testing.T) {
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "wrong-hash", "read-only", "network-change", "wrong-intent", "cancelled"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				_, _, pins, _ := miningClaimRPCFixture(t, op)
				raw, pins := miningClaimReviewDescriptor(t, pins)
				store, keys, v, _, client := miningClaimExecutionFixture(t, raw, pins, op, "success")
				keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
				endpoint := "https://claim-review-fixture.invalid"
				if _, err := keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); err != nil {
					t.Fatal(err)
				}
				admission, _, err := loadWENMiningClaimAdmissionV1(store.db.Path(), "miner", v)
				if err != nil {
					t.Fatal(err)
				}
				body := wenMiningClaimReviewPrepareRequestV1{RequestID: "prepared-claim", Intent: v, ReviewSHA256: admission.reviewSHA}
				cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				if mode == "wrong-hash" {
					body.ReviewSHA256 = wenHashV1([]byte("wrong"))
				}
				if mode == "read-only" {
					cfg.readOnly = true
				}
				if mode == "wrong-intent" {
					body.Intent.ID = "999"
				}
				if mode == "cancelled" {
					cancel()
				}
				service := &signerServiceV2{store: store, keys: keys}
				factory := func(selected string) wenMiningClaimExecutionRPCV1 {
					if selected != endpoint {
						t.Fatal("unconfigured RPC")
					}
					if mode == "network-change" {
						if _, err := keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://changed.invalid"}); err != nil {
							t.Fatal(err)
						}
					}
					return client
				}
				out, err := service.prepareConfiguredWENMiningClaimReviewV1(ctx, cfg, "miner", body, factory)
				if (err == nil) != (mode == "ok") {
					t.Fatal(mode, err)
				}
				if client.sends != 0 {
					t.Fatal("preparation sent")
				}
				if err := store.db.View(func(tx *bolt.Tx) error {
					stored := tx.Bucket(bucketSignerReviewsV2).Get([]byte(body.RequestID))
					if (stored != nil) != (mode == "ok") {
						t.Fatal("unexpected stored review")
					}
					if tx.Bucket(wenBudgetBucketV1).Get([]byte("request:"+body.RequestID)) != nil {
						t.Fatal("preparation reserved funds")
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				if mode == "ok" && os.Getenv("WEN_PREPARE_VECTOR_DIR") != "" {
					raw, err := json.Marshal(map[string]any{"request": body, "review": out})
					if err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(os.Getenv("WEN_PREPARE_VECTOR_DIR"), op+".json"), raw, 0600); err != nil {
						t.Fatal(err)
					}
				}
				if mode == "ok" {
					if out.State != jupiterReviewPreparedV2 || out.ArtifactKind != wenMiningClaimArtifactKindV1 || out.Signature != "" {
						t.Fatal("bad unsigned review")
					}
					if _, err := service.prepareConfiguredWENMiningClaimReviewV1(ctx, cfg, "miner", body, factory); err == nil {
						t.Fatal("overwrote review")
					}
				}
			})
		}
	}
}
func TestWENMiningClaimReviewPrepareWire(t *testing.T) {
	req := request{Op: "v2.wenMining.claim.review.prepare", WalletID: "miner", Request: json.RawMessage(`{"extra":true}`)}
	if err := mustValidate(req, signerConfig{}); err != nil {
		t.Fatal(err)
	}
	if applicationUpdateGateReadOperations[req.Op] {
		t.Fatal("review storage classified read-only")
	}
	service := &signerServiceV2{}
	if _, err := service.handle(req, signerConfig{}, false); err == nil {
		t.Fatal("unknown preparation fields accepted")
	}
}
