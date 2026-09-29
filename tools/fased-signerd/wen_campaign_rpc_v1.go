package main

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenCampaignReadRPCV1 interface {
	signerWENBTCReadRPCV1
	GetMinimumBalanceForRentExemption(context.Context, uint64, rpc.CommitmentType) (uint64, error)
}

// Signer-owned pins/client only. A read creates no permission to sign or spend.
func readWENCampaignOwnerV1(ctx context.Context, client wenCampaignReadRPCV1, pins signerWENBTCPinsV1, v wenCampaignOwnerActionV1, wallet solana.PublicKey, min, expires, maxSlotLag uint64) (wenCampaignPositionV1, error) {
	var out wenCampaignPositionV1
	bad := errors.New("campaign finalized readback rejected")
	if pins.ProgramID != v.Program.String() || pins.DeploymentSlot == 0 || min < pins.DeploymentSlot || expires <= min || expires-min > 32 || maxSlotLag == 0 || maxSlotLag > 32 || !wenReservationHashV1(pins.CodeSHA256) {
		return out, bad
	}
	if pins.UpgradeAuthority != nil {
		x := *pins.UpgradeAuthority
		pins.UpgradeAuthority = &x
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	genesis, err := client.GetGenesisHash(ctx)
	if err != nil {
		return out, err
	}
	if genesis.String() != pins.Genesis {
		return out, bad
	}
	program := solana.MustPublicKeyFromBase58(v.Program.String())
	loader := solana.MustPublicKeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")
	pd, _, err := solana.FindProgramAddress([][]byte{program[:]}, loader)
	if err != nil {
		return out, err
	}
	keys := []solana.PublicKey{solana.MustPublicKeyFromBase58(v.Position.String()), program, pd, solana.MustPublicKeyFromBase58("SysvarC1ock11111111111111111111111111111111")}
	if v.Operation == "policy" {
		if v.Policy == nil {
			return out, bad
		}
		keys = append(keys, v.Policy.Window)
	}
	for i, k := range keys {
		for _, earlier := range keys[:i] {
			if k == earlier {
				return out, bad
			}
		}
	}
	page, err := client.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &min})
	if err != nil {
		return out, err
	}
	if page == nil || len(page.Value) != len(keys) || page.Context.Slot < min || page.Context.Slot >= expires {
		return out, bad
	}
	slot := page.Context.Slot
	accounts := make([]*signerWENBTCAccountV1, len(keys))
	for i, a := range page.Value {
		if a == nil || a.Data == nil {
			return out, bad
		}
		accounts[i] = &signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Slot: slot, Executable: a.Executable, Data: append([]byte(nil), a.Data.GetBinary()...)}
	}
	// Shared Solana loader verification has no BTC custody assumptions.
	if err := verifyWENBTCDeploymentV1(signerWENBTCPinsV1{ProgramID: v.Program.String(), DeploymentSlot: pins.DeploymentSlot, CodeSHA256: pins.CodeSHA256, UpgradeAuthority: pins.UpgradeAuthority}, slot, accounts[1], accounts[2]); err != nil {
		return out, err
	}
	clock := accounts[3]
	if clock.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || clock.Executable || len(clock.Data) != 40 || binary.LittleEndian.Uint64(clock.Data) != slot {
		return out, bad
	}
	now := binary.LittleEndian.Uint64(clock.Data[32:])
	if now > uint64(1<<63-1) {
		return out, bad
	}
	rent, err := client.GetMinimumBalanceForRentExemption(ctx, 256, rpc.CommitmentFinalized)
	if err != nil {
		return out, err
	}
	entry := accounts[0]
	candidate := wenCampaignPositionV1{Address: entry.Address, Owner: entry.Owner, Executable: entry.Executable, Data: entry.Data, Lamports: page.Value[0].Lamports, Rent: rent}
	if v.Operation == "policy" {
		w := accounts[4]
		candidate.Now = now
		candidate.PolicyWindow = &wenCampaignSetupAccountV1{Address: w.Address, Owner: w.Owner, Executable: w.Executable, Data: w.Data, Lamports: page.Value[4].Lamports}
	}
	if _, err := buildWENCampaignOwnerV1(v, wallet, candidate); err != nil {
		return out, err
	}
	var issuer, window solana.PublicKey
	copy(issuer[:], candidate.Data[48:80])
	copy(window[:], candidate.Data[192:224])
	accountingHash, err := readWENCampaignAccountingV1(ctx, client, program, v.Economy, issuer, window, solana.PublicKey(candidate.Data[80:112]), slot, expires)
	if err != nil {
		return out, err
	}
	candidate.AccountingSHA256 = hex.EncodeToString(accountingHash[:])
	reference, err := client.GetSlot(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return out, err
	}
	if reference < slot || reference-slot > maxSlotLag || reference >= expires {
		return out, bad
	}
	after, err := client.GetGenesisHash(ctx)
	if err != nil {
		return out, err
	}
	if after != genesis {
		return out, bad
	}
	if err := ctx.Err(); err != nil {
		return out, err
	}
	candidate.Slot = slot
	candidate.ReferenceSlot = reference
	return candidate, nil
}
