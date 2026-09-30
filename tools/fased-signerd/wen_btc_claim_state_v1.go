package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"math/big"
	"strconv"
)

// Accounting observations must be obtained by the signer, never accepted as
// user-provided proof. This subset does not verify deployment or token custody.
type wenBTCClaimHistoryV1 struct {
	Slot, Now                                            uint64
	Funding, Cohort, History, Settlement, Fallback, Paid *signerWENBTCAccountV1
}
type wenBTCClaimAllocationV1 struct {
	Amount, Weight, Eligible, Unclaimed, Slot uint64
	StateHash                                 string
}

func validateWENBTCClaimHistoryV1(v signerWENBTCClaimIntentV1, owner, policy, usdc solana.PublicKey, s wenBTCClaimHistoryV1) (wenBTCClaimAllocationV1, error) {
	var out wenBTCClaimAllocationV1
	bad := errors.New("BTC historical claim rejected")
	ix, e := buildWENBTCClaimInstructionV1(v, owner)
	if e != nil {
		return out, e
	}
	if policy.IsZero() || usdc.IsZero() {
		return out, bad
	}
	num := func(x string) uint64 { n, _ := strconv.ParseUint(x, 10, 64); return n }
	day, from := num(v.Day), num(v.From)
	if s.Slot < num(v.MinFinalizedSlot) || s.Slot >= num(v.ExpiresSlot) || s.Now > uint64(1<<63-1) || day >= s.Now/86400 || from > day || s.Fallback != nil || s.Paid != nil {
		return out, bad
	}
	p := ix.ProgramID()
	sale := solana.MustPublicKeyFromBase58(v.Sale)
	mint := solana.MustPublicKeyFromBase58(v.Mint)
	le := func(n uint64) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, n); return b }
	derive := func(seed string, parts ...[]byte) (solana.PublicKey, uint8) {
		k, b, _ := solana.FindProgramAddress(append([][]byte{[]byte(seed)}, parts...), p)
		return k, b
	}
	var batch solana.PublicKey
	if v.Source == "fee" {
		batch, _ = derive("wen-fee-batch-v1", sale[:], le(day))
	} else {
		prep, _ := derive("wen-mining-preparation-v1", sale[:], le(num(*v.Offer)))
		offer, _ := derive("wen-mining-offer-v1", sale[:], prep[:])
		r, _ := derive("wen-mining-progress-v1", sale[:], offer[:])
		batch, _ = derive("wen-mining-income-v1", r[:])
	}
	funding, fb := derive("wen-btc-funded-v1", batch[:])
	cohort, cb := derive("wen-opening-target-v1", sale[:], []byte{4}, le(day))
	history, hb := derive("wen-stake-history-v1", sale[:], owner[:], le(from))
	settlement, sb := derive("wen-btc-settled-v1", funding[:])
	check := func(a *signerWENBTCAccountV1, k solana.PublicKey, b byte, magic string, length int, state byte) bool {
		return a != nil && a.Address == k && a.Owner == p && !a.Executable && a.Slot == s.Slot && len(a.Data) == length && string(a.Data[:8]) == magic && a.Data[8] == 1 && a.Data[9] == 0 && a.Data[10] == state && a.Data[11] == b && bytes.Equal(a.Data[12:16], make([]byte, 4))
	}
	if !check(s.Funding, funding, fb, "WENBTF01", 160, 1) || !check(s.Cohort, cohort, cb, "WENBEN01", 168, 4) || !check(s.History, history, hb, "WENSTH01", 104, 0) || !check(s.Settlement, settlement, sb, "WENBTST1", 208, 0) {
		return out, bad
	}
	f, c, h, t := s.Funding.Data, s.Cohort.Data, s.History.Data, s.Settlement.Data
	key := func(d []byte, off int, k solana.PublicKey) bool { return bytes.Equal(d[off:off+32], k[:]) }
	n := func(d []byte, off int) uint64 { return binary.LittleEndian.Uint64(d[off:]) }
	if !key(f, 16, batch) || !key(f, 48, cohort) || !key(f, 80, usdc) || !key(c, 16, sale) || !key(c, 48, policy) || !key(h, 16, sale) || !key(h, 48, owner) || !key(t, 16, funding) || !key(t, 48, cohort) || !key(t, 80, mint) {
		return out, bad
	}
	eligible, weight := n(c, 128), n(h, 96)
	if n(c, 80) != day || eligible == 0 || n(h, 80) != from || n(h, 88) <= day || weight == 0 || weight > eligible {
		return out, bad
	}
	digestInput := append([]byte("wen-stake-cohort-v1"), sale[:]...)
	digestInput = append(digestInput, policy[:]...)
	digestInput = append(digestInput, le(day)...)
	digestInput = append(digestInput, le(eligible)...)
	digest := sha256.Sum256(digestInput)
	if !bytes.Equal(c[136:168], digest[:]) {
		return out, bad
	}
	// The closed-day check above bounds day below signed timestamp range.
	due := (day + 1) * 86400
	cash, fallbackCash, fallbackWeight := n(f, 112), n(f, 136), n(f, 144)
	if cash == 0 || fallbackCash > cash || fallbackWeight > eligible || n(f, 120) != due || n(f, 128) != due+86400 || n(f, 152) != 0 {
		return out, bad
	}
	tokens, remaining, claimed, converted := n(t, 120), n(t, 128), n(t, 152), n(t, 160)
	if n(t, 112) != cash-fallbackCash || n(t, 136) != fallbackCash || n(t, 144) != fallbackWeight || remaining != eligible-fallbackWeight || remaining == 0 || weight > remaining || tokens == 0 || claimed > tokens || converted < due || converted > s.Now || !bytes.Equal(t[200:208], make([]byte, 8)) {
		return out, bad
	}
	amount := new(big.Int).Mul(new(big.Int).SetUint64(tokens), new(big.Int).SetUint64(weight))
	amount.Div(amount, new(big.Int).SetUint64(remaining))
	if !amount.IsUint64() || amount.Sign() == 0 || amount.Uint64() > tokens-claimed || amount.Uint64() < num(v.MinimumReceived) {
		return out, bad
	}
	return wenBTCClaimAllocationV1{Amount: amount.Uint64(), Weight: weight, Eligible: eligible, Unclaimed: tokens - claimed}, nil
}
