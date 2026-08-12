package platform

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	stateparticipant "fased-lifecycled/participant"
)

type SharedStateStore interface {
	Prepare(string) (string, error)
	Activate(string) error
	VerifyAccess(string) error
	Restore(string) error
	Discard(string) error
	Converge() error
}

const maxSharedStateRecords = 100000

type typedStateRecord struct {
	Participant string `json:"participant"`
	Path        string `json:"path"`
	Mode        uint32 `json:"mode"`
	UID         uint32 `json:"uid"`
	GID         uint32 `json:"gid"`
	Directory   bool   `json:"directory"`
	SignerOwned bool   `json:"signerOwned"`
	SQLite      bool   `json:"sqlite"`
	Backup      string `json:"backup,omitempty"`
	Digest      string `json:"digest,omitempty"`
}

// DiskTypedStateStore is the only active product-state permission and SQLite
// rollback owner. Prepare must be called after Gateway and signer quiescence.
type DiskTypedStateStore struct {
	Config     Config
	rootPrefix string
}

func NewDiskTypedStateStore(config Config) (*DiskTypedStateStore, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	return &DiskTypedStateStore{Config: config}, nil
}

func (store *DiskTypedStateStore) Prepare(transactionID string) (string, error) {
	records, err := store.discover()
	if err != nil {
		return "", err
	}
	for index := range records {
		if !records[index].SQLite {
			continue
		}
		backup := filepath.Join(store.transactionRoot(transactionID), "sqlite", fmt.Sprintf("%04d.state", index))
		digest, err := stateparticipant.SnapshotSQLiteFile(store.resolve(records[index].Path), backup)
		if err != nil {
			return "", fmt.Errorf("snapshot %s SQLite family: %w", records[index].Participant, err)
		}
		records[index].Backup = store.unresolve(backup)
		records[index].Digest = digest
	}
	data, err := json.Marshal(records)
	if err != nil {
		return "", err
	}
	if err := writeAtomicFile(store.recordPath(transactionID), append(data, '\n'), 0o600); err != nil {
		return "", err
	}
	if err := syncDirectoryChain(store.transactionRoot(transactionID), store.resolve(store.Config.LifecycleRoot)); err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return fmt.Sprintf("sha256:%x", digest), nil
}

func (store *DiskTypedStateStore) Activate(transactionID string) error {
	records, err := store.read(transactionID)
	if err != nil {
		return err
	}
	configGID, err := canonicalConfigGroupGID(store.resolve(store.Config.OwnerStateRoot), store.Config.Operator.UID)
	if err != nil {
		return err
	}
	for _, record := range records {
		path := store.resolve(record.Path)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if record.SignerOwned {
			// The signer/migrator owns signer metadata changes. This state
			// participant owns its SQLite rollback bytes and verifies the
			// post-migration signer identity below.
			continue
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != record.UID || stat.Gid != record.GID || durableStateMode(info.Mode()) != record.Mode || info.IsDir() != record.Directory {
			return errors.New("typed state changed after post-quiesce snapshot")
		}
		if err := os.Chown(path, int(record.UID), int(configGID)); err != nil {
			return err
		}
		if err := os.Chmod(path, sharedStateMode(info.Mode())); err != nil {
			return err
		}
	}
	return store.VerifyAccess(transactionID)
}

func (store *DiskTypedStateStore) VerifyAccess(transactionID string) error {
	records, err := store.read(transactionID)
	if err != nil {
		return err
	}
	current, err := store.discover()
	if err != nil {
		return err
	}
	seen := make(map[string]bool, len(records))
	for _, record := range records {
		seen[record.Path] = true
	}
	for _, record := range current {
		if !seen[record.Path] {
			records = append(records, record)
		}
	}
	configGID, err := canonicalConfigGroupGID(store.resolve(store.Config.OwnerStateRoot), store.Config.Operator.UID)
	if err != nil {
		return err
	}
	for _, record := range records {
		info, err := os.Lstat(store.resolve(record.Path))
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return errors.New("typed state identity is unavailable")
		}
		uid, gid := store.Config.Gateway.UID, configGID
		if record.SignerOwned {
			uid, gid = store.Config.Signer.UID, store.Config.Signer.GID
		}
		if !principalCanAccess(info.Mode(), stat.Uid, stat.Gid, uid, gid) {
			return fmt.Errorf("%s state is inaccessible to target uid %d", record.Participant, uid)
		}
	}
	return nil
}

func principalCanAccess(mode os.FileMode, ownerUID, ownerGID, uid, gid uint32) bool {
	bits := mode.Perm() & 0o007
	if uid == ownerUID {
		bits = (mode.Perm() >> 6) & 0o7
	} else if gid == ownerGID {
		bits = (mode.Perm() >> 3) & 0o7
	}
	want := os.FileMode(0o6)
	if mode.IsDir() {
		want = 0o7
	}
	return bits&want == want
}

func (store *DiskTypedStateStore) Restore(transactionID string) error {
	records, err := store.read(transactionID)
	if errors.Is(err, os.ErrNotExist) {
		// Quiescing may fail before a state snapshot is created. No typed
		// state mutation exists to undo in that case.
		return nil
	}
	if err != nil {
		return err
	}
	wantSQLite := make(map[string]bool)
	for _, record := range records {
		if record.SQLite {
			wantSQLite[record.Path] = true
		}
	}
	current, err := store.discover()
	if err != nil {
		return err
	}
	for _, record := range current {
		if record.SQLite && !wantSQLite[record.Path] {
			if err := stateparticipant.RemoveUnexpectedSQLiteFile(store.resolve(record.Path)); err != nil {
				return err
			}
		}
	}
	for index := len(records) - 1; index >= 0; index-- {
		record := records[index]
		path := store.resolve(record.Path)
		if record.SQLite {
			if err := stateparticipant.RestoreSQLiteFile(store.resolve(record.Backup), path, record.Digest, os.FileMode(record.Mode)); err != nil {
				return err
			}
		}
		if err := os.Chown(path, int(record.UID), int(record.GID)); err != nil {
			return err
		}
		if err := os.Chmod(path, os.FileMode(record.Mode)); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskTypedStateStore) Discard(transactionID string) error {
	return os.RemoveAll(store.transactionRoot(transactionID))
}

func (store *DiskTypedStateStore) Converge() error {
	records, err := store.discover()
	if err != nil {
		return err
	}
	configGID, err := canonicalConfigGroupGID(store.resolve(store.Config.OwnerStateRoot), store.Config.Operator.UID)
	if err != nil {
		return err
	}
	for _, record := range records {
		if record.SignerOwned {
			continue
		}
		path := store.resolve(record.Path)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if err := os.Chown(path, int(record.UID), int(configGID)); err != nil {
			return err
		}
		if err := os.Chmod(path, sharedStateMode(info.Mode())); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskTypedStateStore) discover() ([]typedStateRecord, error) {
	var records []typedStateRecord
	seen := make(map[string]bool)
	for _, spec := range store.specs() {
		path := store.resolve(spec.Path)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if spec.RootOnly || info.Mode().IsRegular() {
			record, err := store.inspect(spec, path, info)
			if err != nil {
				return nil, err
			}
			if !seen[record.Path] {
				records = append(records, record)
				seen[record.Path] = true
			}
			continue
		}
		err = filepath.WalkDir(path, func(current string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			info, err := os.Lstat(current)
			if err != nil {
				return err
			}
			record, err := store.inspect(spec, current, info)
			if err != nil {
				return err
			}
			if !seen[record.Path] {
				records = append(records, record)
				seen[record.Path] = true
			}
			if len(records) > maxSharedStateRecords {
				return errors.New("typed state inventory exceeds limit")
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Path < records[j].Path })
	return records, nil
}

func (store *DiskTypedStateStore) inspect(spec stateparticipant.StateSpec, path string, info os.FileInfo) (typedStateRecord, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && (!info.Mode().IsRegular() || stat.Nlink != 1)) {
		return typedStateRecord{}, fmt.Errorf("%s state contains an unsafe entry", spec.Kind)
	}
	if spec.SignerOwned {
		if stat.Uid != 0 && stat.Uid != store.Config.Signer.UID {
			return typedStateRecord{}, errors.New("signer state has an unexpected owner")
		}
	} else if stat.Uid != store.Config.Operator.UID && stat.Uid != store.Config.Gateway.UID {
		return typedStateRecord{}, fmt.Errorf("%s state has an unexpected owner", spec.Kind)
	}
	return typedStateRecord{Participant: string(spec.Kind), Path: store.unresolve(path), Mode: durableStateMode(info.Mode()), UID: stat.Uid, GID: stat.Gid, Directory: info.IsDir(), SignerOwned: spec.SignerOwned, SQLite: info.Mode().IsRegular() && stateparticipant.IsSQLiteFamilyName(info.Name())}, nil
}

func durableStateMode(mode os.FileMode) uint32 {
	return uint32(mode & (os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky))
}

func sharedStateMode(mode os.FileMode) os.FileMode {
	if mode.IsDir() {
		return os.ModeSetgid | 0o770
	}
	result := mode.Perm() | 0o660
	if mode.Perm()&0o111 != 0 {
		result |= 0o110
	}
	return result & 0o770
}

func (store *DiskTypedStateStore) specs() []stateparticipant.StateSpec {
	return stateparticipant.CanonicalStateSpecs(store.Config.OwnerStateRoot, store.Config.SignerStateRoot())
}

func (store *DiskTypedStateStore) read(transactionID string) ([]typedStateRecord, error) {
	data, err := readRegularFile(store.recordPath(transactionID))
	if err != nil {
		return nil, err
	}
	var records []typedStateRecord
	if err := json.Unmarshal(data, &records); err != nil || len(records) > maxSharedStateRecords {
		return nil, errors.New("typed state record is invalid")
	}
	for _, record := range records {
		if record.Participant == "" || !filepath.IsAbs(record.Path) || filepath.Clean(record.Path) != record.Path || (!pathWithin(store.Config.OwnerStateRoot, record.Path) && !pathWithin(store.Config.SignerStateRoot(), record.Path) && record.Path != store.Config.SignerStateRoot()) {
			return nil, errors.New("typed state record escaped its declared roots")
		}
		if record.SQLite && (record.Backup == "" || !stateparticipant.ValidDigest(record.Digest) || !pathWithin(store.unresolve(store.transactionRoot(transactionID)), record.Backup)) {
			return nil, errors.New("SQLite family record lacks rollback evidence")
		}
	}
	return records, nil
}

func (store *DiskTypedStateStore) transactionRoot(transactionID string) string {
	return store.resolve(filepath.Join(store.Config.LifecycleRoot, "transactions", transactionID, "target", "typed-state"))
}

func (store *DiskTypedStateStore) recordPath(transactionID string) string {
	return filepath.Join(store.transactionRoot(transactionID), "metadata.json")
}

func (store *DiskTypedStateStore) resolve(path string) string {
	if store.rootPrefix == "" {
		return path
	}
	return filepath.Join(store.rootPrefix, filepath.Clean(path))
}

func (store *DiskTypedStateStore) unresolve(path string) string {
	if store.rootPrefix == "" {
		return path
	}
	return string(filepath.Separator) + filepath.ToSlash(strings.TrimPrefix(path, store.rootPrefix+string(filepath.Separator)))
}

func syncDirectoryChain(start, stop string) error {
	current := filepath.Clean(start)
	stop = filepath.Clean(stop)
	for {
		directory, err := os.Open(current)
		if err != nil {
			return err
		}
		err = directory.Sync()
		directory.Close()
		if err != nil {
			return err
		}
		if current == stop {
			return nil
		}
		parent := filepath.Dir(current)
		if parent == current || !pathWithin(stop, current) {
			return errors.New("typed state durability path escaped lifecycle root")
		}
		current = parent
	}
}
