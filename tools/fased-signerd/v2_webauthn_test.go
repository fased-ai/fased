package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math/big"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
	solana "github.com/gagliardetto/solana-go"
	"github.com/go-webauthn/webauthn/protocol"
	bolt "go.etcd.io/bbolt"
)

const (
	testWebAuthnRPID   = "wallet.example.test"
	testWebAuthnOrigin = "https://wallet.example.test"
)

type testWebAuthnAuthenticatorV2 struct {
	privateKey   *ecdsa.PrivateKey
	credentialID []byte
}

func newTestWebAuthnAuthenticatorV2(t *testing.T) *testWebAuthnAuthenticatorV2 {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate test WebAuthn key: %v", err)
	}
	credentialID := make([]byte, 32)
	if _, err := rand.Read(credentialID); err != nil {
		t.Fatalf("generate test credential id: %v", err)
	}
	return &testWebAuthnAuthenticatorV2{privateKey: privateKey, credentialID: credentialID}
}

func webAuthnClientDataJSONV2(t *testing.T, ceremonyType, challenge, origin string) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"type":      ceremonyType,
		"challenge": challenge,
		"origin":    origin,
	})
	if err != nil {
		t.Fatalf("marshal client data: %v", err)
	}
	return raw
}

func testWebAuthnAuthenticatorDataV2(t *testing.T, rpID string, flags byte, counter uint32, attested []byte) []byte {
	t.Helper()
	rpIDHash := sha256.Sum256([]byte(rpID))
	raw := make([]byte, 37)
	copy(raw[:32], rpIDHash[:])
	raw[32] = flags
	binary.BigEndian.PutUint32(raw[33:37], counter)
	if len(attested) > 0 {
		raw = append(raw, attested...)
	}
	return raw
}

func paddedP256CoordinateV2(value *big.Int) []byte {
	out := make([]byte, 32)
	value.FillBytes(out)
	return out
}

func (a *testWebAuthnAuthenticatorV2) cosePublicKey(t *testing.T) []byte {
	t.Helper()
	mode, err := cbor.CanonicalEncOptions().EncMode()
	if err != nil {
		t.Fatalf("create canonical CBOR mode: %v", err)
	}
	coseKey, err := mode.Marshal(map[int]any{
		1:  2,
		3:  -7,
		-1: 1,
		-2: paddedP256CoordinateV2(a.privateKey.X),
		-3: paddedP256CoordinateV2(a.privateKey.Y),
	})
	if err != nil {
		t.Fatalf("marshal COSE key: %v", err)
	}
	return coseKey
}

func (a *testWebAuthnAuthenticatorV2) registrationResponse(
	t *testing.T,
	options *protocol.CredentialCreation,
	origin string,
	flags byte,
	counter uint32,
) json.RawMessage {
	t.Helper()
	coseKey := a.cosePublicKey(t)
	attested := make([]byte, 0, 16+2+len(a.credentialID)+len(coseKey))
	attested = append(attested, make([]byte, 16)...)
	credentialLength := make([]byte, 2)
	binary.BigEndian.PutUint16(credentialLength, uint16(len(a.credentialID)))
	attested = append(attested, credentialLength...)
	attested = append(attested, a.credentialID...)
	attested = append(attested, coseKey...)
	authenticatorData := testWebAuthnAuthenticatorDataV2(
		t,
		options.Response.RelyingParty.ID,
		flags,
		counter,
		attested,
	)
	attestationObject, err := cbor.Marshal(map[string]any{
		"fmt":      "none",
		"authData": authenticatorData,
		"attStmt":  map[string]any{},
	})
	if err != nil {
		t.Fatalf("marshal attestation object: %v", err)
	}
	clientData := webAuthnClientDataJSONV2(
		t,
		"webauthn.create",
		options.Response.Challenge.String(),
		origin,
	)
	encoded, err := json.Marshal(map[string]any{
		"id":    base64.RawURLEncoding.EncodeToString(a.credentialID),
		"rawId": base64.RawURLEncoding.EncodeToString(a.credentialID),
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(clientData),
			"attestationObject": base64.RawURLEncoding.EncodeToString(attestationObject),
		},
	})
	if err != nil {
		t.Fatalf("marshal registration response: %v", err)
	}
	return encoded
}

func (a *testWebAuthnAuthenticatorV2) assertionResponse(
	t *testing.T,
	options *protocol.CredentialAssertion,
	origin string,
	rpID string,
	challenge string,
	flags byte,
	counter uint32,
) json.RawMessage {
	return a.assertionResponseForType(t, options, origin, rpID, challenge, "webauthn.get", flags, counter)
}

func (a *testWebAuthnAuthenticatorV2) assertionResponseForType(
	t *testing.T,
	options *protocol.CredentialAssertion,
	origin string,
	rpID string,
	challenge string,
	ceremonyType string,
	flags byte,
	counter uint32,
) json.RawMessage {
	t.Helper()
	if challenge == "" {
		challenge = options.Response.Challenge.String()
	}
	clientData := webAuthnClientDataJSONV2(t, ceremonyType, challenge, origin)
	authenticatorData := testWebAuthnAuthenticatorDataV2(t, rpID, flags, counter, nil)
	clientHash := sha256.Sum256(clientData)
	signedData := append(append([]byte(nil), authenticatorData...), clientHash[:]...)
	signedHash := sha256.Sum256(signedData)
	signature, err := ecdsa.SignASN1(rand.Reader, a.privateKey, signedHash[:])
	if err != nil {
		t.Fatalf("sign WebAuthn assertion: %v", err)
	}
	encoded, err := json.Marshal(map[string]any{
		"id":    base64.RawURLEncoding.EncodeToString(a.credentialID),
		"rawId": base64.RawURLEncoding.EncodeToString(a.credentialID),
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(clientData),
			"authenticatorData": base64.RawURLEncoding.EncodeToString(authenticatorData),
			"signature":         base64.RawURLEncoding.EncodeToString(signature),
		},
	})
	if err != nil {
		t.Fatalf("marshal assertion response: %v", err)
	}
	return encoded
}

type testSignerWebAuthnFixtureV2 struct {
	store         *signerStoreV2
	keys          *signerKeyManagerV2
	service       *signerWebAuthnServiceV2
	authenticator *testWebAuthnAuthenticatorV2
	policy        signerPolicyV2
	now           time.Time
	walletID      string
	semantic      json.RawMessage
	txDigest      string
	dbPath        string
}

func newTestSignerWebAuthnFixtureV2(t *testing.T) *testSignerWebAuthnFixtureV2 {
	t.Helper()
	dir := t.TempDir()
	store, err := openSignerStoreV2(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatalf("open signer store: %v", err)
	}
	keys, err := openSignerKeyManagerV2(store, filepath.Join(dir, "master.key"))
	if err != nil {
		_ = store.Close()
		t.Fatalf("open signer keys: %v", err)
	}
	fixture := &testSignerWebAuthnFixtureV2{
		store:    store,
		keys:     keys,
		now:      time.Date(2026, 7, 16, 18, 0, 0, 0, time.UTC),
		walletID: "vault",
		semantic: json.RawMessage(`{
			"type":"solana.nativeTransfer",
			"destination":"So11111111111111111111111111111111111111112",
			"lamports":"1000"
		}`),
		txDigest: "sha256:" + strings.Repeat("a", 64),
		dbPath:   filepath.Join(dir, "state.db"),
	}
	store.now = func() time.Time { return fixture.now }
	destination := solana.NewWallet().PublicKey().String()
	policyInput := testSignerPolicyV2(fixture.walletID, destination, 10_000, 100_000)
	policyInput.Role = "vault"
	_, fixture.policy, err = keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID:        fixture.walletID,
		ExpectedVersion: 0,
		Policy:          policyInput,
	})
	if err != nil {
		keys.Close()
		_ = store.Close()
		t.Fatalf("create signer wallet: %v", err)
	}
	fixture.service, err = newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
	if err != nil {
		keys.Close()
		_ = store.Close()
		t.Fatalf("create signer WebAuthn service: %v", err)
	}
	fixture.authenticator = newTestWebAuthnAuthenticatorV2(t)
	t.Cleanup(func() {
		if fixture.keys != nil {
			fixture.keys.Close()
		}
		if fixture.store != nil {
			_ = fixture.store.Close()
		}
	})
	return fixture
}

func (f *testSignerWebAuthnFixtureV2) enroll(t *testing.T, authenticator *testWebAuthnAuthenticatorV2) signerWebAuthnCredentialMetadataV2 {
	t.Helper()
	begin, err := f.service.beginRegistration("Primary hardware key")
	if err != nil {
		t.Fatalf("begin registration: %v", err)
	}
	response := authenticator.registrationResponse(t, begin.Options, testWebAuthnOrigin, 0x45, 1)
	finish, err := f.service.finishRegistration(signerWebAuthnRegistrationFinishRequestV2{
		ChallengeID: begin.ChallengeID,
		Credential:  response,
	})
	if err != nil {
		t.Fatalf("finish registration: %v", err)
	}
	return finish.Credential
}

func (f *testSignerWebAuthnFixtureV2) beginReview(t *testing.T) signerReviewAuthorizationBeginResultV2 {
	t.Helper()
	result, err := f.service.beginReviewAuthorization(f.walletID, signerReviewAuthorizationBeginRequestV2{
		RequestID:         "review-request-001",
		PolicyHash:        f.policy.Hash,
		SemanticIntent:    f.semantic,
		TransactionDigest: f.txDigest,
	})
	if err != nil {
		t.Fatalf("begin review authorization: %v", err)
	}
	return result
}

func (f *testSignerWebAuthnFixtureV2) finishReview(
	t *testing.T,
	begin signerReviewAuthorizationBeginResultV2,
	authenticator *testWebAuthnAuthenticatorV2,
	counter uint32,
) (signerReviewAuthorizationFinishResultV2, error) {
	t.Helper()
	response := authenticator.assertionResponse(
		t,
		begin.Options,
		testWebAuthnOrigin,
		testWebAuthnRPID,
		"",
		0x05,
		counter,
	)
	return f.service.finishReviewAuthorization(f.walletID, signerReviewAuthorizationFinishRequestV2{
		ChallengeID: begin.ChallengeID,
		Credential:  response,
	})
}

func TestSignerWebAuthnConfigurationIsExactAndFailClosed(t *testing.T) {
	store, _ := openTestSignerV2(t)
	if _, err := newSignerWebAuthnServiceV2(store, "", testWebAuthnOrigin); err == nil {
		t.Fatal("expected partial WebAuthn configuration to fail")
	}
	if _, err := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, "http://wallet.example.test"); err == nil {
		t.Fatal("expected non-local HTTP origin to fail")
	}
	if _, err := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, "https://attacker.example.net"); err == nil {
		t.Fatal("expected origin outside RP ID to fail")
	}
	service, err := newSignerWebAuthnServiceV2(store, "localhost", "http://localhost:8787")
	if err != nil || !service.enabled {
		t.Fatalf("expected localhost development origin to be accepted: %v", err)
	}
}

func TestSignerWebAuthnFirstEnrollmentRequiresControlSocketAndDerivesAttestedKey(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	service := &signerServiceV2{store: fixture.store, keys: fixture.keys, webauthn: fixture.service}
	body := json.RawMessage(`{"label":"Primary hardware key"}`)
	if _, err := service.handle(request{Op: "v2.webauthn.registration.begin", Request: body}, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "control socket") {
		t.Fatalf("expected application socket enrollment to be denied, got %v", err)
	}
	beginRaw, err := service.handle(request{Op: "v2.webauthn.registration.begin", Request: body}, signerConfig{}, true)
	if err != nil {
		t.Fatalf("control-socket registration begin: %v", err)
	}
	var envelope struct {
		Result signerWebAuthnRegistrationBeginResultV2 `json:"result"`
	}
	if err := json.Unmarshal(beginRaw, &envelope); err != nil {
		t.Fatalf("decode registration begin: %v", err)
	}
	response := fixture.authenticator.registrationResponse(t, envelope.Result.Options, testWebAuthnOrigin, 0x45, 1)
	finishBody, _ := json.Marshal(signerWebAuthnRegistrationFinishRequestV2{
		ChallengeID: envelope.Result.ChallengeID,
		Credential:  response,
	})
	if _, err := service.handle(request{Op: "v2.webauthn.registration.finish", Request: finishBody}, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "control socket") {
		t.Fatalf("expected application socket registration finish to be denied, got %v", err)
	}
	if _, err := service.handle(request{Op: "v2.webauthn.registration.finish", Request: finishBody}, signerConfig{}, true); err != nil {
		t.Fatalf("control-socket registration finish: %v", err)
	}

	credentials, err := fixture.service.listCredentials()
	if err != nil || len(credentials) != 1 {
		t.Fatalf("expected one signer-owned credential: %#v err=%v", credentials, err)
	}
	if credentials[0].ID != base64.RawURLEncoding.EncodeToString(fixture.authenticator.credentialID) {
		t.Fatalf("stored credential ID did not come from attestation: %#v", credentials[0])
	}
	err = fixture.store.db.View(func(tx *bolt.Tx) error {
		records, err := loadSignerWebAuthnCredentialRecordsV2(tx)
		if err != nil {
			return err
		}
		if len(records) != 1 || !bytes.Equal(records[0].Credential.PublicKey, fixture.authenticator.cosePublicKey(t)) {
			return errors.New("stored credential public key was not derived from the verified attestation")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSignerWebAuthnRejectsAdversarialAssertions(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	fixture.enroll(t, fixture.authenticator)
	unknown := newTestWebAuthnAuthenticatorV2(t)
	forger := newTestWebAuthnAuthenticatorV2(t)
	forger.credentialID = append([]byte(nil), fixture.authenticator.credentialID...)

	tests := []struct {
		name      string
		build     func(*testing.T, signerReviewAuthorizationBeginResultV2) json.RawMessage
		wantError string
	}{
		{
			name: "wrong ceremony type",
			build: func(t *testing.T, begin signerReviewAuthorizationBeginResultV2) json.RawMessage {
				return fixture.authenticator.assertionResponseForType(t, begin.Options, testWebAuthnOrigin, testWebAuthnRPID, "", "webauthn.create", 0x05, 2)
			},
			wantError: "verify signer webauthn assertion",
		},
		{
			name: "wrong origin",
			build: func(t *testing.T, begin signerReviewAuthorizationBeginResultV2) json.RawMessage {
				return fixture.authenticator.assertionResponse(t, begin.Options, "https://attacker.example.test", testWebAuthnRPID, "", 0x05, 2)
			},
			wantError: "origin",
		},
		{
			name: "wrong rp id hash",
			build: func(t *testing.T, begin signerReviewAuthorizationBeginResultV2) json.RawMessage {
				return fixture.authenticator.assertionResponse(t, begin.Options, testWebAuthnOrigin, "attacker.example.test", "", 0x05, 2)
			},
			wantError: "verify signer webauthn assertion",
		},
		{
			name: "wrong challenge",
			build: func(t *testing.T, begin signerReviewAuthorizationBeginResultV2) json.RawMessage {
				return fixture.authenticator.assertionResponse(t, begin.Options, testWebAuthnOrigin, testWebAuthnRPID, base64.RawURLEncoding.EncodeToString([]byte("wrong-challenge-value-long-enough")), 0x05, 2)
			},
			wantError: "challenge",
		},
		{
			name: "missing uv",
			build: func(t *testing.T, begin signerReviewAuthorizationBeginResultV2) json.RawMessage {
				return fixture.authenticator.assertionResponse(t, begin.Options, testWebAuthnOrigin, testWebAuthnRPID, "", 0x01, 2)
			},
			wantError: "verify signer webauthn assertion",
		},
		{
			name: "unknown credential",
			build: func(t *testing.T, begin signerReviewAuthorizationBeginResultV2) json.RawMessage {
				return unknown.assertionResponse(t, begin.Options, testWebAuthnOrigin, testWebAuthnRPID, "", 0x05, 2)
			},
			wantError: "unknown",
		},
		{
			name: "invalid signature",
			build: func(t *testing.T, begin signerReviewAuthorizationBeginResultV2) json.RawMessage {
				return forger.assertionResponse(t, begin.Options, testWebAuthnOrigin, testWebAuthnRPID, "", 0x05, 2)
			},
			wantError: "verify signer webauthn assertion",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			begin := fixture.beginReview(t)
			_, err := fixture.service.finishReviewAuthorization(fixture.walletID, signerReviewAuthorizationFinishRequestV2{
				ChallengeID: begin.ChallengeID,
				Credential:  test.build(t, begin),
			})
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), test.wantError) {
				t.Fatalf("expected %q error, got %v", test.wantError, err)
			}
		})
	}
}

func TestSignerWebAuthnProofBindsDigestPolicyNonceAndIsSingleUse(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	fixture.enroll(t, fixture.authenticator)
	begin := fixture.beginReview(t)
	finish, err := fixture.finishReview(t, begin, fixture.authenticator, 2)
	if err != nil {
		t.Fatalf("finish review authorization: %v", err)
	}

	wrongDigest := finish.Binding
	wrongDigest.TransactionDigest = "sha256:" + strings.Repeat("b", 64)
	if err := fixture.service.verifyAndConsumeReviewProofV2(wrongDigest, &finish.Authorization.Proof); err == nil || !strings.Contains(err.Error(), "binding mismatch") {
		t.Fatalf("expected transaction digest mismatch, got %v", err)
	}
	wrongPolicy := finish.Binding
	wrongPolicy.PolicyHash = "sha256:" + strings.Repeat("c", 64)
	if err := fixture.service.verifyAndConsumeReviewProofV2(wrongPolicy, &finish.Authorization.Proof); err == nil || !strings.Contains(err.Error(), "binding mismatch") {
		t.Fatalf("expected policy hash mismatch, got %v", err)
	}
	wrongNonce := finish.Binding
	wrongNonce.Nonce = base64.RawURLEncoding.EncodeToString([]byte("different-nonce-value-which-is-long"))
	if err := fixture.service.verifyAndConsumeReviewProofV2(wrongNonce, &finish.Authorization.Proof); err == nil || !strings.Contains(err.Error(), "binding mismatch") {
		t.Fatalf("expected nonce mismatch, got %v", err)
	}
	if err := fixture.service.verifyAndConsumeReviewProofV2(finish.Binding, &finish.Authorization.Proof); err != nil {
		t.Fatalf("consume exact review authorization: %v", err)
	}
	if err := fixture.service.verifyAndConsumeReviewProofV2(finish.Binding, &finish.Authorization.Proof); err == nil || !strings.Contains(err.Error(), "not pending") {
		t.Fatalf("expected replay rejection, got %v", err)
	}
}

func TestSignerWebAuthnPolicyChangeInvalidatesPendingChallenge(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	fixture.enroll(t, fixture.authenticator)
	begin := fixture.beginReview(t)
	if _, err := fixture.store.putPolicy(signerPolicyV2{WalletID: fixture.walletID, Role: "vault"}, fixture.policy.Version); err != nil {
		t.Fatalf("replace signer policy: %v", err)
	}
	if _, err := fixture.finishReview(t, begin, fixture.authenticator, 2); err == nil || !strings.Contains(err.Error(), "policy is no longer current") {
		t.Fatalf("expected pending challenge to be invalidated by policy change, got %v", err)
	}
}

func TestSignerWebAuthnPolicyChangeInvalidatesIssuedProof(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	fixture.enroll(t, fixture.authenticator)
	begin := fixture.beginReview(t)
	finish, err := fixture.finishReview(t, begin, fixture.authenticator, 2)
	if err != nil {
		t.Fatalf("finish review authorization: %v", err)
	}
	if _, err := fixture.store.putPolicy(signerPolicyV2{WalletID: fixture.walletID, Role: "vault"}, fixture.policy.Version); err != nil {
		t.Fatalf("replace signer policy: %v", err)
	}
	if err := fixture.service.verifyAndConsumeReviewProofV2(finish.Binding, &finish.Authorization.Proof); err == nil || !strings.Contains(err.Error(), "policy is no longer current") {
		t.Fatalf("expected issued proof to be invalidated by policy change, got %v", err)
	}
}

func TestSignerWebAuthnRejectsCounterRollback(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	fixture.enroll(t, fixture.authenticator)
	first := fixture.beginReview(t)
	if _, err := fixture.finishReview(t, first, fixture.authenticator, 2); err != nil {
		t.Fatalf("first assertion: %v", err)
	}
	rollback := fixture.beginReview(t)
	if _, err := fixture.finishReview(t, rollback, fixture.authenticator, 2); err == nil || !strings.Contains(err.Error(), "counter rollback") {
		t.Fatalf("expected counter rollback rejection, got %v", err)
	}
}

func TestSignerWebAuthnProofSurvivesRestartAndConcurrentConsumption(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	fixture.enroll(t, fixture.authenticator)
	begin := fixture.beginReview(t)
	finish, err := fixture.finishReview(t, begin, fixture.authenticator, 2)
	if err != nil {
		t.Fatalf("finish review: %v", err)
	}
	fixture.keys.Close()
	fixture.keys = nil
	if err := fixture.store.Close(); err != nil {
		t.Fatalf("close signer store: %v", err)
	}
	fixture.store = nil

	reopened, err := openSignerStoreV2(fixture.dbPath)
	if err != nil {
		t.Fatalf("reopen signer store: %v", err)
	}
	reopened.now = func() time.Time { return fixture.now }
	fixture.store = reopened
	fixture.service, err = newSignerWebAuthnServiceV2(reopened, testWebAuthnRPID, testWebAuthnOrigin)
	if err != nil {
		t.Fatalf("reopen signer WebAuthn service: %v", err)
	}
	health, err := fixture.service.health()
	if err != nil || health.CredentialCount != 1 {
		t.Fatalf("credential did not survive restart: %#v err=%v", health, err)
	}

	var wait sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			results <- fixture.service.verifyAndConsumeReviewProofV2(finish.Binding, &finish.Authorization.Proof)
		}()
	}
	wait.Wait()
	close(results)
	successes := 0
	rejections := 0
	for result := range results {
		if result == nil {
			successes++
		} else if strings.Contains(result.Error(), "not pending") {
			rejections++
		} else {
			t.Fatalf("unexpected concurrent proof error: %v", result)
		}
	}
	if successes != 1 || rejections != 1 {
		t.Fatalf("expected one proof consumption and one replay rejection, successes=%d rejections=%d", successes, rejections)
	}
}

func TestSignerWebAuthnChallengesAndProofsExpireDurably(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	fixture.enroll(t, fixture.authenticator)
	begin := fixture.beginReview(t)
	fixture.now = fixture.now.Add(signerWebAuthnReviewTTL + time.Second)
	response := fixture.authenticator.assertionResponse(t, begin.Options, testWebAuthnOrigin, testWebAuthnRPID, "", 0x05, 2)
	if _, err := fixture.service.finishReviewAuthorization(fixture.walletID, signerReviewAuthorizationFinishRequestV2{
		ChallengeID: begin.ChallengeID,
		Credential:  response,
	}); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expected challenge expiry, got %v", err)
	}

	fixture.now = time.Date(2026, 7, 16, 19, 0, 0, 0, time.UTC)
	begin = fixture.beginReview(t)
	finish, err := fixture.finishReview(t, begin, fixture.authenticator, 2)
	if err != nil {
		t.Fatalf("finish second review: %v", err)
	}
	fixture.now = fixture.now.Add(signerWebAuthnProofTTL + time.Second)
	if err := fixture.service.verifyAndConsumeReviewProofV2(finish.Binding, &finish.Authorization.Proof); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expected proof expiry, got %v", err)
	}
}

func TestSignerReviewIntentCanonicalizationRejectsDuplicateKeys(t *testing.T) {
	_, _, _, err := normalizeSignerReviewIntentV2(json.RawMessage(`{"type":"one","type":"two"}`))
	if err == nil || !strings.Contains(err.Error(), "duplicate key") {
		t.Fatalf("expected duplicate semantic key rejection, got %v", err)
	}
	canonicalA, _, digestA, err := normalizeSignerReviewIntentV2(json.RawMessage(`{"type":"x","amount":"1","nested":{"b":2,"a":1}}`))
	if err != nil {
		t.Fatalf("normalize first semantic intent: %v", err)
	}
	canonicalB, _, digestB, err := normalizeSignerReviewIntentV2(json.RawMessage(`{"nested":{"a":1,"b":2},"amount":"1","type":"x"}`))
	if err != nil {
		t.Fatalf("normalize second semantic intent: %v", err)
	}
	if digestA != digestB || string(canonicalA) != string(canonicalB) {
		t.Fatalf("expected deterministic semantic digest: %s %s / %s %s", canonicalA, canonicalB, digestA, digestB)
	}
}

func TestSignerWebAuthnMissingPolicyAndWrongPolicyHashFailClosed(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	fixture.enroll(t, fixture.authenticator)
	_, err := fixture.service.beginReviewAuthorization(fixture.walletID, signerReviewAuthorizationBeginRequestV2{
		RequestID:         "wrong-policy-hash",
		PolicyHash:        "sha256:" + strings.Repeat("f", 64),
		SemanticIntent:    fixture.semantic,
		TransactionDigest: fixture.txDigest,
	})
	if err == nil || !strings.Contains(err.Error(), "policy hash mismatch") {
		t.Fatalf("expected wrong policy hash rejection, got %v", err)
	}
	_, err = fixture.service.beginReviewAuthorization("missing", signerReviewAuthorizationBeginRequestV2{
		RequestID:         "missing-policy-001",
		PolicyHash:        fixture.policy.Hash,
		SemanticIntent:    fixture.semantic,
		TransactionDigest: fixture.txDigest,
	})
	if err == nil || !strings.Contains(err.Error(), "explicit signer policy required") {
		t.Fatalf("expected missing policy rejection, got %v", err)
	}
}
