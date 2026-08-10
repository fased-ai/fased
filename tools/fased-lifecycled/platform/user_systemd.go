package platform

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
)

type CommandUserSystemd struct {
	Binary    string
	Principal Principal
	Home      string
}

func (systemd CommandUserSystemd) command(ctx context.Context, arguments ...string) (*exec.Cmd, error) {
	if systemd.Binary != "/usr/bin/systemctl" && systemd.Binary != "/bin/systemctl" {
		return nil, errors.New("user systemd binary must use a fixed system path")
	}
	if systemd.Principal.UID == 0 || systemd.Principal.GID == 0 || systemd.Home == "" {
		return nil, errors.New("user systemd principal is unsafe")
	}
	// The target controller deliberately runs with NoNewPrivileges. Asking the
	// child process to change credentials therefore fails under the hardened
	// unit. Let PID 1 connect to the exact local user manager instead; the
	// numeric UID avoids mutable account-name authority.
	machine := strconv.FormatUint(uint64(systemd.Principal.UID), 10) + "@.host"
	command := exec.CommandContext(ctx, systemd.Binary, append([]string{"--user", "--machine=" + machine}, arguments...)...)
	command.Env = []string{"PATH=/usr/bin:/bin"}
	return command, nil
}

func (systemd CommandUserSystemd) run(ctx context.Context, arguments ...string) error {
	command, err := systemd.command(ctx, arguments...)
	if err != nil {
		return err
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("user systemctl %s failed: %w: %s", arguments[0], err, output)
	}
	return nil
}

func (systemd CommandUserSystemd) IsActive(ctx context.Context, unit string) (bool, error) {
	command, err := systemd.command(ctx, "is-active", "--quiet", unit)
	if err != nil {
		return false, err
	}
	output, err := command.CombinedOutput()
	if err == nil {
		return true, nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && (exit.ExitCode() == 3 || exit.ExitCode() == 4) {
		return false, nil
	}
	return false, fmt.Errorf("user systemctl is-active failed: %w: %s", err, output)
}

func (systemd CommandUserSystemd) Stop(ctx context.Context, unit string) error {
	return systemd.run(ctx, "stop", unit)
}

func (systemd CommandUserSystemd) Start(ctx context.Context, unit string) error {
	return systemd.run(ctx, "start", unit)
}
