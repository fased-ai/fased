package main

import (
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strings"
)

// Internal candidate review payload, not an authorization proof. A trusted
// approval layer must bind its digest before any reviewed execution is exposed.
type wenMiningClaimReviewArtifactV1 struct {
	Version         uint32                         `json:"version"`
	RequestID       string                         `json:"requestId"`
	WalletID        string                         `json:"walletId"`
	WalletPublicKey string                         `json:"walletPublicKey"`
	PolicyHash      string                         `json:"policyHash"`
	Intent          signerWENMiningClaimIntentV1   `json:"intent"`
	Binding         wenMiningClaimMessageBindingV1 `json:"binding"`
}

func newWENMiningClaimReviewArtifactV1(request, walletID, policyHash string, v signerWENMiningClaimIntentV1, p *wenMiningClaimPreparedV1) (wenMiningClaimReviewArtifactV1, string, error) {
	if p == nil {
		return wenMiningClaimReviewArtifactV1{}, "", errors.New("missing prepared claim")
	}
	a := wenMiningClaimReviewArtifactV1{Version: 1, RequestID: request, WalletID: walletID, WalletPublicKey: p.wallet.String(), PolicyHash: policyHash, Intent: v,
		Binding: wenMiningClaimMessageBindingV1{ComputeUnitLimit: p.computeLimit, Message: append([]byte(nil), p.message...), Blockhash: p.blockhash, ReviewSHA: p.review.reviewSHA, StateHash: p.state.StateHash, Slot: p.slot, Fee: p.fee, Rent: p.rent, LastValidHeight: p.lastValidHeight}}
	// Own pointer-bearing fields as well as transaction bytes.
	if v.Destination != nil {
		d := *v.Destination
		a.Intent.Destination = &d
	}
	digest, err := a.digest()
	return a, digest, err
}
func (a wenMiningClaimReviewArtifactV1) digest() (string, error) {
	bad := errors.New("invalid mining claim review artifact")
	id, err := validateRequestIDV2(a.RequestID)
	if err != nil || id != a.RequestID || a.Version != 1 || a.WalletID == "" || normalizeWalletID(a.WalletID) != a.WalletID || !strings.HasPrefix(a.PolicyHash, "sha256:") || !wenReservationHashV1(strings.TrimPrefix(a.PolicyHash, "sha256:")) {
		return "", bad
	}
	wallet, err := solana.PublicKeyFromBase58(a.WalletPublicKey)
	if err != nil || wallet.IsZero() || wallet.String() != a.WalletPublicKey {
		return "", bad
	}
	if err = validateWENMiningClaimMessageBindingV1(a.Intent, wallet, a.Binding.Fee, a.Binding); err != nil {
		return "", err
	}
	raw, err := json.Marshal(a)
	if err != nil {
		return "", err
	}
	return wenHashV1(append([]byte("wen-mining-claim-review-v1\x00"), raw...)), nil
}
