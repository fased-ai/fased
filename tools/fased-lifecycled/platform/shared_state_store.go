package platform

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

const maxSharedStateRecords = 100000

type SharedStateStore interface {
	Prepare(string) error
	Activate(string) error
	Restore(string) error
	Discard(string) error
	Converge() error
}

type sharedStateRecord struct {
	Path string `json:"path"`
	Mode uint32 `json:"mode"`
	UID  uint32 `json:"uid"`
	GID  uint32 `json:"gid"`
}

type DiskSharedStateStore struct {
	Config     Config
	rootPrefix string
}

func NewDiskSharedStateStore(config Config) (*DiskSharedStateStore, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	return &DiskSharedStateStore{Config: config}, nil
}

func (store *DiskSharedStateStore) Prepare(transactionID string) error {
	records, err := store.discover()
	if err != nil {
		return err
	}
	data, err := json.Marshal(records)
	if err != nil {
		return err
	}
	return writeAtomicFile(store.recordPath(transactionID), append(data, '\n'), 0o600)
}

func (store *DiskSharedStateStore) Activate(transactionID string) error {
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
			return errors.Join(err, store.restore(records))
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != record.UID || stat.Gid != record.GID || info.Mode().Perm() != os.FileMode(record.Mode) {
			return errors.Join(errors.New("shared state changed after permission snapshot"), store.restore(records))
		}
		mode := sharedStateMode(info.Mode())
		if err := os.Chown(path, int(record.UID), int(configGID)); err != nil {
			return errors.Join(err, store.restore(records))
		}
		if err := os.Chmod(path, mode); err != nil {
			return errors.Join(err, store.restore(records))
		}
	}
	return nil
}

func (store *DiskSharedStateStore) Converge() error {
	records, err := store.discover()
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
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != record.UID || stat.Gid != record.GID || info.Mode().Perm() != os.FileMode(record.Mode) {
			return errors.New("shared state changed during onboarding convergence")
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

func (store *DiskSharedStateStore) Restore(transactionID string) error {
	records, err := store.read(transactionID)
	if err != nil {
		return err
	}
	return store.restore(records)
}

func (store *DiskSharedStateStore) Discard(transactionID string) error {
	return os.RemoveAll(filepath.Dir(store.recordPath(transactionID)))
}

func (store *DiskSharedStateStore) discover() ([]sharedStateRecord, error) {
	root := store.resolve(store.Config.OwnerStateRoot)
	allowed := []string{"agents", "cache", "canvas", "cron", "extensions", "federation", "identity", "logs", "sat-mining", "share", "workspace"}
	var paths []string
	for _, name := range allowed {
		path := filepath.Join(root, name)
		if err := store.walk(path, &paths); err != nil {
			return nil, err
		}
	}
	for _, relative := range []string{"wallet", filepath.Join("wallet", "provider-registry.v1.json")} {
		path := filepath.Join(root, relative)
		if info, err := os.Lstat(path); err == nil {
			if (relative == "wallet" && !info.IsDir()) || (relative != "wallet" && !info.Mode().IsRegular()) || info.Mode()&os.ModeSymlink != 0 {
				return nil, errors.New("canonical wallet registry state is unsafe")
			}
			paths = append(paths, path)
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	sort.Strings(paths)
	if len(paths) > maxSharedStateRecords {
		return nil, errors.New("shared state permission inventory exceeds limit")
	}
	records := make([]sharedStateRecord, 0, len(paths))
	for _, resolved := range paths {
		info, err := os.Lstat(resolved)
		if err != nil {
			return nil, err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || (stat.Uid != store.Config.Operator.UID && stat.Uid != store.Config.Gateway.UID) || (!info.IsDir() && (!info.Mode().IsRegular() || stat.Nlink != 1)) {
			return nil, fmt.Errorf("shared state entry %q has unsafe identity or type", resolved)
		}
		records = append(records, sharedStateRecord{Path: store.unresolve(resolved), Mode: uint32(info.Mode().Perm()), UID: stat.Uid, GID: stat.Gid})
	}
	return records, nil
}

func (store *DiskSharedStateStore) walk(root string, paths *[]string) error {
	if _, err := os.Lstat(root); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type().IsRegular() && isTransientSQLiteSidecar(entry.Name()) {
			return nil
		}
		if entry.IsDir() || entry.Type().IsRegular() {
			*paths = append(*paths, path)
			if len(*paths) > maxSharedStateRecords {
				return errors.New("shared state permission inventory exceeds limit")
			}
		}
		return nil
	})
}

func isTransientSQLiteSidecar(name string) bool {
	for _, suffix := range []string{"-wal", "-shm", "-journal", ".sqlite-wal", ".sqlite-shm", ".sqlite-journal"} {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}

func (store *DiskSharedStateStore) read(transactionID string) ([]sharedStateRecord, error) {
	data, err := readRegularFile(store.recordPath(transactionID))
	if err != nil {
		return nil, err
	}
	var records []sharedStateRecord
	if err := json.Unmarshal(data, &records); err != nil || len(records) > maxSharedStateRecords {
		return nil, errors.New("shared state permission snapshot is invalid")
	}
	for _, record := range records {
		if !filepath.IsAbs(record.Path) || filepath.Clean(record.Path) != record.Path || !pathWithin(store.Config.OwnerStateRoot, record.Path) || record.Mode > 0o777 {
			return nil, errors.New("shared state permission snapshot escaped its boundary")
		}
	}
	return records, nil
}

func (store *DiskSharedStateStore) restore(records []sharedStateRecord) error {
	var failures []error
	for index := len(records) - 1; index >= 0; index-- {
		record := records[index]
		path := store.resolve(record.Path)
		failures = append(failures, os.Chown(path, int(record.UID), int(record.GID)))
		failures = append(failures, os.Chmod(path, os.FileMode(record.Mode)))
	}
	return errors.Join(failures...)
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

func (store *DiskSharedStateStore) recordPath(transactionID string) string {
	return store.resolve(filepath.Join(store.Config.LifecycleRoot, "transactions", transactionID, "target", "shared-state", "metadata.json"))
}

func (store *DiskSharedStateStore) resolve(path string) string {
	if store.rootPrefix == "" {
		return path
	}
	return filepath.Join(store.rootPrefix, filepath.Clean(path))
}

func (store *DiskSharedStateStore) unresolve(path string) string {
	if store.rootPrefix == "" {
		return path
	}
	return string(filepath.Separator) + filepath.ToSlash(strings.TrimPrefix(path, store.rootPrefix+string(filepath.Separator)))
}
