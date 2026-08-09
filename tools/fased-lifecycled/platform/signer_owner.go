package platform

import (
	"fmt"
	"path/filepath"

	"fased-lifecycled/model"
)

func CanonicalSignerOwnerFiles(config Config) []string {
	return []string{
		filepath.Join(config.InstallRoot, "helpers", "fased-signer-owner"),
		filepath.Join(config.OwnerStateRoot, "bin", "fased-signer-owner"),
	}
}

func RenderSignerOwnerWrapper(config Config) ([]byte, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	paths := CanonicalSignerOwnerFiles(config)
	local := "0"
	if config.Profile == model.ProfileProtectedLocal {
		local = "1"
	}
	data := fmt.Sprintf(`#!/usr/bin/env bash
set -euo pipefail
export FASED_SIGNER_USER=%q
export FASED_SIGNER_HOME=%q
export FASED_SIGNER_BIN=%q
export FASED_SIGNER_CONTROL_SOCKET=%q
export FASED_SIGNER_OWNER_LOCK=%q
export FASED_SIGNER_UPDATE_GATE=%q
export FASED_SIGNER_UPDATE_JOURNAL=%q
export FASED_SIGNER_OWNER_LOCAL=%q
export FASED_SIGNER_OUTPUT_UID=%q
export FASED_SIGNER_OUTPUT_GID=%q
export FASED_SIGNER_OUTPUT_USER="$(id -nu "$FASED_SIGNER_OUTPUT_UID")"
exec %q "$@"
`, config.SignerUserName(), config.SignerStateRoot(), filepath.Join(config.InstallRoot, "current", "payload", "bin", "fased-signerd"),
		config.ControlSocket(), filepath.Join("/run/lock", filepath.Base(paths[1])+".lock"), config.UpdateGatePath(),
		filepath.Join(config.LifecycleRoot, "active-signer-transaction.json"), local,
		fmt.Sprint(config.Operator.UID), fmt.Sprint(config.Operator.GID), paths[0])
	return []byte(data), nil
}
