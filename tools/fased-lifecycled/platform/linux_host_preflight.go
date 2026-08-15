package platform

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type LinuxHostPreflight struct {
	Root      string
	Systemctl string
	RunOutput func(context.Context, string, ...string) ([]byte, error)
}

func CommandLinuxHostPreflight() LinuxHostPreflight {
	return LinuxHostPreflight{Systemctl: "/usr/bin/systemctl", RunOutput: func(ctx context.Context, command string, args ...string) ([]byte, error) {
		return exec.CommandContext(ctx, command, args...).CombinedOutput()
	}}
}

func (preflight LinuxHostPreflight) Verify(ctx context.Context) error {
	if preflight.Root != "" && (!filepath.IsAbs(preflight.Root) || filepath.Clean(preflight.Root) != preflight.Root || preflight.Root == "/") {
		return errors.New("Linux host preflight root is unsafe")
	}
	if preflight.Systemctl != "/usr/bin/systemctl" && preflight.Systemctl != "/bin/systemctl" {
		return errors.New("Linux host preflight requires a fixed systemctl")
	}
	if preflight.RunOutput == nil {
		return errors.New("Linux host preflight command runner is unavailable")
	}
	osRelease, err := preflight.read("/proc/sys/kernel/osrelease", 4096)
	if err != nil {
		return errors.New("Linux kernel identity is unavailable")
	}
	version, _ := preflight.read("/proc/version", 4096)
	kernel := strings.ToLower(string(osRelease) + " " + string(version))
	wsl := strings.Contains(kernel, "microsoft") || strings.Contains(kernel, "wsl")
	wsl2 := strings.Contains(kernel, "wsl2") || strings.Contains(kernel, "microsoft-standard")
	if wsl && !wsl2 {
		return errors.New("WSL1 is unsupported; install Ubuntu on WSL2 before using the managed lifecycle")
	}
	pid1, err := preflight.read("/proc/1/comm", 128)
	if err != nil || strings.TrimSpace(string(pid1)) != "systemd" {
		if wsl {
			return errors.New("WSL2 systemd is not active; enable systemd in /etc/wsl.conf, run wsl --shutdown, and reopen the distro")
		}
		return errors.New("the managed Linux lifecycle requires systemd as PID 1")
	}
	info, err := os.Lstat(preflight.path("/run/systemd/system"))
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("the systemd runtime directory is unavailable")
	}
	output, commandErr := preflight.RunOutput(ctx, preflight.Systemctl, "is-system-running")
	state := strings.TrimSpace(string(bytes.TrimSpace(output)))
	if state != "running" && state != "degraded" {
		return errors.Join(commandErr, errors.New("systemd is not in a usable running or degraded state"))
	}
	return nil
}

func (preflight LinuxHostPreflight) path(path string) string {
	if preflight.Root == "" {
		return path
	}
	return filepath.Join(preflight.Root, strings.TrimPrefix(path, "/"))
}

func (preflight LinuxHostPreflight) read(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(preflight.path(path))
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > limit {
		return nil, errors.New("Linux host preflight file is unsafe")
	}
	return os.ReadFile(preflight.path(path))
}
