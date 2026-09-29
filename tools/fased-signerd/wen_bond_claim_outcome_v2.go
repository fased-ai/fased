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

// Only the retained wire and its finalized effects establish claim delivery.
// Current balances alone cannot attribute a claim to this attempt.
func wenBondClaimOutcomeV2(r wenBondClaimReservationV2, result *rpc.GetTransactionResult) (debit, gross, net, fee uint64, hash string, err error) {
	bad := errors.New("Bond finalized claim outcome rejected")
	reject := func() (uint64, uint64, uint64, uint64, string, error) { return 0, 0, 0, 0, "", bad }
	a, b := r.Artifact, r.Artifact.Binding
	d, e := a.digest()
	if e != nil || d != r.Digest || r.Version != 2 || result == nil || result.Meta == nil || result.Transaction == nil || result.Slot < b.Snapshot.ReferenceSlot || (r.State != "submission-uncertain" && r.State != "finalized-success" && r.State != "finalized-failed") {
		return reject()
	}
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
	keys, m := tx.Message.AccountKeys, result.Meta
	if len(tx.Message.GetAddressTableLookups()) != 0 || len(m.LoadedAddresses.Writable) != 0 || len(m.LoadedAddresses.ReadOnly) != 0 || len(m.PreBalances) != len(keys) || len(m.PostBalances) != len(keys) || m.Fee != b.Fee || m.Fee > a.MaxFee || keys[0] != a.Pins.Owner || m.PreBalances[0] < m.Fee || m.PostBalances[0] != m.PreBalances[0]-m.Fee || m.PostBalances[0] < a.RetainedLamports {
		return reject()
	}
	for i := 1; i < len(keys); i++ {
		if m.PreBalances[i] != m.PostBalances[i] {
			return reject()
		}
	}
	ix, e := buildWENBondClaimV2(a.Pins, b.Snapshot.Claim)
	if e != nil {
		return reject()
	}
	roles := ix.Accounts()
	amount := func(rows []rpc.TokenBalance, key, owner solana.PublicKey) (uint64, error) {
		seen := false
		var n uint64
		for _, v := range rows {
			if int(v.AccountIndex) >= len(keys) {
				return 0, bad
			}
			if keys[v.AccountIndex] != key {
				continue
			}
			if seen || v.Mint != roles[5].PublicKey || v.Owner == nil || *v.Owner != owner || v.ProgramId == nil || *v.ProgramId != solana.Token2022ProgramID || v.UiTokenAmount == nil || v.UiTokenAmount.Decimals != 11 {
				return 0, bad
			}
			seen = true
			var e error
			n, e = strconv.ParseUint(v.UiTokenAmount.Amount, 10, 64)
			if e != nil || strconv.FormatUint(n, 10) != v.UiTokenAmount.Amount {
				return 0, bad
			}
		}
		if !seen {
			return 0, bad
		}
		return n, nil
	}
	cp, e := amount(m.PreTokenBalances, roles[6].PublicKey, roles[3].PublicKey)
	if e != nil {
		return reject()
	}
	cq, e := amount(m.PostTokenBalances, roles[6].PublicKey, roles[3].PublicKey)
	if e != nil {
		return reject()
	}
	dp, e := amount(m.PreTokenBalances, a.Pins.Destination, a.Pins.Owner)
	if e != nil {
		return reject()
	}
	dq, e := amount(m.PostTokenBalances, a.Pins.Destination, a.Pins.Owner)
	if e != nil {
		return reject()
	}
	if m.Err != nil {
		if cp != cq || dp != dq {
			return reject()
		}
	} else {
		c := b.Snapshot.Claim
		if cp < cq || dq < dp {
			return reject()
		}
		gross, net = cp-cq, dq-dp
		if gross == 0 || gross > c.Gross-c.ClaimedGross || net < a.Policy.MinimumNet || gross < net {
			return reject()
		}
		fee = wenBondCeilV2(new(big.Int).Mul(wenBondN(gross), wenBondN(3)), wenBondN(100)).Uint64()
		if gross-net != fee || cp != c.Gross-c.ClaimedGross {
			return reject()
		}
	}
	raw, e := json.Marshal(struct {
		Slot      uint64
		Meta      *rpc.TransactionMeta
		Signature string
	}{result.Slot, m, r.Signature})
	if e != nil {
		return 0, 0, 0, 0, "", e
	}
	return m.Fee, gross, net, fee, wenHashV1(raw), nil
}
