package main

import (
	"encoding/binary"
	"encoding/hex"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

func vaultCycleReserveFixtureV1(t *testing.T) (vaultCommitmentScopeV1, signerOwnedAccountSnapshotV2) {
	t.Helper()
	r, k, s := vaultMiningBindingFixtureV1(t)
	b, err := resolveVaultMiningBindingV1(r, k, s)
	if err != nil {
		t.Fatal(err)
	}
	return b.Scope, vaultCycleReserveForScopeV1(t, b.Scope)
}

func vaultCycleReserveForScopeV1(t *testing.T, scope vaultCommitmentScopeV1) signerOwnedAccountSnapshotV2 {
	t.Helper()
	sat := solana.MustPublicKeyFromBase58(satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID)
	var id [8]byte
	binary.LittleEndian.PutUint64(id[:], 43)
	cycle, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_cycle_state_v2"), id[:]}, sat)
	if err != nil {
		t.Fatal(err)
	}
	reserve, bump, err := solana.FindProgramAddress([][]byte{[]byte("sat_keeper_operating_reserve"), scope.PermanentMining[:]}, sat)
	if err != nil {
		t.Fatal(err)
	}
	c, d := make([]byte, 408), make([]byte, 144)
	c[0] = 149
	c[8] = 43
	c[32] = 1
	c[40] = 16
	binary.LittleEndian.PutUint64(c[344:], 100)
	binary.LittleEndian.PutUint64(c[352:], 200)
	for i, g := range []uint16{1, 2, 2, 3, 3, 3, 3, 2, 2, 2} {
		binary.LittleEndian.PutUint16(c[384+2*i:], g)
	}
	d[0] = 147
	d[8] = 1
	d[9] = 1
	d[10] = bump
	d[12] = 2
	d[14] = 1
	copy(d[16:48], scope.PermanentMining[:])
	protocol, pb, err := solana.FindProgramAddress([][]byte{[]byte("sat_protocol_generation_state_v2")}, sat)
	if err != nil {
		t.Fatal(err)
	}
	p := make([]byte, 184)
	p[0] = 152
	p[8] = 1
	p[9] = 1
	p[10] = pb
	p[11] = 1
	copy(p[12:32], c[384:404])
	digest, err := hex.DecodeString("ec935a84a00d6bd8269b856b84328684e3d977a5f0fb758fd3884cd310a6934c")
	if err != nil {
		t.Fatal(err)
	}
	copy(p[40:72], digest)
	copy(p[72:104], scope.Executor[:])
	binary.LittleEndian.PutUint64(p[104:], 1)
	binary.LittleEndian.PutUint64(p[112:], 7)
	return signerOwnedAccountSnapshotV2{Slot: 101, Addresses: []solana.PublicKey{cycle, reserve, protocol}, Accounts: []*rpc.Account{{Owner: sat, Data: rpc.DataBytesOrJSONFromBytes(c)}, {Owner: sat, Lamports: 1_120_000, Data: rpc.DataBytesOrJSONFromBytes(d)}, {Owner: sat, Data: rpc.DataBytesOrJSONFromBytes(p)}}}
}

func TestVaultCycleReserveV1(t *testing.T) {
	scope, s := vaultCycleReserveFixtureV1(t)
	if err := validateVaultCycleReserveV1(scope, 43, s, 1_000_000, 7); err != nil {
		t.Fatal(err)
	}
	for _, slot := range []uint64{99, 100, 199, 200} {
		s.Slot = slot
		err := validateVaultCycleReserveV1(scope, 43, s, 1_000_000, 7)
		if (err == nil) != (slot >= 100 && slot < 200) {
			t.Fatalf("wrong commit boundary %d: %v", slot, err)
		}
	}
	for _, tc := range []struct {
		name string
		a, o int
	}{{"sealed seed", 0, 48}, {"closed", 0, 32}, {"wrong cycle", 0, 8}, {"tuple", 0, 390}, {"identity", 1, 16}, {"bump", 1, 10}, {"padding", 1, 120}, {"encumbered", 1, 48}, {"invalid paid", 1, 56}} {
		t.Run(tc.name, func(t *testing.T) {
			scope, s := vaultCycleReserveFixtureV1(t)
			d := s.Accounts[tc.a].Data.GetBinary()
			d[tc.o] ^= 1
			s.Accounts[tc.a].Data = rpc.DataBytesOrJSONFromBytes(d)
			if validateVaultCycleReserveV1(scope, 43, s, 1_000_000, 7) == nil {
				t.Fatal("accepted invalid cycle/reserve")
			}
		})
	}
	scope, s = vaultCycleReserveFixtureV1(t)
	s.Accounts[1].Lamports--
	if validateVaultCycleReserveV1(scope, 43, s, 1_000_000, 7) == nil {
		t.Fatal("accepted reserve short by one lamport")
	}
}

func TestVaultProtocolActivationV1(t *testing.T) {
	for _, offset := range []int{0, 8, 9, 10, 11, 12, 32, 40, 104, 112} {
		scope, s := vaultCycleReserveFixtureV1(t)
		p := s.Accounts[2].Data.GetBinary()
		p[offset] ^= 1
		s.Accounts[2].Data = rpc.DataBytesOrJSONFromBytes(p)
		if validateVaultCycleReserveV1(scope, 43, s, 1_000_000, 7) == nil {
			t.Fatalf("accepted altered protocol field %d", offset)
		}
	}
	scope, s := vaultCycleReserveFixtureV1(t)
	for _, generation := range []uint64{0, 6, 8} {
		if validateVaultCycleReserveV1(scope, 43, s, 1_000_000, generation) == nil {
			t.Fatal("accepted wrong reviewed activation")
		}
	}
}
