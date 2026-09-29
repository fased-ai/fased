package main

import (
	"context"
	"testing"
)

func TestWENMiningClaimHumanReviewedExecution(t *testing.T) {
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"success", "lost-success", "missing", "wrong-proof", "revoke-before-key"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				_, _, pins, _ := miningClaimRPCFixture(t, op)
				raw, pins := miningClaimReviewDescriptor(t, pins)
				outcomeMode := "success"
				if mode == "lost-success" {
					outcomeMode = mode
				}
				store, keys, v, policy, client := miningClaimExecutionFixture(t, raw, pins, op, outcomeMode)
				p, err := prepareReviewedWENMiningClaimV1(context.Background(), client, store.db.Path(), "miner", v)
				if err != nil {
					t.Fatal(err)
				}
				a, _, err := newWENMiningClaimReviewArtifactV1("state-request", "miner", policy.Hash, v, p)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := store.storeWENMiningClaimReviewV1(a); err != nil {
					t.Fatal(err)
				}
				authService, err := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
				if err != nil {
					t.Fatal(err)
				}
				auth := newTestWebAuthnAuthenticatorV2(t)
				fixture := &testSignerWebAuthnFixtureV2{store: store, service: authService, walletID: "miner"}
				fixture.enroll(t, auth)
				begin, err := authService.beginReviewAuthorization("miner", signerReviewAuthorizationBeginRequestV2{RequestID: a.RequestID})
				if err != nil {
					t.Fatal(err)
				}
				finish, err := fixture.finishReview(t, begin, auth, 2)
				if err != nil {
					t.Fatal(err)
				}
				proof := &finish.Authorization.Proof
				if mode == "missing" {
					proof = nil
				}
				if mode == "wrong-proof" {
					proof = &signerWebAuthnProofReferenceV2{ProofID: "not-authorized"}
				}
				checks := 0
				guard := func() error {
					checks++
					if mode == "revoke-before-key" && checks == 3 {
						summary, err := authService.credentialSummary()
						if err != nil {
							return err
						}
						_, err = authService.revokeCredential(signerWebAuthnCredentialRevokeRequestV2{CredentialID: finish.CredentialID, ExpectedCount: summary.Count, ExpectedVersion: summary.Version, ConfirmLastCredential: true})
						return err
					}
					return nil
				}
				service := &signerServiceV2{store: store, keys: keys}
				digest, status, err := service.executeHumanReviewedWENMiningClaimV1(context.Background(), client, "miner", a.RequestID, authService, proof, guard)
				if mode == "missing" || mode == "wrong-proof" || mode == "revoke-before-key" {
					if err == nil || client.sends != 0 {
						t.Fatal("unapproved send", status, err)
					}
					if mode == "revoke-before-key" {
						if r := readWENState(t, store); r.Signature != "" || r.ClaimAuthorization == nil {
							t.Fatal("revoked before key boundary not exercised")
						}
					}
					return
				}
				if err != nil || status != "finalized-success" || client.sends != 1 {
					t.Fatal(status, err)
				}
				saved := readWENState(t, store)
				if saved.ClaimAuthorization == nil || saved.ClaimAuthorization.ProofID != proof.ProofID || !saved.SuccessBudgetSettled {
					t.Fatal("missing authorization or reconciliation")
				}
				keys.Close()
				dbPath := store.db.Path()
				if err := store.Close(); err != nil {
					t.Fatal(err)
				}
				reopened, err := openSignerStoreV2(dbPath)
				if err != nil {
					t.Fatal(err)
				}
				defer reopened.Close()
				if status, err := reopened.recoverWENMiningClaimExecutionV1(context.Background(), client, a.RequestID, digest); err != nil || status != "finalized-success" {
					t.Fatal(status, err)
				}
				if _, err := reopened.prepareWENMiningClaimSubmissionV1(context.Background(), client, a.RequestID, digest); err == nil || client.sends != 1 {
					t.Fatal("recovery resent")
				}
			})
		}
	}
}
