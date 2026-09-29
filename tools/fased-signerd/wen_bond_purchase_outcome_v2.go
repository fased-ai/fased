package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"math/big"
	"strconv"
)

// Transaction metadata is tied to the retained signed wire, including loaded
// address keys. Present account balances cannot substitute for these effects.
func wenBondPurchaseOutcomeV2(r wenBondPurchaseReservationV2, result *rpc.GetTransactionResult) (debit, cash, gross uint64, hash string, err error) {
	bad := errors.New("Bond finalized purchase outcome rejected")
	reject := func() (uint64, uint64, uint64, string, error) { return 0, 0, 0, "", bad }
	a, b := r.Artifact, r.Artifact.Binding
	d, e := a.digest()
	if e != nil || d != r.Digest || r.Version != 2 || result == nil || result.Meta == nil || result.Transaction == nil || result.Slot < b.Snapshot.ReferenceSlot || (r.State != "submission-uncertain" && r.State != "finalized-success" && r.State != "finalized-failed") {
		return reject()
	}
	sig, e := solana.SignatureFromBase58(r.Signature)
	if e != nil || !ed25519.Verify(ed25519.PublicKey(a.Pins.Bond.Owner[:]), b.Message, sig[:]) {
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
	staticCount := len(tx.Message.AccountKeys)
	writableCount, readonlyCount := 0, 0
	for _, l := range tx.Message.GetAddressTableLookups() {
		writableCount += len(l.WritableIndexes)
		readonlyCount += len(l.ReadonlyIndexes)
	}
	tables, e := verifiedWENBTCLookupTablesV1(a.Policy.internalLookups(), b.Snapshot.Lookups, signerWENBTCMessageLifeV1{minimumSlot: b.Snapshot.Slot, maximumSlotLag: a.Policy.MaxSlotLag})
	if e != nil || tx.Message.SetAddressTables(tables) != nil || tx.Message.ResolveLookups() != nil {
		return reject()
	}
	keys := tx.Message.AccountKeys
	m := result.Meta
	if len(m.PreBalances) != len(keys) || len(m.PostBalances) != len(keys) || m.Fee != b.Fee || m.Fee > a.Limits.MaxFee || keys[0] != a.Pins.Bond.Owner || m.PreBalances[0] < m.PostBalances[0] {
		return reject()
	}
	debit = m.PreBalances[0] - m.PostBalances[0]
	if debit < m.Fee || debit-m.Fee > b.Snapshot.Rent || m.PostBalances[0] < a.Limits.RetainedLamports {
		return reject()
	}
	if len(m.LoadedAddresses.Writable) != writableCount || len(m.LoadedAddresses.ReadOnly) != readonlyCount {
		return reject()
	}
	lookupKeys := append(append([]solana.PublicKey(nil), m.LoadedAddresses.Writable...), m.LoadedAddresses.ReadOnly...)
	for i, k := range lookupKeys {
		if keys[staticCount+i] != k {
			return reject()
		}
	}
	sumPre, sumPost := new(big.Int), new(big.Int)
	for i := range keys {
		sumPre.Add(sumPre, wenBondN(m.PreBalances[i]))
		sumPost.Add(sumPost, wenBondN(m.PostBalances[i]))
	}
	if sumPre.Sub(sumPre, sumPost).Cmp(wenBondN(m.Fee)) != 0 {
		return reject()
	}

	amount := func(rows []rpc.TokenBalance, key, mint, owner, program solana.PublicKey, decimals uint8, optional bool) (uint64, error) {
		seen := false
		var n uint64
		for _, v := range rows {
			if int(v.AccountIndex) >= len(keys) {
				return 0, bad
			}
			if keys[v.AccountIndex] != key {
				continue
			}
			if seen || v.Mint != mint || v.Owner == nil || *v.Owner != owner || v.ProgramId == nil || *v.ProgramId != program || v.UiTokenAmount == nil || v.UiTokenAmount.Decimals != decimals {
				return 0, bad
			}
			seen = true
			var e error
			n, e = strconv.ParseUint(v.UiTokenAmount.Amount, 10, 64)
			if e != nil || strconv.FormatUint(n, 10) != v.UiTokenAmount.Amount {
				return 0, bad
			}
		}
		if !seen && !optional {
			return 0, bad
		}
		return n, nil
	}
	usdc := solana.PublicKeyFromBytes(a.Pins.PolicyBytes[8:40])
	pre, e := amount(m.PreTokenBalances, a.Pins.Source, usdc, a.Pins.Bond.Owner, solana.TokenProgramID, 6, false)
	if e != nil {
		return reject()
	}
	post, e := amount(m.PostTokenBalances, a.Pins.Source, usdc, a.Pins.Bond.Owner, solana.TokenProgramID, 6, false)
	if e != nil {
		return reject()
	}
	ix, e := buildWENBondPurchaseV2(b.Snapshot.Pins, b.Snapshot.Quote, a.Policy.Nonce, b.Snapshot.Now, a.Policy.Route)
	if e != nil {
		return reject()
	}
	accounts := ix[0].Accounts()
	mint, custody, paid := accounts[9].PublicKey, accounts[23].PublicKey, accounts[19].PublicKey
	custodyPre, e := amount(m.PreTokenBalances, custody, mint, paid, solana.Token2022ProgramID, 11, true)
	if e != nil || custodyPre != 0 {
		return reject()
	}
	custodyPost, e := amount(m.PostTokenBalances, custody, mint, paid, solana.Token2022ProgramID, 11, m.Err != nil)
	if e != nil {
		return reject()
	}
	if m.Err != nil {
		if debit != m.Fee || pre != post || custodyPost != 0 {
			return reject()
		}
	} else {
		q, e := inspectWENBondQuoteV2(a.Pins.Bond, b.Snapshot.Quote, a.Policy.Nonce)
		if e != nil || pre < q.Cash || post != pre-q.Cash || custodyPost != q.Gross {
			return reject()
		}
		btcPre, e := amount(m.PreTokenBalances, accounts[17].PublicKey, accounts[25].PublicKey, accounts[2].PublicKey, solana.TokenProgramID, 8, false)
		if e != nil {
			return reject()
		}
		btcPost, e := amount(m.PostTokenBalances, accounts[17].PublicKey, accounts[25].PublicKey, accounts[2].PublicKey, solana.TokenProgramID, 8, false)
		if e != nil || btcPost < btcPre || btcPost-btcPre < q.RequiredBTC {
			return reject()
		}
		cash, gross = q.Cash, q.Gross
	}
	raw, e := json.Marshal(struct {
		Slot      uint64
		Meta      *rpc.TransactionMeta
		Signature string
	}{result.Slot, m, r.Signature})
	if e != nil {
		return 0, 0, 0, "", e
	}
	return debit, cash, gross, wenHashV1(raw), nil
}
