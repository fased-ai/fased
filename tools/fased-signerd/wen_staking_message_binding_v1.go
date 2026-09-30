package main

import (
	"bytes"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

// Unsigned message commitment is separate from the durable signing fence.
type wenStakingMessageBindingV1 struct {
	Evidence                         *wenStakingPreparedEvidenceV1 `json:",omitempty"`
	Message                          []byte
	Blockhash                        solana.Hash
	ReviewSHA                        string
	Slot, Fee, Rent, LastValidHeight uint64
}

type wenStakingPreparedEvidenceV1 struct {
	Pins   wenStakingPinsV1
	Before wenStakingHistorySnapshotV1
}

func validateWENStakingMessageBindingV1(v signerWENStakingIntentV1, w solana.PublicKey, total uint64, b wenStakingMessageBindingV1) error {
	bad := errors.New("staking prepared message rejected")
	if b.Evidence != nil {
		ev := b.Evidence
		if ev.Before.Slot > b.Slot || ev.Pins.ProgramID != v.ProgramID || ev.Pins.Genesis != v.Genesis || ev.Pins.DescriptorSHA256 != v.DescriptorSHA256 || ev.Pins.CapabilitySHA256 != v.CapabilitySHA256 || ev.Pins.DeploymentSlot == 0 || ev.Pins.DeploymentSlot > ev.Before.Slot || !wenReservationHashV1(ev.Pins.CodeSHA256) {
			return bad
		}
		if _, e := validateWENStakingHistoryV1(v, w, ev.Before); e != nil {
			return e
		}
	}

	ix, e := buildWENStakingInstructionV1(v, w)
	if e != nil {
		return e
	}
	min, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	expires, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	maxFee, _ := strconv.ParseUint(v.MaxFeeLamports, 10, 64)
	if b.Blockhash == (solana.Hash{}) || !wenReservationHashV1(b.ReviewSHA) || b.Slot < min || b.Slot >= expires || b.LastValidHeight == 0 || b.Fee > maxFee || b.Fee > ^uint64(0)-b.Rent || b.Fee+b.Rent != total {
		return bad
	}
	tx, e := solana.NewTransaction([]solana.Instruction{ix}, b.Blockhash, solana.TransactionPayer(w))
	if e != nil {
		return e
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	expected, e := tx.Message.MarshalBinary()
	if e != nil {
		return e
	}
	if len(expected)+65 > 1232 || !bytes.Equal(expected, b.Message) {
		return bad
	}
	return nil
}
func (s *signerStoreV2) reservePreparedWENStakingV1(request, walletID, policyHash string, v signerWENStakingIntentV1, p *wenStakingPreparedV1) (string, bool, error) {
	if s == nil || s.db == nil || p == nil {
		return "", false, errors.New("missing staking preparation")
	}
	if e := recheckWENStakingReviewV1(s.db.Path(), walletID, v, p.review, p.wallet); e != nil {
		return "", false, e
	}
	current, w, e := loadWENStakingAdmissionV1(s.db.Path(), walletID, v)
	if e != nil {
		return "", false, e
	}
	if w != p.wallet || current.reviewSHA != p.review.reviewSHA || p.total > current.maxTotalCostLamports {
		return "", false, errors.New("staking review differs")
	}
	b := wenStakingMessageBindingV1{Evidence: &wenStakingPreparedEvidenceV1{Pins: current.pins, Before: p.state.History}, Message: append([]byte(nil), p.message...), Blockhash: p.blockhash, ReviewSHA: p.review.reviewSHA, Slot: p.slot, Fee: p.fee, Rent: p.rent, LastValidHeight: p.lastValidHeight}
	return s.reserveWENStakingBoundBudgetV1(request, walletID, policyHash, v, w, p.total, &b)
}
