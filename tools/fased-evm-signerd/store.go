package main

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	bolt "go.etcd.io/bbolt"
)

var (
	metadataBucket = []byte("metadata")
	walletsBucket  = []byte("wallets")
	schemaKey      = []byte("schema")
)

type walletStore struct {
	db        *bolt.DB
	masterKey []byte
}

func initializeStore(statePath, masterKeyPath string) error {
	if !filepath.IsAbs(statePath) || !filepath.IsAbs(masterKeyPath) {
		return errors.New("state and master-key paths must be absolute")
	}
	if err := validateNewPath(statePath); err != nil {
		return err
	}
	if err := validateNewPath(masterKeyPath); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(filepath.Clean(masterKeyPath)), 0o700); err != nil {
		return fmt.Errorf("create EVM signer directory: %w", err)
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return errors.New("generate EVM signer master key")
	}
	defer zeroBytes(key)
	file, err := os.OpenFile(filepath.Clean(masterKeyPath), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create EVM signer master key: %w", err)
	}
	if _, err := file.Write(key); err != nil {
		_ = file.Close()
		return errors.New("write EVM signer master key")
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return errors.New("sync EVM signer master key")
	}
	if err := file.Close(); err != nil {
		return errors.New("close EVM signer master key")
	}
	store, err := openStore(statePath, masterKeyPath)
	if err != nil {
		_ = os.Remove(filepath.Clean(masterKeyPath))
		return err
	}
	return store.close()
}

func openStore(statePath, masterKeyPath string) (*walletStore, error) {
	key, err := readOwnerFile(masterKeyPath, 32)
	if err != nil {
		return nil, fmt.Errorf("read EVM signer master key: %w", err)
	}
	statePath = filepath.Clean(statePath)
	if info, err := os.Lstat(statePath); err == nil {
		if err := requireOwnerRegularFile(info, "EVM signer state database"); err != nil {
			zeroBytes(key)
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		zeroBytes(key)
		return nil, fmt.Errorf("inspect EVM signer state database: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
		zeroBytes(key)
		return nil, fmt.Errorf("create EVM signer state directory: %w", err)
	}
	db, err := bolt.Open(statePath, 0o600, &bolt.Options{Timeout: 2 * time.Second})
	if err != nil {
		zeroBytes(key)
		return nil, fmt.Errorf("open EVM signer state database: %w", err)
	}
	store := &walletStore{db: db, masterKey: key}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		metadata, err := tx.CreateBucketIfNotExists(metadataBucket)
		if err != nil {
			return err
		}
		if current := metadata.Get(schemaKey); current == nil {
			if err := metadata.Put(schemaKey, []byte("fased-evm-signer-state-v1")); err != nil {
				return err
			}
		} else if string(current) != "fased-evm-signer-state-v1" {
			return errors.New("unsupported EVM signer state schema")
		}
		_, err = tx.CreateBucketIfNotExists(walletsBucket)
		return err
	}); err != nil {
		_ = store.close()
		return nil, err
	}
	return store, nil
}

func (store *walletStore) close() error {
	if store == nil {
		return nil
	}
	zeroBytes(store.masterKey)
	if store.db == nil {
		return nil
	}
	return store.db.Close()
}

func (store *walletStore) create(role string, secret []byte) (publicWallet, error) {
	if err := validateRole(role); err != nil {
		return publicWallet{}, err
	}
	if err := validatePrivateKey(secret); err != nil {
		return publicWallet{}, err
	}
	address, err := addressFromPrivateKey(secret)
	if err != nil {
		return publicWallet{}, err
	}
	var created walletRecord
	err = store.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(walletsBucket)
		generation := uint64(1)
		if raw := bucket.Get([]byte(role)); raw != nil {
			var previous walletRecord
			if json.Unmarshal(raw, &previous) != nil || validateRecord(previous) != nil {
				return errors.New("stored EVM wallet record is unreadable")
			}
			if previous.RevokedAt == "" {
				return errors.New("an active EVM wallet already exists for this role")
			}
			generation = previous.Generation + 1
		}
		created = walletRecord{SchemaVersion: 1, Role: role, Generation: generation, Address: address, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
		created.Nonce, created.Ciphertext, err = encryptSecret(store.masterKey, secret, recordAAD(created))
		if err != nil {
			return err
		}
		raw, err := json.Marshal(created)
		if err != nil {
			return errors.New("encode EVM wallet record")
		}
		return bucket.Put([]byte(role), raw)
	})
	if err != nil {
		return publicWallet{}, err
	}
	return created.public(), nil
}

func (store *walletStore) restore(pkg recoveryPackage, secret []byte) (publicWallet, error) {
	if err := validateRecoveryPackage(pkg); err != nil {
		return publicWallet{}, err
	}
	if address, err := addressFromPrivateKey(secret); err != nil || address != pkg.Address {
		return publicWallet{}, errors.New("restored EVM address does not match recovery package")
	}
	created := walletRecord{
		SchemaVersion: 1, Role: pkg.Role, Generation: pkg.Generation,
		Address: pkg.Address, CreatedAt: pkg.CreatedAt,
	}
	var err error
	created.Nonce, created.Ciphertext, err = encryptSecret(store.masterKey, secret, recordAAD(created))
	if err != nil {
		return publicWallet{}, err
	}
	err = store.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(walletsBucket)
		if bucket.Get([]byte(pkg.Role)) != nil {
			return errors.New("refusing to overwrite existing EVM role during recovery")
		}
		raw, err := json.Marshal(created)
		if err != nil {
			return errors.New("encode restored EVM wallet record")
		}
		return bucket.Put([]byte(pkg.Role), raw)
	})
	return created.public(), err
}

func (store *walletStore) get(role string) (walletRecord, error) {
	if err := validateRole(role); err != nil {
		return walletRecord{}, err
	}
	var record walletRecord
	err := store.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(walletsBucket).Get([]byte(role))
		if raw == nil {
			return errors.New("EVM wallet role is not initialized")
		}
		if err := json.Unmarshal(raw, &record); err != nil || validateRecord(record) != nil {
			return errors.New("stored EVM wallet record is unreadable")
		}
		return nil
	})
	return record, err
}

func (store *walletStore) list() ([]publicWallet, error) {
	result := make([]publicWallet, 0, 2)
	for _, role := range []string{roleAgentService, roleStrategy} {
		record, err := store.get(role)
		if err != nil {
			if err.Error() == "EVM wallet role is not initialized" {
				continue
			}
			return nil, err
		}
		result = append(result, record.public())
	}
	return result, nil
}

func (store *walletStore) revoke(role string, expectedGeneration uint64) (publicWallet, error) {
	var updated walletRecord
	err := store.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(walletsBucket)
		raw := bucket.Get([]byte(role))
		if raw == nil || json.Unmarshal(raw, &updated) != nil || validateRecord(updated) != nil {
			return errors.New("EVM wallet role is unavailable or unreadable")
		}
		if updated.RevokedAt != "" {
			return errors.New("EVM wallet role is already revoked")
		}
		if expectedGeneration == 0 || updated.Generation != expectedGeneration {
			return errors.New("EVM wallet generation changed")
		}
		updated.RevokedAt = time.Now().UTC().Format(time.RFC3339Nano)
		next, err := json.Marshal(updated)
		if err != nil {
			return errors.New("encode revoked EVM wallet record")
		}
		return bucket.Put([]byte(role), next)
	})
	return updated.public(), err
}

func validateNewPath(path string) error {
	path = filepath.Clean(path)
	if _, err := os.Lstat(path); err == nil {
		return errors.New("refusing to overwrite an existing file")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func readOwnerFile(path string, exactBytes int) ([]byte, error) {
	info, err := os.Lstat(filepath.Clean(path))
	if err != nil {
		return nil, err
	}
	if err := requireOwnerRegularFile(info, "sensitive input"); err != nil {
		return nil, err
	}
	if info.Size() != int64(exactBytes) {
		return nil, errors.New("sensitive input has an unexpected size")
	}
	return os.ReadFile(filepath.Clean(path))
}

func readOwnerBoundedFile(path string, maximumBytes int64) ([]byte, error) {
	info, err := os.Lstat(filepath.Clean(path))
	if err != nil {
		return nil, err
	}
	if err := requireOwnerRegularFile(info, "sensitive input"); err != nil {
		return nil, err
	}
	if info.Size() <= 0 || info.Size() > maximumBytes {
		return nil, errors.New("sensitive input has an unexpected size")
	}
	return os.ReadFile(filepath.Clean(path))
}

func requireOwnerRegularFile(info os.FileInfo, label string) error {
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s must be a regular non-symlink file", label)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s must not be group/world accessible", label)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("%s must be owned by uid %d", label, os.Geteuid())
	}
	return nil
}
