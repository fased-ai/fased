package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

func federationChallengePayloadV2(t *testing.T, wallet solana.PublicKey, now time.Time, nonce string) []byte {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"schema":    federationBondChallengeSchemaV2,
		"handle":    "@bonded@ff1.fased.app",
		"nodeId":    "node-bond-1",
		"tokenId":   "bond-token-1",
		"bondId":    "bond-pos-1",
		"wallet":    map[string]any{"chain": "solana", "address": wallet.String()},
		"tier":      "basic-bond",
		"amountRaw": "750000000000",
		"nonce":     nonce,
		"issuedAt":  now.Add(-time.Minute).Format(time.RFC3339Nano),
		"expiresAt": now.Add(4 * time.Minute).Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func federationChallengeIntentV2(wallet solana.PublicKey, now time.Time, challengeID string, payload []byte) signerIntentV2 {
	return signerIntentV2{
		Type: intentFederationBondChallenge,
		Federation: &signerFederationBondChallengeIntentV2{
			ChallengeID: challengeID, FederationOrigin: "https://FF1.FASED.APP/",
			Handle: "@bonded@ff1.fased.app", NodeID: "node-bond-1", TokenID: "bond-token-1",
			BondID: "bond-pos-1", Tier: "basic-bond", AmountRaw: "750000000000",
			ExpiresAt:     now.Add(4 * time.Minute).Format(time.RFC3339Nano),
			PayloadBase64: base64.StdEncoding.EncodeToString(payload),
		},
	}
}

func TestSignerV2FederationChallengeBindsExactDomainPayload(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	payload := federationChallengePayloadV2(t, wallet, now, "nonce-bond-1")
	intent := federationChallengeIntentV2(wallet, now, "bond-challenge-1", payload)
	normalized, err := normalizeFederationBondChallengeIntentV2(intent, wallet)
	if err != nil {
		t.Fatalf("normalize federation challenge: %v", err)
	}
	expectedMessage, err := federationBondSigningMessageBytesV2(*normalized.Intent.Federation)
	if err != nil || !bytes.Equal(normalized.Message, expectedMessage) {
		t.Fatal("normalized federation message did not bind the canonical signature wrapper")
	}
	if normalized.Intent.Federation.FederationOrigin != "https://ff1.fased.app" {
		t.Fatalf("federation origin was not canonicalized: %q", normalized.Intent.Federation.FederationOrigin)
	}
	if normalized.RequiredRole != "vault" || normalized.PolicyOperation != intentFederationBondChallenge || normalized.Asset != "federation:bond-challenge" || normalized.Amount.String() != "1" || normalized.Destination != wallet.String() || len(normalized.RequiredPrograms) != 1 || normalized.RequiredPrograms[0] != federationBondPolicyDomainV2 {
		t.Fatalf("federation intent omitted its Vault policy binding: %#v", normalized)
	}
	_, decoded, err := federationPayloadFromIntentV2(normalized)
	if err != nil {
		t.Fatalf("decode normalized federation payload: %v", err)
	}
	if err := validateFederationBondChallengeTimeV2(decoded, now); err != nil {
		t.Fatalf("validate federation challenge time: %v", err)
	}
	if federationBondChallengeRequestIDV2("bond-challenge-1") == federationBondChallengeRequestIDV2("bond-challenge-2") {
		t.Fatal("different challenge IDs produced the same deterministic request ID")
	}
	otherID := intent
	otherFederation := *intent.Federation
	otherID.Federation = &otherFederation
	otherID.Federation.ChallengeID = "bond-challenge-2"
	otherNormalized, err := normalizeFederationBondChallengeIntentV2(otherID, wallet)
	if err != nil || bytes.Equal(otherNormalized.Message, normalized.Message) {
		t.Fatal("federation signature message did not bind challengeId")
	}
	otherOrigin := intent
	otherFederation = *intent.Federation
	otherOrigin.Federation = &otherFederation
	otherOrigin.Federation.FederationOrigin = "https://other.fased.app"
	otherNormalized, err = normalizeFederationBondChallengeIntentV2(otherOrigin, wallet)
	if err != nil || bytes.Equal(otherNormalized.Message, normalized.Message) {
		t.Fatal("federation signature message did not bind federationOrigin")
	}
}

func TestSignerV2FederationChallengeRejectsMutationReplayAndRawFields(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	payload := federationChallengePayloadV2(t, wallet, now, "nonce-original")
	valid := federationChallengeIntentV2(wallet, now, "bond-challenge-replay", payload)
	normalized, err := normalizeFederationBondChallengeIntentV2(valid, wallet)
	if err != nil {
		t.Fatalf("normalize original challenge: %v", err)
	}
	mutatedPayload := federationChallengePayloadV2(t, wallet, now, "nonce-mutated")
	mutated := federationChallengeIntentV2(wallet, now, "bond-challenge-replay", mutatedPayload)
	mutatedNormalized, err := normalizeFederationBondChallengeIntentV2(mutated, wallet)
	if err != nil {
		t.Fatalf("normalize independently valid mutated challenge: %v", err)
	}
	if mutatedNormalized.Digest == normalized.Digest {
		t.Fatal("mutated payload did not change the immutable signer intent digest")
	}

	raw := valid
	raw.DataBase64 = base64.StdEncoding.EncodeToString([]byte("raw instruction"))
	if _, err := normalizeFederationBondChallengeIntentV2(raw, wallet); err == nil || !strings.Contains(err.Error(), "rejects transaction") {
		t.Fatalf("federation challenge accepted raw instruction fields: %v", err)
	}

	extra := append([]byte(nil), payload[:len(payload)-1]...)
	extra = append(extra, []byte(`,"unexpected":true}`)...)
	malformed := federationChallengeIntentV2(wallet, now, "bond-challenge-extra", extra)
	if _, err := normalizeFederationBondChallengeIntentV2(malformed, wallet); err == nil || !strings.Contains(err.Error(), "unsupported field") {
		t.Fatalf("unknown federation payload field was accepted: %v", err)
	}
	duplicate := []byte(strings.Replace(string(payload), `"nonce":"nonce-original"`, `"nonce":"nonce-original","nonce":"duplicate"`, 1))
	duplicateIntent := federationChallengeIntentV2(wallet, now, "bond-challenge-duplicate", duplicate)
	if _, err := normalizeFederationBondChallengeIntentV2(duplicateIntent, wallet); err == nil || !strings.Contains(err.Error(), "duplicate key") {
		t.Fatalf("duplicate federation payload key was accepted: %v", err)
	}
}

func TestSignerV2FederationChallengeFailsClosedOnRolePolicyCapsAndTime(t *testing.T) {
	store, keys := openTestSignerV2(t)
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	walletRecord, locked, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID: "bond-vault", ExpectedVersion: 0,
		Policy: signerPolicyV2{Role: "vault", Operations: []string{}, Programs: []string{}, Assets: []signerPolicyAssetV2{}},
	})
	if err != nil {
		t.Fatalf("create locked federation Vault: %v", err)
	}
	policy, err := store.putPolicy(signerPolicyV2{
		WalletID: walletRecord.WalletID, Role: "vault", Operations: []string{intentFederationBondChallenge}, Programs: []string{federationBondPolicyDomainV2},
		Assets: []signerPolicyAssetV2{{
			Asset: "federation:bond-challenge", Destinations: []string{walletRecord.PublicKey}, MaxPerTx: "1", MaxDaily: "1",
		}},
	}, locked.Version)
	if err != nil {
		t.Fatalf("configure federation Vault policy: %v", err)
	}
	wallet := solana.MustPublicKeyFromBase58(walletRecord.PublicKey)
	payload := federationChallengePayloadV2(t, wallet, now, "nonce-first")
	valid := federationChallengeIntentV2(wallet, now, "bond-challenge-first", payload)
	normalized, err := normalizeFederationBondChallengeIntentV2(valid, wallet)
	if err != nil {
		t.Fatalf("normalize valid federation intent: %v", err)
	}
	agentPolicy := policy
	agentPolicy.Role = "agent"
	if _, err := policyAssetForIntentV2(agentPolicy, normalized); err == nil || !strings.Contains(err.Error(), "cannot authorize") {
		t.Fatalf("non-Vault role authorized federation signing: %v", err)
	}
	emptyPolicy := policy
	emptyPolicy.Operations = nil
	if _, err := policyAssetForIntentV2(emptyPolicy, normalized); err == nil || !strings.Contains(err.Error(), "operations are empty") {
		t.Fatalf("empty federation policy did not fail closed: %v", err)
	}
	emptyPrograms := policy
	emptyPrograms.Programs = nil
	if _, err := policyAssetForIntentV2(emptyPrograms, normalized); err == nil || !strings.Contains(err.Error(), "programs are empty") {
		t.Fatalf("empty federation signer-domain policy did not fail closed: %v", err)
	}
	first := signerExecuteRequestV2{
		RequestID: federationBondChallengeRequestIDV2(valid.Federation.ChallengeID), PolicyHash: policy.Hash,
		Intent: valid, intentWalletID: walletRecord.WalletID,
	}
	if _, _, err := store.reserveOperation(first, normalized); err != nil {
		t.Fatalf("reserve first reviewed federation allowance: %v", err)
	}
	secondPayload := federationChallengePayloadV2(t, wallet, now, "nonce-second")
	secondIntent := federationChallengeIntentV2(wallet, now, "bond-challenge-second", secondPayload)
	secondNormalized, err := normalizeFederationBondChallengeIntentV2(secondIntent, wallet)
	if err != nil {
		t.Fatalf("normalize second challenge: %v", err)
	}
	_, _, err = store.reserveOperation(signerExecuteRequestV2{
		RequestID: federationBondChallengeRequestIDV2(secondIntent.Federation.ChallengeID), PolicyHash: policy.Hash,
		Intent: secondIntent, intentWalletID: walletRecord.WalletID,
	}, secondNormalized)
	if err == nil || !strings.Contains(err.Error(), "daily cap exceeded") {
		t.Fatalf("federation daily cap was not enforced: %v", err)
	}

	expired := decodeFederationForTestV2(t, federationChallengePayloadV2(t, wallet, now.Add(-20*time.Minute), "expired"))
	if err := validateFederationBondChallengeTimeV2(expired, now); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expired federation challenge was accepted: %v", err)
	}
}

func decodeFederationForTestV2(t *testing.T, payload []byte) federationBondChallengePayloadV2 {
	t.Helper()
	decoded, err := decodeFederationBondChallengePayloadV2(payload)
	if err != nil {
		t.Fatalf("decode federation test payload: %v", err)
	}
	return decoded
}

func TestSignerV2DirectVaultAndFederationExecutionIsRejected(t *testing.T) {
	store, keys := openTestSignerV2(t)
	service := &signerServiceV2{store: store, keys: keys}
	for _, intentType := range []string{intentSolanaVaultBondAction, intentFederationBondChallenge} {
		_, err := service.execute(signerExecuteRequestV2{Intent: signerIntentV2{Type: intentType}})
		if err == nil || !strings.Contains(err.Error(), "require signer-owned reviewed authorization") {
			t.Fatalf("direct %s execution was not rejected by the reviewed-only guard: %v", intentType, err)
		}
	}
}
