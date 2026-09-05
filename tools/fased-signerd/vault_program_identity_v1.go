package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"

	solana "github.com/gagliardetto/solana-go"
)

// Pins must come from an authenticated release contract, never an RPC request or
// the same endpoint supplying account bytes. No public operation accepts pins.
type vaultProgramPinV1 struct {
	Program          solana.PublicKey
	DeploymentSlot   uint64
	UpgradeAuthority *solana.PublicKey // nil means immutable
	ELFSize          uint64
	ELFSHA256        [32]byte
	ProgramDataSize  uint64
}

// Internal release-context validation only. Neither pins nor account snapshots
// become trusted merely by passing this function. The native authenticated
// release reader must supply pins before this can gate a live signing operation.
// Both programs must be observed in the same context as the transaction state.
func verifyVaultDeploymentPairV1(capital, sat vaultProgramPinV1, capitalSnapshot, satSnapshot signerOwnedAccountSnapshotV2, stateSlot uint64) error {
	if capital.Program != solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1) || sat.Program != solana.MustPublicKeyFromBase58(satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID) {
		return errors.New("Vault deployment pair does not match executable contract")
	}
	if stateSlot == 0 || capitalSnapshot.Slot != stateSlot || satSnapshot.Slot != stateSlot {
		return errors.New("Vault deployment and state contexts differ")
	}
	if err := verifyVaultProgramIdentityV1(capital, capitalSnapshot); err != nil {
		return err
	}
	return verifyVaultProgramIdentityV1(sat, satSnapshot)
}

// Verifies one upgradeable-loader Program/ProgramData pair in a single snapshot.
// This is byte identity, not proof that the RPC is honest, finalized, or that a
// later upgrade cannot race execution. Those remain caller/review obligations.
func verifyVaultProgramIdentityV1(pin vaultProgramPinV1, snapshot signerOwnedAccountSnapshotV2) error {
	if pin.Program.IsZero() || pin.DeploymentSlot == 0 || pin.ELFSize < 4 || pin.ProgramDataSize < 45 || pin.ELFSize > pin.ProgramDataSize-45 || pin.ELFSHA256 == ([32]byte{}) {
		return errors.New("invalid trusted Vault program pin")
	}
	loader := solana.MustPublicKeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")
	programData, _, err := solana.FindProgramAddress([][]byte{pin.Program[:]}, loader)
	if err != nil {
		return err
	}
	if snapshot.Slot < pin.DeploymentSlot || len(snapshot.Addresses) != 2 || len(snapshot.Accounts) != 2 || snapshot.Addresses[0] != pin.Program || snapshot.Addresses[1] != programData {
		return errors.New("Vault deployment snapshot identity/slot mismatch")
	}
	p, d := snapshot.Accounts[0], snapshot.Accounts[1]
	if p == nil || d == nil || p.Data == nil || d.Data == nil || p.Owner != loader || d.Owner != loader || !p.Executable || d.Executable {
		return errors.New("invalid Vault loader account ownership/flags")
	}
	pb, db := p.Data.GetBinary(), d.Data.GetBinary()
	if len(pb) != 36 || uint64(len(db)) != pin.ProgramDataSize || binary.LittleEndian.Uint32(pb[:4]) != 2 || !bytes.Equal(pb[4:36], programData[:]) {
		return errors.New("invalid Vault Program to ProgramData linkage")
	}
	if binary.LittleEndian.Uint32(db[:4]) != 3 || binary.LittleEndian.Uint64(db[4:12]) != pin.DeploymentSlot {
		return errors.New("Vault ProgramData deployment generation mismatch")
	}
	if pin.UpgradeAuthority == nil {
		if db[12] != 0 {
			return errors.New("Vault program is not immutable")
		}
	} else if pin.UpgradeAuthority.IsZero() || db[12] != 1 || !bytes.Equal(db[13:45], pin.UpgradeAuthority[:]) {
		return errors.New("Vault upgrade authority mismatch")
	}
	end := 45 + int(pin.ELFSize) // bounded by the verified account length above
	elf := db[45:end]
	if !bytes.Equal(elf[:4], []byte{0x7f, 'E', 'L', 'F'}) || sha256.Sum256(elf) != pin.ELFSHA256 {
		return errors.New("Vault executable digest mismatch")
	}
	for _, value := range db[end:] {
		if value != 0 {
			return errors.New("nonzero Vault deployment trailing bytes")
		}
	}
	return nil
}
