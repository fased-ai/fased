package main

import (
	"bytes"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

type wenBTCClaimMessageBindingV1 struct {
	Amount, Weight                   uint64
	Message                          []byte
	Blockhash                        solana.Hash
	ReviewSHA, StateHash             string
	Slot, Fee, Rent, LastValidHeight uint64
}

func validateWENBTCClaimMessageBindingV1(v signerWENBTCClaimIntentV1, w solana.PublicKey, total uint64, b wenBTCClaimMessageBindingV1) error {
	bad := errors.New("BTC claim message binding rejected")
	ix, e := buildWENBTCClaimInstructionV1(v, w)
	if e != nil {
		return e
	}
	num := func(s string) uint64 { n, _ := strconv.ParseUint(s, 10, 64); return n }
	if b.Amount < num(v.MinimumReceived) || b.Weight == 0 || b.Blockhash == (solana.Hash{}) || !wenReservationHashV1(b.ReviewSHA) || !wenReservationHashV1(b.StateHash) || b.Slot < num(v.MinFinalizedSlot) || b.Slot >= num(v.ExpiresSlot) || b.LastValidHeight == 0 || b.Fee == 0 || b.Rent == 0 || b.Fee > num(v.MaxFeeLamports) || b.Rent > num(v.MaxRentLamports) || b.Fee > ^uint64(0)-b.Rent || b.Fee+b.Rent != total {
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
func (s *signerStoreV2) reservePreparedWENBTCClaimV1(request, walletID, policyHash string, v signerWENBTCClaimIntentV1, p *wenBTCClaimPreparedV1) (string, bool, error) {
	if s == nil || s.db == nil || p == nil {
		return "", false, errors.New("missing claim preparation")
	}
	if e := recheckWENBTCClaimReviewV1(s.db.Path(), walletID, v, p.review, p.wallet); e != nil {
		return "", false, e
	}
	if p.total > p.review.maxTotalCostLamports {
		return "", false, errors.New("claim budget exceeded")
	}
	b := wenBTCClaimMessageBindingV1{Amount: p.state.Amount, Weight: p.state.Weight, Message: append([]byte(nil), p.message...), Blockhash: p.blockhash, ReviewSHA: p.review.reviewSHA, StateHash: p.state.StateHash, Slot: p.slot, Fee: p.fee, Rent: p.rent, LastValidHeight: p.lastValidHeight}
	return s.reserveWENBTCClaimBoundBudgetV1(request, walletID, policyHash, v, p.wallet, p.total, &b)
}
