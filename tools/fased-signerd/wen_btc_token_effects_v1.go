package main

import (
	"encoding/json"
	"math/big"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// Missing-side metadata is explicitly retained, never interpreted as a zero
// balance. Role-specific settlement must separately prove creation or closure.
type wenTokenEffectV1 struct {
	Account, Mint, Owner, Program string
	Decimals                      uint8
	PrePresent, PostPresent       bool
	PreRaw, PostRaw, DeltaRaw     string
}

func wenSuccessTokenEffectsV1(r wenBudgetReservationV1, result *rpc.GetTransactionResult) (string, []wenTokenEffectV1) {
	native, _ := wenSuccessNativeEffectsV1(r, result)
	if native == "" {
		return "", nil
	}
	meta := result.Meta
	if len(meta.PreTokenBalances)+len(meta.PostTokenBalances) == 0 {
		return "", nil
	}
	rows := make(map[uint16]wenTokenEffectV1)
	for side, balances := range [][]rpc.TokenBalance{meta.PreTokenBalances, meta.PostTokenBalances} {
		seen := map[uint16]bool{}
		for _, balance := range balances {
			i := balance.AccountIndex
			if int(i) >= len(r.AccountKeys) || seen[i] || balance.Mint.IsZero() || balance.Owner == nil || balance.Owner.IsZero() || balance.ProgramId == nil || (*balance.ProgramId != solana.TokenProgramID && *balance.ProgramId != solana.Token2022ProgramID) || balance.UiTokenAmount == nil {
				return "", nil
			}
			seen[i] = true
			amount := balance.UiTokenAmount.Amount
			n, err := strconv.ParseUint(amount, 10, 64)
			if err != nil || strconv.FormatUint(n, 10) != amount {
				return "", nil
			}
			row, exists := rows[i]
			if exists && (row.Mint != balance.Mint.String() || row.Owner != balance.Owner.String() || row.Program != balance.ProgramId.String() || row.Decimals != balance.UiTokenAmount.Decimals) {
				return "", nil
			}
			row.Account = r.AccountKeys[i]
			row.Mint = balance.Mint.String()
			row.Owner = balance.Owner.String()
			row.Program = balance.ProgramId.String()
			row.Decimals = balance.UiTokenAmount.Decimals
			if side == 0 {
				row.PrePresent = true
				row.PreRaw = amount
			} else {
				row.PostPresent = true
				row.PostRaw = amount
			}
			rows[i] = row
		}
	}
	ordered := make([]wenTokenEffectV1, 0, len(rows))
	for i := range r.AccountKeys {
		row, exists := rows[uint16(i)]
		if !exists {
			continue
		}
		if row.PrePresent && row.PostPresent {
			pre, _ := new(big.Int).SetString(row.PreRaw, 10)
			post, _ := new(big.Int).SetString(row.PostRaw, 10)
			row.DeltaRaw = post.Sub(post, pre).String()
		}
		ordered = append(ordered, row)
	}
	raw, err := json.Marshal(struct {
		Native string
		Tokens []wenTokenEffectV1
	}{native, ordered})
	if err != nil {
		return "", nil
	}
	return wenHashV1(raw), ordered
}
