package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
)

// Internal decoded observations, never request-supplied evidence. The protected
// execution service must obtain these in one finalized, genesis-checked RPC batch.
// These validators do not fetch state or authorize signing.
type signerWENBTCAccountV1 struct {
	Address, Owner solana.PublicKey
	Slot           uint64
	Executable     bool
	Data           []byte
}

func verifyWENBTCDeploymentV1(pins signerWENBTCPinsV1, slot uint64, program, data *signerWENBTCAccountV1) error {
	bad := errors.New("WEN BTC deployment readback mismatch")
	key, err := solana.PublicKeyFromBase58(pins.ProgramID)
	if err != nil || key.IsZero() || pins.DeploymentSlot == 0 || pins.DeploymentSlot > slot {
		return bad
	}
	loader := solana.MustPublicKeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")
	address, _, err := solana.FindProgramAddress([][]byte{key[:]}, loader)
	if err != nil || program == nil || data == nil {
		return bad
	}
	if program.Address != key || data.Address != address || program.Owner != loader || data.Owner != loader || program.Slot != slot || data.Slot != slot || !program.Executable || data.Executable || len(program.Data) != 36 || len(data.Data) <= 45 || len(data.Data) > 10*1024*1024 {
		return bad
	}
	if binary.LittleEndian.Uint32(program.Data) != 2 || !bytes.Equal(program.Data[4:], address[:]) || binary.LittleEndian.Uint32(data.Data) != 3 || binary.LittleEndian.Uint64(data.Data[4:12]) != pins.DeploymentSlot {
		return bad
	}
	if pins.UpgradeAuthority == nil {
		if data.Data[12] != 0 {
			return bad
		}
	} else if data.Data[12] != 1 || !bytes.Equal(data.Data[13:45], pins.UpgradeAuthority[:]) {
		return bad
	}
	if wenHashV1(data.Data[45:]) != pins.CodeSHA256 {
		return bad
	}
	return nil
}

func (a signerWENBTCArtifactsV1) verifyAcceptanceSourceV1(slot uint64, source *signerWENBTCAccountV1) error {
	bad := errors.New("WEN BTC acceptance funding custody mismatch")
	token := solana.MustPublicKeyFromBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
	if source == nil || source.Address != a.source || source.Owner != token || source.Executable || source.Slot != slot || len(source.Data) != 165 {
		return bad
	}
	d := source.Data
	if !bytes.Equal(d[:32], a.keys[3][:]) || !bytes.Equal(d[32:64], a.keys[2][:]) || binary.LittleEndian.Uint64(d[64:72]) < a.numbers[4] || d[108] != 1 {
		return bad
	}
	// No delegate or close authority may control the funding account. Native
	// wrappers are not admitted as this route's independently selected cash mint.
	if binary.LittleEndian.Uint32(d[72:76]) != 0 || binary.LittleEndian.Uint32(d[109:113]) != 0 || binary.LittleEndian.Uint32(d[129:133]) != 0 {
		return bad
	}
	return nil
}
