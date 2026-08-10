package platform

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func CanonicalInstallProjectionPath(config Config) string {
	return filepath.Join(config.OwnerStateRoot, "install.json")
}

func CanonicalGatewayConfigPath(config Config) string {
	return filepath.Join(config.OwnerStateRoot, "fased.json")
}

type LifecycleFile struct {
	Data []byte
	Mode os.FileMode
	UID  uint32
	GID  uint32
}

type lifecycleFileMetadata struct {
	Present bool   `json:"present"`
	Mode    uint32 `json:"mode"`
	UID     uint32 `json:"uid"`
	GID     uint32 `json:"gid"`
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
		previousMetadata := previous + ".json"
		if _, err := os.Lstat(previousMetadata); errors.Is(err, os.ErrNotExist) {
			resolved := store.resolve(target)
			info, inspectErr := os.Lstat(resolved)
			metadata := lifecycleFileMetadata{}
			if inspectErr == nil {
				stat, ok := info.Sys().(*syscall.Stat_t)
				if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || !ok || stat.Nlink != 1 || info.Size() > 1<<20 || !store.safeExisting(target, info.Mode().Perm(), stat.Uid) {
					return errors.New("existing lifecycle projection file is unsafe")
				}
				metadata = lifecycleFileMetadata{Present: true, Mode: uint32(info.Mode().Perm()), UID: stat.Uid, GID: stat.Gid}
			} else if !errors.Is(inspectErr, os.ErrNotExist) {
				return inspectErr
			}
			if metadata.Present {
				data, readErr := readOptionalRegular(resolved)
				if readErr != nil {
					return readErr
				}
				if err := writeAtomicFile(previous, data, 0o600); err != nil {
					return err
				}
			}
			encoded, err := json.Marshal(metadata)
			if err != nil {
				return err
			}
			if err := writeAtomicFile(previousMetadata, append(encoded, '\n'), 0o600); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		if err := writeAtomicFile(filepath.Join(workspace, "staged", name), file.Data, 0o600); err != nil {
			return err
		}
		encoded, err := json.Marshal(lifecycleFileMetadata{Present: true, Mode: uint32(file.Mode.Perm()), UID: file.UID, GID: file.GID})
		if err != nil {
			return err
		}
		if err := writeAtomicFile(filepath.Join(workspace, "staged", name+".json"), append(encoded, '\n'), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskLifecycleFileStore) Activate(transactionID string, targets []string) error {
	for _, target := range targets {
		name := store.recordName(target)
		data, err := readRegularFile(filepath.Join(store.workspace(transactionID), "staged", name))
		if err != nil {
			return err
		}
		metadata, err := store.readMetadata(filepath.Join(store.workspace(transactionID), "staged", name+".json"))
		if err != nil || !metadata.Present {
			return errors.New("staged lifecycle file metadata is invalid")
		}
		if err := store.install(target, data, os.FileMode(metadata.Mode), metadata.UID, metadata.GID); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskLifecycleFileStore) Restore(transactionID string, targets []string) error {
	for _, target := range targets {
		name := store.recordName(target)
		metadata, err := store.readMetadata(filepath.Join(store.workspace(transactionID), "previous", name+".json"))
		if err != nil {
			return err
		}
		resolved := store.resolve(target)
		if !metadata.Present {
			if err := os.Remove(resolved); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			continue
		}
		data, err := readRegularFile(filepath.Join(store.workspace(transactionID), "previous", name))
		if err != nil {
			return err
		}
		if err := store.install(target, data, os.FileMode(metadata.Mode), metadata.UID, metadata.GID); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskLifecycleFileStore) Discard(transactionID string) error {
	return os.RemoveAll(store.workspace(transactionID))
}

func (store *DiskLifecycleFileStore) validate(files map[string]LifecycleFile) error {
	allowed := map[string]LifecycleFile{}
	for _, target := range CanonicalSignerOwnerFiles(store.Config) {
		allowed[target] = LifecycleFile{Mode: 0o755, UID: store.expectedUID, GID: store.expectedUID}
	}
	allowed[CanonicalInstallProjectionPath(store.Config)] = LifecycleFile{Mode: 0o640, UID: store.Config.Operator.UID, GID: store.Config.Operator.GID}
	baseCount := len(allowed)
	if _, ok := files[CanonicalGatewayConfigPath(store.Config)]; ok {
		gid, err := canonicalConfigGroupGID(store.resolve(store.Config.OwnerStateRoot), store.Config.Operator.UID)
		if err != nil {
			return err
		}
		allowed[CanonicalGatewayConfigPath(store.Config)] = LifecycleFile{Mode: 0o660, UID: store.Config.Operator.UID, GID: gid}
	}
	if len(files) != baseCount && len(files) != baseCount+1 {
		return errors.New("lifecycle file transaction must contain the exact derived file set")
	}
	for target, file := range files {
		expected, ok := allowed[target]
		if !ok || len(file.Data) == 0 || len(file.Data) > 1<<20 || file.Mode != expected.Mode || file.UID != expected.UID || file.GID != expected.GID {
			return fmt.Errorf("lifecycle file %q does not match its bounded derived contract", target)
		}
	}
	return nil
}

func (store *DiskLifecycleFileStore) recordName(target string) string {
	if target == CanonicalGatewayConfigPath(store.Config) {
		return "gateway-config"
	}
	if target == CanonicalInstallProjectionPath(store.Config) {
		return "install-projection"
	}
	if filepath.Dir(target) == "/usr/local/libexec" {
		return "helper"
	}
	return "wrapper"
}

func (store *DiskLifecycleFileStore) safeExisting(target string, mode os.FileMode, uid uint32) bool {
	if target == CanonicalGatewayConfigPath(store.Config) {
		return mode&0o007 == 0 && mode&0o111 == 0 && uid == store.Config.Operator.UID
	}
	if target == CanonicalInstallProjectionPath(store.Config) {
		return mode&0o002 == 0 && (uid == store.Config.Operator.UID || uid == store.expectedUID)
	}
	return mode == 0o755 && uid == store.expectedUID
}

func canonicalConfigGroupGID(path string, operatorUID uint32) (uint32, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return 0, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !ok || stat.Uid != operatorUID || stat.Gid == 0 || info.Mode().Perm()&0o007 != 0 {
		return 0, errors.New("owner state root does not expose a canonical config group")
	}
	return stat.Gid, nil
}

func (store *DiskLifecycleFileStore) readMetadata(path string) (lifecycleFileMetadata, error) {
	data, err := readRegularFile(path)
	if err != nil {
		return lifecycleFileMetadata{}, err
	}
	var metadata lifecycleFileMetadata
	if err := json.Unmarshal(data, &metadata); err != nil || metadata.Mode > 0o777 {
		return lifecycleFileMetadata{}, errors.New("lifecycle file metadata is invalid")
	}
	return metadata, nil
}

func (store *DiskLifecycleFileStore) install(target string, data []byte, mode os.FileMode, uid, gid uint32) error {
	resolved := store.resolve(target)
	if err := writeAtomicFile(resolved, data, mode); err != nil {
		return err
	}
	if store.rootPrefix == "" {
		if err := os.Chown(resolved, int(uid), int(gid)); err != nil {
			return err
		}
	}
	return os.Chmod(resolved, mode)
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
