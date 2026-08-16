//go:build darwin

package platform

import (
	"context"
	"errors"
	"os/exec"
)

type DarwinHostPreflight struct{}

func CommandDarwinHostPreflight() DarwinHostPreflight { return DarwinHostPreflight{} }

func (DarwinHostPreflight) Verify(ctx context.Context) error {
	output, err := exec.CommandContext(ctx, "/bin/launchctl", "print", "system").CombinedOutput()
	if err != nil || len(output) == 0 || len(output) > 1<<20 {
		return errors.New("Darwin lifecycle requires an available system launchd domain")
	}
	return nil
}
