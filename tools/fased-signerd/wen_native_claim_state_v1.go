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

// These records must come from one finalized signer-owned read. This validator
// checks entitlement and custody, not deployment, activation or signing authority.
type wenNativeClaimSnapshotV1 struct {
	Slot, Now                                                            uint64
	Source, Receipt, Cohort, History, Paid, Mint, Inventory, Destination *signerWENBTCAccountV1
}
type wenNativeClaimAllocationV1 struct{ Gross, Fee, Net, Weight, Eligible, Unpaid uint64 }

func validateWENNativeClaimStateV1(v signerWENNativeClaimIntentV1, owner, policy solana.PublicKey, s wenNativeClaimSnapshotV1) (wenNativeClaimAllocationV1, error) {
	var out wenNativeClaimAllocationV1
	bad := errors.New("native SAT claim state rejected")
	ix, e := buildWENNativeClaimInstructionV1(v, owner)
	if e != nil {
		return out, e
	}
	num := func(x string) uint64 { n, _ := strconv.ParseUint(x, 10, 64); return n }
	award, from := num(v.Award), num(v.From)
	day := award / 3
	if policy.IsZero() || s.Slot < num(v.MinFinalizedSlot) || s.Slot >= num(v.ExpiresSlot) || s.Now > uint64(1<<63-1) || s.Now/86400 <= day || s.Paid != nil {
		return out, bad
	}
	p := ix.ProgramID()
	a := ix.Accounts()
	sale := a[1].PublicKey
	le := func(n uint64) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, n); return b }
	derive := func(seed string, parts ...[]byte) (solana.PublicKey, byte) {
		k, b, _ := solana.FindProgramAddress(append([][]byte{[]byte(seed)}, parts...), p)
		return k, b
	}
	domain := sha256.Sum256(append([]byte("wen-native-staking-epoch-v1"), le(award)...))
	receipt, rb := derive("wen-named-promise-v1", sale[:], []byte{2}, domain[:])
	source, sb := derive("wen-native-stake-release-v1", receipt[:])
	cohort, cb := derive("wen-opening-target-v1", sale[:], []byte{4}, le(day))
	history, hb := derive("wen-stake-history-v1", sale[:], owner[:], le(from))
	check := func(r *signerWENBTCAccountV1, k solana.PublicKey, b byte, magic string, length int, state byte, versions ...byte) bool {
		if r == nil || r.Address != k || r.Owner != p || r.Executable || r.Slot != s.Slot || len(r.Data) != length {
			return false
		}
		d := r.Data
		version := false
		for _, v := range versions {
			version = version || d[8] == v
		}
		return version && string(d[:8]) == magic && d[9] == 0 && d[10] == state && d[11] == b && bytes.Equal(d[12:16], make([]byte, 4))
	}
	if !check(s.Source, source, sb, "WENNSRC1", 112, 0, 1, 2) || !check(s.Receipt, receipt, rb, "WENPRM01", 152, 2, 1, 2) || !check(s.Cohort, cohort, cb, "WENBEN01", 168, 4, 1) || !check(s.History, history, hb, "WENSTH01", 104, 0, 1) {
		return out, bad
	}
	r, t, c, h := s.Receipt.Data, s.Source.Data, s.Cohort.Data, s.History.Data
	key := func(d []byte, o int, k solana.PublicKey) bool { return bytes.Equal(d[o:o+32], k[:]) }
	n := func(d []byte, o int) uint64 { return binary.LittleEndian.Uint64(d[o:]) }
	promises, _ := derive("wen-sat-promises-v1", sale[:])
	if !key(r, 16, sale) || !bytes.Equal(r[48:80], domain[:]) || !key(r, 80, promises) || !key(t, 16, sale) || !key(t, 48, receipt) || !key(c, 16, sale) || !key(c, 48, policy) || !key(h, 16, sale) || !key(h, 48, owner) || !bytes.Equal(r[144:], make([]byte, 8)) {
		return out, bad
	}
	total, minted, cancelled := n(r, 120), n(r, 128), n(r, 136)
	amount, paid, last := n(t, 80), n(t, 88), n(t, 104)
	eligible, weight := n(c, 128), n(h, 96)
	if total == 0 || minted > total || cancelled != total-minted || minted != amount || amount == 0 || paid > amount || n(r, 112) != award || n(t, 96) != award || last < award || last > s.Now/28800 || n(c, 80) != day || eligible == 0 || n(h, 80) != from || from > day || n(h, 88) <= day || weight == 0 || weight > eligible {
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
	gross := new(big.Int).Mul(new(big.Int).SetUint64(amount), new(big.Int).SetUint64(weight))
	gross.Div(gross, new(big.Int).SetUint64(eligible))
	if !gross.IsUint64() || gross.Sign() == 0 || gross.Uint64() > amount-paid {
		return out, bad
	}
	collector, _ := derive("wen-sat-collector-v1", sale[:])
	mint := a[10].PublicKey
	if e = validateWENSatMintV1(s.Mint, mint, sale, collector, s.Slot); e != nil {
		return out, e
	}
	if _, _, e = validateWENSatCustodyV1(s.Inventory, a[8].PublicKey, mint, receipt, s.Slot, amount-paid); e != nil {
		return out, e
	}
	balance, withheld, e := validateWENSatCustodyV1(s.Destination, a[9].PublicKey, mint, owner, s.Slot, 0)
	if e != nil {
		return out, e
	}
	fee, net := wenSatTransferV1(gross.Uint64())
	if net == 0 || net < num(v.MinimumReceived) || net > ^uint64(0)-balance || fee > ^uint64(0)-withheld {
		return out, bad
	}
	return wenNativeClaimAllocationV1{gross.Uint64(), fee, net, weight, eligible, amount - paid}, nil
}
