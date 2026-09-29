package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

// Finalized metadata proves the exact wallet spend and delivered spendable SAT.
// No current balance or later quote can stand in for this transaction's effects.
func wenMarketOutcomeV1(r wenMarketReservationV1, result *rpc.GetTransactionResult) (fee, cash, net uint64, hash string, err error) {
	bad := errors.New("Buy finalized outcome mismatch")
	reject := func() (uint64, uint64, uint64, string, error) { return 0, 0, 0, "", bad }
	d, e := r.Artifact.digest()
	if e != nil || d != r.Digest || r.Version != 1 || (r.State != "submission-uncertain" && r.State != "finalized-success" && r.State != "finalized-failed") || result == nil || result.Meta == nil || result.Transaction == nil || result.Slot < r.Artifact.Binding.Snapshot.Quote.ReferenceSlot {
		return reject()
	}
	a := r.Artifact
	b := a.Binding
	sig, e := solana.SignatureFromBase58(r.Signature)
	if e != nil || !ed25519.Verify(ed25519.PublicKey(a.Pins.Owner[:]), b.Message, sig[:]) {
		return reject()
	}
	wire := make([]byte, 65+len(b.Message))
	wire[0] = 1
	copy(wire[1:65], sig[:])
	copy(wire[65:], b.Message)
	if !bytes.Equal(wire, result.Transaction.GetBinary()) {
		return reject()
	}
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		return reject()
	}
	keys := tx.Message.AccountKeys
	m := result.Meta
	if m.Fee != b.Fee || m.Fee > b.MaxFee || len(m.PreBalances) != len(keys) || len(m.PostBalances) != len(keys) {
		return reject()
	}
	for i, key := range keys {
		if key == a.Pins.Owner {
			if m.PreBalances[i] < m.Fee || m.PostBalances[i] != m.PreBalances[i]-m.Fee || m.PostBalances[i] < b.RetainedLamports {
				return reject()
			}
		} else if m.PreBalances[i] != m.PostBalances[i] {
			return reject()
		}
	}
	ix, e := buildWENMarketBuyV1(a.Pins, b.Snapshot.Quote, a.Limits)
	if e != nil {
		return reject()
	}
	metas := ix.Accounts()
	type tokenRole struct {
		owner, mint, program solana.PublicKey
		decimals             uint8
	}
	roles := map[solana.PublicKey]tokenRole{
		a.Pins.CashAccount:  {a.Pins.Owner, metas[10].PublicKey, solana.TokenProgramID, 6},
		a.Pins.AssetAccount: {a.Pins.Owner, metas[11].PublicKey, solana.Token2022ProgramID, 11},
		metas[6].PublicKey:  {metas[1].PublicKey, metas[10].PublicKey, solana.TokenProgramID, 6},
		metas[7].PublicKey:  {metas[1].PublicKey, metas[11].PublicKey, solana.Token2022ProgramID, 11},
	}
	decode := func(rows []rpc.TokenBalance) (map[solana.PublicKey]uint64, error) {
		if len(rows) != len(roles) {
			return nil, bad
		}
		out := map[solana.PublicKey]uint64{}
		for _, row := range rows {
			if int(row.AccountIndex) >= len(keys) || row.Owner == nil || row.ProgramId == nil || row.UiTokenAmount == nil {
				return nil, bad
			}
			key := keys[row.AccountIndex]
			role, ok := roles[key]
			if !ok || *row.Owner != role.owner || row.Mint != role.mint || *row.ProgramId != role.program || row.UiTokenAmount.Decimals != role.decimals {
				return nil, bad
			}
			if _, exists := out[key]; exists {
				return nil, bad
			}
			n, e := strconv.ParseUint(row.UiTokenAmount.Amount, 10, 64)
			if e != nil || strconv.FormatUint(n, 10) != row.UiTokenAmount.Amount {
				return nil, bad
			}
			out[key] = n
		}
		return out, nil
	}
	pre, e := decode(m.PreTokenBalances)
	if e != nil {
		return reject()
	}
	post, e := decode(m.PostTokenBalances)
	if e != nil {
		return reject()
	}
	if m.Err != nil {
		for key, n := range pre {
			if post[key] != n {
				return reject()
			}
		}
	} else {
		cash = b.Snapshot.Quote.InputCash
		cv, av := metas[6].PublicKey, metas[7].PublicKey
		if pre[a.Pins.CashAccount] < cash || post[a.Pins.CashAccount] != pre[a.Pins.CashAccount]-cash || pre[cv] > ^uint64(0)-cash || post[cv] != pre[cv]+cash || post[a.Pins.AssetAccount] <= pre[a.Pins.AssetAccount] || pre[av] <= post[av] {
			return reject()
		}
		net = post[a.Pins.AssetAccount] - pre[a.Pins.AssetAccount]
		gross := pre[av] - post[av]
		_, expected := wenSatTransferV1(gross)
		factor := uint64(10000 - a.Limits.SlippageBPS)
		q := b.Snapshot.Quote.QuotedNet
		minimum := q/10000*factor + q%10000*factor/10000
		if net != expected || net < minimum || net < a.Limits.MinimumNet {
			return reject()
		}
	}
	raw, e := json.Marshal(struct {
		Slot      uint64
		Meta      *rpc.TransactionMeta
		Signature string
	}{result.Slot, m, r.Signature})
	if e != nil {
		return 0, 0, 0, "", e
	}
	// Keep integer metadata; float UI fields never enter amount arithmetic.
	return m.Fee, cash, net, wenHashV1(raw), nil
}
