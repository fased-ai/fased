package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"fased-lifecycled/trust"
)

func main() {
	if err := run(os.Args[1:], os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "fased-release-index:", err)
		os.Exit(1)
	}
}

func run(args []string, stderr io.Writer) error {
	flags := flag.NewFlagSet("fased-release-index", flag.ContinueOnError)
	flags.SetOutput(stderr)
	var input, keyPath, keyID, output string
	flags.StringVar(&input, "input", "", "unsigned release-index JSON")
	flags.StringVar(&keyPath, "private-key", "", "PKCS8 Ed25519 private-key PEM file")
	flags.StringVar(&keyID, "key-id", "", "delegated release key ID")
	flags.StringVar(&output, "output", "", "signed release-index envelope")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || input == "" || keyPath == "" || keyID == "" || output == "" {
		return errors.New("--input, --private-key, --key-id, and --output are required")
	}
	indexJSON, err := os.ReadFile(input)
	if err != nil {
		return err
	}
	index, err := trust.DecodeReleaseIndex(indexJSON)
	if err != nil {
		return fmt.Errorf("release index: %w", err)
	}
	privateKey, derivedID, err := readPrivateKey(keyPath)
	if err != nil {
		return err
	}
	if derivedID != keyID {
		return errors.New("delegated key ID does not match the private key")
	}
	signed, err := trust.SignReleaseIndex(index, trust.SigningKey{KeyID: keyID, PrivateKey: privateKey})
	if err != nil {
		return err
	}
	return writeAtomic(output, signed)
}

func readPrivateKey(path string) (ed25519.PrivateKey, string, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, "", err
	}
	if !before.Mode().IsRegular() || before.Mode().Perm()&0o077 != 0 {
		return nil, "", errors.New("private key must be a non-symlink regular file inaccessible to group and world")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, "", err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) || !after.Mode().IsRegular() || after.Mode().Perm()&0o077 != 0 {
		return nil, "", errors.New("private key changed identity or permissions while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, 16*1024+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) > 16*1024 {
		return nil, "", errors.New("private key exceeds its size limit")
	}
	final, err := file.Stat()
	if err != nil || !os.SameFile(after, final) || final.Size() != after.Size() || final.ModTime() != after.ModTime() {
		return nil, "", errors.New("private key changed while reading")
	}
	block, rest := pem.Decode(data)
	if block == nil || len(rest) != 0 || block.Type != "PRIVATE KEY" {
		return nil, "", errors.New("private key is not one canonical PKCS8 PEM block")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, "", err
	}
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, "", errors.New("private key is not Ed25519")
	}
	der, err := x509.MarshalPKIXPublicKey(privateKey.Public())
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(der)
	return privateKey, hex.EncodeToString(digest[:]), nil
}

func writeAtomic(path string, data []byte) error {
	directoryPath := filepath.Dir(path)
	temp, err := os.CreateTemp(directoryPath, ".release-index-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return err
	}
	directory, err := os.Open(directoryPath)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
