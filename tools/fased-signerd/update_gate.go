package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"
)

var applicationUpdateGateReadOperations = map[string]bool{
	"health":                       true,
	"v2.capabilities":              true,
	"v2.network.get":               true,
	"v2.policy.get":                true,
	"v2.wallet.get":                true,
	"v2.wallet.readiness":          true,
	"v2.wallet.rotation.status":    true,
	"v2.operation.get":             true,
	"v2.satLookup.binding.get":     true,
	"v2.satCommitment.binding.get": true,
	"v2.review.get":                true,
	"v2.webauthn.credentials.list": true,
	"v2.jupiter.trigger.history":   true,
	"getAddresses":                 true,
	"getBalance":                   true,
}

var signerLifecycleUpdateOperationsV1 = map[string]bool{
	"v2.lifecycle.upgrade.prepare": true,
	"v2.lifecycle.upgrade.verify":  true,
	"v2.lifecycle.upgrade.commit":  true,
	"v2.lifecycle.upgrade.abort":   true,
}

// These mutations are part of a lifecycle-owned custody migration, but they
// also remain available to an explicit control-socket administrator when no
// paired update is active. During an update they may cross the gate only on
// the signer-only control socket; application and operator sockets stay
// blocked.
var signerLifecycleMigrationOperationsV1 = map[string]bool{
	"v2.wallet.importLegacy": true,
	"v2.network.put":         true,
}

func enforceApplicationUpdateGate(gatePath, operation string, control bool, trustedUID, trustedGID int) error {
	if signerLifecycleUpdateOperationsV1[operation] {
		if !control {
			return errors.New("signer lifecycle upgrade requires the control socket")
		}
		active, err := trustedUpdateGateActive(gatePath, trustedUID, trustedGID)
		if err != nil {
			return fmt.Errorf("signer update gate is invalid; refusing lifecycle operation: %w", err)
		}
		if !active {
			return errors.New("signer lifecycle upgrade requires an active trusted update gate")
		}
		return nil
	}
	if strings.TrimSpace(gatePath) == "" || applicationUpdateGateReadOperations[operation] {
		return nil
	}
	active, err := trustedUpdateGateActive(gatePath, trustedUID, trustedGID)
	if err != nil {
		return fmt.Errorf("signer update gate is invalid; refusing mutation: %w", err)
	}
	if active && signerLifecycleMigrationOperationsV1[operation] {
		if !control {
			return errors.New("signer lifecycle migration requires the control socket")
		}
		return nil
	}
	if active {
		socketKind := "application"
		if control {
			socketKind = "control"
		}
		return fmt.Errorf("signer update is awaiting a durable app and signer decision; %s mutations are temporarily disabled", socketKind)
	}
	return nil
}

func trustedUpdateGateActive(gatePath string, trustedUID, trustedGID int) (bool, error) {
	info, err := os.Lstat(gatePath)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o640 {
		return false, errors.New("gate must be a regular file with exact mode 0640")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 {
		return false, errors.New("gate must have exactly one filesystem link")
	}
	if int(stat.Uid) != trustedUID || int(stat.Gid) != trustedGID {
		return false, fmt.Errorf("gate must be owned by uid %d and gid %d", trustedUID, trustedGID)
	}
	return true, nil
}
