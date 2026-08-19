//go:build linux

package hostsecurity

import (
	"os"
	"path/filepath"
	"strconv"
)

func mutationLockDescriptorMatches(descriptor int, path string) bool {
	linkedPath, err := os.Readlink(filepath.Join("/proc/self/fd", strconv.Itoa(descriptor)))
	return err == nil && linkedPath == path
}
