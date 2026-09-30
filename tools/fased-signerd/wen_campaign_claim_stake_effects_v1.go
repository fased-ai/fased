package main

import (
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// Token receipt proof only. The caller must independently verify transaction
// identity/native costs; successful history writes need the poststate check.
func verifyWENCampaignClaimStakeEffectsV1(v signerWENStakingIntentV1, minimumNet uint64, s wenCampaignClaimSnapshotV1, h wenStakingHistorySnapshotV1, keys []solana.PublicKey, m *rpc.TransactionMeta) error {
	if _, _, e := buildWENCampaignClaimStakeV1(v, minimumNet, s, h); e != nil {
		return e
	}
	return verifyWENCampaignClaimDestinationEffectsV1(s, h.Pool.Address, keys, m)
}

// Isolated successful historical transition, not a transaction-time RPC proof.
// Sum per-transfer net credits: rounding an aggregate gross can overcredit stake.
func validateWENCampaignClaimStakePoststateV1(v signerWENStakingIntentV1, minimumNet uint64, s wenCampaignClaimSnapshotV1, before, after wenStakingHistorySnapshotV1, outcomeSlot uint64) error {
	_, result, e := buildWENCampaignClaimStakeV1(v, minimumNet, s, before)
	if e != nil {
		return e
	}
	return validateWENStakingCreditPoststateV1(v, s.Owner, before, after, outcomeSlot, result.Amounts.Net)
}
