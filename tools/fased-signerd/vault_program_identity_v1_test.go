package main

import (
	"crypto/sha256"
	"encoding/binary"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

func vaultProgramFixtureV1(t *testing.T) (vaultProgramPinV1, signerOwnedAccountSnapshotV2) {
	t.Helper()
	program, authority := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	loader := solana.MustPublicKeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")
	pda, _, err := solana.FindProgramAddress([][]byte{program[:]}, loader)
	if err != nil {
		t.Fatal(err)
	}
	elf := []byte{0x7f, 'E', 'L', 'F', 1, 2, 3, 4}
	pin := vaultProgramPinV1{Program: program, DeploymentSlot: 100, UpgradeAuthority: &authority, ELFSize: uint64(len(elf)), ELFSHA256: sha256.Sum256(elf), ProgramDataSize: 61}
	p, d := make([]byte, 36), make([]byte, 61)
	binary.LittleEndian.PutUint32(p, 2)
	copy(p[4:], pda[:])
	binary.LittleEndian.PutUint32(d, 3)
	binary.LittleEndian.PutUint64(d[4:], 100)
	d[12] = 1
	copy(d[13:45], authority[:])
	copy(d[45:], elf)
	return pin, signerOwnedAccountSnapshotV2{Slot: 101, Addresses: []solana.PublicKey{program, pda}, Accounts: []*rpc.Account{{Owner: loader, Executable: true, Data: rpc.DataBytesOrJSONFromBytes(p)}, {Owner: loader, Data: rpc.DataBytesOrJSONFromBytes(d)}}}
}

func TestVaultProgramIdentityV1(t *testing.T) {
	pin, s := vaultProgramFixtureV1(t)
	if err := verifyVaultProgramIdentityV1(pin, s); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name            string
		account, offset int
	}{{"program tag", 0, 0}, {"link", 0, 4}, {"data tag", 1, 0}, {"slot", 1, 4}, {"authority option", 1, 12}, {"authority", 1, 13}, {"ELF", 1, 49}, {"tail", 1, 60}} {
		t.Run(tc.name, func(t *testing.T) {
			p, s := vaultProgramFixtureV1(t)
			b := s.Accounts[tc.account].Data.GetBinary()
			b[tc.offset] ^= 1
			s.Accounts[tc.account].Data = rpc.DataBytesOrJSONFromBytes(b)
			if verifyVaultProgramIdentityV1(p, s) == nil {
				t.Fatal("accepted changed deployment")
			}
		})
	}
	for _, mutate := range []func(*vaultProgramPinV1, *signerOwnedAccountSnapshotV2){
		func(p *vaultProgramPinV1, s *signerOwnedAccountSnapshotV2) { s.Slot = 99 },
		func(p *vaultProgramPinV1, s *signerOwnedAccountSnapshotV2) { s.Accounts[0].Executable = false },
		func(p *vaultProgramPinV1, s *signerOwnedAccountSnapshotV2) { s.Accounts[1].Owner = p.Program },
		func(p *vaultProgramPinV1, s *signerOwnedAccountSnapshotV2) {
			s.Accounts[1].Data = rpc.DataBytesOrJSONFromBytes([]byte{3})
		},
		func(p *vaultProgramPinV1, s *signerOwnedAccountSnapshotV2) { p.ELFSize = ^uint64(0) },
		func(p *vaultProgramPinV1, s *signerOwnedAccountSnapshotV2) { p.UpgradeAuthority = nil },
		func(p *vaultProgramPinV1, s *signerOwnedAccountSnapshotV2) { s.Addresses[1] = p.Program },
	} {
		p, s := vaultProgramFixtureV1(t)
		mutate(&p, &s)
		if verifyVaultProgramIdentityV1(p, s) == nil {
			t.Fatal("accepted invalid identity")
		}
	}
	// Revoked authority is valid only with an explicitly immutable trusted pin.
	pin.UpgradeAuthority = nil
	data := s.Accounts[1].Data.GetBinary()
	data[12] = 0
	s.Accounts[1].Data = rpc.DataBytesOrJSONFromBytes(data)
	if err := verifyVaultProgramIdentityV1(pin, s); err != nil {
		t.Fatal(err)
	}
}

func TestVaultDeploymentPairV1(t *testing.T) {
	fixture := func(program solana.PublicKey) (vaultProgramPinV1, signerOwnedAccountSnapshotV2) {
		pin, s := vaultProgramFixtureV1(t)
		pin.Program = program
		loader := s.Accounts[0].Owner
		pda, _, err := solana.FindProgramAddress([][]byte{program[:]}, loader)
		if err != nil {
			t.Fatal(err)
		}
		s.Addresses[0], s.Addresses[1] = program, pda
		copy(s.Accounts[0].Data.GetBinary()[4:36], pda[:])
		return pin, s
	}
	c, cs := fixture(solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1))
	s, ss := fixture(solana.MustPublicKeyFromBase58(satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID))
	if err := verifyVaultDeploymentPairV1(c, s, cs, ss, 101); err != nil {
		t.Fatal(err)
	}
	if verifyVaultDeploymentPairV1(s, c, ss, cs, 101) == nil {
		t.Fatal("accepted swapped program roles")
	}
	for _, slot := range []uint64{0, 100, 102} {
		if verifyVaultDeploymentPairV1(c, s, cs, ss, slot) == nil {
			t.Fatalf("accepted state slot %d", slot)
		}
	}
	ss.Slot++
	if verifyVaultDeploymentPairV1(c, s, cs, ss, 101) == nil {
		t.Fatal("accepted mixed program contexts")
	}
	ss.Slot--
	for _, snapshot := range []signerOwnedAccountSnapshotV2{cs, ss} {
		data := snapshot.Accounts[1].Data.GetBinary()
		data[49] ^= 1
		if verifyVaultDeploymentPairV1(c, s, cs, ss, 101) == nil {
			t.Fatal("accepted changed executable")
		}
		data[49] ^= 1
	}
}
