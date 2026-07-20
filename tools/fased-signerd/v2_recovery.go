package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"golang.org/x/crypto/argon2"
)

const (
	signerRecoveryKindV1           = "fased-signer-wallet-recovery"
	signerRecoveryVersionV1        = uint8(1)
	signerRecoveryMemoryKiBV1      = uint32(64 * 1024)
	signerRecoveryIterationsV1     = uint32(3)
	signerRecoveryParallelismV1    = uint8(1)
	signerRecoverySaltBytesV1      = 16
	signerRecoveryKeyBytesV1       = 32
	maxSignerRecoveryPackageBytes  = 16 << 10
	maxSignerRecoveryPasswordBytes = 1024
)

func readSignerRecoveryPasswordV1(path string) ([]byte, error) {
	if err := validateSignerImportPathV2(path, maxSignerRecoveryPasswordBytes); err != nil {
		return nil, fmt.Errorf("validate recovery password file: %w", err)
	}
	password, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("read recovery password file")
	}
	password = bytes.TrimSuffix(password, []byte{'\n'})
	password = bytes.TrimSuffix(password, []byte{'\r'})
	if len(password) < 12 || len(password) > maxSignerRecoveryPasswordBytes {
		zeroBytes(password)
		return nil, errors.New("recovery password must contain 12 to 1024 bytes")
	}
	return password, nil
}

func signerRecoveryAADV1(pkg signerWalletRecoveryPackageV1) []byte {
	return []byte(fmt.Sprintf(
		"fased-signerd:wallet-recovery:v1:%s:%s:%s:%s",
		pkg.WalletID,
		pkg.Role,
		pkg.PublicKey,
		pkg.CreatedAt,
	))
}

func encryptSignerRecoveryPackageV1(wallet signerWalletRecordV2, role string, secret, password []byte) (signerWalletRecoveryPackageV1, error) {
	if len(secret) != 64 || !validateSolanaCLIPrivateKeyV2(secret) {
		return signerWalletRecoveryPackageV1{}, errors.New("signer wallet key is invalid")
	}
	salt := make([]byte, signerRecoverySaltBytesV1)
	if _, err := rand.Read(salt); err != nil {
		return signerWalletRecoveryPackageV1{}, errors.New("generate recovery salt")
	}
	defer zeroBytes(salt)
	key := argon2.IDKey(password, salt, signerRecoveryIterationsV1, signerRecoveryMemoryKiBV1, signerRecoveryParallelismV1, signerRecoveryKeyBytesV1)
	defer zeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return signerWalletRecoveryPackageV1{}, errors.New("initialize recovery encryption")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return signerWalletRecoveryPackageV1{}, errors.New("initialize recovery authenticated encryption")
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return signerWalletRecoveryPackageV1{}, errors.New("generate recovery nonce")
	}
	defer zeroBytes(nonce)
	pkg := signerWalletRecoveryPackageV1{
		Kind:      signerRecoveryKindV1,
		Version:   signerRecoveryVersionV1,
		WalletID:  wallet.WalletID,
		Role:      role,
		PublicKey: wallet.PublicKey,
		CreatedAt: wallet.CreatedAt,
		KDF: signerWalletRecoveryKDFV1{
			Name:        "argon2id",
			MemoryKiB:   signerRecoveryMemoryKiBV1,
			Iterations:  signerRecoveryIterationsV1,
			Parallelism: signerRecoveryParallelismV1,
			Salt:        base64.RawURLEncoding.EncodeToString(salt),
		},
		Encryption: signerWalletRecoveryEncryptionV1{
			Name:  "aes-256-gcm",
			Nonce: base64.RawURLEncoding.EncodeToString(nonce),
		},
	}
	ciphertext := aead.Seal(nil, nonce, secret, signerRecoveryAADV1(pkg))
	pkg.Encryption.Ciphertext = base64.RawURLEncoding.EncodeToString(ciphertext)
	zeroBytes(ciphertext)
	return pkg, nil
}

func validateSignerRecoveryPackageV1(pkg signerWalletRecoveryPackageV1) error {
	if pkg.Kind != signerRecoveryKindV1 || pkg.Version != signerRecoveryVersionV1 {
		return errors.New("unsupported recovery package kind or version")
	}
	if normalizeWalletID(pkg.WalletID) != pkg.WalletID || pkg.WalletID == "" {
		return errors.New("recovery package walletId is invalid")
	}
	if pkg.Role != "agent" && pkg.Role != "mining" && pkg.Role != "vault" {
		return errors.New("recovery package role is invalid")
	}
	if _, err := normalizeRotationPublicKeyV2(pkg.PublicKey, "publicKey"); err != nil {
		return errors.New("recovery package publicKey is invalid")
	}
	createdAt, createdAtErr := time.Parse(time.RFC3339Nano, pkg.CreatedAt)
	if createdAtErr != nil || createdAt.UTC().Format(time.RFC3339Nano) != pkg.CreatedAt {
		return errors.New("recovery package createdAt is invalid")
	}
	if pkg.KDF.Name != "argon2id" || pkg.KDF.MemoryKiB != signerRecoveryMemoryKiBV1 ||
		pkg.KDF.Iterations != signerRecoveryIterationsV1 || pkg.KDF.Parallelism != signerRecoveryParallelismV1 {
		return errors.New("recovery package KDF parameters are unsupported")
	}
	if pkg.Encryption.Name != "aes-256-gcm" {
		return errors.New("recovery package encryption is unsupported")
	}
	salt, err := base64.RawURLEncoding.DecodeString(pkg.KDF.Salt)
	if err != nil || len(salt) != signerRecoverySaltBytesV1 {
		zeroBytes(salt)
		return errors.New("recovery package salt is invalid")
	}
	zeroBytes(salt)
	nonce, err := base64.RawURLEncoding.DecodeString(pkg.Encryption.Nonce)
	if err != nil || len(nonce) != 12 {
		zeroBytes(nonce)
		return errors.New("recovery package nonce is invalid")
	}
	zeroBytes(nonce)
	ciphertext, err := base64.RawURLEncoding.DecodeString(pkg.Encryption.Ciphertext)
	if err != nil || len(ciphertext) != 64+16 {
		zeroBytes(ciphertext)
		return errors.New("recovery package ciphertext is invalid")
	}
	zeroBytes(ciphertext)
	return nil
}

func decryptSignerRecoveryPackageV1(pkg signerWalletRecoveryPackageV1, password []byte) ([]byte, error) {
	if err := validateSignerRecoveryPackageV1(pkg); err != nil {
		return nil, err
	}
	salt, _ := base64.RawURLEncoding.DecodeString(pkg.KDF.Salt)
	defer zeroBytes(salt)
	nonce, _ := base64.RawURLEncoding.DecodeString(pkg.Encryption.Nonce)
	defer zeroBytes(nonce)
	ciphertext, _ := base64.RawURLEncoding.DecodeString(pkg.Encryption.Ciphertext)
	defer zeroBytes(ciphertext)
	key := argon2.IDKey(password, salt, pkg.KDF.Iterations, pkg.KDF.MemoryKiB, pkg.KDF.Parallelism, signerRecoveryKeyBytesV1)
	defer zeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("initialize recovery decryption")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("initialize recovery authenticated decryption")
	}
	secret, err := aead.Open(nil, nonce, ciphertext, signerRecoveryAADV1(pkg))
	if err != nil {
		return nil, errors.New("recovery password is incorrect or the package was modified")
	}
	if !validateSolanaCLIPrivateKeyV2(secret) {
		zeroBytes(secret)
		return nil, errors.New("recovery package contains an invalid wallet key")
	}
	privateKeyPublic := solana.PrivateKey(secret).PublicKey().String()
	if privateKeyPublic != pkg.PublicKey {
		zeroBytes(secret)
		return nil, errors.New("recovery package public key does not match its private key")
	}
	return secret, nil
}
func (m *signerKeyManagerV2) ExportRecoveryV1(walletID string, req signerWalletRecoveryExportRequestV2) (signerWalletRecoveryExportResultV2, error) {
	walletID = normalizeWalletID(walletID)
	privateKey, wallet, err := m.privateKey(walletID)
	if err != nil {
		return signerWalletRecoveryExportResultV2{}, err
	}
	defer zeroBytes(privateKey)
	if req.ExpectedPublicKey != wallet.PublicKey {
		return signerWalletRecoveryExportResultV2{}, errors.New("expectedPublicKey does not match the signer wallet")
	}
	policy, err := m.store.getPolicy(walletID)
	if err != nil {
		return signerWalletRecoveryExportResultV2{}, err
	}
	password, err := readSignerRecoveryPasswordV1(req.PasswordPath)
	if err != nil {
		return signerWalletRecoveryExportResultV2{}, err
	}
	defer zeroBytes(password)
	pkg, err := encryptSignerRecoveryPackageV1(wallet, policy.Role, privateKey, password)
	if err != nil {
		return signerWalletRecoveryExportResultV2{}, err
	}
	_ = removeSignerImportFileV2(req.PasswordPath)
	return signerWalletRecoveryExportResultV2{WalletID: walletID, Role: policy.Role, PublicKey: wallet.PublicKey, Package: pkg}, nil
}

func readSignerRecoveryPackageV1(path string) (signerWalletRecoveryPackageV1, error) {
	if err := validateSignerImportPathV2(path, maxSignerRecoveryPackageBytes); err != nil {
		return signerWalletRecoveryPackageV1{}, fmt.Errorf("validate recovery package: %w", err)
	}
	file, err := os.Open(path)
	if err != nil {
		return signerWalletRecoveryPackageV1{}, errors.New("open recovery package")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxSignerRecoveryPackageBytes+1))
	if err != nil || len(raw) == 0 || len(raw) > maxSignerRecoveryPackageBytes {
		zeroBytes(raw)
		return signerWalletRecoveryPackageV1{}, errors.New("read recovery package")
	}
	defer zeroBytes(raw)
	var pkg signerWalletRecoveryPackageV1
	if err := decodeStrictJSONV2(raw, &pkg); err != nil {
		return signerWalletRecoveryPackageV1{}, errors.New("recovery package must contain one strict JSON object")
	}
	if err := validateSignerRecoveryPackageV1(pkg); err != nil {
		return signerWalletRecoveryPackageV1{}, err
	}
	return pkg, nil
}

func (m *signerKeyManagerV2) ImportRecoveryV1(req signerWalletRecoveryImportRequestV2) (signerWalletRecordV2, signerPolicyV2, error) {
	pkg, err := readSignerRecoveryPackageV1(req.RecoveryPath)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	requestedRole := req.Policy.Role
	if req.Baseline != nil {
		requestedRole = strings.ToLower(strings.TrimSpace(req.Baseline.Role))
	}
	if requestedRole != pkg.Role {
		return signerWalletRecordV2{}, signerPolicyV2{}, errors.New("recovery package role does not match the requested wallet role")
	}
	password, err := readSignerRecoveryPasswordV1(req.PasswordPath)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	defer zeroBytes(password)
	secret, err := decryptSignerRecoveryPackageV1(pkg, password)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	defer zeroBytes(secret)
	policyInput := req.Policy
	if req.Baseline != nil {
		privateKey := solana.PrivateKey(secret)
		policyInput, err = compileSignerRoleBaselineV1(
			req.WalletID,
			privateKey.PublicKey().String(),
			*req.Baseline,
			signerRoleBaselineRuntimeFromEnvV1(),
		)
		if err != nil {
			return signerWalletRecordV2{}, signerPolicyV2{}, err
		}
	}
	wallet, policy, err := m.storeNewKeyWithPolicy(req.WalletID, secret, policyInput, req.ExpectedVersion)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	_ = removeSignerImportFileV2(req.RecoveryPath)
	_ = removeSignerImportFileV2(req.PasswordPath)
	return wallet, policy, nil
}

func validateSignerRawExportPathV2(path string) error {
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("raw export path must be absolute and clean")
	}
	if filepath.Base(filepath.Dir(path)) != ".admin-export" {
		return errors.New("raw export path must be inside the signer-owned .admin-export directory")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return errors.New("inspect raw export file")
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() != 0 {
		return errors.New("raw export file must be an empty owner-only regular file")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && (int(stat.Uid) != os.Geteuid() || stat.Nlink != 1) {
		return errors.New("raw export file must be signer-owned with exactly one link")
	}
	return nil
}

func (m *signerKeyManagerV2) ExportRawV2(walletID string, req signerWalletRawExportRequestV2) (signerWalletRawExportResultV2, error) {
	privateKey, wallet, err := m.privateKey(normalizeWalletID(walletID))
	if err != nil {
		return signerWalletRawExportResultV2{}, err
	}
	defer zeroBytes(privateKey)
	if req.ExpectedPublicKey != wallet.PublicKey {
		return signerWalletRawExportResultV2{}, errors.New("expectedPublicKey does not match the signer wallet")
	}
	if err := validateSignerRawExportPathV2(req.Path); err != nil {
		return signerWalletRawExportResultV2{}, err
	}
	values := make([]int, len(privateKey))
	for index, value := range privateKey {
		values[index] = int(value)
	}
	encoded, err := json.Marshal(values)
	for index := range values {
		values[index] = 0
	}
	if err != nil {
		return signerWalletRawExportResultV2{}, errors.New("encode raw wallet export")
	}
	defer zeroBytes(encoded)
	file, err := os.OpenFile(req.Path, os.O_WRONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return signerWalletRawExportResultV2{}, errors.New("open raw export file")
	}
	if err := writeAndSyncSignerAdminFile(file, encoded); err != nil {
		return signerWalletRawExportResultV2{}, err
	}
	if err := syncSignerAdminDirectory(filepath.Dir(req.Path)); err != nil {
		return signerWalletRawExportResultV2{}, err
	}
	return signerWalletRawExportResultV2{WalletID: wallet.WalletID, PublicKey: wallet.PublicKey, Written: true}, nil
}
