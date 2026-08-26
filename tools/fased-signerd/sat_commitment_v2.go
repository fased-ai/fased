package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

const (
	signerSATCommitmentRecordVersionV1 = uint64(1)
	signerSATAllocationScaleV1         = uint64(1_000_000)
)

type signerSATCommitmentAllocateRequestV1 struct {
	Cluster            string   `json:"cluster"`
	ProgramID          string   `json:"programId"`
	ProtocolGeneration string   `json:"protocolGeneration"`
	CycleID            string   `json:"cycleId"`
	CommittedLamports  string   `json:"committedLamports"`
	AllocationFP       []uint32 `json:"allocationFp"`
}

type signerSATCommitmentRevealRequestV1 struct {
	Reference string `json:"reference"`
}

type signerSATCommitmentIntentV1 struct {
	Reference          string `json:"reference"`
	Cluster            string `json:"cluster"`
	ProtocolGeneration string `json:"protocolGeneration"`
}

type signerSATCommitmentBindingRequestV1 struct {
	Cluster            string `json:"cluster"`
	ProgramID          string `json:"programId"`
	ProtocolGeneration string `json:"protocolGeneration"`
	CycleID            string `json:"cycleId"`
}

type signerSATCommitmentRecordV1 struct {
	Version            uint64 `json:"version"`
	Reference          string `json:"reference"`
	WalletID           string `json:"walletId"`
	Authority          string `json:"authority"`
	Cluster            string `json:"cluster"`
	ProgramID          string `json:"programId"`
	ProtocolGeneration string `json:"protocolGeneration"`
	CycleID            string `json:"cycleId"`
	CommittedLamports  string `json:"committedLamports"`
	AllocationCount    int    `json:"allocationCount"`
	CommitmentHex      string `json:"commitmentHex"`
	CreatedAt          string `json:"createdAt"`
	EncryptionNonce    string `json:"encryptionNonce"`
	EncryptedMaterial  string `json:"encryptedMaterial"`
}

type signerSATCommitmentMaterialV1 struct {
	NonceBase64  string   `json:"nonceBase64"`
	AllocationFP []uint32 `json:"allocationFp"`
}

type signerSATCommitmentAllocationResultV1 struct {
	Reference          string `json:"reference"`
	CommitmentHex      string `json:"commitmentHex"`
	CycleID            string `json:"cycleId"`
	CommittedLamports  string `json:"committedLamports"`
	AllocationCount    int    `json:"allocationCount"`
	ProtocolGeneration string `json:"protocolGeneration"`
}

type signerSATCommitmentRevealResultV1 struct {
	signerSATCommitmentAllocationResultV1
	NonceBase64  string   `json:"nonceBase64"`
	AllocationFP []uint32 `json:"allocationFp"`
}

func normalizeSATCommitmentAllocateRequestV1(request signerSATCommitmentAllocateRequestV1) (signerSATCommitmentAllocateRequestV1, uint64, uint64, error) {
	request.Cluster = strings.TrimSpace(request.Cluster)
	if request.Cluster != "local" && request.Cluster != "devnet" && request.Cluster != "mainnet-beta" {
		return request, 0, 0, errors.New("SAT commitment cluster is invalid")
	}
	request.ProgramID = strings.TrimSpace(request.ProgramID)
	if _, err := solana.PublicKeyFromBase58(request.ProgramID); err != nil {
		return request, 0, 0, errors.New("SAT commitment program ID is invalid")
	}
	request.ProtocolGeneration = strings.TrimSpace(request.ProtocolGeneration)
	if request.ProtocolGeneration == "" || len(request.ProtocolGeneration) > 128 || strings.ContainsAny(request.ProtocolGeneration, "\r\n\x00") {
		return request, 0, 0, errors.New("SAT commitment protocol generation is invalid")
	}
	cycleID, err := strconv.ParseUint(strings.TrimSpace(request.CycleID), 10, 64)
	if err != nil || cycleID == 0 {
		return request, 0, 0, errors.New("SAT commitment cycle ID is invalid")
	}
	committedLamports, err := strconv.ParseUint(strings.TrimSpace(request.CommittedLamports), 10, 64)
	if err != nil || committedLamports == 0 {
		return request, 0, 0, errors.New("SAT commitment lamports are invalid")
	}
	if len(request.AllocationFP) != 16 && len(request.AllocationFP) != 25 {
		return request, 0, 0, errors.New("SAT commitment allocation count is invalid")
	}
	var total uint64
	for _, value := range request.AllocationFP {
		total += uint64(value)
	}
	if total != signerSATAllocationScaleV1 {
		return request, 0, 0, errors.New("SAT commitment allocation must sum to 1000000")
	}
	request.CycleID = strconv.FormatUint(cycleID, 10)
	request.CommittedLamports = strconv.FormatUint(committedLamports, 10)
	return request, cycleID, committedLamports, nil
}

func normalizeSATCommitmentBindingRequestV1(request signerSATCommitmentBindingRequestV1) (signerSATCommitmentBindingRequestV1, error) {
	normalized, _, _, err := normalizeSATCommitmentAllocateRequestV1(signerSATCommitmentAllocateRequestV1{
		Cluster: request.Cluster, ProgramID: request.ProgramID, ProtocolGeneration: request.ProtocolGeneration,
		CycleID: request.CycleID, CommittedLamports: "1", AllocationFP: append([]uint32{1_000_000}, make([]uint32, 15)...),
	})
	if err != nil {
		return request, err
	}
	return signerSATCommitmentBindingRequestV1{
		Cluster: normalized.Cluster, ProgramID: normalized.ProgramID,
		ProtocolGeneration: normalized.ProtocolGeneration, CycleID: normalized.CycleID,
	}, nil
}

func satCommitmentReferenceV1(walletID string, request signerSATCommitmentAllocateRequestV1) string {
	digest := sha256.Sum256([]byte(strings.Join([]string{
		"fased-signerd:sat-commitment:v1", walletID, request.Cluster, request.ProgramID,
		request.ProtocolGeneration, request.CycleID,
	}, "\x00")))
	return "sha256:" + hex.EncodeToString(digest[:])
}

func satCommitmentBindingReferenceV1(walletID string, request signerSATCommitmentBindingRequestV1) string {
	return satCommitmentReferenceV1(walletID, signerSATCommitmentAllocateRequestV1{
		Cluster: request.Cluster, ProgramID: request.ProgramID,
		ProtocolGeneration: request.ProtocolGeneration, CycleID: request.CycleID,
	})
}

func buildSATCommitmentV1(authority solana.PublicKey, cycleID, committedLamports uint64, nonce []byte, allocation []uint32) string {
	hash := sha256.New()
	hash.Write(authority.Bytes())
	var encoded [8]byte
	binary.LittleEndian.PutUint64(encoded[:], cycleID)
	hash.Write(encoded[:])
	binary.LittleEndian.PutUint64(encoded[:], committedLamports)
	hash.Write(encoded[:])
	hash.Write(nonce)
	var allocationBytes [4]byte
	for _, value := range allocation {
		binary.LittleEndian.PutUint32(allocationBytes[:], value)
		hash.Write(allocationBytes[:])
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func deriveSATCommitmentEncryptionKeyV1(masterKey []byte) ([]byte, error) {
	if len(masterKey) != 32 {
		return nil, errors.New("signer master key is unavailable")
	}
	mac := hmac.New(sha256.New, masterKey)
	mac.Write([]byte("fased-signerd:sat-commitment:encryption:v1"))
	return mac.Sum(nil), nil
}

func satCommitmentAADV1(record signerSATCommitmentRecordV1) []byte {
	return []byte(strings.Join([]string{
		"fased-signerd:sat-commitment-record:v1", record.Reference, record.WalletID,
		record.Authority, record.Cluster, record.ProgramID, record.ProtocolGeneration,
		record.CycleID, record.CommittedLamports, strconv.Itoa(record.AllocationCount),
		record.CommitmentHex, strconv.FormatUint(record.Version, 10), record.CreatedAt,
	}, "\x00"))
}

func (m *signerKeyManagerV2) encryptSATCommitmentMaterialV1(record *signerSATCommitmentRecordV1, material signerSATCommitmentMaterialV1) error {
	plaintext, err := json.Marshal(material)
	if err != nil {
		return errors.New("encode SAT commitment reveal material")
	}
	defer zeroBytes(plaintext)
	key, err := deriveSATCommitmentEncryptionKeyV1(m.masterKey)
	if err != nil {
		return err
	}
	defer zeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return errors.New("initialize SAT commitment encryption")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return errors.New("initialize SAT commitment authenticated encryption")
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return errors.New("generate SAT commitment encryption nonce")
	}
	defer zeroBytes(nonce)
	ciphertext := aead.Seal(nil, nonce, plaintext, satCommitmentAADV1(*record))
	defer zeroBytes(ciphertext)
	record.EncryptionNonce = base64.RawURLEncoding.EncodeToString(nonce)
	record.EncryptedMaterial = base64.RawURLEncoding.EncodeToString(ciphertext)
	return nil
}

func (m *signerKeyManagerV2) decryptSATCommitmentMaterialV1(record signerSATCommitmentRecordV1) (signerSATCommitmentMaterialV1, error) {
	var material signerSATCommitmentMaterialV1
	if record.Version != signerSATCommitmentRecordVersionV1 {
		return material, errors.New("SAT commitment record version is unsupported")
	}
	nonce, err := base64.RawURLEncoding.DecodeString(record.EncryptionNonce)
	if err != nil {
		return material, errors.New("SAT commitment encryption nonce is invalid")
	}
	defer zeroBytes(nonce)
	ciphertext, err := base64.RawURLEncoding.DecodeString(record.EncryptedMaterial)
	if err != nil {
		return material, errors.New("SAT commitment encrypted material is invalid")
	}
	defer zeroBytes(ciphertext)
	key, err := deriveSATCommitmentEncryptionKeyV1(m.masterKey)
	if err != nil {
		return material, err
	}
	defer zeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return material, errors.New("initialize SAT commitment decryption")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return material, errors.New("initialize SAT commitment authenticated decryption")
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, satCommitmentAADV1(record))
	if err != nil {
		return material, errors.New("SAT commitment encrypted material authentication failed")
	}
	defer zeroBytes(plaintext)
	if err := decodeStrictJSONV2(plaintext, &material); err != nil {
		return material, errors.New("SAT commitment reveal material is invalid")
	}
	return material, nil
}

func (m *signerKeyManagerV2) getSATCommitmentBindingV1(walletID string, request signerSATCommitmentBindingRequestV1) (signerSATCommitmentAllocationResultV1, error) {
	walletID = normalizeWalletID(walletID)
	wallet, err := m.getRecord(walletID)
	if err != nil {
		return signerSATCommitmentAllocationResultV1{}, err
	}
	request, err = normalizeSATCommitmentBindingRequestV1(request)
	if err != nil {
		return signerSATCommitmentAllocationResultV1{}, err
	}
	reference := satCommitmentBindingReferenceV1(walletID, request)
	var record signerSATCommitmentRecordV1
	err = m.store.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerSATCommitmentsV2).Get([]byte(reference))
		if raw == nil {
			return errors.New("SAT commitment binding was not found")
		}
		if err := decodeStrictJSONV2(raw, &record); err != nil {
			return errors.New("stored SAT commitment record is invalid")
		}
		if record.Reference != reference || record.WalletID != walletID || record.Authority != wallet.PublicKey || record.Cluster != request.Cluster ||
			record.ProgramID != request.ProgramID || record.ProtocolGeneration != request.ProtocolGeneration ||
			record.CycleID != request.CycleID {
			return errors.New("SAT commitment binding mismatch")
		}
		return nil
	})
	if err != nil {
		return signerSATCommitmentAllocationResultV1{}, err
	}
	material, err := m.decryptSATCommitmentMaterialV1(record)
	if err != nil {
		return signerSATCommitmentAllocationResultV1{}, err
	}
	defer zeroSATCommitmentMaterialV1(&material)
	if err := validateSATCommitmentMaterialV1(record, material); err != nil {
		return signerSATCommitmentAllocationResultV1{}, err
	}
	return publicSATCommitmentAllocationV1(record), nil
}

func publicSATCommitmentAllocationV1(record signerSATCommitmentRecordV1) signerSATCommitmentAllocationResultV1 {
	return signerSATCommitmentAllocationResultV1{
		Reference: record.Reference, CommitmentHex: record.CommitmentHex, CycleID: record.CycleID,
		CommittedLamports: record.CommittedLamports, AllocationCount: record.AllocationCount,
		ProtocolGeneration: record.ProtocolGeneration,
	}
}

func (m *signerKeyManagerV2) allocateSATCommitmentV1(walletID string, request signerSATCommitmentAllocateRequestV1) (signerSATCommitmentAllocationResultV1, error) {
	walletID = normalizeWalletID(walletID)
	request, cycleID, committedLamports, err := normalizeSATCommitmentAllocateRequestV1(request)
	if err != nil {
		return signerSATCommitmentAllocationResultV1{}, err
	}
	wallet, err := m.getRecord(walletID)
	if err != nil {
		return signerSATCommitmentAllocationResultV1{}, err
	}
	policy, err := m.store.getPolicy(walletID)
	if err != nil {
		return signerSATCommitmentAllocationResultV1{}, err
	}
	if policy.Role != "mining" {
		return signerSATCommitmentAllocationResultV1{}, errors.New("SAT commitments require a signer-owned Mining wallet")
	}
	authority, err := solana.PublicKeyFromBase58(wallet.PublicKey)
	if err != nil {
		return signerSATCommitmentAllocationResultV1{}, errors.New("signer Mining wallet authority is invalid")
	}
	reference := satCommitmentReferenceV1(walletID, request)
	var result signerSATCommitmentAllocationResultV1
	err = m.store.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerSATCommitmentsV2)
		if raw := bucket.Get([]byte(reference)); raw != nil {
			var existing signerSATCommitmentRecordV1
			if err := decodeStrictJSONV2(raw, &existing); err != nil {
				return errors.New("stored SAT commitment record is invalid")
			}
			material, err := m.decryptSATCommitmentMaterialV1(existing)
			if err != nil {
				return err
			}
			defer zeroSATCommitmentMaterialV1(&material)
			if err := validateSATCommitmentMaterialV1(existing, material); err != nil {
				return err
			}
			if existing.Reference != reference || existing.WalletID != walletID || existing.Authority != wallet.PublicKey || existing.Cluster != request.Cluster ||
				existing.ProgramID != request.ProgramID || existing.ProtocolGeneration != request.ProtocolGeneration ||
				existing.CycleID != request.CycleID || existing.CommittedLamports != request.CommittedLamports ||
				len(material.AllocationFP) != len(request.AllocationFP) {
				return errors.New("SAT commitment reference is already bound to different immutable material")
			}
			for index := range request.AllocationFP {
				if material.AllocationFP[index] != request.AllocationFP[index] {
					return errors.New("SAT commitment reference is already bound to different immutable material")
				}
			}
			result = publicSATCommitmentAllocationV1(existing)
			return nil
		}
		revealNonce := make([]byte, 32)
		if _, err := rand.Read(revealNonce); err != nil {
			return errors.New("generate SAT commitment reveal nonce")
		}
		defer zeroBytes(revealNonce)
		record := signerSATCommitmentRecordV1{
			Version: signerSATCommitmentRecordVersionV1, Reference: reference, WalletID: walletID,
			Authority: wallet.PublicKey, Cluster: request.Cluster, ProgramID: request.ProgramID,
			ProtocolGeneration: request.ProtocolGeneration, CycleID: request.CycleID,
			CommittedLamports: request.CommittedLamports, AllocationCount: len(request.AllocationFP),
			CommitmentHex: buildSATCommitmentV1(authority, cycleID, committedLamports, revealNonce, request.AllocationFP),
			CreatedAt:     timestampV2(m.store.now()),
		}
		if err := m.encryptSATCommitmentMaterialV1(&record, signerSATCommitmentMaterialV1{
			NonceBase64: base64.StdEncoding.EncodeToString(revealNonce), AllocationFP: append([]uint32(nil), request.AllocationFP...),
		}); err != nil {
			return err
		}
		encoded, err := json.Marshal(record)
		if err != nil {
			return fmt.Errorf("encode SAT commitment record: %w", err)
		}
		if err := bucket.Put([]byte(reference), encoded); err != nil {
			return err
		}
		result = publicSATCommitmentAllocationV1(record)
		return nil
	})
	return result, err
}

func (m *signerKeyManagerV2) revealSATCommitmentMaterialV1(walletID string, request signerSATCommitmentRevealRequestV1) (signerSATCommitmentRevealResultV1, error) {
	record, err := m.loadSATCommitmentRecordV1(walletID, request.Reference)
	if err != nil {
		return signerSATCommitmentRevealResultV1{}, err
	}
	material, err := m.decryptSATCommitmentMaterialV1(record)
	if err != nil {
		return signerSATCommitmentRevealResultV1{}, err
	}
	if err := validateSATCommitmentMaterialV1(record, material); err != nil {
		return signerSATCommitmentRevealResultV1{}, err
	}
	return signerSATCommitmentRevealResultV1{
		signerSATCommitmentAllocationResultV1: publicSATCommitmentAllocationV1(record),
		NonceBase64:                           material.NonceBase64, AllocationFP: material.AllocationFP,
	}, nil
}

func (m *signerKeyManagerV2) loadSATCommitmentRecordV1(walletID, rawReference string) (signerSATCommitmentRecordV1, error) {
	walletID = normalizeWalletID(walletID)
	reference := strings.TrimSpace(rawReference)
	if len(reference) != 71 || !strings.HasPrefix(reference, "sha256:") {
		return signerSATCommitmentRecordV1{}, errors.New("SAT commitment reference is invalid")
	}
	if _, err := hex.DecodeString(strings.TrimPrefix(reference, "sha256:")); err != nil {
		return signerSATCommitmentRecordV1{}, errors.New("SAT commitment reference is invalid")
	}
	var record signerSATCommitmentRecordV1
	err := m.store.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerSATCommitmentsV2).Get([]byte(reference))
		if raw == nil {
			return errors.New("SAT commitment reveal material was not found")
		}
		if err := decodeStrictJSONV2(raw, &record); err != nil {
			return errors.New("stored SAT commitment record is invalid")
		}
		if record.Reference != reference {
			return errors.New("SAT commitment reference mismatch")
		}
		if record.WalletID != walletID {
			return errors.New("SAT commitment wallet mismatch")
		}
		return nil
	})
	if err != nil {
		return signerSATCommitmentRecordV1{}, err
	}
	wallet, err := m.getRecord(walletID)
	if err != nil {
		return signerSATCommitmentRecordV1{}, err
	}
	if record.Authority != wallet.PublicKey {
		return signerSATCommitmentRecordV1{}, errors.New("SAT commitment authority mismatch")
	}
	return record, nil
}

func zeroSATCommitmentMaterialV1(material *signerSATCommitmentMaterialV1) {
	if material == nil {
		return
	}
	for index := range material.AllocationFP {
		material.AllocationFP[index] = 0
	}
	material.NonceBase64 = ""
}

func validateSATCommitmentMaterialV1(record signerSATCommitmentRecordV1, material signerSATCommitmentMaterialV1) error {
	if len(material.AllocationFP) != record.AllocationCount {
		return errors.New("SAT commitment allocation count mismatch")
	}
	nonce, err := base64.StdEncoding.DecodeString(material.NonceBase64)
	if err != nil || len(nonce) != 32 {
		return errors.New("SAT commitment reveal nonce is invalid")
	}
	defer zeroBytes(nonce)
	cycleID, err := strconv.ParseUint(record.CycleID, 10, 64)
	if err != nil {
		return errors.New("stored SAT commitment cycle ID is invalid")
	}
	committedLamports, err := strconv.ParseUint(record.CommittedLamports, 10, 64)
	if err != nil {
		return errors.New("stored SAT commitment lamports are invalid")
	}
	var allocationTotal uint64
	for _, value := range material.AllocationFP {
		allocationTotal += uint64(value)
	}
	authority, err := solana.PublicKeyFromBase58(record.Authority)
	if err != nil || allocationTotal != signerSATAllocationScaleV1 ||
		buildSATCommitmentV1(authority, cycleID, committedLamports, nonce, material.AllocationFP) != record.CommitmentHex {
		return errors.New("SAT commitment reveal material does not match its durable commitment")
	}
	return nil
}

func (s *signerServiceV2) hydrateSATCommitmentIntentV1(input signerIntentV2, walletID string) (signerIntentV2, error) {
	if input.SATCommitment == nil {
		return input, nil
	}
	commitment := *input.SATCommitment
	if input.Type != intentSolanaSATAction || input.Action != "revealCycle" || len(input.Instructions) != 0 {
		return signerIntentV2{}, errors.New("signer-owned SAT commitment references are valid only for one revealCycle")
	}
	if commitment.Reference != strings.TrimSpace(commitment.Reference) || commitment.Cluster != strings.TrimSpace(commitment.Cluster) || commitment.ProtocolGeneration != strings.TrimSpace(commitment.ProtocolGeneration) {
		return signerIntentV2{}, errors.New("signer-owned SAT commitment identity is not canonical")
	}
	if _, err := normalizeSolanaClusterV2(commitment.Cluster); err != nil {
		return signerIntentV2{}, errors.New("signer-owned SAT commitment cluster is invalid")
	}
	if commitment.ProtocolGeneration == "" {
		return signerIntentV2{}, errors.New("signer-owned SAT commitment protocol generation is required")
	}
	placeholder, err := base64.StdEncoding.DecodeString(input.DataBase64)
	if err != nil || len(placeholder) != 145 || placeholder[0] != 92 {
		return signerIntentV2{}, errors.New("signer-owned SAT reveal requires the canonical sealed placeholder")
	}
	for _, value := range placeholder[9:] {
		if value != 0 {
			return signerIntentV2{}, errors.New("signer-owned SAT reveal placeholder must not contain caller reveal material")
		}
	}
	cycleID := binary.LittleEndian.Uint64(placeholder[1:9])
	if cycleID == 0 {
		return signerIntentV2{}, errors.New("signer-owned SAT reveal cycle ID is invalid")
	}
	record, err := s.keys.loadSATCommitmentRecordV1(walletID, commitment.Reference)
	if err != nil {
		return signerIntentV2{}, err
	}
	if record.Cluster != commitment.Cluster || record.ProtocolGeneration != commitment.ProtocolGeneration || record.ProgramID != strings.TrimSpace(input.ProgramID) || record.CycleID != strconv.FormatUint(cycleID, 10) {
		return signerIntentV2{}, errors.New("signer-owned SAT reveal does not match its immutable commitment binding")
	}
	if record.AllocationCount != 25 || commitment.ProtocolGeneration != "sat-v2" {
		return signerIntentV2{}, errors.New("signer-owned SAT reveal protocol generation is not active")
	}
	wallet, err := s.keys.PublicRecord(walletID)
	if err != nil {
		return signerIntentV2{}, err
	}
	if record.Authority != wallet.PublicKey {
		return signerIntentV2{}, errors.New("signer-owned SAT reveal authority mismatch")
	}
	rpcURLs, err := s.keys.SolanaRPCURLsV2(walletID)
	if err != nil {
		return signerIntentV2{}, errSignerNetworkPendingV2
	}
	if _, err := solanaRPCURLsForClusterV2(rpcURLs, record.Cluster); err != nil {
		return signerIntentV2{}, err
	}
	material, err := s.keys.decryptSATCommitmentMaterialV1(record)
	if err != nil {
		return signerIntentV2{}, err
	}
	defer zeroSATCommitmentMaterialV1(&material)
	if err := validateSATCommitmentMaterialV1(record, material); err != nil {
		return signerIntentV2{}, err
	}
	nonce, err := base64.StdEncoding.DecodeString(material.NonceBase64)
	if err != nil || len(nonce) != 32 {
		return signerIntentV2{}, errors.New("SAT commitment reveal nonce is invalid")
	}
	defer zeroBytes(nonce)
	data := make([]byte, 145)
	data[0] = 92
	binary.LittleEndian.PutUint64(data[1:9], cycleID)
	copy(data[9:41], nonce)
	for index, value := range material.AllocationFP {
		binary.LittleEndian.PutUint32(data[41+index*4:45+index*4], value)
	}
	input.DataBase64 = base64.StdEncoding.EncodeToString(data)
	zeroBytes(data)
	return input, nil
}
