package main

import (
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strings"
)

const wenBondClaimArtifactKindV2 = "wen-bond-claim-v2"
const wenBondClaimOperationV2 = "wen.bond.claim.v2"

type wenBondClaimReviewBindingV2 struct {
	Message                                    []byte
	Blockhash                                  solana.Hash
	Snapshot                                   wenBondClaimSnapshotV2
	Fee, Units, CurrentHeight, LastValidHeight uint64
}
type wenBondClaimReviewArtifactV2 struct {
	Version                                          uint32
	RequestID, WalletID, WalletPublicKey, PolicyHash string
	Pins                                             wenBondPinsV2
	Policy                                           wenBondReadPolicyV2
	MaxFee, RetainedLamports                         uint64
	Binding                                          wenBondClaimReviewBindingV2
}

func (a wenBondClaimReviewArtifactV2) nativeDebit() uint64 { return a.MaxFee }
func (a wenBondClaimReviewArtifactV2) requiredPrograms() []string {
	return []string{a.Pins.Program.String(), solana.Token2022ProgramID.String()}
}
func (a wenBondClaimReviewArtifactV2) digest() (string, error) {
	bad := errors.New("Bond claim review artifact rejected")
	b, c := a.Binding, a.Binding.Snapshot.Claim
	if _, e := validateRequestIDV2(a.RequestID); e != nil {
		return "", e
	}
	if a.Version != 2 || a.WalletID == "" || normalizeWalletID(a.WalletID) != a.WalletID || a.WalletPublicKey != a.Pins.Owner.String() || !strings.HasPrefix(a.PolicyHash, "sha256:") || !wenReservationHashV1(strings.TrimPrefix(a.PolicyHash, "sha256:")) || a.MaxFee == 0 || a.RetainedLamports > ^uint64(0)-a.MaxFee || b.Fee == 0 || b.Fee > a.MaxFee || b.Units > 200000 || b.Snapshot.Now == 0 || b.Snapshot.Slot < a.Policy.MinimumSlot || b.Snapshot.ReferenceSlot < b.Snapshot.Slot || b.Snapshot.ReferenceSlot >= a.Policy.ExpiresSlot || b.Snapshot.ReferenceSlot-b.Snapshot.Slot > a.Policy.MaxSlotLag || !wenReservationHashV1(b.Snapshot.StateSHA256) || a.Policy.Deployment.ProgramID != a.Pins.Program.String() || a.Policy.Deployment.Genesis == "" || a.Policy.MinimumNet == 0 || c.Nonce != a.Policy.Nonce || c.AvailableNet < a.Policy.MinimumNet {
		return "", bad
	}
	if c.Gross == 0 || c.ClaimedGross > c.Gross || c.ClaimedNet > c.ClaimedGross || c.ClaimedFee != c.ClaimedGross-c.ClaimedNet || c.AvailableGross > c.Gross-c.ClaimedGross || c.AvailableNet > c.AvailableGross || c.TransferFee != c.AvailableGross-c.AvailableNet || c.Start > b.Snapshot.Now || c.End <= c.Start {
		return "", bad
	}
	if e := verifyWENBondClaimMessageV2(b.Message, a.Pins, c, b.Blockhash, b.CurrentHeight, b.LastValidHeight); e != nil {
		return "", e
	}
	raw, e := json.Marshal(a)
	if e != nil {
		return "", e
	}
	return wenHashV1(append([]byte("wen-bond-claim-review-v2\x00"), raw...)), nil
}
func newWENBondClaimReviewV2(request, wallet, policyHash string, p *wenBondClaimPreparedV2) (wenBondClaimReviewArtifactV2, error) {
	if p == nil {
		return wenBondClaimReviewArtifactV2{}, errors.New("missing protected Bond claim preparation")
	}
	a := wenBondClaimReviewArtifactV2{Version: 2, RequestID: request, WalletID: wallet, WalletPublicKey: p.pins.Owner.String(), PolicyHash: policyHash, Pins: p.pins, Policy: p.policy, MaxFee: p.maxFee, RetainedLamports: p.retainedLamports, Binding: wenBondClaimReviewBindingV2{p.message, p.blockhash, p.snapshot, p.fee, p.units, p.currentHeight, p.lastValidHeight}}
	raw, e := json.Marshal(a)
	if e == nil {
		e = json.Unmarshal(raw, &a)
	}
	if e != nil {
		return a, e
	}
	_, e = a.digest()
	return a, e
}
