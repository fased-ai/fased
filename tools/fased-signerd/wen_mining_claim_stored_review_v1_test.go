package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWENMiningClaimStoredWebAuthnReview(t *testing.T) {
	for _, op := range []string{"sol", "sat"} {
		t.Run(op, func(t *testing.T) {
			_, _, pins, _ := miningClaimRPCFixture(t, op)
			raw, pins := miningClaimReviewDescriptor(t, pins)
			store, _, v, policy, client := miningClaimExecutionFixture(t, raw, pins, op, "success")
			p, err := prepareReviewedWENMiningClaimV1(context.Background(), client, store.db.Path(), "miner", v)
			if err != nil {
				t.Fatal(err)
			}
			a, _, err := newWENMiningClaimReviewArtifactV1("review-request-001", "miner", policy.Hash, v, p)
			if err != nil {
				t.Fatal(err)
			}
			review, err := store.storeWENMiningClaimReviewV1(a)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.storeWENMiningClaimReviewV1(a); err == nil {
				t.Fatal("review overwritten")
			}
			for _, mutate := range []func(*signerReviewV2){
				func(r *signerReviewV2) { r.Amount = "0" }, func(r *signerReviewV2) { r.PolicyHash = "wrong" },
				func(r *signerReviewV2) { r.WalletPublicKey = v.ProgramID }, func(r *signerReviewV2) { r.TransactionDigest = "wrong" },
				func(r *signerReviewV2) { r.StateSlot++ }, func(r *signerReviewV2) { r.ArtifactDigest = "wrong" },
			} {
				changed := review
				mutate(&changed)
				if _, err := reviewBindingFromStoredReviewV2(changed, policy); err == nil {
					t.Fatal("changed stored review accepted")
				}
			}
			service, err := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
			if err != nil {
				t.Fatal(err)
			}
			auth := newTestWebAuthnAuthenticatorV2(t)
			fixture := &testSignerWebAuthnFixtureV2{store: store, service: service, walletID: "miner"}
			fixture.enroll(t, auth)
			begin := fixture.beginReview(t)
			finish, err := fixture.finishReview(t, begin, auth, 2)
			if err != nil {
				t.Fatal(err)
			}
			if finish.Binding.ArtifactDigest != review.ArtifactDigest || finish.Binding.TransactionDigest != review.TransactionDigest {
				t.Fatal("approval not bound")
			}
			if dir := os.Getenv("WEN_AUTH_VECTOR_DIR"); dir != "" {
				encoded, err := json.Marshal(map[string]any{"review": review, "begin": begin, "finish": finish})
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, op+".json"), encoded, 0600); err != nil {
					t.Fatal(err)
				}
			}
			wrong := finish.Binding
			wrong.ArtifactDigest = "sha256:" + wenHashV1([]byte("other"))
			if err := service.verifyAndConsumeReviewProofV2(wrong, &finish.Authorization.Proof); err == nil {
				t.Fatal("wrong artifact consumed proof")
			}
			digest, _, err := store.reservePreparedWENMiningClaimV1(a.RequestID, "miner", policy.Hash, v, p)
			if err != nil {
				t.Fatal(err)
			}
			if err := service.authorizeWENMiningClaimV1("miner", a.RequestID, "wrong", &finish.Authorization.Proof); err == nil {
				t.Fatal("wrong reservation authorized")
			}
			if err := service.authorizeWENMiningClaimV1("miner", a.RequestID, digest, &finish.Authorization.Proof); err != nil {
				t.Fatal(err)
			}
			if err := service.authorizeWENMiningClaimV1("miner", a.RequestID, digest, &finish.Authorization.Proof); err != nil {
				t.Fatal("idempotent retry", err)
			}
			if err := service.verifyAndConsumeReviewProofV2(finish.Binding, &finish.Authorization.Proof); err == nil {
				t.Fatal("atomically consumed proof still pending")
			}
			if err := service.verifyAndConsumeReviewProofV2(finish.Binding, &finish.Authorization.Proof); err == nil {
				t.Fatal("proof reused")
			}
			statePath := store.db.Path()
			if err := store.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := openSignerStoreV2(statePath)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			recoveredService, err := newSignerWebAuthnServiceV2(reopened, testWebAuthnRPID, testWebAuthnOrigin)
			if err != nil {
				t.Fatal(err)
			}
			if err := recoveredService.authorizeWENMiningClaimV1("miner", a.RequestID, digest, &finish.Authorization.Proof); err != nil {
				t.Fatal("reopened authorization", err)
			}
			if err := recoveredService.authorizeWENMiningClaimV1("miner", a.RequestID, "other", &finish.Authorization.Proof); err == nil {
				t.Fatal("reopened changed reservation accepted")
			}
			summary, err := recoveredService.credentialSummary()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := recoveredService.revokeCredential(signerWebAuthnCredentialRevokeRequestV2{CredentialID: finish.CredentialID, ExpectedCount: summary.Count, ExpectedVersion: summary.Version, ConfirmLastCredential: true}); err != nil {
				t.Fatal(err)
			}
			if err := recoveredService.authorizeWENMiningClaimV1("miner", a.RequestID, digest, &finish.Authorization.Proof); err == nil {
				t.Fatal("revoked credential authorized retry")
			}
			if client.sends != 0 {
				t.Fatal("authorization sent a transaction")
			}
		})
	}
}
