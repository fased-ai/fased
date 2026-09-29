package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

func TestWENStakingFullRPCV1(t *testing.T) {
	for _, mode := range []string{"ok", "genesis", "genesis-change", "stale", "reference-behind", "reference-expired", "rpc-error", "nil-page", "reference-error", "code", "clock", "history", "inactive", "allocation", "policy", "future-open", "sale-time", "token", "fee", "missing-custody"} {
		t.Run(mode, func(t *testing.T) {
			f := stakingReviewFixture(t)
			programKey := solana.MustPublicKeyFromBase58(f.Intent.ProgramID)
			creator := solana.MustPublicKeyFromBase58(f.Wallet)
			policy := solana.MustPublicKeyFromBase58(f.Intent.Genesis)
			saleKey, saleBump, _ := solana.FindProgramAddress([][]byte{[]byte("wen-genesis-v1"), creator[:], policy[:]}, programKey)
			pub, private, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			v, w, s, mint, custody, source := stakingTokenFixture(t, saleKey, solana.PublicKeyFromBytes(pub))
			saleData := make([]byte, 192)
			copy(saleData, "WENGEN01")
			saleData[8] = 1
			saleData[10] = 3
			saleData[11] = saleBump
			copy(saleData[16:], creator[:])
			copy(saleData[48:], policy[:])
			binary.LittleEndian.PutUint64(saleData[152:], 604800)
			binary.LittleEndian.PutUint64(saleData[160:], 604801)
			binary.LittleEndian.PutUint64(saleData[168:], 50000000000)
			binary.LittleEndian.PutUint64(saleData[176:], 50000000000)
			_, ab, _ := solana.FindProgramAddress([][]byte{[]byte("wen-activation-v1"), saleKey[:]}, programKey)
			activation := make([]byte, 160)
			copy(activation, "WENACTR1")
			activation[8] = 1
			activation[10] = 1
			activation[11] = ab
			copy(activation[16:], saleKey[:])
			copy(activation[128:], policy[:])
			scaled := uint64(50000000000) * 100000
			binary.LittleEndian.PutUint64(activation[88:], scaled/2)
			binary.LittleEndian.PutUint64(activation[120:], scaled/2-scaled/3-scaled*40/300-scaled*6/300)
			switch mode {
			case "inactive":
				saleData[10] = 2
			case "allocation":
				activation[120] ^= 1
			case "policy":
				activation[128] ^= 1
			case "future-open":
				binary.LittleEndian.PutUint64(activation[80:], s.Now+1)
			case "sale-time":
				saleData[152] ^= 1
			case "token":
				custody.Data[108] = 2
			case "fee":
				mint.Data[276] ^= 1
			}

			p := solana.MustPublicKeyFromBase58(v.ProgramID)
			loader := solana.BPFLoaderUpgradeableProgramID
			pd, _, _ := solana.FindProgramAddress([][]byte{p[:]}, loader)
			code := []byte{1, 2, 3}
			pins := wenStakingPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, CodeSHA256: wenHashV1(code), DeploymentSlot: 50}
			program := make([]byte, 36)
			binary.LittleEndian.PutUint32(program, 2)
			copy(program[4:], pd[:])
			body := make([]byte, 48)
			binary.LittleEndian.PutUint32(body, 3)
			binary.LittleEndian.PutUint64(body[4:], 50)
			copy(body[45:], code)
			clock := make([]byte, 40)
			binary.LittleEndian.PutUint64(clock, 150)
			binary.LittleEndian.PutUint64(clock[32:], s.Now)
			if mode == "code" {
				body[45] ^= 1
			}
			if mode == "clock" {
				clock[0] ^= 1
			}
			if mode == "history" {
				s.History.Data[96] ^= 1
			}
			ix, e := buildWENStakingInstructionV1(v, w)
			if e != nil {
				t.Fatal(e)
			}
			m := ix.Accounts()
			keys := []solana.PublicKey{m[3].PublicKey, m[4].PublicKey, m[5].PublicKey, m[6].PublicKey, m[12].PublicKey, m[13].PublicKey, m[14].PublicKey, p, pd, solana.SysVarClockPubkey}
			account := func(d []byte, o solana.PublicKey, ex bool) *rpc.Account {
				return &rpc.Account{Owner: o, Executable: ex, Data: rpc.DataBytesOrJSONFromBytes(d)}
			}
			vals := []*rpc.Account{}
			for _, a := range []*signerWENBTCAccountV1{s.Pool, s.Position, s.History, s.NextHistory, s.Index, s.Point, s.NextPoint} {
				if a == nil {
					vals = append(vals, nil)
				} else {
					vals = append(vals, account(a.Data, a.Owner, false))
				}
			}
			vals = append(vals, account(program, loader, true), account(body, loader, false), account(clock, solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), false))
			keys = append(keys, m[1].PublicKey, m[2].PublicKey, m[8].PublicKey, m[7].PublicKey, m[9].PublicKey)
			vals = append(vals, account(saleData, p, false), account(activation, p, false), account(mint.Data, mint.Owner, false), account(custody.Data, custody.Owner, false), account(source.Data, source.Owner, false))
			if mode == "missing-custody" {
				vals[13] = nil
			}
			page := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: vals}
			client := &wenReadRPCFake{t: t, genesis: solana.MustHashFromBase58(v.Genesis), page: page, addresses: keys, change: mode}
			if mode == "ok" {
				checkStakingPreparation(t, client, v, w, pins, private)
				checkWENWithdrawalRPC(t, client, v, w, pins, private)
			}
			result, e := readWENStakingRPCV1(context.Background(), client, pins, v, w, 2)
			if (e == nil) != (mode == "ok") {
				t.Fatal("unexpected historical readback", e)
			}
			if e == nil && (result.History.Slot != 150 || result.Tokens.Net != 97) {
				t.Fatal("slot")
			}
		})
	}
}
