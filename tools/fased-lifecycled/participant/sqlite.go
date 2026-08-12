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
	_, ok := SQLiteFamilyMain(name)
	return ok
}

// SQLiteFamilyMain returns the main database name for a main, WAL, SHM, or
// rollback-journal member. Arbitrary files ending in -wal/-shm/-journal are
// not classified as SQLite.
func SQLiteFamilyMain(path string) (string, bool) {
	directory, name := filepath.Split(path)
	lower := strings.ToLower(name)
	for _, suffix := range []string{"-journal", "-wal", "-shm"} {
		if strings.HasSuffix(lower, suffix) {
			name = name[:len(name)-len(suffix)]
			lower = lower[:len(lower)-len(suffix)]
			break
		}
	}
	if !strings.HasSuffix(lower, ".sqlite") && !strings.HasSuffix(lower, ".db") {
		return "", false
	}
	return filepath.Join(directory, name), true
}

func ValidateSQLiteMain(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	header := make([]byte, 16)
	if _, err := io.ReadFull(file, header); err != nil || string(header) != "SQLite format 3\x00" {
		return errors.New("SQLite main database header is invalid")
	}
	return nil
}

func SnapshotRegularFile(source, destination string) (string, error) {
	return snapshotRegularFile(source, destination, "")
}

func snapshotRegularFile(source, destination, expectedDigest string) (string, error) {
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
	digest := fmt.Sprintf("sha256:%x", hash.Sum(nil))
	if expectedDigest != "" && digest != expectedDigest {
		return "", errors.New("state rollback snapshot digest changed")
	}
	if err := os.Rename(temporaryName, destination); err != nil {
		return "", err
	}
	if err := syncDirectory(filepath.Dir(destination)); err != nil {
		return "", err
	}
	return digest, nil
}

// SnapshotSQLiteFile remains the database-family copy primitive. The caller
// must group all members under SQLiteFamilyMain and validate the main database
// before taking any member snapshots.
func SnapshotSQLiteFile(source, destination string) (string, error) {
	return SnapshotRegularFile(source, destination)
}

func RestoreRegularFile(backup, destination, wantDigest string, mode os.FileMode) error {
	info, err := os.Lstat(backup)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || stat.Nlink != 1 || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("SQLite rollback snapshot identity is unsafe")
	}
	if _, err := snapshotRegularFile(backup, destination, wantDigest); err != nil {
		return err
	}
	return os.Chmod(destination, mode)
}

func DigestRegularFile(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("state file is unavailable")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) || linkCount(opened) != 1 {
		return "", errors.New("state file changed while opening")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	final, err := file.Stat()
	if err != nil || final.Size() != opened.Size() || final.ModTime() != opened.ModTime() {
		return "", errors.New("state file changed while hashing")
	}
	return fmt.Sprintf("sha256:%x", hash.Sum(nil)), nil
}

func RestoreSQLiteFile(backup, destination, wantDigest string, mode os.FileMode) error {
	return RestoreRegularFile(backup, destination, wantDigest, mode)
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
