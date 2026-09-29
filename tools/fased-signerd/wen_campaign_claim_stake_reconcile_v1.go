package main

import (
	"bytes"
	"context"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenCampaignClaimStakeRecoveryRPCV1 interface {
	signerWENBTCReconcileRPCV1
	signerWENBTCReadRPCV1
}

// A later account observation is supporting evidence of the isolated transition.
// Intervening writes fail closed and leave the hold unresolved, never retrying.
func reconcileWENCampaignClaimStakeV1(ctx context.Context, c wenCampaignClaimStakeRecoveryRPCV1, a wenCampaignClaimStakeReviewV1, slot uint64) error {
	bad := errors.New("direct stake finalized claim/history reconciliation unavailable")
	owner := solana.MustPublicKeyFromBase58(a.WalletPublicKey)
	observed, e := readWENStakingObservationV1(ctx, c, a.Pins, a.Intent, owner, 32, false, slot)
	if e != nil {
		return e
	}
	if e = validateWENCampaignClaimStakePoststateV1(a.Intent, a.MinimumNet, a.Snapshot.Claim, a.Snapshot.History, observed.History, slot); e != nil {
		return e
	}
	// Fetch at or after the authenticated staking observation. The claim page
	// cannot be treated as unconsumed merely because its selected rows are gone.
	minimum := observed.History.Slot
	page, e := c.GetMultipleAccountsWithOpts(ctx, []solana.PublicKey{a.Snapshot.Claim.Page.Address}, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &minimum})
	if e != nil {
		return e
	}
	if page == nil || page.Context.Slot < minimum || len(page.Value) != 1 || page.Value[0] == nil {
		return bad
	}
	account := page.Value[0]
	if account.Owner != a.Claim.Program || account.Executable || account.Data == nil {
		return bad
	}
	expected := append([]byte(nil), a.Snapshot.Claim.Page.Data...)
	for i := 0; i < 8; i++ {
		if a.Claim.Mask&(1<<i) != 0 {
			clear(expected[128+i*56 : 128+(i+1)*56])
		}
	}
	if !bytes.Equal(expected, account.Data.GetBinary()) {
		return bad
	}
	reference, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return e
	}
	if reference < page.Context.Slot || reference-page.Context.Slot > 32 {
		return bad
	}
	genesis, e := c.GetGenesisHash(ctx)
	if e != nil {
		return e
	}
	if genesis.String() != a.Pins.Genesis {
		return bad
	}
	return ctx.Err()
}
