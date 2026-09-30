package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"math"
	"strconv"
)

type wenMiningFundingReadbackV1 struct {
	Slot, Now, OwnerLamports uint64
	StateHash                string
}

// Signer-owned pins and client only. Descriptor validation precedes this read;
// this function independently verifies the live program and all custody records.
func readWENMiningFundingRPCV1(ctx context.Context, c signerWENBTCReadRPCV1, pins wenStakingPinsV1, v signerWENMiningFundingIntentV1, owner solana.PublicKey, maxSlotLag uint64) (wenMiningFundingReadbackV1, error) {
	var zero wenMiningFundingReadbackV1
	bad := errors.New("funding finalized snapshot rejected")
	ix, e := buildWENMiningFundingInstructionV1(v, owner)
	if e != nil {
		return zero, e
	}
	if pins.ProgramID != v.ProgramID || pins.Genesis != v.Genesis || pins.DescriptorSHA256 != v.DescriptorSHA256 || pins.CapabilitySHA256 != v.CapabilitySHA256 || pins.DeploymentSlot == 0 {
		return zero, bad
	}
	if pins.UpgradeAuthority != nil {
		copy := *pins.UpgradeAuthority
		pins.UpgradeAuthority = &copy
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
	for _, a := range ix.Accounts() {
		keys = append(keys, a.PublicKey)
	}
	keys = append(keys, p, pd, solana.SysVarClockPubkey, solana.SysVarRentPubkey)
	seen := map[solana.PublicKey]bool{}
	for _, k := range keys {
		if seen[k] {
			return zero, bad
		}
		seen[k] = true
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
	balances := make([]uint64, len(keys))
	for i, a := range page.Value {
		if a == nil || a.Data == nil {
			return zero, bad
		}
		accounts[i] = &signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Executable: a.Executable, Slot: slot, Data: append([]byte(nil), a.Data.GetBinary()...)}
		balances[i] = a.Lamports
	}
	if e = verifyWENBTCDeploymentV1(signerWENBTCPinsV1{ProgramID: pins.ProgramID, DeploymentSlot: pins.DeploymentSlot, CodeSHA256: pins.CodeSHA256, UpgradeAuthority: pins.UpgradeAuthority}, slot, accounts[6], accounts[7]); e != nil {
		return zero, e
	}
	sysvar := solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111")
	clock, rent := accounts[8], accounts[9]
	if clock.Owner != sysvar || clock.Executable || len(clock.Data) != 40 || binary.LittleEndian.Uint64(clock.Data) != slot || rent.Owner != sysvar || rent.Executable || len(rent.Data) != 17 {
		return zero, bad
	}
	now := binary.LittleEndian.Uint64(clock.Data[32:])
	rate := binary.LittleEndian.Uint64(rent.Data)
	threshold := math.Float64frombits(binary.LittleEndian.Uint64(rent.Data[8:]))
	if math.IsNaN(threshold) || math.IsInf(threshold, 0) || threshold <= 0 || rent.Data[16] > 100 {
		return zero, bad
	}
	minimum := func(length uint64) (uint64, error) {
		if rate > 9007199254740991/(128+length) {
			return 0, bad
		}
		n := math.Floor(float64((128+length)*rate) * threshold)
		if n <= 0 || n > 9007199254740991 || math.IsNaN(n) {
			return 0, bad
		}
		return uint64(n), nil
	}
	vr, e := minimum(160)
	if e != nil {
		return zero, e
	}
	cr, e := minimum(80)
	if e != nil {
		return zero, e
	}
	if e = validateWENMiningFundingReservationV1(v, owner, wenMiningFundingReservationV1{Slot: slot, Now: now, VaultLamports: balances[0], VaultRent: vr, Vault: accounts[0], Action: accounts[1]}); e != nil {
		return zero, e
	}
	if e = validateWENMiningFundingDestinationV1(v, owner, wenMiningFundingDestinationV1{Slot: slot, CapitalLamports: balances[5], CapitalRent: cr, Owner: accounts[2], Sale: accounts[3], Budget: accounts[4], Capital: accounts[5]}); e != nil {
		return zero, e
	}
	ref, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return zero, e
	}
	if ref < slot || ref-slot > maxSlotLag || ref >= expiry {
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
	hash := sha256.New()
	for i, a := range accounts {
		if i == 8 {
			continue
		}
		hash.Write(a.Address[:])
		hash.Write(a.Owner[:])
		flag := byte(0)
		if a.Executable {
			flag = 1
		}
		hash.Write([]byte{flag})
		var n [8]byte
		binary.LittleEndian.PutUint64(n[:], balances[i])
		hash.Write(n[:])
		binary.LittleEndian.PutUint64(n[:], uint64(len(a.Data)))
		hash.Write(n[:])
		hash.Write(a.Data)
	}
	return wenMiningFundingReadbackV1{Slot: slot, Now: now, OwnerLamports: balances[2], StateHash: hex.EncodeToString(hash.Sum(nil))}, nil
}
