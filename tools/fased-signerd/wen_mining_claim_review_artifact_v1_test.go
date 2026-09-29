package main

import (
	"context"
	"testing"
)

func TestWENMiningClaimReviewArtifact(t *testing.T) {
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "request", "wallet", "policy", "amount", "fee", "message", "hash", "expiry"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				_, _, pins, _ := miningClaimRPCFixture(t, op)
				raw, pins := miningClaimReviewDescriptor(t, pins)
				store, keys, v, policy, client := miningClaimExecutionFixture(t, raw, pins, op, "success")
				prepared, err := prepareReviewedWENMiningClaimV1(context.Background(), client, store.db.Path(), "miner", v)
				if err != nil {
					t.Fatal(err)
				}
				a, hash, err := newWENMiningClaimReviewArtifactV1("state-request", "miner", policy.Hash, v, prepared)
				if err != nil {
					t.Fatal(err)
				}
				// The exported review owns its bytes; later preparation-buffer reuse cannot change it.
				original := prepared.message[0]
				prepared.message[0] ^= 1
				if a.Binding.Message[0] != original {
					t.Fatal("aliased message")
				}
				prepared.message[0] = original
				switch mode {
				case "request":
					a.RequestID = "other-request"
				case "wallet":
					a.WalletID = "other"
				case "policy":
					a.PolicyHash = "sha256:" + wenHashV1([]byte("changed"))
				case "amount":
					a.Intent.MinimumReceived = "0"
				case "fee":
					a.Binding.Fee++
				case "message":
					a.Binding.Message[0] ^= 1
				case "hash":
					hash = wenHashV1([]byte("wrong"))
				case "expiry":
					a.Binding.LastValidHeight++
				}
				svc := &signerServiceV2{store: store, keys: keys}
				digest, state, err := svc.executeReviewedMiningClaimV1(context.Background(), client, "state-request", "miner", policy.Hash, v, nil, &a, hash)
				if mode == "ok" {
					if err != nil || state != "finalized-success" || digest == "" || client.sends != 1 {
						t.Fatal(state, err)
					}
					// Existing durable claim machinery must still prevent another submission.
					_, _, err = svc.executeReviewedMiningClaimV1(context.Background(), client, "state-request", "miner", policy.Hash, v, nil, &a, hash)
					if err == nil || client.sends != 1 {
						t.Fatal("review replay sent")
					}
				} else if err == nil || digest != "" || state != "" || client.sends != 0 {
					t.Fatal("changed artifact executed", mode, err)
				}
			})
		}
	}
}
