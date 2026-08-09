package platform

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

type LifecycleFile struct {
	Data []byte
	Mode os.FileMode
}

type LifecycleFileStore interface {
	Prepare(string, map[string]LifecycleFile) error
	Activate(string, []string) error
	Restore(string, []string) error
	Discard(string) error
}

type DiskLifecycleFileStore struct {
	Config      Config
	rootPrefix  string
	expectedUID uint32
}

func NewDiskLifecycleFileStore(config Config) (*DiskLifecycleFileStore, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	return &DiskLifecycleFileStore{Config: config}, nil
}

func (store *DiskLifecycleFileStore) Prepare(transactionID string, files map[string]LifecycleFile) error {
	if err := store.validate(files); err != nil {
		return err
	}
	workspace := store.workspace(transactionID)
	for _, directory := range []string{"staged", "previous"} {
		if err := os.MkdirAll(filepath.Join(workspace, directory), 0o700); err != nil {
			return err
		}
	}
	for target, file := range files {
		name := store.recordName(target)
		previous := filepath.Join(workspace, "previous", name)
		if _, err := os.Lstat(previous); errors.Is(err, os.ErrNotExist) {
			resolved := store.resolve(target)
			info, inspectErr := os.Lstat(resolved)
			if inspectErr == nil {
				stat, ok := info.Sys().(*syscall.Stat_t)
				if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o755 || !ok || stat.Uid != store.expectedUID || stat.Nlink != 1 {
					return errors.New("existing signer-owner lifecycle file is unsafe")
				}
			} else if !errors.Is(inspectErr, os.ErrNotExist) {
				return inspectErr
			}
			data, readErr := readOptionalRegular(resolved)
			if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
				return readErr
			}
			if errors.Is(readErr, os.ErrNotExist) {
				data = []byte("ABSENT\n")
			}
			if err := writeAtomicFile(previous, data, 0o600); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		if err := writeAtomicFile(filepath.Join(workspace, "staged", name), file.Data, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskLifecycleFileStore) Activate(transactionID string, targets []string) error {
	for _, target := range targets {
		data, err := readRegularFile(filepath.Join(store.workspace(transactionID), "staged", store.recordName(target)))
		if err != nil {
			return err
		}
		mode := os.FileMode(0o755)
		if err := writeAtomicFile(store.resolve(target), data, mode); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskLifecycleFileStore) Restore(transactionID string, targets []string) error {
	for _, target := range targets {
		data, err := readRegularFile(filepath.Join(store.workspace(transactionID), "previous", store.recordName(target)))
		if err != nil {
			return err
		}
		resolved := store.resolve(target)
		if string(data) == "ABSENT\n" {
			if err := os.Remove(resolved); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			continue
		}
		if err := writeAtomicFile(resolved, data, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskLifecycleFileStore) Discard(transactionID string) error {
	return os.RemoveAll(store.workspace(transactionID))
}

func (store *DiskLifecycleFileStore) validate(files map[string]LifecycleFile) error {
	allowed := map[string]bool{}
	for _, target := range CanonicalSignerOwnerFiles(store.Config) {
		allowed[target] = true
	}
	if len(files) != len(allowed) {
		return errors.New("lifecycle file transaction must contain the exact signer-owner file set")
	}
	for target, file := range files {
		if !allowed[target] || len(file.Data) == 0 || len(file.Data) > 1<<20 || file.Mode != 0o755 {
			return fmt.Errorf("lifecycle file %q is not an allowed bounded executable", target)
		}
	}
	return nil
}

func (store *DiskLifecycleFileStore) recordName(target string) string {
	if filepath.Dir(target) == "/usr/local/libexec" {
		return "helper"
	}
	return "wrapper"
}

func (store *DiskLifecycleFileStore) workspace(transactionID string) string {
	return store.resolve(filepath.Join(store.Config.LifecycleRoot, "transactions", transactionID, "target", "files"))
}

func (store *DiskLifecycleFileStore) resolve(path string) string {
	if store.rootPrefix == "" {
		return path
	}
	return filepath.Join(store.rootPrefix, filepath.Clean(path))
}
