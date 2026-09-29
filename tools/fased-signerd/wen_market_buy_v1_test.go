package main

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"testing"

	solana "github.com/gagliardetto/solana-go"
)

type wenMarketVectorV1 struct {
	Profile, Program, Economy, Owner, SatAccount, QuoteAccount, Pool, Config, NetSat, BuyUSDC, BuyNetSat, MinimumNet, Blockhash, Message string
	SlippageBPS                                                                                                                          uint16
}

func wenMarketVectorsV1(t *testing.T) []wenMarketVectorV1 {
	t.Helper()
	raw, err := os.ReadFile("testdata/wen-market-buy-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Kind string
		Rows []wenMarketVectorV1
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Kind != "canonical-unsigned-buy-vectors-v1" || len(fixture.Rows) != 6 {
		t.Fatal("incomplete canonical vectors")
	}
	return fixture.Rows
}
func wenMarketVectorArgsV1(t *testing.T, v wenMarketVectorV1) (wenMarketBuyPinsV1, wenMarketBuyQuoteV1, wenMarketBuyLimitsV1) {
	t.Helper()
	number := func(s string) uint64 {
		n, e := strconv.ParseUint(s, 10, 64)
		if e != nil {
			t.Fatal(e)
		}
		return n
	}
	p := wenMarketBuyPinsV1{Profile: v.Profile, Program: solana.MustPublicKeyFromBase58(v.Program), Economy: solana.MustPublicKeyFromBase58(v.Economy), Owner: solana.MustPublicKeyFromBase58(v.Owner), AssetAccount: solana.MustPublicKeyFromBase58(v.SatAccount), CashAccount: solana.MustPublicKeyFromBase58(v.QuoteAccount), Pool: solana.MustPublicKeyFromBase58(v.Pool), Config: solana.MustPublicKeyFromBase58(v.Config)}
	q := wenMarketBuyQuoteV1{Pool: p.Pool, RequestedNet: number(v.NetSat), InputCash: number(v.BuyUSDC), QuotedNet: number(v.BuyNetSat), Slot: 100, ReferenceSlot: 101}
	l := wenMarketBuyLimitsV1{RequestedNet: q.RequestedNet, MaxCash: q.InputCash, MinimumNet: number(v.MinimumNet), MinimumSlot: 100, ExpiresSlot: 132, SlippageBPS: v.SlippageBPS}
	return p, q, l
}
func TestWENMarketBuyCanonicalMessageParity(t *testing.T) {
	for _, v := range wenMarketVectorsV1(t) {
		t.Run(v.Profile+"/"+v.NetSat, func(t *testing.T) {
			p, q, l := wenMarketVectorArgsV1(t, v)
			bh := solana.MustHashFromBase58(v.Blockhash)
			expected, e := hex.DecodeString(v.Message)
			if e != nil {
				t.Fatal(e)
			}
			message, e := compileWENMarketBuyV1(p, q, l, bh, 150, 200, nil)
			if e != nil {
				t.Fatal(e)
			}
			// SDKs order equal-role static keys differently. Resolve every key and
			// privilege independently, but freeze Fased's own reviewed bytes.
			for _, wire := range [][]byte{message, expected} {
				if e = verifyWENMarketBuyMessageV1(wire, p, q, l, bh, 150, 200); e != nil {
					t.Fatal("canonical instruction parity", e)
				}
			}
			if _, e = compileWENMarketBuyV1(p, q, l, bh, 151, 200, message); e != nil {
				t.Fatal("unchanged review rejected", e)
			}
			q.InputCash--
			if _, e = compileWENMarketBuyV1(p, q, l, bh, 151, 200, message); e == nil {
				t.Fatal("replacement message accepted")
			}
		})
	}
}
func TestWENMarketBuyRejectsUnboundInputs(t *testing.T) {
	p, q, l := wenMarketVectorArgsV1(t, wenMarketVectorsV1(t)[0])
	tests := []struct {
		name   string
		change func(*wenMarketBuyPinsV1, *wenMarketBuyQuoteV1, *wenMarketBuyLimitsV1)
	}{
		{"unknown profile", func(p *wenMarketBuyPinsV1, _ *wenMarketBuyQuoteV1, _ *wenMarketBuyLimitsV1) { p.Profile = "unknown" }},
		{"replaced pool", func(p *wenMarketBuyPinsV1, _ *wenMarketBuyQuoteV1, _ *wenMarketBuyLimitsV1) { p.Pool = p.Owner }},
		{"replaced quote pool", func(_ *wenMarketBuyPinsV1, q *wenMarketBuyQuoteV1, _ *wenMarketBuyLimitsV1) {
			q.Pool = solana.PublicKey{9}
		}},
		{"aliased custody", func(p *wenMarketBuyPinsV1, _ *wenMarketBuyQuoteV1, _ *wenMarketBuyLimitsV1) {
			p.CashAccount = p.AssetAccount
		}},
		{"empty owner", func(p *wenMarketBuyPinsV1, _ *wenMarketBuyQuoteV1, _ *wenMarketBuyLimitsV1) {
			p.Owner = solana.PublicKey{}
		}},
		{"over budget", func(_ *wenMarketBuyPinsV1, q *wenMarketBuyQuoteV1, _ *wenMarketBuyLimitsV1) { q.InputCash++ }},
		{"different size", func(_ *wenMarketBuyPinsV1, q *wenMarketBuyQuoteV1, _ *wenMarketBuyLimitsV1) { q.RequestedNet++ }},
		{"insufficient delivery", func(_ *wenMarketBuyPinsV1, q *wenMarketBuyQuoteV1, _ *wenMarketBuyLimitsV1) { q.QuotedNet-- }},
		{"weak minimum", func(_ *wenMarketBuyPinsV1, _ *wenMarketBuyQuoteV1, l *wenMarketBuyLimitsV1) { l.MinimumNet-- }},
		{"slippage", func(_ *wenMarketBuyPinsV1, _ *wenMarketBuyQuoteV1, l *wenMarketBuyLimitsV1) { l.SlippageBPS = 51 }},
		{"expired", func(_ *wenMarketBuyPinsV1, q *wenMarketBuyQuoteV1, _ *wenMarketBuyLimitsV1) { q.ReferenceSlot = 132 }},
		{"predates read", func(_ *wenMarketBuyPinsV1, q *wenMarketBuyQuoteV1, _ *wenMarketBuyLimitsV1) { q.Slot = 99 }},
		{"reversed observations", func(_ *wenMarketBuyPinsV1, q *wenMarketBuyQuoteV1, _ *wenMarketBuyLimitsV1) { q.ReferenceSlot = 99 }},
		{"widened freshness", func(_ *wenMarketBuyPinsV1, _ *wenMarketBuyQuoteV1, l *wenMarketBuyLimitsV1) { l.ExpiresSlot = 133 }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			pp, qq, ll := p, q, l
			tc.change(&pp, &qq, &ll)
			if _, err := buildWENMarketBuyV1(pp, qq, ll); err == nil {
				t.Fatal("unsafe input accepted")
			}
		})
	}
	for _, bh := range []solana.Hash{{}, solana.MustHashFromBase58(wenMarketVectorsV1(t)[0].Blockhash)} {
		if _, err := compileWENMarketBuyV1(p, q, l, bh, 200, 200, nil); err == nil {
			t.Fatal("expired lifetime accepted")
		}
	}
}

func TestWENMarketBuyRejectsAlteredMessage(t *testing.T) {
	v := wenMarketVectorsV1(t)[0]
	p, q, l := wenMarketVectorArgsV1(t, v)
	bh := solana.MustHashFromBase58(v.Blockhash)
	raw, e := compileWENMarketBuyV1(p, q, l, bh, 150, 200, nil)
	if e != nil {
		t.Fatal(e)
	}
	cases := []struct {
		name   string
		change func([]byte) []byte
	}{
		{"trailing", func(b []byte) []byte { return append(b, 0) }},
		{"truncated", func(b []byte) []byte { return b[:len(b)-1] }},
		{"different payer", func(b []byte) []byte { b[5] ^= 1; return b }},
		{"extra signer", func(b []byte) []byte { b[1] = 2; return b }},
		{"readonly payer", func(b []byte) []byte { b[2] = 1; return b }},
		{"privilege escalation", func(b []byte) []byte { b[3]--; return b }},
		{"amount", func(b []byte) []byte { b[len(b)-2] ^= 1; return b }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := tc.change(append([]byte(nil), raw...))
			if verifyWENMarketBuyMessageV1(b, p, q, l, bh, 150, 200) == nil {
				t.Fatal("altered message accepted")
			}
		})
	}
	if verifyWENMarketBuyMessageV1(raw, p, q, l, solana.Hash{8}, 150, 200) == nil {
		t.Fatal("replacement blockhash accepted")
	}
	if verifyWENMarketBuyMessageV1(raw, p, q, l, bh, 200, 200) == nil {
		t.Fatal("expired review accepted")
	}
}
