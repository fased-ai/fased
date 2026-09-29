package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

// Checks an isolated transition against authenticated pre-state. A later RPC
// snapshot can include intervening writes: mismatch is not proof of chain loss.
// This does not authenticate a transaction-time snapshot or settle any budget.
func validateWENStakingPoststateV1(v signerWENStakingIntentV1, w solana.PublicKey, before, after wenStakingHistorySnapshotV1, outcomeSlot uint64) error {
	amount, _ := strconv.ParseUint(v.Amount, 10, 64)
	_, net := wenSatTransferV1(amount)
	return validateWENStakingCreditPoststateV1(v, w, before, after, outcomeSlot, net)
}

// Private explicit credit for independently validated multi-transfer claims.
func validateWENStakingCreditPoststateV1(v signerWENStakingIntentV1, w solana.PublicKey, before, after wenStakingHistorySnapshotV1, outcomeSlot, net uint64) error {
	bad := errors.New("staking historical transition not established")
	h, e := validateWENStakingHistoryV1(v, w, before)
	if e != nil {
		return e
	}
	if outcomeSlot < before.Slot || after.Slot < outcomeSlot || after.Now < before.Now {
		return bad
	}
	num := func(s string) uint64 { n, _ := strconv.ParseUint(s, 10, 64); return n }
	day, last, from := num(v.Day), num(v.Last), num(v.AggregateFrom)
	amount, next, custodied := h.PositionAmount, h.PoolNext, h.PoolCustodied
	exit, weight := uint64(0), uint64(0)
	if v.Operation == "deposit" {
		if net == 0 {
			return bad
		}
		for _, n := range []uint64{amount, next, custodied} {
			if net > ^uint64(0)-n {
				return bad
			}
		}
		amount += net
		next += net
		custodied += net
		weight = amount
	} else {
		exit = day + 1
		next -= amount
	}
	p, sale := solana.MustPublicKeyFromBase58(v.ProgramID), solana.MustPublicKeyFromBase58(v.Sale)
	le := func(n uint64) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, n); return b }
	rec := func(seed, magic string, n int, second solana.PublicKey, ver byte, extra ...[]byte) *signerWENBTCAccountV1 {
		seeds := [][]byte{[]byte(seed), sale[:]}
		key, bump, err := solana.FindProgramAddress(append(seeds, extra...), p)
		if err != nil {
			return nil
		}
		d := make([]byte, n)
		copy(d, magic)
		d[8] = ver
		d[11] = bump
		copy(d[16:], sale[:])
		copy(d[48:], second[:])
		return &signerWENBTCAccountV1{Address: key, Owner: p, Slot: after.Slot, Data: d}
	}
	put := func(a *signerWENBTCAccountV1, o int, n uint64) { binary.LittleEndian.PutUint64(a.Data[o:], n) }
	clone := func(a *signerWENBTCAccountV1) *signerWENBTCAccountV1 {
		if a == nil {
			return nil
		}
		c := *a
		c.Slot = after.Slot
		c.Data = append([]byte(nil), a.Data...)
		return &c
	}
	pool := clone(before.Pool)
	if binary.LittleEndian.Uint64(pool.Data[80:]) < day {
		put(pool, 80, day)
		put(pool, 88, h.PoolNext)
	}
	put(pool, 96, next)
	put(pool, 104, custodied)
	position := rec("wen-stake-position-v1", "WENSTP01", 104, w, 1, w[:])
	if position == nil {
		return bad
	}
	put(position, 80, amount)
	put(position, 88, exit)
	put(position, 96, day+1)
	history := rec("wen-stake-history-v1", "WENSTH01", 104, w, 1, w[:], le(day+1))
	if history == nil {
		return bad
	}
	put(history, 80, day+1)
	put(history, 88, ^uint64(0))
	put(history, 96, weight)
	oldHistory := clone(before.History)
	if last == day+1 {
		oldHistory = history
	} else if last > 0 {
		put(oldHistory, 88, day+1)
	}
	index := clone(before.Index)
	put(index, 80, day+1)
	point := rec("wen-stake-total-v1", "WENSTOT1", 112, index.Address, 1, le(day+1))
	if point == nil {
		return bad
	}
	put(point, 80, day+1)
	put(point, 88, ^uint64(0))
	put(point, 96, next)
	oldPoint := clone(before.Point)
	if from == day+1 {
		oldPoint = point
	} else {
		put(oldPoint, 88, day+1)
	}
	expected := []*signerWENBTCAccountV1{pool, position, oldHistory, history, index, oldPoint, point}
	got := []*signerWENBTCAccountV1{after.Pool, after.Position, after.History, after.NextHistory, after.Index, after.Point, after.NextPoint}
	for i, a := range expected {
		b := got[i]
		if a == nil {
			if b != nil {
				return bad
			}
			continue
		}
		if b == nil || a.Address != b.Address || a.Owner != b.Owner || b.Executable || b.Slot != after.Slot || !bytes.Equal(a.Data, b.Data) {
			return bad
		}
	}
	return nil
}
