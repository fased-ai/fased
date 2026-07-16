package main

import (
	"encoding/binary"
	"math/big"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type vaultBondRPCFixtureV2 struct {
	wallet, program, mint, policy, position, distributor, staking, bondVault, recipient solana.PublicKey
	instruction                                                                         normalizedSATInstructionV2
	snapshot                                                                            signerOwnedAccountSnapshotV2
}

func vaultBondTestAccountV2(owner solana.PublicKey, data []byte) *rpc.Account {
	return &rpc.Account{Lamports: 2_039_280, Owner: owner, Data: rpc.DataBytesOrJSONFromBytes(data)}
}

func vaultBondTestPDA(t *testing.T, program solana.PublicKey, seeds ...[]byte) (solana.PublicKey, byte) {
	t.Helper()
	address, bump, err := solana.FindProgramAddress(seeds, program)
	if err != nil {
		t.Fatal(err)
	}
	return address, bump
}

func putVaultBondKeyV2(data []byte, offset int, key solana.PublicKey) {
	copy(data[offset:offset+32], key[:])
}

func splTokenTestAccountV2(mint, owner solana.PublicKey, amount uint64) *rpc.Account {
	data := make([]byte, splTokenAccountSizeV2)
	putVaultBondKeyV2(data, 0, mint)
	putVaultBondKeyV2(data, 32, owner)
	binary.LittleEndian.PutUint64(data[64:72], amount)
	data[108] = 1
	return vaultBondTestAccountV2(solana.TokenProgramID, data)
}

func cloneRPCAccountV2(account *rpc.Account) *rpc.Account {
	if account == nil {
		return nil
	}
	copyAccount := *account
	if account.Data != nil {
		copyAccount.Data = rpc.DataBytesOrJSONFromBytes(append([]byte(nil), account.Data.GetBinary()...))
	}
	return &copyAccount
}

func makeVaultBondRPCFixtureV2(t *testing.T) vaultBondRPCFixtureV2 {
	t.Helper()
	wallet, program, mint := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	policy, policyBump := vaultBondTestPDA(t, program, []byte("sat_bond_tier_policy"))
	position, positionBump := vaultBondTestPDA(t, program, []byte("sat_bond_position"), wallet[:])
	distributor, distributorBump := vaultBondTestPDA(t, program, []byte("sat_bond_staking_distributor"))
	staking, stakingBump := vaultBondTestPDA(t, program, []byte("sat_bond_staking_position"), wallet[:])
	bondVault, err := findAssociatedTokenAddressV2(position, mint, solana.TokenProgramID)
	if err != nil {
		t.Fatal(err)
	}
	recipient, err := findAssociatedTokenAddressV2(wallet, mint, solana.TokenProgramID)
	if err != nil {
		t.Fatal(err)
	}
	rewardVault, err := findAssociatedTokenAddressV2(distributor, mint, solana.TokenProgramID)
	if err != nil {
		t.Fatal(err)
	}
	updateAuthority := solana.NewWallet().PublicKey()

	policyData := make([]byte, vaultBondTierPolicySizeV2)
	policyData[0] = vaultBondTierPolicyDiscriminatorV2
	policyBody := policyData[vaultBondAccountHeaderSizeV2:]
	policyBody[0], policyBody[1] = 1, policyBump
	binary.LittleEndian.PutUint64(policyBody[8:16], 7)
	binary.LittleEndian.PutUint64(policyBody[16:24], 25)
	binary.LittleEndian.PutUint64(policyBody[24:32], 50)
	binary.LittleEndian.PutUint64(policyBody[32:40], 10)
	putVaultBondKeyV2(policyBody, 56, updateAuthority)

	positionData := make([]byte, vaultBondPositionSizeV2)
	positionData[0] = vaultBondPositionDiscriminatorV2
	positionBody := positionData[vaultBondAccountHeaderSizeV2:]
	positionBody[0], positionBody[1], positionBody[2], positionBody[3] = 1, 2, 1, positionBump
	binary.LittleEndian.PutUint32(positionBody[4:8], 7)
	putVaultBondKeyV2(positionBody, 8, wallet)
	putVaultBondKeyV2(positionBody, 40, mint)
	putVaultBondKeyV2(positionBody, 72, bondVault)
	binary.LittleEndian.PutUint64(positionBody[104:112], 75)
	binary.LittleEndian.PutUint64(positionBody[128:136], 80)
	binary.LittleEndian.PutUint64(positionBody[136:144], 90)

	distributorData := make([]byte, vaultBondStakingDistributorSizeV2)
	distributorData[0] = vaultBondDistributorDiscriminatorV2
	distributorBody := distributorData[vaultBondAccountHeaderSizeV2:]
	distributorBody[0], distributorBody[1], distributorBody[2] = 1, distributorBump, 1
	binary.LittleEndian.PutUint64(distributorBody[8:16], 7)
	putVaultBondKeyV2(distributorBody, 16, mint)
	putVaultBondKeyV2(distributorBody, 48, rewardVault)
	putVaultBondKeyV2(distributorBody, 80, updateAuthority)
	binary.LittleEndian.PutUint64(distributorBody[112:120], 1)

	stakingData := make([]byte, vaultBondStakingPositionSizeV2)
	stakingData[0] = vaultBondStakingDiscriminatorV2
	stakingBody := stakingData[vaultBondAccountHeaderSizeV2:]
	stakingBody[0], stakingBody[1], stakingBody[2] = 1, 1, stakingBump
	binary.LittleEndian.PutUint64(stakingBody[8:16], 7)
	putVaultBondKeyV2(stakingBody, 16, wallet)
	putVaultBondKeyV2(stakingBody, 48, position)

	mintData := make([]byte, splMintAccountSizeV2)
	mintData[44], mintData[45] = 9, 1
	addresses := []solana.PublicKey{policy, position, distributor, staking, bondVault, recipient, mint}
	accounts := []*rpc.Account{
		vaultBondTestAccountV2(program, policyData), vaultBondTestAccountV2(program, positionData),
		vaultBondTestAccountV2(program, distributorData), vaultBondTestAccountV2(program, stakingData),
		splTokenTestAccountV2(mint, position, 75), splTokenTestAccountV2(mint, wallet, 12),
		vaultBondTestAccountV2(solana.TokenProgramID, mintData),
	}
	digest, err := signerOwnedAccountSnapshotDigestV2(addresses, accounts)
	if err != nil {
		t.Fatal(err)
	}
	metas := solana.AccountMetaSlice{
		&solana.AccountMeta{PublicKey: wallet, IsSigner: true, IsWritable: true},
		&solana.AccountMeta{PublicKey: policy},
		&solana.AccountMeta{PublicKey: position, IsWritable: true},
		&solana.AccountMeta{PublicKey: distributor, IsWritable: true},
		&solana.AccountMeta{PublicKey: staking, IsWritable: true},
		&solana.AccountMeta{PublicKey: bondVault, IsWritable: true},
		&solana.AccountMeta{PublicKey: recipient, IsWritable: true},
		&solana.AccountMeta{PublicKey: mint, IsWritable: true},
		&solana.AccountMeta{PublicKey: solana.SystemProgramID},
		&solana.AccountMeta{PublicKey: solana.TokenProgramID},
		&solana.AccountMeta{PublicKey: solana.SPLAssociatedTokenAccountProgramID},
	}
	return vaultBondRPCFixtureV2{
		wallet: wallet, program: program, mint: mint, policy: policy, position: position,
		distributor: distributor, staking: staking, bondVault: bondVault, recipient: recipient,
		instruction: normalizedSATInstructionV2{
			Program: program, Data: []byte{6}, Accounts: metas, Codec: signerSATCodecsV2["finalizeBondUnlock"],
		},
		snapshot: signerOwnedAccountSnapshotV2{Slot: 100, Addresses: addresses, Accounts: accounts, Digest: digest},
	}
}

func TestSignerV2VaultBondRPCDecodersRejectOwnerShapePDAAndVaultMutation(t *testing.T) {
	fixture := makeVaultBondRPCFixtureV2(t)
	position, err := decodeVaultBondPositionStateV2(fixture.snapshot.Accounts[1], fixture.position, fixture.program, fixture.wallet)
	if err != nil || position.AmountRaw != 75 || !position.BondMint.Equals(fixture.mint) {
		t.Fatalf("decode valid Vault bond position: %#v err=%v", position, err)
	}

	tests := []struct {
		name   string
		mutate func(account *rpc.Account)
		want   string
	}{
		{name: "owner", mutate: func(account *rpc.Account) { account.Owner = solana.SystemProgramID }, want: "owner/executable"},
		{name: "length", mutate: func(account *rpc.Account) {
			account.Data = rpc.DataBytesOrJSONFromBytes(account.Data.GetBinary()[:100])
		}, want: "exactly 192"},
		{name: "discriminator", mutate: func(account *rpc.Account) {
			data := append([]byte(nil), account.Data.GetBinary()...)
			data[0]++
			account.Data = rpc.DataBytesOrJSONFromBytes(data)
		}, want: "discriminator"},
		{name: "stored vault", mutate: func(account *rpc.Account) {
			data := append([]byte(nil), account.Data.GetBinary()...)
			putVaultBondKeyV2(data[vaultBondAccountHeaderSizeV2:], 72, solana.NewWallet().PublicKey())
			account.Data = rpc.DataBytesOrJSONFromBytes(data)
		}, want: "non-canonical SAT vault"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			account := cloneRPCAccountV2(fixture.snapshot.Accounts[1])
			test.mutate(account)
			_, err := decodeVaultBondPositionStateV2(account, fixture.position, fixture.program, fixture.wallet)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected %q rejection, got %v", test.want, err)
			}
		})
	}
	wrongAddress := solana.NewWallet().PublicKey()
	if _, err := decodeVaultBondPositionStateV2(fixture.snapshot.Accounts[1], wrongAddress, fixture.program, fixture.wallet); err == nil || !strings.Contains(err.Error(), "canonical PDA") {
		t.Fatalf("wrong bond PDA was accepted: %v", err)
	}
}

func TestSignerV2VaultBondFinalizeResolutionBindsExactState(t *testing.T) {
	fixture := makeVaultBondRPCFixtureV2(t)
	effect, err := resolveVaultBondFinalizeEffectV2(fixture.instruction, fixture.wallet, fixture.snapshot)
	if err != nil {
		t.Fatalf("resolve exact Vault bond finalization: %v", err)
	}
	if effect.Action != "finalizeBondUnlock" || effect.Asset != "solana:spl:"+fixture.mint.String() || effect.Amount.Cmp(big.NewInt(75)) != 0 || effect.Destination != fixture.wallet.String() || !effect.RequiresStateRecheck || effect.StateDigest != fixture.snapshot.Digest || effect.StateSlot != 100 {
		t.Fatalf("unexpected exact Vault bond finalization effect: %#v", effect)
	}
	addresses, err := vaultBondFinalizeSnapshotAddressesV2(fixture.instruction)
	if err != nil || len(addresses) != 7 || !addresses[0].Equals(fixture.policy) || !addresses[6].Equals(fixture.mint) {
		t.Fatalf("unexpected finalization snapshot address set: %v err=%v", addresses, err)
	}

	mutated := fixture.snapshot
	mutated.Accounts = append([]*rpc.Account(nil), fixture.snapshot.Accounts...)
	mutated.Accounts[4] = splTokenTestAccountV2(fixture.mint, fixture.position, 74)
	mutated.Digest, _ = signerOwnedAccountSnapshotDigestV2(mutated.Addresses, mutated.Accounts)
	if mutated.Digest == fixture.snapshot.Digest {
		t.Fatal("mutated account bytes did not change signer-owned state digest")
	}
	if _, err := resolveVaultBondFinalizeEffectV2(fixture.instruction, fixture.wallet, mutated); err == nil || !strings.Contains(err.Error(), "not ready") {
		t.Fatalf("underfunded bond vault was accepted: %v", err)
	}

	wrongMint := fixture.snapshot
	wrongMint.Accounts = append([]*rpc.Account(nil), fixture.snapshot.Accounts...)
	wrongMint.Accounts[4] = splTokenTestAccountV2(solana.NewWallet().PublicKey(), fixture.position, 75)
	wrongMint.Digest, _ = signerOwnedAccountSnapshotDigestV2(wrongMint.Addresses, wrongMint.Accounts)
	if _, err := resolveVaultBondFinalizeEffectV2(fixture.instruction, fixture.wallet, wrongMint); err == nil || !strings.Contains(err.Error(), "mint or owner") {
		t.Fatalf("wrong token mint was accepted: %v", err)
	}
}

func TestSignerV2VaultBondDynamicClaimsFailClosed(t *testing.T) {
	for _, action := range []string{"claimBondStakingRewards", "claimUnallocatedStakingRewards"} {
		if err := requireExactVaultBondClaimEffectV2(action); err == nil || !strings.Contains(err.Error(), "exact signer-reviewed amount") {
			t.Fatalf("dynamic claim %s did not fail closed: %v", action, err)
		}
	}
	if err := requireExactVaultBondClaimEffectV2("requestBondUnlock"); err != nil {
		t.Fatalf("non-claim mutation was incorrectly rejected by claim guard: %v", err)
	}
}
