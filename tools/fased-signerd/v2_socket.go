package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func resolveSocketGroupV2(name string) (int, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return -1, nil
	}
	group, err := user.LookupGroup(name)
	if err != nil {
		return -1, fmt.Errorf("resolve signer socket group %q: %w", name, err)
	}
	gid, err := strconv.Atoi(group.Gid)
	if err != nil || gid < 0 {
		return -1, fmt.Errorf("resolve signer socket group %q: invalid gid", name)
	}
	return gid, nil
}

func prepareSocketDirectoryV2(socketPath string, gid int) error {
	directory := filepath.Dir(socketPath)
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		mode := os.FileMode(0o700)
		if gid >= 0 {
			mode = 0o711
		}
		if err := os.MkdirAll(directory, mode); err != nil {
			return fmt.Errorf("create signer socket directory: %w", err)
		}
		info, err = os.Lstat(directory)
	}
	if err != nil {
		return fmt.Errorf("inspect signer socket directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("signer socket directory must be a non-symlink directory")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("signer socket directory must be owned by uid %d", os.Geteuid())
	}
	if gid >= 0 {
		// Application, operator, and control sockets may share one runtime
		// directory while intentionally using different groups. Keep the
		// directory search-only for non-owners; each socket's mode, group, and
		// peer-credential check remain the authorization boundary.
		if err := os.Chmod(directory, 0o711); err != nil {
			return fmt.Errorf("set signer socket directory mode: %w", err)
		}
	}
	return nil
}

func removeStaleSocketV2(socketPath string) error {
	info, err := os.Lstat(socketPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect signer socket: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || info.Mode()&os.ModeSocket == 0 {
		return errors.New("refusing to replace a non-socket signer path")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("stale signer socket must be owned by uid %d", os.Geteuid())
	}
	if err := os.Remove(socketPath); err != nil {
		return fmt.Errorf("remove stale signer socket: %w", err)
	}
	return nil
}

func listenUnixSocketV2(socketPath string, mode uint32, groupName string) (net.Listener, error) {
	if strings.TrimSpace(socketPath) == "" || !filepath.IsAbs(socketPath) {
		return nil, errors.New("signer socket path must be absolute")
	}
	gid, err := resolveSocketGroupV2(groupName)
	if err != nil {
		return nil, err
	}
	if gid < 0 && mode&0o070 != 0 {
		return nil, errors.New("group-accessible signer socket mode requires --socket-group")
	}
	if gid >= 0 && mode&0o060 != 0o060 {
		return nil, errors.New("--socket-group requires group read/write socket permissions")
	}
	if err := prepareSocketDirectoryV2(socketPath, gid); err != nil {
		return nil, err
	}
	if err := removeStaleSocketV2(socketPath); err != nil {
		return nil, err
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, err
	}
	closeOnError := func(cause error) (net.Listener, error) {
		_ = listener.Close()
		_ = os.Remove(socketPath)
		return nil, cause
	}
	if gid >= 0 {
		if err := os.Chown(socketPath, -1, gid); err != nil {
			return closeOnError(fmt.Errorf("set signer socket group: %w", err))
		}
	}
	if err := os.Chmod(socketPath, os.FileMode(mode)); err != nil {
		return closeOnError(fmt.Errorf("set signer socket mode: %w", err))
	}
	return listener, nil
}
