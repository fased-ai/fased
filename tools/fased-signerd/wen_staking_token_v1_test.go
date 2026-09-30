package main

import (
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"math/big"
	"testing"
)

func stakingTokenFixture(t *testing.T, override ...solana.PublicKey) (signerWENStakingIntentV1, solana.PublicKey, wenStakingHistorySnapshotV1, *signerWENBTCAccountV1, *signerWENBTCAccountV1, *signerWENBTCAccountV1) {
	v, w, s := stakingHistoryFixture(t, false, override...)
	v.Amount = "100"
	ix, e := buildWENStakingInstructionV1(v, w)
	if e != nil {
		t.Fatal(e)
	}
	a := ix.Accounts()
	sale := a[1].PublicKey
	collector, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-collector-v1"), sale[:]}, ix.ProgramID())
	rec := func(key solana.PublicKey, n int) *signerWENBTCAccountV1 {
		return &signerWENBTCAccountV1{Address: key, Owner: solana.Token2022ProgramID, Slot: s.Slot, Data: make([]byte, n)}
	}
	mint := rec(a[8].PublicKey, 278)
	d := mint.Data
	binary.LittleEndian.PutUint32(d, 1)
	copy(d[4:], sale[:])
	d[44] = 11
	d[45] = 1
	d[165] = 1
	binary.LittleEndian.PutUint16(d[166:], 1)
	binary.LittleEndian.PutUint16(d[168:], 108)
	copy(d[202:], collector[:])
	for _, o := range []int{72, 90} {
		binary.LittleEndian.PutUint64(d[170+o+8:], ^uint64(0))
		binary.LittleEndian.PutUint16(d[170+o+16:], 300)
	}
	token := func(key, owner solana.PublicKey, amount uint64) *signerWENBTCAccountV1 {
		r := rec(key, 178)
		copy(r.Data, a[8].PublicKey[:])
		copy(r.Data[32:], owner[:])
		binary.LittleEndian.PutUint64(r.Data[64:], amount)
		r.Data[108] = 1
		r.Data[165] = 2
		binary.LittleEndian.PutUint16(r.Data[166:], 2)
		binary.LittleEndian.PutUint16(r.Data[168:], 8)
		return r
	}
	return v, w, s, mint, token(a[7].PublicKey, a[3].PublicKey, 100), token(a[9].PublicKey, w, 1000)
}
func TestWENStakingTokensV1(t *testing.T) {
	v, w, s, m, c, src := stakingTokenFixture(t)
	out, e := validateWENStakingTokensV1(v, w, s, m, c, src)
	if e != nil || out.Net != 97 || out.Fee != 3 || out.NextTotal != 197 {
		t.Fatal(out, e)
	}
	v.Amount = "1"
	if _, e = validateWENStakingTokensV1(v, w, s, m, c, src); e == nil {
		t.Fatal("zero net accepted")
	}
	v.Amount = "2"
	out, e = validateWENStakingTokensV1(v, w, s, m, c, src)
	if e != nil || out.Net != 1 {
		t.Fatal("arbitrary minimum", e)
	}
	v.Operation = "requestExit"
	v.Amount = "0"
	out, e = validateWENStakingTokensV1(v, w, s, m, c, nil)
	if e != nil || out.Gross != 0 || out.Fee != 0 || out.NextTotal != 0 {
		t.Fatal("exit transferred tokens", e)
	}
	for _, mode := range []string{"cap", "custody-overflow", "fee-old", "fee-new", "authority", "collector", "decimals", "frozen", "delegate", "native", "close", "balance", "withheld", "slot", "unknown", "duplicate", "truncated", "mint-owner"} {
		t.Run(mode, func(t *testing.T) {
			v, w, s, m, c, src := stakingTokenFixture(t)
			switch mode {
			case "cap":
				m.Data[250] ^= 1
			case "custody-overflow":
				binary.LittleEndian.PutUint64(c.Data[64:], ^uint64(0))
			case "fee-old":
				m.Data[258] ^= 1
			case "fee-new":
				m.Data[276] ^= 1
			case "authority":
				m.Data[170] = 1
			case "collector":
				m.Data[202] ^= 1
			case "decimals":
				m.Data[44] = 8
			case "frozen":
				c.Data[108] = 2
			case "delegate":
				src.Data[72] = 1
			case "native":
				src.Data[109] = 1
			case "close":
				src.Data[129] = 1
			case "balance":
				binary.LittleEndian.PutUint64(src.Data[64:], 99)
			case "withheld":
				binary.LittleEndian.PutUint64(c.Data[170:], ^uint64(0))
			case "slot":
				src.Slot++
			case "unknown":
				src.Data[166] = 9
			case "duplicate":
				src.Data = append(src.Data, src.Data[166:]...)
			case "truncated":
				src.Data = src.Data[:170]
			case "mint-owner":
				m.Owner = w
			}
			if _, e := validateWENStakingTokensV1(v, w, s, m, c, src); e == nil {
				t.Fatal("invalid token state accepted")
			}
		})
	}
}
func TestWENSatFeeRoundingV1(t *testing.T) {
	for _, n := range []uint64{0, 1, 2, 33, 34, 99, 100, 101, 9007199254740993, ^uint64(0)} {
		fee, net := wenSatTransferV1(n)
		want := new(big.Int).SetUint64(n)
		want.Mul(want, big.NewInt(3))
		want.Add(want, big.NewInt(99))
		want.Div(want, big.NewInt(100))
		if fee != want.Uint64() || net != n-fee {
			t.Fatal("fee mismatch", n)
		}
	}
}
