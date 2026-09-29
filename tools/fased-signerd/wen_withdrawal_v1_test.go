package main

import (
	"encoding/binary"
	"encoding/json"
	"testing"
)

func TestWENWithdrawalPreviewV1(t *testing.T) {
	for _, mode := range []string{"ok", "early", "not-exiting", "gross", "minimum", "custody", "eligible", "next", "mint", "owner", "mixed-slot", "zero-position", "overflow", "bad-header", "wrong-mint"} {
		t.Run(mode, func(t *testing.T) {
			v, w, s, m, c, d := stakingTokenFixture(t)
			q := signerWENWithdrawalIntentV1{DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, Genesis: v.Genesis, ProgramID: v.ProgramID, Sale: v.Sale, Mint: v.Mint, TokenAccount: v.TokenAccount, Day: "11", ExpectedGross: "100", MinimumNet: "97", MaxFeeLamports: v.MaxFeeLamports, MinFinalizedSlot: v.MinFinalizedSlot, ExpiresSlot: v.ExpiresSlot}
			put := func(a *signerWENBTCAccountV1, o int, n uint64) { binary.LittleEndian.PutUint64(a.Data[o:], n) }
			put(s.Position, 88, 11)
			put(s.Position, 96, 11)
			put(s.Pool, 96, 0)
			switch mode {
			case "early":
				q.Day = "10"
			case "not-exiting":
				put(s.Position, 88, 0)
			case "gross":
				q.ExpectedGross = "101"
			case "minimum":
				q.MinimumNet = "98"
			case "custody":
				put(c, 64, 99)
			case "eligible":
				put(s.Pool, 80, 11)
			case "next":
				put(s.Pool, 96, 1)
			case "mint":
				m.Data[276] ^= 1
			case "owner":
				d.Data[32] ^= 1
			case "mixed-slot":
				d.Slot++
			case "zero-position":
				put(s.Position, 80, 0)
			case "overflow":
				put(d, 64, ^uint64(0))
			case "bad-header":
				s.Position.Data[11] ^= 1
			case "wrong-mint":
				q.Mint = q.TokenAccount
			}
			now := uint64(11 * 86400)
			if mode == "early" {
				now = 10 * 86400
			}
			out, e := previewWENWithdrawalV1(q, w, 100, now, s.Pool, s.Position, m, c, d)
			if (e == nil) != (mode == "ok") {
				t.Fatal(mode, out, e)
			}
			if mode == "ok" {
				if out.Gross != 100 || out.Net != 97 || out.Fee != 3 || out.RemainingCustodied != 0 || out.Eligible != 0 || out.Last != 11 {
					t.Fatal(out)
				}
				ix, e := buildWENWithdrawalInstructionV1(q, w)
				if e != nil {
					t.Fatal(e)
				}
				data, e := ix.Data()
				if e != nil || len(data) != 1 || data[0] != 12 || len(ix.Accounts()) != 9 {
					t.Fatal("wire")
				}
				for i, a := range ix.Accounts() {
					if a.IsSigner != (i == 0) || a.IsWritable != (i == 0 || i == 3 || i == 4 || i == 5 || i == 7) {
						t.Fatal("account role", i)
					}
				}
				raw, _ := json.Marshal(q)
				if _, e = decodeWENWithdrawalIntentV1(raw); e != nil {
					t.Fatal(e)
				}
				raw = append(raw[:len(raw)-1], []byte(",\"unexpected\":1}")...)
				if _, e = decodeWENWithdrawalIntentV1(raw); e == nil {
					t.Fatal("unknown field")
				}
			}
		})
	}
}
