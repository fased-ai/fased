package main

import (
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"math"
	"strings"
)

const wenCampaignArtifactKindV1 = "wen-campaign-owner-v1"

func wenCampaignOperationV1(op string) string {
	switch op {
	case "stop", "top-up", "withdraw", "setup", "policy", "claim":
		return "wen.campaign." + op + ".v1"
	}
	return ""
}

type wenCampaignReviewBindingV1 struct {
	Claim                                                    *wenCampaignClaimSnapshotV1 `json:",omitempty"`
	Message                                                  []byte
	Blockhash                                                solana.Hash
	Position                                                 wenCampaignPositionV1
	Fee, MaxFee, CurrentHeight, LastValidHeight, ExpiresSlot uint64
	Setup                                                    *wenCampaignSetupSnapshotV1 `json:",omitempty"`
}
type wenCampaignReviewArtifactV1 struct {
	Version                                          uint32
	RequestID, WalletID, WalletPublicKey, PolicyHash string
	Pins                                             signerWENBTCPinsV1
	Action                                           wenCampaignOwnerActionV1
	Binding                                          wenCampaignReviewBindingV1
}

func (a wenCampaignReviewArtifactV1) debit() (uint64, error) {
	amount := a.Binding.MaxFee
	if a.Action.Operation == "setup" {
		if a.Binding.Setup == nil || a.Action.Setup == nil || a.Action.Amount != a.Action.Setup.Terms.Deposit {
			return 0, errors.New("missing setup funding")
		}
		for _, n := range []uint64{a.Action.Amount, a.Binding.Setup.Rent} {
			if n > math.MaxUint64-amount {
				return 0, errors.New("setup debit overflow")
			}
			amount += n
		}
		return amount, nil
	}
	if a.Action.Operation == "top-up" {
		if a.Action.Amount > math.MaxUint64-amount {
			return 0, errors.New("campaign debit overflow")
		}
		amount += a.Action.Amount
	}
	return amount, nil
}
func (a wenCampaignReviewArtifactV1) stateHash() string {
	var raw []byte
	if a.Binding.Claim != nil {
		raw, _ = json.Marshal(a.Binding.Claim)
	} else if a.Binding.Setup != nil {
		raw, _ = json.Marshal(a.Binding.Setup)
	} else {
		raw, _ = json.Marshal(a.Binding.Position)
	}
	return wenHashV1(raw)
}
func (a wenCampaignReviewArtifactV1) digest() (string, error) {
	bad := errors.New("invalid campaign review artifact")
	id, e := validateRequestIDV2(a.RequestID)
	if e != nil || id != a.RequestID || a.Version != 1 || a.WalletID == "" || normalizeWalletID(a.WalletID) != a.WalletID || !strings.HasPrefix(a.PolicyHash, "sha256:") || !wenReservationHashV1(strings.TrimPrefix(a.PolicyHash, "sha256:")) || wenCampaignOperationV1(a.Action.Operation) == "" {
		return "", bad
	}
	wallet, e := solana.PublicKeyFromBase58(a.WalletPublicKey)
	if e != nil || wallet.IsZero() || wallet.String() != a.WalletPublicKey {
		return "", bad
	}
	if a.Pins.ProgramID != a.Action.Program.String() || a.Pins.DeploymentSlot == 0 || !wenReservationHashV1(a.Pins.CodeSHA256) || a.Binding.Position.Slot < a.Pins.DeploymentSlot || a.Binding.Position.ReferenceSlot < a.Binding.Position.Slot || a.Binding.Position.ReferenceSlot >= a.Binding.ExpiresSlot || a.Binding.ExpiresSlot-a.Binding.Position.Slot > 32 || a.Binding.MaxFee == 0 || a.Binding.Fee > a.Binding.MaxFee {
		return "", bad
	}
	if a.Action.Operation != "claim" && a.Action.Operation != "setup" && !wenReservationHashV1(a.Binding.Position.AccountingSHA256) {
		return "", bad
	}
	if _, e = solana.HashFromBase58(a.Pins.Genesis); e != nil {
		return "", bad
	}
	if _, e = a.debit(); e != nil {
		return "", e
	}
	if e = verifyWENCampaignReviewMessageV1(a, wallet); e != nil {
		return "", e
	}
	raw, e := json.Marshal(a)
	if e != nil {
		return "", e
	}
	return wenHashV1(append([]byte("wen-campaign-owner-review-v1\x00"), raw...)), nil
}
func newWENCampaignReviewV1(request, walletID, policyHash string, pins signerWENBTCPinsV1, v wenCampaignOwnerActionV1, wallet solana.PublicKey, p *wenCampaignPreparedV1, expires, maxFee uint64) (wenCampaignReviewArtifactV1, error) {
	if p == nil {
		return wenCampaignReviewArtifactV1{}, errors.New("missing campaign preparation")
	}
	a := wenCampaignReviewArtifactV1{Version: 1, RequestID: request, WalletID: walletID, WalletPublicKey: wallet.String(), PolicyHash: policyHash, Pins: pins, Action: v, Binding: wenCampaignReviewBindingV1{Message: append([]byte(nil), p.message...), Blockhash: p.blockhash, Position: p.position, Fee: p.fee, MaxFee: maxFee, CurrentHeight: p.currentHeight, LastValidHeight: p.lastValidHeight, ExpiresSlot: expires}}
	a.Binding.Position.Data = append([]byte{}, p.position.Data...)
	if p.claim != nil {
		raw, _ := json.Marshal(p.claim)
		var q wenCampaignClaimSnapshotV1
		if e := json.Unmarshal(raw, &q); e != nil {
			return a, e
		}
		a.Binding.Claim = &q
	}
	if v.Claim != nil {
		q := *v.Claim
		q.Windows = append([]struct{ Window, Vault solana.PublicKey }(nil), q.Windows...)
		a.Action.Claim = &q
	}
	if v.Policy != nil {
		q := *v.Policy
		a.Action.Policy = &q
	}
	if p.position.PolicyWindow != nil {
		w := *p.position.PolicyWindow
		w.Data = append([]byte{}, w.Data...)
		a.Binding.Position.PolicyWindow = &w
	}
	if p.setup != nil {
		raw, _ := json.Marshal(p.setup)
		var snapshot wenCampaignSetupSnapshotV1
		if e := json.Unmarshal(raw, &snapshot); e != nil {
			return a, e
		}
		a.Binding.Setup = &snapshot
	}
	if v.Setup != nil {
		copied := *v.Setup
		a.Action.Setup = &copied
	}
	if pins.UpgradeAuthority != nil {
		x := *pins.UpgradeAuthority
		a.Pins.UpgradeAuthority = &x
	}
	_, e := a.digest()
	return a, e
}
