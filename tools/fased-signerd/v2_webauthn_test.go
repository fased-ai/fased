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
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
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
	destination := solanaNativeMintV2
	policyInput := testSignerPolicyV2(fixture.walletID, destination, 10_000, 100_000)
	policyInput.Role = "vault"
	walletRecord, createdPolicy, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID:        fixture.walletID,
		ExpectedVersion: 0,
		Policy:          policyInput,
	})
	if err != nil {
		keys.Close()
		_ = store.Close()
		t.Fatalf("create signer wallet: %v", err)
	}
	fixture.policy = createdPolicy
	var fixtureIntent signerIntentV2
	if err := decodeSignerRequestV2(fixture.semantic, &fixtureIntent); err != nil {
		t.Fatalf("decode fixture review intent: %v", err)
	}
	normalizedFixtureIntent, err := normalizeSignerIntentV2(fixtureIntent)
	if err != nil {
		t.Fatalf("normalize fixture review intent: %v", err)
	}
	fixture.semantic, err = json.Marshal(normalizedFixtureIntent.Intent)
	if err != nil {
		t.Fatalf("encode fixture review intent: %v", err)
	}
	reviewTransaction := &signerSolanaTransactionEnvelopeV2{
		SerializedTxBase64: "AQ==",
		Programs:           []string{solana.SystemProgramID.String()},
		WritableAccounts:   []string{destination},
		Submission:         jupiterSubmissionRPCV2,
	}
	review := signerReviewV2{
		RequestID:         "review-request-001",
		WalletID:          fixture.walletID,
		WalletPublicKey:   walletRecord.PublicKey,
		IntentType:        normalizedFixtureIntent.Intent.Type,
		IntentDigest:      normalizedFixtureIntent.Digest,
		PolicyHash:        fixture.policy.Hash,
		Mode:              jupiterReviewModeReviewedV2,
		Nonce:             strings.Repeat("c", 64),
		SemanticIntent:    fixture.semantic,
		ArtifactKind:      signerReviewArtifactSolanaTransactionV2,
		ArtifactDigest:    fixture.txDigest,
		Transaction:       reviewTransaction,
		Asset:             normalizedFixtureIntent.Asset,
		Amount:            normalizedFixtureIntent.Amount.String(),
		Destination:       normalizedFixtureIntent.Destination,
		PolicyOperation:   normalizedFixtureIntent.Intent.Type,
		RequiredPrograms:  normalizedFixtureIntent.RequiredPrograms,
		IssuedAt:          timestampV2(fixture.now),
		State:             jupiterReviewPreparedV2,
		PreparedAt:        timestampV2(fixture.now),
		ExpiresAt:         timestampV2(reviewExpiryV2(fixture.now)),
		UpdatedAt:         timestampV2(fixture.now),
		TransactionDigest: fixture.txDigest,
	}
	encodedReview, err := json.Marshal(review)
	if err != nil {
		t.Fatalf("encode fixture signer review: %v", err)
	}
	if err := fixture.store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerReviewsV2).Put([]byte(review.RequestID), encodedReview)
	}); err != nil {
		t.Fatalf("store fixture signer review: %v", err)
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
		RequestID: "review-request-001",
	})
	if err != nil {
		t.Fatalf("begin review authorization: %v", err)
	}
	return result
}

func (f *testSignerWebAuthnFixtureV2) refreshReview(t *testing.T) {
	t.Helper()
	if err := f.store.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerReviewsV2)
		raw := bucket.Get([]byte("review-request-001"))
		if raw == nil {
			return errors.New("fixture signer review not found")
		}
		var review signerReviewV2
		if err := json.Unmarshal(raw, &review); err != nil {
			return err
		}
		review.Nonce = strings.Repeat("d", 64)
		review.IssuedAt = timestampV2(f.now)
		review.PreparedAt = timestampV2(f.now)
		review.ExpiresAt = timestampV2(reviewExpiryV2(f.now))
		review.UpdatedAt = timestampV2(f.now)
		encoded, err := json.Marshal(review)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(review.RequestID), encoded)
	}); err != nil {
		t.Fatalf("refresh fixture signer review: %v", err)
	}
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

func TestSignerReviewedVaultTransferBuildsExactTransactionAndExecutesWithWebAuthn(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	fixture.enroll(t, fixture.authenticator)
	if err := fixture.store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerReviewsV2).Delete([]byte("review-request-001"))
	}); err != nil {
		t.Fatal(err)
	}
	var blockhash solana.Hash
	blockhash[0] = 7
	rpcServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		var body struct {
			ID     any               `json:"id"`
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode signer RPC request: %v", err)
		}
		writer.Header().Set("Content-Type", "application/json")
		response := map[string]any{"jsonrpc": "2.0", "id": body.ID}
		switch body.Method {
		case "getGenesisHash":
			response["result"] = "11111111111111111111111111111111"
		case "getLatestBlockhash":
			response["result"] = map[string]any{
				"context": map[string]any{"slot": 1},
				"value": map[string]any{
					"blockhash":            blockhash.String(),
					"lastValidBlockHeight": 999999,
				},
			}
		case "simulateTransaction":
			response["result"] = map[string]any{
				"context": map[string]any{"slot": 1},
				"value":   map[string]any{"err": nil, "logs": []string{}, "unitsConsumed": 1},
			}
		case "sendTransaction":
			if len(body.Params) == 0 {
				t.Fatal("sendTransaction omitted signed bytes")
			}
			var encoded string
			if err := json.Unmarshal(body.Params[0], &encoded); err != nil {
				t.Fatalf("decode signed transaction: %v", err)
			}
			raw, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				t.Fatalf("decode signed transaction bytes: %v", err)
			}
			tx, err := solana.TransactionFromBytes(raw)
			if err != nil || len(tx.Signatures) != 1 || tx.Signatures[0].IsZero() {
				t.Fatalf("signer submitted invalid signed transaction: %v", err)
			}
			response["result"] = tx.Signatures[0].String()
		case "getSignatureStatuses":
			response["result"] = map[string]any{
				"context": map[string]any{"slot": 2},
				"value": []any{map[string]any{
					"slot":               2,
					"confirmations":      nil,
					"err":                nil,
					"confirmationStatus": "confirmed",
				}},
			}
		default:
			t.Fatalf("unexpected signer RPC method %q", body.Method)
		}
		if err := json.NewEncoder(writer).Encode(response); err != nil {
			t.Fatalf("encode signer RPC response: %v", err)
		}
	}))
	defer rpcServer.Close()
	if _, err := fixture.keys.PutNetworkV2(fixture.walletID, signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0),
		PrimaryRPCURL:   rpcServer.URL,
	}); err != nil {
		t.Fatalf("configure signer-owned RPC: %v", err)
	}
	var intent signerIntentV2
	if err := json.Unmarshal(fixture.semantic, &intent); err != nil {
		t.Fatal(err)
	}
	service := &signerServiceV2{store: fixture.store, keys: fixture.keys, webauthn: fixture.service}
	review, err := service.prepareJupiterReviewV2(fixture.walletID, signerReviewPrepareRequestV2{
		RequestID:  "review-request-001",
		PolicyHash: fixture.policy.Hash,
		Mode:       jupiterReviewModeReviewedV2,
		Intent:     intent,
	})
	if err != nil {
		t.Fatalf("prepare signer-built reviewed transfer: %v", err)
	}
	if review.Transaction == nil || review.Transaction.SerializedTxBase64 == "" || review.TransactionDigest == "" || review.Transaction.Submission != jupiterSubmissionRPCV2 {
		t.Fatalf("signer did not persist exact reviewed transaction: %#v", review)
	}
	callerTransaction := review.Transaction
	if _, err := service.prepareJupiterReviewV2(fixture.walletID, signerReviewPrepareRequestV2{
		RequestID:   "review-request-002",
		PolicyHash:  fixture.policy.Hash,
		Mode:        jupiterReviewModeReviewedV2,
		Intent:      intent,
		Transaction: callerTransaction,
	}); err == nil || !strings.Contains(err.Error(), "built only by the signer") {
		t.Fatalf("reviewed transfer accepted caller transaction substitution: %v", err)
	}
	begin := fixture.beginReview(t)
	finish, err := fixture.finishReview(t, begin, fixture.authenticator, 2)
	if err != nil {
		t.Fatalf("finish signer-owned WebAuthn authorization: %v", err)
	}
	result, err := service.executeJupiterReviewV2(fixture.walletID, signerReviewExecuteRequestV2{
		RequestID:     review.RequestID,
		Authorization: &finish.Authorization,
	})
	if err != nil {
		t.Fatalf("execute exact reviewed transfer: %v", err)
	}
	if result.Operation == nil || result.Operation.State != operationConfirmed || result.Operation.Signature == "" || result.Review.State != jupiterReviewSignedV2 {
		t.Fatalf("reviewed transfer did not reach one confirmed execution: %#v", result)
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

func TestSignerReviewedAuthorizationWithNoCredentialFailsWithNativeAdminWorkflow(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	_, err := fixture.service.beginReviewAuthorization(fixture.walletID, signerReviewAuthorizationBeginRequestV2{
		RequestID: "review-request-001",
	})
	if err == nil {
		t.Fatal("expected reviewed authorization to fail before native WebAuthn enrollment")
	}
	message := err.Error()
	for _, required := range []string{
		"no signer-owned WebAuthn credential is enrolled",
		"fased-signerd admin webauthn registration begin",
		"--control-socket <signer-control.sock>",
		"webauthn registration finish",
		"Gateway enrollment is intentionally unavailable",
	} {
		if !strings.Contains(message, required) {
			t.Fatalf("zero-credential error omitted %q: %v", required, err)
		}
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
	fixture.refreshReview(t)
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

func TestSignerWebAuthnAuthorizationBeginLoadsOnlySignerOwnedReview(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	fixture.enroll(t, fixture.authenticator)
	service := &signerServiceV2{store: fixture.store, keys: fixture.keys, webauthn: fixture.service}
	for _, body := range []string{
		`{"requestId":"review-request-001","policyHash":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}`,
		`{"requestId":"review-request-001","transactionDigest":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}`,
		`{"requestId":"review-request-001","semanticIntent":{"type":"solana.nativeTransfer"}}`,
	} {
		if _, err := service.handle(request{
			Op:       "v2.review.authorization.begin",
			WalletID: fixture.walletID,
			Request:  json.RawMessage(body),
		}, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "invalid signer-v2 request") {
			t.Fatalf("expected caller-supplied review binding to be rejected, body=%s err=%v", body, err)
		}
	}
	if _, err := service.handle(request{
		Op:       "v2.review.execute",
		WalletID: fixture.walletID,
		Request:  json.RawMessage(`{"requestId":"review-request-001","transaction":{"serializedTxBase64":"Ag=="}}`),
	}, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "invalid signer-v2 request") {
		t.Fatalf("expected execute-time transaction substitution to be rejected, got %v", err)
	}
	_, err := fixture.service.beginReviewAuthorization("missing", signerReviewAuthorizationBeginRequestV2{
		RequestID: "missing-policy-001",
	})
	if err == nil || !strings.Contains(err.Error(), "review not found") {
		t.Fatalf("expected missing signer-owned review rejection, got %v", err)
	}
}

func TestSignerWebAuthnCredentialRevocationIsFencedAtomicAndInvalidatesPendingAuthority(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	primary := fixture.authenticator
	backup := newTestWebAuthnAuthenticatorV2(t)
	primaryMetadata := fixture.enroll(t, primary)
	backupMetadata := fixture.enroll(t, backup)

	summary, err := fixture.service.credentialSummary()
	if err != nil || summary.Version != 2 || summary.Count != 2 || len(summary.Credentials) != 2 {
		t.Fatalf("unexpected enrolled credential fence: %#v err=%v", summary, err)
	}
	begin := fixture.beginReview(t)
	proof, err := fixture.finishReview(t, begin, primary, 2)
	if err != nil {
		t.Fatalf("issue primary credential proof: %v", err)
	}
	pendingReview := fixture.beginReview(t)
	pendingRegistration, err := fixture.service.beginRegistration("Replacement key")
	if err != nil {
		t.Fatalf("begin pending replacement registration: %v", err)
	}

	stale := signerWebAuthnCredentialRevokeRequestV2{
		CredentialID:    primaryMetadata.ID,
		ExpectedCount:   2,
		ExpectedVersion: 1,
	}
	if _, err := fixture.service.revokeCredential(stale); err == nil || !strings.Contains(err.Error(), "state conflict") {
		t.Fatalf("credential revoke accepted a stale optimistic fence: %v", err)
	}
	unchanged, err := fixture.service.credentialSummary()
	if err != nil || unchanged.Version != 2 || unchanged.Count != 2 {
		t.Fatalf("stale revoke mutated credential state: %#v err=%v", unchanged, err)
	}

	revoke := stale
	revoke.ExpectedVersion = summary.Version
	result, err := fixture.service.revokeCredential(revoke)
	if err != nil {
		t.Fatalf("revoke exact primary credential: %v", err)
	}
	if result.Revoked.ID != primaryMetadata.ID || result.Version != 3 || result.Count != 1 ||
		result.InvalidatedChallenges != 2 || result.InvalidatedProofs != 1 {
		t.Fatalf("unexpected credential revoke result: %#v", result)
	}
	remaining, err := fixture.service.credentialSummary()
	if err != nil || remaining.Version != 3 || remaining.Count != 1 || len(remaining.Credentials) != 1 || remaining.Credentials[0].ID != backupMetadata.ID {
		t.Fatalf("credential membership/version was not updated atomically: %#v err=%v", remaining, err)
	}
	if err := fixture.store.db.View(func(tx *bolt.Tx) error {
		for _, challengeID := range []string{pendingReview.ChallengeID, pendingRegistration.ChallengeID} {
			if tx.Bucket(bucketSignerWebAuthnChallengesV2).Get([]byte(challengeID)) != nil {
				return fmt.Errorf("pending challenge %s survived credential revocation", challengeID)
			}
		}
		if tx.Bucket(bucketSignerReviewProofsV2).Get([]byte(proof.Authorization.Proof.ProofID)) != nil {
			return errors.New("unused proof issued by the revoked credential survived")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	last := signerWebAuthnCredentialRevokeRequestV2{
		CredentialID:    backupMetadata.ID,
		ExpectedCount:   1,
		ExpectedVersion: 3,
	}
	if _, err := fixture.service.revokeCredential(last); err == nil || !strings.Contains(err.Error(), "last WebAuthn credential") {
		t.Fatalf("last credential was removed without explicit admin confirmation: %v", err)
	}
	afterRefusal, err := fixture.service.credentialSummary()
	if err != nil || afterRefusal.Version != 3 || afterRefusal.Count != 1 {
		t.Fatalf("last-credential refusal mutated state: %#v err=%v", afterRefusal, err)
	}
	last.ConfirmLastCredential = true
	lastResult, err := fixture.service.revokeCredential(last)
	if err != nil || lastResult.Version != 4 || lastResult.Count != 0 {
		t.Fatalf("explicit control-owned last credential revoke failed: %#v err=%v", lastResult, err)
	}
}

func TestSignerWebAuthnCredentialRevokeOpIsStrictAndControlOnly(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	metadata := fixture.enroll(t, fixture.authenticator)
	service := &signerServiceV2{store: fixture.store, keys: fixture.keys, webauthn: fixture.service}
	body, _ := json.Marshal(signerWebAuthnCredentialRevokeRequestV2{
		CredentialID:          metadata.ID,
		ExpectedCount:         1,
		ExpectedVersion:       1,
		ConfirmLastCredential: true,
	})
	req := request{Op: "v2.webauthn.credentials.revoke", Request: body}
	if _, err := service.handle(req, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "control socket") {
		t.Fatalf("application socket reached credential revocation: %v", err)
	}
	unknown := append([]byte{}, body[:len(body)-1]...)
	unknown = append(unknown, []byte(`,"unexpected":true}`)...)
	if _, err := service.handle(requestWithBodyV2(req, unknown), signerConfig{}, true); err == nil || !strings.Contains(err.Error(), "invalid signer-v2 request") {
		t.Fatalf("credential revocation accepted unknown fields: %v", err)
	}
	if _, err := service.handle(req, signerConfig{readOnly: true}, true); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("read-only signer allowed credential revocation: %v", err)
	}
}

func TestSignerWebAuthnConcurrentRevocationHasOneAtomicWinner(t *testing.T) {
	fixture := newTestSignerWebAuthnFixtureV2(t)
	metadata := fixture.enroll(t, fixture.authenticator)
	req := signerWebAuthnCredentialRevokeRequestV2{
		CredentialID:          metadata.ID,
		ExpectedCount:         1,
		ExpectedVersion:       1,
		ConfirmLastCredential: true,
	}
	const workers = 8
	results := make(chan error, workers)
	var wait sync.WaitGroup
	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := fixture.service.revokeCredential(req)
			results <- err
		}()
	}
	wait.Wait()
	close(results)
	successes := 0
	conflicts := 0
	for err := range results {
		if err == nil {
			successes++
		} else if strings.Contains(err.Error(), "state conflict") {
			conflicts++
		} else {
			t.Fatalf("unexpected concurrent revoke result: %v", err)
		}
	}
	if successes != 1 || conflicts != workers-1 {
		t.Fatalf("concurrent revoke successes=%d conflicts=%d", successes, conflicts)
	}
	summary, err := fixture.service.credentialSummary()
	if err != nil || summary.Version != 2 || summary.Count != 0 {
		t.Fatalf("concurrent revoke did not converge to one state transition: %#v err=%v", summary, err)
	}
}
