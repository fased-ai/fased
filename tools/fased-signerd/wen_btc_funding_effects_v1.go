package main

import (
	"encoding/binary"
	"encoding/json"
	"math/big"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// Match observed movements to the offer and account roles in the exact admitted
// instruction. No reward income is inferred from subscription principal.
func wenSuccessFundingEffectsV1(r wenBudgetReservationV1, result *rpc.GetTransactionResult) string {
	tokenProof, rows := wenSuccessTokenEffectsV1(r, result)
	if tokenProof == "" {
		return ""
	}
	tx, err := solana.TransactionFromBytes(result.Transaction.GetBinary())
	if err != nil || len(tx.Message.Instructions) != 2 {
		return ""
	}
	ix := tx.Message.Instructions[1]
	d := []byte(ix.Data)
	if len(d) < 465 || int(ix.ProgramIDIndex) >= len(r.AccountKeys) || (d[0] != 111 && d[0] != 112) {
		return ""
	}
	program, err := solana.PublicKeyFromBase58(r.AccountKeys[ix.ProgramIDIndex])
	if err != nil {
		return ""
	}
	offer := d[1:465]
	key := func(i int) solana.PublicKey { return solana.PublicKeyFromBytes(offer[8+i*32 : 40+i*32]) }
	n := func(i int) uint64 { return binary.LittleEndian.Uint64(offer[328+i*8 : 336+i*8]) }
	sale := key(0)
	authority, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-activation-v1"), sale[:]}, program)
	if err != nil {
		return ""
	}
	role := func(i int) string {
		if i >= len(ix.Accounts) || int(ix.Accounts[i]) >= len(r.AccountKeys) {
			return ""
		}
		return r.AccountKeys[ix.Accounts[i]]
	}
	indices := map[string]int{}
	for i, k := range r.AccountKeys {
		indices[k] = i
	}
	byAccount := map[string]wenTokenEffectV1{}
	for _, row := range rows {
		byAccount[row.Account] = row
	}
	used := map[string]bool{}
	// Creation requires a zero-lamport pre-state and funded post-state as well as
	// the expected initialized token identity. Missing metadata otherwise rejects.
	delta := func(account string, mint, owner solana.PublicKey, decimals uint8, tokenProgram solana.PublicKey, created bool) (*big.Int, bool) {
		row, ok := byAccount[account]
		if !ok || row.Mint != mint.String() || row.Owner != owner.String() || row.Program != tokenProgram.String() || row.Decimals != decimals || !row.PostPresent {
			return nil, false
		}
		index, ok := indices[account]
		if !ok {
			return nil, false
		}
		pre := new(big.Int)
		if created {
			if result.Meta.PreBalances[index] != 0 || result.Meta.PostBalances[index] == 0 || row.PrePresent {
				return nil, false
			}
		} else {
			if !row.PrePresent {
				return nil, false
			}
			pre, _ = new(big.Int).SetString(row.PreRaw, 10)
		}
		post, _ := new(big.Int).SetString(row.PostRaw, 10)
		if pre == nil || post == nil {
			return nil, false
		}
		used[account] = true
		return post.Sub(post, pre), true
	}
	exact := func(account string, mint, owner solana.PublicKey, decimals uint8, tokenProgram solana.PublicKey, amount uint64, negative, created bool) bool {
		got, ok := delta(account, mint, owner, decimals, tokenProgram, created)
		if !ok {
			return false
		}
		want := new(big.Int).SetUint64(amount)
		if negative {
			want.Neg(want)
		}
		return got.Cmp(want) == 0
	}
	cash, asset := key(3), key(4)
	if n(10) > ^uint64(0)-n(12) {
		return ""
	}
	budget := n(10) + n(12)
	if d[0] == 111 {
		if len(d) != 569 || len(ix.Accounts) != 27 || n(9) != 0 || n(6) != 0 || n(7) != 0 || n(8) != 0 || budget > n(4) || n(11) > n(4)-budget {
			return ""
		}
		retained := n(4) - budget - n(11)
		record, err := solana.PublicKeyFromBase58(role(5))
		if err != nil {
			return ""
		}
		paid, err := solana.PublicKeyFromBase58(role(9))
		if err != nil {
			return ""
		}
		sat, err := solana.PublicKeyFromBase58(role(13))
		if err != nil {
			return ""
		}
		if !exact(role(1), cash, key(2), 6, solana.TokenProgramID, n(4), true, false) || !exact(role(2), cash, authority, 6, solana.TokenProgramID, retained, false, false) || !exact(role(3), cash, record, 6, solana.TokenProgramID, budget, false, true) || !exact(role(4), cash, authority, 6, solana.TokenProgramID, n(11), false, false) || !exact(role(16), sat, paid, 11, solana.Token2022ProgramID, 0, false, true) {
			return ""
		}
		for _, row := range rows {
			if !used[row.Account] && (!row.PrePresent || !row.PostPresent || row.DeltaRaw != "0") {
				return ""
			}
		}
	} else {
		if len(ix.Accounts) < 23 {
			return ""
		}
		record, err := solana.PublicKeyFromBase58(role(1))
		if err != nil {
			return ""
		}
		if !exact(role(2), cash, record, 6, solana.TokenProgramID, budget, true, false) || !exact(role(4), cash, authority, 6, solana.TokenProgramID, n(12), false, false) {
			return ""
		}
		received, ok := delta(role(3), asset, authority, 8, solana.TokenProgramID, false)
		if !ok || received.Sign() <= 0 || received.Cmp(new(big.Int).SetUint64(n(13))) < 0 {
			return ""
		}
		for _, i := range []int{11, 14} {
			index, ok := indices[role(i)]
			if !ok || result.Meta.PreBalances[index] != 0 || result.Meta.PostBalances[index] != 0 {
				return ""
			}
			if row, exists := byAccount[role(i)]; exists {
				if row.PrePresent && row.PreRaw != "0" || row.PostPresent && row.PostRaw != "0" {
					return ""
				}
			}
		}
		for _, row := range rows {
			if row.Owner == r.WalletPublicKey && (!row.PrePresent || !row.PostPresent || row.DeltaRaw != "0") {
				return ""
			}
		}
	}
	raw, _ := json.Marshal([]string{tokenProof, wenHashV1(d), strconv.FormatUint(result.Slot, 10)})
	return wenHashV1(raw)
}
