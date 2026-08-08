package platform

import (
	"testing"

	"fased-lifecycled/model"
)

func principals() (Principal, Principal, Principal) {
	return Principal{UID: 1000, GID: 1000}, Principal{UID: 997, GID: 997}, Principal{UID: 996, GID: 996}
}

func TestConfigDerivesCanonicalProfilePathsAndIdentity(t *testing.T) {
	operator, gateway, signer := principals()
	local, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := local.Identity()
	if err != nil {
		t.Fatal(err)
	}
	if local.InstallRoot != "/opt/fased/local/example" || identity.Services["controller"] != "fased-local-controller-worker-example.service" {
		t.Fatalf("unexpected Local identity: %+v %+v", local, identity)
	}
	hosting, err := NewConfig(model.ProfileHosting, "example", "/var/lib/fased/owner", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	hostingIdentity, err := hosting.Identity()
	if err != nil || hostingIdentity.Adapter != "linux-systemd-hosting-v1" || hosting.InstallRoot != "/opt/fased" {
		t.Fatalf("unexpected Hosting identity: %+v %+v err=%v", hosting, hostingIdentity, err)
	}
}

func TestConfigRejectsRootPrincipalsSharedSignerAndPathSubstitution(t *testing.T) {
	operator, gateway, signer := principals()
	if _, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", Principal{}, gateway, signer); err == nil {
		t.Fatal("root operator was accepted")
	}
	if _, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, signer, signer); err == nil {
		t.Fatal("shared gateway/signer principal was accepted")
	}
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	config.InstallRoot = "/tmp/substituted"
	if err := config.Validate(); err == nil {
		t.Fatal("system path substitution was accepted")
	}
}

func TestConfigDigestChangesWithOwnerOrPrincipal(t *testing.T) {
	operator, gateway, signer := principals()
	first, _ := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	second, _ := NewConfig(model.ProfileProtectedLocal, "example", "/home/other/.fased", operator, gateway, signer)
	firstDigest, _ := first.Digest()
	secondDigest, _ := second.Digest()
	if firstDigest == secondDigest {
		t.Fatal("owner-state substitution did not change platform identity")
	}
}
