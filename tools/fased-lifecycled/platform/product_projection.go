package platform

import (
	"path/filepath"

	"fased-lifecycled/model"
)

func CanonicalProductVersionPath(config Config) string {
	if config.Profile == model.ProfileProtectedLocal {
		return filepath.Join(config.ProductStateRoot, "controller", "signer-version")
	}
	return "/var/lib/fased-host-updater/signer-version"
}
