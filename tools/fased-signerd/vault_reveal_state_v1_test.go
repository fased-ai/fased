package main

import (
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

func TestVaultRevealWindowV1(t *testing.T) {
	_, s := vaultCycleReserveFixtureV1(t)
	s.Addresses, s.Accounts = s.Addresses[:1], s.Accounts[:1]
	c := s.Accounts[0].Data.GetBinary()
	binary.LittleEndian.PutUint64(c[360:368], 300)
	for _, slot := range []uint64{199, 200, 299, 300} {
		s.Slot = slot
		if err := validateVaultRevealWindowV1(43, s); (err == nil) != (slot >= 200 && slot < 300) {
			t.Fatalf("slot %d: %v", slot, err)
		}
	}
	s.Slot = 250
	for _, offset := range []int{0, 8, 32, 40, 48, 384} {
		old := c[offset]
		c[offset] ^= 1
		if validateVaultRevealWindowV1(43, s) == nil {
			t.Fatalf("accepted corrupted offset %d", offset)
		}
		c[offset] = old
	}
	s.Accounts[0].Executable = true
	if validateVaultRevealWindowV1(43, s) == nil {
		t.Fatal("accepted executable cycle")
	}
}

func TestVaultRevealCommitmentV1(t *testing.T) {
	scope, s := vaultCycleReserveFixtureV1(t)
	s.Slot = 250
	binary.LittleEndian.PutUint64(s.Accounts[0].Data.GetBinary()[360:368], 300)
	sat := s.Accounts[0].Owner
	var id [8]byte
	id[0] = 43
	miner, _, _ := solana.FindProgramAddress([][]byte{[]byte("sat_miner_cycle_state_v2"), scope.Authority[:], id[:]}, sat)
	registry, _, _ := solana.FindProgramAddress([][]byte{[]byte("sat_cycle_registry_meta"), id[:]}, sat)
	s.Addresses[1], s.Addresses[2] = miner, registry
	m := make([]byte, 416)
	m[0] = 150
	copy(m[72:104], scope.Authority[:])
	copy(m[104:136], scope.PermanentMining[:])
	m[136] = 43
	binary.LittleEndian.PutUint64(m[144:152], 1_000_000_000)
	hash := make([]byte, 32)
	hash[0] = 42
	copy(m[240:272], hash)
	copy(m[328:348], s.Accounts[0].Data.GetBinary()[384:404])
	s.Accounts[1] = &rpc.Account{Owner: sat, Data: rpc.DataBytesOrJSONFromBytes(m)}
	s.Accounts[2] = nil
	check := func(want uint64) {
		t.Helper()
		page, err := validateVaultRevealCommitmentV1(scope, 43, 1_000_000_000, hash, s)
		if err != nil || page != want {
			t.Fatalf("page %d, want %d: %v", page, want, err)
		}
	}
	check(0)
	s.Accounts[2] = &rpc.Account{Owner: solana.SystemProgramID, Lamports: 10}
	check(0)
	r := make([]byte, 88)
	r[0] = 134
	r[8] = 43
	s.Accounts[2] = &rpc.Account{Owner: sat, Data: rpc.DataBytesOrJSONFromBytes(r)}
	for _, count := range []uint32{0, 63, 64, 127, 128} {
		binary.LittleEndian.PutUint32(r[16:20], count)
		check(uint64(count) / 64)
	}
	for _, offset := range []int{0, 72, 104, 136, 144, 232, 233, 240, 328} {
		old := m[offset]
		m[offset] ^= 1
		if _, err := validateVaultRevealCommitmentV1(scope, 43, 1_000_000_000, hash, s); err == nil {
			t.Fatalf("accepted corrupted miner offset %d", offset)
		}
		m[offset] = old
	}
	r[8]++
	if _, err := validateVaultRevealCommitmentV1(scope, 43, 1_000_000_000, hash, s); err == nil {
		t.Fatal("accepted wrong registry cycle")
	}
}
