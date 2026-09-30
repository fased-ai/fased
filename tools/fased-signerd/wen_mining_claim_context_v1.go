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

// Derive the settlement domain from authenticated offer bytes, not intent hints.
func validateWENMiningClaimContextV1(v signerWENMiningClaimIntentV1, owner solana.PublicKey, slot, now uint64, offer, entry *signerWENBTCAccountV1, s wenMiningClaimSnapshotV1) (wenMiningClaimSnapshotV1, error) {
	bad := errors.New("mining claim offer or entry rejected")
	ix, e := buildWENMiningClaimInstructionV1(v, owner)
	if e != nil {
		return s, e
	}
	p := ix.ProgramID()
	a := ix.Accounts()
	sale := a[1].PublicKey
	if offer == nil || offer.Address != a[2].PublicKey || offer.Owner != p || offer.Executable || offer.Slot != slot || len(offer.Data) != 408 {
		return s, bad
	}
	d := offer.Data
	le := func(n uint64) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, n); return b }
	id, _ := strconv.ParseUint(v.ID, 10, 64)
	derive := func(seed string, parts ...[]byte) (solana.PublicKey, byte) {
		k, b, _ := solana.FindProgramAddress(append([][]byte{[]byte(seed)}, parts...), p)
		return k, b
	}
	prep, _ := derive("wen-mining-preparation-v1", sale[:], le(id))
	_, b := derive("wen-mining-offer-v1", sale[:], prep[:])
	if string(d[:8]) != "WENMOFR1" || (d[8] != 1 && d[8] != 2) || d[9] != 0 || d[10] != 0 || d[11] != b || !bytes.Equal(d[12:16], make([]byte, 4)) || !bytes.Equal(d[400:], make([]byte, 8)) {
		return s, bad
	}
	keys := make([]solana.PublicKey, 8)
	seen := map[solana.PublicKey]bool{}
	for i := range keys {
		copy(keys[i][:], d[16+i*32:48+i*32])
		if keys[i].IsZero() || seen[keys[i]] {
			return s, bad
		}
		seen[keys[i]] = true
	}
	capacity, _ := derive("wen-capacity-reserved-v1", sale[:], le(id))
	history, _ := derive("wen-mining-history-v1", sale[:])
	fund, _ := derive("wen-mining-lifecycle-fund-v1", sale[:], le(id))
	for i, k := range map[int]solana.PublicKey{0: p, 1: sale, 3: prep, 4: capacity, 6: history, 7: fund} {
		if keys[i] != k {
			return s, bad
		}
	}
	n := make([]uint64, 12)
	for i := range n {
		n[i] = binary.LittleEndian.Uint64(d[304+i*8:])
	}
	if n[0] >= n[1] || n[1] > uint64(1<<63-1)-900 {
		return s, bad
	}
	for _, i := range []int{2, 3, 4, 5, 6, 11} {
		if n[i] == 0 {
			return s, bad
		}
	}
	multiplier := int64(9)
	if d[8] == 2 {
		multiplier = 8
	}
	target := new(big.Int).Mul(new(big.Int).SetUint64(n[3]), big.NewInt(multiplier))
	target.Div(target, big.NewInt(4))
	if !target.IsUint64() {
		return s, bad
	}
	scaled := new(big.Int).Mul(new(big.Int).Set(target), big.NewInt(1000000))
	rate := new(big.Int).Add(new(big.Int).Set(scaled), new(big.Int).SetUint64(n[4]-1))
	rate.Div(rate, new(big.Int).SetUint64(n[4]))
	if rate.Cmp(big.NewInt(1000)) < 0 {
		rate.SetInt64(1000)
	}
	if rate.Cmp(big.NewInt(10000)) > 0 {
		rate.SetInt64(10000)
	}
	limit := new(big.Int).Div(scaled, rate)
	if !limit.IsUint64() || limit.Sign() == 0 || limit.Uint64() > n[5] || n[6] > limit.Uint64() || n[7] != target.Uint64() || n[8] != rate.Uint64() || n[9] != limit.Uint64() || n[10] != n[6] {
		return s, bad
	}
	preimage := append([]byte("WEN-EXECUTION-PREFUNDED-V1"), a[2].PublicKey[:]...)
	preimage = append(preimage, le(n[1])...)
	preimage = append(preimage, fund[:]...)
	digest := sha256.Sum256(preimage)
	if !bytes.Equal(d[272:304], digest[:]) {
		return s, bad
	}
	s.Slot = slot
	s.Now = now
	s.Open = n[1]
	s.Capacity = limit.Uint64()
	s.MinimumFill = n[6]
	allocation, e := validateWENMiningClaimSettlementV1(v, owner, s)
	if e != nil {
		return s, e
	}
	if entry == nil || entry.Address != a[5].PublicKey || entry.Owner != p || entry.Executable || entry.Slot != slot || len(entry.Data) != 272 {
		return s, bad
	}
	d = entry.Data
	nonce, _ := strconv.ParseUint(v.Nonce, 10, 64)
	_, b = derive("wen-mining-entry-v1", a[2].PublicKey[:], owner[:], le(nonce))
	if string(d[:8]) != "WENMEN01" || d[8] != 1 || d[9] > 1 || d[10] > d[9] || d[11] != b || !bytes.Equal(d[12:16], make([]byte, 4)) {
		return s, bad
	}
	vault, _ := derive("wen-mining-capital-v1", sale[:], owner[:])
	for i, k := range []solana.PublicKey{p, sale, a[2].PublicKey, owner, vault} {
		if !bytes.Equal(d[16+i*32:48+i*32], k[:]) {
			return s, bad
		}
	}
	for i, n := range []uint64{nonce, allocation.Capital, s.Open} {
		if binary.LittleEndian.Uint64(d[176+i*8:]) != n {
			return s, bad
		}
	}
	if d[9] == 0 && !bytes.Equal(d[200:232], make([]byte, 32)) {
		return s, bad
	}
	if d[10] == 0 {
		if !bytes.Equal(d[232:], make([]byte, 40)) {
			return s, bad
		}
	} else {
		total := uint32(0)
		for i := 0; i < 4; i++ {
			total += uint32(binary.LittleEndian.Uint16(d[232+i*2:]))
		}
		if total != 10000 {
			return s, bad
		}
		material := append([]byte("wen-mining-commitment-v1"), d[16:192]...)
		material = append(material, d[232:]...)
		hash := sha256.Sum256(material)
		if !bytes.Equal(hash[:], d[200:232]) {
			return s, bad
		}
	}
	return s, nil
}
