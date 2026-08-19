//go:build darwin

package hostsecurity

import (
	"bytes"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Darwin F_GETPATH is the kernel-provided exact path for an open descriptor.
// Fail closed when it cannot provide a byte-for-byte canonical match.
func mutationLockDescriptorMatches(descriptor int, path string) bool {
	var buffer [unix.PathMax]byte
	if _, err := unix.FcntlInt(uintptr(descriptor), unix.F_GETPATH, int(uintptr(unsafe.Pointer(&buffer[0])))); err != nil {
		return false
	}
	end := bytes.IndexByte(buffer[:], 0)
	return end >= 0 && string(buffer[:end]) == path
}
