package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"golang.org/x/crypto/argon2"
)

const (
	recoveryKind       = "fased-evm-signer-wallet-recovery"
	recoveryMemoryKiB  = uint32(64 * 1024)
	recoveryIterations = uint32(3)
)

type recoveryPackage struct {
	Kind       string `json:"kind"`
	Version    uint8  `json:"version"`
	Role       string `json:"role"`
	Generation uint64 `json:"generation"`
	Address    string `json:"address"`
	CreatedAt  string `json:"createdAt"`
	KDF        struct {
		Name        string `json:"name"`
		MemoryKiB   uint32 `json:"memoryKiB"`
		Iterations  uint32 `json:"iterations"`
		Parallelism uint8  `json:"parallelism"`
		Salt        string `json:"salt"`
	} `json:"kdf"`
	Encryption struct {
		Name       string `json:"name"`
		Nonce      string `json:"nonce"`
		Ciphertext string `json:"ciphertext"`
	} `json:"encryption"`
}

func makeRecoveryPackage(record walletRecord, secret, password []byte) (recoveryPackage, error) {
	if len(password) < 12 || len(password) > 1024 {
		return recoveryPackage{}, errors.New("recovery password must contain 12 to 1024 bytes")
	}
	if address, err := addressFromPrivateKey(secret); err != nil || address != record.Address {
		return recoveryPackage{}, errors.New("recovery key does not match EVM wallet address")
	}
	salt := make([]byte, 16)
	nonce := make([]byte, 12)
	if _, err := rand.Read(salt); err != nil {
		return recoveryPackage{}, errors.New("generate recovery salt")
	}
	defer zeroBytes(salt)
	if _, err := rand.Read(nonce); err != nil {
		return recoveryPackage{}, errors.New("generate recovery nonce")
	}
	defer zeroBytes(nonce)
	pkg := recoveryPackage{Kind: recoveryKind, Version: 1, Role: record.Role, Generation: record.Generation, Address: record.Address, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	pkg.KDF.Name, pkg.KDF.MemoryKiB, pkg.KDF.Iterations, pkg.KDF.Parallelism = "argon2id", recoveryMemoryKiB, recoveryIterations, 1
	pkg.KDF.Salt = base64.RawURLEncoding.EncodeToString(salt)
	pkg.Encryption.Name, pkg.Encryption.Nonce = "aes-256-gcm", base64.RawURLEncoding.EncodeToString(nonce)
	key := argon2.IDKey(password, salt, recoveryIterations, recoveryMemoryKiB, 1, 32)
	defer zeroBytes(key)
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	ciphertext := aead.Seal(nil, nonce, secret, recoveryAAD(pkg))
	defer zeroBytes(ciphertext)
	pkg.Encryption.Ciphertext = base64.RawURLEncoding.EncodeToString(ciphertext)
	return pkg, validateRecoveryPackage(pkg)
}

func validateRecoveryPackage(pkg recoveryPackage) error {
	if pkg.Kind != recoveryKind || pkg.Version != 1 || validateRole(pkg.Role) != nil || pkg.Generation == 0 || !isChecksumAddress(pkg.Address) {
		return errors.New("unsupported or invalid EVM recovery package")
	}
	created, err := time.Parse(time.RFC3339Nano, pkg.CreatedAt)
	if err != nil || created.UTC().Format(time.RFC3339Nano) != pkg.CreatedAt {
		return errors.New("EVM recovery package creation time is invalid")
	}
	if pkg.KDF.Name != "argon2id" || pkg.KDF.MemoryKiB != recoveryMemoryKiB || pkg.KDF.Iterations != recoveryIterations || pkg.KDF.Parallelism != 1 || pkg.Encryption.Name != "aes-256-gcm" {
		return errors.New("EVM recovery package cryptography is unsupported")
	}
	if !validEncodedBytes(pkg.KDF.Salt, 16) || !validEncodedBytes(pkg.Encryption.Nonce, 12) || !validEncodedBytes(pkg.Encryption.Ciphertext, 48) {
		return errors.New("EVM recovery package encoding is invalid")
	}
	return nil
}

func openRecoveryPackage(pkg recoveryPackage, password []byte) ([]byte, error) {
	if err := validateRecoveryPackage(pkg); err != nil {
		return nil, err
	}
	salt, _ := base64.RawURLEncoding.DecodeString(pkg.KDF.Salt)
	nonce, _ := base64.RawURLEncoding.DecodeString(pkg.Encryption.Nonce)
	ciphertext, _ := base64.RawURLEncoding.DecodeString(pkg.Encryption.Ciphertext)
	defer zeroBytes(salt)
	defer zeroBytes(nonce)
	defer zeroBytes(ciphertext)
	key := argon2.IDKey(password, salt, recoveryIterations, recoveryMemoryKiB, 1, 32)
	defer zeroBytes(key)
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	secret, err := aead.Open(nil, nonce, ciphertext, recoveryAAD(pkg))
	if err != nil {
		zeroBytes(secret)
		return nil, errors.New("recovery password is incorrect or the package was modified")
	}
	address, err := addressFromPrivateKey(secret)
	if err != nil || address != pkg.Address {
		zeroBytes(secret)
		return nil, errors.New("recovery package key does not match its EVM address")
	}
	return secret, nil
}

func recoveryAAD(pkg recoveryPackage) []byte {
	return []byte(fmt.Sprintf("fased-evm-signerd:recovery:v1:%s:%d:%s:%s", pkg.Role, pkg.Generation, pkg.Address, pkg.CreatedAt))
}

func validEncodedBytes(value string, size int) bool {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	defer zeroBytes(raw)
	return err == nil && len(raw) == size && base64.RawURLEncoding.EncodeToString(raw) == value
}

func decodeRecoveryPackage(raw []byte) (recoveryPackage, error) {
	var pkg recoveryPackage
	decoder := json.NewDecoder(newBoundedReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&pkg); err != nil {
		return recoveryPackage{}, errors.New("decode strict EVM recovery package")
	}
	if decoder.Decode(&struct{}{}) == nil {
		return recoveryPackage{}, errors.New("EVM recovery package contains trailing JSON")
	}
	return pkg, validateRecoveryPackage(pkg)
}
