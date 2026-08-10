package platform

import (
	"context"
	"reflect"
	"testing"
)

func TestUserSystemdUsesRootMediatedExactUIDWithoutCredentialFork(t *testing.T) {
	client := CommandUserSystemd{Binary: "/usr/bin/systemctl", Principal: Principal{UID: 1000, GID: 1000}, Home: "/home/owner"}
	command, err := client.command(context.Background(), "is-active", "--quiet", "fased-gateway.service")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/usr/bin/systemctl", "--user", "--machine=1000@.host", "is-active", "--quiet", "fased-gateway.service"}
	if !reflect.DeepEqual(command.Args, want) {
		t.Fatalf("unexpected user-manager command: got=%v want=%v", command.Args, want)
	}
	if command.SysProcAttr != nil {
		t.Fatal("hardened controller attempted a credential-changing fork")
	}
}
