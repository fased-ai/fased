package platform

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type LaunchdRunner interface {
	Output(context.Context, string, ...string) ([]byte, error)
}

type execLaunchdRunner struct{}

func (execLaunchdRunner) Output(ctx context.Context, command string, arguments ...string) ([]byte, error) {
	process := exec.CommandContext(ctx, command, arguments...)
	process.Env = []string{"HOME=/var/root", "LANG=C", "LC_ALL=C", "PATH=/usr/bin:/bin:/usr/sbin:/sbin"}
	return process.CombinedOutput()
}

type CommandLaunchd struct {
	Binary     string
	PS         string
	UnitRoot   string
	Runner     LaunchdRunner
	rootPrefix string
}

var (
	launchdFieldPattern = regexp.MustCompile(`^([a-z ]+) = (.+)$`)
	launchdLabelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$`)
)

func NewCommandLaunchd() (CommandLaunchd, error) {
	manager := CommandLaunchd{Binary: "/bin/launchctl", PS: "/bin/ps", UnitRoot: "/Library/LaunchDaemons", Runner: execLaunchdRunner{}}
	for _, path := range []string{manager.Binary, manager.PS} {
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || info.Mode().Perm()&0o111 == 0 {
			return CommandLaunchd{}, fmt.Errorf("Darwin lifecycle command %s is unavailable or unsafe", path)
		}
	}
	return manager, nil
}

func (launchd CommandLaunchd) validate() error {
	if launchd.Binary != "/bin/launchctl" || launchd.PS != "/bin/ps" || launchd.UnitRoot != "/Library/LaunchDaemons" || launchd.Runner == nil {
		return errors.New("launchd adapter must use fixed system paths")
	}
	return nil
}

func (launchd CommandLaunchd) output(ctx context.Context, command string, arguments ...string) ([]byte, error) {
	if err := launchd.validate(); err != nil {
		return nil, err
	}
	output, err := launchd.Runner.Output(ctx, command, arguments...)
	if len(output) > 64<<10 {
		return nil, errors.New("launchd command output exceeds limit")
	}
	if err != nil {
		return output, fmt.Errorf("%s failed: %w: %s", filepath.Base(command), err, strings.TrimSpace(string(output)))
	}
	return output, nil
}

func (launchd CommandLaunchd) service(label string) (string, string, error) {
	if !launchdLabelPattern.MatchString(label) || strings.Contains(label, "..") {
		return "", "", errors.New("launchd service identity is invalid")
	}
	definition := filepath.Join(launchd.UnitRoot, label+".plist")
	if launchd.rootPrefix != "" {
		definition = filepath.Join(launchd.rootPrefix, definition)
	}
	return "system/" + label, definition, nil
}

func (launchd CommandLaunchd) DaemonReload(context.Context) error { return launchd.validate() }
func (launchd CommandLaunchd) ResetFailed(context.Context, string) error {
	return launchd.validate()
}

func (launchd CommandLaunchd) Stop(ctx context.Context, label string) error {
	service, _, err := launchd.service(label)
	if err != nil {
		return err
	}
	output, err := launchd.output(ctx, launchd.Binary, "bootout", service)
	if err != nil && !launchdServiceAbsent(output) {
		return err
	}
	return nil
}

func (launchd CommandLaunchd) Start(ctx context.Context, label string) error {
	service, plist, err := launchd.service(label)
	if err != nil {
		return err
	}
	if _, inspectErr := launchd.Inspect(ctx, label); inspectErr != nil {
		if output, bootstrapErr := launchd.output(ctx, launchd.Binary, "bootstrap", "system", plist); bootstrapErr != nil && !launchdServiceLoaded(output) {
			return bootstrapErr
		}
	} else {
		return nil
	}
	if _, err := launchd.output(ctx, launchd.Binary, "kickstart", "-k", service); err != nil {
		return err
	}
	_, err = launchd.Inspect(ctx, label)
	return err
}

func (launchd CommandLaunchd) Enable(ctx context.Context, label string) error {
	service, _, err := launchd.service(label)
	if err != nil {
		return err
	}
	if _, err := launchd.output(ctx, launchd.Binary, "enable", service); err != nil {
		return err
	}
	return nil
}

func (launchd CommandLaunchd) Disable(ctx context.Context, label string) error {
	service, _, err := launchd.service(label)
	if err != nil {
		return err
	}
	if err := launchd.Stop(ctx, label); err != nil {
		return err
	}
	_, err = launchd.output(ctx, launchd.Binary, "disable", service)
	return err
}

func (launchd CommandLaunchd) IsEnabled(ctx context.Context, label string) error {
	_, plist, err := launchd.service(label)
	if err != nil {
		return err
	}
	info, err := os.Lstat(plist)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.Join(err, errors.New("launchd service definition is unavailable"))
	}
	output, err := launchd.output(ctx, launchd.Binary, "print-disabled", "system")
	if err != nil {
		return err
	}
	if strings.Contains(string(output), `"`+label+`" => true`) {
		return errors.New("launchd service is disabled")
	}
	return nil
}

func (launchd CommandLaunchd) IsActive(ctx context.Context, label string) error {
	_, err := launchd.Inspect(ctx, label)
	return err
}

func (launchd CommandLaunchd) Inspect(ctx context.Context, label string) (ServiceIdentity, error) {
	service, plist, err := launchd.service(label)
	if err != nil {
		return ServiceIdentity{}, err
	}
	output, err := launchd.output(ctx, launchd.Binary, "print", service)
	if err != nil {
		return ServiceIdentity{}, err
	}
	values := make(map[string]string)
	for _, raw := range strings.Split(string(output), "\n") {
		match := launchdFieldPattern.FindStringSubmatch(strings.TrimSpace(raw))
		if len(match) == 3 {
			values[match[1]] = strings.TrimSpace(match[2])
		}
	}
	pid, err := strconv.ParseUint(values["pid"], 10, 32)
	if err != nil || pid == 0 || values["state"] != "running" || values["program"] == "" || !filepath.IsAbs(values["program"]) {
		return ServiceIdentity{}, errors.New("launchd service is not a process-bound running daemon")
	}
	plistData, err := readRegularFile(plist)
	if err != nil || len(plistData) == 0 || len(plistData) > 1<<20 {
		return ServiceIdentity{}, errors.Join(err, errors.New("launchd service definition is invalid"))
	}
	program, err := launchdProgram(plistData, label)
	if err != nil || program != values["program"] {
		return ServiceIdentity{}, errors.Join(err, errors.New("launchd running program differs from its root-owned definition"))
	}
	started, err := launchd.output(ctx, launchd.PS, "-p", strconv.FormatUint(pid, 10), "-o", "lstart=")
	startedText := strings.TrimSpace(string(started))
	if err != nil || startedText == "" || strings.Contains(startedText, "\n") || len(startedText) > 128 {
		return ServiceIdentity{}, errors.Join(err, errors.New("launchd process start identity is unavailable"))
	}
	plistDigest := sha256.Sum256(plistData)
	execStart := program + " plist-sha256=" + fmt.Sprintf("%x", plistDigest)
	identityDigest := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%s\x00%s", label, pid, startedText, execStart)))
	startDigest := sha256.Sum256([]byte(startedText))
	startedValue := uint64(0)
	for _, value := range startDigest[:8] {
		startedValue = startedValue<<8 | uint64(value)
	}
	if startedValue == 0 {
		startedValue = 1
	}
	execDigest := sha256.Sum256([]byte(execStart))
	return ServiceIdentity{
		Unit: label, MainPID: uint32(pid), InvocationID: fmt.Sprintf("%x", identityDigest[:16]),
		ActiveEnterTimestampMonotonic: startedValue, ExecStartDigest: fmt.Sprintf("sha256:%x", execDigest), ExecStart: execStart,
	}, nil
}

func launchdServiceAbsent(output []byte) bool {
	normalized := strings.ToLower(string(output))
	return strings.Contains(normalized, "could not find service") || strings.Contains(normalized, "no such process") || strings.Contains(normalized, "service cannot be found")
}

func launchdServiceLoaded(output []byte) bool {
	normalized := strings.ToLower(string(output))
	return strings.Contains(normalized, "service already loaded") || strings.Contains(normalized, "already bootstrapped")
}
