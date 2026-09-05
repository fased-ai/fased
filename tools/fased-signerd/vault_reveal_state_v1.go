package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"

	solana "github.com/gagliardetto/solana-go"
)

// Reference-only review entry for native callers. Returned transaction remains
// private to the signer; the RPC must return a digest/summary, never these bytes.
func (m *signerKeyManagerV2) prepareVaultRevealReferenceV1(walletID string, bindingRequest vaultMiningBindingRequestV1, bindings signerOwnedAccountSnapshotV2, commitment signerSATCommitmentBindingRequestV1, reference string, reveal signerOwnedAccountSnapshotV2, blockhash solana.Hash) (*solana.Transaction, error) {
	wallet, err := m.PublicRecord(walletID)
	if err != nil {
		return nil, err
	}
	key, err := solana.PublicKeyFromBase58(wallet.PublicKey)
	if err != nil {
		return nil, err
	}
	scope, err := validateVaultRevealAuthorityV1(bindingRequest, key, bindings)
	if err != nil {
		return nil, err
	}
	request, err := m.restoreVaultRevealRequestV1(walletID, scope, commitment, reference)
	if err != nil {
		return nil, err
	}
	defer clear(request.AllocationFP)
	return m.prepareVaultRevealTransactionV1(walletID, bindingRequest, bindings, request, reveal, blockhash)
}

// Recovery accepts Active and Draining Vaults, including queued exits and entry
// pause. It still requires the exact current executor and immutable bindings.
func validateVaultRevealAuthorityV1(request vaultMiningBindingRequestV1, wallet solana.PublicKey, snapshot signerOwnedAccountSnapshotV2) (vaultCommitmentScopeV1, error) {
	var empty vaultCommitmentScopeV1
	if len(snapshot.Addresses) != 4 || len(snapshot.Accounts) != 4 {
		return empty, errors.New("incomplete Vault recovery context")
	}
	b := snapshot
	b.Addresses, b.Accounts = snapshot.Addresses[:3], snapshot.Accounts[:3]
	binding, err := resolveVaultMiningBindingV1(request, wallet, b)
	if err != nil {
		return empty, err
	}
	program := solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1)
	address, bump, err := solana.FindProgramAddress([][]byte{[]byte("agent-mining-vault"), binding.Scope.Binding[:]}, program)
	if err != nil {
		return empty, err
	}
	a := snapshot.Accounts[3]
	if snapshot.Addresses[3] != address || a == nil || a.Data == nil || a.Executable || a.Owner != program || len(a.Data.GetBinary()) != 511 {
		return empty, errors.New("invalid recovery Vault account")
	}
	v := a.Data.GetBinary()
	disc := sha256.Sum256([]byte("account:AgentMiningVault"))
	if !bytes.Equal(v[:8], disc[:8]) || v[8] != 1 || (v[9] != 1 && v[9] != 2) || v[10] != bump {
		return empty, errors.New("Vault cannot reveal in this state")
	}
	for offset, key := range map[int]solana.PublicKey{43: binding.Scope.Binding, 75: binding.Scope.Profile, 107: binding.Scope.Authority, 139: snapshot.Addresses[2]} {
		if !bytes.Equal(v[offset:offset+32], key[:]) {
			return empty, errors.New("Vault recovery identity mismatch")
		}
	}
	return binding.Scope, nil
}

// Native-only unsigned preparation. Not a signing authorization: deployment,
// budgets, reviewed intent, simulation and replay enforcement remain mandatory.
func (m *signerKeyManagerV2) prepareVaultRevealTransactionV1(walletID string, bindingRequest vaultMiningBindingRequestV1, bindings signerOwnedAccountSnapshotV2, request signerSATCommitmentAllocateRequestV1, reveal signerOwnedAccountSnapshotV2, blockhash solana.Hash) (*solana.Transaction, error) {
	wallet, err := m.PublicRecord(walletID)
	if err != nil {
		return nil, err
	}
	key, err := solana.PublicKeyFromBase58(wallet.PublicKey)
	if err != nil {
		return nil, err
	}
	if request.Cluster != bindingRequest.Cluster || bindings.Slot != reveal.Slot {
		return nil, errors.New("Vault reveal network or snapshot context mismatch")
	}
	scope, err := validateVaultRevealAuthorityV1(bindingRequest, key, bindings)
	if err != nil {
		return nil, err
	}
	page, err := m.inspectStoredVaultRevealV1(walletID, scope, request, reveal)
	if err != nil {
		return nil, err
	}
	return m.buildVaultTransactionV1(walletID, scope, request, "reveal_vault_cycle", 0, page, blockhash)
}

// Native-only bridge to authenticated encrypted storage. This does not construct
// or sign a reveal; callers must still establish current authority bindings.
func (m *signerKeyManagerV2) inspectStoredVaultRevealV1(walletID string, scope vaultCommitmentScopeV1, request signerSATCommitmentAllocateRequestV1, snapshot signerOwnedAccountSnapshotV2) (uint64, error) {
	request, cycle, amount, err := normalizeSATCommitmentAllocateRequestV1(request)
	if err != nil {
		return 0, err
	}
	data, err := m.vaultCommitmentInstructionDataV1(walletID, scope, request, "commit_vault_cycle", 0)
	if err != nil {
		return 0, err
	}
	defer zeroBytes(data)
	return validateVaultRevealCommitmentV1(scope, cycle, amount, data[24:56], snapshot)
}

// This checks only the cycle predicate for recovery, not authorization to sign.
// Snapshot contains exactly the cycle. Public-entry activation, queued exits and
// reserve entry budgets deliberately do not gate an existing commitment's reveal.
func validateVaultRevealWindowV1(cycleID uint64, snapshot signerOwnedAccountSnapshotV2) error {
	if cycleID == 0 || snapshot.Slot == 0 || len(snapshot.Addresses) != 1 || len(snapshot.Accounts) != 1 {
		return errors.New("incomplete Vault reveal context")
	}
	sat := solana.MustPublicKeyFromBase58(satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID)
	var id [8]byte
	binary.LittleEndian.PutUint64(id[:], cycleID)
	address, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_cycle_state_v2"), id[:]}, sat)
	if err != nil {
		return err
	}
	a := snapshot.Accounts[0]
	if snapshot.Addresses[0] != address || a == nil || a.Data == nil || a.Executable || a.Owner != sat || len(a.Data.GetBinary()) != 408 {
		return errors.New("invalid Vault reveal cycle account")
	}
	c := a.Data.GetBinary()
	if !bytes.Equal(c[:8], []byte{149, 0, 0, 0, 0, 0, 0, 0}) || binary.LittleEndian.Uint64(c[8:16]) != cycleID || c[32] != 1 || binary.LittleEndian.Uint64(c[40:48]) != 16 || !bytes.Equal(c[48:80], make([]byte, 32)) || snapshot.Slot < binary.LittleEndian.Uint64(c[352:360]) || snapshot.Slot >= binary.LittleEndian.Uint64(c[360:368]) {
		return errors.New("Vault cycle is outside the reveal window")
	}
	for i, g := range []uint16{1, 2, 2, 3, 3, 3, 3, 2, 2, 2} {
		if binary.LittleEndian.Uint16(c[384+2*i:386+2*i]) != g {
			return errors.New("wrong Vault reveal cycle generation")
		}
	}
	return nil
}

// Snapshot order: cycle, committed miner cycle, registry (nil before first reveal).
// expectedHash must come from authenticated native commitment storage, not RPC input.
// This is not a complete signing gate; binding, deployment and simulation remain required.
func validateVaultRevealCommitmentV1(scope vaultCommitmentScopeV1, cycleID, amount uint64, expectedHash []byte, snapshot signerOwnedAccountSnapshotV2) (uint64, error) {
	if len(snapshot.Addresses) != 3 || len(snapshot.Accounts) != 3 || len(expectedHash) != 32 || amount == 0 {
		return 0, errors.New("incomplete Vault reveal commitment context")
	}
	window := snapshot
	window.Addresses, window.Accounts = snapshot.Addresses[:1], snapshot.Accounts[:1]
	if err := validateVaultRevealWindowV1(cycleID, window); err != nil {
		return 0, err
	}
	sat := solana.MustPublicKeyFromBase58(satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID)
	var id [8]byte
	binary.LittleEndian.PutUint64(id[:], cycleID)
	miner, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_miner_cycle_state_v2"), scope.Authority[:], id[:]}, sat)
	if err != nil {
		return 0, err
	}
	registry, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_cycle_registry_meta"), id[:]}, sat)
	if err != nil {
		return 0, err
	}
	if snapshot.Addresses[1] != miner || snapshot.Addresses[2] != registry {
		return 0, errors.New("wrong Vault reveal addresses")
	}
	a := snapshot.Accounts[1]
	if a == nil || a.Data == nil || a.Executable || a.Owner != sat || len(a.Data.GetBinary()) != 416 {
		return 0, errors.New("invalid Vault miner cycle")
	}
	m := a.Data.GetBinary()
	if !bytes.Equal(m[:8], []byte{150, 0, 0, 0, 0, 0, 0, 0}) || !bytes.Equal(m[72:104], scope.Authority[:]) || !bytes.Equal(m[104:136], scope.PermanentMining[:]) || binary.LittleEndian.Uint64(m[136:144]) != cycleID || binary.LittleEndian.Uint64(m[144:152]) != amount || m[232] != 0 || m[233] != 0 || !bytes.Equal(m[240:272], expectedHash) {
		return 0, errors.New("Vault on-chain commitment mismatch or already resolved")
	}
	for i, g := range []uint16{1, 2, 2, 3, 3, 3, 3, 2, 2, 2} {
		if binary.LittleEndian.Uint16(m[328+2*i:330+2*i]) != g {
			return 0, errors.New("wrong Vault miner cycle generation")
		}
	}
	r := snapshot.Accounts[2]
	if r == nil {
		return 0, nil
	}
	// A prefunded system PDA is still uninitialized; the program may allocate it.
	if r.Owner == solana.SystemProgramID && !r.Executable && (r.Data == nil || len(r.Data.GetBinary()) == 0) {
		return 0, nil
	}
	if r.Data == nil || r.Executable || r.Owner != sat || len(r.Data.GetBinary()) != 88 {
		return 0, errors.New("invalid Vault reveal registry")
	}
	d := r.Data.GetBinary()
	if !bytes.Equal(d[:8], []byte{134, 0, 0, 0, 0, 0, 0, 0}) || binary.LittleEndian.Uint64(d[8:16]) != cycleID {
		return 0, errors.New("wrong Vault reveal registry identity")
	}
	page := uint64(binary.LittleEndian.Uint32(d[16:20])) / 64
	if page >= 65535 {
		return 0, errors.New("Vault reveal registry capacity exhausted")
	}
	return page, nil
}
