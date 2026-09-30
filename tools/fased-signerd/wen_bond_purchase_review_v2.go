package main

import (
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strings"
)

const wenBondPurchaseArtifactKindV2 = "wen-bond-purchase-v2"
const wenBondPurchaseOperationV2 = "wen.bond.purchase.v2"

type wenBondPurchaseReviewBindingV2 struct {
	Message                                           []byte
	Blockhash                                         solana.Hash
	Snapshot                                          wenBondPurchaseSnapshotV2
	Fee, Total, Units, CurrentHeight, LastValidHeight uint64
}
type wenBondPurchaseReviewArtifactV2 struct {
	Version                                          uint32
	RequestID, WalletID, WalletPublicKey, PolicyHash string
	Pins                                             wenBondPurchasePinsV2
	Policy                                           wenBondPurchaseReadPolicyV2
	Limits                                           wenBondPurchaseCostLimitsV2
	Binding                                          wenBondPurchaseReviewBindingV2
}

func (a wenBondPurchaseReviewArtifactV2) cashAsset() string {
	if len(a.Pins.PolicyBytes) != 96 {
		return ""
	}
	usdc := solana.PublicKeyFromBytes(a.Pins.PolicyBytes[8:40])
	return "solana:spl:" + usdc.String()
}
func (a wenBondPurchaseReviewArtifactV2) requiredPrograms() []string {
	out := []string{a.Pins.Bond.Program.String()}
	for _, v := range []string{a.Policy.Venue.ProgramID, a.Policy.Router.ProgramID, a.Policy.Oracle.ProgramID, solana.TokenProgramID.String(), solana.Token2022ProgramID.String()} {
		if !containsStringV2(out, v) {
			out = append(out, v)
		}
	}
	return out
}
func (a wenBondPurchaseReviewArtifactV2) digest() (string, error) {
	bad := errors.New("Bond purchase review artifact rejected")
	b, l := a.Binding, a.Limits
	if _, e := validateRequestIDV2(a.RequestID); e != nil {
		return "", e
	}
	if a.Version != 2 || a.WalletID == "" || normalizeWalletID(a.WalletID) != a.WalletID || a.WalletPublicKey != a.Pins.Bond.Owner.String() || !strings.HasPrefix(a.PolicyHash, "sha256:") || !wenReservationHashV1(strings.TrimPrefix(a.PolicyHash, "sha256:")) || len(a.Pins.PolicyBytes) != 96 || b.Fee == 0 || b.Fee > l.MaxFee || l.RecoveryBudget == 0 || b.Snapshot.Rent > l.MaxRent || b.Units > uint64(l.ComputeUnits) || b.Snapshot.Now == 0 || b.Snapshot.Slot < a.Policy.MinimumSlot || b.Snapshot.ReferenceSlot < b.Snapshot.Slot || b.Snapshot.ReferenceSlot >= a.Policy.ExpiresSlot || !wenReservationHashV1(b.Snapshot.StateSHA256) {
		return "", bad
	}
	expected := uint64(0)
	for _, n := range []uint64{b.Fee, b.Snapshot.Rent, l.RecoveryBudget, l.RetainedLamports} {
		if expected > ^uint64(0)-n {
			return "", bad
		}
		expected += n
	}
	if expected != b.Total {
		return "", bad
	}
	if a.Policy.Deployment.ProgramID != a.Pins.Bond.Program.String() || a.Policy.Deployment.Genesis == "" || a.Policy.QuoteSHA256 != wenHashV1(b.Snapshot.Quote.Data) {
		return "", bad
	}
	p := b.Snapshot.Pins
	if p.Bond != a.Pins.Bond || p.Source != a.Pins.Source || p.MaximumCash != a.Pins.MaximumCash || p.MinimumNet != a.Pins.MinimumNet || wenHashV1(p.PolicyBytes) != wenHashV1(a.Pins.PolicyBytes) {
		return "", bad
	}
	life := signerWENBTCMessageLifeV1{b.CurrentHeight, b.LastValidHeight, b.Snapshot.Slot, a.Policy.MaxSlotLag}
	if e := verifyWENBondPurchaseMessageV2(b.Message, p, b.Snapshot.Quote, a.Policy.Nonce, b.Snapshot.Now, a.Policy.Route, b.Blockhash, l.ComputeUnits, a.Policy.internalLookups(), b.Snapshot.Lookups, life); e != nil {
		return "", e
	}
	if _, e := wenMarketQuoteCashV1(&b.Snapshot.Source, p.Source, solana.PublicKeyFromBytes(p.PolicyBytes[8:40]), p.Bond.Owner, b.Snapshot.Slot, a.cashAmount()); e != nil {
		return "", e
	}
	raw, e := json.Marshal(a)
	if e != nil {
		return "", e
	}
	return wenHashV1(append([]byte("wen-bond-purchase-review-v2\x00"), raw...)), nil
}
func (a wenBondPurchaseReviewArtifactV2) cashAmount() uint64 {
	q, e := inspectWENBondQuoteV2(a.Pins.Bond, a.Binding.Snapshot.Quote, a.Policy.Nonce)
	if e != nil {
		return 0
	}
	return q.Cash
}
func (a wenBondPurchaseReviewArtifactV2) nativeDebit() uint64 {
	if a.Binding.Total < a.Limits.RetainedLamports {
		return 0
	}
	return a.Binding.Total - a.Limits.RetainedLamports
}
func newWENBondPurchaseReviewV2(request, wallet, policyHash string, p *wenBondPurchaseCostPreparedV2) (wenBondPurchaseReviewArtifactV2, error) {
	if p == nil {
		return wenBondPurchaseReviewArtifactV2{}, errors.New("missing protected Bond preparation")
	}
	a := wenBondPurchaseReviewArtifactV2{Version: 2, RequestID: request, WalletID: wallet, WalletPublicKey: p.pins.Bond.Owner.String(), PolicyHash: policyHash, Pins: p.pins, Policy: p.policy, Limits: p.limits, Binding: wenBondPurchaseReviewBindingV2{Message: p.message, Blockhash: p.blockhash, Snapshot: p.snapshot, Fee: p.fee, Total: p.total, Units: p.units, CurrentHeight: p.currentHeight, LastValidHeight: p.lastValidHeight}}
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
