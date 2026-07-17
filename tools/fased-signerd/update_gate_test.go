package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplicationUpdateGateBlocksMutationsButAllowsHealth(t *testing.T) {
	gatePath := filepath.Join(t.TempDir(), "active")
	if err := os.WriteFile(gatePath, []byte("paired-update\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	trustedUID := os.Geteuid()
	for _, operation := range []string{"health", "v2.capabilities", "v2.policy.get", "v2.review.get", "v2.operation.get", "getBalance"} {
		if err := enforceApplicationUpdateGate(gatePath, operation, false, trustedUID); err != nil {
			t.Fatalf("read operation %s was blocked: %v", operation, err)
		}
	}
	for _, operation := range []string{"v2.wallet.create", "v2.policy.tighten", "v2.review.prepare", "v2.review.execute", "v2.execute", "v2.operation.reconcile"} {
		err := enforceApplicationUpdateGate(gatePath, operation, false, trustedUID)
		if err == nil || !strings.Contains(err.Error(), "temporarily disabled") {
			t.Fatalf("mutation %s was not blocked by the update gate: %v", operation, err)
		}
	}
	if err := enforceApplicationUpdateGate(gatePath, "v2.wallet.import", true, trustedUID); err == nil || !strings.Contains(err.Error(), "control mutations") {
		t.Fatalf("control mutation was not blocked during the rollback window: %v", err)
	}
	if err := enforceApplicationUpdateGate(gatePath, "v2.policy.get", true, trustedUID); err != nil {
		t.Fatalf("control read was blocked during the rollback window: %v", err)
	}
}

func TestApplicationUpdateGateFailsClosedForUntrustedGateAndOpensOnlyWhenAbsent(t *testing.T) {
	directory := t.TempDir()
	gatePath := filepath.Join(directory, "active")
	if err := os.WriteFile(gatePath, []byte("invalid\n"), 0o666); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(gatePath, 0o666); err != nil {
		t.Fatal(err)
	}
	err := enforceApplicationUpdateGate(gatePath, "v2.execute", false, os.Geteuid())
	if err == nil || !strings.Contains(err.Error(), "gate is invalid") {
		t.Fatalf("untrusted gate did not fail closed: %v", err)
	}
	if err := os.Remove(gatePath); err != nil {
		t.Fatal(err)
	}
	if err := enforceApplicationUpdateGate(gatePath, "v2.execute", false, os.Geteuid()); err != nil {
		t.Fatalf("absent gate should allow normal policy enforcement: %v", err)
	}
}
