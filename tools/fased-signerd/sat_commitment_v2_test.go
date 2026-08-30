package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

func TestSignerSATCommitmentVNextUsesDomainProgramAndSixteenChannels(t *testing.T) {
	program := solana.NewWallet().PublicKey()
	authority := solana.NewWallet().PublicKey()
	nonce := bytes.Repeat([]byte{0x5a}, 32)
	allocation := make([]uint32, 16)
	for index := range allocation {
		allocation[index] = 62_500
	}
	got := buildSATCommitmentV1(program, authority, 77, 1_000_000_000, nonce, allocation)
	hash := sha256.New()
	hash.Write([]byte("sat-cycle-commit-v2"))
	hash.Write(program.Bytes())
	hash.Write(authority.Bytes())
	var u64 [8]byte
	binary.LittleEndian.PutUint64(u64[:], 77)
	hash.Write(u64[:])
	binary.LittleEndian.PutUint64(u64[:], 1_000_000_000)
	hash.Write(u64[:])
	hash.Write(nonce)
	var u32 [4]byte
	for _, value := range allocation {
		binary.LittleEndian.PutUint32(u32[:], value)
		hash.Write(u32[:])
	}
	want := fmt.Sprintf("%x", hash.Sum(nil))
	if got != want {
		t.Fatalf("generation-2 commitment mismatch: got %s want %s", got, want)
	}
	otherProgram := solana.NewWallet().PublicKey()
	if buildSATCommitmentV1(otherProgram, authority, 77, 1_000_000_000, nonce, allocation) == got {
		t.Fatal("generation-2 commitment did not bind the mining program ID")
	}
	legacyAllocation := make([]uint32, 25)
	for index := range legacyAllocation {
		legacyAllocation[index] = 40_000
	}
	if buildSATCommitmentV1(program, authority, 77, 1_000_000_000, nonce, legacyAllocation) == got {
		t.Fatal("legacy and generation-2 commitment domains collided")
	}
}

func testSATCommitmentRequestV1(program string) signerSATCommitmentAllocateRequestV1 {
	allocation := make([]uint32, 25)
	for index := range allocation {
		allocation[index] = 40_000
	}
	return signerSATCommitmentAllocateRequestV1{
		Cluster: "devnet", ProgramID: program, ProtocolGeneration: "sat-v2",
		CycleID: "12345", CommittedLamports: "250000000", AllocationFP: allocation,
	}
}

func createSATCommitmentMiningWalletV1(t *testing.T, keys *signerKeyManagerV2, walletID string) signerWalletRecordV2 {
	t.Helper()
	wallet, _, err := keys.CreateWithRoleBaseline(
		walletID,
		0,
		signerRoleBaselineRequestV1{Version: 1, Role: "mining"},
		signerRoleBaselineRuntimeV1{},
	)
	if err != nil {
		t.Fatalf("create signer-owned Mining wallet: %v", err)
	}
	return wallet
}

func TestSignerSATCommitmentMaterialIsEncryptedAndSurvivesRestart(t *testing.T) {
	directory := t.TempDir()
	statePath := filepath.Join(directory, "state.db")
	masterKeyPath := filepath.Join(directory, "master.key")
	store, err := openSignerStoreV2(statePath)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := openSignerKeyManagerV2(store, masterKeyPath)
	if err != nil {
		t.Fatal(err)
	}
	wallet := createSATCommitmentMiningWalletV1(t, keys, "mining")
	request := testSATCommitmentRequestV1(solana.NewWallet().PublicKey().String())
	allocated, err := keys.allocateSATCommitmentV1(wallet.WalletID, request)
	if err != nil {
		t.Fatalf("allocate SAT commitment: %v", err)
	}
	if allocated.Reference == "" || len(allocated.CommitmentHex) != 64 || allocated.AllocationCount != 25 {
		t.Fatalf("unexpected public commitment allocation: %#v", allocated)
	}
	binding, err := keys.getSATCommitmentBindingV1(wallet.WalletID, signerSATCommitmentBindingRequestV1{
		Cluster: request.Cluster, ProgramID: request.ProgramID,
		ProtocolGeneration: request.ProtocolGeneration, CycleID: request.CycleID,
	})
	if err != nil || binding != allocated {
		t.Fatalf("cycle binding did not recover the public commitment pointer: %#v err=%v", binding, err)
	}
	idempotent, err := keys.allocateSATCommitmentV1(wallet.WalletID, request)
	if err != nil || idempotent != allocated {
		t.Fatalf("immutable retry did not return the same commitment: %#v err=%v", idempotent, err)
	}
	revealed, err := keys.revealSATCommitmentMaterialV1(wallet.WalletID, signerSATCommitmentRevealRequestV1{Reference: allocated.Reference})
	if err != nil {
		t.Fatalf("read SAT reveal material: %v", err)
	}
	nonce, err := base64.StdEncoding.DecodeString(revealed.NonceBase64)
	if err != nil || len(nonce) != 32 || len(revealed.AllocationFP) != 25 {
		t.Fatalf("invalid reveal material returned: nonceBytes=%d allocation=%d err=%v", len(nonce), len(revealed.AllocationFP), err)
	}
	authority, _ := solana.PublicKeyFromBase58(wallet.PublicKey)
	program, _ := solana.PublicKeyFromBase58(request.ProgramID)
	if calculated := buildSATCommitmentV1(program, authority, 12345, 250_000_000, nonce, revealed.AllocationFP); calculated != allocated.CommitmentHex {
		t.Fatalf("revealed material does not reproduce commitment: got %s want %s", calculated, allocated.CommitmentHex)
	}
	if err := store.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerSATCommitmentsV2).Get([]byte(allocated.Reference))
		if bytes.Contains(raw, []byte(revealed.NonceBase64)) || bytes.Contains(raw, []byte(`"allocationFp"`)) {
			t.Fatal("signer database stored SAT reveal material in plaintext")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	keys.Close()
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := openSignerStoreV2(statePath)
	if err != nil {
		t.Fatalf("reopen signer store: %v", err)
	}
	defer reopened.Close()
	reopenedKeys, err := openSignerKeyManagerV2(reopened, masterKeyPath)
	if err != nil {
		t.Fatalf("reopen signer keys: %v", err)
	}
	defer reopenedKeys.Close()
	recovered, err := reopenedKeys.revealSATCommitmentMaterialV1(wallet.WalletID, signerSATCommitmentRevealRequestV1{Reference: allocated.Reference})
	if err != nil || recovered.NonceBase64 != revealed.NonceBase64 || !bytes.Equal(uint32SliceBytesV1(recovered.AllocationFP), uint32SliceBytesV1(revealed.AllocationFP)) {
		t.Fatalf("restart did not recover exact encrypted reveal material: %#v err=%v", recovered, err)
	}
	recoveredBinding, err := reopenedKeys.getSATCommitmentBindingV1(wallet.WalletID, signerSATCommitmentBindingRequestV1{
		Cluster: request.Cluster, ProgramID: request.ProgramID,
		ProtocolGeneration: request.ProtocolGeneration, CycleID: request.CycleID,
	})
	if err != nil || recoveredBinding != allocated {
		t.Fatalf("restart did not recover the signer-owned cycle binding: %#v err=%v", recoveredBinding, err)
	}
}

func uint32SliceBytesV1(values []uint32) []byte {
	encoded, _ := json.Marshal(values)
	return encoded
}

func TestSignerSATCommitmentRejectsRebindingAndCiphertextTampering(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet := createSATCommitmentMiningWalletV1(t, keys, "mining-commitment")
	request := testSATCommitmentRequestV1(solana.NewWallet().PublicKey().String())
	allocated, err := keys.allocateSATCommitmentV1(wallet.WalletID, request)
	if err != nil {
		t.Fatal(err)
	}
	rebound := request
	rebound.AllocationFP = append([]uint32(nil), request.AllocationFP...)
	rebound.AllocationFP[0]++
	rebound.AllocationFP[1]--
	if _, err := keys.allocateSATCommitmentV1(wallet.WalletID, rebound); err == nil || !strings.Contains(err.Error(), "different immutable material") {
		t.Fatalf("allocation rebinding was accepted: %v", err)
	}
	other := createSATCommitmentMiningWalletV1(t, keys, "other-mining")
	if _, err := keys.revealSATCommitmentMaterialV1(other.WalletID, signerSATCommitmentRevealRequestV1{Reference: allocated.Reference}); err == nil || !strings.Contains(err.Error(), "wallet mismatch") {
		t.Fatalf("cross-wallet reveal was accepted: %v", err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerSATCommitmentsV2)
		raw := bucket.Get([]byte(allocated.Reference))
		var record signerSATCommitmentRecordV1
		if err := json.Unmarshal(raw, &record); err != nil {
			return err
		}
		ciphertext, err := base64.RawURLEncoding.DecodeString(record.EncryptedMaterial)
		if err != nil {
			return err
		}
		ciphertext[0] ^= 0x01
		record.EncryptedMaterial = base64.RawURLEncoding.EncodeToString(ciphertext)
		encoded, err := json.Marshal(record)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(allocated.Reference), encoded)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.revealSATCommitmentMaterialV1(wallet.WalletID, signerSATCommitmentRevealRequestV1{Reference: allocated.Reference}); err == nil || !strings.Contains(err.Error(), "authentication failed") {
		t.Fatalf("tampered commitment material was accepted: %v", err)
	}
}

func TestSignerSATCommitmentApplicationOperationsAreTypedAndWalletScoped(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet := createSATCommitmentMiningWalletV1(t, keys, "mining-rpc")
	service := &signerServiceV2{store: store, keys: keys}
	allocationRequest := testSATCommitmentRequestV1(solana.NewWallet().PublicKey().String())
	body, _ := json.Marshal(allocationRequest)
	allocateEnvelope := requestWithBodyV2(request{Op: "v2.satCommitment.allocate", WalletID: wallet.WalletID}, body)
	if err := mustValidate(allocateEnvelope, signerConfig{}); err != nil {
		t.Fatalf("valid SAT allocation envelope was rejected: %v", err)
	}
	if _, err := service.handle(allocateEnvelope, signerConfig{}, false); err != nil {
		t.Fatalf("application SAT allocation did not reach typed signer handler: %v", err)
	}
	allocated, err := keys.allocateSATCommitmentV1(wallet.WalletID, allocationRequest)
	if err != nil {
		t.Fatal(err)
	}
	bindingBody, _ := json.Marshal(signerSATCommitmentBindingRequestV1{
		Cluster: allocationRequest.Cluster, ProgramID: allocationRequest.ProgramID,
		ProtocolGeneration: allocationRequest.ProtocolGeneration, CycleID: allocationRequest.CycleID,
	})
	bindingEnvelope := requestWithBodyV2(request{Op: "v2.satCommitment.binding.get", WalletID: wallet.WalletID}, bindingBody)
	if err := mustValidate(bindingEnvelope, signerConfig{}); err != nil {
		t.Fatalf("valid SAT binding envelope was rejected: %v", err)
	}
	if _, err := service.handle(bindingEnvelope, signerConfig{}, false); err != nil {
		t.Fatalf("application SAT binding lookup failed: %v", err)
	}
	revealBody, _ := json.Marshal(signerSATCommitmentRevealRequestV1{Reference: allocated.Reference})
	revealEnvelope := requestWithBodyV2(request{Op: "v2.satCommitment.revealMaterial", WalletID: wallet.WalletID}, revealBody)
	if err := mustValidate(revealEnvelope, signerConfig{}); err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("application socket exposed raw SAT reveal material: %v", err)
	}
	unknown := append(append([]byte(nil), body[:len(body)-1]...), []byte(`,"nonceBase64":"forbidden"}`)...)
	if _, err := service.handle(requestWithBodyV2(request{Op: "v2.satCommitment.allocate", WalletID: wallet.WalletID}, unknown), signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "invalid signer-v2") {
		t.Fatalf("SAT allocation accepted caller-supplied nonce material: %v", err)
	}
}

func TestSignerSATCommitmentHydratesRevealOnlyInsideNativeSigner(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet := createSATCommitmentMiningWalletV1(t, keys, "mining-hydrate")
	genesis := solana.NewWallet().PublicKey().String()
	rpc := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		var body struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Method != "getGenesisHash" {
			t.Fatalf("unexpected signer hydration RPC method %q", body.Method)
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{"jsonrpc": "2.0", "id": body.ID, "result": genesis})
	}))
	defer rpc.Close()
	if _, err := keys.PutNetworkV2(wallet.WalletID, signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: rpc.URL,
	}); err != nil {
		t.Fatalf("configure signer-owned local RPC: %v", err)
	}
	program := solana.NewWallet().PublicKey().String()
	request := testSATCommitmentRequestV1(program)
	request.Cluster = "local"
	allocated, err := keys.allocateSATCommitmentV1(wallet.WalletID, request)
	if err != nil {
		t.Fatal(err)
	}
	placeholder := make([]byte, 145)
	placeholder[0] = 92
	binary.LittleEndian.PutUint64(placeholder[1:9], 12345)
	intent := signerIntentV2{
		Type: intentSolanaSATAction, Action: "revealCycle", ProgramID: program,
		DataBase64: base64.StdEncoding.EncodeToString(placeholder),
		SATCommitment: &signerSATCommitmentIntentV1{
			Reference: allocated.Reference, Cluster: "local", ProtocolGeneration: "sat-v2",
		},
	}
	hydrated, err := (&signerServiceV2{store: store, keys: keys}).hydrateSATCommitmentIntentV1(intent, wallet.WalletID)
	if err != nil {
		t.Fatalf("hydrate signer-owned SAT reveal: %v", err)
	}
	data, err := base64.StdEncoding.DecodeString(hydrated.DataBase64)
	if err != nil || len(data) != 145 || bytes.Equal(data, placeholder) {
		t.Fatalf("signer did not replace the sealed reveal placeholder: len=%d err=%v", len(data), err)
	}
	revealed, err := keys.revealSATCommitmentMaterialV1(wallet.WalletID, signerSATCommitmentRevealRequestV1{Reference: allocated.Reference})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data[9:41], mustDecodeBase64ForSATCommitmentTestV1(t, revealed.NonceBase64)) || !bytes.Equal(data[41:141], uint32SliceWireBytesV1(revealed.AllocationFP)) {
		t.Fatal("signer-built reveal instruction does not contain the exact encrypted commitment material")
	}
	placeholder[9] = 1
	intent.DataBase64 = base64.StdEncoding.EncodeToString(placeholder)
	if _, err := (&signerServiceV2{store: store, keys: keys}).hydrateSATCommitmentIntentV1(intent, wallet.WalletID); err == nil || !strings.Contains(err.Error(), "must not contain caller reveal material") {
		t.Fatalf("caller reveal material bypass was accepted: %v", err)
	}
}

func mustDecodeBase64ForSATCommitmentTestV1(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

func uint32SliceWireBytesV1(values []uint32) []byte {
	encoded := make([]byte, len(values)*4)
	for index, value := range values {
		binary.LittleEndian.PutUint32(encoded[index*4:index*4+4], value)
	}
	return encoded
}
