package platform

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"syscall"
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
	command := exec.CommandContext(ctx, systemd.Binary, append([]string{"--user"}, arguments...)...)
	runtime := "/run/user/" + strconv.FormatUint(uint64(systemd.Principal.UID), 10)
	command.Env = []string{"HOME=" + systemd.Home, "PATH=/usr/bin:/bin", "XDG_RUNTIME_DIR=" + runtime, "DBUS_SESSION_BUS_ADDRESS=unix:path=" + runtime + "/bus"}
	command.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: systemd.Principal.UID, Gid: systemd.Principal.GID, NoSetGroups: true}}
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
