//go:build linux

package main

import "syscall"

const prSetDumpable = 4

func applyProcessDumpHardening() {
	_, _, _ = syscall.Syscall(syscall.SYS_PRCTL, uintptr(prSetDumpable), uintptr(0), 0)
}

