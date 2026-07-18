package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const maxSignerAdminJupiterAPIKeyBytesV2 = 4096

func runSignerAdminJupiterAPIKeyInstallV2(args []string, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("fased-signerd admin jupiter api-key-install", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	output := fs.String("output", "", "absolute signer-owned Jupiter API key path")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	path, err := validateSignerAdminJupiterAPIKeyPathV2(*output, false)
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(stdin, maxSignerAdminJupiterAPIKeyBytesV2+2))
	if err != nil {
		return errors.New("read Jupiter API key from stdin")
	}
	defer zeroBytes(raw)
	key, err := normalizeSignerJupiterAPIKeyV2(raw)
	if err != nil {
		return err
	}
	defer zeroBytes(key)
	if err := writeSignerAdminJupiterAPIKeyAtomicV2(path, key); err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "Jupiter Trigger API key installed at %s; restart fased-signerd to activate it.\n", path)
	return err
}

func runSignerAdminJupiterAPIKeyStatusV2(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("fased-signerd admin jupiter api-key-status", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	output := fs.String("output", "", "absolute signer-owned Jupiter API key path")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	path, err := validateSignerAdminJupiterAPIKeyPathV2(*output, true)
	if errors.Is(err, os.ErrNotExist) {
		_, writeErr := fmt.Fprintf(stdout, "Jupiter Trigger API key is not configured at %s.\n", filepath.Clean(*output))
		return writeErr
	}
	if err != nil {
		return err
	}
	key, err := readSignerJupiterAPIKeyFileV2(path)
	if err != nil {
		return err
	}
	zeroBytes(key)
	_, err = fmt.Fprintf(stdout, "Jupiter Trigger API key is configured at %s.\n", path)
	return err
}

func runSignerAdminJupiterAPIKeyRemoveV2(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("fased-signerd admin jupiter api-key-remove", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	output := fs.String("output", "", "absolute signer-owned Jupiter API key path")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	path, err := validateSignerAdminJupiterAPIKeyPathV2(*output, false)
	if err != nil {
		return err
	}
	key, err := readSignerJupiterAPIKeyFileV2(path)
	if err != nil {
		return err
	}
	zeroBytes(key)
	if err := os.Remove(path); err != nil {
		return errors.New("remove signer-owned Jupiter API key file")
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return errors.New("open Jupiter API key directory for fsync")
	}
	syncErr := directory.Sync()
	closeErr := directory.Close()
	if syncErr != nil || closeErr != nil {
		return errors.New("fsync Jupiter API key directory")
	}
	_, err = fmt.Fprintf(stdout, "Jupiter Trigger API key removed from %s; restart fased-signerd to deactivate any in-memory client.\n", path)
	return err
}

func validateSignerAdminJupiterAPIKeyPathV2(raw string, allowMissing bool) (string, error) {
	path := strings.TrimSpace(raw)
	if path == "" {
		return "", errors.New("--output is required")
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || filepath.Base(path) == "." {
		return "", errors.New("Jupiter API key output path must be absolute and clean")
	}
	directoryPath := filepath.Dir(path)
	directory, err := os.Lstat(directoryPath)
	if err != nil {
		return "", errors.New("inspect Jupiter API key directory")
	}
	if directory.Mode()&os.ModeSymlink != 0 || !directory.IsDir() || directory.Mode().Perm()&0o022 != 0 {
		return "", errors.New("Jupiter API key directory must be a non-symlink directory that is not group/world writable")
	}
	if stat, ok := directory.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return "", fmt.Errorf("Jupiter API key directory must be owned by uid %d", os.Geteuid())
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		if allowMissing {
			return path, os.ErrNotExist
		}
		return path, nil
	}
	if err != nil {
		return "", errors.New("inspect existing Jupiter API key file")
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("existing Jupiter API key path must be a private regular non-symlink file")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return "", fmt.Errorf("existing Jupiter API key file must be owned by uid %d", os.Geteuid())
	}
	return path, nil
}

func writeSignerAdminJupiterAPIKeyAtomicV2(path string, key []byte) error {
	directoryPath := filepath.Dir(path)
	for attempt := 0; attempt < 8; attempt++ {
		random := make([]byte, 16)
		if _, err := rand.Read(random); err != nil {
			return errors.New("generate Jupiter API key staging name")
		}
		temporary := filepath.Join(directoryPath, ".jupiter-api-key-"+hex.EncodeToString(random)+".tmp")
		zeroBytes(random)
		file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return errors.New("create staged Jupiter API key file")
		}
		cleanup := func() {
			_ = file.Close()
			_ = os.Remove(temporary)
		}
		payload := make([]byte, len(key)+1)
		copy(payload, key)
		payload[len(payload)-1] = '\n'
		_, writeErr := file.Write(payload)
		zeroBytes(payload)
		if writeErr != nil {
			cleanup()
			return errors.New("write staged Jupiter API key file")
		}
		if err := file.Sync(); err != nil {
			cleanup()
			return errors.New("fsync staged Jupiter API key file")
		}
		if err := file.Close(); err != nil {
			_ = os.Remove(temporary)
			return errors.New("close staged Jupiter API key file")
		}
		if err := os.Rename(temporary, path); err != nil {
			_ = os.Remove(temporary)
			return errors.New("atomically install Jupiter API key file")
		}
		directory, err := os.Open(directoryPath)
		if err != nil {
			return errors.New("open Jupiter API key directory for fsync")
		}
		syncErr := directory.Sync()
		closeErr := directory.Close()
		if syncErr != nil || closeErr != nil {
			return errors.New("fsync Jupiter API key directory")
		}
		return nil
	}
	return errors.New("could not allocate Jupiter API key staging file")
}
