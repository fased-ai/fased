package main

import (
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

func TestWENMiningFundingReservationV1(t *testing.T) {
	v, owner, _ := miningFundingFixture(t)
	ix, e := buildWENMiningFundingInstructionV1(v, owner)
	if e != nil {
		t.Fatal(e)
	}
	p := ix.ProgramID()
	a := ix.Accounts()
	id := solana.MustPublicKeyFromBase58(v.VaultID)
	vault := a[0].PublicKey
	_, vb, _ := solana.FindProgramAddress([][]byte{[]byte("wen-portfolio-sol-v1"), owner[:], id[:]}, p)
	nonce := uint64(0)
	for _, c := range v.Nonce {
		nonce = nonce*10 + uint64(c-'0')
	}
	le := make([]byte, 8)
	binary.LittleEndian.PutUint64(le, nonce)
	_, ab, _ := solana.FindProgramAddress([][]byte{[]byte("wen-portfolio-action-v1"), vault[:], le}, p)
	d, q := make([]byte, 160), make([]byte, 112)
	copy(d, []byte("WENPVL01"))
	copy(q, []byte("WENPVA01"))
	d[8] = 1
	q[8] = 1
	d[10] = 1
	d[11] = vb
	q[11] = ab
	put := func(d []byte, o int, n uint64) { binary.LittleEndian.PutUint64(d[o:], n) }
	key := func(d []byte, o int, k solana.PublicKey) { copy(d[o:o+32], k[:]) }
	key(d, 16, owner)
	key(d, 48, id)
	key(d, 80, a[5].PublicKey)
	put(d, 120, 6000)
	put(d, 144, 2)
	key(q, 16, vault)
	put(q, 48, nonce)
	put(q, 56, 6000)
	put(q, 64, 100)
	key(q, 72, a[5].PublicKey)
	s := wenMiningFundingReservationV1{Slot: 2, Now: 10, VaultLamports: 8000, VaultRent: 2000, Vault: &signerWENBTCAccountV1{Address: vault, Owner: p, Slot: 2, Data: d}, Action: &signerWENBTCAccountV1{Address: a[1].PublicKey, Owner: p, Slot: 2, Data: q}}
	if e = validateWENMiningFundingReservationV1(v, owner, s); e != nil {
		t.Fatal(e)
	} // disabled, zero limit still pays accepted action
	for _, r := range []*signerWENBTCAccountV1{s.Vault, s.Action} {
		for _, offset := range []int{0, 8, 9, 10, 11, 12, 16, 48, 80, len(r.Data) - 1} {
			r.Data[offset] ^= 255
			if validateWENMiningFundingReservationV1(v, owner, s) == nil {
				t.Fatalf("mutated byte %d accepted", offset)
			}
			r.Data[offset] ^= 255
		}
	}
	for _, mutate := range []func(*wenMiningFundingReservationV1){func(x *wenMiningFundingReservationV1) { x.Now = 100 }, func(x *wenMiningFundingReservationV1) { x.Slot = 20 }, func(x *wenMiningFundingReservationV1) { x.VaultLamports-- }, func(x *wenMiningFundingReservationV1) { x.Action = nil }} {
		x := s
		mutate(&x)
		if validateWENMiningFundingReservationV1(v, owner, x) == nil {
			t.Fatal("invalid reservation accepted")
		}
	}
	put(q, 56, 5999)
	if validateWENMiningFundingReservationV1(v, owner, s) == nil {
		t.Fatal("wrong expected amount")
	}
	put(q, 56, 6000)
	put(d, 128, ^uint64(0))
	if validateWENMiningFundingReservationV1(v, owner, s) == nil {
		t.Fatal("overflow")
	}
}
