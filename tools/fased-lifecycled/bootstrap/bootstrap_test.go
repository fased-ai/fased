package bootstrap

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestUnknownNewerPlatformConfigFailsWithoutMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "platform.json")
	before := []byte(`{"schemaVersion":2,"profile":"protected-local"}`)
	if err := os.WriteFile(path, before, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readExistingPlatformConfig(path); err == nil {
		t.Fatal("unknown-newer platform configuration was accepted")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("unknown-newer platform configuration was mutated")
	}
}
