package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"math/big"
)

type signerWENBTCRouteV1 struct {
	Program  solana.PublicKey
	Data     []byte
	Accounts []signerTypedAccountV2
}

// Only immutable artifact loading is shared with acceptance. Acquisition must
// not require the acceptance window to remain open; its own deadline applies.
func loadWENBTCAcquisitionV1(root string, pins signerWENBTCPinsV1, intent signerWENBTCIntentV1, wallet solana.PublicKey, slot, now uint64) (signerWENBTCArtifactsV1, error) {
	if intent.Operation != "acquisition" {
		return signerWENBTCArtifactsV1{}, errors.New("expected WEN BTC acquisition intent")
	}
	a, err := loadWENBTCArtifactsV1(root, pins, intent, wallet, slot, 0, "acquisition")
	if err != nil {
		return a, err
	}
	if now > a.numbers[15] {
		return signerWENBTCArtifactsV1{}, errors.New("WEN BTC conversion expired")
	}
	return a, nil
}

func (a signerWENBTCArtifactsV1) acquisitionInstruction(payer solana.PublicKey, route signerWENBTCRouteV1, now uint64) ([]byte, []signerTypedAccountV2, error) {
	bad := errors.New("WEN BTC acquisition route mismatch")
	if err := a.validateTerms(0); err != nil {
		return nil, nil, err
	}
	jup := solana.MustPublicKeyFromBase58("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")
	usdc := solana.MustPublicKeyFromBase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
	btc := solana.MustPublicKeyFromBase58("cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij")
	if payer.IsZero() || now > a.numbers[15] || route.Program != jup || a.keys[3] != usdc || a.keys[4] != btc || a.keys[5] != jup {
		return nil, nil, bad
	}
	var deriveErr error
	derive := func(program solana.PublicKey, seeds ...[]byte) solana.PublicKey {
		k, _, err := solana.FindProgramAddress(seeds, program)
		if err != nil {
			deriveErr = err
		}
		return k
	}
	nonce := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonce, a.numbers[0])
	record := derive(a.program, []byte("wen-btc-subscription-v1"), a.keys[0][:], a.keys[2][:], nonce)
	stage := func(seed string) solana.PublicKey { return derive(a.program, []byte(seed), record[:]) }
	source, dest, authority := stage("wen-btc-sub-route-cash-v1"), stage("wen-btc-sub-route-asset-v1"), stage("wen-btc-swap-v1")
	if a.keys[6] != stage("wen-btc-subscription-cash-v1") {
		return nil, nil, bad
	}
	for _, i := range []int{6, 7, 8, 9} {
		if a.keys[i] == source || a.keys[i] == dest {
			return nil, nil, bad
		}
	}
	d := route.Data
	r := route.Accounts
	if len(d) < 36 || len(d) > 44 || len(r) < 14 || len(r) > 64 {
		return nil, nil, bad
	}
	discriminator := sha256.Sum256([]byte("global:shared_accounts_route"))
	if !bytes.Equal(d[:8], discriminator[:8]) || d[8] >= 8 {
		return nil, nil, bad
	}
	count := binary.LittleEndian.Uint32(d[9:13])
	if count < 1 || count > 3 {
		return nil, nil, bad
	}
	at := 13 + 4*int(count)
	if len(d) != at+19 {
		return nil, nil, bad
	}
	for i := 0; i < int(count); i++ {
		if !bytes.Equal(d[13+4*i:17+4*i], []byte{26, 100, byte(i), byte(i + 1)}) {
			return nil, nil, bad
		}
	}
	quote := binary.LittleEndian.Uint64(d[at+8:])
	slip := binary.LittleEndian.Uint16(d[at+16:])
	if binary.LittleEndian.Uint64(d[at:]) != a.numbers[10] || quote == 0 || slip > 50 || d[at+18] != 0 {
		return nil, nil, bad
	}
	floor := new(big.Int).Mul(new(big.Int).SetUint64(quote), new(big.Int).SetUint64(uint64(10000-slip)))
	floor.Div(floor, big.NewInt(10000))
	if floor.Cmp(new(big.Int).SetUint64(a.numbers[13])) < 0 {
		return nil, nil, bad
	}
	rk := make([]solana.PublicKey, len(r))
	for i, m := range r {
		k, err := solana.PublicKeyFromBase58(m.Pubkey)
		if err != nil || k.String() != m.Pubkey || k == a.program || m.IsSigner != (i == 2) {
			return nil, nil, bad
		}
		rk[i] = k
	}
	fixed := []solana.PublicKey{solana.TokenProgramID, derive(jup, []byte("authority"), []byte{d[8]}), authority, source, rk[4], rk[5], dest, usdc, btc, jup, jup, derive(jup, []byte("__event_authority")), jup}
	for i, m := range r {
		if i < 13 {
			if rk[i] != fixed[i] || m.IsWritable != (i >= 3 && i <= 6) {
				return nil, nil, bad
			}
		} else {
			for _, k := range []solana.PublicKey{authority, source, dest, usdc, btc} {
				if rk[i] == k {
					return nil, nil, bad
				}
			}
		}
	}
	if rk[4] == rk[5] {
		return nil, nil, bad
	}
	for _, i := range []int{4, 5} {
		for _, k := range []solana.PublicKey{source, dest, authority, usdc, btc, jup, solana.TokenProgramID} {
			if rk[i] == k {
				return nil, nil, bad
			}
		}
	}
	push := solana.MustPublicKeyFromBase58("pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou")
	feed := func(h string) solana.PublicKey { b, _ := hex.DecodeString(h); return derive(push, []byte{0, 0}, b) }
	order := []solana.PublicKey{payer, record, a.keys[6], a.keys[7], a.keys[8], {}, feed("eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a"), feed("2817d7bfe5c64b8ea956e9a26f573ef64e72e4d7891f2d6af9bcc93f7aff9a97")}
	if deriveErr != nil {
		return nil, nil, deriveErr
	}
	seen := map[solana.PublicKey]bool{}
	for _, k := range order {
		if seen[k] || k == jup {
			return nil, nil, bad
		}
		seen[k] = true
	}
	for _, k := range rk {
		if seen[k] {
			return nil, nil, bad
		}
	}
	keys := make([]signerTypedAccountV2, 0, len(r)+9)
	for i, k := range order {
		keys = append(keys, signerTypedAccountV2{Pubkey: k.String(), IsSigner: i == 0, IsWritable: i < 5})
	}
	for _, m := range r {
		m.IsSigner = false
		keys = append(keys, m)
	}
	keys = append(keys, signerTypedAccountV2{Pubkey: jup.String()})
	data := append([]byte{112}, a.offer[:]...)
	data = append(data, byte(len(r)))
	for _, m := range r {
		var f byte
		if m.IsSigner {
			f |= 1
		}
		if m.IsWritable {
			f |= 2
		}
		data = append(data, f)
	}
	data = append(data, d...)
	return data, keys, nil
}

func (a signerWENBTCArtifactsV1) verifyAcquisitionAccountsV1(slot, now uint64, record, cash, reserve, working *signerWENBTCAccountV1) error {
	bad := errors.New("WEN BTC funded acquisition readback mismatch")
	if record == nil || record.Owner != a.program || record.Executable || record.Slot != slot || len(record.Data) != 192 || now > a.numbers[15] {
		return bad
	}
	d := record.Data
	accepted := binary.LittleEndian.Uint64(d[120:128])
	if now < accepted {
		return bad
	}
	if err := a.validateTerms(accepted); err != nil {
		return err
	}
	nonce := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonce, a.numbers[0])
	address, bump, err := solana.FindProgramAddress([][]byte{[]byte("wen-btc-subscription-v1"), a.keys[0][:], a.keys[2][:], nonce}, a.program)
	if err != nil || record.Address != address {
		return bad
	}
	digest := sha256.Sum256(append([]byte("wen-btc-subscription-offer-v1"), a.offer[8:]...))
	expected := make([]byte, 192)
	copy(expected, []byte("WENBTCS1"))
	expected[8] = 1
	expected[11] = bump
	copy(expected[16:], a.keys[0][:])
	copy(expected[48:], a.keys[2][:])
	copy(expected[80:], digest[:])
	copy(expected[112:], nonce)
	copy(expected[120:], d[120:128])
	binary.LittleEndian.PutUint64(expected[128:], a.numbers[10])
	binary.LittleEndian.PutUint64(expected[136:], a.numbers[12])
	if !bytes.Equal(expected, d) || a.numbers[12] > ^uint64(0)-a.numbers[10] {
		return bad
	}
	authority, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-activation-v1"), a.keys[0][:]}, a.program)
	if err != nil {
		return err
	}
	validate := func(account *signerWENBTCAccountV1, key, mint, owner solana.PublicKey, minimum uint64) error {
		copyA := a
		copyA.source = key
		copyA.keys[3] = mint
		copyA.keys[2] = owner
		copyA.numbers[4] = minimum
		return copyA.verifyAcceptanceSourceV1(slot, account)
	}
	if err = validate(cash, a.keys[6], a.keys[3], address, a.numbers[10]+a.numbers[12]); err != nil {
		return err
	}
	if err = validate(reserve, a.keys[7], a.keys[4], authority, 0); err != nil {
		return err
	}
	return validate(working, a.keys[8], a.keys[3], authority, 0)
}
