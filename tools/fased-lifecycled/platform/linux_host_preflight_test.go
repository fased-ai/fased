package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func linuxPreflightFixture(t *testing.T, kernel, pid1, systemdState string) LinuxHostPreflight {
	t.Helper()
	root := t.TempDir()
	for path, value := range map[string]string{
		"proc/sys/kernel/osrelease": kernel + "\n",
		"proc/version":              kernel + "\n",
		"proc/1/comm":               pid1 + "\n",
		"usr/lib/os-release":        "NAME=Ubuntu\nID=ubuntu\n",
	} {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(value), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "run/systemd/system"), 0o755); err != nil {
		t.Fatal(err)
	}
	return LinuxHostPreflight{Root: root, Systemctl: "/usr/bin/systemctl", RunOutput: func(context.Context, string, ...string) ([]byte, error) {
		if systemdState == "failed" {
			return []byte("maintenance\n"), errors.New("not ready")
		}
		return []byte(systemdState + "\n"), nil
	}}
}

func TestLinuxHostPreflightAcceptsOrdinaryLinuxAndWSL2Systemd(t *testing.T) {
	for _, kernel := range []string{"6.8.0-generic", "5.15.153.1-microsoft-standard-WSL2"} {
		if err := linuxPreflightFixture(t, kernel, "systemd", "degraded").Verify(context.Background()); err != nil {
			t.Fatalf("usable host %q was rejected: %v", kernel, err)
		}
	}
}

func TestLinuxHostPreflightReadsZeroSizedProcIdentity(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("procfs identity is Linux-specific")
	}
	info, err := os.Lstat("/proc/sys/kernel/osrelease")
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != 0 {
		t.Skip("kernel exposes a nonzero procfs identity size")
	}
	contents, err := (LinuxHostPreflight{}).read("/proc/sys/kernel/osrelease", 4096)
	if err != nil {
		t.Fatalf("zero-sized procfs identity was rejected: %v", err)
	}
	if strings.TrimSpace(string(contents)) == "" {
		t.Fatal("procfs identity was empty")
	}
}

func TestLinuxHostPreflightRejectsWSL1AndWSL2WithoutSystemd(t *testing.T) {
	for _, test := range []struct{ kernel, pid1, message string }{
		{kernel: "4.4.0-Microsoft", pid1: "init", message: "WSL1"},
		{kernel: "5.15.153.1-microsoft-standard-WSL2", pid1: "init", message: "wsl --shutdown"},
	} {
		err := linuxPreflightFixture(t, test.kernel, test.pid1, "running").Verify(context.Background())
		if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(test.message)) {
			t.Fatalf("invalid WSL host was not rejected with %q: %v", test.message, err)
		}
	}
}

func TestLinuxHostPreflightRejectsNonUbuntuWSL2(t *testing.T) {
	preflight := linuxPreflightFixture(t, "5.15.153.1-microsoft-standard-WSL2", "systemd", "running")
	if err := os.WriteFile(filepath.Join(preflight.Root, "usr/lib/os-release"), []byte("NAME=Debian\nID=debian\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := preflight.Verify(context.Background())
	if err == nil || !strings.Contains(err.Error(), "requires the Ubuntu distribution") {
		t.Fatalf("non-Ubuntu WSL2 was not rejected: %v", err)
	}
}

func TestLinuxHostPreflightRejectsUnusableSystemdState(t *testing.T) {
	if err := linuxPreflightFixture(t, "6.8.0-generic", "systemd", "failed").Verify(context.Background()); err == nil {
		t.Fatal("unusable systemd state was accepted")
	}
}
