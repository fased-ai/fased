package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type signerVaultMiningAllocateV1 struct {
	Binding              vaultMiningBindingRequestV1          `json:"binding"`
	Commitment           signerSATCommitmentAllocateRequestV1 `json:"commitment"`
	ActivationGeneration string                               `json:"activationGeneration"`
}

func (s *signerServiceV2) allocateReviewedVaultCommitmentV1(walletID string, input signerVaultMiningAllocateV1) (signerSATCommitmentAllocationResultV1, error) {
	var empty signerSATCommitmentAllocationResultV1
	request, cycle, amount, err := normalizeSATCommitmentAllocateRequestV1(input.Commitment)
	if err != nil {
		return empty, err
	}
	if request.Cluster != input.Binding.Cluster || request.Cluster != "devnet" || request.ProtocolGeneration != "2" || request.ProgramID != satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID || len(request.AllocationFP) != 16 {
		return empty, errors.New("invalid Vault allocation network/contract")
	}
	activation, err := vaultCanonicalU64V1(input.ActivationGeneration, true)
	if err != nil {
		return empty, err
	}
	policy, err := s.store.getPolicy(walletID)
	if err != nil {
		return empty, err
	}
	if policy.Role != "agent" {
		return empty, errors.New("Vault allocation requires Agent role")
	}
	release, err := signerVaultReleaseContextV1(request.Cluster, solanaDevnetGenesisHashV2)
	if err != nil {
		return empty, err
	}
	wallet, err := s.keys.PublicRecord(walletID)
	if err != nil {
		return empty, err
	}
	key, err := solana.PublicKeyFromBase58(wallet.PublicKey)
	if err != nil {
		return empty, err
	}
	urls, err := s.keys.SolanaRPCURLsV2(walletID)
	if err != nil {
		return empty, errSignerNetworkPendingV2
	}
	urls, err = solanaRPCURLsForClusterV2(urls, request.Cluster)
	if err != nil {
		return empty, err
	}
	intent := normalizedIntentV2{Intent: signerIntentV2{Cluster: request.Cluster, VaultMining: &signerVaultMiningIntentV1{Profile: input.Binding.Profile, PermanentMining: input.Binding.PermanentMining, CycleID: request.CycleID, MinFinalizedSlot: strconv.FormatUint(input.Binding.MinFinalizedSlot, 10)}}}
	snapshot, rent, err := fetchVaultReviewSnapshotV1(urls, intent)
	if err != nil {
		return empty, err
	}
	if err := verifyVaultDeploymentPairV1(release.Capital, release.Satcoin, vaultSnapshotSubsetV1(snapshot, 9, 10), vaultSnapshotSubsetV1(snapshot, 11, 12), snapshot.Slot); err != nil {
		return empty, err
	}
	scope, err := validateVaultCommitStateV1(input.Binding, key, vaultSnapshotSubsetV1(snapshot, 0, 1, 2, 3), amount)
	if err != nil {
		return empty, err
	}
	if err := validateVaultCycleReserveV1(scope, cycle, vaultSnapshotSubsetV1(snapshot, 4, 7, 8), rent, activation); err != nil {
		return empty, err
	}
	return s.keys.allocateVaultCommitmentV1(walletID, scope, request)
}

// One finalized read: binding, record, capital, Vault, cycle, miner cycle,
// registry, Operating Reserve, protocol, Capital/ProgramData, SAT/ProgramData.
func vaultReviewAddressesV1(intent normalizedIntentV2) ([]solana.PublicKey, error) {
	r := vaultIntentBindingRequestV1(intent)
	addresses, authority, err := vaultMiningBindingAddressesV1(r)
	if err != nil {
		return nil, err
	}
	sat := solana.MustPublicKeyFromBase58(satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID)
	capital := solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1)
	mining := solana.MustPublicKeyFromBase58(r.PermanentMining)
	cycle, _ := vaultCanonicalU64V1(intent.Intent.VaultMining.CycleID, true)
	var id [8]byte
	binary.LittleEndian.PutUint64(id[:], cycle)
	for i, seeds := range [][][]byte{
		{[]byte("agent-mining-vault"), addresses[0][:]},
		{[]byte("sat_cycle_state_v2"), id[:]},
		{[]byte("sat_miner_cycle_state_v2"), authority[:], id[:]},
		{[]byte("sat_cycle_registry_meta"), id[:]},
		{[]byte("sat_keeper_operating_reserve"), mining[:]},
		{[]byte("sat_protocol_generation_state_v2")},
	} {
		program := sat
		if i == 0 {
			program = capital
		}
		address, _, err := solana.FindProgramAddress(seeds, program)
		if err != nil {
			return nil, err
		}
		addresses = append(addresses, address)
	}
	loader := solana.MustPublicKeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")
	for _, program := range []solana.PublicKey{capital, sat} {
		data, _, err := solana.FindProgramAddress([][]byte{program[:]}, loader)
		if err != nil {
			return nil, err
		}
		addresses = append(addresses, program, data)
	}
	return addresses, nil
}

func vaultSnapshotSubsetV1(s signerOwnedAccountSnapshotV2, indexes ...int) signerOwnedAccountSnapshotV2 {
	result := signerOwnedAccountSnapshotV2{Slot: s.Slot}
	for _, i := range indexes {
		result.Addresses = append(result.Addresses, s.Addresses[i])
		result.Accounts = append(result.Accounts, s.Accounts[i])
	}
	result.Digest, _ = signerOwnedAccountSnapshotDigestV2(result.Addresses, result.Accounts)
	return result
}

// Pure native preparation seam. Pins must be supplied by the compiled release
// lookup, never a public request. Tests pass synthetic pins to this layer only.
func (m *signerKeyManagerV2) prepareVaultReviewStateV1(walletID string, intent normalizedIntentV2, snapshot signerOwnedAccountSnapshotV2, release vaultReleaseContextV1, rent uint64, blockhash solana.Hash) (*solana.Transaction, vaultReviewReferenceV1, error) {
	var empty vaultReviewReferenceV1
	if intent.Intent.VaultMining == nil || len(snapshot.Addresses) != 13 || len(snapshot.Accounts) != 13 || release.Cluster != intent.Intent.Cluster || release.Genesis != solanaDevnetGenesisHashV2 {
		return nil, empty, errors.New("incomplete Vault review release/state")
	}
	expected, err := vaultReviewAddressesV1(intent)
	if err != nil {
		return nil, empty, err
	}
	for i := range expected {
		if expected[i] != snapshot.Addresses[i] {
			return nil, empty, errors.New("Vault review snapshot address mismatch")
		}
	}
	if err := verifyVaultDeploymentPairV1(release.Capital, release.Satcoin, vaultSnapshotSubsetV1(snapshot, 9, 10), vaultSnapshotSubsetV1(snapshot, 11, 12), snapshot.Slot); err != nil {
		return nil, empty, err
	}
	wallet, err := m.PublicRecord(walletID)
	if err != nil {
		return nil, empty, err
	}
	key, err := solana.PublicKeyFromBase58(wallet.PublicKey)
	if err != nil {
		return nil, empty, err
	}
	bindingRequest := vaultIntentBindingRequestV1(intent)
	bindings := vaultSnapshotSubsetV1(snapshot, 0, 1, 2, 3)
	scope, err := validateVaultRevealAuthorityV1(bindingRequest, key, bindings)
	if err != nil {
		return nil, empty, err
	}
	v := intent.Intent.VaultMining
	if strconv.FormatUint(scope.AuthorityGeneration, 10) != v.AuthorityGeneration || strconv.FormatUint(scope.BindingGeneration, 10) != v.BindingGeneration {
		return nil, empty, errors.New("Vault reviewed authority changed")
	}
	commitment := signerSATCommitmentBindingRequestV1{Cluster: intent.Intent.Cluster, ProgramID: release.Satcoin.Program.String(), ProtocolGeneration: "2", CycleID: v.CycleID}
	request, err := m.restoreVaultRevealRequestV1(walletID, scope, commitment, v.Reference)
	if err != nil {
		return nil, empty, err
	}
	defer clear(request.AllocationFP)
	if request.CommittedLamports != v.CommittedLamports {
		return nil, empty, errors.New("Vault reviewed capital differs from commitment")
	}
	var tx *solana.Transaction
	if intent.Intent.Action == "commit_vault_cycle" {
		// Already allocated on-chain state cannot be committed a second time.
		a := snapshot.Accounts[5]
		if a != nil && (a.Executable || a.Owner != solana.SystemProgramID || (a.Data != nil && len(a.Data.GetBinary()) != 0)) {
			return nil, empty, errors.New("Vault cycle already committed")
		}
		maxRent, _ := vaultCanonicalU64V1(v.MaxRentLamports, false)
		activation, _ := vaultCanonicalU64V1(v.ActivationGeneration, true)
		tx, err = m.prepareVaultCommitTransactionV1(walletID, bindingRequest, bindings, request, maxRent, blockhash, vaultSnapshotSubsetV1(snapshot, 4, 7, 8), rent, activation)
	} else if intent.Intent.Action == "reveal_vault_cycle" {
		tx, err = m.prepareVaultRevealTransactionV1(walletID, bindingRequest, bindings, request, vaultSnapshotSubsetV1(snapshot, 4, 5, 6), blockhash)
	} else {
		return nil, empty, errors.New("unsupported Vault review action")
	}
	return tx, vaultReviewReferenceV1{Scope: scope, Commitment: commitment, Reference: v.Reference, Blockhash: blockhash.String()}, err
}

func fetchVaultReviewSnapshotV1(urls []string, intent normalizedIntentV2) (signerOwnedAccountSnapshotV2, uint64, error) {
	var empty signerOwnedAccountSnapshotV2
	addresses, err := vaultReviewAddressesV1(intent)
	if err != nil {
		return empty, 0, err
	}
	witnesses, err := independentSATLookupRPCURLsV2(urls)
	if err != nil {
		return empty, 0, err
	}
	var first signerOwnedAccountSnapshotV2
	var firstRent uint64
	minimum, _ := vaultCanonicalU64V1(intent.Intent.VaultMining.MinFinalizedSlot, true)
	for i, url := range witnesses[:2] {
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		client := newSignerOwnedSolanaRPCClientV2(url)
		result, err := client.GetMultipleAccountsWithOpts(ctx, addresses, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized})
		if err != nil || result == nil || result.Context.Slot < minimum || len(result.Value) != len(addresses) {
			cancel()
			return empty, 0, errors.New("finalized Vault review snapshot unavailable")
		}
		rent, err := client.GetMinimumBalanceForRentExemption(ctx, 144, rpc.CommitmentFinalized)
		cancel()
		if err != nil || rent == 0 {
			return empty, 0, errors.New("Vault reserve rent unavailable")
		}
		digest, err := signerOwnedAccountSnapshotDigestV2(addresses, result.Value)
		if err != nil {
			return empty, 0, err
		}
		if i == 0 {
			first = signerOwnedAccountSnapshotV2{Slot: result.Context.Slot, Addresses: addresses, Accounts: result.Value, Digest: digest}
			firstRent = rent
		} else if digest != first.Digest || rent != firstRent {
			return empty, 0, errors.New("independent Vault state witnesses disagree; prepare again")
		}
	}
	return first, firstRent, nil
}

func (s *signerServiceV2) resolveVaultReviewV1(walletID string, intent normalizedIntentV2, previous *signerReviewV2) (jupiterValidatedTransactionV2, signerReviewArtifactInputV2, []string, error) {
	var result jupiterValidatedTransactionV2
	var artifact signerReviewArtifactInputV2
	// This lookup is deliberately disabled until finalized pins are delivered.
	release, err := signerVaultReleaseContextV1(intent.Intent.Cluster, solanaDevnetGenesisHashV2)
	if err != nil {
		return result, artifact, nil, err
	}
	urls, err := s.keys.SolanaRPCURLsV2(walletID)
	if err != nil {
		return result, artifact, nil, errSignerNetworkPendingV2
	}
	urls, err = solanaRPCURLsForClusterV2(urls, intent.Intent.Cluster)
	if err != nil {
		return result, artifact, nil, err
	}
	snapshot, rent, err := fetchVaultReviewSnapshotV1(urls, intent)
	if err != nil {
		return result, artifact, nil, err
	}
	var hash solana.Hash
	if previous != nil {
		old, err := normalizeStoredReviewArtifactV2(*previous)
		if err != nil || old.Kind != signerReviewArtifactVaultReferenceV1 || old.StateDigest != snapshot.Digest || snapshot.Slot < old.StateSlot {
			return result, artifact, nil, errors.New("Vault state changed after review")
		}
		hash, err = solana.HashFromBase58(old.VaultReference.Blockhash)
		if err != nil {
			return result, artifact, nil, err
		}
	} else {
		hash, err = signerLatestBlockhashWithFallbackV2(urls)
		if err != nil {
			return result, artifact, nil, err
		}
	}
	tx, reference, err := s.keys.prepareVaultReviewStateV1(walletID, intent, snapshot, release, rent, hash)
	if err != nil {
		return result, artifact, nil, err
	}
	artifact, err = vaultRevealReviewArtifactV1(reference, tx, snapshot.Digest, snapshot.Slot)
	if err != nil {
		return result, artifact, nil, err
	}
	if previous != nil && previous.ArtifactDigest != artifact.Digest {
		return result, artifact, nil, errors.New("Vault reconstruction changed reviewed bytes")
	}
	if err := simulateTypedTransferReviewV2(urls, tx); err != nil {
		return result, artifact, nil, errors.New("Vault transaction simulation failed")
	}
	if err := validateSignerNativeSpendV2(urls, tx, reference.Scope.Executor, intent); err != nil {
		return result, artifact, nil, err
	}
	if err := validateVaultNetworkFeeV1(urls, tx, intent.Intent.VaultMining.MaxFeeLamports); err != nil {
		return result, artifact, nil, err
	}
	raw, err := tx.MarshalBinary()
	if err != nil {
		return result, artifact, nil, err
	}
	return jupiterValidatedTransactionV2{Transaction: tx, RawUnsigned: raw, WalletSignerIndex: 0}, artifact, urls, nil
}

func validateVaultNetworkFeeV1(urls []string, tx *solana.Transaction, maximum string) error {
	cap, err := vaultCanonicalU64V1(maximum, true)
	if err != nil || tx == nil {
		return errors.New("invalid Vault network fee bound")
	}
	message, err := tx.Message.MarshalBinary()
	if err != nil {
		return err
	}
	defer zeroBytes(message)
	witnesses, err := independentSATLookupRPCURLsV2(urls)
	if err != nil {
		return err
	}
	for _, url := range witnesses[:2] {
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		fee, err := newSignerOwnedSolanaRPCClientV2(url).GetFeeForMessage(ctx, base64.StdEncoding.EncodeToString(message), rpc.CommitmentFinalized)
		cancel()
		if err != nil || fee == nil || fee.Value == nil || *fee.Value > cap {
			return errors.New("Vault network fee unavailable or exceeds reviewed cap")
		}
	}
	return nil
}
