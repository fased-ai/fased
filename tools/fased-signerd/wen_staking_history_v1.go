package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

// Historical-state subset only. Sale/activation/token custody and RPC authentication
// remain required before this can be used for executable staking preflight.
type wenStakingHistorySnapshotV1 struct {
	Slot, Now                                                     uint64
	Pool, Position, History, NextHistory, Index, Point, NextPoint *signerWENBTCAccountV1
}
type wenStakingHistoryResultV1 struct {
	PositionAmount, PoolNext, PoolCustodied, EffectiveDay uint64
	RentBytes                                             []uint64
}

func validateWENStakingHistoryV1(v signerWENStakingIntentV1, wallet solana.PublicKey, s wenStakingHistorySnapshotV1) (wenStakingHistoryResultV1, error) {
	var out wenStakingHistoryResultV1
	bad := errors.New("staking historical state rejected")
	if _, e := buildWENStakingInstructionV1(v, wallet); e != nil {
		return out, e
	}
	num := func(s string) uint64 { n, _ := strconv.ParseUint(s, 10, 64); return n }
	day, last, from := num(v.Day), num(v.Last), num(v.AggregateFrom)
	if s.Slot < num(v.MinFinalizedSlot) || s.Slot >= num(v.ExpiresSlot) || s.Now > uint64(1<<63-1) || s.Now/86400 != day {
		return out, bad
	}
	program, sale, mint := solana.MustPublicKeyFromBase58(v.ProgramID), solana.MustPublicKeyFromBase58(v.Sale), solana.MustPublicKeyFromBase58(v.Mint)
	le := func(n uint64) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, n); return b }
	derive := func(seed string, extra ...[]byte) (solana.PublicKey, uint8, error) {
		seeds := [][]byte{[]byte(seed), sale[:]}
		return solana.FindProgramAddress(append(seeds, extra...), program)
	}
	check := func(a *signerWENBTCAccountV1, seed, magic string, length int, second solana.PublicKey, version byte, extra ...[]byte) ([]byte, error) {
		p, b, e := derive(seed, extra...)
		if e != nil {
			return nil, e
		}
		if a == nil || a.Address != p || a.Owner != program || a.Executable || a.Slot != s.Slot || len(a.Data) != length {
			return nil, bad
		}
		d := a.Data
		if string(d[:8]) != magic || d[8] != version || d[9] != 0 || d[10] != 0 || d[11] != b || !bytes.Equal(d[12:16], make([]byte, 4)) || !bytes.Equal(d[16:48], sale[:]) || !bytes.Equal(d[48:80], second[:]) {
			return nil, bad
		}
		return d, nil
	}
	read := func(d []byte, o int) uint64 { return binary.LittleEndian.Uint64(d[o : o+8]) }
	pool, e := check(s.Pool, "wen-stake-pool-v1", "WENSTK01", 112, mint, 2)
	if e != nil {
		return out, e
	}
	next, custodied := read(pool, 96), read(pool, 104)
	if read(pool, 80) > day || read(pool, 88) > custodied || next > custodied {
		return out, bad
	}
	amount := uint64(0)
	if s.Position == nil {
		if v.Operation != "deposit" || last != 0 {
			return out, bad
		}
		out.RentBytes = append(out.RentBytes, 104)
	} else {
		p, e := check(s.Position, "wen-stake-position-v1", "WENSTP01", 104, wallet, 1, wallet[:])
		if e != nil {
			return out, e
		}
		amount = read(p, 80)
		if read(p, 88) != 0 || read(p, 96) != last || amount > next || amount > custodied {
			return out, bad
		}
	}
	if last > 0 {
		h, e := check(s.History, "wen-stake-history-v1", "WENSTH01", 104, wallet, 1, wallet[:], le(last))
		if e != nil {
			return out, e
		}
		if read(h, 80) != last || read(h, 88) != ^uint64(0) || read(h, 96) != amount {
			return out, bad
		}
	}
	equal := func(a, b *signerWENBTCAccountV1) bool {
		return a != nil && b != nil && a.Address == b.Address && a.Owner == b.Owner && a.Executable == b.Executable && a.Slot == b.Slot && bytes.Equal(a.Data, b.Data)
	}
	if last == day+1 {
		if !equal(s.History, s.NextHistory) {
			return out, bad
		}
	} else {
		if s.NextHistory != nil {
			return out, bad
		}
		out.RentBytes = append(out.RentBytes, 104)
	}
	index, e := check(s.Index, "wen-stake-history-index-v1", "WENSTIX1", 96, mint, 1)
	if e != nil {
		return out, e
	}
	indexKey, _, e := derive("wen-stake-history-index-v1")
	if e != nil {
		return out, e
	}
	point, e := check(s.Point, "wen-stake-total-v1", "WENSTOT1", 112, indexKey, 1, le(from))
	if e != nil {
		return out, e
	}
	if read(index, 80) != from || read(index, 88) > day || read(point, 80) != from || read(point, 88) != ^uint64(0) || read(point, 96) != next || read(point, 104) != 0 {
		return out, bad
	}
	if from == day+1 {
		if !equal(s.Point, s.NextPoint) {
			return out, bad
		}
	} else {
		if s.NextPoint != nil {
			return out, bad
		}
		out.RentBytes = append(out.RentBytes, 112)
	}
	if v.Operation == "requestExit" && amount == 0 {
		return out, bad
	}
	out.PositionAmount, out.PoolNext, out.PoolCustodied, out.EffectiveDay = amount, next, custodied, day+1
	return out, nil
}
