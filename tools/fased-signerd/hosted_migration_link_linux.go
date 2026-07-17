//go:build linux

package main

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func linkHostedMigrationDescriptorV1(source *os.File, destination string) error {
	// Link the already-verified descriptor, not its app-owned pathname. This
	// closes the rename/symlink race between the last source check and the
	// durable quarantine link.
	if err := unix.Linkat(
		int(source.Fd()),
		"",
		unix.AT_FDCWD,
		destination,
		unix.AT_EMPTY_PATH,
	); err == nil || os.Geteuid() == 0 {
		return err
	}
	// AT_EMPTY_PATH requires CAP_DAC_READ_SEARCH. Unit tests intentionally run
	// unprivileged, so use the descriptor's procfs alias there. Production
	// hosted migration is root-only and never takes this fallback.
	descriptorPath := fmt.Sprintf("/proc/self/fd/%d", source.Fd())
	return unix.Linkat(
		unix.AT_FDCWD,
		descriptorPath,
		unix.AT_FDCWD,
		destination,
		unix.AT_SYMLINK_FOLLOW,
	)
}
