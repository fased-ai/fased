package main

import (
	"context"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

type wenCampaignClaimStakeReadbackV1 struct {
	Claim            wenCampaignClaimSnapshotV1
	History          wenStakingHistorySnapshotV1
	Sale, Activation signerWENBTCAccountV1
	Result           wenCampaignClaimStakeResultV1
}

// Read all selected obligations and custody in one finalized page. Caller-named
// windows are hints only: PDA, ownership and claim membership must all match.
func readWENCampaignClaimStakeV1(ctx context.Context, c signerWENBTCReadRPCV1, pins wenStakingPinsV1, v signerWENStakingIntentV1, q wenCampaignClaimRequestV1, owner solana.PublicKey, minimumNet, lag uint64) (wenCampaignClaimStakeReadbackV1, error) {
	min, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	expires, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	var out wenCampaignClaimStakeReadbackV1
	bad := errors.New("campaign claim-to-stake read rejected")
	if validateWENStakingIntentV1(v) != nil || v.Operation != "deposit" || v.ProgramID != pins.ProgramID || v.Genesis != pins.Genesis || v.DescriptorSHA256 != pins.DescriptorSHA256 || v.CapabilitySHA256 != pins.CapabilitySHA256 || v.Sale != q.Economy.String() {
		return out, bad
	}
	stake, e := buildWENStakingInstructionV1(v, owner)
	if e != nil {
		return out, e
	}
	metas := stake.Accounts()
	if q.Destination != metas[7].PublicKey {
		return out, bad
	}
	if pins.UpgradeAuthority != nil {
		authority := *pins.UpgradeAuthority
		pins.UpgradeAuthority = &authority
	}
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
	// Preserve legitimate same-day history aliases, but fetch each address once.
	claimCount := len(keys)
	historyIndices := []int{3, 4, 5, 6, 12, 13, 14, 1, 2}
	offsets := make([]int, len(historyIndices))
	for i, n := range historyIndices {
		key := metas[n].PublicKey
		offset := -1
		for j, k := range keys {
			if k == key {
				offset = j
				break
			}
		}
		if offset < 0 {
			offset = len(keys)
			keys = append(keys, key)
		}
		offsets[i] = offset
	}
	result, e := c.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &min})
	if e != nil {
		return out, e
	}
	if result == nil || len(result.Value) != len(keys) || result.Context.Slot < min || result.Context.Slot >= expires {
		return out, bad
	}
	slot := result.Context.Slot
	accounts := make([]*signerWENBTCAccountV1, len(keys))
	for i, a := range result.Value {
		if a == nil && i >= claimCount && (i == offsets[1] || i == offsets[2] || i == offsets[3] || i == offsets[6]) {
			continue
		}
		if a == nil || a.Data == nil {
			return out, bad
		}
		accounts[i] = &signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Executable: a.Executable, Slot: slot, Data: append([]byte(nil), a.Data.GetBinary()...)}
	}
	if e = verifyWENBTCDeploymentV1(signerWENBTCPinsV1{ProgramID: pins.ProgramID, CodeSHA256: pins.CodeSHA256, DeploymentSlot: pins.DeploymentSlot, UpgradeAuthority: pins.UpgradeAuthority}, slot, accounts[4], accounts[5]); e != nil {
		return out, e
	}
	clock := accounts[6]
	if clock.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || clock.Executable || len(clock.Data) != 40 || binary.LittleEndian.Uint64(clock.Data) != slot || binary.LittleEndian.Uint64(clock.Data[32:]) > 1<<63-1 {
		return out, bad
	}
	out.Claim = wenCampaignClaimSnapshotV1{Program: q.Program, Economy: q.Economy, Owner: owner, Slot: slot, Mask: q.Mask, Position: *accounts[0], Page: *accounts[1], Mint: *accounts[2], Destination: *accounts[3]}
	for i := range q.Windows {
		out.Claim.Windows = append(out.Claim.Windows, wenCampaignClaimWindowV1{Window: *accounts[7+2*i], Vault: *accounts[8+2*i]})
	}
	out.History = wenStakingHistorySnapshotV1{Slot: slot, Now: binary.LittleEndian.Uint64(clock.Data[32:]), Pool: accounts[offsets[0]], Position: accounts[offsets[1]], History: accounts[offsets[2]], NextHistory: accounts[offsets[3]], Index: accounts[offsets[4]], Point: accounts[offsets[5]], NextPoint: accounts[offsets[6]]}
	if e = validateWENStakingActivationV1(v, slot, out.History.Now, accounts[offsets[7]], accounts[offsets[8]]); e != nil {
		return wenCampaignClaimStakeReadbackV1{}, e
	}
	out.Sale, out.Activation = *accounts[offsets[7]], *accounts[offsets[8]]
	if _, out.Result, e = buildWENCampaignClaimStakeV1(v, minimumNet, out.Claim, out.History); e != nil {
		return wenCampaignClaimStakeReadbackV1{}, e
	}
	reference, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return wenCampaignClaimStakeReadbackV1{}, e
	}
	if reference < slot || reference-slot > lag || reference >= expires {
		return wenCampaignClaimStakeReadbackV1{}, bad
	}
	after, e := c.GetGenesisHash(ctx)
	if e != nil {
		return wenCampaignClaimStakeReadbackV1{}, e
	}
	if after != genesis {
		return wenCampaignClaimStakeReadbackV1{}, bad
	}
	if e = ctx.Err(); e != nil {
		return wenCampaignClaimStakeReadbackV1{}, e
	}
	out.Claim.ReferenceSlot = reference
	return out, nil
}
