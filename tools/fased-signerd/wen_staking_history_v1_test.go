package main

import (
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

func stakingHistoryFixture(t *testing.T, same bool, override ...solana.PublicKey) (signerWENStakingIntentV1, solana.PublicKey, wenStakingHistorySnapshotV1) {
	t.Helper()
	f := stakingReviewFixture(t)
	v := f.Intent
	if len(override) > 0 {
		v.Sale = override[0].String()
		p := solana.MustPublicKeyFromBase58(v.ProgramID)
		mint, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), override[0][:]}, p)
		if e != nil {
			t.Fatal(e)
		}
		v.Mint = mint.String()
	}
	v.Last = "9"
	v.AggregateFrom = "9"
	day := uint64(9)
	if same {
		v.Last = "11"
		v.AggregateFrom = "11"
		day = 11
	}
	p, sale, mint, w := solana.MustPublicKeyFromBase58(v.ProgramID), solana.MustPublicKeyFromBase58(v.Sale), solana.MustPublicKeyFromBase58(v.Mint), solana.MustPublicKeyFromBase58(f.Wallet)
	if len(override) > 1 {
		w = override[1]
	}
	le := func(n uint64) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, n); return b }
	rec := func(seed, magic string, n int, who solana.PublicKey, ver byte, extra ...[]byte) *signerWENBTCAccountV1 {
		seeds := [][]byte{[]byte(seed), sale[:]}
		key, b, e := solana.FindProgramAddress(append(seeds, extra...), p)
		if e != nil {
			t.Fatal(e)
		}
		d := make([]byte, n)
		copy(d, magic)
		d[8] = ver
		d[11] = b
		copy(d[16:], sale[:])
		copy(d[48:], who[:])
		return &signerWENBTCAccountV1{Address: key, Owner: p, Slot: 100, Data: d}
	}
	put := func(a *signerWENBTCAccountV1, o int, n uint64) { binary.LittleEndian.PutUint64(a.Data[o:], n) }
	s := wenStakingHistorySnapshotV1{Slot: 100, Now: 864001}
	s.Pool = rec("wen-stake-pool-v1", "WENSTK01", 112, mint, 2)
	put(s.Pool, 80, 10)
	put(s.Pool, 88, 100)
	put(s.Pool, 96, 100)
	put(s.Pool, 104, 100)
	s.Position = rec("wen-stake-position-v1", "WENSTP01", 104, w, 1, w[:])
	put(s.Position, 80, 100)
	put(s.Position, 96, day)
	s.History = rec("wen-stake-history-v1", "WENSTH01", 104, w, 1, w[:], le(day))
	put(s.History, 80, day)
	put(s.History, 88, ^uint64(0))
	put(s.History, 96, 100)
	s.Index = rec("wen-stake-history-index-v1", "WENSTIX1", 96, mint, 1)
	put(s.Index, 80, day)
	put(s.Index, 88, 10)
	s.Point = rec("wen-stake-total-v1", "WENSTOT1", 112, s.Index.Address, 1, le(day))
	put(s.Point, 80, day)
	put(s.Point, 88, ^uint64(0))
	put(s.Point, 96, 100)
	if same {
		s.NextHistory = s.History
		s.NextPoint = s.Point
	}
	return v, w, s
}
func TestWENStakingHistoryV1(t *testing.T) {
	for _, same := range []bool{false, true} {
		for _, op := range []string{"deposit", "requestExit"} {
			v, w, s := stakingHistoryFixture(t, same)
			v.Operation = op
			if op == "requestExit" {
				v.Amount = "0"
			}
			out, e := validateWENStakingHistoryV1(v, w, s)
			if e != nil {
				t.Fatal(e)
			}
			want := 2
			if same {
				want = 0
			}
			if len(out.RentBytes) != want || out.PositionAmount != 100 || out.EffectiveDay != 11 {
				t.Fatal("wrong preview", out)
			}
		}
	}
	v, w, s := stakingHistoryFixture(t, false)
	v.Last = "0"
	s.Position = nil
	s.History = nil
	out, e := validateWENStakingHistoryV1(v, w, s)
	if e != nil || len(out.RentBytes) != 3 {
		t.Fatal("first deposit", e)
	}
	for _, mutate := range []func(*wenStakingHistorySnapshotV1){
		func(s *wenStakingHistorySnapshotV1) { s.Now += 86400 }, func(s *wenStakingHistorySnapshotV1) { s.Slot = 200 }, func(s *wenStakingHistorySnapshotV1) { s.Pool.Data[8] = 1 }, func(s *wenStakingHistorySnapshotV1) { s.Pool.Owner = w }, func(s *wenStakingHistorySnapshotV1) { s.Position.Data[88] = 1 }, func(s *wenStakingHistorySnapshotV1) { s.Position.Data[96] ^= 1 }, func(s *wenStakingHistorySnapshotV1) { s.History.Data[88] = 0 }, func(s *wenStakingHistorySnapshotV1) { s.Point.Data[96] ^= 1 }, func(s *wenStakingHistorySnapshotV1) { s.Index.Data[80] ^= 1 }, func(s *wenStakingHistorySnapshotV1) { s.Point.Slot++ }, func(s *wenStakingHistorySnapshotV1) { s.NextPoint = s.Point }, func(s *wenStakingHistorySnapshotV1) { s.NextHistory = s.History },
	} {
		v, w, s := stakingHistoryFixture(t, false)
		mutate(&s)
		if _, e := validateWENStakingHistoryV1(v, w, s); e == nil {
			t.Fatal("mutated history accepted")
		}
	}
}
