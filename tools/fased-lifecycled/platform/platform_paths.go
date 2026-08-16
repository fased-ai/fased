package platform

import "path/filepath"

func LocalInstallRootForOS(operatingSystem, instanceID string) string {
	if operatingSystem == "darwin" {
		return filepath.Join("/Library/Fased", "local", instanceID)
	}
	return filepath.Join("/opt/fased/local", instanceID)
}

func LocalLifecycleRootForOS(operatingSystem, instanceID string) string {
	if operatingSystem == "darwin" {
		return filepath.Join("/Library/FasedLifecycle", instanceID)
	}
	return filepath.Join("/var/lib/fased-local", instanceID, "lifecycle")
}

func LocalPlatformConfigPathForOS(operatingSystem, instanceID string) string {
	return filepath.Join(LocalLifecycleRootForOS(operatingSystem, instanceID), "platform.json")
}

func BootstrapJournalRootForOS(operatingSystem string) string {
	if operatingSystem == "darwin" {
		return "/Library/FasedLifecycle/bootstrap"
	}
	return "/var/lib/fased-lifecycle-bootstrap"
}

func BootstrapMutationLockPathForOS(operatingSystem string) string {
	if operatingSystem == "darwin" {
		return "/var/run/fased-bootstrap-local.lock"
	}
	return "/run/lock/fased-bootstrap-local.lock"
}

func BootstrapCacheRootForOS(operatingSystem string) string {
	if operatingSystem == "darwin" {
		return "/Library/FasedLifecycle/bootstrap-cache"
	}
	return "/var/lib/fased-bootstrap"
}

func LifecycleHostRootForOS(operatingSystem string) string {
	if operatingSystem == "darwin" {
		return "/Library/FasedLifecycle"
	}
	return "/opt/fased/lifecycle"
}
