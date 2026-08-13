package platform

import (
	"fmt"
	"os/exec"
	"strings"
	"testing"
)

func TestSystemdAbsentUnitExitIsIdempotent(t *testing.T) {
	err := exec.Command("/bin/sh", "-c", "exit 5").Run()
	if !isSystemdUnitAbsent(fmt.Errorf("wrapped systemctl stop: %w", err)) {
		t.Fatal("systemd exit 5 was not recognized as an absent unit")
	}
	err = exec.Command("/bin/sh", "-c", "exit 1").Run()
	if isSystemdUnitAbsent(fmt.Errorf("wrapped systemctl stop: %w", err)) {
		t.Fatal("ordinary systemd failure was treated as an absent unit")
	}
}

func TestSystemdServiceIdentityRequiresLiveProcessBinding(t *testing.T) {
	unit := "fased-gateway-example.service"
	output := []byte("Id=" + unit + "\nActiveState=active\nSubState=running\nMainPID=123\nInvocationID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nActiveEnterTimestampMonotonic=456\nExecStart={ path=/opt/fased/local/example/generations/abc/payload/bin/fased-gateway-launch ; argv[]=/opt/fased/local/example/generations/abc/payload/bin/fased-gateway-launch ; }\n")
	identity, err := parseServiceIdentity(unit, output)
	if err != nil || identity.MainPID != 123 || identity.InvocationID == "" || identity.ExecStartDigest == "" {
		t.Fatalf("valid systemd process identity was rejected: identity=%+v err=%v", identity, err)
	}
	for name, replacement := range map[string]string{
		"inactive": "ActiveState=inactive", "no-pid": "MainPID=0", "no-invocation": "InvocationID=",
	} {
		t.Run(name, func(t *testing.T) {
			candidate := output
			switch name {
			case "inactive":
				candidate = []byte(strings.Replace(string(output), "ActiveState=active", replacement, 1))
			case "no-pid":
				candidate = []byte(strings.Replace(string(output), "MainPID=123", replacement, 1))
			case "no-invocation":
				candidate = []byte(strings.Replace(string(output), "InvocationID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", replacement, 1))
			}
			if _, err := parseServiceIdentity(unit, candidate); err == nil {
				t.Fatal("unbound systemd process identity was accepted")
			}
		})
	}
}
