package main

import (
	"bytes"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

// Both phases require the durable preimage. Commit must not strand a reveal by
// admitting a hash whose material the signer cannot recover. The directory is
// supplied by signer configuration, never by the semantic request.
func verifyWENMiningProtectedMessageV1(root string, v signerWENMiningIntentV1, wallet solana.PublicKey, s wenMiningEntrySnapshotV1, message []byte, blockhash solana.Hash, currentHeight, lastValidHeight, fee uint64) error {
	material, err := loadWENMiningPreimageV1(root, v, wallet)
	if err != nil {
		return err
	}
	defer zeroBytes(material)
	var reveal []byte
	if v.Operation == "reveal" {
		reveal = material
	}
	return verifyWENMiningMessageV1(v, wallet, s, reveal, message, blockhash, currentHeight, lastValidHeight, fee)
}

// Rebuild the entire one-instruction message from the admitted semantic action.
// No lookup tables, priority-fee instructions, extra signers or transfers allowed.
func verifyWENMiningMessageV1(v signerWENMiningIntentV1, wallet solana.PublicKey, s wenMiningEntrySnapshotV1, reveal, message []byte, blockhash solana.Hash, currentHeight, lastValidHeight, fee uint64) error {
	bad := errors.New("WEN mining message rejected")
	if blockhash == (solana.Hash{}) || currentHeight >= lastValidHeight || len(message) == 0 || len(message)+65 > 1232 {
		return bad
	}
	ix, err := prepareWENMiningInstructionV1(v, wallet, s, reveal)
	if err != nil {
		return err
	}
	limit, _ := strconv.ParseUint(v.MaxFeeLamports, 10, 64)
	if fee > limit {
		return bad
	}
	tx, err := solana.NewTransaction([]solana.Instruction{ix}, blockhash, solana.TransactionPayer(wallet))
	if err != nil {
		return err
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	expected, err := tx.Message.MarshalBinary()
	if err != nil {
		return err
	}
	if !bytes.Equal(message, expected) {
		return bad
	}
	return nil
}
