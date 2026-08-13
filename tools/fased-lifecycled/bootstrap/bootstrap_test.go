package bootstrap

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

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

func TestBootstrapRollbackUsesFreshBoundedContext(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	cancelParent()
	if parent.Err() == nil {
		t.Fatal("test parent context did not cancel")
	}
	called := false
	if err := withBootstrapRollbackContext(func(ctx context.Context) error {
		called = true
		if ctx.Err() != nil {
			t.Fatalf("rollback inherited an expired apply context: %v", ctx.Err())
		}
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > bootstrapRollbackTimeout {
			t.Fatalf("rollback context is not independently bounded: deadline=%v ok=%v", deadline, ok)
		}
		return nil
	}); err != nil || !called {
		t.Fatalf("fresh rollback context failed: called=%v err=%v", called, err)
	}
}
