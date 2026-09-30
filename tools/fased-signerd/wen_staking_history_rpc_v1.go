package main

import (
	"context"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

type wenStakingReadbackV1 struct {
	History wenStakingHistorySnapshotV1
	Tokens  wenStakingTokenResultV1
}

// Compatibility reader for historical diagnostics only.
func readWENStakingHistoryRPCV1(ctx context.Context, client signerWENBTCReadRPCV1, pins wenStakingPinsV1, v signerWENStakingIntentV1, wallet solana.PublicKey, maxSlotLag uint64) (wenStakingHistorySnapshotV1, error) {
	r, e := readWENStakingStateV1(ctx, client, pins, v, wallet, maxSlotLag, false)
	return r.History, e
}

// Full coherent state observation; budgets and execution are separate.
func readWENStakingRPCV1(ctx context.Context, client signerWENBTCReadRPCV1, pins wenStakingPinsV1, v signerWENStakingIntentV1, wallet solana.PublicKey, maxSlotLag uint64) (wenStakingReadbackV1, error) {
	return readWENStakingStateV1(ctx, client, pins, v, wallet, maxSlotLag, true)
}
func readWENStakingStateV1(ctx context.Context, client signerWENBTCReadRPCV1, pins wenStakingPinsV1, v signerWENStakingIntentV1, wallet solana.PublicKey, maxSlotLag uint64, full bool) (wenStakingReadbackV1, error) {
	return readWENStakingObservationV1(ctx, client, pins, v, wallet, maxSlotLag, full, 0)
}

// outcomeSlot is nonzero only for post-execution historical observation.
func readWENStakingObservationV1(ctx context.Context, client signerWENBTCReadRPCV1, pins wenStakingPinsV1, v signerWENStakingIntentV1, wallet solana.PublicKey, maxSlotLag uint64, full bool, outcomeSlot uint64) (wenStakingReadbackV1, error) {
	var out wenStakingReadbackV1
	bad := errors.New("WEN staking finalized readback rejected")
	if err := validateWENStakingIntentV1(v); err != nil {
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
	if outcomeSlot > min {
		min = outcomeSlot
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
	ix, err := buildWENStakingInstructionV1(v, wallet)
	if err != nil {
		return out, err
	}
	metas := ix.Accounts()
	keys := []solana.PublicKey{metas[3].PublicKey, metas[4].PublicKey, metas[5].PublicKey, metas[6].PublicKey, metas[12].PublicKey, metas[13].PublicKey, metas[14].PublicKey, program, pd, solana.SysVarClockPubkey}
	if full {
		keys = append(keys, metas[1].PublicKey, metas[2].PublicKey, metas[8].PublicKey, metas[7].PublicKey, metas[9].PublicKey)
	}
	page, err := client.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &min})
	if err != nil {
		return out, err
	}
	if page == nil || len(page.Value) != len(keys) || page.Context.Slot < min || outcomeSlot == 0 && page.Context.Slot >= expires {
		return out, bad
	}
	slot := page.Context.Slot
	accounts := make([]*signerWENBTCAccountV1, len(keys))
	for i, a := range page.Value {
		if a == nil && (i == 1 || i == 2 || i == 3 || i == 6 || full && i == 14 && v.Operation == "requestExit") {
			continue
		}
		if a == nil || a.Data == nil {
			return out, bad
		}
		accounts[i] = &signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Slot: slot, Executable: a.Executable, Data: append([]byte(nil), a.Data.GetBinary()...)}
	}
	// Shared Solana loader verification has no BTC custody assumptions.
	if err := verifyWENBTCDeploymentV1(signerWENBTCPinsV1{ProgramID: pins.ProgramID, DeploymentSlot: pins.DeploymentSlot, CodeSHA256: pins.CodeSHA256, UpgradeAuthority: pins.UpgradeAuthority}, slot, accounts[7], accounts[8]); err != nil {
		return out, err
	}
	clock := accounts[9]
	if clock.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || clock.Executable || len(clock.Data) != 40 || binary.LittleEndian.Uint64(clock.Data) != slot {
		return out, bad
	}
	now := binary.LittleEndian.Uint64(clock.Data[32:])
	if now > uint64(1<<63-1) {
		return out, bad
	}
	candidate := wenStakingHistorySnapshotV1{Slot: slot, Now: now, Pool: accounts[0], Position: accounts[1], History: accounts[2], NextHistory: accounts[3], Index: accounts[4], Point: accounts[5], NextPoint: accounts[6]}
	if outcomeSlot == 0 {
		if _, err := validateWENStakingHistoryV1(v, wallet, candidate); err != nil {
			return out, err
		}
	}
	if full {
		if err := validateWENStakingActivationV1(v, slot, now, accounts[10], accounts[11]); err != nil {
			return out, err
		}
		tokens, err := validateWENStakingTokensV1(v, wallet, candidate, accounts[12], accounts[13], accounts[14])
		if err != nil {
			return out, err
		}
		out.Tokens = tokens
	}
	reference, err := client.GetSlot(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return out, err
	}
	if reference < slot || reference-slot > maxSlotLag || outcomeSlot == 0 && reference >= expires {
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
	out.History = candidate
	return out, nil
}
