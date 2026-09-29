package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"

	solana "github.com/gagliardetto/solana-go"
)

// Candidate reconstruction only. No socket opcode or signing permission is
// added here. Snapshots must come from the future protected setup readback.
type wenCampaignSetupAccountV1 struct {
	Address, Owner solana.PublicKey
	Executable     bool
	Lamports       uint64
	Data           []byte
}
type wenCampaignSetupTermsV1 struct {
	Deposit, MaxPrice, Daily, Total, Expiry, MaxWait uint64
}
type wenCampaignSetupV1 struct {
	Program, Economy, Owner, Issuer    solana.PublicKey
	Now                                uint64
	Terms                              wenCampaignSetupTermsV1
	Position, Window, Registry, Member wenCampaignSetupAccountV1
}
type wenCampaignAllocationV1 struct {
	Address solana.PublicKey
	Bytes   uint64
}

func buildWENCampaignAtomicSetupV1(v wenCampaignSetupV1) (solana.Instruction, []wenCampaignAllocationV1, error) {
	bad := errors.New("invalid atomic campaign setup")
	fail := func() (solana.Instruction, []wenCampaignAllocationV1, error) { return nil, nil, bad }
	if v.Program.IsZero() || v.Owner.IsZero() || v.Economy.IsZero() || v.Issuer.IsZero() {
		return fail()
	}
	derive := func(seeds ...[]byte) (solana.PublicKey, error) {
		k, _, e := solana.FindProgramAddress(seeds, v.Program)
		return k, e
	}
	mint, e := derive([]byte("wen-sat-mint-v1"), v.Economy[:])
	if e != nil {
		return fail()
	}
	position, e := derive([]byte("wen-retail-position-v2"), v.Owner[:], mint[:])
	if e != nil {
		return fail()
	}
	empty := func(a wenCampaignSetupAccountV1) bool {
		return a.Owner == solana.SystemProgramID && !a.Executable && a.Lamports == 0 && len(a.Data) == 0
	}
	record := func(a wenCampaignSetupAccountV1, magic string, size int) bool {
		return a.Owner == v.Program && !a.Executable && len(a.Data) == size && string(a.Data[:8]) == magic && a.Data[8] == 1 && a.Data[9] == 0 && bytes.Equal(a.Data[12:16], make([]byte, 4))
	}
	field := func(data []byte, o int, k solana.PublicKey) bool { return bytes.Equal(data[o:o+32], k[:]) }
	if v.Position.Address != position || !empty(v.Position) || !record(v.Window, "WENRCMP2", 256) {
		return fail()
	}
	w := v.Window.Data
	flags := w[11]
	validFlags := flags <= 7 || (flags >= 12 && flags <= 15)
	if w[10] != 0 || !validFlags || flags&1 != 0 || !field(w, 16, v.Issuer) || !field(w, 48, mint) {
		return fail()
	}
	window, e := derive([]byte("wen-retail-window-v2"), v.Issuer[:], mint[:], w[112:120])
	if e != nil || window != v.Window.Address {
		return fail()
	}
	n := func(o int) uint64 { return binary.LittleEndian.Uint64(w[o : o+8]) }
	t := v.Terms
	if t.Deposit == 0 || t.Daily == 0 || t.Total == 0 || t.MaxWait == 0 || t.MaxPrice < n(120) || t.Expiry < n(136) || v.Now >= n(128) {
		return fail()
	}
	fee, reserved, float := n(232), n(248), n(240)
	// Subtraction/division avoids overflowing the three-job execution reserve.
	if fee == 0 || reserved > float || fee > (float-reserved)/3 || n(216) == math.MaxUint64 {
		return fail()
	}
	registry, e := derive([]byte("wen-retail-members-v2"), v.Issuer[:], mint[:])
	if e != nil || registry != v.Registry.Address {
		return fail()
	}
	allocations := []wenCampaignAllocationV1{{position, 256}}
	var index uint64
	if empty(v.Registry) {
		allocations = append(allocations, wenCampaignAllocationV1{registry, 112})
	} else {
		if !record(v.Registry, "WENRMEM2", 112) || !field(v.Registry.Data, 16, v.Issuer) || !field(v.Registry.Data, 48, mint) {
			return fail()
		}
		index = binary.LittleEndian.Uint64(v.Registry.Data[80:88])
	}
	if index == math.MaxUint64 {
		return fail()
	}
	var nonce [8]byte
	binary.LittleEndian.PutUint64(nonce[:], index)
	member, e := derive([]byte("wen-retail-member-v2"), registry[:], nonce[:])
	if e != nil || member != v.Member.Address || !empty(v.Member) {
		return fail()
	}
	allocations = append(allocations, wenCampaignAllocationV1{member, 80})
	keys := solana.AccountMetaSlice{solana.Meta(v.Owner).WRITE().SIGNER(), solana.Meta(position).WRITE(), solana.Meta(window).WRITE(), solana.Meta(registry).WRITE(), solana.Meta(member).WRITE(), solana.Meta(solana.SystemProgramID)}
	seen := map[solana.PublicKey]bool{v.Program: true}
	for _, k := range keys {
		if seen[k.PublicKey] {
			return fail()
		}
		seen[k.PublicKey] = true
	}
	data := make([]byte, 57)
	data[0] = 161
	for i, value := range []uint64{t.Deposit, t.MaxPrice, t.Daily, t.Total, t.Expiry, t.MaxWait, 0} {
		binary.LittleEndian.PutUint64(data[1+8*i:], value)
	}
	return solana.NewInstruction(v.Program, keys, data), allocations, nil
}
