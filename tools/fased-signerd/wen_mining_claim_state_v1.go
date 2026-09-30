package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"math/big"
	"strconv"
)

// Internal observations only. A future composed reader must authenticate the
// offer/entry and obtain all records in one finalized, deployment-pinned batch.
// This validator establishes settlement consistency, not custody or signing.
type wenMiningClaimSnapshotV1 struct {
	Slot, Now, Open, Capacity, MinimumFill uint64
	Roster, Receipt, Claim                 *signerWENBTCAccountV1
}
type wenMiningClaimAllocationV1 struct {
	SOLGross, SATGross, Capital, Count uint64
	SOLPaid, SATPaid, Routed           bool
}

func validateWENMiningClaimSettlementV1(v signerWENMiningClaimIntentV1, owner solana.PublicKey, s wenMiningClaimSnapshotV1) (wenMiningClaimAllocationV1, error) {
	var out wenMiningClaimAllocationV1
	bad := errors.New("mining claim settlement rejected")
	ix, err := buildWENMiningClaimInstructionV1(v, owner)
	if err != nil {
		return out, err
	}
	num := func(x string) uint64 { n, _ := strconv.ParseUint(x, 10, 64); return n }
	if s.Slot < num(v.MinFinalizedSlot) || s.Slot >= num(v.ExpiresSlot) || s.Open == 0 || s.Open > uint64(1<<63-1)-900 || s.Now < s.Open+900 || s.Now > uint64(1<<63-1) || s.MinimumFill == 0 || s.MinimumFill > s.Capacity {
		return out, bad
	}
	p := ix.ProgramID()
	a := ix.Accounts()
	sale, offer, entry := a[1].PublicKey, a[2].PublicKey, a[5].PublicKey
	le := func(n uint64) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, n); return b }
	derive := func(seed string, parts ...[]byte) (solana.PublicKey, byte) {
		k, b, _ := solana.FindProgramAddress(append([][]byte{[]byte(seed)}, parts...), p)
		return k, b
	}
	check := func(r *signerWENBTCAccountV1, k solana.PublicKey, b byte, magic string, length int, state byte) bool {
		return r != nil && r.Address == k && r.Owner == p && !r.Executable && r.Slot == s.Slot && len(r.Data) == length && string(r.Data[:8]) == magic && r.Data[8] == 1 && r.Data[9] == 0 && r.Data[10] == state && r.Data[11] == b && bytes.Equal(r.Data[12:16], make([]byte, 4))
	}
	n := func(d []byte, o int) uint64 { return binary.LittleEndian.Uint64(d[o:]) }
	key := func(d []byte, o int, k solana.PublicKey) bool { return bytes.Equal(d[o:o+32], k[:]) }
	roster, rb := derive("wen-mining-roster-v1", sale[:], offer[:])
	if s.Roster == nil || len(s.Roster.Data) < 200 || (len(s.Roster.Data)-160)%40 != 0 {
		return out, bad
	}
	count := uint64((len(s.Roster.Data) - 160) / 40)
	ordinal := num(v.Ordinal)
	if !check(s.Roster, roster, rb, "WENMRST1", len(s.Roster.Data), 1) || ordinal >= count {
		return out, bad
	}
	r := s.Roster.Data
	if !key(r, 16, p) || !key(r, 48, sale) || !key(r, 80, offer) || n(r, 112) != s.Open || n(r, 120) != s.Capacity || n(r, 128) != s.MinimumFill || n(r, 136) >= s.Open || n(r, 144) != count {
		return out, bad
	}
	var total uint64
	for i := 0; i < int(count); i++ {
		o := 160 + i*40
		capital := n(r, o+32)
		if bytes.Equal(r[o:o+32], make([]byte, 32)) || capital == 0 || capital > ^uint64(0)-total || (i > 0 && bytes.Compare(r[o-40:o-8], r[o:o+32]) >= 0) {
			return out, bad
		}
		total += capital
	}
	if total != n(r, 152) || total < s.MinimumFill || total > s.Capacity || !key(r, 160+int(ordinal)*40, entry) {
		return out, bad
	}
	receipt, bump := derive("wen-mining-progress-v1", sale[:], offer[:])
	if s.Receipt == nil || len(s.Receipt.Data) != 352 {
		return out, bad
	}
	d := s.Receipt.Data
	magic := string(d[:8])
	if (magic != "WENMST01" && magic != "WENMST02") || !check(s.Receipt, receipt, bump, magic, 352, 1) {
		return out, bad
	}
	fund, _ := derive("wen-mining-lifecycle-fund-v1", sale[:], le(num(v.ID)))
	vault, _ := derive("wen-allocation-v1", sale[:], []byte{3})
	for i, k := range []solana.PublicKey{p, sale, offer, roster, fund, vault} {
		if !key(d, 16+32*i, k) {
			return out, bad
		}
	}
	execution := uint64(0)
	if magic == "WENMST02" {
		x := new(big.Int).SetUint64(n(d, 304))
		x.Mul(x, big.NewInt(2))
		x.Div(x, big.NewInt(100))
		execution = x.Uint64()
	}
	if n(d, 208) != num(v.ID) || n(d, 216) != s.Open || n(d, 224) < s.Open+900 || n(d, 224) > s.Now || n(d, 232) != count || n(d, 312) > n(d, 240) || n(d, 320) > n(d, 248) || n(d, 328) > count || n(d, 336) > count || n(d, 344) != execution {
		return out, bad
	}
	claim, cb := derive("wen-mining-claim-v1", sale[:], entry[:])
	if s.Claim == nil || len(s.Claim.Data) != 192 {
		return out, bad
	}
	c := s.Claim.Data
	flags := c[10]
	if flags > 3 || !check(s.Claim, claim, cb, "WENMCLM1", 192, flags) {
		return out, bad
	}
	for i, k := range []solana.PublicKey{p, sale, offer, entry, owner} {
		if !key(c, 16+i*32, k) {
			return out, bad
		}
	}
	sol, sat := n(c, 176), n(c, 184)
	if sol == 0 && sat == 0 {
		return out, bad
	}
	for i, amount := range []uint64{sol, sat} {
		paid := flags&(1<<i) != 0
		sum, done, paidCount := n(d, 240+i*8), n(d, 312+i*8), n(d, 328+i*8)
		if amount > sum || (paid && (paidCount == 0 || done < amount)) || (!paid && (paidCount >= count || sum-done < amount)) {
			return out, bad
		}
	}
	out = wenMiningClaimAllocationV1{sol, sat, n(r, 192+int(ordinal)*40), count, flags&1 != 0, flags&2 != 0, magic == "WENMST02"}
	gross, paid := out.SOLGross, out.SOLPaid
	if v.Operation == "sat" {
		gross, paid = out.SATGross, out.SATPaid
	}
	if paid || gross != num(v.ExpectedGross) {
		return wenMiningClaimAllocationV1{}, bad
	}
	return out, nil
}
