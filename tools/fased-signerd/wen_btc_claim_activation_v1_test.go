package main

import (
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

func claimActivationFixture(t *testing.T, v signerWENBTCClaimIntentV1) (*signerWENBTCAccountV1, *signerWENBTCAccountV1) {
	t.Helper()
	p := solana.MustPublicKeyFromBase58(v.ProgramID)
	key, b, e := solana.FindProgramAddress([][]byte{[]byte("wen-genesis-v1"), make([]byte, 32), make([]byte, 32)}, p)
	if e != nil || key.String() != v.Sale {
		t.Fatal("invalid fixture sale")
	}
	ak, ab, _ := solana.FindProgramAddress([][]byte{[]byte("wen-activation-v1"), key[:]}, p)
	create := func(k solana.PublicKey, magic string, n int, b, state byte) *signerWENBTCAccountV1 {
		d := make([]byte, n)
		copy(d, magic)
		d[8] = 1
		d[10] = state
		d[11] = b
		return &signerWENBTCAccountV1{Address: k, Owner: p, Slot: 150, Data: d}
	}
	s, a := create(key, "WENGEN01", 192, b, 3), create(ak, "WENACTR1", 160, ab, 1)
	put := func(d []byte, o int, n uint64) { binary.LittleEndian.PutUint64(d[o:], n) }
	put(s.Data, 152, 604800)
	put(s.Data, 160, 604801)
	put(s.Data, 168, 50000000000)
	put(s.Data, 176, 50000000000)
	copy(a.Data[16:], key[:])
	put(a.Data, 80, 604801)
	scaled := uint64(50000000000) * 100000
	put(a.Data, 88, scaled/2)
	put(a.Data, 120, scaled/2-scaled/3-scaled*40/300-scaled*6/300)
	return s, a
}
func TestWENBTCClaimActivation(t *testing.T) {
	for _, mode := range []string{"ok", "sale-address", "sale-owner", "sale-state", "sale-bump", "close", "accepted", "activation-owner", "activation-state", "activation-bump", "activation-sale", "activation-id", "activation-future", "minted", "staking", "slot", "short"} {
		t.Run(mode, func(t *testing.T) {
			v, _ := claimHistoryFixture(t, false)
			s, a := claimActivationFixture(t, v)
			switch mode {
			case "sale-address":
				s.Address[0] ^= 1
			case "sale-owner":
				s.Owner[0] ^= 1
			case "sale-state":
				s.Data[10] = 2
			case "sale-bump":
				s.Data[11] ^= 1
			case "close":
				s.Data[152] ^= 1
			case "accepted":
				binary.LittleEndian.PutUint64(s.Data[176:], 1)
			case "activation-owner":
				a.Owner[0] ^= 1
			case "activation-state":
				a.Data[10] = 0
			case "activation-bump":
				a.Data[11] ^= 1
			case "activation-sale":
				a.Data[16] ^= 1
			case "activation-id":
				a.Data[128] ^= 1
			case "activation-future":
				binary.LittleEndian.PutUint64(a.Data[80:], 44*86400)
			case "minted":
				a.Data[88] ^= 1
			case "staking":
				a.Data[120] ^= 1
			case "slot":
				a.Slot--
			case "short":
				s.Data = s.Data[:8]
			}
			e := validateWENLaunchActivationV1(solana.MustPublicKeyFromBase58(v.ProgramID), solana.MustPublicKeyFromBase58(v.Sale), 150, 43*86400, s, a)
			if (e == nil) != (mode == "ok") {
				t.Fatal(e)
			}
		})
	}
}

func TestWENRollingSaleActivationKeepsExistingClaims(t *testing.T) {
	v, _ := claimHistoryFixture(t, false)
	s, a := claimActivationFixture(t, v)
	s.Data = append(s.Data, make([]byte, 16)...)
	s.Data[8] = 3
	put := func(at int, n uint64) { binary.LittleEndian.PutUint64(s.Data[at:], n) }
	put(152, 4*86400)
	put(160, 23*86400)
	put(192, 86400)
	p := solana.MustPublicKeyFromBase58(v.ProgramID)
	key := solana.MustPublicKeyFromBase58(v.Sale)
	if err := validateWENLaunchActivationV1(p, key, 150, 43*86400, s, a); err != nil {
		t.Fatalf("rolling sale rejected: %v", err)
	}
	put(192, 0)
	if err := validateWENLaunchActivationV1(p, key, 150, 43*86400, s, a); err == nil {
		t.Fatal("rolling sale without threshold was accepted")
	}
}
