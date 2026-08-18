package custody

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// ZeroBytes clears buf in place.
func ZeroBytes(buf []byte) {
	for index := range buf {
		buf[index] = 0
	}
}

// LoadOrCreateMasterKey loads the signer master key at path, or creates it securely.
func LoadOrCreateMasterKey(path string) ([]byte, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("signer master key path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create signer key directory: %w", err)
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return nil, errors.New("signer master key must be a regular non-symlink file")
		}
		if info.Mode().Perm()&0o077 != 0 {
			return nil, errors.New("signer master key must not be group/world accessible")
		}
		if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
			return nil, fmt.Errorf("signer master key must be owned by uid %d", os.Geteuid())
		}
		key, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read signer master key: %w", err)
		}
		if len(key) != 32 {
			ZeroBytes(key)
			return nil, errors.New("signer master key has invalid length")
		}
		return key, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect signer master key: %w", err)
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate signer master key: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		ZeroBytes(key)
		return nil, fmt.Errorf("create signer master key: %w", err)
	}
	writeErr := error(nil)
	if _, err := file.Write(key); err != nil {
		writeErr = err
	} else if err := file.Sync(); err != nil {
		writeErr = err
	}
	if err := file.Close(); writeErr == nil && err != nil {
		writeErr = err
	}
	if writeErr != nil {
		ZeroBytes(key)
		_ = os.Remove(path)
		return nil, fmt.Errorf("persist signer master key: %w", writeErr)
	}
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return key, nil
}
