package platform

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
)

type Systemd interface {
	DaemonReload(context.Context) error
	Stop(context.Context, string) error
	Start(context.Context, string) error
	Enable(context.Context, string) error
	Disable(context.Context, string) error
	IsEnabled(context.Context, string) error
	IsActive(context.Context, string) error
}

type CommandSystemd struct {
	Binary string
}

func (systemd CommandSystemd) run(ctx context.Context, arguments ...string) error {
	if systemd.Binary != "/usr/bin/systemctl" && systemd.Binary != "/bin/systemctl" {
		return errors.New("systemd binary must use a fixed system path")
	}
	output, err := exec.CommandContext(ctx, systemd.Binary, arguments...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s failed: %w: %s", arguments[0], err, output)
	}
	return nil
}

func (systemd CommandSystemd) DaemonReload(ctx context.Context) error {
	return systemd.run(ctx, "daemon-reload")
}
func (systemd CommandSystemd) Stop(ctx context.Context, unit string) error {
	err := systemd.run(ctx, "stop", unit)
	if isSystemdUnitAbsent(err) {
		return nil
	}
	return err
}

func isSystemdUnitAbsent(err error) bool {
	var exitError *exec.ExitError
	return errors.As(err, &exitError) && exitError.ExitCode() == 5
}
func (systemd CommandSystemd) Start(ctx context.Context, unit string) error {
	return systemd.run(ctx, "start", unit)
}
func (systemd CommandSystemd) Enable(ctx context.Context, unit string) error {
	return systemd.run(ctx, "enable", unit)
}
func (systemd CommandSystemd) Disable(ctx context.Context, unit string) error {
	err := systemd.run(ctx, "disable", unit)
	if isSystemdUnitAbsent(err) {
		return nil
	}
	return err
}
func (systemd CommandSystemd) IsEnabled(ctx context.Context, unit string) error {
	return systemd.run(ctx, "is-enabled", "--quiet", unit)
}
func (systemd CommandSystemd) IsActive(ctx context.Context, unit string) error {
	return systemd.run(ctx, "is-active", "--quiet", unit)
}
