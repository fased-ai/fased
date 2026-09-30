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

// Pure receipt validation. Finality/genesis must be authenticated by the caller.
// Returns actual budget spend, not net cash flow: withdrawal principal is not income.
func wenCampaignOutcomeV1(r wenCampaignReservationV1, result *rpc.GetTransactionResult) (uint64, string, error) {
	bad := errors.New("campaign outcome mismatch")
	digest, e := r.Artifact.digest()
	if e != nil || digest != r.Digest || r.Version != 1 || (r.State != "submission-uncertain" && r.State != "finalized-success" && r.State != "finalized-failed") {
		return 0, "", bad
	}
	if result == nil || result.Meta == nil || result.Transaction == nil || result.Slot < r.Artifact.Binding.Position.ReferenceSlot {
		return 0, "", bad
	}
	sig, e := solana.SignatureFromBase58(r.Signature)
	if e != nil {
		return 0, "", bad
	}
	owner, e := solana.PublicKeyFromBase58(r.Artifact.WalletPublicKey)
	if e != nil || !ed25519.Verify(ed25519.PublicKey(owner[:]), r.Artifact.Binding.Message, sig[:]) {
		return 0, "", bad
	}
	wire := make([]byte, 65+len(r.Artifact.Binding.Message))
	wire[0] = 1
	copy(wire[1:65], sig[:])
	copy(wire[65:], r.Artifact.Binding.Message)
	if !bytes.Equal(wire, result.Transaction.GetBinary()) {
		return 0, "", bad
	}
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		return 0, "", e
	}
	m := result.Meta
	if m.Fee > r.Artifact.Binding.MaxFee || m.Fee != r.Artifact.Binding.Fee || len(m.PreBalances) != len(tx.Message.AccountKeys) || len(m.PostBalances) != len(m.PreBalances) {
		return 0, "", bad
	}
	if r.Artifact.Action.Operation == "claim" {
		if r.Artifact.Binding.Claim == nil || verifyWENCampaignClaimEffectsV1(*r.Artifact.Binding.Claim, tx.Message.AccountKeys, m) != nil {
			return 0, "", bad
		}
	} else if len(m.PreTokenBalances) != 0 || len(m.PostTokenBalances) != 0 {
		return 0, "", bad
	}
	debit := m.Fee
	setupDeltas := map[solana.PublicKey]uint64{}
	if m.Err == nil && r.Artifact.Action.Operation == "setup" {
		snapshot := r.Artifact.Binding.Setup
		_, allocations, err := buildWENCampaignAtomicSetupV1(snapshot.Setup)
		if err != nil {
			return 0, "", bad
		}
		for i, a := range allocations {
			n := snapshot.RentByAllocation[i]
			if i == 0 {
				n += r.Artifact.Action.Amount
			}
			setupDeltas[a.Address] = n
			debit += n
		}
	}
	delta := new(big.Int)
	if m.Err == nil {
		switch r.Artifact.Action.Operation {
		case "top-up":
			delta.SetUint64(r.Artifact.Action.Amount)
			debit += r.Artifact.Action.Amount
		case "withdraw":
			delta.Neg(new(big.Int).SetUint64(r.Artifact.Action.Amount))
		}
	}
	ownerDelta := new(big.Int).Neg(new(big.Int).Set(delta))
	ownerDelta.Sub(ownerDelta, new(big.Int).SetUint64(m.Fee))
	if r.Artifact.Action.Operation == "setup" {
		ownerDelta.Neg(new(big.Int).SetUint64(debit))
	}
	for i, key := range tx.Message.AccountKeys {
		want := new(big.Int)
		if key == owner {
			want.Set(ownerDelta)
		} else if key == r.Artifact.Action.Position {
			want.Set(delta)
		}
		if n, ok := setupDeltas[key]; ok {
			want.SetUint64(n)
		}
		got := new(big.Int).Sub(new(big.Int).SetUint64(m.PostBalances[i]), new(big.Int).SetUint64(m.PreBalances[i]))
		if got.Cmp(want) != 0 {
			return 0, "", bad
		}
	}
	maximum, e := r.Artifact.debit()
	if e != nil || debit > maximum {
		return 0, "", bad
	}
	raw, e := json.Marshal(struct {
		Slot      uint64
		Meta      *rpc.TransactionMeta
		Signature string
	}{result.Slot, m, r.Signature})
	if e != nil {
		return 0, "", e
	}
	return debit, wenHashV1(raw), nil
}
