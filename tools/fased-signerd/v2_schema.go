package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	bolt "go.etcd.io/bbolt"
)

const signerStateSchemaVersionV2 uint64 = 3

var signerStateBucketsV2 = [][]byte{
	bucketSignerMetaV2,
	bucketSignerPoliciesV2,
	bucketSignerOperationsV2,
	bucketSignerUsageV2,
	bucketSignerWalletsV2,
	bucketSignerNetworksV2,
	bucketSignerWebAuthnCredentialsV2,
	bucketSignerWebAuthnChallengesV2,
	bucketSignerReviewProofsV2,
	bucketSignerReviewsV2,
}

type signerSchemaHealthV2 struct {
	Version   uint64 `json:"version"`
	Supported uint64 `json:"supported"`
	Ready     bool   `json:"ready"`
}

func inspectSignerStateBeforeOpenV2(path string) (bool, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("inspect signer state database: %w", err)
	}
	if err := validateSignerStateFileV2(path); err != nil {
		return false, false, err
	}
	return true, info.Size() > 0, nil
}

func inspectSignerSchemaReadOnlyV2(path string) (uint64, error) {
	db, err := bolt.Open(path, 0o600, &bolt.Options{ReadOnly: true, Timeout: 2 * time.Second})
	if err != nil {
		return 0, fmt.Errorf("inspect signer state schema: %w", err)
	}
	defer db.Close()
	return readSignerSchemaVersionV2(db)
}

func readSignerSchemaVersionV2(db *bolt.DB) (uint64, error) {
	if db == nil {
		return 0, errors.New("signer state database is unavailable")
	}
	var version uint64
	err := db.View(func(tx *bolt.Tx) error {
		var err error
		version, err = readSignerSchemaVersionFromTxV2(tx)
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("read signer state schema: %w", err)
	}
	return version, nil
}

func readSignerSchemaVersionFromTxV2(tx *bolt.Tx) (uint64, error) {
	meta := tx.Bucket(bucketSignerMetaV2)
	if meta == nil {
		return 0, nil
	}
	raw := meta.Get([]byte("schemaVersion"))
	if len(raw) == 0 {
		return 0, nil
	}
	version, err := strconv.ParseUint(string(raw), 10, 64)
	if err != nil || version == 0 {
		return 0, errors.New("signer state schema version is invalid")
	}
	return version, nil
}

func migrateSignerStateV2(db *bolt.DB, fromVersion uint64) error {
	if db == nil {
		return errors.New("signer state database is unavailable")
	}
	if fromVersion > signerStateSchemaVersionV2 {
		return fmt.Errorf(
			"signer state schema %d is newer than supported schema %d; refusing to mutate",
			fromVersion,
			signerStateSchemaVersionV2,
		)
	}
	if fromVersion == signerStateSchemaVersionV2 {
		return validateSignerSchemaBucketsV2(db)
	}
	if fromVersion != 0 && fromVersion != 1 && fromVersion != 2 {
		return fmt.Errorf("unsupported signer state migration from schema %d", fromVersion)
	}
	capabilities, err := json.Marshal(signerV2Capabilities)
	if err != nil {
		return fmt.Errorf("encode signer capabilities for migration: %w", err)
	}
	err = db.Update(func(tx *bolt.Tx) error {
		current, err := readSignerSchemaVersionFromTxV2(tx)
		if err != nil {
			return err
		}
		if current != fromVersion {
			return fmt.Errorf("signer state schema changed during migration: expected %d, current %d", fromVersion, current)
		}
		for _, bucket := range signerStateBucketsV2 {
			if _, err := tx.CreateBucketIfNotExists(bucket); err != nil {
				return err
			}
		}
		meta := tx.Bucket(bucketSignerMetaV2)
		if err := meta.Put([]byte("capabilities"), capabilities); err != nil {
			return err
		}
		return meta.Put([]byte("schemaVersion"), []byte(strconv.FormatUint(signerStateSchemaVersionV2, 10)))
	})
	if err != nil {
		return fmt.Errorf("migrate signer state schema %d to %d atomically: %w", fromVersion, signerStateSchemaVersionV2, err)
	}
	return validateSignerSchemaBucketsV2(db)
}

func validateSignerSchemaBucketsV2(db *bolt.DB) error {
	if db == nil {
		return errors.New("signer state database is unavailable")
	}
	return db.View(func(tx *bolt.Tx) error {
		version, err := readSignerSchemaVersionFromTxV2(tx)
		if err != nil {
			return err
		}
		if version != signerStateSchemaVersionV2 {
			return fmt.Errorf("signer state schema is %d, expected %d", version, signerStateSchemaVersionV2)
		}
		for _, bucket := range signerStateBucketsV2 {
			if tx.Bucket(bucket) == nil {
				return fmt.Errorf("signer state schema %d is missing required bucket %q", version, string(bucket))
			}
		}
		return nil
	})
}

func backupSignerStateBeforeMigrationV2(db *bolt.DB, statePath string) (string, error) {
	if db == nil {
		return "", errors.New("signer state database is unavailable")
	}
	directory := filepath.Dir(statePath)
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	var backupPath string
	var backup *os.File
	for attempt := 0; attempt < 16; attempt++ {
		suffix := ""
		if attempt > 0 {
			suffix = fmt.Sprintf(".%d", attempt)
		}
		candidate := fmt.Sprintf("%s.pre-v%d-%s%s.bak", statePath, signerStateSchemaVersionV2, stamp, suffix)
		file, err := os.OpenFile(candidate, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", fmt.Errorf("create pre-migration signer state backup: %w", err)
		}
		backupPath = candidate
		backup = file
		break
	}
	if backup == nil {
		return "", errors.New("could not allocate exclusive pre-migration signer state backup")
	}
	cleanup := func(cause error) (string, error) {
		_ = backup.Close()
		_ = os.Remove(backupPath)
		_ = syncSignerStateDirectoryV2(directory)
		return "", cause
	}
	if err := backup.Chmod(0o600); err != nil {
		return cleanup(fmt.Errorf("secure pre-migration signer state backup: %w", err))
	}
	if err := db.View(func(tx *bolt.Tx) error {
		_, err := tx.WriteTo(backup)
		return err
	}); err != nil {
		return cleanup(fmt.Errorf("write pre-migration signer state backup: %w", err))
	}
	if err := backup.Sync(); err != nil {
		return cleanup(fmt.Errorf("fsync pre-migration signer state backup: %w", err))
	}
	if err := backup.Close(); err != nil {
		return cleanup(fmt.Errorf("close pre-migration signer state backup: %w", err))
	}
	if err := syncSignerStateDirectoryV2(directory); err != nil {
		_ = os.Remove(backupPath)
		return "", err
	}
	return backupPath, nil
}

func syncSignerStateDirectoryV2(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open signer state directory for fsync: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("fsync signer state directory: %w", err)
	}
	return nil
}

func (s *signerStoreV2) schemaHealth() signerSchemaHealthV2 {
	version := uint64(0)
	if s != nil {
		version = s.schemaVersion
	}
	return signerSchemaHealthV2{
		Version:   version,
		Supported: signerStateSchemaVersionV2,
		Ready:     version == signerStateSchemaVersionV2,
	}
}
