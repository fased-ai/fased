package main

import (
	"bytes"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

// Receipt proof only: historical eligibility and withheld-fee custody need their
// own account readback. The caller authenticates finalized wire and chain.
func wenStakingSuccessEffectsV1(r wenBudgetReservationV1, result *rpc.GetTransactionResult) string {
	if !wenStakingSettlementScopesValidV1(r) || r.StakingPrepared == nil || result == nil || result.Meta == nil || result.Transaction == nil {
		return ""
	}
	if validateWENStakingFenceV1(r, r.MessageSHA256, r.AccountKeys, []uint64{r.MinExecutionSlot}) != nil {
		return ""
	}
	tx, e := solana.TransactionFromBytes(result.Transaction.GetBinary())
	if e != nil {
		return ""
	}
	message, e := tx.Message.MarshalBinary()
	if e != nil || !bytes.Equal(message, r.SignedMessage) || !bytes.Equal(message, r.StakingPrepared.Message) {
		return ""
	}
	native, debit := wenSuccessNativeEffectsV1(r, result)
	if native == "" || result.Meta.Fee > r.StakingPrepared.Fee || debit-result.Meta.Fee > r.StakingPrepared.Rent {
		return ""
	}
	v := *r.StakingIntent
	ix, e := buildWENStakingInstructionV1(v, solana.MustPublicKeyFromBase58(r.WalletPublicKey))
	if e != nil {
		return ""
	}
	a := ix.Accounts()
	allowed := map[string]bool{a[4].PublicKey.String(): true, a[6].PublicKey.String(): true, a[14].PublicKey.String(): true}
	for i, key := range r.AccountKeys {
		if i == 0 {
			continue
		}
		pre, post := result.Meta.PreBalances[i], result.Meta.PostBalances[i]
		if pre != post && (!allowed[key] || pre != 0 || post == 0) {
			return ""
		}
	}
	token, rows := wenSuccessTokenEffectsV1(r, result)
	if v.Operation == "deposit" && (token == "" || len(rows) != 2) {
		return ""
	}
	if v.Operation == "requestExit" && token == "" && (len(result.Meta.PreTokenBalances) != 0 || len(result.Meta.PostTokenBalances) != 0) {
		return ""
	}
	gross, _ := strconv.ParseUint(v.Amount, 10, 64)
	_, net := wenSatTransferV1(gross)
	seen := map[string]bool{}
	for _, row := range rows {
		owner, delta := "", "0"
		switch row.Account {
		case v.TokenAccount:
			owner = r.WalletPublicKey
			if v.Operation == "deposit" {
				delta = "-" + v.Amount
			}
		case a[7].PublicKey.String():
			owner = a[3].PublicKey.String()
			if v.Operation == "deposit" {
				delta = strconv.FormatUint(net, 10)
			}
		default:
			return ""
		}
		if seen[row.Account] || !row.PrePresent || !row.PostPresent || row.Mint != v.Mint || row.Owner != owner || row.Program != solana.Token2022ProgramID.String() || row.Decimals != 11 || row.DeltaRaw != delta {
			return ""
		}
		seen[row.Account] = true
	}
	raw, e := json.Marshal(struct {
		Native, Token, Message string
		Slot                   uint64
	}{native, token, r.MessageSHA256, result.Slot})
	if e != nil {
		return ""
	}
	return wenHashV1(raw)
}
