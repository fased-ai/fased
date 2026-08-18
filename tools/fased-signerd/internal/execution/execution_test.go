package execution

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

func TestRPCPoolCircuitBackoffOrderAndReset(t *testing.T) {
	now := time.Unix(100, 0)
	pool := NewRPCPool(func() time.Time { return now })
	primary, fallback := "https://primary.invalid", "https://fallback.invalid"
	pool.MarkFailure(primary, errors.New("429 quota exhausted"))
	active, err := pool.ActiveURLs([]string{primary, fallback})
	if err != nil || len(active) != 1 || active[0] != fallback {
		t.Fatalf("quota cooldown did not preserve fallback order: active=%v err=%v", active, err)
	}
	now = now.Add(30 * time.Second)
	active, err = pool.ActiveURLs([]string{primary, fallback})
	if err != nil || len(active) != 2 || active[0] != primary || active[1] != fallback {
		t.Fatalf("expired cooldown did not restore configured order: active=%v err=%v", active, err)
	}
	pool.MarkFailure(primary, errors.New("temporary network failure"))
	active, err = pool.ActiveURLs([]string{primary, fallback})
	if err != nil || len(active) != 1 || active[0] != fallback {
		t.Fatalf("quota expiry erased primary failure history: active=%v err=%v", active, err)
	}
	pool.MarkSuccess(primary)
	active, err = pool.ActiveURLs([]string{primary, fallback})
	if err != nil || len(active) != 2 || active[0] != primary || active[1] != fallback {
		t.Fatalf("success did not reset primary endpoint state: active=%v err=%v", active, err)
	}
	if _, err := pool.ActiveURLs([]string{"", "  "}); err == nil || err.Error() != "missing Solana write RPC URL" {
		t.Fatalf("missing endpoints error changed: %v", err)
	}
}

func TestRPCPoolBlockhashFallbackAndCredentialSafeError(t *testing.T) {
	blockhash := solana.NewWallet().PublicKey().String()
	fallback := rpcServer(t, func(method string) (any, *rpcError) {
		if method != "getLatestBlockhash" {
			t.Fatalf("unexpected fallback method %q", method)
		}
		return map[string]any{"context": map[string]any{"slot": 1}, "value": map[string]any{"blockhash": blockhash, "lastValidBlockHeight": 9}}, nil
	})
	primary := rpcServer(t, func(method string) (any, *rpcError) {
		if method != "getLatestBlockhash" {
			t.Fatalf("unexpected primary method %q", method)
		}
		return nil, &rpcError{Code: -32000, Message: "primary failed"}
	})
	pool := NewRPCPool(nil)
	got, err := pool.LatestBlockhashWithFallback([]string{primary.URL + "?api-key=secret", fallback.URL}, time.Second)
	if err != nil || got.String() != blockhash {
		t.Fatalf("blockhash fallback failed: hash=%s err=%v", got, err)
	}
	malformed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("{")) }))
	defer malformed.Close()
	_, err = NewRPCPool(nil).LatestBlockhashWithFallback([]string{malformed.URL + "?api-key=write-rpc-secret"}, time.Second)
	if err == nil || strings.Contains(err.Error(), "write-rpc-secret") {
		t.Fatalf("credential-safe blockhash failure changed: %v", err)
	}
}

func TestRPCPoolBroadcastAndStatuses(t *testing.T) {
	privateKey := solana.NewWallet().PrivateKey
	tx := signedTransaction(t, privateKey)
	raw, err := tx.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	expected := tx.Signatures[0]
	server := rpcServer(t, func(method string) (any, *rpcError) {
		switch method {
		case "sendTransaction":
			return expected.String(), nil
		case "getSignatureStatuses":
			return map[string]any{"context": map[string]any{"slot": 1}, "value": []any{map[string]any{"err": nil, "confirmationStatus": "confirmed"}}}, nil
		default:
			t.Fatalf("unexpected method %q", method)
			return nil, nil
		}
	})
	pool := NewRPCPool(nil)
	if err := pool.BroadcastSignedOnce([]string{server.URL}, raw, expected, time.Second); err != nil {
		t.Fatalf("broadcast: %v", err)
	}
	status, err := pool.LookupSignatureStatus([]string{server.URL}, expected, time.Second)
	if err != nil || status != "confirmed" {
		t.Fatalf("status: %q %v", status, err)
	}
	if err := pool.ConfirmSignatureAcrossRPCs([]string{server.URL}, expected, time.Second, time.Second); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	var differentSignature solana.Signature
	differentSignature[0] = 1
	mismatch := rpcServer(t, func(method string) (any, *rpcError) { return differentSignature.String(), nil })
	if err := NewRPCPool(nil).BroadcastSignedOnce([]string{mismatch.URL}, raw, expected, time.Second); err == nil || err.Error() != "Solana RPC returned a different signature for the signed transaction" {
		t.Fatalf("signature mismatch error changed: %v", err)
	}
}

func TestRPCPoolStatusOutcomesAndBoundedTimeout(t *testing.T) {
	var signature solana.Signature
	signature[0] = 1
	for name, value := range map[string]any{
		"failed":  map[string]any{"err": map[string]any{"InstructionError": []any{0, "Custom"}}, "confirmationStatus": "confirmed"},
		"pending": map[string]any{"err": nil, "confirmationStatus": "processed"},
		"unknown": nil,
	} {
		t.Run(name, func(t *testing.T) {
			server := rpcServer(t, func(method string) (any, *rpcError) {
				if method != "getSignatureStatuses" {
					t.Fatalf("unexpected method %q", method)
				}
				return map[string]any{"context": map[string]any{"slot": 1}, "value": []any{value}}, nil
			})
			status, err := NewRPCPool(nil).LookupSignatureStatus([]string{server.URL}, signature, time.Second)
			if err != nil || status != name {
				t.Fatalf("status outcome: %q %v", status, err)
			}
		})
	}
	pending := rpcServer(t, func(string) (any, *rpcError) {
		return map[string]any{"context": map[string]any{"slot": 1}, "value": []any{nil}}, nil
	})
	err := NewRPCPool(nil).ConfirmSignatureAcrossRPCs([]string{pending.URL}, signature, time.Second, 10*time.Millisecond)
	if err == nil || err.Error() != "signer-owned Solana RPC confirmation timed out" {
		t.Fatalf("confirmation timeout changed: %v", err)
	}
}

func TestSigningAndStoredArtifactPrimitives(t *testing.T) {
	privateKey := solana.NewWallet().PrivateKey
	legacy, err := NewSignedTypedTransaction([]solana.Instruction{testInstruction(privateKey.PublicKey())}, solana.Hash{}, privateKey, nil)
	if err != nil || len(legacy.Signatures) != 1 || legacy.Signatures[0].IsZero() {
		t.Fatalf("legacy typed signing failed: tx=%#v err=%v", legacy, err)
	}
	table, lookup := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	v0, err := NewSignedTypedTransaction([]solana.Instruction{solana.NewInstruction(solana.SystemProgramID, solana.AccountMetaSlice{
		&solana.AccountMeta{PublicKey: privateKey.PublicKey(), IsSigner: true, IsWritable: true},
		&solana.AccountMeta{PublicKey: lookup, IsWritable: true},
	}, []byte{1})}, solana.Hash{}, privateKey, map[solana.PublicKey]solana.PublicKeySlice{table: {lookup}})
	if err != nil || v0.Message.GetVersion() != solana.MessageVersionV0 || len(v0.Message.GetAddressTableLookups()) != 1 {
		t.Fatalf("v0 typed signing failed: tx=%#v err=%v", v0, err)
	}
	message := []byte("fased:federation exact message")
	signatureBase64, err := SignDomainMessageBase64(privateKey, message)
	signature, decodeErr := base64.StdEncoding.DecodeString(signatureBase64)
	if err != nil || decodeErr != nil || !ed25519.Verify(ed25519.PublicKey(privateKey.PublicKey().Bytes()), message, signature) {
		t.Fatalf("domain message signing failed: sign=%v decode=%v", err, decodeErr)
	}
	raw, err := legacy.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	encoded := base64.StdEncoding.EncodeToString(raw)
	if _, _, err := DecodeStoredSignedOperation(encoded, "sha256:"+hex.EncodeToString(digest[:]), legacy.Signatures[0].String()); err != nil {
		t.Fatalf("stored artifact validation failed: %v", err)
	}
	if _, _, err := DecodeStoredSignedOperation(encoded, "sha256:bad", legacy.Signatures[0].String()); err == nil || err.Error() != "stored signed transaction artifact digest mismatch" {
		t.Fatalf("stored artifact tamper rejection changed: %v", err)
	}
	if _, _, err := DecodeStoredSignedOperation(encoded, "sha256:"+hex.EncodeToString(digest[:]), solana.NewWallet().PublicKey().String()); err == nil || err.Error() != "stored signed transaction artifact signature mismatch" {
		t.Fatalf("stored signature mismatch rejection changed: %v", err)
	}
	if _, _, err := DecodeStoredSignedOperation("not-base64", "", ""); err == nil || err.Error() != "stored signed transaction artifact is invalid" {
		t.Fatalf("stored invalid artifact rejection changed: %v", err)
	}
	overSized := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", 1645)))
	if _, _, err := DecodeStoredSignedOperation(overSized, "", ""); err == nil || err.Error() != "stored signed transaction artifact is invalid" {
		t.Fatalf("stored oversized artifact rejection changed: %v", err)
	}
}

func TestValidatedJupiterSignerSlotIsolation(t *testing.T) {
	privateKey := solana.NewWallet().PrivateKey
	extraSigner := solana.NewWallet().PrivateKey
	tx, err := twoSignerTransaction(privateKey.PublicKey(), extraSigner.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	raw, signature, err := SignValidatedJupiterTransaction(tx, 0, privateKey)
	if err != nil || len(raw) == 0 || signature.IsZero() || len(tx.Signatures) != 2 || !tx.Signatures[1].IsZero() {
		t.Fatalf("validated signer slot failed: raw=%d signature=%s err=%v", len(raw), signature, err)
	}
	preSigned, err := twoSignerTransaction(privateKey.PublicKey(), extraSigner.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := preSigned.PartialSign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(extraSigner.PublicKey()) {
			copy := extraSigner
			return &copy
		}
		return nil
	}); err != nil {
		t.Fatalf("pre-sign second required signer slot: %v", err)
	}
	if len(preSigned.Signatures) != 2 || preSigned.Signatures[1].IsZero() {
		t.Fatalf("second required signer slot was not populated: %#v", preSigned.Signatures)
	}
	if _, _, err := SignValidatedJupiterTransaction(preSigned, 0, privateKey); err == nil || err.Error() != "signer modified an additional Trigger signer slot" {
		t.Fatalf("preexisting second signer slot was not rejected: %v", err)
	}
	if _, _, err := SignValidatedJupiterTransaction(nil, 0, privateKey); err == nil || err.Error() != "validated transaction is missing" {
		t.Fatalf("missing transaction error changed: %v", err)
	}
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func rpcServer(t *testing.T, respond func(string) (any, *rpcError)) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var request struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode RPC request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		result, rpcErr := respond(request.Method)
		response := map[string]any{"jsonrpc": "2.0", "id": request.ID}
		if rpcErr != nil {
			response["error"] = rpcErr
		} else {
			response["result"] = result
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	t.Cleanup(server.Close)
	return server
}

func testInstruction(payer solana.PublicKey) solana.Instruction {
	return solana.NewInstruction(solana.SystemProgramID, solana.AccountMetaSlice{&solana.AccountMeta{PublicKey: payer, IsSigner: true, IsWritable: true}}, []byte{1})
}

func twoSignerTransaction(payer, additionalSigner solana.PublicKey) (*solana.Transaction, error) {
	return solana.NewTransaction([]solana.Instruction{solana.NewInstruction(solana.SystemProgramID, solana.AccountMetaSlice{
		&solana.AccountMeta{PublicKey: payer, IsSigner: true, IsWritable: true},
		&solana.AccountMeta{PublicKey: additionalSigner, IsSigner: true},
	}, []byte{1})}, solana.Hash{}, solana.TransactionPayer(payer))
}

func signedTransaction(t *testing.T, privateKey solana.PrivateKey) *solana.Transaction {
	t.Helper()
	tx, err := NewSignedTypedTransaction([]solana.Instruction{testInstruction(privateKey.PublicKey())}, solana.Hash{}, privateKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	return tx
}
