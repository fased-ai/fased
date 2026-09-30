package main

import (
	"context"
	"crypto/ed25519"
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

func checkWENWithdrawalRPC(t *testing.T, base *wenReadRPCFake, v signerWENStakingIntentV1, w solana.PublicKey, pins wenStakingPinsV1, private ed25519.PrivateKey) {
	t.Helper()
	for _, mode := range []string{"ok", "genesis", "genesis-change", "stale", "reference-behind", "reference-expired", "rpc-error", "nil-page", "reference-error", "code", "clock", "inactive", "missing-destination", "early", "minimum", "changed-pins", "slot"} {
		t.Run("withdrawal/"+mode, func(t *testing.T) {
			q := signerWENWithdrawalIntentV1{DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, Genesis: v.Genesis, ProgramID: v.ProgramID, Sale: v.Sale, Mint: v.Mint, TokenAccount: v.TokenAccount, Day: "11", ExpectedGross: "100", MinimumNet: "97", MaxFeeLamports: v.MaxFeeLamports, MinFinalizedSlot: v.MinFinalizedSlot, ExpiresSlot: v.ExpiresSlot}
			client := *base
			client.calls = 0
			client.change = mode
			values := []*rpc.Account{}
			keys := []solana.PublicKey{}
			for _, i := range []int{0, 1, 13, 12, 14, 10, 11, 7, 8, 9} {
				a := *base.page.Value[i]
				a.Data = rpc.DataBytesOrJSONFromBytes(append([]byte(nil), a.Data.GetBinary()...))
				values = append(values, &a)
				keys = append(keys, base.addresses[i])
			}
			client.addresses = keys
			client.page = &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: values}
			put := func(i, o int, n uint64) {
				d := append([]byte(nil), values[i].Data.GetBinary()...)
				binary.LittleEndian.PutUint64(d[o:], n)
				values[i].Data = rpc.DataBytesOrJSONFromBytes(d)
			}
			put(0, 96, 0)
			put(1, 88, 11)
			put(1, 96, 11)
			put(9, 32, 11*86400)
			bound := pins
			switch mode {
			case "code":
				d := append([]byte(nil), values[8].Data.GetBinary()...)
				d[45] ^= 1
				values[8].Data = rpc.DataBytesOrJSONFromBytes(d)
			case "clock":
				put(9, 0, 149)
			case "inactive":
				d := append([]byte(nil), values[5].Data.GetBinary()...)
				d[10] = 2
				values[5].Data = rpc.DataBytesOrJSONFromBytes(d)
			case "missing-destination":
				values[4] = nil
			case "early":
				q.Day = "10"
				put(9, 32, 10*86400)
			case "minimum":
				q.MinimumNet = "98"
			case "changed-pins":
				bound.CapabilitySHA256 = wenHashV1([]byte("different"))
			case "slot":
				client.page.Context.Slot = 99
			}
			out, e := readWENWithdrawalRPCV1(context.Background(), &client, bound, q, w, 2)
			if (e == nil) != (mode == "ok") {
				t.Fatal("withdrawal readback", e)
			}
			if e == nil {
				if out.Slot != 150 || out.Preview.Net != 97 || out.Preview.RemainingCustodied != 0 {
					t.Fatal(out.Preview)
				}
				checkWithdrawalPreparation(t, &client, q, w, bound, private)
				// Returned evidence owns its bytes independently of the RPC response.
				before := out.Position.Data[80]
				put(1, 80, 200)
				if out.Position.Data[80] != before {
					t.Fatal("aliased response")
				}
			}
		})
	}
}
