package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

// Finalized historical accounting and token custody readback; no signing.
// Identity pins and policy/USDC must come from protected launch admission.
func readWENBTCClaimHistoryRPCV1(ctx context.Context, c signerWENBTCReadRPCV1, pins wenStakingPinsV1, v signerWENBTCClaimIntentV1, owner, policy, usdc solana.PublicKey, maxSlotLag uint64) (wenBTCClaimAllocationV1, error) {
	var zero wenBTCClaimAllocationV1
	bad := errors.New("BTC claim finalized history rejected")
	ix, e := buildWENBTCClaimInstructionV1(v, owner)
	if e != nil {
		return zero, e
	}
	if pins.ProgramID != v.ProgramID || pins.Genesis != v.Genesis || pins.DescriptorSHA256 != v.DescriptorSHA256 || pins.CapabilitySHA256 != v.CapabilitySHA256 || pins.DeploymentSlot == 0 {
		return zero, bad
	}
	if pins.UpgradeAuthority != nil {
		x := *pins.UpgradeAuthority
		pins.UpgradeAuthority = &x
	}
	min, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	expiry, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	if min < pins.DeploymentSlot {
		return zero, bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	genesis, e := c.GetGenesisHash(ctx)
	if e != nil {
		return zero, e
	}
	if genesis.String() != pins.Genesis {
		return zero, bad
	}
	p := ix.ProgramID()
	pd, _, e := solana.FindProgramAddress([][]byte{p[:]}, solana.BPFLoaderUpgradeableProgramID)
	if e != nil {
		return zero, e
	}
	keys := []solana.PublicKey{}
	for _, i := range []int{3, 4, 5, 6, 7, 8} {
		keys = append(keys, ix.Accounts()[i].PublicKey)
	}
	keys = append(keys, p, pd, solana.SysVarClockPubkey)
	for _, i := range []int{12, 9, 10, 14, 1, 2} {
		keys = append(keys, ix.Accounts()[i].PublicKey)
	}
	page, e := c.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &min})
	if e != nil {
		return zero, e
	}
	if page == nil || len(page.Value) != len(keys) || page.Context.Slot < min || page.Context.Slot >= expiry {
		return zero, bad
	}
	slot := page.Context.Slot
	accounts := make([]*signerWENBTCAccountV1, len(keys))
	for i, a := range page.Value {
		if a == nil {
			if i == 4 || i == 5 {
				continue
			}
			return zero, bad
		}
		if a.Data == nil {
			return zero, bad
		}
		accounts[i] = &signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Executable: a.Executable, Slot: slot, Data: append([]byte(nil), a.Data.GetBinary()...)}
	}
	if e = verifyWENBTCDeploymentV1(signerWENBTCPinsV1{ProgramID: pins.ProgramID, DeploymentSlot: pins.DeploymentSlot, CodeSHA256: pins.CodeSHA256, UpgradeAuthority: pins.UpgradeAuthority}, slot, accounts[6], accounts[7]); e != nil {
		return zero, e
	}
	clock := accounts[8]
	if clock.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || clock.Executable || len(clock.Data) != 40 || binary.LittleEndian.Uint64(clock.Data) != slot {
		return zero, bad
	}
	allocation, e := validateWENBTCClaimHistoryV1(v, owner, policy, usdc, wenBTCClaimHistoryV1{Slot: slot, Now: binary.LittleEndian.Uint64(clock.Data[32:]), Funding: accounts[0], Cohort: accounts[1], History: accounts[2], Settlement: accounts[3], Fallback: accounts[4], Paid: accounts[5]})
	if e != nil {
		return zero, e
	}
	if e = validateWENBTCClaimCustodyV1(v, owner, slot, allocation, accounts[9], accounts[10], accounts[11], accounts[12]); e != nil {
		return zero, e
	}
	if e = validateWENLaunchActivationV1(p, solana.MustPublicKeyFromBase58(v.Sale), slot, binary.LittleEndian.Uint64(clock.Data[32:]), accounts[13], accounts[14]); e != nil {
		return zero, e
	}
	reference, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return zero, e
	}
	if reference < slot || reference-slot > maxSlotLag || reference >= expiry {
		return zero, bad
	}
	after, e := c.GetGenesisHash(ctx)
	if e != nil {
		return zero, e
	}
	if after != genesis {
		return zero, bad
	}
	if e = ctx.Err(); e != nil {
		return zero, e
	}
	// Bind every account except Clock, whose validated slot/time may advance.
	hash := sha256.New()
	for i, a := range accounts {
		if i == 8 {
			continue
		}
		if a == nil {
			hash.Write([]byte{0})
			continue
		}
		hash.Write([]byte{1})
		hash.Write(a.Address[:])
		hash.Write(a.Owner[:])
		if a.Executable {
			hash.Write([]byte{1})
		} else {
			hash.Write([]byte{0})
		}
		var size [8]byte
		binary.LittleEndian.PutUint64(size[:], uint64(len(a.Data)))
		hash.Write(size[:])
		hash.Write(a.Data)
	}
	allocation.Slot = slot
	allocation.StateHash = hex.EncodeToString(hash.Sum(nil))
	return allocation, nil
}
