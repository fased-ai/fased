package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type vaultBondReviewRPCV2 struct {
	mu        sync.Mutex
	fixture   vaultBondRPCFixtureV2
	blockhash string
}

func (f *vaultBondReviewRPCV2) accounts() []*rpc.Account {
	f.mu.Lock()
	defer f.mu.Unlock()
	result := make([]*rpc.Account, len(f.fixture.snapshot.Accounts))
	for index, account := range f.fixture.snapshot.Accounts {
		result[index] = cloneRPCAccountV2(account)
	}
	return result
}

func (f *vaultBondReviewRPCV2) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	var body struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		http.Error(response, "invalid request", http.StatusBadRequest)
		return
	}
	var result any
	switch body.Method {
	case "getGenesisHash":
		result = "7YkK94UjQ9uR5nH6QpV2yMVgF2mJkQNWqFQ4rQPhhVxS"
	case "getMultipleAccounts":
		result = map[string]any{"context": map[string]any{"slot": 100}, "value": f.accounts()}
	case "getLatestBlockhash":
		result = map[string]any{
			"context": map[string]any{"slot": 100},
			"value":   map[string]any{"blockhash": f.blockhash, "lastValidBlockHeight": 500},
		}
	case "simulateTransaction":
		result = map[string]any{
			"context": map[string]any{"slot": 100},
			"value":   map[string]any{"err": nil, "logs": []string{}, "unitsConsumed": 1},
		}
	default:
		response.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(response).Encode(map[string]any{
			"jsonrpc": "2.0", "id": json.RawMessage(body.ID),
			"error": map[string]any{"code": -32601, "message": "unsupported test method"},
		})
		return
	}
	response.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(response).Encode(map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(body.ID), "result": result,
	})
}

func vaultBondFinalizeIntentV2(fixture vaultBondRPCFixtureV2) signerIntentV2 {
	keys := make([]signerSATAccountV2, 0, len(fixture.instruction.Accounts))
	for _, account := range fixture.instruction.Accounts {
		keys = append(keys, signerSATAccountV2{
			Pubkey: account.PublicKey.String(), IsSigner: account.IsSigner, IsWritable: account.IsWritable,
		})
	}
	return signerIntentV2{
		Type: intentSolanaVaultBondAction, Cluster: "local", Action: "finalizeBondUnlock",
		ProgramID: fixture.program.String(), DataBase64: base64.StdEncoding.EncodeToString([]byte{6}), Keys: keys,
	}
}

func TestReviewedVaultBondPrepareBuildsTransactionAndBindsState(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet, locked, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID: "bond-vault-reviewed", ExpectedVersion: 0, Policy: signerPolicyV2{Role: "vault"},
	})
	if err != nil {
		t.Fatal(err)
	}
	walletKey := solana.MustPublicKeyFromBase58(wallet.PublicKey)
	fixture := makeVaultBondRPCFixtureForWalletV2(t, walletKey)
	input := vaultBondFinalizeIntentV2(fixture)
	baseIntent, err := normalizeSignerIntentForWalletV2(input, &walletKey)
	if err != nil {
		t.Fatal(err)
	}
	effect, err := resolveVaultBondFinalizeEffectV2(fixture.instruction, walletKey, fixture.snapshot)
	if err != nil {
		t.Fatal(err)
	}
	reviewedIntent := baseIntent
	reviewedIntent.Asset, reviewedIntent.Amount, reviewedIntent.Destination = effect.Asset, effect.Amount, effect.Destination
	policy, err := store.putPolicy(signerPolicyV2{
		WalletID: wallet.WalletID, Role: "vault",
		Operations: []string{reviewedIntent.PolicyOperation}, Programs: reviewedIntent.RequiredPrograms,
		Assets: []signerPolicyAssetV2{
			{Asset: reviewedIntent.Asset, Destinations: []string{reviewedIntent.Destination}, MaxPerTx: "75", MaxDaily: "75"},
			{Asset: "solana:native", Destinations: []string{wallet.PublicKey}, MaxPerTx: "6500000", MaxDaily: "6500000"},
		},
	}, locked.Version)
	if err != nil {
		t.Fatal(err)
	}
	rpcFixture := &vaultBondReviewRPCV2{fixture: fixture, blockhash: solana.Hash{9}.String()}
	server := httptest.NewServer(rpcFixture)
	defer server.Close()
	zero := uint64(0)
	if _, err := keys.PutNetworkV2(wallet.WalletID, signerNetworkPutRequestV2{
		ExpectedVersion: &zero, PrimaryRPCURL: server.URL,
	}); err != nil {
		t.Fatal(err)
	}
	service := &signerServiceV2{store: store, keys: keys}
	review, err := service.prepareJupiterReviewV2(wallet.WalletID, signerReviewPrepareRequestV2{
		RequestID: "vault-bond-finalize-reviewed", PolicyHash: policy.Hash,
		Mode: jupiterReviewModeReviewedV2, Intent: input,
	})
	if err != nil {
		t.Fatalf("prepare signer-built Vault bond review: %v", err)
	}
	if review.Transaction == nil || review.ArtifactKind != signerReviewArtifactSolanaTransactionV2 ||
		review.StateDigest != fixture.snapshot.Digest || review.StateSlot != fixture.snapshot.Slot ||
		review.Asset != effect.Asset || review.Amount != effect.Amount.String() ||
		review.Destination != wallet.PublicKey || review.Transaction.Submission != jupiterSubmissionRPCV2 {
		t.Fatalf("Vault review omitted exact transaction/state/effect binding: %#v", review)
	}
	webauthnService, err := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
	if err != nil {
		t.Fatal(err)
	}
	authenticator := newTestWebAuthnAuthenticatorV2(t)
	registration, err := webauthnService.beginRegistration("Vault approval key")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := webauthnService.finishRegistration(signerWebAuthnRegistrationFinishRequestV2{
		ChallengeID: registration.ChallengeID,
		Credential:  authenticator.registrationResponse(t, registration.Options, testWebAuthnOrigin, 0x45, 1),
	}); err != nil {
		t.Fatal(err)
	}
	authorization, err := webauthnService.beginReviewAuthorization(wallet.WalletID, signerReviewAuthorizationBeginRequestV2{
		RequestID: review.RequestID,
	})
	if err != nil {
		t.Fatalf("begin Vault review authorization: %v", err)
	}
	if authorization.Binding.PolicyOperation != reviewedIntent.PolicyOperation {
		t.Fatalf("WebAuthn did not bind the exact Vault policy operation: %#v", authorization.Binding)
	}

	rpcFixture.mu.Lock()
	rpcFixture.fixture.snapshot.Accounts[4] = splTokenTestAccountV2(fixture.mint, fixture.position, 74)
	rpcFixture.mu.Unlock()
	configured, err := keys.SolanaRPCURLsV2(wallet.WalletID)
	if err != nil {
		t.Fatal(err)
	}
	current, snapshot, _, err := resolveVaultBondReviewStateV2(configured, walletKey, baseIntent)
	if err == nil {
		err = compareVaultBondReviewStateV2(review, current, snapshot)
	}
	if err == nil || (!strings.Contains(err.Error(), "not ready") && !strings.Contains(err.Error(), "state changed")) {
		t.Fatalf("Vault state mutation after review was accepted: %v", err)
	}
}
