package migrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"fased-lifecycled/model"
	"fased-lifecycled/platform"
)

type DirectoryAdapter struct {
	Path          string
	LifecycleRoot string
}

type directoryMarker struct {
	Path    string `json:"path"`
	Created bool   `json:"created"`
}

func (adapter DirectoryAdapter) Prepare(_ context.Context, tx model.Transaction, migration model.Migration) error {
	if err := adapter.validate(tx, migration); err != nil {
		return err
	}
	info, err := os.Lstat(adapter.Path)
	created := false
	if errors.Is(err, os.ErrNotExist) {
		if migration.From != 0 {
			return errors.New("declared installed state directory is missing")
		}
		created = true
	} else if err != nil {
		return err
	} else if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("declared state path is not a regular directory")
	}
	data, _ := json.Marshal(directoryMarker{Path: adapter.Path, Created: created})
	return writeMigrationRecord(adapter.markerPath(tx, migration), data)
}

func (adapter DirectoryAdapter) Activate(_ context.Context, tx model.Transaction, migration model.Migration) error {
	marker, err := adapter.readMarker(tx, migration)
	if err != nil {
		return err
	}
	if marker.Created {
		if err := os.MkdirAll(marker.Path, 0o700); err != nil {
			return err
		}
	}
	return nil
}

func (adapter DirectoryAdapter) Verify(_ context.Context, tx model.Transaction, migration model.Migration) error {
	if _, err := adapter.readMarker(tx, migration); err != nil {
		return err
	}
	info, err := os.Lstat(adapter.Path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("migrated state directory is unavailable or unsafe")
	}
	return nil
}

func (adapter DirectoryAdapter) Commit(_ context.Context, tx model.Transaction, migration model.Migration) error {
	return removeMigrationRecord(adapter.markerPath(tx, migration))
}

func (adapter DirectoryAdapter) Abort(_ context.Context, tx model.Transaction, migration model.Migration) error {
	marker, err := adapter.readMarker(tx, migration)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if marker.Created {
		if err := os.Remove(marker.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("fresh state directory is not empty; refusing destructive rollback: %w", err)
		}
	}
	return removeMigrationRecord(adapter.markerPath(tx, migration))
}

func (adapter DirectoryAdapter) validate(tx model.Transaction, migration model.Migration) error {
	if !filepath.IsAbs(adapter.Path) || filepath.Clean(adapter.Path) != adapter.Path || !filepath.IsAbs(adapter.LifecycleRoot) || filepath.Clean(adapter.LifecycleRoot) != adapter.LifecycleRoot {
		return errors.New("migration paths must be absolute and clean")
	}
	if migration.From > 0 && migration.To <= migration.From {
		return errors.New("directory migration is not monotonic")
	}
	return tx.Validate()
}

func (adapter DirectoryAdapter) markerPath(tx model.Transaction, migration model.Migration) string {
	return filepath.Join(adapter.LifecycleRoot, "transactions", tx.ID, "migrations", migration.State+".json")
}

func (adapter DirectoryAdapter) readMarker(tx model.Transaction, migration model.Migration) (directoryMarker, error) {
	data, err := os.ReadFile(adapter.markerPath(tx, migration))
	if err != nil {
		return directoryMarker{}, err
	}
	var marker directoryMarker
	if err := json.Unmarshal(data, &marker); err != nil || marker.Path != adapter.Path {
		return directoryMarker{}, errors.New("migration marker is invalid or rebound")
	}
	return marker, nil
}

type SignerOwnedAdapter struct{}

func (SignerOwnedAdapter) Prepare(context.Context, model.Transaction, model.Migration) error {
	return nil
}
func (SignerOwnedAdapter) Activate(context.Context, model.Transaction, model.Migration) error {
	return nil
}
func (SignerOwnedAdapter) Verify(context.Context, model.Transaction, model.Migration) error {
	return nil
}
func (SignerOwnedAdapter) Commit(context.Context, model.Transaction, model.Migration) error {
	return nil
}
func (SignerOwnedAdapter) Abort(context.Context, model.Transaction, model.Migration) error {
	return nil
}

func RegistryFor(config platform.Config) (map[Key]Adapter, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	directory := func(path string) Adapter { return DirectoryAdapter{Path: path, LifecycleRoot: config.LifecycleRoot} }
	registry := map[Key]Adapter{
		{State: "managedInstall", From: 0, To: 2}: directory(config.InstallRoot),
		{State: "managedInstall", From: 1, To: 2}: directory(config.InstallRoot),
		{State: "walletRegistry", From: 0, To: 1}: directory(filepath.Join(config.OwnerStateRoot, "wallet")),
		{State: "mining", From: 0, To: 1}:         directory(filepath.Join(config.OwnerStateRoot, "mining")),
		{State: "federation", From: 0, To: 2}:     directory(filepath.Join(config.OwnerStateRoot, "federation")),
		{State: "federation", From: 1, To: 2}:     directory(filepath.Join(config.OwnerStateRoot, "federation")),
		{State: "signer", From: 0, To: 2}:         SignerOwnedAdapter{},
		{State: "signer", From: 1, To: 2}:         SignerOwnedAdapter{},
	}
	return registry, nil
}

func writeMigrationRecord(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".migration-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
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

func removeMigrationRecord(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
