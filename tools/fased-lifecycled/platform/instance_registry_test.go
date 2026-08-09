package platform

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func localRegistryFixture(t *testing.T) (string, LocalInstanceRequest) {
	t.Helper()
	root := t.TempDir()
	registry := filepath.Join(root, "registry", "instances.json")
	state := filepath.Join(root, "owner", ".fased")
	if err := os.MkdirAll(state, 0o700); err != nil {
		t.Fatal(err)
	}
	return registry, LocalInstanceRequest{
		TransactionID: "018f47d2-5a6b-7c8d-9e0f-123456789abc",
		OperatorUID:   uint32(os.Getuid()), OperatorUser: "owner", Profile: "default", StateDir: state,
	}
}

func TestLocalInstanceAllocationIsTransactionalAndIdempotent(t *testing.T) {
	registry, request := localRegistryFixture(t)
	allocation, err := PlanLocalInstance(registry, uint32(os.Getuid()), request, bytes.NewReader([]byte("12345678")), time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	if allocation.Entry.InstanceID != "3132333435363738" || !allocation.Created || allocation.Committed {
		t.Fatalf("unexpected Local allocation: %+v", allocation)
	}
	if _, err := os.Stat(registry); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("planning mutated the Local registry: %v", err)
	}
	if err := CommitLocalInstance(registry, uint32(os.Getuid()), &allocation); err != nil {
		t.Fatal(err)
	}
	reused, err := PlanLocalInstance(registry, uint32(os.Getuid()), request, nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if reused.Created || !reused.Committed || reused.Entry != allocation.Entry {
		t.Fatalf("same Local boundary allocated a second instance: %+v", reused)
	}
	if err := RollbackLocalInstance(registry, uint32(os.Getuid()), &allocation); err != nil {
		t.Fatal(err)
	}
	decoded, _, err := readLocalInstanceRegistry(registry, uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	if len(decoded.Instances) != 0 {
		t.Fatalf("rollback retained new Local allocation: %+v", decoded.Instances)
	}
}

func TestLocalInstanceCommitUsesCompareAndSwap(t *testing.T) {
	registry, request := localRegistryFixture(t)
	first, err := PlanLocalInstance(registry, uint32(os.Getuid()), request, bytes.NewReader([]byte("12345678")), time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	secondRequest := request
	secondRequest.StateDir = filepath.Join(filepath.Dir(request.StateDir), "second")
	if err := os.MkdirAll(secondRequest.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	second, err := PlanLocalInstance(registry, uint32(os.Getuid()), secondRequest, bytes.NewReader([]byte("abcdefgh")), time.Unix(101, 0))
	if err != nil {
		t.Fatal(err)
	}
	if err := CommitLocalInstance(registry, uint32(os.Getuid()), &first); err != nil {
		t.Fatal(err)
	}
	if err := CommitLocalInstance(registry, uint32(os.Getuid()), &second); err == nil {
		t.Fatal("stale Local registry allocation committed")
	}
}

func TestUnknownNewerLocalRegistryFailsBeforeMutation(t *testing.T) {
	registry, request := localRegistryFixture(t)
	if err := os.MkdirAll(filepath.Dir(registry), 0o700); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{"schemaVersion": 2, "instances": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(registry, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(registry)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := PlanLocalInstance(registry, uint32(os.Getuid()), request, bytes.NewReader([]byte("12345678")), time.Now()); err == nil {
		t.Fatal("unknown-newer Local registry was accepted")
	}
	after, err := os.ReadFile(registry)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("unknown-newer Local registry was mutated")
	}
}
