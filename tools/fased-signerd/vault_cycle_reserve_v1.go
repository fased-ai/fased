package main

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"errors"

	solana "github.com/gagliardetto/solana-go"
)

// Snapshot order is cycle, Operating Reserve, protocol generation. Rent minimum must be obtained by
// the native caller from the verified network, never from Gateway input. This
// does not prove RPC freshness or time left to submit. Expected activation must
// be bound to the reviewed request, never inferred from the replacement snapshot.
func validateVaultCycleReserveV1(scope vaultCommitmentScopeV1, cycleID uint64, snapshot signerOwnedAccountSnapshotV2, reserveRentMinimum uint64, expectedActivation uint64) error {
	if cycleID == 0 || expectedActivation == 0 || snapshot.Slot == 0 || reserveRentMinimum == 0 || len(snapshot.Addresses) != 3 || len(snapshot.Accounts) != 3 {
		return errors.New("incomplete Vault cycle/reserve context")
	}
	sat := solana.MustPublicKeyFromBase58(satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID)
	var id [8]byte
	binary.LittleEndian.PutUint64(id[:], cycleID)
	cycle, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_cycle_state_v2"), id[:]}, sat)
	if err != nil {
		return err
	}
	reserve, bump, err := solana.FindProgramAddress([][]byte{[]byte("sat_keeper_operating_reserve"), scope.PermanentMining[:]}, sat)
	if err != nil {
		return err
	}
	protocol, protocolBump, err := solana.FindProgramAddress([][]byte{[]byte("sat_protocol_generation_state_v2")}, sat)
	if err != nil {
		return err
	}
	if snapshot.Addresses[0] != cycle || snapshot.Addresses[1] != reserve || snapshot.Addresses[2] != protocol {
		return errors.New("wrong Vault cycle/reserve addresses")
	}
	for i, size := range []int{408, 144, 184} {
		a := snapshot.Accounts[i]
		if a == nil || a.Data == nil || a.Executable || a.Owner != sat || len(a.Data.GetBinary()) != size {
			return errors.New("invalid Vault cycle/reserve account")
		}
	}
	c, r := snapshot.Accounts[0].Data.GetBinary(), snapshot.Accounts[1].Data.GetBinary()
	u64 := func(d []byte, o int) uint64 { return binary.LittleEndian.Uint64(d[o : o+8]) }
	p := snapshot.Accounts[2].Data.GetBinary()
	if !bytes.Equal(p[:8], []byte{152, 0, 0, 0, 0, 0, 0, 0}) || p[8] != 1 || p[9] != 1 || p[10] != protocolBump || p[11] != 1 || !bytes.Equal(p[32:40], make([]byte, 8)) || bytes.Equal(p[72:104], make([]byte, 32)) || u64(p, 104) == 0 || u64(p, 104) > snapshot.Slot || u64(p, 112) != expectedActivation {
		return errors.New("Vault public entry is disabled or activation changed")
	}
	if hex.EncodeToString(p[40:72]) != "ec935a84a00d6bd8269b856b84328684e3d977a5f0fb758fd3884cd310a6934c" { // pragma: allowlist secret
		return errors.New("Vault protocol economics digest mismatch")
	}
	if !bytes.Equal(c[:8], []byte{149, 0, 0, 0, 0, 0, 0, 0}) || u64(c, 8) != cycleID || c[32] != 1 || u64(c, 40) != 16 || !bytes.Equal(c[48:80], make([]byte, 32)) || snapshot.Slot < u64(c, 344) || snapshot.Slot >= u64(c, 352) {
		return errors.New("Vault cycle is outside the open commit window")
	}
	for i, g := range []uint16{1, 2, 2, 3, 3, 3, 3, 2, 2, 2} {
		if binary.LittleEndian.Uint16(p[12+2*i:14+2*i]) != g {
			return errors.New("wrong Vault protocol generation")
		}
		if binary.LittleEndian.Uint16(c[384+2*i:386+2*i]) != g {
			return errors.New("wrong Vault cycle generation")
		}
	}
	if !bytes.Equal(r[:8], []byte{147, 0, 0, 0, 0, 0, 0, 0}) || r[8] != 1 || r[9] != 1 || r[10] != bump || r[11] != 0 || binary.LittleEndian.Uint16(r[12:14]) != 2 || binary.LittleEndian.Uint16(r[14:16]) != 1 || !bytes.Equal(r[16:48], scope.PermanentMining[:]) || !bytes.Equal(r[120:144], make([]byte, 24)) {
		return errors.New("invalid Vault Operating Reserve identity/layout")
	}
	reserved, paid, debt, refunded, rolled := u64(r, 48), u64(r, 56), u64(r, 64), u64(r, 72), u64(r, 80)
	disposition := uint64(0)
	for _, v := range []uint64{paid, debt, refunded, rolled} {
		if disposition > ^uint64(0)-v {
			return errors.New("Vault reserve accounting overflow")
		}
		disposition += v
	}
	if disposition > reserved {
		return errors.New("Vault reserve dispositions exceed reservations")
	}
	encumbered := reserved - paid - refunded
	balance := snapshot.Accounts[1].Lamports
	const charge = uint64(40000 * 3) // canonical interface_generation_v2 work allowance
	if balance < reserveRentMinimum || balance-reserveRentMinimum < encumbered || balance-reserveRentMinimum-encumbered < charge || reserved > ^uint64(0)-charge {
		return errors.New("insufficient unencumbered Vault Operating Reserve")
	}
	return nil
}
