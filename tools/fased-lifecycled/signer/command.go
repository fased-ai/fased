package signer

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strconv"

	"fased-lifecycled/platform"
)

const defaultSystemdRun = "/usr/bin/systemd-run"

func signerCommand(ctx context.Context, systemdRun, binary string, principal platform.Principal, writableRoot string, arguments ...string) (*exec.Cmd, error) {
	if systemdRun == "" {
		systemdRun = defaultSystemdRun
	}
	if systemdRun != "/usr/bin/systemd-run" && systemdRun != "/bin/systemd-run" {
		return nil, errors.New("signer command runner must use a fixed system path")
	}
	if principal.UID == 0 || principal.GID == 0 {
		return nil, errors.New("signer command principal is unsafe")
	}
	if err := requireExecutable(binary); err != nil {
		return nil, err
	}
	if writableRoot != "" && (!filepath.IsAbs(writableRoot) || filepath.Clean(writableRoot) != writableRoot) {
		return nil, errors.New("signer writable root must be absolute and clean")
	}

	runArguments := []string{
		"--quiet",
		"--wait",
		"--pipe",
		"--collect",
		"--service-type=exec",
		"--uid=" + strconv.FormatUint(uint64(principal.UID), 10),
		"--gid=" + strconv.FormatUint(uint64(principal.GID), 10),
		"--property=NoNewPrivileges=yes",
		"--property=PrivateTmp=yes",
		"--property=PrivateDevices=yes",
		"--property=ProtectSystem=strict",
		"--property=ProtectHome=yes",
		"--property=RestrictAddressFamilies=AF_UNIX",
		"--property=CapabilityBoundingSet=",
	}
	if writableRoot != "" {
		runArguments = append(runArguments, "--property=ReadWritePaths="+writableRoot)
	}
	runArguments = append(runArguments, "--", binary)
	runArguments = append(runArguments, arguments...)
	command := exec.CommandContext(ctx, systemdRun, runArguments...)
	command.Env = []string{"PATH=/usr/bin:/bin"}
	return command, nil
}
