package main

import (
	"context"
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

func TestWENStakingHistoryRPCV1(t *testing.T) {
	for _, mode := range []string{"ok", "genesis", "genesis-change", "stale", "reference-behind", "reference-expired", "rpc-error", "nil-page", "reference-error", "code", "clock", "history"} {
		t.Run(mode, func(t *testing.T) {
			v, w, s := stakingHistoryFixture(t, false)
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
			page := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: vals}
			client := &wenReadRPCFake{t: t, genesis: solana.MustHashFromBase58(v.Genesis), page: page, addresses: keys, change: mode}
			result, e := readWENStakingHistoryRPCV1(context.Background(), client, pins, v, w, 2)
			if (e == nil) != (mode == "ok") {
				t.Fatal("unexpected historical readback", e)
			}
			if e == nil && result.Slot != 150 {
				t.Fatal("slot")
			}
		})
	}
}
