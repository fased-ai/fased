package platform

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

type Systemd interface {
	DaemonReload(context.Context) error
	ResetFailed(context.Context, string) error
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

type ServiceIdentity struct {
	Unit                          string
	MainPID                       uint32
	InvocationID                  string
	ActiveEnterTimestampMonotonic uint64
	ExecStartDigest               string
	ExecStart                     string
}

type SystemdInspector interface {
	Inspect(context.Context, string) (ServiceIdentity, error)
}

var (
	systemdUnitPattern       = regexp.MustCompile(`^[A-Za-z0-9_.@-]+\.service$`)
	systemdInvocationPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
)

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

func (systemd CommandSystemd) Inspect(ctx context.Context, unit string) (ServiceIdentity, error) {
	if !systemdUnitPattern.MatchString(unit) {
		return ServiceIdentity{}, errors.New("systemd service identity is invalid")
	}
	if systemd.Binary != "/usr/bin/systemctl" && systemd.Binary != "/bin/systemctl" {
		return ServiceIdentity{}, errors.New("systemd binary must use a fixed system path")
	}
	arguments := []string{"show", "--no-pager", "--property=Id", "--property=ActiveState", "--property=SubState", "--property=MainPID", "--property=InvocationID", "--property=ActiveEnterTimestampMonotonic", "--property=ExecStart", "--", unit}
	output, err := exec.CommandContext(ctx, systemd.Binary, arguments...).CombinedOutput()
	if err != nil {
		return ServiceIdentity{}, fmt.Errorf("systemctl show failed: %w: %s", err, output)
	}
	if len(output) == 0 || len(output) > 16<<10 {
		return ServiceIdentity{}, errors.New("systemd service identity response is empty or oversized")
	}
	return parseServiceIdentity(unit, output)
}

func parseServiceIdentity(unit string, output []byte) (ServiceIdentity, error) {
	values := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		key, value, found := strings.Cut(line, "=")
		if !found || key == "" {
			return ServiceIdentity{}, errors.New("systemd service identity response is malformed")
		}
		values[key] = value
	}
	pid, pidErr := strconv.ParseUint(values["MainPID"], 10, 32)
	started, startedErr := strconv.ParseUint(values["ActiveEnterTimestampMonotonic"], 10, 64)
	invocation := values["InvocationID"]
	execStart := values["ExecStart"]
	if values["Id"] != unit || values["ActiveState"] != "active" || values["SubState"] != "running" ||
		pidErr != nil || pid == 0 || startedErr != nil || started == 0 ||
		!systemdInvocationPattern.MatchString(invocation) || execStart == "" || len(execStart) > 8<<10 {
		return ServiceIdentity{}, errors.New("systemd service is not a process-bound active unit")
	}
	digest := sha256.Sum256([]byte(execStart))
	return ServiceIdentity{Unit: unit, MainPID: uint32(pid), InvocationID: invocation, ActiveEnterTimestampMonotonic: started, ExecStartDigest: fmt.Sprintf("sha256:%x", digest), ExecStart: execStart}, nil
}

func (systemd CommandSystemd) DaemonReload(ctx context.Context) error {
	return systemd.run(ctx, "daemon-reload")
}
func (systemd CommandSystemd) ResetFailed(ctx context.Context, unit string) error {
	return systemd.run(ctx, "reset-failed", unit)
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
	if err := systemd.run(ctx, "start", unit); err != nil {
		return err
	}
	_, err := systemd.Inspect(ctx, unit)
	return err
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
