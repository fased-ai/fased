package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplicationUpdateGateBlocksMutationsButAllowsHealth(t *testing.T) {
	gatePath := filepath.Join(t.TempDir(), "active")
	if err := os.WriteFile(gatePath, []byte("paired-update\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	trustedUID := os.Geteuid()
	trustedGID := os.Getegid()
	for _, operation := range []string{"health", "v2.capabilities", "v2.policy.get", "v2.review.get", "v2.operation.get", "v2.satLookup.binding.get", "v2.satCommitment.binding.get", "v2.keeperFeePayer.get", "v2.wallet.rotation.status", "v2.jupiter.trigger.history", "getBalance"} {
		if err := enforceApplicationUpdateGate(gatePath, operation, false, trustedUID, trustedGID); err != nil {
			t.Fatalf("read operation %s was blocked: %v", operation, err)
		}
	}
	for _, operation := range []string{"v2.wallet.create", "v2.wallet.rotation.create", "v2.wallet.rotation.commit", "v2.webauthn.credentials.revoke", "v2.policy.tighten", "v2.review.prepare", "v2.review.execute", "v2.execute", "v2.operation.reconcile", "v2.satCommitment.allocate", "v2.keeperFeePayer.ensure"} {
		err := enforceApplicationUpdateGate(gatePath, operation, false, trustedUID, trustedGID)
		if err == nil || !strings.Contains(err.Error(), "temporarily disabled") {
			t.Fatalf("mutation %s was not blocked by the update gate: %v", operation, err)
		}
	}
	if err := enforceApplicationUpdateGate(gatePath, "v2.wallet.import", true, trustedUID, trustedGID); err == nil || !strings.Contains(err.Error(), "control mutations") {
		t.Fatalf("control mutation was not blocked during the rollback window: %v", err)
	}
	if err := enforceApplicationUpdateGate(gatePath, "v2.policy.get", true, trustedUID, trustedGID); err != nil {
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
	err := enforceApplicationUpdateGate(gatePath, "v2.execute", false, os.Geteuid(), os.Getegid())
	if err == nil || !strings.Contains(err.Error(), "gate is invalid") {
		t.Fatalf("untrusted gate did not fail closed: %v", err)
	}
	if err := os.Remove(gatePath); err != nil {
		t.Fatal(err)
	}
	if err := enforceApplicationUpdateGate(gatePath, "v2.execute", false, os.Geteuid(), os.Getegid()); err != nil {
		t.Fatalf("absent gate should allow normal policy enforcement: %v", err)
	}
}

func TestSignerLifecycleUpgradeRequiresControlSocketAndActiveTrustedGate(t *testing.T) {
	gatePath := filepath.Join(t.TempDir(), "active")
	operation := "v2.lifecycle.upgrade.prepare"
	if err := enforceApplicationUpdateGate(gatePath, operation, true, os.Geteuid(), os.Getegid()); err == nil || !strings.Contains(err.Error(), "requires an active") {
		t.Fatalf("lifecycle operation ran without active gate: %v", err)
	}
	if err := os.WriteFile(gatePath, []byte("paired-update\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := enforceApplicationUpdateGate(gatePath, operation, false, os.Geteuid(), os.Getegid()); err == nil || !strings.Contains(err.Error(), "control socket") {
		t.Fatalf("lifecycle operation ran outside control socket: %v", err)
	}
	if err := enforceApplicationUpdateGate(gatePath, operation, true, os.Geteuid(), os.Getegid()); err != nil {
		t.Fatalf("trusted lifecycle operation was blocked: %v", err)
	}
}

func TestSignerLifecycleMigrationCrossesActiveGateOnlyOnControlSocket(t *testing.T) {
	gatePath := filepath.Join(t.TempDir(), "active")
	operations := []string{"v2.wallet.importLegacy", "v2.network.put"}
	for _, operation := range operations {
		if err := enforceApplicationUpdateGate(gatePath, operation, true, os.Geteuid(), os.Getegid()); err != nil {
			t.Fatalf("explicit control migration %s was blocked without an active update: %v", operation, err)
		}
	}
	if err := os.WriteFile(gatePath, []byte("paired-update\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	for _, operation := range operations {
		if err := enforceApplicationUpdateGate(gatePath, operation, false, os.Geteuid(), os.Getegid()); err == nil || !strings.Contains(err.Error(), "control socket") {
			t.Fatalf("lifecycle migration %s crossed the active gate outside the control socket: %v", operation, err)
		}
		if err := enforceApplicationUpdateGate(gatePath, operation, true, os.Geteuid(), os.Getegid()); err != nil {
			t.Fatalf("trusted control-socket lifecycle migration %s was blocked: %v", operation, err)
		}
	}
}
