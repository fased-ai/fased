package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"math"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// Owner actions use the catalogue source. This read authenticates its current
// records; it never asserts that older campaign history is complete.
func readWENCampaignAccountingV1(ctx context.Context, c wenCampaignReadRPCV1, program, sale, issuer, window, mint solana.PublicKey, min, expires uint64) ([32]byte, error) {
	var zero [32]byte
	bad := errors.New("campaign accounting readback rejected")
	if program.IsZero() || sale.IsZero() || issuer.IsZero() || window.IsZero() || mint.IsZero() || min == 0 || expires <= min {
		return zero, bad
	}
	meta, err := wenCampaignAccountingTailV1(program, sale, issuer, window)
	if err != nil {
		return zero, err
	}
	keys := make([]solana.PublicKey, 5)
	for i, a := range meta {
		keys[i] = a.PublicKey
	}
	for i, k := range keys {
		for _, earlier := range keys[:i] {
			if k == earlier {
				return zero, bad
			}
		}
	}
	read := func(addresses []solana.PublicKey, minimum uint64) (*rpc.GetMultipleAccountsResult, error) {
		page, e := c.GetMultipleAccountsWithOpts(ctx, addresses, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &minimum})
		if e != nil {
			return nil, e
		}
		if page == nil || len(page.Value) != len(addresses) || page.Context.Slot < minimum || page.Context.Slot >= expires {
			return nil, bad
		}
		return page, nil
	}
	first, err := read(keys, min)
	if err != nil {
		return zero, err
	}
	value := func(a *rpc.Account, address solana.PublicKey, size int, magic string) ([]byte, error) {
		if a == nil || a.Data == nil || a.Owner != program || a.Executable {
			return nil, bad
		}
		d := a.Data.GetBinary()
		if len(d) != size || string(d[:8]) != magic || d[8] != 1 || d[9] != 0 || !bytes.Equal(d[12:16], make([]byte, 4)) || address.IsZero() {
			return nil, bad
		}
		return d, nil
	}
	absent := func(a *rpc.Account) bool {
		return a == nil || a.Owner == solana.SystemProgramID && !a.Executable && a.Data != nil && len(a.Data.GetBinary()) == 0
	}
	s := first.Value[0]
	if s == nil || s.Data == nil || s.Owner != program || s.Executable {
		return zero, bad
	}
	saleData := s.Data.GetBinary()
	if !validWENSaleScheduleV1(saleData) || !bytes.Equal(saleData[16:48], issuer[:]) || !bytes.Equal(saleData[80:112], mint[:]) {
		return zero, bad
	}
	canonicalSale, saleBump, err := solana.FindProgramAddress([][]byte{[]byte("wen-genesis-v1"), issuer[:], saleData[48:80]}, program)
	if err != nil || canonicalSale != sale || saleData[11] != saleBump {
		return zero, bad
	}
	open := int64(binary.LittleEndian.Uint64(saleData[144:]))
	closeAt := int64(binary.LittleEndian.Uint64(saleData[152:]))
	deadline := int64(binary.LittleEndian.Uint64(saleData[160:]))
	total := binary.LittleEndian.Uint64(saleData[168:])
	if open < 0 || closeAt < open || deadline <= closeAt || binary.LittleEndian.Uint64(saleData[176:]) > total || binary.LittleEndian.Uint64(saleData[184:]) > total || binary.LittleEndian.Uint64(saleData[176:]) > 200000000000 {
		return zero, bad
	}
	if len(saleData) == 200 {
		epoch := binary.LittleEndian.Uint64(saleData[192:])
		if epoch == 0 || epoch > math.MaxInt64/28800 {
			return zero, bad
		}
	}
	w, err := value(first.Value[1], window, 256, "WENRCMP2")
	if err != nil {
		return zero, err
	}
	flags := w[11]
	validFlags := flags <= 7 || flags >= 12 && flags <= 15 || flags >= 30 && flags <= 31 || flags >= 62 && flags <= 63
	canonicalWindow, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-retail-window-v2"), issuer[:], mint[:], w[112:120]}, program)
	if err != nil || canonicalWindow != window || w[10] > 2 || !validFlags || !bytes.Equal(w[16:48], issuer[:]) || !bytes.Equal(w[48:80], mint[:]) {
		return zero, bad
	}
	if flags&2 != 0 {
		f, e := value(first.Value[2], keys[2], 176, "WENRFND2")
		if e != nil {
			return zero, e
		}
		source := binary.LittleEndian.Uint64(f[112:])
		var seeds [][]byte
		switch {
		case source&(uint64(1)<<62) != 0:
			n := source &^ (uint64(1) << 62)
			b := make([]byte, 8)
			binary.LittleEndian.PutUint64(b, n)
			seeds = [][]byte{[]byte("wen-grouped-mining-v1"), sale[:], b}
		case source&(uint64(1)<<63) != 0:
			n := source &^ (uint64(1) << 63)
			b := make([]byte, 8)
			binary.LittleEndian.PutUint64(b, n)
			seeds = [][]byte{[]byte("wen-opening-budget-v1"), sale[:], {3}, b}
		default:
			seeds = [][]byte{[]byte("wen-funded-mining-budget-v1"), sale[:], f[112:120]}
		}
		budget, _, e := solana.FindProgramAddress(seeds, program)
		if e != nil || !bytes.Equal(f[16:48], window[:]) || !bytes.Equal(f[48:80], sale[:]) || !bytes.Equal(f[80:112], budget[:]) || binary.LittleEndian.Uint64(f[128:]) != binary.LittleEndian.Uint64(w[152:]) || binary.LittleEndian.Uint64(f[136:]) != binary.LittleEndian.Uint64(w[128:]) {
			return zero, bad
		}
	} else if !absent(first.Value[2]) {
		return zero, bad
	}
	root, entry := first.Value[3], first.Value[4]
	var count, index uint64
	catalogue, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-retail-members-v2"), issuer[:], mint[:]}, program)
	if err != nil {
		return zero, err
	}
	if absent(root) {
		if !absent(entry) {
			return zero, bad
		}
	} else {
		d, e := value(root, keys[3], 104, "WENDOM01")
		if e != nil {
			return zero, fmt.Errorf("campaign accounting root: %w", e)
		}
		count = binary.LittleEndian.Uint64(d[56:])
		revision := binary.LittleEndian.Uint64(d[64:])
		_, bump, e := solana.FindProgramAddress([][]byte{[]byte("wen-accounting-domain-v1"), sale[:], {3}}, program)
		expected := make([]byte, 104)
		copy(expected, "WENDOM01")
		expected[8], expected[10], expected[11], expected[72] = 1, 3, bump, 1
		copy(expected[16:], sale[:])
		binary.LittleEndian.PutUint64(expected[48:], 1)
		binary.LittleEndian.PutUint64(expected[56:], count)
		binary.LittleEndian.PutUint64(expected[64:], revision)
		if e != nil || revision < count || revision == math.MaxUint64 || !bytes.Equal(d, expected) {
			return zero, fmt.Errorf("campaign accounting root content: %w", bad)
		}
	}
	if !absent(entry) {
		d, e := value(entry, keys[4], 128, "WENDS001")
		if e != nil {
			return zero, fmt.Errorf("campaign accounting entry: %w", e)
		}
		index = binary.LittleEndian.Uint64(d[80:])
		_, bump, e := solana.FindProgramAddress([][]byte{[]byte("wen-accounting-source-v1"), keys[3][:], catalogue[:]}, program)
		expected := make([]byte, 128)
		copy(expected, "WENDS001")
		expected[8], expected[11] = 1, bump
		copy(expected[16:], keys[3][:])
		copy(expected[48:], catalogue[:])
		binary.LittleEndian.PutUint64(expected[80:], index)
		if e != nil || index >= count || !bytes.Equal(d, expected) {
			return zero, fmt.Errorf("campaign accounting entry content: %w", bad)
		}
	} else {
		index = count
	}
	indexBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(indexBytes, index)
	indexKey, bump, err := solana.FindProgramAddress([][]byte{[]byte("wen-accounting-index-v1"), keys[3][:], indexBytes}, program)
	if err != nil {
		return zero, err
	}
	for _, key := range keys {
		if indexKey == key {
			return zero, bad
		}
	}
	indexed, err := read([]solana.PublicKey{indexKey}, first.Context.Slot)
	if err != nil {
		return zero, err
	}
	if absent(entry) {
		if !absent(indexed.Value[0]) {
			return zero, bad
		}
	} else {
		d, e := value(indexed.Value[0], indexKey, 120, "WENDIX01")
		if e != nil {
			return zero, fmt.Errorf("campaign accounting index: %w", e)
		}
		expected := make([]byte, 120)
		copy(expected, "WENDIX01")
		expected[8], expected[11] = 1, bump
		copy(expected[16:], keys[3][:])
		copy(expected[48:], catalogue[:])
		copy(expected[80:], keys[4][:])
		binary.LittleEndian.PutUint64(expected[112:], index)
		if !bytes.Equal(d, expected) {
			return zero, fmt.Errorf("campaign accounting index content: %w", bad)
		}
	}
	hashAccounts := func(pages ...*rpc.GetMultipleAccountsResult) [32]byte {
		h := sha256.New()
		var n [8]byte
		for _, page := range pages {
			for _, a := range page.Value {
				if a == nil {
					h.Write([]byte{0})
					continue
				}
				h.Write([]byte{1})
				h.Write(a.Owner[:])
				if a.Executable {
					h.Write([]byte{1})
				} else {
					h.Write([]byte{0})
				}
				binary.LittleEndian.PutUint64(n[:], a.Lamports)
				h.Write(n[:])
				if a.Data != nil {
					d := a.Data.GetBinary()
					binary.LittleEndian.PutUint64(n[:], uint64(len(d)))
					h.Write(n[:])
					h.Write(d)
				}
			}
		}
		var result [32]byte
		copy(result[:], h.Sum(nil))
		return result
	}
	firstHash := hashAccounts(first, indexed)
	lastKeys := append(append([]solana.PublicKey(nil), keys...), indexKey)
	last, err := read(lastKeys, indexed.Context.Slot)
	if err != nil {
		return zero, err
	}
	lastContext := &rpc.GetMultipleAccountsResult{Value: last.Value[:len(keys)]}
	lastIndex := &rpc.GetMultipleAccountsResult{Value: last.Value[len(keys):]}
	if hashAccounts(lastContext, lastIndex) != firstHash {
		return zero, bad
	}
	return firstHash, nil
}
