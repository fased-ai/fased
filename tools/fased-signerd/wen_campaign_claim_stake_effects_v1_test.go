package main

import (
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
	"testing"
)

func TestWENCampaignClaimStakeEffectsV1(t *testing.T) {
	for _, same := range []bool{false, true} {
		v, s, h := directCampaignStakeFixture(t, same)
		ix, result, e := buildWENCampaignClaimStakeV1(v, 970, s, h)
		if e != nil {
			t.Fatal(e)
		}
		keys := []solana.PublicKey{}
		for _, k := range ix.Accounts() {
			keys = append(keys, k.PublicKey)
		}
		row := func(k, owner solana.PublicKey, n uint64) rpc.TokenBalance {
			index := 0
			for i, key := range keys {
				if key == k {
					index = i
					break
				}
			}
			program := solana.Token2022ProgramID
			return rpc.TokenBalance{AccountIndex: uint16(index), Mint: s.Mint.Address, Owner: &owner, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Decimals: 11, Amount: strconv.FormatUint(n, 10)}}
		}
		for _, failed := range []bool{false, true} {
			m := &rpc.TransactionMeta{}
			dest, vault := uint64(1070), uint64(0)
			if failed {
				m.Err = "failed"
				dest = 100
				vault = 1000
			}
			m.PreTokenBalances = []rpc.TokenBalance{row(s.Destination.Address, h.Pool.Address, 100), row(s.Windows[0].Vault.Address, s.Windows[0].Window.Address, 1000)}
			m.PostTokenBalances = []rpc.TokenBalance{row(s.Destination.Address, h.Pool.Address, dest), row(s.Windows[0].Vault.Address, s.Windows[0].Window.Address, vault)}
			if e = verifyWENCampaignClaimStakeEffectsV1(v, 970, s, h, keys, m); e != nil {
				t.Fatal(e)
			}
			if verifyWENCampaignClaimEffectsV1(s, keys, m) == nil {
				t.Fatal("wallet route accepted pool custody")
			}
			for name, mutate := range map[string]func(*rpc.TransactionMeta){
				"net":       func(m *rpc.TransactionMeta) { m.PostTokenBalances[0].UiTokenAmount.Amount = "1069" },
				"owner":     func(m *rpc.TransactionMeta) { m.PostTokenBalances[0].Owner = &s.Owner },
				"vault":     func(m *rpc.TransactionMeta) { m.PostTokenBalances = m.PostTokenBalances[:1] },
				"duplicate": func(m *rpc.TransactionMeta) { m.PostTokenBalances[1] = m.PostTokenBalances[0] },
				"mint":      func(m *rpc.TransactionMeta) { m.PostTokenBalances[0].Mint = s.Economy },
				"index":     func(m *rpc.TransactionMeta) { m.PostTokenBalances[0].AccountIndex = 65535 },
			} {
				t.Run(name, func(t *testing.T) {
					raw, _ := json.Marshal(m)
					var bad rpc.TransactionMeta
					_ = json.Unmarshal(raw, &bad)
					mutate(&bad)
					if verifyWENCampaignClaimStakeEffectsV1(v, 970, s, h, keys, &bad) == nil {
						t.Fatal("invalid effects accepted")
					}
				})
			}
		}
		_, _, after := stakingHistoryFixture(t, true)
		put := func(a *signerWENBTCAccountV1, o int, n uint64) { binary.LittleEndian.PutUint64(a.Data[o:], n) }
		if !same {
			_, _, old := stakingHistoryFixture(t, false)
			after.History = old.History
			after.Point = old.Point
			put(after.History, 88, 11)
			put(after.Point, 88, 11)
		}
		put(after.Position, 80, result.NextPosition)
		put(after.NextHistory, 96, result.NextPosition)
		put(after.Pool, 96, result.NextTotal)
		put(after.Pool, 104, result.NextCustodied)
		put(after.NextPoint, 96, result.NextTotal)
		after.Slot = 150
		for _, a := range []*signerWENBTCAccountV1{after.Pool, after.Position, after.History, after.NextHistory, after.Index, after.Point, after.NextPoint} {
			a.Slot = 150
		}
		if e = validateWENCampaignClaimStakePoststateV1(v, 970, s, h, after, 150); e != nil {
			t.Fatal(e)
		}
		for _, a := range []*signerWENBTCAccountV1{after.Pool, after.Position, after.NextHistory, after.NextPoint} {
			a.Data[96] ^= 1
			if validateWENCampaignClaimStakePoststateV1(v, 970, s, h, after, 150) == nil {
				t.Fatal("wrong history accepted")
			}
			a.Data[96] ^= 1
		}
	}
}
