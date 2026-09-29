package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

// Receipt/account proof only. The recovery owner must authenticate finalized
// chain/wire; allocation is read exclusively from the durable message binding.
func wenNativeClaimSuccessEffectsV1(r wenBudgetReservationV1, result *rpc.GetTransactionResult, paid *signerWENBTCAccountV1) string {
	if !wenNativeClaimSettlementScopesValidV1(r) || r.NativeClaimPrepared == nil || result == nil || result.Transaction == nil || result.Meta == nil || paid == nil {
		return ""
	}
	if validateWENNativeClaimFenceV1(r, r.MessageSHA256, r.AccountKeys, []uint64{r.MinExecutionSlot}) != nil {
		return ""
	}
	tx, e := solana.TransactionFromBytes(result.Transaction.GetBinary())
	if e != nil {
		return ""
	}
	msg, e := tx.Message.MarshalBinary()
	if e != nil || !bytes.Equal(msg, r.SignedMessage) {
		return ""
	}
	native, debit := wenSuccessNativeEffectsV1(r, result)
	b := r.NativeClaimPrepared
	if native == "" || result.Meta.Fee > b.Fee || debit < result.Meta.Fee || debit-result.Meta.Fee > b.Rent {
		return ""
	}
	v := *r.NativeClaimIntent
	w := solana.MustPublicKeyFromBase58(r.WalletPublicKey)
	ix, e := buildWENNativeClaimInstructionV1(v, w)
	if e != nil {
		return ""
	}
	a := ix.Accounts()
	p := ix.ProgramID()
	funding := a[4].PublicKey
	pk, bump, e := solana.FindProgramAddress([][]byte{[]byte("wen-native-stake-claim-v1"), funding[:], w[:]}, p)
	if e != nil {
		return ""
	}
	d := paid.Data
	if paid.Address != pk || paid.Owner != p || paid.Executable || paid.Slot < result.Slot || len(d) != 112 || string(d[:8]) != "WENNSCL1" || d[8] != 1 || d[9] != 0 || d[10] != 0 || d[11] != bump || !bytes.Equal(d[12:16], make([]byte, 4)) || !bytes.Equal(d[16:48], funding[:]) || !bytes.Equal(d[48:80], w[:]) || binary.LittleEndian.Uint64(d[80:]) != r.NativeClaimPrepared.Gross || binary.LittleEndian.Uint64(d[88:]) != b.Net || binary.LittleEndian.Uint64(d[96:]) != b.Weight || binary.LittleEndian.Uint64(d[104:]) != mustNativeClaimDayV1(v) {
		return ""
	}
	found := false
	for i := 1; i < len(r.AccountKeys); i++ {
		pre, post := result.Meta.PreBalances[i], result.Meta.PostBalances[i]
		if r.AccountKeys[i] == pk.String() {
			if pre != 0 || post == 0 || post != debit-result.Meta.Fee {
				return ""
			}
			found = true
		} else if pre != post {
			return ""
		}
	}
	if !found {
		return ""
	}
	token, rows := wenSuccessTokenEffectsV1(r, result)
	if token == "" || len(rows) != 2 {
		return ""
	}
	for _, row := range rows {
		owner, delta := "", ""
		switch row.Account {
		case v.Destination:
			owner = w.String()
			delta = strconv.FormatUint(b.Net, 10)
		case a[8].PublicKey.String():
			owner = a[3].PublicKey.String()
			delta = "-" + strconv.FormatUint(r.NativeClaimPrepared.Gross, 10)
		default:
			return ""
		}
		if !row.PrePresent || !row.PostPresent || row.Owner != owner || row.Mint != v.Mint || row.Program != solana.Token2022ProgramID.String() || row.Decimals != 11 || row.DeltaRaw != delta {
			return ""
		}
	}
	raw, e := json.Marshal(struct {
		Native, Token, Message string
		Paid                   []byte
		Slot                   uint64
	}{native, token, r.MessageSHA256, d, result.Slot})
	if e != nil {
		return ""
	}
	return wenHashV1(raw)
}

func mustNativeClaimDayV1(v signerWENNativeClaimIntentV1) uint64 {
	n, _ := strconv.ParseUint(v.Award, 10, 64)
	return n / 3
}
