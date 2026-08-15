package platform

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

const maxACLOutput = 64 << 10

type ACLCommandRunner interface {
	Run(context.Context, string, []string, []byte) ([]byte, error)
}

type execACLRunner struct{}

func (execACLRunner) Run(ctx context.Context, path string, arguments []string, input []byte) ([]byte, error) {
	command := exec.CommandContext(ctx, path, arguments...)
	command.Env = []string{"HOME=/var/root", "LANG=C", "LC_ALL=C", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if len(output) > maxACLOutput {
		return nil, errors.New("ACL command output exceeds limit")
	}
	if err != nil {
		return output, fmt.Errorf("ACL command failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return output, nil
}

type ACLSnapshot struct {
	raw     []byte
	entries map[string]string
}

type HomeACL interface {
	Capture(context.Context, string) (ACLSnapshot, error)
	HasExactTraversal(ACLSnapshot, uint32) (bool, error)
	GrantTraversal(context.Context, string, uint32, ACLSnapshot) error
	Restore(context.Context, string, ACLSnapshot) error
}

func sameACL(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}
