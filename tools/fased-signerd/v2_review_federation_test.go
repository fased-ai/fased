package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

func TestReviewedFederationChallengeSignsExactMessageOnce(t *testing.T) {
	store, keys := openTestSignerV2(t)
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	wallet, locked, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID: "federation-vault", ExpectedVersion: 0,
		Policy: signerPolicyV2{Role: "vault"},
	})
	if err != nil {
		t.Fatal(err)
	}
	policy, err := store.putPolicy(signerPolicyV2{
		WalletID: wallet.WalletID, Role: "vault",
		Operations: []string{intentFederationBondChallenge},
		Programs:   []string{federationBondPolicyDomainV2},
		Assets: []signerPolicyAssetV2{{
			Asset: "federation:bond-challenge", Destinations: []string{wallet.PublicKey},
			MaxPerTx: "1", MaxDaily: "1",
		}},
	}, locked.Version)
	if err != nil {
		t.Fatal(err)
	}
	webauthn, err := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
	if err != nil {
		t.Fatal(err)
	}
	authenticator := newTestWebAuthnAuthenticatorV2(t)
	registration, err := webauthn.beginRegistration("Federation approval key")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := webauthn.finishRegistration(signerWebAuthnRegistrationFinishRequestV2{
		ChallengeID: registration.ChallengeID,
		Credential:  authenticator.registrationResponse(t, registration.Options, testWebAuthnOrigin, 0x45, 1),
	}); err != nil {
		t.Fatal(err)
	}

	walletKey := solana.MustPublicKeyFromBase58(wallet.PublicKey)
	payload := federationChallengePayloadV2(t, walletKey, now, "reviewed-federation-nonce")
	intentInput := federationChallengeIntentV2(walletKey, now, "reviewed-federation-challenge", payload)
	normalized, err := normalizeSignerIntentForWalletV2(intentInput, &walletKey)
	if err != nil {
		t.Fatal(err)
	}
	requestID := federationBondChallengeRequestIDV2(intentInput.Federation.ChallengeID)
	service := &signerServiceV2{store: store, keys: keys, webauthn: webauthn}
	review, err := service.prepareJupiterReviewV2(wallet.WalletID, signerReviewPrepareRequestV2{
		RequestID: requestID, PolicyHash: policy.Hash, Mode: jupiterReviewModeReviewedV2, Intent: intentInput,
	})
	if err != nil {
		t.Fatalf("prepare exact federation review: %v", err)
	}
	if review.ArtifactKind != signerReviewArtifactDomainMessageV2 || review.Transaction != nil ||
		review.ArtifactDigest == "" || review.MessageBase64 != intentInput.Federation.PayloadBase64 ||
		review.RequiredPrograms[0] != federationBondPolicyDomainV2 {
		t.Fatalf("federation review omitted its exact artifact/domain binding: %#v", review)
	}

	begin, err := webauthn.beginReviewAuthorization(wallet.WalletID, signerReviewAuthorizationBeginRequestV2{RequestID: requestID})
	if err != nil {
		t.Fatal(err)
	}
	finish, err := webauthn.finishReviewAuthorization(wallet.WalletID, signerReviewAuthorizationFinishRequestV2{
		ChallengeID: begin.ChallengeID,
		Credential: authenticator.assertionResponse(
			t, begin.Options, testWebAuthnOrigin, testWebAuthnRPID, "", 0x05, 2,
		),
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.executeJupiterReviewV2(wallet.WalletID, signerReviewExecuteRequestV2{
		RequestID: requestID, Authorization: &finish.Authorization,
	})
	if err != nil {
		t.Fatalf("execute exact federation review: %v", err)
	}
	if result.Operation == nil || result.Operation.State != operationConfirmed ||
		result.Review.State != jupiterReviewSignedV2 || result.SignatureBase64 == "" ||
		result.Operation.AuthorizationProof != finish.Authorization.Proof.ProofID {
		t.Fatalf("federation review did not complete durably: %#v", result)
	}
	signature, err := base64.StdEncoding.Strict().DecodeString(result.SignatureBase64)
	if err != nil || len(signature) != ed25519.SignatureSize ||
		!ed25519.Verify(ed25519.PublicKey(walletKey[:]), normalized.Message, signature) {
		t.Fatal("federation result is not the signer-owned signature of the exact raw challenge payload")
	}
	usage, err := store.dailyUsage(wallet.WalletID, "federation:bond-challenge", now)
	if err != nil || usage.String() != "1" {
		t.Fatalf("reviewed federation cap was not reserved exactly once: usage=%v err=%v", usage, err)
	}

	duplicate, err := service.executeJupiterReviewV2(wallet.WalletID, signerReviewExecuteRequestV2{
		RequestID: requestID, Authorization: &finish.Authorization,
	})
	if err != nil || duplicate.Operation == nil || duplicate.Operation.State != operationConfirmed ||
		duplicate.SignatureBase64 != result.SignatureBase64 {
		t.Fatalf("idempotent federation retry changed or repeated the result: %#v err=%v", duplicate, err)
	}
	lookupBody, err := json.Marshal(signerOperationLookupV2{RequestID: requestID})
	if err != nil {
		t.Fatal(err)
	}
	lookupRaw, err := service.handle(request{
		Op: "v2.review.get", WalletID: wallet.WalletID, Request: lookupBody,
	}, signerConfig{readOnly: true}, false)
	if err != nil {
		t.Fatalf("read signed review after completion: %v", err)
	}
	var lookup struct {
		Result signerReviewV2 `json:"result"`
	}
	if err := json.Unmarshal(lookupRaw, &lookup); err != nil {
		t.Fatalf("decode signed review lookup: %v", err)
	}
	if lookup.Result.State != jupiterReviewSignedV2 || lookup.Result.Signature != result.SignatureBase64 ||
		lookup.Result.ArtifactDigest != review.ArtifactDigest || lookup.Result.IntentDigest != review.IntentDigest {
		t.Fatalf("signed review lookup changed its immutable result: %#v", lookup.Result)
	}
	if _, err := service.handle(request{
		Op: "v2.review.get", WalletID: "different-wallet", Request: lookupBody,
	}, signerConfig{readOnly: true}, false); err == nil || !strings.Contains(err.Error(), "wallet mismatch") {
		t.Fatalf("cross-wallet review lookup was accepted: %v", err)
	}
	if _, err := service.execute(signerExecuteRequestV2{
		RequestID: requestID + "-raw", PolicyHash: policy.Hash, Intent: intentInput, intentWalletID: wallet.WalletID,
	}); err == nil || !strings.Contains(err.Error(), "reviewed authorization") {
		t.Fatalf("direct federation execution bypassed review: %v", err)
	}
}
