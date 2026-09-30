package main

import (
	"context"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

type wenWithdrawalReadbackV1 struct {
	Slot, Now                                                    uint64
	Preview                                                      wenWithdrawalPreviewV1
	Pool, Position, Custody, Mint, Destination, Sale, Activation *signerWENBTCAccountV1
}

// Read-only. Pins must come from protected withdrawal admission before signing;
// matching identity hashes here does not validate descriptor capability semantics.
func readWENWithdrawalRPCV1(ctx context.Context, c signerWENBTCReadRPCV1, pins wenStakingPinsV1, v signerWENWithdrawalIntentV1, w solana.PublicKey, maxSlotLag uint64) (wenWithdrawalReadbackV1, error) {
	return readWENWithdrawalStateV1(ctx, c, pins, v, w, maxSlotLag, 0)
}
func readWENWithdrawalStateV1(ctx context.Context, c signerWENBTCReadRPCV1, pins wenStakingPinsV1, v signerWENWithdrawalIntentV1, w solana.PublicKey, maxSlotLag, observationSlot uint64) (wenWithdrawalReadbackV1, error) {
	var out wenWithdrawalReadbackV1
	bad := errors.New("withdrawal finalized readback rejected")
	ix, e := buildWENWithdrawalInstructionV1(v, w)
	if e != nil {
		return out, e
	}
	if pins.ProgramID != v.ProgramID || pins.Genesis != v.Genesis || pins.DescriptorSHA256 != v.DescriptorSHA256 || pins.CapabilitySHA256 != v.CapabilitySHA256 || pins.DeploymentSlot == 0 {
		return out, bad
	}
	if pins.UpgradeAuthority != nil {
		copy := *pins.UpgradeAuthority
		pins.UpgradeAuthority = &copy
	}
	min, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	expiry, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	if observationSlot > 0 {
		if observationSlot > min {
			min = observationSlot
		}
		expiry = ^uint64(0)
	}
	if min < pins.DeploymentSlot {
		return out, bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	genesis, e := c.GetGenesisHash(ctx)
	if e != nil {
		return out, e
	}
	if genesis.String() != pins.Genesis {
		return out, bad
	}
	p := ix.ProgramID()
	pd, _, e := solana.FindProgramAddress([][]byte{p[:]}, solana.BPFLoaderUpgradeableProgramID)
	if e != nil {
		return out, e
	}
	a := ix.Accounts()
	keys := []solana.PublicKey{a[3].PublicKey, a[4].PublicKey, a[5].PublicKey, a[6].PublicKey, a[7].PublicKey, a[1].PublicKey, a[2].PublicKey, p, pd, solana.SysVarClockPubkey}
	page, e := c.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &min})
	if e != nil {
		return out, e
	}
	if page == nil || len(page.Value) != len(keys) || page.Context.Slot < min || page.Context.Slot >= expiry {
		return out, bad
	}
	slot := page.Context.Slot
	accounts := make([]*signerWENBTCAccountV1, len(keys))
	for i, a := range page.Value {
		if a == nil || a.Data == nil {
			return out, bad
		}
		accounts[i] = &signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Executable: a.Executable, Slot: slot, Data: append([]byte(nil), a.Data.GetBinary()...)}
	}
	if e = verifyWENBTCDeploymentV1(signerWENBTCPinsV1{ProgramID: pins.ProgramID, DeploymentSlot: pins.DeploymentSlot, CodeSHA256: pins.CodeSHA256, UpgradeAuthority: pins.UpgradeAuthority}, slot, accounts[7], accounts[8]); e != nil {
		return out, e
	}
	clock := accounts[9]
	if clock.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || clock.Executable || len(clock.Data) != 40 || binary.LittleEndian.Uint64(clock.Data) != slot {
		return out, bad
	}
	now := binary.LittleEndian.Uint64(clock.Data[32:])
	if now > uint64(1<<63-1) {
		return out, bad
	}
	if e = validateWENStakingActivationV1(v.identity(), slot, now, accounts[5], accounts[6]); e != nil {
		return out, e
	}
	var preview wenWithdrawalPreviewV1
	if observationSlot == 0 {
		preview, e = previewWENWithdrawalV1(v, w, slot, now, accounts[0], accounts[1], accounts[3], accounts[2], accounts[4])
		if e != nil {
			return out, e
		}
	}
	reference, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return out, e
	}
	if reference < slot || reference-slot > maxSlotLag || reference >= expiry {
		return out, bad
	}
	after, e := c.GetGenesisHash(ctx)
	if e != nil {
		return out, e
	}
	if after != genesis {
		return out, bad
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	return wenWithdrawalReadbackV1{slot, now, preview, accounts[0], accounts[1], accounts[2], accounts[3], accounts[4], accounts[5], accounts[6]}, nil
}
