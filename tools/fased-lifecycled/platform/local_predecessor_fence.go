package platform

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"syscall"

	"fased-lifecycled/model"
)

const LocalPredecessorDropInPath = "/etc/systemd/user/fased-gateway.service.d/90-fased-protected-local.conf"

var localPredecessorDropIn = []byte("[Unit]\nConditionPathExists=!%h/.fased/lifecycle.json\n")

type LocalPredecessorFence interface {
	Ensure(Config) error
	Verify(Config) error
}

type DiskLocalPredecessorFence struct{}

func (DiskLocalPredecessorFence) Ensure(config Config) error {
	if err := validateLocalPredecessorFenceConfig(config); err != nil {
		return err
	}
	return ensureLocalPredecessorFenceAt("/etc/systemd/user", 0)
}

func (DiskLocalPredecessorFence) Verify(config Config) error {
	if err := validateLocalPredecessorFenceConfig(config); err != nil {
		return err
	}
	return verifyLocalPredecessorFenceAt("/etc/systemd/user", 0)
}

type NoLocalPredecessorFence struct{}

func (NoLocalPredecessorFence) Ensure(Config) error { return nil }
func (NoLocalPredecessorFence) Verify(Config) error { return nil }

func validateLocalPredecessorFenceConfig(config Config) error {
	if config.Profile != model.ProfileProtectedLocal || filepath.Base(config.OwnerStateRoot) != ".fased" || config.OwnerStateRoot != filepath.Join(config.OwnerHome(), ".fased") {
		return errors.New("Local predecessor fence is not bound to the canonical owner state root")
	}
	return nil
}

// ensureLocalPredecessorFenceAt establishes one monotonic global invariant.
// It never removes or restores the fence: an owner-specific rollback must not
// be able to make another protected Local installation's legacy unit runnable.
func ensureLocalPredecessorFenceAt(userUnitRoot string, expectedUID uint32) error {
	if !filepath.IsAbs(userUnitRoot) || filepath.Clean(userUnitRoot) != userUnitRoot || userUnitRoot == "/" {
		return errors.New("Local predecessor user-unit root is unsafe")
	}
	rootInfo, err := os.Lstat(userUnitRoot)
	if err != nil {
		return err
	}
	if err := validateFenceDirectoryInfo(rootInfo, expectedUID); err != nil {
		return err
	}
	root, err := os.OpenRoot(userUnitRoot)
	if err != nil {
		return err
	}
	defer root.Close()
	openedRootInfo, err := root.Stat(".")
	if err != nil || !os.SameFile(rootInfo, openedRootInfo) || validateFenceDirectoryInfo(openedRootInfo, expectedUID) != nil {
		return errors.New("Local predecessor user-unit root changed during installation")
	}
	createdDirectory := false
	if err := root.Mkdir("fased-gateway.service.d", 0o755); err == nil {
		createdDirectory = true
	} else if !errors.Is(err, os.ErrExist) {
		return err
	}
	directoryInfo, err := root.Lstat("fased-gateway.service.d")
	if err != nil {
		return errors.New("Local predecessor drop-in directory is unsafe")
	}
	if !createdDirectory && validateFenceDirectoryInfo(directoryInfo, expectedUID) != nil {
		return errors.New("Local predecessor drop-in directory is unsafe")
	}
	dropInRoot, err := root.OpenRoot("fased-gateway.service.d")
	if err != nil {
		return err
	}
	defer dropInRoot.Close()
	if createdDirectory {
		directoryHandle, err := dropInRoot.Open(".")
		if err != nil {
			return err
		}
		if err := directoryHandle.Chmod(0o755); err != nil {
			_ = directoryHandle.Close()
			return err
		}
		if err := directoryHandle.Sync(); err != nil {
			_ = directoryHandle.Close()
			return err
		}
		if err := directoryHandle.Close(); err != nil {
			return err
		}
		if err := syncRoot(root); err != nil {
			return err
		}
	}
	openedDirectoryInfo, err := dropInRoot.Stat(".")
	if err != nil || !os.SameFile(directoryInfo, openedDirectoryInfo) || validateFenceDirectoryInfo(openedDirectoryInfo, expectedUID) != nil || openedDirectoryInfo.Mode().Perm() != 0o755 {
		return errors.New("Local predecessor drop-in directory changed during installation")
	}
	name := filepath.Base(LocalPredecessorDropInPath)
	if err := validateExistingFenceInRoot(dropInRoot, name, expectedUID); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return installLocalPredecessorFenceInRoot(dropInRoot, name, expectedUID)
}

func installLocalPredecessorFenceInRoot(root *os.Root, name string, expectedUID uint32) error {
	nonce := make([]byte, 8)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	temporary := "." + name + ".tmp-" + hex.EncodeToString(nonce)
	file, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = root.Remove(temporary)
		}
	}()
	if err := file.Chown(int(expectedUID), int(expectedUID)); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Chmod(0o644); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.Write(localPredecessorDropIn); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := root.Link(temporary, name); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		if err := validateExistingFenceInRoot(root, name, expectedUID); err != nil {
			return err
		}
	}
	if err := root.Remove(temporary); err != nil {
		return err
	}
	removeTemporary = false
	if err := syncRoot(root); err != nil {
		return err
	}
	return validateExistingFenceInRoot(root, name, expectedUID)
}

func syncRoot(root *os.Root) error {
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	if err := directory.Sync(); err != nil {
		_ = directory.Close()
		return err
	}
	return directory.Close()
}

func verifyLocalPredecessorFenceAt(userUnitRoot string, expectedUID uint32) error {
	if !filepath.IsAbs(userUnitRoot) || filepath.Clean(userUnitRoot) != userUnitRoot || userUnitRoot == "/" {
		return errors.New("Local predecessor user-unit root is unsafe")
	}
	if err := validateFenceDirectory(userUnitRoot, expectedUID); err != nil {
		return err
	}
	directory := filepath.Join(userUnitRoot, "fased-gateway.service.d")
	if err := validateFenceDirectory(directory, expectedUID); err != nil {
		return err
	}
	return validateExistingFence(filepath.Join(directory, filepath.Base(LocalPredecessorDropInPath)), expectedUID)
}

func validateFenceDirectory(path string, expectedUID uint32) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	return validateFenceDirectoryInfo(info, expectedUID)
}

func validateFenceDirectoryInfo(info os.FileInfo, expectedUID uint32) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != expectedUID || info.Mode().Perm()&0o022 != 0 || info.Mode().Perm()&0o555 != 0o555 {
		return errors.New("Local predecessor fence directory is unsafe")
	}
	return nil
}

func validateExistingFence(path string, expectedUID uint32) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o644 || stat.Uid != expectedUID || stat.Gid != expectedUID || stat.Nlink != 1 {
		return errors.New("existing Local predecessor fence is unsafe")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if !bytes.Equal(data, localPredecessorDropIn) {
		return errors.New("existing Local predecessor fence differs from the canonical policy")
	}
	return nil
}

func validateExistingFenceInRoot(root *os.Root, name string, expectedUID uint32) error {
	info, err := root.Lstat(name)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o644 || stat.Uid != expectedUID || stat.Gid != expectedUID || stat.Nlink != 1 {
		return errors.New("existing Local predecessor fence is unsafe")
	}
	data, err := root.ReadFile(name)
	if err != nil {
		return err
	}
	if !bytes.Equal(data, localPredecessorDropIn) {
		return errors.New("existing Local predecessor fence differs from the canonical policy")
	}
	return nil
}
