package platform

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

type StateAccessVerifier interface {
	Verify(context.Context, string, bool, Principal, []uint32) error
}

// CommandStateAccessVerifier asks the fixed lifecycle binary to perform a
// kernel access(2) check after the child has dropped to the exact service UID,
// GID, and supplementary groups. It does not read or mutate state contents.
type CommandStateAccessVerifier struct {
	Binary  string
	Timeout time.Duration
}

func (verifier CommandStateAccessVerifier) Verify(ctx context.Context, path string, directory bool, principal Principal, groups []uint32) error {
	timeout := verifier.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command, err := verifier.command(probeCtx, path, directory, principal, groups)
	if err != nil {
		return err
	}
	output, err := command.CombinedOutput()
	if err != nil {
		if probeCtx.Err() != nil {
			return errors.New("target-UID state access probe timed out")
		}
		return fmt.Errorf("state is inaccessible to uid %s gid %s: %w: %s", strconv.FormatUint(uint64(principal.UID), 10), strconv.FormatUint(uint64(principal.GID), 10), err, output)
	}
	return nil
}

func (verifier CommandStateAccessVerifier) command(ctx context.Context, path string, directory bool, principal Principal, groups []uint32) (*exec.Cmd, error) {
	if !filepath.IsAbs(verifier.Binary) || filepath.Clean(verifier.Binary) != verifier.Binary {
		return nil, errors.New("state access verifier binary must be absolute and clean")
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || principal.UID == 0 || principal.GID == 0 {
		return nil, errors.New("state access probe identity is invalid")
	}
	args := []string{"state-access-check", "--path", path}
	if directory {
		args = append(args, "--directory")
	}
	command := exec.CommandContext(ctx, verifier.Binary, args...)
	credential := &syscall.Credential{Uid: principal.UID, Gid: principal.GID}
	if os.Geteuid() == 0 {
		credential.Groups = append([]uint32(nil), groups...)
	} else {
		if uint32(os.Geteuid()) != principal.UID || uint32(os.Getegid()) != principal.GID || len(groups) != 0 {
			return nil, errors.New("actual target-UID access verification requires root")
		}
		credential.NoSetGroups = true
	}
	command.SysProcAttr = &syscall.SysProcAttr{Credential: credential}
	return command, nil
}
