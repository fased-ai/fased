package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

func TestVaultCommitmentStorageScopeAndRestart(t *testing.T) {
	dir := t.TempDir()
	state, master := filepath.Join(dir, "state.db"), filepath.Join(dir, "master.key")
	store, err := openSignerStoreV2(state)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := openSignerKeyManagerV2(store, master)
	if err != nil {
		t.Fatal(err)
	}
	wallet, _, err := keys.CreateWithRoleBaseline("executor", 0, signerRoleBaselineRequestV1{Version: 1, Role: "agent"}, signerRoleBaselineRuntimeV1{})
	if err != nil {
		t.Fatal(err)
	}
	program := solana.MustPublicKeyFromBase58(satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID)
	capital := solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1)
	scope := vaultCommitmentScopeV1{Profile: solana.NewWallet().PublicKey(), PermanentMining: solana.NewWallet().PublicKey(),
		Executor: solana.MustPublicKeyFromBase58(wallet.PublicKey), Keeper: solana.NewWallet().PublicKey(), AuthorityGeneration: 1, BindingGeneration: 1}
	scope.Binding, _, err = solana.FindProgramAddress([][]byte{[]byte("capital-vault-binding"), scope.Profile[:]}, capital)
	if err != nil {
		t.Fatal(err)
	}
	scope.Authority, _, err = solana.FindProgramAddress([][]byte{[]byte("sat_agent_vault_authority"), program[:], scope.PermanentMining[:]}, capital)
	if err != nil {
		t.Fatal(err)
	}
	request := signerSATCommitmentAllocateRequestV1{Cluster: "devnet", ProgramID: program.String(), ProtocolGeneration: "2", CycleID: "43", CommittedLamports: "1000000000", AllocationFP: make([]uint32, 16)}
	for i := range request.AllocationFP {
		request.AllocationFP[i] = 62500
	}
	allocated, err := keys.allocateVaultCommitmentV1(wallet.WalletID, scope, request)
	if err != nil {
		t.Fatal(err)
	}
	repeat, err := keys.allocateVaultCommitmentV1(wallet.WalletID, scope, request)
	if err != nil || repeat != allocated {
		t.Fatalf("immutable retry: %v", err)
	}
	slot := vaultCommitmentSlotV1(scope, request)
	var raw []byte
	if err := store.db.View(func(tx *bolt.Tx) error {
		raw = bytes.Clone(tx.Bucket(bucketSignerSATCommitmentsV2).Get([]byte(slot)))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	record, material, err := keys.openVaultCommitmentV1(raw, wallet.WalletID, scope, request)
	if err != nil {
		t.Fatal(err)
	}
	defer zeroSATCommitmentMaterialV1(&material)
	nonce, err := base64.StdEncoding.DecodeString(material.NonceBase64)
	if err != nil {
		t.Fatal(err)
	}
	defer zeroBytes(nonce)
	if buildSATCommitmentV1(program, scope.Authority, 43, 1_000_000_000, nonce, material.AllocationFP) != allocated.CommitmentHex {
		t.Fatal("wrong Vault commitment domain")
	}
	if buildSATCommitmentV1(program, scope.Executor, 43, 1_000_000_000, nonce, material.AllocationFP) == allocated.CommitmentHex {
		t.Fatal("commitment used executor instead of Vault")
	}
	if bytes.Contains(raw, []byte(material.NonceBase64)) || bytes.Contains(raw, []byte("allocationFp")) {
		t.Fatal("plaintext material stored")
	}
	if _, err := keys.loadSATCommitmentRecordV1(wallet.WalletID, allocated.Reference); err == nil {
		t.Fatal("Vault material entered direct miner path")
	}
	for _, mutate := range []func(*vaultCommitmentScopeV1){
		func(s *vaultCommitmentScopeV1) { s.AuthorityGeneration++ },
		func(s *vaultCommitmentScopeV1) { s.BindingGeneration++ },
		func(s *vaultCommitmentScopeV1) { s.Authority = s.Executor },
		func(s *vaultCommitmentScopeV1) { s.Keeper = s.Executor },
		func(s *vaultCommitmentScopeV1) { s.Executor = solana.NewWallet().PublicKey() },
		func(s *vaultCommitmentScopeV1) { s.Binding = solana.NewWallet().PublicKey() },
	} {
		changed := scope
		mutate(&changed)
		if _, err := keys.allocateVaultCommitmentV1(wallet.WalletID, changed, request); err == nil {
			t.Fatal("changed scope accepted")
		}
	}
	changed := request
	changed.AllocationFP = append([]uint32(nil), request.AllocationFP...)
	changed.AllocationFP[0]++
	changed.AllocationFP[1]--
	if _, err := keys.allocateVaultCommitmentV1(wallet.WalletID, scope, changed); err == nil {
		t.Fatal("allocation replacement accepted")
	}
	changed = request
	changed.CommittedLamports = "2000000000"
	if _, err := keys.allocateVaultCommitmentV1(wallet.WalletID, scope, changed); err == nil {
		t.Fatal("capital replacement accepted")
	}
	forged := vaultCommitmentRecordV1{Scope: scope, Commitment: record}
	forged.Scope.AuthorityGeneration++
	forged.Commitment.Reference = vaultCommitmentReferenceV1(forged.Scope, forged.Commitment)
	tampered, _ := json.Marshal(forged)
	if _, _, err := keys.openVaultCommitmentV1(tampered, wallet.WalletID, forged.Scope, request); err == nil {
		t.Fatal("scope rewrite bypassed authenticated encryption")
	}
	keys.Close()
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = openSignerStoreV2(state)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	keys, err = openSignerKeyManagerV2(store, master)
	if err != nil {
		t.Fatal(err)
	}
	defer keys.Close()
	recovered, err := keys.allocateVaultCommitmentV1(wallet.WalletID, scope, request)
	if err != nil || recovered != allocated {
		t.Fatalf("restart changed commitment: %v", err)
	}
	var reopened []byte
	if err := store.db.View(func(tx *bolt.Tx) error {
		reopened = bytes.Clone(tx.Bucket(bucketSignerSATCommitmentsV2).Get([]byte(slot)))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(reopened, raw) {
		t.Fatal("retry/rejection/restart rewrote durable material")
	}
	_, after, err := keys.openVaultCommitmentV1(reopened, wallet.WalletID, scope, request)
	if err != nil {
		t.Fatal(err)
	}
	defer zeroSATCommitmentMaterialV1(&after)
	if material.NonceBase64 != after.NonceBase64 {
		t.Fatal("restart lost nonce")
	}
	commitData, err := keys.vaultCommitmentInstructionDataV1(wallet.WalletID, scope, request, "commit_vault_cycle", 5000000)
	if err != nil {
		t.Fatal(err)
	}
	revealData, err := keys.vaultCommitmentInstructionDataV1(wallet.WalletID, scope, request, "reveal_vault_cycle", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer zeroBytes(revealData)
	for _, action := range []string{"commit_vault_cycle", "reveal_vault_cycle"} {
		rent := uint64(0)
		expectedData := revealData
		if action == "commit_vault_cycle" {
			rent = 5000000
			expectedData = commitData
		}
		tx, err := keys.buildVaultTransactionV1(wallet.WalletID, scope, request, action, rent, 0, solana.Hash{1})
		if err != nil {
			t.Fatal(err)
		}
		if len(tx.Message.Instructions) != 1 || !bytes.Equal(tx.Message.Instructions[0].Data, expectedData) {
			t.Fatal("Vault transaction lost native instruction data")
		}
		if tx.Message.AccountKeys[0] != scope.Executor || tx.Message.Header.NumRequiredSignatures != 1 || !tx.Signatures[0].IsZero() {
			t.Fatal("Vault transaction expanded signer authority")
		}
		compiled := tx.Message.Instructions[0]
		if tx.Message.AccountKeys[compiled.ProgramIDIndex] != capital || len(compiled.Accounts) != len(agentCapitalInstructionContractsV1[action].Accounts) {
			t.Fatal("Vault transaction changed program/account contract")
		}
		if tx.Message.AccountKeys[compiled.Accounts[1]] != scope.Binding || tx.Message.AccountKeys[compiled.Accounts[0]] != scope.Executor {
			t.Fatal("Vault transaction changed binding/executor")
		}
		raw, err := tx.MarshalBinary()
		if err != nil {
			t.Fatal(err)
		}
		if err := validateVaultTransactionBytesV1(tx, raw); err != nil {
			t.Fatal(err)
		}
		for _, offset := range []int{1, len(raw) - 1} {
			bad := bytes.Clone(raw)
			bad[offset] ^= 1
			if validateVaultTransactionBytesV1(tx, bad) == nil {
				t.Fatal("accepted mutated Vault transaction")
			}
			zeroBytes(bad)
		}
		if validateVaultTransactionBytesV1(tx, append(bytes.Clone(raw), 0)) == nil {
			t.Fatal("accepted appended transaction bytes")
		}
		zeroBytes(raw)
		zeroBytes(tx.Message.Instructions[0].Data)
	}
	if _, err := keys.buildVaultTransactionV1(wallet.WalletID, scope, request, "commit_vault_cycle", 0, 1, solana.Hash{1}); err == nil {
		t.Fatal("commit accepted reveal page context")
	}
	if _, err := keys.buildVaultTransactionV1(wallet.WalletID, scope, request, "commit_vault_cycle", 0, 0, solana.Hash{}); err == nil {
		t.Fatal("accepted empty blockhash")
	}
	if len(commitData) != 64 || len(revealData) != 120 || hex.EncodeToString(commitData[24:56]) != allocated.CommitmentHex ||
		binary.LittleEndian.Uint64(commitData[56:64]) != 5000000 || binary.LittleEndian.Uint64(revealData[8:16]) != 1 ||
		binary.LittleEndian.Uint64(revealData[16:24]) != 43 || !bytes.Equal(revealData[24:56], nonce) {
		t.Fatal("native Vault instruction binding mismatch")
	}
	for i, value := range material.AllocationFP {
		if binary.LittleEndian.Uint32(revealData[56+i*4:60+i*4]) != value {
			t.Fatalf("wrong little-endian allocation at channel %d", i)
		}
	}
	for _, action := range []string{"reveal_vault_cycle", "withdraw", ""} {
		if _, err := keys.vaultCommitmentInstructionDataV1(wallet.WalletID, scope, request, action, 1); err == nil {
			t.Fatal("expanded action/rent accepted")
		}
	}
	direct := createSATCommitmentMiningWalletV1(t, keys, "mining")
	wrongRole := scope
	wrongRole.Executor = solana.MustPublicKeyFromBase58(direct.PublicKey)
	if _, err := keys.allocateVaultCommitmentV1(direct.WalletID, wrongRole, request); err == nil {
		t.Fatal("Mining wallet reused as Vault executor")
	}
}
