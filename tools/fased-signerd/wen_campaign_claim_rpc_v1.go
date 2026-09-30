package main

import (
	"context"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenCampaignClaimRequestV1 struct {
	Program, Economy, Destination solana.PublicKey
	PageIndex                     uint64
	Mask                          uint8
	Windows                       []struct{ Window, Vault solana.PublicKey }
}

// Read all selected obligations and custody in one finalized page. Caller-named
// windows are hints only: PDA, ownership and claim membership must all match.
func readWENCampaignClaimV1(ctx context.Context, c signerWENBTCReadRPCV1, pins signerWENBTCPinsV1, q wenCampaignClaimRequestV1, owner solana.PublicKey, min, expires, lag uint64) (wenCampaignClaimSnapshotV1, error) {
	var out wenCampaignClaimSnapshotV1
	bad := errors.New("campaign claim read rejected")
	if pins.ProgramID != q.Program.String() || pins.DeploymentSlot == 0 || min < pins.DeploymentSlot || expires <= min || expires-min > 32 || lag == 0 || lag > 32 || len(q.Windows) < 1 || len(q.Windows) > 4 {
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
	mint, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), q.Economy[:]}, q.Program)
	if e != nil {
		return out, e
	}
	pos, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-retail-position-v2"), owner[:], mint[:]}, q.Program)
	if e != nil {
		return out, e
	}
	index := make([]byte, 8)
	binary.LittleEndian.PutUint64(index, q.PageIndex)
	page, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-retail-claims-v2"), pos[:], index}, q.Program)
	if e != nil {
		return out, e
	}
	pd, _, e := solana.FindProgramAddress([][]byte{q.Program[:]}, solana.BPFLoaderUpgradeableProgramID)
	if e != nil {
		return out, e
	}
	keys := []solana.PublicKey{pos, page, mint, q.Destination, q.Program, pd, solana.SysVarClockPubkey}
	for _, w := range q.Windows {
		keys = append(keys, w.Window, w.Vault)
	}
	for i, k := range keys {
		for _, v := range keys[:i] {
			if k == v {
				return out, bad
			}
		}
	}
	result, e := c.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &min})
	if e != nil {
		return out, e
	}
	if result == nil || len(result.Value) != len(keys) || result.Context.Slot < min || result.Context.Slot >= expires {
		return out, bad
	}
	slot := result.Context.Slot
	accounts := make([]signerWENBTCAccountV1, len(keys))
	for i, a := range result.Value {
		if a == nil || a.Data == nil {
			return out, bad
		}
		accounts[i] = signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Executable: a.Executable, Slot: slot, Data: append([]byte(nil), a.Data.GetBinary()...)}
	}
	if e = verifyWENBTCDeploymentV1(pins, slot, &accounts[4], &accounts[5]); e != nil {
		return out, e
	}
	clock := accounts[6]
	if clock.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || clock.Executable || len(clock.Data) != 40 || binary.LittleEndian.Uint64(clock.Data) != slot || binary.LittleEndian.Uint64(clock.Data[32:]) > 1<<63-1 {
		return out, bad
	}
	out = wenCampaignClaimSnapshotV1{Program: q.Program, Economy: q.Economy, Owner: owner, Slot: slot, Mask: q.Mask, Position: accounts[0], Page: accounts[1], Mint: accounts[2], Destination: accounts[3]}
	for i := range q.Windows {
		out.Windows = append(out.Windows, wenCampaignClaimWindowV1{Window: accounts[7+2*i], Vault: accounts[8+2*i]})
	}
	if _, _, e = buildWENCampaignClaimV1(out); e != nil {
		return wenCampaignClaimSnapshotV1{}, e
	}
	reference, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return wenCampaignClaimSnapshotV1{}, e
	}
	if reference < slot || reference-slot > lag || reference >= expires {
		return wenCampaignClaimSnapshotV1{}, bad
	}
	after, e := c.GetGenesisHash(ctx)
	if e != nil {
		return wenCampaignClaimSnapshotV1{}, e
	}
	if after != genesis {
		return wenCampaignClaimSnapshotV1{}, bad
	}
	if e = ctx.Err(); e != nil {
		return wenCampaignClaimSnapshotV1{}, e
	}
	out.ReferenceSlot = reference
	return out, nil
}
