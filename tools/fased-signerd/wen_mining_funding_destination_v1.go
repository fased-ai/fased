package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"math"
)

type wenMiningFundingDestinationV1 struct {
	Slot, CapitalLamports, CapitalRent uint64
	Sale, Budget, Capital, Owner       *signerWENBTCAccountV1
}

func validateWENMiningFundingDestinationV1(v signerWENMiningFundingIntentV1, owner solana.PublicKey, s wenMiningFundingDestinationV1) error {
	ix, e := buildWENMiningFundingInstructionV1(v, owner)
	if e != nil {
		return e
	}
	p := ix.ProgramID()
	a := ix.Accounts()
	sale := a[3].PublicKey
	bad := errors.New("mining funding destination rejected")
	n := func(d []byte, o int) uint64 { return binary.LittleEndian.Uint64(d[o:]) }
	key := func(d []byte, o int, k solana.PublicKey) bool { return bytes.Equal(d[o:o+32], k[:]) }
	check := func(r *signerWENBTCAccountV1, k solana.PublicKey, length int, magic string) bool {
		if r == nil || r.Address != k || r.Owner != p || r.Executable || r.Slot != s.Slot || len(r.Data) != length {
			return false
		}
		d := r.Data
		return string(d[:8]) == magic && d[8] == 1 && d[9] == 0 && bytes.Equal(d[12:16], make([]byte, 4))
	}
	if s.Owner == nil || s.Owner.Address != owner || s.Owner.Owner != solana.SystemProgramID || s.Owner.Executable || s.Owner.Slot != s.Slot || len(s.Owner.Data) != 0 || s.Sale == nil || s.Sale.Address != sale || s.Sale.Owner != p || s.Sale.Executable || s.Sale.Slot != s.Slot || !validWENSaleScheduleV1(s.Sale.Data) || !check(s.Budget, a[4].PublicKey, 1712, "WENMBD01") || !check(s.Capital, a[5].PublicKey, 80, "WENMCP01") {
		return bad
	}
	d, b, c := s.Sale.Data, s.Budget.Data, s.Capital.Data
	expected, sb, e := solana.FindProgramAddress([][]byte{[]byte("wen-genesis-v1"), d[16:48], d[48:80]}, p)
	if e != nil {
		return e
	}
	if expected != sale || d[11] != sb || d[10] != 3 || n(d, 160) <= n(d, 152) || n(d, 176) > n(d, 168) || n(d, 184) > n(d, 168) || n(d, 176) > 200000000000 {
		return bad
	}
	_, bb, e := solana.FindProgramAddress([][]byte{[]byte("wen-mining-budget-v1"), sale[:], owner[:]}, p)
	if e != nil {
		return e
	}
	_, cb, e := solana.FindProgramAddress([][]byte{[]byte("wen-mining-capital-v1"), sale[:], owner[:]}, p)
	if e != nil {
		return e
	}
	if b[10] > 1 || b[11] != bb || !key(b, 16, sale) || !key(b, 48, owner) || !key(b, 80, a[5].PublicKey) || n(b, 128) > n(b, 136) || n(b, 144) == 0 || c[10] != 0 || c[11] != cb || !key(c, 16, sale) || !key(c, 48, owner) {
		return bad
	}
	for i := 0; i < 97; i++ {
		tag, spent := n(b, 160+i*16), n(b, 168+i*16)
		if spent > 0 && (tag%97 != uint64(i) || tag > n(b, 152)/900) {
			return bad
		}
	}
	if s.CapitalRent == 0 || s.CapitalRent > math.MaxUint64-n(b, 136) || s.CapitalLamports < s.CapitalRent+n(b, 136) {
		return bad
	}
	return nil
}
