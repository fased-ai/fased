package main

import (
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"reflect"
	"strconv"
)

// Runs inside the shared atomic fence. Bare accounting reservations cannot sign.
func validateWENMiningClaimFenceV1(r wenBudgetReservationV1, messageSHA string, keys []string, slots []uint64) error {
	bad := errors.New("mining claim signing fence differs from reserved message")
	if r.MiningClaimIntent == nil || r.MiningClaimPrepared == nil || len(slots) != 1 || r.MiningFundingIntent != nil || r.MiningFundingPrepared != nil || r.NativeClaimIntent != nil || r.NativeClaimPrepared != nil || r.BTCClaimIntent != nil || r.BTCClaimPrepared != nil || r.WithdrawalIntent != nil || r.WithdrawalPrepared != nil || r.MiningIntent != nil || r.StakingIntent != nil || r.StakingPrepared != nil || len(r.WalletClaims) != 1 || r.Genesis != r.MiningClaimIntent.Genesis {
		return bad
	}
	v, b := *r.MiningClaimIntent, *r.MiningClaimPrepared
	w, e := solana.PublicKeyFromBase58(r.WalletPublicKey)
	if e != nil {
		return bad
	}
	total, ok := r.WalletClaims["solana:native"]
	if !ok || validateWENMiningClaimMessageBindingV1(v, w, total, b) != nil || messageSHA != wenHashV1(b.Message) {
		return bad
	}
	expiry, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	if slots[0] < b.Slot || slots[0] >= expiry {
		return bad
	}
	ix, e := buildWENMiningClaimInstructionV1(v, w)
	if e != nil {
		return e
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
