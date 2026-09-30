package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

func TestVaultBroadcastEncryptionV1(t *testing.T) {
	wallet := solana.NewWallet()
	tx, err := solana.NewTransaction([]solana.Instruction{solana.NewInstruction(solana.SystemProgramID, solana.AccountMetaSlice{solana.Meta(wallet.PublicKey()).SIGNER().WRITE()}, []byte{1, 2, 3})}, solana.Hash{1}, solana.TransactionPayer(wallet.PublicKey()))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Sign(func(k solana.PublicKey) *solana.PrivateKey { return &wallet.PrivateKey }); err != nil {
		t.Fatal(err)
	}
	raw, err := tx.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	op := signerOperationV2{RequestID: "vault-test", WalletID: "executor", IntentType: intentSolanaVaultMining, IntentDigest: "intent", PolicyHash: "policy", ExecutionAttempt: 1, TransactionDigest: "sha256:" + hex.EncodeToString(digest[:]), Signature: tx.Signatures[0].String()}
	keys := &signerKeyManagerV2{masterKey: bytes.Repeat([]byte{7}, 32)}
	op.SignedTxBase64, err = keys.sealVaultBroadcastV1(op, raw)
	if err != nil {
		t.Fatal(err)
	}
	if op.SignedTxBase64 == base64.StdEncoding.EncodeToString(raw) {
		t.Fatal("plaintext persisted")
	}
	reopened := &signerKeyManagerV2{masterKey: bytes.Clone(keys.masterKey)}
	decoded, _, err := reopened.decodeVaultBroadcastV1(op)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, decoded) {
		t.Fatal("retry bytes changed")
	}
	for _, mutate := range []func(*signerOperationV2){
		func(o *signerOperationV2) { o.WalletID = "other" },
		func(o *signerOperationV2) { o.ExecutionAttempt++ },
		func(o *signerOperationV2) { o.PolicyHash = "other" },
		func(o *signerOperationV2) { o.SignedTxBase64 = base64.StdEncoding.EncodeToString(raw) },
		func(o *signerOperationV2) { o.Signature = "other" },
	} {
		changed := op
		mutate(&changed)
		if _, _, err := keys.decodeVaultBroadcastV1(changed); err == nil {
			t.Fatal("accepted substituted broadcast")
		}
	}
	reopened.masterKey[0] ^= 1
	if _, _, err := reopened.decodeVaultBroadcastV1(op); err == nil {
		t.Fatal("accepted wrong recovery key")
	}
}
