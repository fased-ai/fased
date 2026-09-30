package main

import (
	"context"
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
	"testing"
)

func TestWENMiningPhaseV1(t *testing.T) {
	for _, op := range []string{"commit", "reveal"} {
		for _, tc := range []struct {
			now            uint64
			commit, reveal string
		}{
			{999, "waiting-open", "waiting-open"}, {1000, "ready-commit", "waiting-reveal"},
			{1179, "ready-commit", "waiting-reveal"}, {1180, "missed-commit", "ready-reveal"},
			{1899, "missed-commit", "ready-reveal"}, {1900, "expired", "expired"}, {2000, "expired", "expired"},
		} {
			t.Run(op+"/"+strconv.FormatUint(tc.now, 10), func(t *testing.T) {
				f := miningFixture(t)
				c, pins, v := miningPrepareSetup(t, f, op, "ok")
				clock := append([]byte(nil), c.page.Value[3].Data.GetBinary()...)
				binary.LittleEndian.PutUint64(clock[32:], tc.now)
				c.page.Value[3].Data = rpc.DataBytesOrJSONFromBytes(clock)
				got, e := readWENMiningPhaseRPCV1(context.Background(), c, c.root, pins, v, solana.MustPublicKeyFromBase58(f.Wallet), 2)
				want := tc.commit
				if op == "reveal" {
					want = tc.reveal
				}
				if e != nil || got != want {
					t.Fatal(got, want, e)
				}
			})
		}
		for _, mode := range []string{"code", "entry", "clock", "negative-time", "stale", "genesis", "intent"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				f := miningFixture(t)
				c, pins, v := miningPrepareSetup(t, f, op, "ok")
				// Waiting is not permission to accept an invalid account or deployment.
				clock := append([]byte(nil), c.page.Value[3].Data.GetBinary()...)
				binary.LittleEndian.PutUint64(clock[32:], 999)
				switch mode {
				case "clock":
					clock[0] ^= 1
				case "negative-time":
					binary.LittleEndian.PutUint64(clock[32:], ^uint64(0))
				case "code":
					pins.CodeSHA256 = wenHashV1([]byte("changed"))
				case "entry":
					v.EntrySHA256 = wenHashV1([]byte("changed"))
				case "stale":
					c.page.Context.Slot = 99
				case "genesis":
					pins.Genesis = "11111111111111111111111111111111"
				case "intent":
					v.Capital = "0"
				}
				c.page.Value[3].Data = rpc.DataBytesOrJSONFromBytes(clock)
				if _, e := readWENMiningPhaseRPCV1(context.Background(), c, c.root, pins, v, solana.MustPublicKeyFromBase58(f.Wallet), 2); e == nil {
					t.Fatal("invalid phase snapshot accepted")
				}
			})
		}
	}
}
