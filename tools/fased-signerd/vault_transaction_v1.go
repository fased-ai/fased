package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"

	solana "github.com/gagliardetto/solana-go"
)

// Snapshot order: Capital binding, SatAgentRecord, miner capital, Mining Vault.
// This is a pre-entry gate only; it does not authorize spending or replace the
// cycle-window, reserve, deployment, policy, simulation and replay gates.
func validateVaultCommitStateV1(request vaultMiningBindingRequestV1, wallet solana.PublicKey, snapshot signerOwnedAccountSnapshotV2, committed uint64) (vaultCommitmentScopeV1, error) {
	var empty vaultCommitmentScopeV1
	if len(snapshot.Addresses) != 4 || len(snapshot.Accounts) != 4 {
		return empty, errors.New("incomplete Vault commit snapshot")
	}
	bindingSnapshot := snapshot
	bindingSnapshot.Addresses = snapshot.Addresses[:3]
	bindingSnapshot.Accounts = snapshot.Accounts[:3]
	binding, err := resolveVaultMiningBindingV1(request, wallet, bindingSnapshot)
	if err != nil {
		return empty, err
	}
	if binding.EntryPaused {
		return empty, errors.New("Vault mining entry is paused")
	}
	capitalProgram := solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1)
	vaultAddress, _, err := solana.FindProgramAddress([][]byte{[]byte("agent-mining-vault"), binding.Scope.Binding[:]}, capitalProgram)
	if err != nil {
		return empty, err
	}
	account := snapshot.Accounts[3]
	if snapshot.Addresses[3] != vaultAddress || account == nil || account.Data == nil || account.Executable || account.Owner != capitalProgram || len(account.Data.GetBinary()) != 511 {
		return empty, errors.New("invalid Mining Vault account")
	}
	vault := account.Data.GetBinary()
	disc := sha256.Sum256([]byte("account:AgentMiningVault"))
	if !bytes.Equal(vault[:8], disc[:8]) || vault[8] != 1 || vault[9] != 1 || binary.LittleEndian.Uint32(vault[279:283]) != 0 {
		return empty, errors.New("Vault is not active or has queued exits")
	}
	keyMatches := func(offset int, key solana.PublicKey) bool { return bytes.Equal(vault[offset:offset+32], key[:]) }
	if !keyMatches(43, binding.Scope.Binding) || !keyMatches(75, binding.Scope.Profile) || !keyMatches(107, binding.Scope.Authority) || !keyMatches(139, snapshot.Addresses[2]) {
		return empty, errors.New("Mining Vault identity mismatch")
	}
	record := snapshot.Accounts[1].Data.GetBinary()
	if binary.LittleEndian.Uint64(vault[351:359]) != binary.LittleEndian.Uint64(record[376:384]) {
		return empty, errors.New("Vault mining receipt has not been reconciled")
	}
	funds := snapshot.Accounts[2].Data.GetBinary()
	u64 := func(offset int) uint64 { return binary.LittleEndian.Uint64(funds[offset : offset+8]) }
	if u64(56) != 0 || u64(72) != 0 || u64(80) != 0 || u64(88) != 0 {
		return empty, errors.New("Vault has locked capital, pending cycles or keeper debt")
	}
	if committed < 1_000_000_000 || committed != u64(64) {
		return empty, errors.New("Vault commit does not match active capital configuration")
	}
	collateral := committed / 100
	if committed > ^uint64(0)-collateral || u64(48) < committed+collateral {
		return empty, errors.New("Vault requires active commit plus 100-bps collateral")
	}
	if snapshot.Accounts[2].Lamports < u64(48) {
		return empty, errors.New("Vault funded accounting exceeds account balance")
	}
	return binding.Scope, nil
}

func (m *signerKeyManagerV2) prepareVaultCommitTransactionV1(walletID string, bindingRequest vaultMiningBindingRequestV1, snapshot signerOwnedAccountSnapshotV2, request signerSATCommitmentAllocateRequestV1, maxRent uint64, blockhash solana.Hash, cycleReserve signerOwnedAccountSnapshotV2, reserveRentMinimum, expectedActivation uint64) (*solana.Transaction, error) {
	wallet, err := m.PublicRecord(walletID)
	if err != nil {
		return nil, err
	}
	key, err := solana.PublicKeyFromBase58(wallet.PublicKey)
	if err != nil {
		return nil, err
	}
	request, cycle, committed, err := normalizeSATCommitmentAllocateRequestV1(request)
	if err != nil {
		return nil, err
	}
	if request.Cluster != bindingRequest.Cluster {
		return nil, errors.New("Vault commit network mismatch")
	}
	scope, err := validateVaultCommitStateV1(bindingRequest, key, snapshot, committed)
	if err != nil {
		return nil, err
	}
	if cycleReserve.Slot != snapshot.Slot {
		return nil, errors.New("Vault state and cycle/reserve snapshots are not from the same context")
	}
	if err := validateVaultCycleReserveV1(scope, cycle, cycleReserve, reserveRentMinimum, expectedActivation); err != nil {
		return nil, err
	}
	return m.buildVaultTransactionV1(walletID, scope, request, "commit_vault_cycle", maxRent, 0, blockhash)
}

// Native-only: returned transactions may contain reveal material and must never
// be returned by an RPC, persisted as plaintext, or logged. This constructor is
// not approval: callers still need current state, deployment, policy and review.
// pageIndex must be obtained from the current registry before reveal simulation.
func (m *signerKeyManagerV2) buildVaultTransactionV1(walletID string, scope vaultCommitmentScopeV1, request signerSATCommitmentAllocateRequestV1, action string, maxRent, pageIndex uint64, blockhash solana.Hash) (*solana.Transaction, error) {
	if blockhash == (solana.Hash{}) || (action == "commit_vault_cycle" && pageIndex != 0) {
		return nil, errors.New("invalid Vault transaction context")
	}
	request, cycle, _, err := normalizeSATCommitmentAllocateRequestV1(request)
	if err != nil {
		return nil, err
	}
	data, err := m.vaultCommitmentInstructionDataV1(walletID, scope, request, action, maxRent)
	if err != nil {
		return nil, err
	}
	defer zeroBytes(data)
	sat := solana.MustPublicKeyFromBase58(request.ProgramID)
	capital := solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1)
	var cycleBytes, pageBytes [8]byte
	binary.LittleEndian.PutUint64(cycleBytes[:], cycle)
	binary.LittleEndian.PutUint64(pageBytes[:], pageIndex)
	keys := map[string]solana.PublicKey{"executor": scope.Executor, "agent_capital_vault_binding": scope.Binding, "permanent_mining_id": scope.PermanentMining, "vault_authority": scope.Authority, "satcoin_program": sat, "system_program": solana.SystemProgramID}
	seeds := map[string][][]byte{
		"mining_vault":        {[]byte("agent-mining-vault"), scope.Binding[:]},
		"sat_agent_record":    {[]byte("sat_agent_record"), scope.PermanentMining[:]},
		"vault_miner_capital": {[]byte("sat_miner_capital_state"), scope.Authority[:]},
		"protocol_state":      {[]byte("sat_protocol_generation_state_v2")},
		"cycle":               {[]byte("sat_cycle_state_v2"), cycleBytes[:]},
		"miner_cycle":         {[]byte("sat_miner_cycle_state_v2"), scope.Authority[:], cycleBytes[:]},
		"operating_reserve":   {[]byte("sat_keeper_operating_reserve"), scope.PermanentMining[:]},
		"reward_remainder":    {[]byte("sat_agent_reward_remainder_v2"), scope.PermanentMining[:]},
		"registry":            {[]byte("sat_cycle_registry_meta"), cycleBytes[:]},
		"page":                {[]byte("sat_cycle_registry_page"), cycleBytes[:], pageBytes[:]},
		"progress":            {[]byte("sat_cycle_settlement_progress_v3"), cycleBytes[:]},
		"registry_reserve":    {[]byte("sat_registry_reserve_v2")},
	}
	contract := agentCapitalInstructionContractsV1[action]
	accounts := make(solana.AccountMetaSlice, 0, len(contract.Accounts))
	for _, account := range contract.Accounts {
		key, ok := keys[account.Name]
		if !ok {
			seed, exists := seeds[account.Name]
			if !exists {
				return nil, errors.New("unsupported Vault account contract")
			}
			owner := sat
			if account.Name == "mining_vault" {
				owner = capital
			}
			key, _, err = solana.FindProgramAddress(seed, owner)
			if err != nil {
				return nil, err
			}
		}
		accounts = append(accounts, &solana.AccountMeta{PublicKey: key, IsSigner: account.IsSigner, IsWritable: account.IsWritable})
	}
	// The transaction retains instruction data. Give it its own buffer before
	// clearing the temporary hydrated buffer on return.
	tx, err := solana.NewTransaction([]solana.Instruction{solana.NewInstruction(capital, accounts, bytes.Clone(data))}, blockhash, solana.TransactionPayer(scope.Executor))
	if err != nil {
		return nil, err
	}
	if tx.Message.IsVersioned() || tx.Message.Header.NumRequiredSignatures != 1 || tx.Message.AccountKeys[0] != scope.Executor {
		return nil, errors.New("invalid Vault transaction signer layout")
	}
	tx.Signatures = make([]solana.Signature, 1)
	return tx, nil
}

// Exact comparison includes fee payer, blockhash, instruction order/data, account
// flags and absence of extra instructions/signatures. Expected is built natively.
func validateVaultTransactionBytesV1(expected *solana.Transaction, raw []byte) error {
	if expected == nil || len(raw) == 0 || len(raw) > 1232 {
		return errors.New("invalid Vault transaction size")
	}
	canonical, err := expected.MarshalBinary()
	if err != nil {
		return err
	}
	defer zeroBytes(canonical)
	if !bytes.Equal(canonical, raw) {
		return errors.New("Vault transaction differs from reviewed native construction")
	}
	return nil
}
