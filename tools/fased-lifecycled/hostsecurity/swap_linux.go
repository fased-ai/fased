//go:build linux

package hostsecurity

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

const (
	managedSwapPath       = "/var/lib/fased-host-security/fased.swap"
	managedSwapFstabEntry = managedSwapPath + " none swap sw 0 0"
	managedSwapBytes      = int64(2 << 30)
	managedSwapThreshold  = int64(2 << 30)
	managedSwapDiskMargin = int64(256 << 20)
)

type hardeningSwapSnapshot struct {
	SchemaVersion uint32 `json:"schemaVersion"`
	Required      bool   `json:"required"`
}

func (snapshot hardeningSwapSnapshot) validate() error {
	if snapshot.SchemaVersion != 1 {
		return errors.New("Hosting managed swap snapshot is invalid")
	}
	return nil
}

type swapInspection struct {
	memoryBytes       int64
	activeBytes       int64
	managedPathActive bool
}

func (host LinuxHost) lifecyclePrerequisitesReady() (bool, error) {
	ready, err := host.managedSwapReady()
	return host.aclToolsReady() && ready, err
}

func (host LinuxHost) snapshotManagedSwap() (hardeningSwapSnapshot, error) {
	ready, err := host.managedSwapReady()
	if err != nil {
		return hardeningSwapSnapshot{}, err
	}
	return hardeningSwapSnapshot{SchemaVersion: 1, Required: !ready}, nil
}

func (host LinuxHost) managedSwapReady() (bool, error) {
	inspection, err := host.inspectSwap()
	if err != nil {
		return false, err
	}
	managedPath := host.path(managedSwapPath)
	managedInfo, managedErr := os.Lstat(managedPath)
	managedExists := managedErr == nil
	if managedErr != nil && !errors.Is(managedErr, os.ErrNotExist) {
		return false, managedErr
	}
	fstab, _, err := host.readManagedFstab()
	if err != nil {
		return false, err
	}
	exactEntries, conflictingEntries := classifyManagedSwapEntries(fstab)
	if conflictingEntries != 0 || exactEntries > 1 {
		return false, errors.New("Hosting managed swap fstab identity is ambiguous")
	}
	if managedExists {
		if err := validateManagedSwapFile(managedInfo); err != nil {
			return false, err
		}
		if !inspection.managedPathActive || exactEntries != 1 {
			return false, errors.New("Hosting managed swap residue is incomplete")
		}
	} else if inspection.managedPathActive || exactEntries != 0 {
		return false, errors.New("Hosting managed swap residue is incomplete")
	}
	if inspection.memoryBytes > managedSwapThreshold {
		return true, nil
	}
	return inspection.activeBytes >= managedSwapBytes, nil
}

func (host LinuxHost) stageManagedSwap(ctx context.Context, snapshot hardeningSwapSnapshot, log io.Writer) error {
	if !snapshot.Required {
		return nil
	}
	managedPath := host.path(managedSwapPath)
	parent := filepath.Dir(managedPath)
	if info, err := os.Lstat(parent); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(parent, 0o700); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else if stat, ok := info.Sys().(*syscall.Stat_t); !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || stat.Uid != uint32(os.Getuid()) {
		return errors.New("Hosting managed swap directory is unsafe")
	}
	if err := os.Chmod(parent, 0o700); err != nil {
		return err
	}
	if err := validateManagedSwapParent(parent); err != nil {
		return err
	}
	info, err := os.Lstat(managedPath)
	if errors.Is(err, os.ErrNotExist) {
		if host.RootPrefix == "" {
			var stat syscall.Statfs_t
			if err := syscall.Statfs(parent, &stat); err != nil {
				return err
			}
			available := int64(stat.Bavail) * int64(stat.Bsize)
			if available < managedSwapBytes+managedSwapDiskMargin {
				return errors.New("Hosting requires at least 2.25 GiB free disk to create managed swap")
			}
		}
		file, createErr := os.OpenFile(managedPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if createErr != nil {
			return createErr
		}
		if closeErr := file.Close(); closeErr != nil {
			return closeErr
		}
		if host.RootPrefix != "" {
			err = os.Truncate(managedPath, managedSwapBytes)
		} else {
			fallocate, findErr := fixedExecutable("/usr/bin/fallocate", "/bin/fallocate")
			if findErr != nil {
				return findErr
			}
			err = host.run(ctx, fallocate, []string{"-l", strconv.FormatInt(managedSwapBytes, 10), managedPath}, nil, io.Discard, log, nil)
		}
		if err != nil {
			return err
		}
		info, err = os.Lstat(managedPath)
	}
	if err != nil {
		return err
	}
	if err := validateManagedSwapFile(info); err != nil {
		return err
	}
	if err := host.ensureManagedSwapFstab(); err != nil {
		return err
	}
	inspection, err := host.inspectSwap()
	if err != nil {
		return err
	}
	if inspection.managedPathActive && inspection.activeBytes >= managedSwapBytes {
		return nil
	}
	if host.RootPrefix == "" {
		mkswap, err := fixedExecutable("/usr/sbin/mkswap", "/sbin/mkswap")
		if err != nil {
			return err
		}
		if err := host.run(ctx, mkswap, []string{managedPath}, nil, io.Discard, log, nil); err != nil {
			return err
		}
		swapon, err := fixedExecutable("/usr/sbin/swapon", "/sbin/swapon")
		if err != nil {
			return err
		}
		if err := host.run(ctx, swapon, []string{managedPath}, nil, io.Discard, log, nil); err != nil {
			return err
		}
	} else if err := host.writeFixtureSwapActive(); err != nil {
		return err
	}
	ready, err := host.managedSwapReady()
	if err != nil || !ready {
		return errors.Join(err, errors.New("Hosting managed swap did not converge"))
	}
	return nil
}

func (host LinuxHost) restoreManagedSwap(ctx context.Context, snapshot hardeningSwapSnapshot) error {
	if !snapshot.Required {
		return nil
	}
	inspection, err := host.inspectSwap()
	if err != nil {
		return err
	}
	managedPath := host.path(managedSwapPath)
	if inspection.managedPathActive {
		if host.RootPrefix == "" {
			swapoff, findErr := fixedExecutable("/usr/sbin/swapoff", "/sbin/swapoff")
			if findErr != nil {
				return findErr
			}
			if err := host.run(ctx, swapoff, []string{managedPath}, nil, io.Discard, io.Discard, nil); err != nil {
				return err
			}
		} else if err := host.writeFixtureSwapInactive(); err != nil {
			return err
		}
	}
	if info, statErr := os.Lstat(managedPath); statErr == nil {
		if err := validateManagedSwapFile(info); err != nil {
			return err
		}
		if err := os.Remove(managedPath); err != nil {
			return err
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}
	return host.removeManagedSwapFstab()
}

func (host LinuxHost) inspectSwap() (swapInspection, error) {
	memory, err := parseMemoryTotal(host.path("/proc/meminfo"))
	if err != nil {
		return swapInspection{}, err
	}
	file, err := os.Open(host.path("/proc/swaps"))
	if err != nil {
		return swapInspection{}, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	if !scanner.Scan() || !strings.HasPrefix(strings.TrimSpace(scanner.Text()), "Filename") {
		return swapInspection{}, errors.New("Hosting /proc/swaps header is invalid")
	}
	result := swapInspection{memoryBytes: memory}
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 5 {
			return swapInspection{}, errors.New("Hosting /proc/swaps row is invalid")
		}
		kilobytes, parseErr := strconv.ParseInt(fields[2], 10, 64)
		if parseErr != nil || kilobytes <= 0 || kilobytes > (1<<52)/1024 {
			return swapInspection{}, errors.New("Hosting /proc/swaps size is invalid")
		}
		result.activeBytes += kilobytes * 1024
		if fields[0] == managedSwapPath || fields[0] == host.path(managedSwapPath) {
			result.managedPathActive = true
		}
	}
	if err := scanner.Err(); err != nil {
		return swapInspection{}, err
	}
	return result, nil
}

func parseMemoryTotal(path string) (int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 3 && fields[0] == "MemTotal:" && fields[2] == "kB" {
			kilobytes, parseErr := strconv.ParseInt(fields[1], 10, 64)
			if parseErr == nil && kilobytes > 0 && kilobytes <= (1<<52)/1024 {
				return kilobytes * 1024, nil
			}
		}
	}
	return 0, errors.Join(scanner.Err(), errors.New("Hosting MemTotal is unavailable or invalid"))
}

func validateManagedSwapParent(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 || stat.Uid != uint32(os.Getuid()) {
		return errors.New("Hosting managed swap directory is unsafe")
	}
	return nil
}

func validateManagedSwapFile(info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 || info.Size() != managedSwapBytes {
		return errors.New("Hosting managed swap file is unsafe")
	}
	return nil
}

func (host LinuxHost) readManagedFstab() ([]byte, os.FileMode, error) {
	path := host.path("/etc/fstab")
	info, err := os.Lstat(path)
	if err != nil {
		return nil, 0, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 || info.Size() > 1<<20 {
		return nil, 0, errors.New("Hosting fstab is unsafe")
	}
	data, err := os.ReadFile(path)
	return data, info.Mode().Perm(), err
}

func classifyManagedSwapEntries(data []byte) (exact, conflicting int) {
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) > 0 && fields[0] == managedSwapPath {
			if trimmed == managedSwapFstabEntry {
				exact++
			} else {
				conflicting++
			}
		}
	}
	return exact, conflicting
}

func (host LinuxHost) ensureManagedSwapFstab() error {
	data, mode, err := host.readManagedFstab()
	if err != nil {
		return err
	}
	exact, conflicting := classifyManagedSwapEntries(data)
	if conflicting != 0 || exact > 1 {
		return errors.New("Hosting managed swap fstab identity is ambiguous")
	}
	if exact == 1 {
		return nil
	}
	updated := append([]byte(nil), data...)
	if len(updated) != 0 && updated[len(updated)-1] != '\n' {
		updated = append(updated, '\n')
	}
	updated = append(updated, []byte(managedSwapFstabEntry+"\n")...)
	return writeAtomicRootFile(host.path("/etc/fstab"), updated, mode, uint32(os.Getuid()))
}

func (host LinuxHost) removeManagedSwapFstab() error {
	data, mode, err := host.readManagedFstab()
	if err != nil {
		return err
	}
	exact, conflicting := classifyManagedSwapEntries(data)
	if conflicting != 0 || exact > 1 {
		return errors.New("Hosting managed swap fstab identity is ambiguous")
	}
	if exact == 0 {
		return nil
	}
	lines := strings.Split(string(data), "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) != managedSwapFstabEntry {
			kept = append(kept, line)
		}
	}
	updated := []byte(strings.Join(kept, "\n"))
	return writeAtomicRootFile(host.path("/etc/fstab"), updated, mode, uint32(os.Getuid()))
}

func (host LinuxHost) writeFixtureSwapActive() error {
	return os.WriteFile(host.path("/proc/swaps"), []byte(fmt.Sprintf("Filename\tType\tSize\tUsed\tPriority\n%s file %d 0 -2\n", host.path(managedSwapPath), managedSwapBytes/1024)), 0o444)
}

func (host LinuxHost) writeFixtureSwapInactive() error {
	return os.WriteFile(host.path("/proc/swaps"), []byte("Filename\tType\tSize\tUsed\tPriority\n"), 0o444)
}
