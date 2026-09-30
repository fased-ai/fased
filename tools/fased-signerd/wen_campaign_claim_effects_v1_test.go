package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

func TestWENCampaignClaimEffectsV1(t *testing.T) {
	s := campaignClaimExecutionSnapshot(solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey())
	ix, _, e := buildWENCampaignClaimV1(s)
	if e != nil {
		t.Fatal(e)
	}
	keys := []solana.PublicKey{}
	for _, k := range ix.Accounts() {
		keys = append(keys, k.PublicKey)
	}
	for _, failed := range []bool{false, true} {
		m := &rpc.TransactionMeta{}
		if failed {
			m.Err = "fixture failure"
		}
		campaignClaimFixtureTokenRows(s, keys, m)
		if e := verifyWENCampaignClaimEffectsV1(s, keys, m); e != nil {
			t.Fatal(e)
		}
		changes := map[string]func(*rpc.TransactionMeta){
			"wrong-net":         func(m *rpc.TransactionMeta) { m.PostTokenBalances[0].UiTokenAmount.Amount = "969" },
			"missing-vault":     func(m *rpc.TransactionMeta) { m.PostTokenBalances = m.PostTokenBalances[:1] },
			"duplicate":         func(m *rpc.TransactionMeta) { m.PostTokenBalances[1] = m.PostTokenBalances[0] },
			"bad-index":         func(m *rpc.TransactionMeta) { m.PostTokenBalances[0].AccountIndex = 65535 },
			"bad-mint":          func(m *rpc.TransactionMeta) { m.PostTokenBalances[0].Mint = s.Economy },
			"bad-owner":         func(m *rpc.TransactionMeta) { m.PostTokenBalances[0].Owner = &s.Economy },
			"bad-token-program": func(m *rpc.TransactionMeta) { m.PostTokenBalances[0].ProgramId = &s.Program },
			"bad-decimals":      func(m *rpc.TransactionMeta) { m.PostTokenBalances[0].UiTokenAmount.Decimals = 9 },
			"noncanonical":      func(m *rpc.TransactionMeta) { m.PreTokenBalances[0].UiTokenAmount.Amount = "00" },
			"negative":          func(m *rpc.TransactionMeta) { m.PreTokenBalances[0].UiTokenAmount.Amount = "-1" },
			"overflow":          func(m *rpc.TransactionMeta) { m.PreTokenBalances[0].UiTokenAmount.Amount = "18446744073709551616" },
		}
		for name, mutate := range changes {
			t.Run(name, func(t *testing.T) {
				raw, _ := json.Marshal(m)
				var bad rpc.TransactionMeta
				json.Unmarshal(raw, &bad)
				mutate(&bad)
				if verifyWENCampaignClaimEffectsV1(s, keys, &bad) == nil {
					t.Fatal("bad receipt accepted")
				}
			})
		}
	}
}
