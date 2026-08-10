package bootstrap

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/model"
	"fased-lifecycled/platform"
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

func TestProtectedLocalBootstrapRejectsNoncanonicalOwnerStateBeforeMutation(t *testing.T) {
	request := PlatformBootstrapRequest{Profile: model.ProfileProtectedLocal, OwnerStateRoot: "/home/owner/custom"}
	operator := platform.AccountRecord{Name: "owner", UID: 1000, GID: 1000, Home: "/home/owner"}
	if err := validateBootstrapOperator(request, operator, true, nil); err == nil {
		t.Fatal("protected Local bootstrap accepted an owner state root not covered by the global fence")
	}
}
