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
	"v2.operation.get":             true,
	"v2.webauthn.credentials.list": true,
	"getAddresses":                 true,
	"getBalance":                   true,
}

func enforceApplicationUpdateGate(gatePath, operation string, control bool, trustedUID int) error {
	if control || strings.TrimSpace(gatePath) == "" || applicationUpdateGateReadOperations[operation] {
		return nil
	}
	active, err := trustedUpdateGateActive(gatePath, trustedUID)
	if err != nil {
		return fmt.Errorf("signer update gate is invalid; refusing application mutation: %w", err)
	}
	if active {
		return errors.New("signer update is awaiting a durable app and signer decision; application mutations are temporarily disabled")
	}
	return nil
}

func trustedUpdateGateActive(gatePath string, trustedUID int) (bool, error) {
	info, err := os.Lstat(gatePath)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 {
		return false, errors.New("gate must be a regular file not writable by group or others")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 {
		return false, errors.New("gate must have exactly one filesystem link")
	}
	if int(stat.Uid) != trustedUID {
		return false, fmt.Errorf("gate must be owned by uid %d", trustedUID)
	}
	return true, nil
}
