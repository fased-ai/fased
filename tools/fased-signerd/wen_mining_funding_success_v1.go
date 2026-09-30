package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

// The reconciler authenticates finalized chain and wire. This proves exact
// capital movement and the immutable paid action, without assuming a later
// vault/budget snapshot still equals its immediate post-transaction state.
func wenMiningFundingSuccessEffectsV1(r wenBudgetReservationV1, result *rpc.GetTransactionResult, paid *signerWENBTCAccountV1) string {
	if !wenMiningFundingSettlementScopesValidV1(r) || result == nil || result.Transaction == nil || result.Meta == nil || paid == nil {
		return ""
	}
	wire, e := wenSignedWireV1(r, r.SignedMessage)
	if e != nil || !bytes.Equal(wire, result.Transaction.GetBinary()) {
		return ""
	}
	native, debit := wenSuccessNativeEffectsV1(r, result)
	if native == "" || debit != result.Meta.Fee || result.Meta.Fee > r.MiningFundingPrepared.Fee || len(result.Meta.PreTokenBalances) != 0 || len(result.Meta.PostTokenBalances) != 0 {
		return ""
	}
	v := *r.MiningFundingIntent
	w := solana.MustPublicKeyFromBase58(r.WalletPublicKey)
	ix, e := buildWENMiningFundingInstructionV1(v, w)
	if e != nil {
		return ""
	}
	a := ix.Accounts()
	p := ix.ProgramID()
	n := func(s string) uint64 { x, _ := strconv.ParseUint(s, 10, 64); return x }
	nonce := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonce, n(v.Nonce))
	vault := a[0].PublicKey
	_, bump, e := solana.FindProgramAddress([][]byte{[]byte("wen-portfolio-action-v1"), vault[:], nonce}, p)
	if e != nil {
		return ""
	}
	d := paid.Data
	if paid.Address != a[1].PublicKey || paid.Owner != p || paid.Executable || paid.Slot < result.Slot || len(d) != 112 || string(d[:8]) != "WENPVA01" || d[8] != 1 || d[9] != 0 || d[10] != 1 || d[11] != bump || !bytes.Equal(d[12:16], make([]byte, 4)) || !bytes.Equal(d[16:48], vault[:]) || binary.LittleEndian.Uint64(d[48:]) != n(v.Nonce) || binary.LittleEndian.Uint64(d[56:]) != n(v.Amount) || binary.LittleEndian.Uint64(d[64:]) != n(v.Deadline) || !bytes.Equal(d[72:104], a[5].PublicKey[:]) || !bytes.Equal(d[104:], make([]byte, 8)) {
		return ""
	}
	sawVault, sawCapital := false, false
	for i := 1; i < len(r.AccountKeys); i++ {
		pre, post := result.Meta.PreBalances[i], result.Meta.PostBalances[i]
		switch r.AccountKeys[i] {
		case vault.String():
			if pre < post || pre-post != n(v.Amount) {
				return ""
			}
			sawVault = true
		case a[5].PublicKey.String():
			if post < pre || post-pre != n(v.Amount) {
				return ""
			}
			sawCapital = true
		default:
			if pre != post {
				return ""
			}
		}
	}
	if !sawVault || !sawCapital {
		return ""
	}
	raw, e := json.Marshal(struct {
		Native, Message string
		Paid            []byte
		Slot            uint64
	}{native, r.MessageSHA256, d, result.Slot})
	if e != nil {
		return ""
	}
	return wenHashV1(raw)
}
