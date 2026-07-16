package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

const (
	vaultBondAccountHeaderSizeV2        = 8
	vaultBondPositionSizeV2             = 192
	vaultBondTierPolicySizeV2           = 144
	vaultBondStakingDistributorSizeV2   = 232
	vaultBondStakingPositionSizeV2      = 200
	vaultBondPositionDiscriminatorV2    = byte(140)
	vaultBondTierPolicyDiscriminatorV2  = byte(141)
	vaultBondDistributorDiscriminatorV2 = byte(142)
	vaultBondStakingDiscriminatorV2     = byte(143)
	splTokenAccountSizeV2               = 165
	splMintAccountSizeV2                = 82
)

type vaultBondPositionStateV2 struct {
	Version               byte
	Status                byte
	Tier                  byte
	Bump                  byte
	PolicyVersion         uint32
	Authority             solana.PublicKey
	BondMint              solana.PublicKey
	BondVault             solana.PublicKey
	AmountRaw             uint64
	CreatedAtSlot         uint64
	UpdatedAtSlot         uint64
	UnlockRequestedAtSlot uint64
	UnlockAvailableAtSlot uint64
}

type vaultBondTierPolicyStateV2 struct {
	Version                byte
	Bump                   byte
	PolicyVersion          uint64
	BasicMinimumRaw        uint64
	OperatorMinimumRaw     uint64
	UnlockDelaySlots       uint64
	ScheduledEffectiveSlot uint64
	LastUpdatedSlot        uint64
	UpdateAuthority        solana.PublicKey
}

type vaultBondStakingDistributorStateV2 struct {
	Version                byte
	Bump                   byte
	Status                 byte
	PolicyVersion          uint64
	RewardMint             solana.PublicKey
	RewardVault            solana.PublicKey
	UpdateAuthority        solana.PublicKey
	MinimumStakeRaw        uint64
	TotalActiveStakeRaw    uint64
	RewardIndexFP          *big.Int
	ObservedRewardVaultRaw uint64
	LastSyncedSlot         uint64
	UnallocatedRewardRaw   uint64
	FractionalRemainderRaw uint64
}

type vaultBondStakingPositionStateV2 struct {
	Version                byte
	Status                 byte
	Bump                   byte
	PolicyVersion          uint64
	Authority              solana.PublicKey
	BondPosition           solana.PublicKey
	ActiveStakeRaw         uint64
	ClaimableRewardRaw     uint64
	RewardDebtFP           *big.Int
	LastSyncedSlot         uint64
	FractionalRemainderRaw uint64
}

type splTokenAccountStateV2 struct {
	Mint   solana.PublicKey
	Owner  solana.PublicKey
	Amount uint64
}

type signerOwnedAccountSnapshotV2 struct {
	Slot      uint64
	Addresses []solana.PublicKey
	Accounts  []*rpc.Account
	Digest    string
}

type vaultBondResolvedEffectV2 struct {
	Action               string
	Asset                string
	Amount               *big.Int
	Destination          string
	StateDigest          string
	StateSlot            uint64
	RequiresStateRecheck bool
}

func strictVaultBondAccountDataV2(account *rpc.Account, owner solana.PublicKey, size int, discriminator byte, label string) ([]byte, error) {
	if account == nil || account.Data == nil {
		return nil, fmt.Errorf("%s account is missing", label)
	}
	if account.Executable || !account.Owner.Equals(owner) {
		return nil, fmt.Errorf("%s account owner/executable state is invalid", label)
	}
	data := account.Data.GetBinary()
	if len(data) != size {
		return nil, fmt.Errorf("%s account must contain exactly %d bytes", label, size)
	}
	if data[0] != discriminator {
		return nil, fmt.Errorf("%s account discriminator is invalid", label)
	}
	return data[vaultBondAccountHeaderSizeV2:], nil
}

func vaultBondReadPublicKeyV2(body []byte, offset int) solana.PublicKey {
	var key solana.PublicKey
	copy(key[:], body[offset:offset+32])
	return key
}

func vaultBondReadU128V2(body []byte, offset int) *big.Int {
	low := new(big.Int).SetUint64(binary.LittleEndian.Uint64(body[offset : offset+8]))
	high := new(big.Int).SetUint64(binary.LittleEndian.Uint64(body[offset+8 : offset+16]))
	high.Lsh(high, 64)
	return high.Add(high, low)
}

func validateVaultBondPDAAndBumpV2(address, program solana.PublicKey, bump byte, label string, seeds ...[]byte) error {
	expected, expectedBump, err := solana.FindProgramAddress(seeds, program)
	if err != nil {
		return fmt.Errorf("derive %s PDA: %w", label, err)
	}
	if !address.Equals(expected) || bump != expectedBump {
		return fmt.Errorf("%s address or bump does not match its canonical PDA", label)
	}
	return nil
}

func decodeVaultBondPositionStateV2(account *rpc.Account, address, program, wallet solana.PublicKey) (vaultBondPositionStateV2, error) {
	body, err := strictVaultBondAccountDataV2(account, program, vaultBondPositionSizeV2, vaultBondPositionDiscriminatorV2, "Vault bond position")
	if err != nil {
		return vaultBondPositionStateV2{}, err
	}
	state := vaultBondPositionStateV2{
		Version: body[0], Status: body[1], Tier: body[2], Bump: body[3],
		PolicyVersion: binary.LittleEndian.Uint32(body[4:8]),
		Authority:     vaultBondReadPublicKeyV2(body, 8), BondMint: vaultBondReadPublicKeyV2(body, 40),
		BondVault: vaultBondReadPublicKeyV2(body, 72), AmountRaw: binary.LittleEndian.Uint64(body[104:112]),
		CreatedAtSlot: binary.LittleEndian.Uint64(body[112:120]), UpdatedAtSlot: binary.LittleEndian.Uint64(body[120:128]),
		UnlockRequestedAtSlot: binary.LittleEndian.Uint64(body[128:136]), UnlockAvailableAtSlot: binary.LittleEndian.Uint64(body[136:144]),
	}
	if state.Version != 1 || state.Status > 3 || state.Tier > 2 || !state.Authority.Equals(wallet) || state.BondMint.IsZero() {
		return vaultBondPositionStateV2{}, errors.New("Vault bond position contains unsupported or mismatched state")
	}
	if err := validateVaultBondPDAAndBumpV2(address, program, state.Bump, "Vault bond position", []byte("sat_bond_position"), wallet[:]); err != nil {
		return vaultBondPositionStateV2{}, err
	}
	expectedVault, err := findAssociatedTokenAddressV2(address, state.BondMint, solana.TokenProgramID)
	if err != nil || !state.BondVault.Equals(expectedVault) {
		return vaultBondPositionStateV2{}, errors.New("Vault bond position stores a non-canonical SAT vault")
	}
	return state, nil
}

func decodeVaultBondTierPolicyStateV2(account *rpc.Account, address, program solana.PublicKey) (vaultBondTierPolicyStateV2, error) {
	body, err := strictVaultBondAccountDataV2(account, program, vaultBondTierPolicySizeV2, vaultBondTierPolicyDiscriminatorV2, "Vault bond tier policy")
	if err != nil {
		return vaultBondTierPolicyStateV2{}, err
	}
	state := vaultBondTierPolicyStateV2{
		Version: body[0], Bump: body[1], PolicyVersion: binary.LittleEndian.Uint64(body[8:16]),
		BasicMinimumRaw: binary.LittleEndian.Uint64(body[16:24]), OperatorMinimumRaw: binary.LittleEndian.Uint64(body[24:32]),
		UnlockDelaySlots: binary.LittleEndian.Uint64(body[32:40]), ScheduledEffectiveSlot: binary.LittleEndian.Uint64(body[40:48]),
		LastUpdatedSlot: binary.LittleEndian.Uint64(body[48:56]), UpdateAuthority: vaultBondReadPublicKeyV2(body, 56),
	}
	if state.Version != 1 || state.UpdateAuthority.IsZero() || state.BasicMinimumRaw == 0 || state.OperatorMinimumRaw < state.BasicMinimumRaw {
		return vaultBondTierPolicyStateV2{}, errors.New("Vault bond tier policy contains unsupported state")
	}
	if err := validateVaultBondPDAAndBumpV2(address, program, state.Bump, "Vault bond tier policy", []byte("sat_bond_tier_policy")); err != nil {
		return vaultBondTierPolicyStateV2{}, err
	}
	return state, nil
}

func decodeVaultBondStakingDistributorStateV2(account *rpc.Account, address, program solana.PublicKey) (vaultBondStakingDistributorStateV2, error) {
	body, err := strictVaultBondAccountDataV2(account, program, vaultBondStakingDistributorSizeV2, vaultBondDistributorDiscriminatorV2, "Vault bond staking distributor")
	if err != nil {
		return vaultBondStakingDistributorStateV2{}, err
	}
	state := vaultBondStakingDistributorStateV2{
		Version: body[0], Bump: body[1], Status: body[2], PolicyVersion: binary.LittleEndian.Uint64(body[8:16]),
		RewardMint: vaultBondReadPublicKeyV2(body, 16), RewardVault: vaultBondReadPublicKeyV2(body, 48),
		UpdateAuthority: vaultBondReadPublicKeyV2(body, 80), MinimumStakeRaw: binary.LittleEndian.Uint64(body[112:120]),
		TotalActiveStakeRaw: binary.LittleEndian.Uint64(body[120:128]), RewardIndexFP: vaultBondReadU128V2(body, 128),
		ObservedRewardVaultRaw: binary.LittleEndian.Uint64(body[144:152]), LastSyncedSlot: binary.LittleEndian.Uint64(body[152:160]),
		UnallocatedRewardRaw: binary.LittleEndian.Uint64(body[160:168]), FractionalRemainderRaw: binary.LittleEndian.Uint64(body[168:176]),
	}
	if state.Version != 1 || state.Status > 1 || state.RewardMint.IsZero() || state.UpdateAuthority.IsZero() {
		return vaultBondStakingDistributorStateV2{}, errors.New("Vault bond staking distributor contains unsupported state")
	}
	if err := validateVaultBondPDAAndBumpV2(address, program, state.Bump, "Vault bond staking distributor", []byte("sat_bond_staking_distributor")); err != nil {
		return vaultBondStakingDistributorStateV2{}, err
	}
	expectedVault, err := findAssociatedTokenAddressV2(address, state.RewardMint, solana.TokenProgramID)
	if err != nil || !state.RewardVault.Equals(expectedVault) {
		return vaultBondStakingDistributorStateV2{}, errors.New("Vault bond staking distributor stores a non-canonical reward vault")
	}
	return state, nil
}

func decodeVaultBondStakingPositionStateV2(account *rpc.Account, address, program, wallet, bondPosition solana.PublicKey) (vaultBondStakingPositionStateV2, error) {
	body, err := strictVaultBondAccountDataV2(account, program, vaultBondStakingPositionSizeV2, vaultBondStakingDiscriminatorV2, "Vault bond staking position")
	if err != nil {
		return vaultBondStakingPositionStateV2{}, err
	}
	state := vaultBondStakingPositionStateV2{
		Version: body[0], Status: body[1], Bump: body[2], PolicyVersion: binary.LittleEndian.Uint64(body[8:16]),
		Authority: vaultBondReadPublicKeyV2(body, 16), BondPosition: vaultBondReadPublicKeyV2(body, 48),
		ActiveStakeRaw: binary.LittleEndian.Uint64(body[80:88]), ClaimableRewardRaw: binary.LittleEndian.Uint64(body[88:96]),
		RewardDebtFP: vaultBondReadU128V2(body, 96), LastSyncedSlot: binary.LittleEndian.Uint64(body[112:120]),
		FractionalRemainderRaw: binary.LittleEndian.Uint64(body[120:128]),
	}
	if state.Version != 1 || state.Status > 1 || !state.Authority.Equals(wallet) || !state.BondPosition.Equals(bondPosition) {
		return vaultBondStakingPositionStateV2{}, errors.New("Vault bond staking position contains unsupported or mismatched state")
	}
	if err := validateVaultBondPDAAndBumpV2(address, program, state.Bump, "Vault bond staking position", []byte("sat_bond_staking_position"), wallet[:]); err != nil {
		return vaultBondStakingPositionStateV2{}, err
	}
	return state, nil
}

func decodeSPLTokenAccountStateV2(account *rpc.Account, expectedAddress, expectedMint, expectedOwner solana.PublicKey, label string) (splTokenAccountStateV2, error) {
	if account == nil || account.Data == nil || account.Executable || !account.Owner.Equals(solana.TokenProgramID) {
		return splTokenAccountStateV2{}, fmt.Errorf("%s is not an SPL Token account", label)
	}
	data := account.Data.GetBinary()
	if len(data) != splTokenAccountSizeV2 || data[108] == 0 {
		return splTokenAccountStateV2{}, fmt.Errorf("%s has an invalid SPL Token layout or state", label)
	}
	state := splTokenAccountStateV2{
		Mint: vaultBondReadPublicKeyV2(data, 0), Owner: vaultBondReadPublicKeyV2(data, 32),
		Amount: binary.LittleEndian.Uint64(data[64:72]),
	}
	if !state.Mint.Equals(expectedMint) || !state.Owner.Equals(expectedOwner) {
		return splTokenAccountStateV2{}, fmt.Errorf("%s mint or owner does not match reviewed semantics", label)
	}
	expectedATA, err := findAssociatedTokenAddressV2(expectedOwner, expectedMint, solana.TokenProgramID)
	if err != nil || !expectedAddress.Equals(expectedATA) {
		return splTokenAccountStateV2{}, fmt.Errorf("%s is not the canonical associated token account", label)
	}
	return state, nil
}

func validateVaultBondMintAccountV2(account *rpc.Account, expectedMint solana.PublicKey) error {
	if account == nil || account.Data == nil || account.Executable || !account.Owner.Equals(solana.TokenProgramID) {
		return errors.New("Vault bond SAT mint owner/executable state is invalid")
	}
	data := account.Data.GetBinary()
	if len(data) != splMintAccountSizeV2 || data[45] == 0 || expectedMint.IsZero() {
		return errors.New("Vault bond SAT mint layout or initialization state is invalid")
	}
	return nil
}

func signerOwnedAccountSnapshotDigestV2(addresses []solana.PublicKey, accounts []*rpc.Account) (string, error) {
	if len(addresses) == 0 || len(addresses) != len(accounts) {
		return "", errors.New("signer-owned account snapshot is incomplete")
	}
	hash := sha256.New()
	for index, address := range addresses {
		account := accounts[index]
		hash.Write(address[:])
		if account == nil {
			// Missing accounts are meaningful for create-style instructions. Bind
			// the absence so execute rejects an account created after review.
			hash.Write([]byte{0})
			continue
		}
		hash.Write([]byte{1})
		if account.Data == nil {
			return "", fmt.Errorf("signer-owned account snapshot has invalid data for %s", address)
		}
		data := account.Data.GetBinary()
		hash.Write(account.Owner[:])
		var number [8]byte
		binary.LittleEndian.PutUint64(number[:], account.Lamports)
		hash.Write(number[:])
		if account.Executable {
			hash.Write([]byte{1})
		} else {
			hash.Write([]byte{0})
		}
		binary.LittleEndian.PutUint64(number[:], uint64(len(data)))
		hash.Write(number[:])
		hash.Write(data)
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}

// fetchVaultBondAccountSnapshotV2 reads all review inputs at one confirmed RPC
// context slot after independently verifying that the signer-owned endpoint is
// on the requested cluster. The digest excludes the context slot so execute can
// require the exact account bytes to remain unchanged at a later slot.
func fetchVaultBondAccountSnapshotV2(rpcURLs []string, cluster string, addresses []solana.PublicKey) (signerOwnedAccountSnapshotV2, error) {
	if len(addresses) == 0 || len(addresses) > 16 {
		return signerOwnedAccountSnapshotV2{}, errors.New("Vault bond snapshot requires one to sixteen exact accounts")
	}
	verified, err := solanaRPCURLsForClusterV2(rpcURLs, cluster)
	if err != nil {
		return signerOwnedAccountSnapshotV2{}, err
	}
	for _, rpcURL := range verified {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		result, requestErr := client.GetMultipleAccountsWithOpts(ctx, addresses, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentConfirmed})
		cancel()
		if requestErr != nil || result == nil || len(result.Value) != len(addresses) {
			if requestErr == nil {
				requestErr = errors.New("signer-owned account snapshot RPC response length mismatch")
			}
			markSolanaWriteRPCFailure(rpcURL, requestErr)
			continue
		}
		digest, digestErr := signerOwnedAccountSnapshotDigestV2(addresses, result.Value)
		if digestErr != nil {
			return signerOwnedAccountSnapshotV2{}, digestErr
		}
		markSolanaWriteRPCSuccess(rpcURL)
		return signerOwnedAccountSnapshotV2{Slot: result.Context.Slot, Addresses: append([]solana.PublicKey(nil), addresses...), Accounts: result.Value, Digest: digest}, nil
	}
	return signerOwnedAccountSnapshotV2{}, errors.New("Vault bond signer-owned account snapshot failed")
}

func vaultBondSnapshotMapV2(snapshot signerOwnedAccountSnapshotV2) map[string]*rpc.Account {
	result := make(map[string]*rpc.Account, len(snapshot.Addresses))
	for index, address := range snapshot.Addresses {
		result[address.String()] = snapshot.Accounts[index]
	}
	return result
}

func vaultBondFinalizeSnapshotAddressesV2(instruction normalizedSATInstructionV2) ([]solana.PublicKey, error) {
	if instruction.Codec.Action != "finalizeBondUnlock" || instruction.Codec.Family != satFamilyBond || len(instruction.Accounts) != 11 {
		return nil, errors.New("Vault bond finalization snapshot requires the typed finalizeBondUnlock codec")
	}
	addresses := make([]solana.PublicKey, 0, 7)
	for index := 1; index <= 7; index++ {
		addresses = append(addresses, instruction.Accounts[index].PublicKey)
	}
	return addresses, nil
}

func resolveVaultBondFinalizeEffectFromRPCV2(rpcURLs []string, cluster string, instruction normalizedSATInstructionV2, wallet solana.PublicKey) (vaultBondResolvedEffectV2, error) {
	addresses, err := vaultBondFinalizeSnapshotAddressesV2(instruction)
	if err != nil {
		return vaultBondResolvedEffectV2{}, err
	}
	snapshot, err := fetchVaultBondAccountSnapshotV2(rpcURLs, cluster, addresses)
	if err != nil {
		return vaultBondResolvedEffectV2{}, err
	}
	return resolveVaultBondFinalizeEffectV2(instruction, wallet, snapshot)
}

// resolveVaultBondFinalizeEffectV2 proves the exact SAT amount returned by a
// finalize-unlock instruction. A reviewed execute must fetch this snapshot
// again and require the same digest immediately before signing.
func resolveVaultBondFinalizeEffectV2(instruction normalizedSATInstructionV2, wallet solana.PublicKey, snapshot signerOwnedAccountSnapshotV2) (vaultBondResolvedEffectV2, error) {
	if instruction.Codec.Action != "finalizeBondUnlock" || instruction.Codec.Family != satFamilyBond || len(instruction.Accounts) != 11 {
		return vaultBondResolvedEffectV2{}, errors.New("exact Vault bond finalization requires the typed finalizeBondUnlock codec")
	}
	if snapshot.Digest == "" || !strings.HasPrefix(snapshot.Digest, "sha256:") {
		return vaultBondResolvedEffectV2{}, errors.New("exact Vault bond finalization requires a signer-owned account snapshot")
	}
	accounts := vaultBondSnapshotMapV2(snapshot)
	accountAt := func(index int) *rpc.Account { return accounts[instruction.Accounts[index].PublicKey.String()] }
	program := instruction.Program
	policy, err := decodeVaultBondTierPolicyStateV2(accountAt(1), instruction.Accounts[1].PublicKey, program)
	if err != nil {
		return vaultBondResolvedEffectV2{}, err
	}
	position, err := decodeVaultBondPositionStateV2(accountAt(2), instruction.Accounts[2].PublicKey, program, wallet)
	if err != nil {
		return vaultBondResolvedEffectV2{}, err
	}
	distributor, err := decodeVaultBondStakingDistributorStateV2(accountAt(3), instruction.Accounts[3].PublicKey, program)
	if err != nil {
		return vaultBondResolvedEffectV2{}, err
	}
	staking, err := decodeVaultBondStakingPositionStateV2(accountAt(4), instruction.Accounts[4].PublicKey, program, wallet, instruction.Accounts[2].PublicKey)
	if err != nil {
		return vaultBondResolvedEffectV2{}, err
	}
	mint := instruction.Accounts[7].PublicKey
	if !position.BondMint.Equals(mint) || !distributor.RewardMint.Equals(mint) || position.PolicyVersion != uint32(policy.PolicyVersion) || staking.PolicyVersion != policy.PolicyVersion || distributor.PolicyVersion != policy.PolicyVersion {
		return vaultBondResolvedEffectV2{}, errors.New("Vault bond finalization account policy/mint versions do not agree")
	}
	if err := validateVaultBondMintAccountV2(accountAt(7), mint); err != nil {
		return vaultBondResolvedEffectV2{}, err
	}
	bondVault, err := decodeSPLTokenAccountStateV2(accountAt(5), instruction.Accounts[5].PublicKey, mint, instruction.Accounts[2].PublicKey, "Vault bond escrow")
	if err != nil {
		return vaultBondResolvedEffectV2{}, err
	}
	if _, err := decodeSPLTokenAccountStateV2(accountAt(6), instruction.Accounts[6].PublicKey, mint, wallet, "Vault bond recipient"); err != nil {
		return vaultBondResolvedEffectV2{}, err
	}
	if !position.BondVault.Equals(instruction.Accounts[5].PublicKey) || position.Status != 2 || position.AmountRaw == 0 || position.UnlockAvailableAtSlot == 0 || snapshot.Slot < position.UnlockAvailableAtSlot || staking.ActiveStakeRaw != 0 || bondVault.Amount < position.AmountRaw {
		return vaultBondResolvedEffectV2{}, errors.New("Vault bond finalization is not ready for the exact reviewed amount")
	}
	return vaultBondResolvedEffectV2{
		Action: "finalizeBondUnlock", Asset: "solana:spl:" + mint.String(),
		Amount: new(big.Int).SetUint64(position.AmountRaw), Destination: wallet.String(),
		StateDigest: snapshot.Digest, StateSlot: snapshot.Slot, RequiresStateRecheck: true,
	}, nil
}

func requireExactVaultBondClaimEffectV2(action string) error {
	switch strings.TrimSpace(action) {
	case "claimBondStakingRewards", "claimUnallocatedStakingRewards":
		return errors.New("Vault bond reward claim is unavailable until the instruction binds an exact signer-reviewed amount and authoritative state version")
	default:
		return nil
	}
}
