package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

func wenSatExtensionsV1(d []byte, kind byte, allowed map[uint16]int) (map[uint16][]byte, error) {
	bad := errors.New("invalid SAT extension")
	out := map[uint16][]byte{}
	if len(d) < 166 || d[165] != kind {
		return nil, bad
	}
	for at := 166; at < len(d); {
		if bytes.Equal(d[at:], make([]byte, len(d)-at)) {
			break
		}
		if at+4 > len(d) {
			return nil, bad
		}
		tag, n := binary.LittleEndian.Uint16(d[at:]), int(binary.LittleEndian.Uint16(d[at+2:]))
		at += 4
		expected, ok := allowed[tag]
		if !ok || n != expected || out[tag] != nil || at+n > len(d) {
			return nil, bad
		}
		out[tag] = d[at : at+n]
		at += n
	}
	return out, nil
}
func wenSatEnvelopeV1(a *signerWENBTCAccountV1, key solana.PublicKey, slot uint64) error {
	if a == nil || a.Address != key || a.Owner != solana.Token2022ProgramID || a.Executable || a.Slot != slot {
		return errors.New("SAT account identity mismatch")
	}
	return nil
}
func validateWENSatMintV1(a *signerWENBTCAccountV1, mint, sale, collector solana.PublicKey, slot uint64) error {
	if e := wenSatEnvelopeV1(a, mint, slot); e != nil {
		return e
	}
	d := a.Data
	ext, e := wenSatExtensionsV1(d, 1, map[uint16]int{1: 108})
	if e != nil {
		return e
	}
	f := ext[1]
	bad := errors.New("SAT mint fee policy rejected")
	if len(f) != 108 || !bytes.Equal(d[82:165], make([]byte, 83)) || binary.LittleEndian.Uint32(d) != 1 || !bytes.Equal(d[4:36], sale[:]) || d[44] != 11 || d[45] != 1 || binary.LittleEndian.Uint32(d[46:]) != 0 || !bytes.Equal(f[:32], make([]byte, 32)) || !bytes.Equal(f[32:64], collector[:]) {
		return bad
	}
	for _, o := range []int{72, 90} {
		if binary.LittleEndian.Uint64(f[o+8:]) != ^uint64(0) || binary.LittleEndian.Uint16(f[o+16:]) != 300 {
			return bad
		}
	}
	return nil
}
func validateWENSatCustodyV1(a *signerWENBTCAccountV1, key, mint, owner solana.PublicKey, slot, minimum uint64) (uint64, uint64, error) {
	if e := wenSatEnvelopeV1(a, key, slot); e != nil {
		return 0, 0, e
	}
	d := a.Data
	ext, e := wenSatExtensionsV1(d, 2, map[uint16]int{2: 8, 7: 0})
	if e != nil {
		return 0, 0, e
	}
	bad := errors.New("SAT custody rejected")
	if len(ext[2]) != 8 || !bytes.Equal(d[:32], mint[:]) || !bytes.Equal(d[32:64], owner[:]) || d[108] != 1 || binary.LittleEndian.Uint32(d[72:]) != 0 || binary.LittleEndian.Uint32(d[109:]) != 0 || binary.LittleEndian.Uint32(d[129:]) != 0 {
		return 0, 0, bad
	}
	amount := binary.LittleEndian.Uint64(d[64:])
	if amount < minimum {
		return 0, 0, bad
	}
	return amount, binary.LittleEndian.Uint64(ext[2]), nil
}

// Overflow-free ceil(gross * 3 / 100), including maximum u64 inputs.
func wenSatTransferV1(gross uint64) (fee, net uint64) {
	fee = (gross/100)*3 + ((gross%100)*3+99)/100
	return fee, gross - fee
}

type wenStakingTokenResultV1 struct{ Gross, Fee, Net, NextPosition, NextTotal uint64 }

// Consumes the same observed slot as history. Sale activation/RPC proof is separate.
func validateWENStakingTokensV1(v signerWENStakingIntentV1, w solana.PublicKey, s wenStakingHistorySnapshotV1, mint, custody, source *signerWENBTCAccountV1) (wenStakingTokenResultV1, error) {
	var out wenStakingTokenResultV1
	h, e := validateWENStakingHistoryV1(v, w, s)
	if e != nil {
		return out, e
	}
	ix, e := buildWENStakingInstructionV1(v, w)
	if e != nil {
		return out, e
	}
	a := ix.Accounts()
	p := ix.ProgramID()
	sale := a[1].PublicKey
	collector, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-sat-collector-v1"), sale[:]}, p)
	if e != nil {
		return out, e
	}
	if e = validateWENSatMintV1(mint, a[8].PublicKey, sale, collector, s.Slot); e != nil {
		return out, e
	}
	balance, withheld, e := validateWENSatCustodyV1(custody, a[7].PublicKey, a[8].PublicKey, a[3].PublicKey, s.Slot, h.PoolCustodied)
	if e != nil {
		return out, e
	}
	if v.Operation == "requestExit" {
		out.NextTotal = h.PoolNext - h.PositionAmount
		return out, nil
	}
	gross, _ := strconv.ParseUint(v.Amount, 10, 64)
	if _, _, e = validateWENSatCustodyV1(source, a[9].PublicKey, a[8].PublicKey, w, s.Slot, gross); e != nil {
		return out, e
	}
	fee, net := wenSatTransferV1(gross)
	bad := errors.New("invalid net staking capacity")
	if net == 0 {
		return out, bad
	}
	for _, base := range []uint64{h.PositionAmount, h.PoolNext, h.PoolCustodied, balance} {
		if net > ^uint64(0)-base {
			return out, bad
		}
	}
	if fee > ^uint64(0)-withheld {
		return out, bad
	}
	return wenStakingTokenResultV1{gross, fee, net, h.PositionAmount + net, h.PoolNext + net}, nil
}
