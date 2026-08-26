// Package migration owns signer state-schema inspection, migration, and backups.
package migration

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	signerstore "fased-signerd/internal/store"
	bolt "go.etcd.io/bbolt"
)

const SignerStateSchemaVersion uint64 = 8

// Contract provides main-owned schema bytes. NewContract clones all inputs so a
// caller cannot alter a migration after passing its contract to this package.
type Contract struct {
	buckets               [][]byte
	metaBucket            []byte
	schemaVersionKey      []byte
	credentialsBucket     []byte
	credentialsVersionKey []byte
	capabilitiesKey       []byte
	capabilities          []byte
}

// WithCapabilities returns a contract bound to an immutable capability value.
func (contract Contract) WithCapabilities(capabilities []byte) Contract {
	contract.capabilities = cloneBytes(capabilities)
	return contract
}

func NewContract(buckets [][]byte, metaBucket, schemaVersionKey, credentialsBucket, credentialsVersionKey, capabilitiesKey []byte) Contract {
	clonedBuckets := make([][]byte, len(buckets))
	for index, bucket := range buckets {
		clonedBuckets[index] = cloneBytes(bucket)
	}
	return Contract{
		buckets:               clonedBuckets,
		metaBucket:            cloneBytes(metaBucket),
		schemaVersionKey:      cloneBytes(schemaVersionKey),
		credentialsBucket:     cloneBytes(credentialsBucket),
		credentialsVersionKey: cloneBytes(credentialsVersionKey),
		capabilitiesKey:       cloneBytes(capabilitiesKey),
	}
}

type SchemaHealth struct {
	Version   uint64 `json:"version"`
	Supported uint64 `json:"supported"`
	Ready     bool   `json:"ready"`
}

func InspectStateBeforeOpen(path string) (bool, bool, error) {
	inspected, err := signerstore.Inspect(path)
	if err != nil {
		return false, false, err
	}
	return inspected.Existed(), inspected.HadState(), nil
}

func InspectSchemaReadOnly(path string, contract Contract) (uint64, error) {
	inspected, err := signerstore.Inspect(path)
	if err != nil {
		return 0, err
	}
	db, err := signerstore.OpenReadOnly(inspected)
	if err != nil {
		return 0, err
	}
	defer db.Close()
	return ReadVersion(db, contract)
}

func ReadVersion(db *signerstore.DB, contract Contract) (uint64, error) {
	if db == nil {
		return 0, errors.New("signer state database is unavailable")
	}
	var version uint64
	err := db.View(func(tx *bolt.Tx) error {
		var err error
		version, err = ReadVersionFromTx(tx, contract)
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("read signer state schema: %w", err)
	}
	return version, nil
}

func ReadVersionFromTx(tx *bolt.Tx, contract Contract) (uint64, error) {
	meta := tx.Bucket(contract.metaBucket)
	if meta == nil {
		return 0, nil
	}
	raw := meta.Get(contract.schemaVersionKey)
	if len(raw) == 0 {
		return 0, nil
	}
	version, err := strconv.ParseUint(string(raw), 10, 64)
	if err != nil || version == 0 {
		return 0, errors.New("signer state schema version is invalid")
	}
	return version, nil
}

func Migrate(db *signerstore.DB, fromVersion uint64, contract Contract) error {
	if db == nil {
		return errors.New("signer state database is unavailable")
	}
	if fromVersion > SignerStateSchemaVersion {
		return fmt.Errorf("signer state schema %d is newer than supported schema %d; refusing to mutate", fromVersion, SignerStateSchemaVersion)
	}
	if fromVersion == SignerStateSchemaVersion {
		return ValidateBuckets(db, contract)
	}
	if fromVersion != 0 && fromVersion != 1 && fromVersion != 2 && fromVersion != 3 && fromVersion != 4 && fromVersion != 5 && fromVersion != 6 && fromVersion != 7 {
		return fmt.Errorf("unsupported signer state migration from schema %d", fromVersion)
	}
	err := db.Update(func(tx *bolt.Tx) error {
		current, err := ReadVersionFromTx(tx, contract)
		if err != nil {
			return err
		}
		if current != fromVersion {
			return fmt.Errorf("signer state schema changed during migration: expected %d, current %d", fromVersion, current)
		}
		for _, bucket := range contract.buckets {
			if _, err := tx.CreateBucketIfNotExists(bucket); err != nil {
				return err
			}
		}
		meta := tx.Bucket(contract.metaBucket)
		if meta.Get(contract.credentialsVersionKey) == nil {
			credentialCount := uint64(0)
			if credentials := tx.Bucket(contract.credentialsBucket); credentials != nil {
				if err := credentials.ForEach(func(_, value []byte) error {
					if value != nil {
						credentialCount++
					}
					return nil
				}); err != nil {
					return err
				}
			}
			if err := meta.Put(contract.credentialsVersionKey, []byte(strconv.FormatUint(credentialCount, 10))); err != nil {
				return err
			}
		}
		if err := meta.Put(contract.capabilitiesKey, contract.capabilities); err != nil {
			return err
		}
		return meta.Put(contract.schemaVersionKey, []byte(strconv.FormatUint(SignerStateSchemaVersion, 10)))
	})
	if err != nil {
		return fmt.Errorf("migrate signer state schema %d to %d atomically: %w", fromVersion, SignerStateSchemaVersion, err)
	}
	return ValidateBuckets(db, contract)
}

func ValidateBuckets(db *signerstore.DB, contract Contract) error {
	if db == nil {
		return errors.New("signer state database is unavailable")
	}
	return db.View(func(tx *bolt.Tx) error {
		version, err := ReadVersionFromTx(tx, contract)
		if err != nil {
			return err
		}
		if version != SignerStateSchemaVersion {
			return fmt.Errorf("signer state schema is %d, expected %d", version, SignerStateSchemaVersion)
		}
		for _, bucket := range contract.buckets {
			if tx.Bucket(bucket) == nil {
				return fmt.Errorf("signer state schema %d is missing required bucket %q", version, string(bucket))
			}
		}
		return nil
	})
}

func BackupBeforeMigration(db *signerstore.DB, statePath string) (string, error) {
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
		candidate := fmt.Sprintf("%s.pre-v%d-%s%s.bak", statePath, SignerStateSchemaVersion, stamp, suffix)
		file, err := os.OpenFile(candidate, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", fmt.Errorf("create pre-migration signer state backup: %w", err)
		}
		backupPath, backup = candidate, file
		break
	}
	if backup == nil {
		return "", errors.New("could not allocate exclusive pre-migration signer state backup")
	}
	cleanup := func(cause error) (string, error) {
		_ = backup.Close()
		_ = os.Remove(backupPath)
		_ = SyncDirectory(directory)
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
	if err := SyncDirectory(directory); err != nil {
		_ = os.Remove(backupPath)
		return "", err
	}
	return backupPath, nil
}

func SyncDirectory(path string) error {
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

func Health(version uint64) SchemaHealth {
	return SchemaHealth{Version: version, Supported: SignerStateSchemaVersion, Ready: version == SignerStateSchemaVersion}
}

func cloneBytes(value []byte) []byte { return append([]byte(nil), value...) }
