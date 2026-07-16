package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

const maxSignerImportBytesV2 = 4096

type signerKeyManagerV2 struct {
	store     *signerStoreV2
	masterKey []byte
}

func openSignerKeyManagerV2(store *signerStoreV2, masterKeyPath string) (*signerKeyManagerV2, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("signer state database is unavailable")
	}
	key, err := loadOrCreateMasterKeyV2(masterKeyPath)
	if err != nil {
		return nil, err
	}
	return &signerKeyManagerV2{store: store, masterKey: key}, nil
}

func (m *signerKeyManagerV2) Close() {
	if m == nil {
		return
	}
	zeroBytes(m.masterKey)
	m.masterKey = nil
}

func loadOrCreateMasterKeyV2(path string) ([]byte, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("signer master key path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create signer key directory: %w", err)
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return nil, errors.New("signer master key must be a regular non-symlink file")
		}
		if info.Mode().Perm()&0o077 != 0 {
			return nil, errors.New("signer master key must not be group/world accessible")
		}
		if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
			return nil, fmt.Errorf("signer master key must be owned by uid %d", os.Geteuid())
		}
		key, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read signer master key: %w", err)
		}
		if len(key) != 32 {
			zeroBytes(key)
			return nil, errors.New("signer master key has invalid length")
		}
		return key, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect signer master key: %w", err)
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate signer master key: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		zeroBytes(key)
		return nil, fmt.Errorf("create signer master key: %w", err)
	}
	writeErr := error(nil)
	if _, err := file.Write(key); err != nil {
		writeErr = err
	} else if err := file.Sync(); err != nil {
		writeErr = err
	}
	if err := file.Close(); writeErr == nil && err != nil {
		writeErr = err
	}
	if writeErr != nil {
		zeroBytes(key)
		_ = os.Remove(path)
		return nil, fmt.Errorf("persist signer master key: %w", writeErr)
	}
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return key, nil
}

func (m *signerKeyManagerV2) CreateWithPolicy(req signerWalletCreateRequestV2) (signerWalletRecordV2, signerPolicyV2, error) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, fmt.Errorf("generate wallet key: %w", err)
	}
	defer zeroBytes(privateKey)
	return m.storeNewKeyWithPolicy(req.WalletID, solana.PrivateKey(privateKey), req.Policy, req.ExpectedVersion)
}

func (m *signerKeyManagerV2) ImportFromFileWithPolicy(req signerWalletImportRequestV2) (signerWalletRecordV2, signerPolicyV2, error) {
	secret, err := readSignerImportFileV2(req.Path)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	defer zeroBytes(secret)
	record, policy, err := m.storeNewKeyWithPolicy(req.WalletID, solana.PrivateKey(secret), req.Policy, req.ExpectedVersion)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	// The wallet+policy commit is authoritative. Cleanup is best-effort so a
	// filesystem error cannot turn a completed import into an ambiguous retry.
	_ = removeSignerImportFileV2(req.Path)
	return record, policy, nil
}

func (m *signerKeyManagerV2) ImportLegacyWithPolicy(req signerWalletLegacyImportRequestV2) (signerWalletRecordV2, signerPolicyV2, error) {
	secret, expectedPublicKey, err := readLegacySignerImportV2(req.Path, req.PassphrasePath)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	defer zeroBytes(secret)
	privateKey := solana.PrivateKey(secret)
	if privateKey.PublicKey().String() != expectedPublicKey {
		return signerWalletRecordV2{}, signerPolicyV2{}, errors.New("legacy signer wallet public key mismatch")
	}
	record, policy, err := m.storeNewKeyWithPolicy(req.WalletID, privateKey, req.Policy, req.ExpectedVersion)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	_ = removeSignerImportFileV2(req.Path)
	_ = removeSignerImportFileV2(req.PassphrasePath)
	return record, policy, nil
}

func (m *signerKeyManagerV2) RotateEncryption(walletID string) (signerWalletRecordV2, error) {
	walletID = normalizeWalletID(walletID)
	privateKey, record, err := m.privateKey(walletID)
	if err != nil {
		return signerWalletRecordV2{}, err
	}
	defer zeroBytes(privateKey)
	record.Version++
	record.RotatedAt = timestampV2(m.store.now())
	if err := m.encryptRecord(&record, privateKey); err != nil {
		return signerWalletRecordV2{}, err
	}
	if err := m.putRecord(record, true); err != nil {
		return signerWalletRecordV2{}, err
	}
	return publicWalletRecordV2(record), nil
}

func (m *signerKeyManagerV2) PublicRecord(walletID string) (signerWalletRecordV2, error) {
	record, err := m.getRecord(normalizeWalletID(walletID))
	if err != nil {
		return signerWalletRecordV2{}, err
	}
	return publicWalletRecordV2(record), nil
}

func (m *signerKeyManagerV2) privateKey(walletID string) (solana.PrivateKey, signerWalletRecordV2, error) {
	record, err := m.getRecord(normalizeWalletID(walletID))
	if err != nil {
		return nil, signerWalletRecordV2{}, err
	}
	secret, err := m.decryptRecord(record)
	if err != nil {
		return nil, signerWalletRecordV2{}, err
	}
	privateKey := solana.PrivateKey(secret)
	expectedPublicKey, err := solana.PublicKeyFromBase58(record.PublicKey)
	if err != nil || !privateKey.PublicKey().Equals(expectedPublicKey) {
		zeroBytes(secret)
		return nil, signerWalletRecordV2{}, errors.New("signer wallet encrypted state public key mismatch")
	}
	return privateKey, record, nil
}

func (m *signerKeyManagerV2) storeNewKeyWithPolicy(
	walletID string,
	privateKey solana.PrivateKey,
	policy signerPolicyV2,
	expectedVersion uint64,
) (signerWalletRecordV2, signerPolicyV2, error) {
	walletID = normalizeWalletID(walletID)
	if len(privateKey) != ed25519.PrivateKeySize {
		return signerWalletRecordV2{}, signerPolicyV2{}, errors.New("wallet private key has invalid length")
	}
	now := timestampV2(m.store.now())
	record := signerWalletRecordV2{
		WalletID:  walletID,
		PublicKey: privateKey.PublicKey().String(),
		Version:   1,
		CreatedAt: now,
	}
	if err := m.encryptRecord(&record, privateKey); err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	storedPolicy, err := m.store.putWalletAndPolicy(record, policy, expectedVersion)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	return publicWalletRecordV2(record), storedPolicy, nil
}

func (m *signerKeyManagerV2) encryptRecord(record *signerWalletRecordV2, privateKey []byte) error {
	block, err := aes.NewCipher(m.masterKey)
	if err != nil {
		return fmt.Errorf("initialize wallet encryption: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return fmt.Errorf("initialize wallet authenticated encryption: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return fmt.Errorf("generate wallet encryption nonce: %w", err)
	}
	aad := []byte(fmt.Sprintf("fased-signerd:v2:%s:%d", record.WalletID, record.Version))
	ciphertext := gcm.Seal(nil, nonce, privateKey, aad)
	record.Nonce = base64.RawURLEncoding.EncodeToString(nonce)
	record.Secret = base64.RawURLEncoding.EncodeToString(ciphertext)
	zeroBytes(ciphertext)
	return nil
}

func (m *signerKeyManagerV2) decryptRecord(record signerWalletRecordV2) ([]byte, error) {
	nonce, err := base64.RawURLEncoding.DecodeString(record.Nonce)
	if err != nil {
		return nil, errors.New("signer wallet encrypted state nonce is invalid")
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(record.Secret)
	if err != nil {
		return nil, errors.New("signer wallet encrypted state is invalid")
	}
	defer zeroBytes(ciphertext)
	block, err := aes.NewCipher(m.masterKey)
	if err != nil {
		return nil, errors.New("initialize wallet decryption")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("initialize wallet authenticated decryption")
	}
	aad := []byte(fmt.Sprintf("fased-signerd:v2:%s:%d", record.WalletID, record.Version))
	secret, err := gcm.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, errors.New("signer wallet encrypted state authentication failed")
	}
	if len(secret) != ed25519.PrivateKeySize {
		zeroBytes(secret)
		return nil, errors.New("signer wallet encrypted state has invalid key length")
	}
	return secret, nil
}

func (m *signerKeyManagerV2) getRecord(walletID string) (signerWalletRecordV2, error) {
	var record signerWalletRecordV2
	err := m.store.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID))
		if raw == nil {
			return errors.New("signer wallet not found")
		}
		return json.Unmarshal(raw, &record)
	})
	return record, err
}

func (m *signerKeyManagerV2) putRecord(record signerWalletRecordV2, replace bool) error {
	return m.store.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerWalletsV2)
		if existing := bucket.Get([]byte(record.WalletID)); existing != nil && !replace {
			return errors.New("signer wallet already exists")
		}
		encoded, err := json.Marshal(record)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(record.WalletID), encoded)
	})
}

func publicWalletRecordV2(record signerWalletRecordV2) signerWalletRecordV2 {
	record.Nonce = ""
	record.Secret = ""
	return record
}

func readSignerImportFileV2(path string) ([]byte, error) {
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) {
		return nil, errors.New("wallet import path must be absolute")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect wallet import file: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("wallet import file must be a regular non-symlink file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("wallet import file must not be group/world accessible")
	}
	if info.Size() <= 0 || info.Size() > maxSignerImportBytesV2 {
		return nil, errors.New("wallet import file has invalid size")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return nil, fmt.Errorf("wallet import file must be owned by uid %d", os.Geteuid())
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open wallet import file: %w", err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxSignerImportBytesV2+1))
	if err != nil {
		return nil, fmt.Errorf("read wallet import file: %w", err)
	}
	defer zeroBytes(data)
	if len(data) > maxSignerImportBytesV2 {
		return nil, errors.New("wallet import file is too large")
	}
	var values []int
	if err := json.Unmarshal(data, &values); err != nil || len(values) != ed25519.PrivateKeySize {
		return nil, errors.New("wallet import file must be a 64-byte Solana CLI keypair JSON array")
	}
	defer func() {
		for i := range values {
			values[i] = 0
		}
	}()
	secret := make([]byte, ed25519.PrivateKeySize)
	for i, value := range values {
		if value < 0 || value > 255 {
			zeroBytes(secret)
			return nil, errors.New("wallet import file contains an invalid key byte")
		}
		secret[i] = byte(value)
	}
	if !validateSolanaCLIPrivateKeyV2(secret) {
		zeroBytes(secret)
		return nil, errors.New("wallet import keypair public key mismatch")
	}
	return secret, nil
}

func validateSolanaCLIPrivateKeyV2(secret []byte) bool {
	if len(secret) != ed25519.PrivateKeySize {
		return false
	}
	derived := ed25519.NewKeyFromSeed(secret[:ed25519.SeedSize])
	defer zeroBytes(derived)
	return subtle.ConstantTimeCompare(derived[ed25519.SeedSize:], secret[ed25519.SeedSize:]) == 1
}

func readLegacySignerImportV2(path, passphrasePath string) ([]byte, string, error) {
	if err := validateSignerImportPathV2(path, 64*1024); err != nil {
		return nil, "", err
	}
	if err := validateSignerImportPathV2(passphrasePath, maxSignerImportBytesV2); err != nil {
		return nil, "", fmt.Errorf("validate legacy passphrase file: %w", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", fmt.Errorf("read legacy signer wallet: %w", err)
	}
	defer zeroBytes(data)
	envelope, err := parseSolanaEnvelope(data)
	if err != nil {
		return nil, "", fmt.Errorf("parse legacy signer wallet: %w", err)
	}
	passphrase, err := os.ReadFile(passphrasePath)
	if err != nil {
		return nil, "", fmt.Errorf("read legacy passphrase file: %w", err)
	}
	defer zeroBytes(passphrase)
	secret, err := decryptSolanaEnvelope(envelope, strings.TrimSpace(string(passphrase)))
	if err != nil {
		return nil, "", errors.New("legacy signer wallet decryption failed")
	}
	return secret, strings.TrimSpace(envelope.PublicKey), nil
}

func validateSignerImportPathV2(path string, maxBytes int64) error {
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) {
		return errors.New("wallet import path must be absolute")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect wallet import file: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("wallet import file must be a regular non-symlink file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("wallet import file must not be group/world accessible")
	}
	if info.Size() <= 0 || info.Size() > maxBytes {
		return errors.New("wallet import file has invalid size")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("wallet import file must be owned by uid %d", os.Geteuid())
	}
	return nil
}

func removeSignerImportFileV2(path string) error {
	if err := os.Remove(strings.TrimSpace(path)); err != nil {
		return fmt.Errorf("remove consumed signer import file: %w", err)
	}
	dir, err := os.Open(filepath.Dir(strings.TrimSpace(path)))
	if err != nil {
		return fmt.Errorf("open signer import directory: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("sync signer import directory: %w", err)
	}
	return nil
}
