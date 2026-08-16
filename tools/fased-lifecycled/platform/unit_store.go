package platform

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type UnitStore interface {
	Prepare(string, map[string][]byte) error
	Activate(string, []string) error
	Restore(string, []string) error
	Discard(string) error
}

type DiskUnitStore struct {
	Config     Config
	rootPrefix string
	Scope      string
}

func NewDiskUnitStore(config Config, scope string) (*DiskUnitStore, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if scope != "controller" && scope != "target" {
		return nil, errors.New("unit store scope must be controller or target")
	}
	return &DiskUnitStore{Config: config, Scope: scope}, nil
}

func (store *DiskUnitStore) Prepare(transactionID string, units map[string][]byte) error {
	if err := store.validateUnits(units); err != nil {
		return err
	}
	workspace := store.workspace(transactionID)
	if err := os.MkdirAll(filepath.Join(workspace, "staged"), 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(workspace, "previous"), 0o700); err != nil {
		return err
	}
	for unit, content := range units {
		target := store.unitPath(unit)
		previous := filepath.Join(workspace, "previous", unit)
		if _, err := os.Lstat(previous); errors.Is(err, os.ErrNotExist) {
			data, readErr := readOptionalRegular(target)
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
		if err := writeAtomicFile(filepath.Join(workspace, "staged", unit), content, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskUnitStore) Activate(transactionID string, units []string) error {
	for _, unit := range units {
		data, err := readRegularFile(filepath.Join(store.workspace(transactionID), "staged", unit))
		if err != nil {
			return err
		}
		if err := writeAtomicFile(store.unitPath(unit), data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskUnitStore) Restore(transactionID string, units []string) error {
	for _, unit := range units {
		data, err := readRegularFile(filepath.Join(store.workspace(transactionID), "previous", unit))
		if err != nil {
			return err
		}
		if string(data) == "ABSENT\n" {
			if err := os.Remove(store.unitPath(unit)); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			continue
		}
		if err := writeAtomicFile(store.unitPath(unit), data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskUnitStore) Discard(transactionID string) error {
	return os.RemoveAll(store.workspace(transactionID))
}

func (store *DiskUnitStore) validateUnits(units map[string][]byte) error {
	identity, err := store.Config.Identity()
	if err != nil {
		return err
	}
	allowed := map[string]bool{}
	for _, unit := range identity.Services {
		allowed[unit] = true
	}
	if len(units) == 0 {
		return errors.New("unit transaction must not be empty")
	}
	for unit, content := range units {
		if !allowed[unit] || len(content) == 0 || len(content) > 1<<20 {
			return fmt.Errorf("unit %q is not an allowed bounded service definition", unit)
		}
	}
	return nil
}

func (store *DiskUnitStore) workspace(transactionID string) string {
	return store.resolve(filepath.Join(store.Config.LifecycleRoot, "transactions", transactionID, store.Scope, "units"))
}

func (store *DiskUnitStore) unitPath(unit string) string {
	return store.resolve(store.Config.ServiceDefinitionPath(unit))
}

func (store *DiskUnitStore) resolve(path string) string {
	if store.rootPrefix == "" {
		return path
	}
	return filepath.Join(store.rootPrefix, filepath.Clean(path))
}

func readOptionalRegular(path string) ([]byte, error) { return readRegularFile(path) }

func readRegularFile(path string) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("unit record must be a regular file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(before, after) {
		return nil, errors.New("unit record changed while reading")
	}
	return data, nil
}

func writeAtomicFile(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".fased-unit-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
