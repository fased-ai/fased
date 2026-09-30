package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"reflect"
	"strconv"
	"strings"
)

// Direct-stake review bound to protected admission and one consumed approval.
// Browser preparation requires a separately configured direct-stake draft.
type wenCampaignClaimStakeReviewV1 struct {
	Version                                                        uint32
	RequestID, WalletID, WalletPublicKey, PolicyHash               string
	Pins                                                           wenStakingPinsV1
	Intent                                                         signerWENStakingIntentV1
	Claim                                                          wenCampaignClaimRequestV1
	MinimumNet, MaxTotal                                           uint64
	Snapshot                                                       wenCampaignClaimStakeReadbackV1
	Message                                                        []byte
	Blockhash                                                      solana.Hash
	Fee, Rent, Units, CurrentHeight, LastValidHeight, MaximumDebit uint64
}

func newWENCampaignClaimStakeReviewV1(request, walletID, policy string, pins wenStakingPinsV1, v signerWENStakingIntentV1, q wenCampaignClaimRequestV1, wallet solana.PublicKey, minimumNet, maxTotal uint64, p *wenCampaignClaimStakePreparedV1) (wenCampaignClaimStakeReviewV1, error) {
	if p == nil {
		return wenCampaignClaimStakeReviewV1{}, errors.New("missing direct stake preparation")
	}
	a := wenCampaignClaimStakeReviewV1{Version: 1, RequestID: request, WalletID: walletID, WalletPublicKey: wallet.String(), PolicyHash: policy, Pins: pins, Intent: v, Claim: q, MinimumNet: minimumNet, MaxTotal: maxTotal, Snapshot: p.snapshot, Message: p.message, Blockhash: p.blockhash, Fee: p.fee, Rent: p.rent, Units: p.units, CurrentHeight: p.currentHeight, LastValidHeight: p.lastValidHeight, MaximumDebit: p.maximumDebit}
	// Detach account bytes, history pointers, window lists and authority from callers.
	raw, e := json.Marshal(a)
	if e != nil {
		return wenCampaignClaimStakeReviewV1{}, e
	}
	var copy wenCampaignClaimStakeReviewV1
	if e = json.Unmarshal(raw, &copy); e != nil {
		return wenCampaignClaimStakeReviewV1{}, e
	}
	if _, e = copy.digest(); e != nil {
		return wenCampaignClaimStakeReviewV1{}, e
	}
	return copy, nil
}
func (a wenCampaignClaimStakeReviewV1) digest() (string, error) {
	bad := errors.New("invalid direct stake review")
	id, e := validateRequestIDV2(a.RequestID)
	if e != nil || id != a.RequestID || a.Version != 1 || a.WalletID == "" || normalizeWalletID(a.WalletID) != a.WalletID || !strings.HasPrefix(a.PolicyHash, "sha256:") || !wenReservationHashV1(strings.TrimPrefix(a.PolicyHash, "sha256:")) {
		return "", bad
	}
	owner, e := solana.PublicKeyFromBase58(a.WalletPublicKey)
	if e != nil || owner.IsZero() || owner.String() != a.WalletPublicKey {
		return "", bad
	}
	v, p, s, q := a.Intent, a.Pins, a.Snapshot, a.Claim
	if validateWENStakingIntentV1(v) != nil || v.ProgramID != p.ProgramID || v.Genesis != p.Genesis || v.DescriptorSHA256 != p.DescriptorSHA256 || v.CapabilitySHA256 != p.CapabilitySHA256 || p.DeploymentSlot == 0 || !wenReservationHashV1(p.CodeSHA256) {
		return "", bad
	}
	min, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	expires, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	maxFee, _ := strconv.ParseUint(v.MaxFeeLamports, 10, 64)
	if min < p.DeploymentSlot || s.Claim.Slot < min || s.Claim.ReferenceSlot < s.Claim.Slot || s.Claim.ReferenceSlot >= expires || expires-min > 32 || a.Fee > maxFee || a.Rent > ^uint64(0)-maxFee || a.MaximumDebit != a.Rent+maxFee || a.MaximumDebit > a.MaxTotal || a.Units > 400000 {
		return "", bad
	}
	if q.Program != s.Claim.Program || q.Economy != s.Claim.Economy || q.Destination != s.Claim.Destination.Address || q.Mask != s.Claim.Mask || len(s.Claim.Page.Data) != 576 || q.PageIndex != binary.LittleEndian.Uint64(s.Claim.Page.Data[80:88]) || len(q.Windows) != len(s.Claim.Windows) || s.Claim.Owner != owner {
		return "", bad
	}
	for i, w := range q.Windows {
		if w.Window != s.Claim.Windows[i].Window.Address || w.Vault != s.Claim.Windows[i].Vault.Address {
			return "", bad
		}
	}
	if e = validateWENStakingActivationV1(v, s.History.Slot, s.History.Now, &s.Sale, &s.Activation); e != nil {
		return "", e
	}
	ix, result, e := buildWENCampaignClaimStakeV1(v, a.MinimumNet, s.Claim, s.History)
	if e != nil {
		return "", e
	}
	if !reflect.DeepEqual(result, s.Result) || (len(result.RentBytes) == 0) != (a.Rent == 0) {
		return "", bad
	}
	message, e := compileWENCampaignClaimStakeV1(ix, owner, a.Blockhash, a.CurrentHeight, a.LastValidHeight)
	if e != nil {
		return "", e
	}
	if !bytes.Equal(message, a.Message) {
		return "", bad
	}
	raw, e := json.Marshal(a)
	if e != nil {
		return "", e
	}
	return wenHashV1(append([]byte("wen-campaign-claim-stake-review-v1\x00"), raw...)), nil
}

// Recheck the retained approval identity against live state without rebuilding
// a different transaction. Caller must bind expectedDigest to owner approval.
func revalidateWENCampaignClaimStakeReviewV1(ctx context.Context, c wenStakingPrepareRPCV1, a wenCampaignClaimStakeReviewV1, expectedDigest string, owner solana.PublicKey, lag uint64) (*wenCampaignClaimStakePreparedV1, error) {
	digest, e := a.digest()
	if e != nil {
		return nil, e
	}
	if !wenReservationHashV1(expectedDigest) || digest != expectedDigest || owner.String() != a.WalletPublicKey {
		return nil, errors.New("direct stake approval identity mismatch")
	}
	old := &wenCampaignClaimStakePreparedV1{message: a.Message, blockhash: a.Blockhash, snapshot: a.Snapshot, fee: a.Fee, rent: a.Rent, units: a.Units, currentHeight: a.CurrentHeight, lastValidHeight: a.LastValidHeight, maximumDebit: a.MaximumDebit}
	return prepareWENCampaignClaimStakeV1(ctx, c, a.Pins, a.Intent, a.Claim, owner, a.MinimumNet, lag, a.MaxTotal, old)
}
