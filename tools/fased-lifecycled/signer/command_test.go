package signer

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"fased-lifecycled/platform"
)

func TestSignerCommandDelegatesExactIdentityToPID1(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "fased-lifecycled")
	if err := os.WriteFile(binary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	command, err := signerCommand(context.Background(), "/usr/bin/systemd-run", binary,
		platform.Principal{UID: 996, GID: 995}, "", "signer-call", "--operation", "v2.lifecycle.upgrade.prepare")
	if err != nil {
		t.Fatal(err)
	}
	if command.SysProcAttr != nil {
		t.Fatal("signer command must not change credentials in the hardened controller")
	}
	want := []string{"/usr/bin/systemd-run", "--quiet", "--wait", "--pipe", "--collect", "--service-type=exec",
		"--uid=996", "--gid=995", "--property=NoNewPrivileges=yes", "--property=PrivateTmp=yes",
		"--property=PrivateDevices=yes", "--property=ProtectSystem=strict", "--property=ProtectHome=yes",
		"--property=RestrictAddressFamilies=AF_UNIX", "--property=CapabilityBoundingSet=", "--", binary,
		"signer-call", "--operation", "v2.lifecycle.upgrade.prepare"}
	if !reflect.DeepEqual(command.Args, want) {
		t.Fatalf("unexpected signer command:\n got: %#v\nwant: %#v", command.Args, want)
	}
	if !reflect.DeepEqual(command.Env, []string{"PATH=/usr/bin:/bin"}) {
		t.Fatalf("unexpected signer command environment: %#v", command.Env)
	}
}

func TestOfflineSignerCommandBindsOnlyStateRootWritable(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "fased-signerd")
	if err := os.WriteFile(binary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	command, err := signerCommand(context.Background(), "", binary, platform.Principal{UID: 996, GID: 996},
		"/var/lib/fased-signerd", "lifecycle-upgrade-abort", "--state-db", "/var/lib/fased-signerd/state.db")
	if err != nil {
		t.Fatal(err)
	}
	wantProperty := "--property=ReadWritePaths=/var/lib/fased-signerd"
	found := false
	for _, argument := range command.Args {
		if argument == wantProperty {
			found = true
		}
	}
	if !found {
		t.Fatalf("offline signer command does not bind writable state root: %#v", command.Args)
	}
}

func TestSignerCommandRejectsMutableRunnerAndUnsafePrincipal(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "fased-signerd")
	if err := os.WriteFile(binary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := signerCommand(context.Background(), "/tmp/systemd-run", binary, platform.Principal{UID: 996, GID: 996}, ""); err == nil {
		t.Fatal("accepted mutable signer command runner")
	}
	if _, err := signerCommand(context.Background(), "", binary, platform.Principal{UID: 0, GID: 996}, ""); err == nil {
		t.Fatal("accepted root signer principal")
	}
}
