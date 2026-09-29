package main

import (
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"math/big"
	"strconv"
)

// Transaction metadata proves spendable token deltas, not the later account's
// withheld-fee extension. Pinned mint rules determine each transfer's fee.
func verifyWENCampaignClaimEffectsV1(s wenCampaignClaimSnapshotV1, keys []solana.PublicKey, m *rpc.TransactionMeta) error {
	return verifyWENCampaignClaimDestinationEffectsV1(s, s.Owner, keys, m)
}

func verifyWENCampaignClaimDestinationEffectsV1(s wenCampaignClaimSnapshotV1, authority solana.PublicKey, keys []solana.PublicKey, m *rpc.TransactionMeta) error {
	bad := errors.New("campaign claim token effects mismatch")
	_, amounts, e := validateWENCampaignClaimDestinationV1(s, authority)
	if e != nil || m == nil {
		return bad
	}
	type expected struct {
		owner solana.PublicKey
		delta *big.Int
	}
	want := map[solana.PublicKey]expected{s.Destination.Address: {authority, new(big.Int).SetUint64(amounts.Net)}}
	j := 0
	for i := 0; i < 8; i++ {
		if s.Mask&(1<<i) == 0 {
			continue
		}
		w := s.Windows[j]
		j++
		gross := binary.LittleEndian.Uint64(s.Page.Data[128+i*56+32:])
		want[w.Vault.Address] = expected{w.Window.Address, new(big.Int).Neg(new(big.Int).SetUint64(gross))}
	}
	if m.Err != nil {
		for k, v := range want {
			v.delta = new(big.Int)
			want[k] = v
		}
	}
	decode := func(rows []rpc.TokenBalance) (map[solana.PublicKey]uint64, error) {
		if len(rows) != len(want) {
			return nil, bad
		}
		out := map[solana.PublicKey]uint64{}
		for _, r := range rows {
			if int(r.AccountIndex) >= len(keys) || r.UiTokenAmount == nil || r.Owner == nil || r.ProgramId == nil {
				return nil, bad
			}
			key := keys[r.AccountIndex]
			w, ok := want[key]
			if !ok {
				return nil, bad
			}
			if _, exists := out[key]; exists {
				return nil, bad
			}
			if r.Mint != s.Mint.Address || *r.Owner != w.owner || *r.ProgramId != solana.Token2022ProgramID || r.UiTokenAmount.Decimals != 11 {
				return nil, bad
			}
			n, e := strconv.ParseUint(r.UiTokenAmount.Amount, 10, 64)
			if e != nil || strconv.FormatUint(n, 10) != r.UiTokenAmount.Amount {
				return nil, bad
			}
			out[key] = n
		}
		return out, nil
	}
	pre, e := decode(m.PreTokenBalances)
	if e != nil {
		return e
	}
	post, e := decode(m.PostTokenBalances)
	if e != nil {
		return e
	}
	for k, w := range want {
		delta := new(big.Int).Sub(new(big.Int).SetUint64(post[k]), new(big.Int).SetUint64(pre[k]))
		if delta.Cmp(w.delta) != 0 {
			return bad
		}
	}
	return nil
}
