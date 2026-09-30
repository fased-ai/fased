package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

type wenMiningEntrySnapshotV1 struct {
	Address, Owner solana.PublicKey
	Executable     bool
	Data           []byte
	Slot, Now      uint64
}

// Pure canonical check. The caller must acquire finalized deployment/Clock pins
// independently; a supplied snapshot is not RPC authentication or signing consent.
// Reveal bytes come from protected preimage storage, never general intent logging.
func prepareWENMiningInstructionV1(v signerWENMiningIntentV1, wallet solana.PublicKey, s wenMiningEntrySnapshotV1, reveal []byte) (solana.Instruction, error) {
	bad := errors.New("WEN mining entry or phase rejected")
	if err := validateWENMiningIntentV1(v); err != nil {
		return nil, err
	}
	parse := func(s string) uint64 { n, _ := strconv.ParseUint(s, 10, 64); return n }
	program := solana.MustPublicKeyFromBase58(v.ProgramID)
	if wallet.IsZero() || s.Owner != program || s.Executable || len(s.Data) != 272 || s.Slot < parse(v.MinFinalizedSlot) || s.Slot >= parse(v.ExpiresSlot) {
		return nil, bad
	}
	d := append([]byte(nil), s.Data...)
	sum := sha256.Sum256(d)
	if hex.EncodeToString(sum[:]) != v.EntrySHA256 || string(d[:8]) != "WENMEN01" || d[8] != 1 || d[9] > 1 || d[10] != 0 || !bytes.Equal(d[12:16], make([]byte, 4)) {
		return nil, bad
	}
	for i, key := range []solana.PublicKey{program, solana.MustPublicKeyFromBase58(v.Economy), solana.MustPublicKeyFromBase58(v.Offer), wallet, solana.MustPublicKeyFromBase58(v.CapitalVault)} {
		if !bytes.Equal(d[16+i*32:48+i*32], key[:]) {
			return nil, bad
		}
	}
	for i, n := range []uint64{parse(v.Nonce), parse(v.Capital), parse(v.Open)} {
		if binary.LittleEndian.Uint64(d[176+i*8:184+i*8]) != n {
			return nil, bad
		}
	}
	entry, bump, err := solana.FindProgramAddress([][]byte{[]byte("wen-mining-entry-v1"), d[80:112], wallet[:], d[176:184]}, program)
	if err != nil || entry.String() != v.Entry || entry != s.Address || d[11] != bump || entry == wallet || program == wallet || entry == program || s.Now < parse(v.Open) {
		return nil, bad
	}
	elapsed := s.Now - parse(v.Open)
	commitment, _ := hex.DecodeString(v.CommitmentSHA256)
	var data []byte
	if v.Operation == "commit" {
		if elapsed >= 180 || d[9] != 0 || len(reveal) != 0 || !bytes.Equal(d[200:], make([]byte, 72)) {
			return nil, bad
		}
		data = append([]byte{54}, commitment...)
	} else {
		material := append([]byte(nil), reveal...)
		if elapsed < 180 || elapsed >= 900 || d[9] != 1 || len(material) != 40 || !bytes.Equal(d[232:], make([]byte, 40)) || !bytes.Equal(d[200:232], commitment) {
			return nil, bad
		}
		total := uint32(0)
		for i := 0; i < 4; i++ {
			total += uint32(binary.LittleEndian.Uint16(material[i*2 : i*2+2]))
		}
		if total != 10000 {
			return nil, bad
		}
		proof := append([]byte("wen-mining-commitment-v1"), d[16:192]...)
		proof = append(proof, material...)
		digest := sha256.Sum256(proof)
		if !bytes.Equal(digest[:], commitment) {
			return nil, bad
		}
		data = append([]byte{55}, material...)
	}
	return solana.NewInstruction(program, solana.AccountMetaSlice{solana.Meta(wallet).SIGNER(), solana.Meta(entry).WRITE()}, data), nil
}
