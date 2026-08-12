package participant

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func IsSQLiteFamilyName(name string) bool {
	lower := strings.ToLower(name)
	return strings.HasSuffix(lower, ".sqlite") || strings.HasSuffix(lower, ".db") || strings.HasSuffix(lower, "-wal") || strings.HasSuffix(lower, "-shm") || strings.HasSuffix(lower, "-journal") || strings.HasSuffix(lower, ".sqlite-wal") || strings.HasSuffix(lower, ".sqlite-shm") || strings.HasSuffix(lower, ".sqlite-journal")
}

func SnapshotSQLiteFile(source, destination string) (string, error) {
	before, err := os.Lstat(source)
	if err != nil || !before.Mode().IsRegular() {
		return "", errors.New("SQLite family member is unavailable")
	}
	input, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer input.Close()
	after, err := input.Stat()
	if err != nil || !os.SameFile(before, after) || linkCount(after) != 1 {
		return "", errors.New("SQLite family member changed while opening")
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".state-*")
	if err != nil {
		return "", err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(temporary, hash), input); err != nil {
		temporary.Close()
		return "", err
	}
	final, err := input.Stat()
	if err != nil || final.Size() != after.Size() || final.ModTime() != after.ModTime() {
		temporary.Close()
		return "", errors.New("SQLite family member changed during snapshot")
	}
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return "", err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return "", err
	}
	if err := temporary.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(temporaryName, destination); err != nil {
		return "", err
	}
	if err := syncDirectory(filepath.Dir(destination)); err != nil {
		return "", err
	}
	return fmt.Sprintf("sha256:%x", hash.Sum(nil)), nil
}

func RestoreSQLiteFile(backup, destination, wantDigest string, mode os.FileMode) error {
	info, err := os.Lstat(backup)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || stat.Nlink != 1 || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("SQLite rollback snapshot identity is unsafe")
	}
	digest, err := SnapshotSQLiteFile(backup, destination)
	if err != nil {
		return err
	}
	if digest != wantDigest {
		return errors.New("SQLite rollback snapshot digest changed")
	}
	return os.Chmod(destination, mode)
}

func RemoveUnexpectedSQLiteFile(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || stat.Nlink != 1 {
		return errors.New("unexpected SQLite rollback residue is unsafe")
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func ValidDigest(value string) bool {
	if !strings.HasPrefix(value, "sha256:") || len(value) != 71 {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil
}

func linkCount(info os.FileInfo) uint64 {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(stat.Nlink)
	}
	return 0
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
