package main

import (
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

func campaignClaimExecutionSnapshot(program, economy, owner solana.PublicKey) wenCampaignClaimSnapshotV1 {
	mint, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), economy[:]}, program)
	collector, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-collector-v1"), economy[:]}, program)
	pos, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-retail-position-v2"), owner[:], mint[:]}, program)
	page, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-retail-claims-v2"), pos[:], make([]byte, 8)}, program)
	issuer := solana.NewWallet().PublicKey()
	window, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-retail-window-v2"), issuer[:], mint[:], make([]byte, 8)}, program)
	vault, dest := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	rec := func(k solana.PublicKey, magic string, n int) signerWENBTCAccountV1 {
		d := make([]byte, n)
		copy(d, magic)
		d[8] = 1
		return signerWENBTCAccountV1{Address: k, Owner: program, Slot: 110, Data: d}
	}
	p, c, w := rec(pos, "WENRPOS2", 256), rec(page, "WENRCLM2", 576), rec(window, "WENRCMP2", 256)
	copy(p.Data[16:], owner[:])
	copy(p.Data[48:], issuer[:])
	copy(p.Data[80:], mint[:])
	copy(c.Data[16:], pos[:])
	copy(c.Data[48:], owner[:])
	copy(c.Data[128:], window[:])
	binary.LittleEndian.PutUint64(c.Data[160:], 1000)
	binary.LittleEndian.PutUint64(c.Data[168:], 80)
	c.Data[176] = 1
	w.Data[10] = 1
	copy(w.Data[16:], issuer[:])
	copy(w.Data[48:], mint[:])
	copy(w.Data[80:], vault[:])
	token := func(k, auth solana.PublicKey, amount uint64) signerWENBTCAccountV1 {
		d := make([]byte, 178)
		copy(d, mint[:])
		copy(d[32:], auth[:])
		binary.LittleEndian.PutUint64(d[64:], amount)
		d[108] = 1
		d[165] = 2
		d[166] = 2
		d[168] = 8
		return signerWENBTCAccountV1{Address: k, Owner: solana.Token2022ProgramID, Slot: 110, Data: d}
	}
	m := make([]byte, 278)
	m[0] = 1
	copy(m[4:], economy[:])
	m[44] = 11
	m[45] = 1
	m[165] = 1
	m[166] = 1
	m[168] = 108
	copy(m[202:], collector[:])
	for _, o := range []int{242, 260} {
		binary.LittleEndian.PutUint64(m[o+8:], ^uint64(0))
		binary.LittleEndian.PutUint16(m[o+16:], 300)
	}
	return wenCampaignClaimSnapshotV1{Program: program, Economy: economy, Owner: owner, Slot: 110, ReferenceSlot: 111, Mask: 1, Position: p, Page: c, Mint: signerWENBTCAccountV1{Address: mint, Owner: solana.Token2022ProgramID, Slot: 110, Data: m}, Destination: token(dest, owner, 0), Windows: []wenCampaignClaimWindowV1{{Window: w, Vault: token(vault, window, 1000)}}}
}
func campaignClaimRequestFromSnapshot(s wenCampaignClaimSnapshotV1) *wenCampaignClaimRequestV1 {
	q := &wenCampaignClaimRequestV1{Program: s.Program, Economy: s.Economy, Destination: s.Destination.Address, Mask: s.Mask}
	for _, w := range s.Windows {
		q.Windows = append(q.Windows, struct{ Window, Vault solana.PublicKey }{w.Window.Address, w.Vault.Address})
	}
	return q
}
func campaignClaimFixtureTokenRows(s wenCampaignClaimSnapshotV1, keys []solana.PublicKey, m *rpc.TransactionMeta) {
	row := func(k, owner solana.PublicKey, n uint64) rpc.TokenBalance {
		index := 0
		for i, a := range keys {
			if a == k {
				index = i
			}
		}
		program := solana.Token2022ProgramID
		return rpc.TokenBalance{AccountIndex: uint16(index), Mint: s.Mint.Address, Owner: &owner, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: strconv.FormatUint(n, 10), Decimals: 11}}
	}
	_, a, _ := buildWENCampaignClaimV1(s)
	net := a.Net
	if m.Err != nil {
		net = 0
	}
	m.PreTokenBalances = []rpc.TokenBalance{row(s.Destination.Address, s.Owner, 0)}
	m.PostTokenBalances = []rpc.TokenBalance{row(s.Destination.Address, s.Owner, net)}
	j := 0
	for i := 0; i < 8; i++ {
		if s.Mask&(1<<i) == 0 {
			continue
		}
		w := s.Windows[j]
		j++
		g := binary.LittleEndian.Uint64(s.Page.Data[128+i*56+32:])
		post := uint64(0)
		if m.Err != nil {
			post = g
		}
		m.PreTokenBalances = append(m.PreTokenBalances, row(w.Vault.Address, w.Window.Address, g))
		m.PostTokenBalances = append(m.PostTokenBalances, row(w.Vault.Address, w.Window.Address, post))
	}
}
