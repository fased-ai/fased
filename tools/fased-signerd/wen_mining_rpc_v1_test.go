package main

import (
	"context"
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

func TestWENMiningFinalizedReadbackV1(t *testing.T) {
	for _, mode := range []string{"ok", "genesis", "genesis-change", "stale", "reference-behind", "reference-expired", "rpc-error", "nil-page", "reference-error", "missing", "code", "clock", "negative-time", "owner", "entry", "pin", "expiry"} {
		t.Run(mode, func(t *testing.T) {
			f := miningFixture(t)
			v := f.Intent
			program := solana.MustPublicKeyFromBase58(v.ProgramID)
			loader := solana.MustPublicKeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")
			pd, _, _ := solana.FindProgramAddress([][]byte{program[:]}, loader)
			code := []byte{1, 2, 3}
			pins := wenMiningPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, CodeSHA256: wenHashV1(code), DeploymentSlot: 50}
			p := make([]byte, 36)
			binary.LittleEndian.PutUint32(p, 2)
			copy(p[4:], pd[:])
			body := make([]byte, 48)
			binary.LittleEndian.PutUint32(body, 3)
			binary.LittleEndian.PutUint64(body[4:], 50)
			copy(body[45:], code)
			clock := make([]byte, 40)
			binary.LittleEndian.PutUint64(clock, 150)
			binary.LittleEndian.PutUint64(clock[32:], 1000)
			if mode == "code" {
				body[45] ^= 1
			}
			if mode == "clock" {
				clock[0] ^= 1
			}
			if mode == "negative-time" {
				binary.LittleEndian.PutUint64(clock[32:], ^uint64(0))
			}
			if mode == "pin" {
				pins.CapabilitySHA256 = "00"
			}
			if mode == "expiry" {
				v.ExpiresSlot = "150"
			}
			keys := []solana.PublicKey{solana.MustPublicKeyFromBase58(v.Entry), program, pd, solana.MustPublicKeyFromBase58("SysvarC1ock11111111111111111111111111111111")}
			account := func(d []byte, o solana.PublicKey, e bool) *rpc.Account {
				return &rpc.Account{Owner: o, Executable: e, Data: rpc.DataBytesOrJSONFromBytes(d)}
			}
			page := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: []*rpc.Account{account(f.Vectors["admitted"], program, false), account(p, loader, true), account(body, loader, false), account(clock, solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), false)}}
			if mode == "missing" {
				page.Value[0] = nil
			}
			if mode == "owner" {
				page.Value[0].Owner = loader
			}
			if mode == "entry" {
				page.Value[0].Data = rpc.DataBytesOrJSONFromBytes(f.Vectors["committed"])
			}
			client := &wenReadRPCFake{t: t, genesis: solana.MustHashFromBase58(v.Genesis), page: page, addresses: keys, change: mode}
			result, err := readWENMiningRPCV1(context.Background(), client, pins, v, solana.MustPublicKeyFromBase58(f.Wallet), nil, 2)
			if (err == nil) != (mode == "ok") {
				t.Fatal("unexpected readback", err)
			}
			if err == nil {
				if result.Slot != 150 || result.Now != 1000 || client.calls != 2 {
					t.Fatal("unbound finalized observation")
				}
				page.Value[0].Data = rpc.DataBytesOrJSONFromBytes([]byte{1})
				if len(result.Data) != 272 {
					t.Fatal("borrowed data")
				}
			}
		})
	}
}
