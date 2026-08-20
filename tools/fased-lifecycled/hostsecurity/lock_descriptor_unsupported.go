//go:build !linux && !darwin

package hostsecurity

func mutationLockDescriptorMatches(int, string) bool { return false }
