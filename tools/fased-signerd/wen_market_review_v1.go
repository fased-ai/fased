package main

import (
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strings"
)

const wenMarketArtifactKindV1 = "wen-market-buy-v1"
const wenMarketOperationV1 = "wen.market.buy.v1"

type wenMarketReviewBindingV1 struct {
	Message                                                       []byte
	Blockhash                                                     solana.Hash
	Snapshot                                                      wenMarketBuySnapshotV1
	Fee, MaxFee, RetainedLamports, CurrentHeight, LastValidHeight uint64
}
type wenMarketReviewArtifactV1 struct {
	Version                                          uint32
	RequestID, WalletID, WalletPublicKey, PolicyHash string
	Pins                                             wenMarketBuyPinsV1
	Policy                                           wenMarketReadPolicyV1
	Limits                                           wenMarketBuyLimitsV1
	Binding                                          wenMarketReviewBindingV1
}

func (a wenMarketReviewArtifactV1) cashAsset() string {
	mint := "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	if a.Pins.Profile == "devnet-synthetic-fixture" {
		mint = "DE8BhmX7qJGzjUSHnYYEXjAcnr86aVUCNquoyEqYsENc"
	}
	return "solana:spl:" + mint
}
func (a wenMarketReviewArtifactV1) requiredPrograms() []string {
	return []string{a.Pins.Program.String(), a.Policy.Venue.ProgramID, solana.TokenProgramID.String(), solana.Token2022ProgramID.String()}
}
func (a wenMarketReviewArtifactV1) digest() (string, error) {
	bad := errors.New("Buy review artifact rejected")
	if _, e := validateRequestIDV2(a.RequestID); e != nil {
		return "", e
	}
	b, p, q := a.Binding, a.Policy, a.Binding.Snapshot.Quote
	if a.Version != 1 || a.WalletID == "" || normalizeWalletID(a.WalletID) != a.WalletID || a.WalletPublicKey != a.Pins.Owner.String() || !strings.HasPrefix(a.PolicyHash, "sha256:") || !wenReservationHashV1(strings.TrimPrefix(a.PolicyHash, "sha256:")) ||
		b.Fee == 0 || b.Fee > b.MaxFee || b.MaxFee > ^uint64(0)-b.RetainedLamports || !wenReservationHashV1(b.Snapshot.StateSHA256) || b.Snapshot.Now == 0 || b.Snapshot.SyntheticReference != p.SyntheticReference ||
		p.Successor.ProgramID != a.Pins.Program.String() || p.Successor.Genesis != p.Venue.Genesis || p.Successor.DeploymentSlot == 0 || p.Venue.DeploymentSlot == 0 || !wenReservationHashV1(p.Successor.CodeSHA256) || !wenReservationHashV1(p.Venue.CodeSHA256) || p.Creator.IsZero() || p.PricePolicy.IsZero() || p.MaxDeviationBPS > 500 || p.ReferenceEnd < 1800 || a.Limits.MinimumSlot < p.Successor.DeploymentSlot || a.Limits.MinimumSlot < p.Venue.DeploymentSlot {
		return "", bad
	}
	genesis := "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
	venue := "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"
	if a.Pins.Profile == "devnet-synthetic-fixture" {
		genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
		venue = "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb"
	}
	if p.Successor.Genesis != genesis || p.Venue.ProgramID != venue || p.SyntheticReference && (a.Pins.Profile != "devnet-synthetic-fixture" || a.Pins.Program.String() != "GC4KiyyAkr3Gwp5pQXQMqoDinrRYtQq9BwZU2cVHDMaQ" || a.Pins.Economy.String() != "5fNcJggJb3rSRpkXhiHmfh1sTr45QLmDfVniFzg6LykH") {
		return "", bad
	}
	if e := verifyWENMarketBuyMessageV1(b.Message, a.Pins, q, a.Limits, b.Blockhash, b.CurrentHeight, b.LastValidHeight); e != nil {
		return "", e
	}
	raw, e := json.Marshal(a)
	if e != nil {
		return "", e
	}
	return wenHashV1(append([]byte("wen-market-buy-review-v1\x00"), raw...)), nil
}
func newWENMarketReviewV1(request, wallet, policyHash string, prepared *wenMarketPreparedBuyV1) (wenMarketReviewArtifactV1, error) {
	if prepared == nil {
		return wenMarketReviewArtifactV1{}, errors.New("missing protected Buy preparation")
	}
	a := wenMarketReviewArtifactV1{Version: 1, RequestID: request, WalletID: wallet, WalletPublicKey: prepared.pins.Owner.String(), PolicyHash: policyHash, Pins: prepared.pins, Policy: prepared.policy, Limits: prepared.limits,
		Binding: wenMarketReviewBindingV1{Message: append([]byte(nil), prepared.message...), Blockhash: prepared.blockhash, Snapshot: prepared.snapshot, Fee: prepared.fee, MaxFee: prepared.maxFee, RetainedLamports: prepared.retainedLamports, CurrentHeight: prepared.currentHeight, LastValidHeight: prepared.lastValidHeight}}
	// Deep-copy pointer-bearing policy before returning durable review data.
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
