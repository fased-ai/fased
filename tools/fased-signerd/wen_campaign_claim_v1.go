package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"math"
	"math/bits"
)

type wenCampaignClaimWindowV1 struct{ Window, Vault signerWENBTCAccountV1 }
type wenCampaignClaimSnapshotV1 struct {
	Program, Economy, Owner           solana.PublicKey
	Slot, ReferenceSlot               uint64
	Mask                              uint8
	Position, Page, Mint, Destination signerWENBTCAccountV1
	Windows                           []wenCampaignClaimWindowV1
}
type wenCampaignClaimAmountsV1 struct{ Gross, Fee, Net, Purchase uint64 }

// Unsigned reconstruction only. Does not authorize a socket operation or signing.
func buildWENCampaignClaimV1(s wenCampaignClaimSnapshotV1) (solana.Instruction, wenCampaignClaimAmountsV1, error) {
	return validateWENCampaignClaimDestinationV1(s, s.Owner)
}
func validateWENCampaignClaimDestinationV1(s wenCampaignClaimSnapshotV1, destinationOwner solana.PublicKey) (solana.Instruction, wenCampaignClaimAmountsV1, error) {
	var out wenCampaignClaimAmountsV1
	bad := errors.New("invalid campaign claim")
	fail := func() (solana.Instruction, wenCampaignClaimAmountsV1, error) {
		return nil, wenCampaignClaimAmountsV1{}, bad
	}
	if s.Program.IsZero() || s.Economy.IsZero() || s.Owner.IsZero() || s.Slot == 0 || s.Mask == 0 || bits.OnesCount8(s.Mask) > 4 || len(s.Windows) != bits.OnesCount8(s.Mask) {
		return fail()
	}
	record := func(a signerWENBTCAccountV1, magic string, size int) bool {
		return a.Owner == s.Program && !a.Executable && a.Slot == s.Slot && len(a.Data) == size && string(a.Data[:8]) == magic && a.Data[8] == 1 && a.Data[9] == 0 && bytes.Equal(a.Data[12:16], make([]byte, 4))
	}
	if !record(s.Position, "WENRPOS2", 256) || !record(s.Page, "WENRCLM2", 576) {
		return fail()
	}
	p, c := s.Position.Data, s.Page.Data
	field := func(d []byte, o int, k solana.PublicKey) bool { return bytes.Equal(d[o:o+32], k[:]) }
	mint, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), s.Economy[:]}, s.Program)
	if e != nil {
		return fail()
	}
	collector, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-sat-collector-v1"), s.Economy[:]}, s.Program)
	if e != nil {
		return fail()
	}
	pos, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-retail-position-v2"), s.Owner[:], mint[:]}, s.Program)
	if e != nil {
		return fail()
	}
	page, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-retail-claims-v2"), pos[:], c[80:88]}, s.Program)
	if e != nil {
		return fail()
	}
	if s.Position.Address != pos || s.Page.Address != page || !field(p, 16, s.Owner) || !field(p, 80, mint) || !field(c, 16, pos) || p[10] > 1 || p[184] != 0 || p[224] > 1 || p[225] > 1 || p[226] > 1 {
		return fail()
	}
	if validateWENSatMintV1(&s.Mint, mint, s.Economy, collector, s.Slot) != nil {
		return fail()
	}
	if _, _, e = validateWENSatCustodyV1(&s.Destination, s.Destination.Address, mint, destinationOwner, s.Slot, 0); e != nil {
		return fail()
	}
	keys := solana.AccountMetaSlice{solana.Meta(s.Owner).SIGNER(), solana.Meta(pos), solana.Meta(page).WRITE(), solana.Meta(mint), solana.Meta(s.Destination.Address).WRITE(), solana.Meta(solana.Token2022ProgramID)}
	n := func(d []byte, o int) uint64 { return binary.LittleEndian.Uint64(d[o : o+8]) }
	selected := 0
	for i := 0; i < 8; i++ {
		at := 128 + i*56
		occupied := c[at+48]
		chosen := s.Mask&(1<<i) != 0
		if occupied == 0 {
			if chosen || !bytes.Equal(c[at:at+56], make([]byte, 56)) {
				return fail()
			}
			continue
		}
		gross := n(c, at+32)
		if occupied != 1 || gross == 0 || !bytes.Equal(c[at+49:at+56], make([]byte, 7)) {
			return fail()
		}
		if !chosen {
			continue
		}
		wv := s.Windows[selected]
		selected++
		w := wv.Window
		if !record(w, "WENRCMP2", 256) {
			return fail()
		}
		b := w.Data
		if b[10] != 1 || !(b[11] <= 7 || b[11] >= 12 && b[11] <= 15 || b[11] >= 30 && b[11] <= 31 || b[11] >= 62 && b[11] <= 63) || !bytes.Equal(b[16:48], p[48:80]) || !field(b, 48, mint) || !field(b, 80, wv.Vault.Address) || !field(c, at, w.Address) {
			return fail()
		}
		window, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-retail-window-v2"), b[16:48], mint[:], b[112:120]}, s.Program)
		if e != nil || window != w.Address {
			return fail()
		}
		if _, _, e = validateWENSatCustodyV1(&wv.Vault, wv.Vault.Address, mint, w.Address, s.Slot, gross); e != nil {
			return fail()
		}
		fee, net := wenSatTransferV1(gross)
		purchase := n(c, at+40)
		if gross > math.MaxUint64-out.Gross || fee > math.MaxUint64-out.Fee || net > math.MaxUint64-out.Net || purchase > math.MaxUint64-out.Purchase {
			return fail()
		}
		out.Gross += gross
		out.Fee += fee
		out.Net += net
		out.Purchase += purchase
		keys = append(keys, solana.Meta(w.Address), solana.Meta(wv.Vault.Address).WRITE())
	}
	for i, k := range keys {
		if k.PublicKey == s.Program {
			return fail()
		}
		for _, earlier := range keys[:i] {
			if k.PublicKey == earlier.PublicKey {
				return fail()
			}
		}
	}
	return solana.NewInstruction(s.Program, keys, []byte{158, s.Mask}), out, nil
}
