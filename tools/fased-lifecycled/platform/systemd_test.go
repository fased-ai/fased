package platform

import (
	"fmt"
	"os/exec"
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
