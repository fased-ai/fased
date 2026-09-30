package main

// Internal storage primitive only. The RPC/intent adapter must obtain this scope
// from finalized account readback before calling it. No public operation exposes
// allocation or reveal yet; generic Capital commit/reveal remains disabled.
import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

type vaultCommitmentScopeV1 struct {
	Profile             solana.PublicKey `json:"profile"`
	PermanentMining     solana.PublicKey `json:"permanentMining"`
	Binding             solana.PublicKey `json:"binding"`
	Authority           solana.PublicKey `json:"authority"`
	Executor            solana.PublicKey `json:"executor"`
	Keeper              solana.PublicKey `json:"keeper"`
	AuthorityGeneration uint64           `json:"authorityGeneration"`
	BindingGeneration   uint64           `json:"bindingGeneration"`
}

type vaultCommitmentRecordV1 struct {
	Scope      vaultCommitmentScopeV1      `json:"scope"`
	Commitment signerSATCommitmentRecordV1 `json:"commitment"`
}

// Native-only recovery by public commitment reference. Allocation and nonce
// remain in authenticated encrypted storage; neither is supplied by a review UI.
func (m *signerKeyManagerV2) restoreVaultRevealRequestV1(walletID string, scope vaultCommitmentScopeV1, binding signerSATCommitmentBindingRequestV1, reference string) (signerSATCommitmentAllocateRequestV1, error) {
	var empty signerSATCommitmentAllocateRequestV1
	binding, err := normalizeSATCommitmentBindingRequestV1(binding)
	if err != nil {
		return empty, err
	}
	walletID = normalizeWalletID(walletID)
	if err := m.validateVaultCommitmentWalletV1(walletID, scope, binding.ProgramID); err != nil {
		return empty, err
	}
	request := signerSATCommitmentAllocateRequestV1{Cluster: binding.Cluster, ProgramID: binding.ProgramID, ProtocolGeneration: binding.ProtocolGeneration, CycleID: binding.CycleID}
	err = m.store.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerSATCommitmentsV2).Get([]byte(vaultCommitmentSlotV1(scope, request)))
		if raw == nil {
			return errors.New("Vault commitment was not allocated")
		}
		var stored vaultCommitmentRecordV1
		if err := decodeStrictJSONV2(raw, &stored); err != nil {
			return errors.New("invalid stored Vault commitment")
		}
		if reference == "" || stored.Commitment.Reference != reference {
			return errors.New("Vault recovery reference mismatch")
		}
		request.CommittedLamports = stored.Commitment.CommittedLamports
		_, material, err := m.openVaultCommitmentV1(raw, walletID, scope, request)
		if err != nil {
			return err
		}
		defer zeroSATCommitmentMaterialV1(&material)
		request.AllocationFP = slices.Clone(material.AllocationFP)
		return nil
	})
	if err != nil {
		return empty, err
	}
	request, _, _, err = normalizeSATCommitmentAllocateRequestV1(request)
	if err != nil {
		clear(request.AllocationFP)
		return empty, err
	}
	return request, nil
}

func validateVaultCommitmentScopeV1(scope vaultCommitmentScopeV1, wallet string, program string) error {
	if scope.Profile.IsZero() || scope.PermanentMining.IsZero() || scope.Executor.IsZero() || scope.Keeper.IsZero() ||
		scope.Executor.String() != wallet || scope.Executor.Equals(scope.Keeper) || scope.Executor.Equals(scope.Authority) ||
		scope.AuthorityGeneration == 0 || scope.BindingGeneration == 0 || program != satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID {
		return errors.New("invalid Vault commitment scope")
	}
	capital := solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1)
	sat := solana.MustPublicKeyFromBase58(program)
	binding, _, err := solana.FindProgramAddress([][]byte{[]byte("capital-vault-binding"), scope.Profile[:]}, capital)
	if err != nil || !binding.Equals(scope.Binding) {
		return errors.New("Vault commitment binding PDA mismatch")
	}
	authority, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_agent_vault_authority"), sat[:], scope.PermanentMining[:]}, capital)
	if err != nil || !authority.Equals(scope.Authority) {
		return errors.New("Vault commitment authority PDA mismatch")
	}
	return nil
}

func vaultCommitmentSlotV1(scope vaultCommitmentScopeV1, request signerSATCommitmentAllocateRequestV1) string {
	// Deliberately excludes wallet and generations: rotating them cannot create
	// another nonce for an already allocated Vault/cycle in this signer store.
	bytes, _ := json.Marshal([]string{"fased:vault-commitment-slot:v1", request.Cluster, request.ProgramID, scope.Binding.String(), request.CycleID})
	digest := sha256.Sum256(bytes)
	return "vault:" + hex.EncodeToString(digest[:])
}

func vaultCommitmentReferenceV1(scope vaultCommitmentScopeV1, record signerSATCommitmentRecordV1) string {
	bytes, _ := json.Marshal(struct {
		Scope                                                 vaultCommitmentScopeV1
		Wallet, Cluster, Program, Generation, Cycle, Lamports string
	}{scope, record.WalletID, record.Cluster, record.ProgramID, record.ProtocolGeneration, record.CycleID, record.CommittedLamports})
	digest := sha256.Sum256(append([]byte("fased:vault-commitment-record:v1\x00"), bytes...))
	return "sha256:" + hex.EncodeToString(digest[:])
}

func (m *signerKeyManagerV2) validateVaultCommitmentWalletV1(walletID string, scope vaultCommitmentScopeV1, program string) error {
	wallet, err := m.getRecord(walletID)
	if err != nil {
		return err
	}
	policy, err := m.store.getPolicy(walletID)
	if err != nil {
		return err
	}
	if policy.Role != "agent" {
		return errors.New("Vault commitments require a separate Agent executor wallet")
	}
	return validateVaultCommitmentScopeV1(scope, wallet.PublicKey, program)
}

func (m *signerKeyManagerV2) openVaultCommitmentV1(raw []byte, walletID string, scope vaultCommitmentScopeV1, request signerSATCommitmentAllocateRequestV1) (signerSATCommitmentRecordV1, signerSATCommitmentMaterialV1, error) {
	var stored vaultCommitmentRecordV1
	var empty signerSATCommitmentMaterialV1
	if err := decodeStrictJSONV2(raw, &stored); err != nil {
		return stored.Commitment, empty, errors.New("invalid stored Vault commitment")
	}
	record := stored.Commitment
	if stored.Scope != scope || record.WalletID != walletID || record.Authority != scope.Authority.String() || record.Cluster != request.Cluster ||
		record.ProgramID != request.ProgramID || record.ProtocolGeneration != request.ProtocolGeneration || record.CycleID != request.CycleID ||
		record.CommittedLamports != request.CommittedLamports || record.AllocationCount != 16 || record.Reference != vaultCommitmentReferenceV1(scope, record) {
		return record, empty, errors.New("Vault cycle already bound to different immutable scope")
	}
	material, err := m.decryptSATCommitmentMaterialV1(record)
	if err != nil {
		return record, empty, err
	}
	if err = validateSATCommitmentMaterialV1(record, material); err != nil {
		zeroSATCommitmentMaterialV1(&material)
		return record, empty, err
	}
	return record, material, nil
}

func (m *signerKeyManagerV2) allocateVaultCommitmentV1(walletID string, scope vaultCommitmentScopeV1, request signerSATCommitmentAllocateRequestV1) (signerSATCommitmentAllocationResultV1, error) {
	var result signerSATCommitmentAllocationResultV1
	walletID = normalizeWalletID(walletID)
	request, cycle, lamports, err := normalizeSATCommitmentAllocateRequestV1(request)
	if err != nil {
		return result, err
	}
	if len(request.AllocationFP) != 16 || lamports < 1_000_000_000 {
		return result, errors.New("Vault mining requires sixteen channels and at least one SOL")
	}
	if err := m.validateVaultCommitmentWalletV1(walletID, scope, request.ProgramID); err != nil {
		return result, err
	}
	slot := vaultCommitmentSlotV1(scope, request)
	err = m.store.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerSATCommitmentsV2)
		if raw := bucket.Get([]byte(slot)); raw != nil {
			record, material, err := m.openVaultCommitmentV1(raw, walletID, scope, request)
			if err != nil {
				return err
			}
			defer zeroSATCommitmentMaterialV1(&material)
			if !slices.Equal(material.AllocationFP, request.AllocationFP) {
				return errors.New("Vault cycle allocation is immutable")
			}
			result = publicSATCommitmentAllocationV1(record)
			return nil
		}
		nonce := make([]byte, 32)
		if _, err := rand.Read(nonce); err != nil {
			return errors.New("generate Vault commitment nonce")
		}
		defer zeroBytes(nonce)
		record := signerSATCommitmentRecordV1{
			Version: signerSATCommitmentRecordVersionV1, WalletID: walletID, Authority: scope.Authority.String(),
			Cluster: request.Cluster, ProgramID: request.ProgramID, ProtocolGeneration: request.ProtocolGeneration,
			CycleID: request.CycleID, CommittedLamports: request.CommittedLamports, AllocationCount: 16,
			CreatedAt:     timestampV2(m.store.now()),
			CommitmentHex: buildSATCommitmentV1(solana.MustPublicKeyFromBase58(request.ProgramID), scope.Authority, cycle, lamports, nonce, request.AllocationFP),
		}
		record.Reference = vaultCommitmentReferenceV1(scope, record)
		material := signerSATCommitmentMaterialV1{NonceBase64: base64.StdEncoding.EncodeToString(nonce), AllocationFP: slices.Clone(request.AllocationFP)}
		defer zeroSATCommitmentMaterialV1(&material)
		if err := m.encryptSATCommitmentMaterialV1(&record, material); err != nil {
			return err
		}
		bytes, err := json.Marshal(vaultCommitmentRecordV1{Scope: scope, Commitment: record})
		if err != nil {
			return err
		}
		if err := bucket.Put([]byte(slot), bytes); err != nil {
			return err
		}
		result = publicSATCommitmentAllocationV1(record)
		return nil
	})
	return result, err
}

// Native-only hydration. No RPC operation returns this data or the plaintext
// nonce. The eventual reviewed transaction path must recheck finalized scope,
// exact account metas, policy, fee budget and simulation before signing.
func (m *signerKeyManagerV2) vaultCommitmentInstructionDataV1(walletID string, scope vaultCommitmentScopeV1, request signerSATCommitmentAllocateRequestV1, action string, maxRent uint64) ([]byte, error) {
	if action != "commit_vault_cycle" && action != "reveal_vault_cycle" {
		return nil, errors.New("unsupported Vault commitment action")
	}
	if action == "reveal_vault_cycle" && maxRent != 0 {
		return nil, errors.New("Vault reveal cannot add a rent budget")
	}
	walletID = normalizeWalletID(walletID)
	request, cycle, _, err := normalizeSATCommitmentAllocateRequestV1(request)
	if err != nil {
		return nil, err
	}
	if err := m.validateVaultCommitmentWalletV1(walletID, scope, request.ProgramID); err != nil {
		return nil, err
	}
	var record signerSATCommitmentRecordV1
	var material signerSATCommitmentMaterialV1
	err = m.store.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerSATCommitmentsV2).Get([]byte(vaultCommitmentSlotV1(scope, request)))
		if raw == nil {
			return errors.New("Vault commitment was not allocated")
		}
		record, material, err = m.openVaultCommitmentV1(raw, walletID, scope, request)
		return err
	})
	if err != nil {
		return nil, err
	}
	defer zeroSATCommitmentMaterialV1(&material)
	if !slices.Equal(material.AllocationFP, request.AllocationFP) {
		return nil, errors.New("Vault allocation does not match stored material")
	}
	contract := agentCapitalInstructionContractsV1[action]
	data := make([]byte, contract.DataSize)
	copy(data, contract.Discriminator[:])
	binary.LittleEndian.PutUint64(data[8:16], scope.AuthorityGeneration)
	binary.LittleEndian.PutUint64(data[16:24], cycle)
	if action == "commit_vault_cycle" {
		commitment, err := hex.DecodeString(record.CommitmentHex)
		if err != nil || len(commitment) != 32 {
			return nil, errors.New("invalid durable Vault commitment hash")
		}
		copy(data[24:56], commitment)
		binary.LittleEndian.PutUint64(data[56:64], maxRent)
	} else {
		nonce, err := base64.StdEncoding.DecodeString(material.NonceBase64)
		if err != nil || len(nonce) != 32 {
			return nil, errors.New("invalid durable Vault nonce")
		}
		defer zeroBytes(nonce)
		copy(data[24:56], nonce)
		for i, value := range material.AllocationFP {
			binary.LittleEndian.PutUint32(data[56+i*4:60+i*4], value)
		}
	}
	return data, nil
}
