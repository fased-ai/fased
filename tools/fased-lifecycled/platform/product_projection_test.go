package platform

import (
	"testing"

	"fased-lifecycled/model"
)

func TestCanonicalProductProjectionPathsAreProfileBound(t *testing.T) {
	operator, gateway, signer := principals()
	local, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	hosting, err := NewConfig(model.ProfileHosting, "hosting", "/home/app/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	if CanonicalProductVersionPath(local) != "/var/lib/fased-local/example/controller/signer-version" ||
		CanonicalProductVersionPath(hosting) != "/var/lib/fased-host-updater/signer-version" {
		t.Fatal("product projection paths are not bound to their canonical profiles")
	}
}
