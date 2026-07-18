package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSignerAdminJupiterAPIKeyLifecycleUsesOnlyPrivateAtomicFileAndStdin(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "jupiter-trigger-api.key")
	firstKey := "jupiter-first-private-key"
	secondKey := "jupiter-second-private-key"

	var output bytes.Buffer
	if err := runSignerAdminCLI(
		[]string{"jupiter", "api-key-install", "--output", path},
		strings.NewReader(firstKey+"\n"),
		&output,
		[]string{"FASED_WALLET_JUPITER_API_KEY_FILE=" + path},
	); err != nil {
		t.Fatalf("install signer-owned Jupiter API key: %v", err)
	}
	if strings.Contains(output.String(), firstKey) {
		t.Fatal("Jupiter API key was printed to stdout")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("installed Jupiter API key is not a private regular file: info=%#v err=%v", info, err)
	}
	key, err := readSignerJupiterAPIKeyFileV2(path)
	if err != nil || string(key) != firstKey {
		t.Fatalf("read installed Jupiter API key: key=%q err=%v", key, err)
	}
	zeroBytes(key)

	output.Reset()
	if err := runSignerAdminCLI(
		[]string{"jupiter", "api-key-install", "--output", path},
		strings.NewReader(secondKey),
		&output,
		nil,
	); err != nil {
		t.Fatalf("atomically replace signer-owned Jupiter API key: %v", err)
	}
	key, err = readSignerJupiterAPIKeyFileV2(path)
	if err != nil || string(key) != secondKey {
		t.Fatalf("read replaced Jupiter API key: key=%q err=%v", key, err)
	}
	zeroBytes(key)
	matches, err := filepath.Glob(filepath.Join(directory, ".jupiter-api-key-*.tmp"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("Jupiter API key staging file remained: matches=%v err=%v", matches, err)
	}

	output.Reset()
	if err := runSignerAdminCLI(
		[]string{"jupiter", "api-key-status", "--output", path},
		strings.NewReader("ignored"),
		&output,
		nil,
	); err != nil {
		t.Fatalf("inspect signer-owned Jupiter API key: %v", err)
	}
	if !strings.Contains(output.String(), "is configured") || strings.Contains(output.String(), secondKey) {
		t.Fatalf("Jupiter API key status was not sanitized: %q", output.String())
	}

	output.Reset()
	if err := runSignerAdminCLI(
		[]string{"jupiter", "api-key-remove", "--output", path},
		strings.NewReader("ignored"),
		&output,
		nil,
	); err != nil {
		t.Fatalf("remove signer-owned Jupiter API key: %v", err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("Jupiter API key remained after removal: %v", err)
	}
	output.Reset()
	if err := runSignerAdminCLI(
		[]string{"jupiter", "api-key-status", "--output", path},
		strings.NewReader("ignored"),
		&output,
		nil,
	); err != nil || !strings.Contains(output.String(), "is not configured") {
		t.Fatalf("missing Jupiter API key status failed closed: output=%q err=%v", output.String(), err)
	}
}

func TestSignerAdminJupiterAPIKeyRejectsArgumentsEnvironmentAndUnsafeFiles(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "jupiter-trigger-api.key")
	for name, testCase := range map[string]struct {
		args    []string
		environ []string
		input   string
	}{
		"argument secret": {
			args:  []string{"jupiter", "api-key-install", "--api-key=secret", "--output", path},
			input: "safe-api-key",
		},
		"Fased environment secret": {
			args:    []string{"jupiter", "api-key-install", "--output", path},
			environ: []string{"FASED_JUPITER_API_KEY=secret"},
			input:   "safe-api-key",
		},
		"generic environment secret": {
			args:    []string{"jupiter", "api-key-install", "--output", path},
			environ: []string{"JUPITER_API_KEY=secret"},
			input:   "safe-api-key",
		},
		"multiline secret": {
			args:  []string{"jupiter", "api-key-install", "--output", path},
			input: "first-line\nsecond-line",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := runSignerAdminCLI(
				testCase.args,
				strings.NewReader(testCase.input),
				&bytes.Buffer{},
				testCase.environ,
			); err == nil {
				t.Fatal("unsafe Jupiter API key input was accepted")
			}
		})
	}

	target := filepath.Join(directory, "target")
	if err := os.WriteFile(target, []byte("existing-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(directory, "symlink-key")
	if err := os.Symlink(target, symlink); err != nil {
		t.Fatal(err)
	}
	if err := runSignerAdminCLI(
		[]string{"jupiter", "api-key-install", "--output", symlink},
		strings.NewReader("safe-api-key"),
		&bytes.Buffer{},
		nil,
	); err == nil {
		t.Fatal("Jupiter API key installer replaced a symlink")
	}
	contents, err := os.ReadFile(target)
	if err != nil || string(contents) != "existing-secret" {
		t.Fatalf("Jupiter API key symlink target changed: contents=%q err=%v", contents, err)
	}

	public := filepath.Join(directory, "public-key")
	if err := os.WriteFile(public, []byte("existing-public-key"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := runSignerAdminCLI(
		[]string{"jupiter", "api-key-install", "--output", public},
		strings.NewReader("safe-api-key"),
		&bytes.Buffer{},
		nil,
	); err == nil {
		t.Fatal("Jupiter API key installer replaced a public file")
	}
}
