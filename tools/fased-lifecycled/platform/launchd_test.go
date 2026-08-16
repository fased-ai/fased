package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeLaunchdRunner struct {
	calls []string
}

func (runner *fakeLaunchdRunner) Output(_ context.Context, command string, arguments ...string) ([]byte, error) {
	call := command + " " + strings.Join(arguments, " ")
	runner.calls = append(runner.calls, call)
	if command == "/bin/ps" {
		return []byte("Sat Aug 15 17:00:00 2026\n"), nil
	}
	if strings.Contains(call, " print system/ai.fased.gateway.example") {
		return []byte("system/ai.fased.gateway.example = {\n\tstate = running\n\tprogram = /Library/Fased/local/example/current/payload/bin/fased-gateway-launch\n\tpid = 321\n}\n"), nil
	}
	return nil, errors.New("unexpected launchd test command")
}

func TestLaunchdPlistAndInspectionBindLabelProgramPIDAndStartIdentity(t *testing.T) {
	label := "ai.fased.gateway.example"
	program := "/Library/Fased/local/example/current/payload/bin/fased-gateway-launch"
	plist, err := renderLaunchdPlist(launchdPlistSpec{
		Label: label, User: "fsgw-example", Group: "fsgw-example", ProgramArguments: []string{program},
		Environment: map[string]string{"FASED_RUNTIME_SOURCE": "go-lifecycle", "PATH": "/usr/bin:/bin"}, Umask: 0o007,
		WorkingDirectory: "/Library/Fased/local/example/current/payload/runtime", StdoutPath: "/Library/FasedLifecycle/example/logs/gateway.log", StderrPath: "/Library/FasedLifecycle/example/logs/gateway.err.log",
	})
	if err != nil {
		t.Fatal(err)
	}
	if parsed, err := launchdProgram(plist, label); err != nil || parsed != program {
		t.Fatalf("launchd plist program = %q, %v", parsed, err)
	}
	if !strings.Contains(string(plist), "<key>KeepAlive</key><true/>") || !strings.Contains(string(plist), "FASED_RUNTIME_SOURCE") {
		t.Fatalf("launchd plist lacks lifecycle contracts:\n%s", plist)
	}

	root := t.TempDir()
	path := filepath.Join(root, "Library/LaunchDaemons", label+".plist")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, plist, 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &fakeLaunchdRunner{}
	manager := CommandLaunchd{Binary: "/bin/launchctl", PS: "/bin/ps", UnitRoot: "/Library/LaunchDaemons", Runner: runner, rootPrefix: root}
	identity, err := manager.Inspect(context.Background(), label)
	if err != nil {
		t.Fatal(err)
	}
	if identity.Unit != label || identity.MainPID != 321 || len(identity.InvocationID) != 32 || identity.ActiveEnterTimestampMonotonic == 0 || !strings.Contains(identity.ExecStart, program) {
		t.Fatalf("unexpected launchd process identity: %+v", identity)
	}
}

func TestLaunchdPlistRejectsLabelOrProgramSubstitution(t *testing.T) {
	plist, err := renderLaunchdPlist(launchdPlistSpec{
		Label: "ai.fased.gateway.example", User: "gateway", Group: "gateway", ProgramArguments: []string{"/safe/gateway"}, Umask: 0o007,
		StdoutPath: "/var/log/fased.out", StderrPath: "/var/log/fased.err",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := launchdProgram(plist, "ai.fased.gateway.other"); err == nil {
		t.Fatal("substituted launchd label was accepted")
	}
}
