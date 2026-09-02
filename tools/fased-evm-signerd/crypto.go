package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"golang.org/x/crypto/sha3"
)

const (
	privateKeyBytes = 32
	nonceBytes      = 12
)

func generatePrivateKey() ([]byte, error) {
	key, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		return nil, errors.New("generate secp256k1 key")
	}
	secret := key.Serialize()
	key.Zero()
	return secret, nil
}

func validatePrivateKey(secret []byte) error {
	if len(secret) != privateKeyBytes {
		return errors.New("EVM private key must contain exactly 32 bytes")
	}
	var scalar secp256k1.ModNScalar
	overflow := scalar.SetByteSlice(secret)
	zero := scalar.IsZero()
	scalar.Zero()
	if overflow || zero {
		return errors.New("EVM private key is outside the secp256k1 scalar range")
	}
	return nil
}

func addressFromPrivateKey(secret []byte) (string, error) {
	if err := validatePrivateKey(secret); err != nil {
		return "", err
	}
	key := secp256k1.PrivKeyFromBytes(secret)
	serialized := key.PubKey().SerializeUncompressed()
	key.Zero()
	hash := sha3.NewLegacyKeccak256()
	_, _ = hash.Write(serialized[1:])
	digest := hash.Sum(nil)
	return checksumAddress(digest[len(digest)-20:]), nil
}

func checksumAddress(raw []byte) string {
	lower := hex.EncodeToString(raw)
	hash := sha3.NewLegacyKeccak256()
	_, _ = hash.Write([]byte(lower))
	digest := hash.Sum(nil)
	result := []byte(lower)
	for index, char := range result {
		if char >= 'a' && char <= 'f' {
			nibble := digest[index/2]
			if index%2 == 0 {
				nibble >>= 4
			} else {
				nibble &= 0x0f
			}
			if nibble >= 8 {
				result[index] = char - ('a' - 'A')
			}
		}
	}
	return "0x" + string(result)
}

func isChecksumAddress(value string) bool {
	if len(value) != 42 || !strings.HasPrefix(value, "0x") {
		return false
	}
	raw, err := hex.DecodeString(value[2:])
	return err == nil && subtle.ConstantTimeCompare([]byte(checksumAddress(raw)), []byte(value)) == 1
}

func encryptSecret(masterKey, secret, aad []byte) (string, string, error) {
	if len(masterKey) != 32 {
		return "", "", errors.New("EVM signer master key must contain exactly 32 bytes")
	}
	block, err := aes.NewCipher(masterKey)
	if err != nil {
		return "", "", errors.New("initialize EVM wallet encryption")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", "", errors.New("initialize authenticated EVM wallet encryption")
	}
	nonce := make([]byte, nonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return "", "", errors.New("generate EVM wallet encryption nonce")
	}
	ciphertext := aead.Seal(nil, nonce, secret, aad)
	return base64.RawURLEncoding.EncodeToString(nonce), base64.RawURLEncoding.EncodeToString(ciphertext), nil
}

func decryptSecret(masterKey []byte, record walletRecord) ([]byte, error) {
	nonce, err := base64.RawURLEncoding.DecodeString(record.Nonce)
	if err != nil || len(nonce) != nonceBytes {
		return nil, errors.New("stored EVM wallet nonce is invalid")
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(record.Ciphertext)
	if err != nil || len(ciphertext) != privateKeyBytes+16 {
		return nil, errors.New("stored EVM wallet ciphertext is invalid")
	}
	block, err := aes.NewCipher(masterKey)
	if err != nil {
		return nil, errors.New("initialize EVM wallet decryption")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("initialize authenticated EVM wallet decryption")
	}
	secret, err := aead.Open(nil, nonce, ciphertext, recordAAD(record))
	if err != nil {
		zeroBytes(secret)
		return nil, errors.New("EVM wallet state authentication failed")
	}
	if err := validatePrivateKey(secret); err != nil {
		zeroBytes(secret)
		return nil, errors.New("stored EVM wallet key is invalid")
	}
	address, err := addressFromPrivateKey(secret)
	if err != nil || address != record.Address {
		zeroBytes(secret)
		return nil, errors.New("stored EVM wallet address does not match its key")
	}
	return secret, nil
}

func recordAAD(record walletRecord) []byte {
	return []byte(fmt.Sprintf("fased-evm-signerd:wallet:v1:%s:%d:%s:%s", record.Role, record.Generation, record.Address, record.CreatedAt))
}

func zeroBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
