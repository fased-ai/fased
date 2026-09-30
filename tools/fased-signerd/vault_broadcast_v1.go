package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	solana "github.com/gagliardetto/solana-go"
)

const vaultBroadcastPrefixV1 = "vault-aead-v1:"

func (m *signerKeyManagerV2) vaultBroadcastCipherV1() (cipher.AEAD, error) {
	if len(m.masterKey) != 32 {
		return nil, errors.New("signer master key unavailable")
	}
	mac := hmac.New(sha256.New, m.masterKey)
	mac.Write([]byte("fased:vault-broadcast:v1"))
	key := mac.Sum(nil)
	defer zeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func vaultBroadcastAADV1(op signerOperationV2) []byte {
	raw, _ := json.Marshal([]any{"fased:vault-broadcast:v1", op.RequestID, op.WalletID, op.IntentType, op.IntentDigest, op.PolicyHash, op.ExecutionAttempt, op.TransactionDigest, op.Signature})
	return raw
}

func (m *signerKeyManagerV2) sealVaultBroadcastV1(op signerOperationV2, raw []byte) (string, error) {
	if op.IntentType != intentSolanaVaultMining || len(raw) == 0 || len(raw) > 1232 {
		return "", errors.New("invalid Vault broadcast payload")
	}
	aead, err := m.vaultBroadcastCipherV1()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nonce, nonce, raw, vaultBroadcastAADV1(op))
	return vaultBroadcastPrefixV1 + base64.StdEncoding.EncodeToString(sealed), nil
}

func (m *signerKeyManagerV2) decodeVaultBroadcastV1(op signerOperationV2) ([]byte, *solana.Transaction, error) {
	if op.IntentType != intentSolanaVaultMining || !strings.HasPrefix(op.SignedTxBase64, vaultBroadcastPrefixV1) {
		return nil, nil, errors.New("Vault broadcast must be encrypted")
	}
	sealed, err := base64.StdEncoding.Strict().DecodeString(strings.TrimPrefix(op.SignedTxBase64, vaultBroadcastPrefixV1))
	if err != nil || len(sealed) > 1300 {
		return nil, nil, errors.New("invalid Vault encrypted broadcast")
	}
	aead, err := m.vaultBroadcastCipherV1()
	if err != nil {
		return nil, nil, err
	}
	if len(sealed) < aead.NonceSize()+aead.Overhead() {
		return nil, nil, errors.New("truncated Vault encrypted broadcast")
	}
	raw, err := aead.Open(nil, sealed[:aead.NonceSize()], sealed[aead.NonceSize():], vaultBroadcastAADV1(op))
	if err != nil {
		return nil, nil, errors.New("Vault broadcast authentication failed")
	}
	defer zeroBytes(raw)
	op.SignedTxBase64 = base64.StdEncoding.EncodeToString(raw)
	return decodeStoredSignedOperationV2(op)
}

func (s *signerServiceV2) markVaultBroadcastV1(requestID string, attempt uint64, signature, digest string, raw []byte) (signerOperationV2, error) {
	return s.store.updateOperation(requestID, func(op *signerOperationV2, now string) error {
		if op.IntentType != intentSolanaVaultMining {
			return errors.New("wrong Vault journal intent")
		}
		if err := applyBroadcastClaimV2(op, attempt, signature, digest, base64.StdEncoding.EncodeToString(raw), now); err != nil {
			return err
		}
		sealed, err := s.keys.sealVaultBroadcastV1(*op, raw)
		if err != nil {
			return err
		}
		op.SignedTxBase64 = sealed
		return nil
	})
}
