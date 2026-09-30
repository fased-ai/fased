package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
)

func validateWENStakingActivationV1(v signerWENStakingIntentV1, slot, now uint64, sale, activation *signerWENBTCAccountV1) error {
	bad := errors.New("staking sale activation rejected")
	if validateWENStakingIntentV1(v) != nil {
		return bad
	}
	return validateWENLaunchActivationV1(solana.MustPublicKeyFromBase58(v.ProgramID), solana.MustPublicKeyFromBase58(v.Sale), slot, now, sale, activation)
}

// Shared launch validation does not reinterpret a reward mint as a staking mint.
func validateWENLaunchActivationV1(p, key solana.PublicKey, slot, now uint64, sale, activation *signerWENBTCAccountV1) error {
	bad := errors.New("sale activation rejected")
	if p.IsZero() || key.IsZero() || now > uint64(1<<63-1) {
		return bad
	}
	envelope := func(a *signerWENBTCAccountV1, k solana.PublicKey, magic string, n int) bool {
		return a != nil && a.Address == k && a.Owner == p && !a.Executable && a.Slot == slot && len(a.Data) == n && string(a.Data[:8]) == magic && a.Data[8] == 1 && a.Data[9] == 0 && bytes.Equal(a.Data[12:16], make([]byte, 4))
	}
	if sale == nil || sale.Address != key || sale.Owner != p || sale.Executable || sale.Slot != slot || !validWENSaleScheduleV1(sale.Data) {
		return bad
	}
	d := sale.Data
	expected, b, e := solana.FindProgramAddress([][]byte{[]byte("wen-genesis-v1"), d[16:48], d[48:80]}, p)
	if e != nil || expected != key || d[11] != b || d[10] != 3 {
		return bad
	}
	n := func(o int) uint64 { return binary.LittleEndian.Uint64(d[o:]) }
	open, close, deadline, total, accepted, refunded := n(144), n(152), n(160), n(168), n(176), n(184)
	if accepted < 50000000000 || accepted > 200000000000 || accepted > total || refunded > total || deadline <= close || close < open {
		return bad
	}
	address, b, e := solana.FindProgramAddress([][]byte{[]byte("wen-activation-v1"), key[:]}, p)
	if e != nil || !envelope(activation, address, "WENACTR1", 160) {
		return bad
	}
	a := activation.Data
	if a[10] != 1 || a[11] != b || !bytes.Equal(a[16:48], key[:]) || !bytes.Equal(a[128:160], d[48:80]) || binary.LittleEndian.Uint64(a[80:]) > now {
		return bad
	}
	scaled := accepted * 100000
	minted := scaled / 2
	staking := minted - scaled/3 - scaled*40/300 - scaled*6/300
	if binary.LittleEndian.Uint64(a[88:]) != minted || binary.LittleEndian.Uint64(a[120:]) != staking {
		return bad
	}
	return nil
}
