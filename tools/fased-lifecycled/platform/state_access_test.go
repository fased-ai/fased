package platform

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestStateAccessCommandDropsToExactPrincipalAndGroups(t *testing.T) {
	binary, err := filepath.Abs(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	principal := Principal{UID: uint32(os.Geteuid()), GID: uint32(os.Getegid())}
	groups := []uint32(nil)
	if os.Geteuid() == 0 {
		principal = Principal{UID: 12345, GID: 12346}
		groups = []uint32{12347}
	}
	command, err := (CommandStateAccessVerifier{Binary: binary}).command(context.Background(), "/var/lib/fased-state", true, principal, groups)
	if err != nil {
		t.Fatal(err)
	}
	if command.SysProcAttr == nil || command.SysProcAttr.Credential == nil {
		t.Fatal("state access command did not install a kernel credential")
	}
	credential := command.SysProcAttr.Credential
	if credential.Uid != principal.UID || credential.Gid != principal.GID || !reflect.DeepEqual(credential.Groups, groups) {
		t.Fatalf("state access command identity mismatch: %+v", credential)
	}
	if got := command.Args[len(command.Args)-1]; got != "--directory" {
		t.Fatalf("directory access intent was not bound: %v", command.Args)
	}
}
