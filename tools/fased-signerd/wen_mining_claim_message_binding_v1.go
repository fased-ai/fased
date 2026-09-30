package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

const wenMiningClaimComputeLimitV1 uint32 = 400000

// Zero preserves previously journaled messages with the implicit 200k limit.
func wenMiningClaimInstructionsV1(ix solana.Instruction, limit uint32) ([]solana.Instruction, error) {
	if limit == 0 {
		return []solana.Instruction{ix}, nil
	}
	if limit != wenMiningClaimComputeLimitV1 {
		return nil, errors.New("invalid claim compute limit")
	}
	data := make([]byte, 5)
	data[0] = 2
	binary.LittleEndian.PutUint32(data[1:], limit)
	return []solana.Instruction{solana.NewInstruction(solana.MustPublicKeyFromBase58("ComputeBudget111111111111111111111111111111"), nil, data), ix}, nil
}

type wenMiningClaimMessageBindingV1 struct {
	ComputeUnitLimit                 uint32
	Message                          []byte
	Blockhash                        solana.Hash
	ReviewSHA, StateHash             string
	Slot, Fee, Rent, LastValidHeight uint64
}

func validateWENMiningClaimMessageBindingV1(v signerWENMiningClaimIntentV1, w solana.PublicKey, total uint64, b wenMiningClaimMessageBindingV1) error {
	bad := errors.New("mining claim message binding rejected")
	ix, e := buildWENMiningClaimInstructionV1(v, w)
	if e != nil {
		return e
	}
	num := func(s string) uint64 { n, _ := strconv.ParseUint(s, 10, 64); return n }
	if b.Blockhash == (solana.Hash{}) || !wenReservationHashV1(b.ReviewSHA) || !wenReservationHashV1(b.StateHash) || b.StateHash != v.AccountStateSHA256 || b.Slot < num(v.MinFinalizedSlot) || b.Slot >= num(v.ExpiresSlot) || b.LastValidHeight == 0 || b.Fee == 0 || b.Rent != 0 || b.Fee > num(v.MaxFeeLamports) || b.Fee > ^uint64(0)-b.Rent || b.Fee+b.Rent != total {
		return bad
	}
	instructions, e := wenMiningClaimInstructionsV1(ix, b.ComputeUnitLimit)
	if e != nil {
		return e
	}
	tx, e := solana.NewTransaction(instructions, b.Blockhash, solana.TransactionPayer(w))
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
func (s *signerStoreV2) reservePreparedWENMiningClaimV1(request, walletID, policyHash string, v signerWENMiningClaimIntentV1, p *wenMiningClaimPreparedV1) (string, bool, error) {
	if s == nil || s.db == nil || p == nil {
		return "", false, errors.New("missing claim preparation")
	}
	if e := recheckWENMiningClaimReviewV1(s.db.Path(), walletID, v, p.review, p.wallet); e != nil {
		return "", false, e
	}
	if p.total > p.review.maxTotalCostLamports {
		return "", false, errors.New("claim budget exceeded")
	}
	b := wenMiningClaimMessageBindingV1{ComputeUnitLimit: p.computeLimit, Message: append([]byte(nil), p.message...), Blockhash: p.blockhash, ReviewSHA: p.review.reviewSHA, StateHash: p.state.StateHash, Slot: p.slot, Fee: p.fee, Rent: p.rent, LastValidHeight: p.lastValidHeight}
	return s.reserveWENMiningClaimBoundBudgetV1(request, walletID, policyHash, v, p.wallet, p.total, &b)
}
