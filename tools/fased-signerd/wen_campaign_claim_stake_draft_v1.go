package main

import (
	"context"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"reflect"
)

// Protected control-plane input only. Applications name its content hash and
// never supply an instruction, endpoint, replacement blockhash or deployment.
type wenCampaignClaimStakeDraftV1 struct {
	Pins                 wenStakingPinsV1
	Intent               signerWENStakingIntentV1
	Claim                wenCampaignClaimRequestV1
	MinimumNet, MaxTotal uint64
}

func (d wenCampaignDraftV1) validate(wallet string) error {
	bad := errors.New("invalid campaign draft")
	if d.Version != 1 || d.WalletID != wallet || wallet == "" || normalizeWalletID(wallet) != wallet {
		return bad
	}
	if d.ClaimStake == nil {
		if wenCampaignOperationV1(d.Action.Operation) == "" || d.MaxFee == 0 || d.MinimumSlot == 0 || d.ExpiresSlot <= d.MinimumSlot || d.ExpiresSlot-d.MinimumSlot > 32 {
			return bad
		}
		return nil
	}
	if !reflect.DeepEqual(d.Pins, signerWENBTCPinsV1{}) || !reflect.DeepEqual(d.Action, wenCampaignOwnerActionV1{}) || d.MinimumSlot != 0 || d.ExpiresSlot != 0 || d.MaxFee != 0 {
		return bad
	}
	c := d.ClaimStake
	if validateWENStakingIntentV1(c.Intent) != nil || c.Intent.Operation != "deposit" || c.MinimumNet == 0 || c.MaxTotal < mustStakeUint(c.Intent.MaxFeeLamports) || c.Pins.ProgramID != c.Claim.Program.String() || c.Pins.Genesis != c.Intent.Genesis || c.Pins.ProgramID != c.Intent.ProgramID {
		return bad
	}
	return nil
}
func (d wenCampaignDraftV1) identity() (operation, program, genesis string) {
	if d.ClaimStake != nil {
		return wenCampaignClaimStakeOperationV1, d.ClaimStake.Pins.ProgramID, d.ClaimStake.Pins.Genesis
	}
	return wenCampaignOperationV1(d.Action.Operation), d.Action.Program.String(), d.Pins.Genesis
}
func (d wenCampaignDraftV1) prepare(ctx context.Context, c wenCampaignExecutionRPCV1, owner solana.PublicKey) (*wenCampaignPreparedV1, *wenCampaignClaimStakePreparedV1, error) {
	if d.ClaimStake != nil {
		v := d.ClaimStake
		p, e := prepareWENCampaignClaimStakeV1(ctx, c, v.Pins, v.Intent, v.Claim, owner, v.MinimumNet, 32, v.MaxTotal, nil)
		return nil, p, e
	}
	p, e := prepareWENCampaignOwnerV1(ctx, c, d.Pins, d.Action, owner, d.MinimumSlot, d.ExpiresSlot, 32, d.MaxFee, nil)
	return p, nil, e
}
