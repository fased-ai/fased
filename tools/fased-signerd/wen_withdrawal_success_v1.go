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
func wenWithdrawalSuccessEffectsV1(r wenBudgetReservationV1, result *rpc.GetTransactionResult) string {
	if !wenWithdrawalSettlementScopesValidV1(r) || r.WithdrawalPrepared == nil || result == nil || result.Meta == nil || result.Transaction == nil {
		return ""
	}
	if validateWENWithdrawalFenceV1(r, r.MessageSHA256, r.AccountKeys, []uint64{r.MinExecutionSlot}) != nil {
		return ""
	}
	tx, e := solana.TransactionFromBytes(result.Transaction.GetBinary())
	if e != nil {
		return ""
	}
	message, e := tx.Message.MarshalBinary()
	if e != nil || !bytes.Equal(message, r.SignedMessage) || !bytes.Equal(message, r.WithdrawalPrepared.Message) {
		return ""
	}
	native, debit := wenSuccessNativeEffectsV1(r, result)
	if native == "" || result.Meta.Fee > r.WithdrawalPrepared.Fee || debit != result.Meta.Fee || r.WithdrawalPrepared.Rent != 0 {
		return ""
	}
	v := *r.WithdrawalIntent
	ix, e := buildWENWithdrawalInstructionV1(v, solana.MustPublicKeyFromBase58(r.WalletPublicKey))
	if e != nil {
		return ""
	}
	a := ix.Accounts()
	for i := 1; i < len(r.AccountKeys); i++ {
		if result.Meta.PreBalances[i] != result.Meta.PostBalances[i] {
			return ""
		}
	}
	token, rows := wenSuccessTokenEffectsV1(r, result)
	if token == "" || len(rows) != 2 {
		return ""
	}
	gross, _ := strconv.ParseUint(v.ExpectedGross, 10, 64)
	minimum, _ := strconv.ParseUint(v.MinimumNet, 10, 64)
	_, net := wenSatTransferV1(gross)
	if net < minimum {
		return ""
	}
	seen := map[string]bool{}
	for _, row := range rows {
		owner, delta := "", ""
		switch row.Account {
		case v.TokenAccount:
			owner = r.WalletPublicKey
			delta = strconv.FormatUint(net, 10)
		case a[5].PublicKey.String():
			owner = a[3].PublicKey.String()
			delta = "-" + v.ExpectedGross
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
