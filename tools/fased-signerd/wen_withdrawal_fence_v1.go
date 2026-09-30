package main

import (
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"reflect"
	"strconv"
)

// Runs inside the shared atomic fence. Bare accounting reservations cannot sign.
func validateWENWithdrawalFenceV1(r wenBudgetReservationV1, messageSHA string, keys []string, slots []uint64) error {
	bad := errors.New("withdrawal signing fence differs from reserved message")
	if r.WithdrawalIntent == nil || r.WithdrawalPrepared == nil || len(slots) != 1 {
		return bad
	}
	v, b := *r.WithdrawalIntent, *r.WithdrawalPrepared
	w, e := solana.PublicKeyFromBase58(r.WalletPublicKey)
	if e != nil {
		return bad
	}
	total, ok := r.WalletClaims["solana:native"]
	if !ok || validateWENWithdrawalMessageBindingV1(v, w, total, b) != nil || messageSHA != wenHashV1(b.Message) {
		return bad
	}
	expiry, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	if slots[0] < b.Slot || slots[0] >= expiry {
		return bad
	}
	ix, e := buildWENWithdrawalInstructionV1(v, w)
	if e != nil {
		return e
	}
	tx, e := solana.NewTransaction([]solana.Instruction{ix}, b.Blockhash, solana.TransactionPayer(w))
	if e != nil {
		return e
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	all, e := tx.Message.GetAllKeys()
	if e != nil {
		return e
	}
	expected := make([]string, len(all))
	for i, k := range all {
		expected[i] = k.String()
	}
	if !reflect.DeepEqual(keys, expected) {
		return bad
	}
	return nil
}
