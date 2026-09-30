package main

import (
	"context"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

type wenMiningPinsV1 struct {
	ProgramID, Genesis, DescriptorSHA256, CapabilitySHA256, CodeSHA256 string
	DeploymentSlot                                                     uint64
	UpgradeAuthority                                                   *solana.PublicKey
}

// Only signer-owned configuration may supply pins/client/preimage material.
// This produces a verified observation, not a fee reservation or signing permit.
func readWENMiningRPCV1(ctx context.Context, client signerWENBTCReadRPCV1, pins wenMiningPinsV1, v signerWENMiningIntentV1, wallet solana.PublicKey, material []byte, maxSlotLag uint64) (wenMiningEntrySnapshotV1, error) {
	material = append([]byte(nil), material...)
	defer zeroBytes(material)
	return readWENMiningValidatedRPCV1(ctx, client, pins, v, maxSlotLag, func(candidate wenMiningEntrySnapshotV1) error {
		_, e := prepareWENMiningInstructionV1(v, wallet, candidate, material)
		return e
	})
}

// Both execution and phase observation use the same finalized deployment,
// entry and Clock batch. The validator never supplies a signing permission.
func readWENMiningValidatedRPCV1(ctx context.Context, client signerWENBTCReadRPCV1, pins wenMiningPinsV1, v signerWENMiningIntentV1, maxSlotLag uint64, validate func(wenMiningEntrySnapshotV1) error) (wenMiningEntrySnapshotV1, error) {
	var out wenMiningEntrySnapshotV1
	bad := errors.New("WEN mining finalized readback rejected")
	if err := validateWENMiningIntentV1(v); err != nil {
		return out, err
	}
	if pins.ProgramID != v.ProgramID || pins.Genesis != v.Genesis || pins.DescriptorSHA256 != v.DescriptorSHA256 || pins.CapabilitySHA256 != v.CapabilitySHA256 || pins.DeploymentSlot == 0 {
		return out, bad
	}
	if pins.UpgradeAuthority != nil {
		copy := *pins.UpgradeAuthority
		pins.UpgradeAuthority = &copy
	}
	min, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	expires, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	if min < pins.DeploymentSlot {
		return out, bad
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
	program := solana.MustPublicKeyFromBase58(pins.ProgramID)
	loader := solana.MustPublicKeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")
	pd, _, err := solana.FindProgramAddress([][]byte{program[:]}, loader)
	if err != nil {
		return out, err
	}
	keys := []solana.PublicKey{solana.MustPublicKeyFromBase58(v.Entry), program, pd, solana.MustPublicKeyFromBase58("SysvarC1ock11111111111111111111111111111111")}
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
	if page == nil || len(page.Value) != 4 || page.Context.Slot < min || page.Context.Slot >= expires {
		return out, bad
	}
	slot := page.Context.Slot
	accounts := make([]*signerWENBTCAccountV1, 4)
	for i, a := range page.Value {
		if a == nil || a.Data == nil {
			return out, bad
		}
		accounts[i] = &signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Slot: slot, Executable: a.Executable, Data: append([]byte(nil), a.Data.GetBinary()...)}
	}
	// Shared Solana loader verification has no BTC custody assumptions.
	if err := verifyWENBTCDeploymentV1(signerWENBTCPinsV1{ProgramID: pins.ProgramID, DeploymentSlot: pins.DeploymentSlot, CodeSHA256: pins.CodeSHA256, UpgradeAuthority: pins.UpgradeAuthority}, slot, accounts[1], accounts[2]); err != nil {
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
	entry := accounts[0]
	candidate := wenMiningEntrySnapshotV1{entry.Address, entry.Owner, entry.Executable, entry.Data, slot, now}
	if err := validate(candidate); err != nil {
		return out, err
	}
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
	return candidate, nil
}
