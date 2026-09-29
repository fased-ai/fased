package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

func checkDirectStakeReview(t *testing.T, pins wenStakingPinsV1, v signerWENStakingIntentV1, q wenCampaignClaimRequestV1, w solana.PublicKey, p *wenCampaignClaimStakePreparedV1) {
	a, e := newWENCampaignClaimStakeReviewV1("direct-stake-review-001", "miner", "sha256:"+wenHashV1([]byte("policy")), pins, v, q, w, 970, 6000, p)
	if e != nil {
		t.Fatal("review", e)
	}
	checkDirectStakeStoredReview(t, a)
	digest, e := a.digest()
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(a)
	for name, change := range map[string]func(*wenCampaignClaimStakeReviewV1){
		"wallet":     func(a *wenCampaignClaimStakeReviewV1) { a.WalletPublicKey = solana.NewWallet().PublicKey().String() },
		"message":    func(a *wenCampaignClaimStakeReviewV1) { a.Message[len(a.Message)-1] ^= 1 },
		"minimum":    func(a *wenCampaignClaimStakeReviewV1) { a.MinimumNet = 971 },
		"claim":      func(a *wenCampaignClaimStakeReviewV1) { a.Claim.PageIndex++ },
		"history":    func(a *wenCampaignClaimStakeReviewV1) { a.Snapshot.History.Pool.Data[88]++ },
		"launch":     func(a *wenCampaignClaimStakeReviewV1) { a.Snapshot.Activation.Data[120] ^= 1 },
		"outcome":    func(a *wenCampaignClaimStakeReviewV1) { a.Snapshot.Result.NextPosition++ },
		"rent":       func(a *wenCampaignClaimStakeReviewV1) { a.Rent++ },
		"budget":     func(a *wenCampaignClaimStakeReviewV1) { a.MaxTotal = 4999 },
		"fee":        func(a *wenCampaignClaimStakeReviewV1) { a.Fee = 5001 },
		"expiry":     func(a *wenCampaignClaimStakeReviewV1) { a.Intent.ExpiresSlot = "150" },
		"descriptor": func(a *wenCampaignClaimStakeReviewV1) { a.Pins.DescriptorSHA256 = wenHashV1([]byte("other")) },
		"request":    func(a *wenCampaignClaimStakeReviewV1) { a.RequestID = "another-request-001" },
		"policy":     func(a *wenCampaignClaimStakeReviewV1) { a.PolicyHash = "sha256:" + wenHashV1([]byte("another")) },
	} {
		t.Run("review-"+name, func(t *testing.T) {
			var b wenCampaignClaimStakeReviewV1
			_ = json.Unmarshal(raw, &b)
			change(&b)
			got, err := b.digest()
			if err == nil && got == digest {
				t.Fatal("changed review retained approved digest")
			}
		})
	}
	// Mutation of prepared state must never mutate a review already presented.
	old := p.snapshot.History.Pool.Data[88]
	p.snapshot.History.Pool.Data[88] ^= 1
	got, e := a.digest()
	p.snapshot.History.Pool.Data[88] = old
	if e != nil || got != digest {
		t.Fatal("review aliases preparation")
	}
}
