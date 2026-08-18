package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"fased-signerd/internal/recovery"
	solana "github.com/gagliardetto/solana-go"
)

const (
	signerRecoveryKindV1           = recovery.KindV1
	signerRecoveryVersionV1        = recovery.VersionV1
	signerRecoveryMemoryKiBV1      = recovery.MemoryKiBV1
	signerRecoveryIterationsV1     = recovery.IterationsV1
	signerRecoveryParallelismV1    = recovery.ParallelismV1
	signerRecoverySaltBytesV1      = recovery.SaltBytesV1
	signerRecoveryKeyBytesV1       = recovery.KeyBytesV1
	maxSignerRecoveryPackageBytes  = recovery.MaxPackageBytes
	maxSignerRecoveryPasswordBytes = recovery.MaxPasswordBytes // pragma: allowlist secret
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

func encryptSignerRecoveryPackageV1(wallet signerWalletRecordV2, role string, secret, password []byte) (signerWalletRecoveryPackageV1, error) {
	return recovery.Encrypt(wallet.WalletID, role, wallet.PublicKey, wallet.CreatedAt, secret, password)
}

func validateSignerRecoveryPackageV1(pkg signerWalletRecoveryPackageV1) error {
	return recovery.Validate(pkg)
}

func decryptSignerRecoveryPackageV1(pkg signerWalletRecoveryPackageV1, password []byte) ([]byte, error) {
	return recovery.Decrypt(pkg, password)
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
