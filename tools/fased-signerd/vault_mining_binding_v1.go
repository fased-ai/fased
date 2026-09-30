package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// This read-only inspection proves account bindings, not executable ProgramData
// identity and not permission to sign. Signing still requires the reviewed path.
type vaultMiningBindingRequestV1 struct {
	Cluster          string `json:"cluster"`
	Profile          string `json:"profile"`
	PermanentMining  string `json:"permanentMining"`
	MinFinalizedSlot uint64 `json:"minFinalizedSlot"`
}
type vaultMiningBindingResultV1 struct {
	Verification         string                 `json:"verification"`
	Scope                vaultCommitmentScopeV1 `json:"scope"`
	FinalizedSlot        uint64                 `json:"finalizedSlot"`
	StateDigest          string                 `json:"stateDigest"`
	FundedLamports       string                 `json:"fundedLamports"`
	ActiveCommitLamports string                 `json:"activeCommitLamports"`
	EntryPaused          bool                   `json:"entryPaused"`
}

func vaultMiningBindingAddressesV1(request vaultMiningBindingRequestV1) ([]solana.PublicKey, solana.PublicKey, error) {
	if request.Cluster != "devnet" {
		return nil, solana.PublicKey{}, errors.New("Vault binding inspection currently requires Devnet")
	}
	if request.MinFinalizedSlot == 0 || request.MinFinalizedSlot > 9007199254740991 {
		return nil, solana.PublicKey{}, errors.New("invalid minimum finalized slot")
	}
	profile, err := solana.PublicKeyFromBase58(request.Profile)
	if err != nil || profile.IsZero() {
		return nil, solana.PublicKey{}, errors.New("invalid Vault Profile")
	}
	mining, err := solana.PublicKeyFromBase58(request.PermanentMining)
	if err != nil || mining.IsZero() {
		return nil, solana.PublicKey{}, errors.New("invalid permanent mining identity")
	}
	sat := solana.MustPublicKeyFromBase58(satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID)
	capital := solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1)
	binding, _, err := solana.FindProgramAddress([][]byte{[]byte("capital-vault-binding"), profile[:]}, capital)
	if err != nil {
		return nil, solana.PublicKey{}, err
	}
	authority, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_agent_vault_authority"), sat[:], mining[:]}, capital)
	if err != nil {
		return nil, solana.PublicKey{}, err
	}
	record, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_agent_record"), mining[:]}, sat)
	if err != nil {
		return nil, solana.PublicKey{}, err
	}
	funds, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_miner_capital_state"), authority[:]}, sat)
	return []solana.PublicKey{binding, record, funds}, authority, err
}

func resolveVaultMiningBindingV1(request vaultMiningBindingRequestV1, wallet solana.PublicKey, snapshot signerOwnedAccountSnapshotV2) (vaultMiningBindingResultV1, error) {
	var result vaultMiningBindingResultV1
	addresses, authority, err := vaultMiningBindingAddressesV1(request)
	if err != nil {
		return result, err
	}
	if snapshot.Slot == 0 || snapshot.Slot < request.MinFinalizedSlot || len(snapshot.Addresses) != 3 || len(snapshot.Accounts) != 3 {
		return result, errors.New("Vault binding snapshot is stale or incomplete")
	}
	for i := range addresses {
		if !addresses[i].Equals(snapshot.Addresses[i]) {
			return result, errors.New("Vault binding snapshot address order mismatch")
		}
	}
	capital := solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1)
	sat := solana.MustPublicKeyFromBase58(satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID)
	// Exact Anchor Borsh and Satcoin repr(C) layouts from the canonical contracts.
	sizes := []int{492, 1032, 136}
	owners := []solana.PublicKey{capital, sat, sat}
	data := make([][]byte, 3)
	for i, account := range snapshot.Accounts {
		if account == nil || account.Data == nil || account.Executable || !account.Owner.Equals(owners[i]) || len(account.Data.GetBinary()) != sizes[i] {
			return result, fmt.Errorf("invalid Vault binding account %d", i)
		}
		data[i] = account.Data.GetBinary()
	}
	binding, record, funds := data[0], data[1], data[2]
	disc := sha256.Sum256([]byte("account:AgentCapitalVaultBinding"))
	if !bytes.Equal(binding[:8], disc[:8]) || binding[8] != 1 || binding[9] != 0 ||
		!bytes.Equal(record[:8], []byte{141, 0, 0, 0, 0, 0, 0, 0}) || record[8] != 1 || record[9] != 1 ||
		binary.LittleEndian.Uint16(record[12:14]) != 2 || binary.LittleEndian.Uint16(record[14:16]) != 2 ||
		!bytes.Equal(funds[:8], []byte{138, 0, 0, 0, 0, 0, 0, 0}) || funds[8] != 2 {
		return result, errors.New("unsupported Vault binding account layout/status")
	}
	for i, generation := range []uint16{1, 3, 3, 3, 3, 2, 2, 2} {
		if binary.LittleEndian.Uint16(record[348+i*2:350+i*2]) != generation {
			return result, errors.New("unsupported Vault component generation")
		}
	}
	key := func(data []byte, offset int) solana.PublicKey {
		var p solana.PublicKey
		copy(p[:], data[offset:offset+32])
		return p
	}
	u64 := func(data []byte, offset int) uint64 { return binary.LittleEndian.Uint64(data[offset : offset+8]) }
	profile := solana.MustPublicKeyFromBase58(request.Profile)
	mining := solana.MustPublicKeyFromBase58(request.PermanentMining)
	if key(binding, 20) != profile || key(binding, 84) != addresses[1] || key(binding, 116) != sat || key(binding, 148) != mining ||
		key(binding, 276) != authority || key(binding, 308) != addresses[2] ||
		key(record, 24) != mining || key(record, 120) != authority || key(record, 152) != authority || key(record, 184) != wallet || key(record, 912) != capital ||
		key(binding, 340) != key(record, 944) || key(binding, 372) != key(record, 976) ||
		u64(binding, 468) == 0 || u64(binding, 468) != u64(record, 1008) ||
		key(funds, 16) != authority || key(funds, 96) != mining {
		return result, errors.New("Vault mining authority/destination binding mismatch")
	}
	result.Scope = vaultCommitmentScopeV1{Profile: profile, PermanentMining: mining, Binding: addresses[0], Authority: authority,
		Executor: wallet, Keeper: key(record, 216), AuthorityGeneration: u64(record, 16), BindingGeneration: u64(binding, 12)}
	if err := validateVaultCommitmentScopeV1(result.Scope, wallet.String(), sat.String()); err != nil {
		return result, err
	}
	digest, err := signerOwnedAccountSnapshotDigestV2(addresses, snapshot.Accounts)
	if err != nil {
		return result, err
	}
	result.FinalizedSlot, result.StateDigest = snapshot.Slot, digest
	result.Verification = "account-bindings-only"
	result.FundedLamports = fmt.Sprint(u64(funds, 48))
	result.ActiveCommitLamports = fmt.Sprint(u64(funds, 64))
	result.EntryPaused = record[11]&1 != 0
	return result, nil
}

func inspectVaultMiningBindingV1(urls []string, wallet solana.PublicKey, request vaultMiningBindingRequestV1) (vaultMiningBindingResultV1, error) {
	addresses, _, err := vaultMiningBindingAddressesV1(request)
	if err != nil {
		return vaultMiningBindingResultV1{}, err
	}
	verified, err := solanaRPCURLsForClusterV2(urls, request.Cluster)
	if err != nil {
		return vaultMiningBindingResultV1{}, err
	}
	for _, url := range verified {
		client := newSignerOwnedSolanaRPCClientV2(url)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		response, err := client.GetMultipleAccountsWithOpts(ctx, addresses, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized})
		cancel()
		if err != nil || response == nil {
			continue
		}
		result, err := resolveVaultMiningBindingV1(request, wallet, signerOwnedAccountSnapshotV2{Slot: response.Context.Slot, Addresses: addresses, Accounts: response.Value})
		if err == nil {
			return result, nil
		}
	}
	return vaultMiningBindingResultV1{}, errors.New("finalized Vault binding readback failed")
}
