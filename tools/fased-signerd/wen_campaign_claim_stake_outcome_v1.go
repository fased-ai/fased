package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"math/big"
)

// Pure receipt validation, not finality authentication or permission to sign.
// Historical poststate and claim consumption remain separate recovery predicates.
func wenCampaignClaimStakeOutcomeV1(a wenCampaignClaimStakeReviewV1, expectedDigest, signature string, result *rpc.GetTransactionResult) (uint64, string, error) {
	bad := errors.New("direct stake transaction outcome mismatch")
	digest, e := a.digest()
	if e != nil || digest != expectedDigest || result == nil || result.Meta == nil || result.Transaction == nil || result.Slot < a.Snapshot.Claim.ReferenceSlot {
		return 0, "", bad
	}
	sig, e := solana.SignatureFromBase58(signature)
	if e != nil {
		return 0, "", bad
	}
	owner, e := solana.PublicKeyFromBase58(a.WalletPublicKey)
	if e != nil || !ed25519.Verify(ed25519.PublicKey(owner[:]), a.Message, sig[:]) {
		return 0, "", bad
	}
	wire := make([]byte, 65+len(a.Message))
	wire[0] = 1
	copy(wire[1:65], sig[:])
	copy(wire[65:], a.Message)
	if !bytes.Equal(wire, result.Transaction.GetBinary()) {
		return 0, "", bad
	}
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		return 0, "", bad
	}
	m := result.Meta
	if m.Fee != a.Fee || len(m.PreBalances) != len(tx.Message.AccountKeys) || len(m.PostBalances) != len(m.PreBalances) {
		return 0, "", bad
	}
	if e = verifyWENCampaignClaimStakeEffectsV1(a.Intent, a.MinimumNet, a.Snapshot.Claim, a.Snapshot.History, tx.Message.AccountKeys, m); e != nil {
		return 0, "", e
	}
	stake, e := buildWENStakingInstructionV1(a.Intent, owner)
	if e != nil {
		return 0, "", e
	}
	h := a.Snapshot.History
	metas := stake.Accounts()
	allocations := map[solana.PublicKey]bool{}
	if h.Position == nil {
		allocations[metas[4].PublicKey] = true
	}
	if h.NextHistory == nil {
		allocations[metas[6].PublicKey] = true
	}
	if h.NextPoint == nil {
		allocations[metas[14].PublicKey] = true
	}
	debit := m.Fee
	if m.Err == nil {
		if a.Rent > ^uint64(0)-debit {
			return 0, "", bad
		}
		debit += a.Rent
	}
	if debit > a.MaximumDebit {
		return 0, "", bad
	}
	rent := uint64(0)
	seen := 0
	for i, k := range tx.Message.AccountKeys {
		got := new(big.Int).Sub(new(big.Int).SetUint64(m.PostBalances[i]), new(big.Int).SetUint64(m.PreBalances[i]))
		if k == owner {
			if got.Cmp(new(big.Int).Neg(new(big.Int).SetUint64(debit))) != 0 {
				return 0, "", bad
			}
			continue
		}
		if allocations[k] && m.Err == nil {
			// Newly allocated accounts must begin absent and receive rent, not principal.
			if m.PreBalances[i] != 0 || m.PostBalances[i] == 0 || m.PostBalances[i] > ^uint64(0)-rent {
				return 0, "", bad
			}
			rent += m.PostBalances[i]
			seen++
			continue
		}
		if got.Sign() != 0 {
			return 0, "", bad
		}
	}
	if m.Err == nil && (rent != a.Rent || seen != len(allocations)) {
		return 0, "", bad
	}
	raw, e := json.Marshal(struct {
		Slot      uint64
		Meta      *rpc.TransactionMeta
		Signature string
	}{result.Slot, m, signature})
	if e != nil {
		return 0, "", e
	}
	return debit, wenHashV1(raw), nil
}
