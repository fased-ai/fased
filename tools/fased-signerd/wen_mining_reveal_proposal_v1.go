package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"strconv"
)

// Produces an unsigned proposal only. The host must independently admit the
// resulting exact intent; this function never writes a review or reads a secret.
func proposeWENMiningRevealV1(saved wenBudgetReservationV1, minimum, expires uint64) (signerWENMiningIntentV1, error) {
	var out signerWENMiningIntentV1
	bad := errors.New("mining reveal requires a reconciled observed commitment")
	if saved.MiningIntent == nil || saved.MiningEntry == nil || saved.State != "finalized-success" || !saved.SuccessBudgetSettled || saved.OutcomeError != "" || saved.MiningObservedSlot == 0 || saved.MiningObservedSlot < saved.OutcomeSlot || minimum < saved.MiningObservedSlot || expires <= minimum || !wenReservationHashV1(saved.MiningEffectsSHA256) {
		return out, bad
	}
	v := *saved.MiningIntent
	if validateWENMiningIntentV1(v) != nil || v.Operation != "commit" || saved.Genesis != v.Genesis {
		return out, bad
	}
	wallet, e := solana.PublicKeyFromBase58(saved.WalletPublicKey)
	if e != nil {
		return out, bad
	}
	if _, e = prepareWENMiningInstructionV1(v, wallet, *saved.MiningEntry, nil); e != nil {
		return out, bad
	}
	wire, e := wenSignedWireV1(saved, saved.SignedMessage)
	if e != nil {
		return out, bad
	}
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil || len(tx.Message.Instructions) != 1 {
		return out, bad
	}
	digest, _ := hex.DecodeString(v.CommitmentSHA256)
	data := tx.Message.Instructions[0].Data
	if len(data) != 33 || data[0] != 54 || hex.EncodeToString(data[1:]) != v.CommitmentSHA256 {
		return out, bad
	}
	committed := append([]byte(nil), saved.MiningEntry.Data...)
	committed[9] = 1
	copy(committed[200:232], digest)
	if wenHashV1(committed) != saved.MiningObservedSHA256 {
		return out, bad
	}
	out = v
	out.Operation = "reveal"
	out.EntrySHA256 = wenHashV1(committed)
	out.MinFinalizedSlot = strconv.FormatUint(minimum, 10)
	out.ExpiresSlot = strconv.FormatUint(expires, 10)
	if e = validateWENMiningIntentV1(out); e != nil {
		return signerWENMiningIntentV1{}, e
	}
	return out, nil
}
func (s *signerStoreV2) proposeWENMiningRevealV1(request, walletID string, minimum, expires uint64) (signerWENMiningIntentV1, error) {
	var out signerWENMiningIntentV1
	bad := errors.New("mining commitment journal unavailable")
	if s == nil || s.db == nil {
		return out, bad
	}
	if _, e := validateRequestIDV2(request); e != nil {
		return out, e
	}
	e := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		var saved wenBudgetReservationV1
		if json.Unmarshal(b.Get([]byte("request:"+request)), &saved) != nil || saved.WalletID != walletID || saved.MiningIntent == nil {
			return bad
		}
		v := saved.MiningIntent
		if string(b.Get([]byte("mining-action:"+wenHashV1([]byte(v.Genesis+":"+v.ProgramID+":"+v.Entry+":commit"))))) != request {
			return bad
		}
		var e error
		out, e = proposeWENMiningRevealV1(saved, minimum, expires)
		return e
	})
	return out, e
}
