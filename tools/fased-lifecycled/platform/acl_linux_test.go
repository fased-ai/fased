package platform

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"
)

type memoryACLRunner struct {
	entries map[string]string
	failSet bool
}

func baseACL() map[string]string {
	return map[string]string{"user::": "rwx", "group::": "---", "other::": "---"}
}

func (runner *memoryACLRunner) Run(_ context.Context, path string, arguments []string, input []byte) ([]byte, error) {
	if path == "getfacl" {
		keys := make([]string, 0, len(runner.entries))
		for key := range runner.entries {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		lines := []string{"# file: /home/owner", "# owner: 1000", "# group: 1000"}
		for _, key := range keys {
			lines = append(lines, key+runner.entries[key])
		}
		return []byte(strings.Join(lines, "\n") + "\n"), nil
	}
	if runner.failSet {
		return nil, errors.New("injected ACL failure")
	}
	if len(arguments) == 1 && arguments[0] == "--restore=-" {
		entries, err := parseACL(input)
		if err != nil {
			return nil, err
		}
		runner.entries = entries
		return nil, nil
	}
	modify := ""
	for index, argument := range arguments {
		if argument == "--modify" && index+1 < len(arguments) {
			modify = arguments[index+1]
		}
	}
	separator := strings.LastIndex(modify, ":")
	if separator < 0 {
		return nil, fmt.Errorf("unexpected ACL arguments: %v", arguments)
	}
	runner.entries[modify[:separator+1]] = modify[separator+1:]
	if _, exists := runner.entries["mask::"]; !exists {
		runner.entries["mask::"] = "--x"
	}
	return nil, nil
}

func TestACLTraversalGrantAndExactRollback(t *testing.T) {
	runner := &memoryACLRunner{entries: baseACL()}
	acl := &LinuxACL{getfacl: "getfacl", setfacl: "setfacl", runner: runner}
	original, err := acl.Capture(context.Background(), "/home/owner")
	if err != nil {
		t.Fatal(err)
	}
	if err := acl.GrantTraversal(context.Background(), "/home/owner", 60001, original); err != nil {
		t.Fatal(err)
	}
	if runner.entries["user:60001:"] != "--x" || runner.entries["mask::"] != "--x" {
		t.Fatalf("exact traversal ACL was not installed: %+v", runner.entries)
	}
	current, err := acl.Capture(context.Background(), "/home/owner")
	if err != nil {
		t.Fatal(err)
	}
	if exact, err := acl.HasExactTraversal(current, 60001); err != nil || !exact {
		t.Fatalf("existing exact traversal was not recognized idempotently: exact=%v err=%v", exact, err)
	}
	if err := acl.Restore(context.Background(), "/home/owner", original); err != nil {
		t.Fatal(err)
	}
	if !sameACL(runner.entries, baseACL()) {
		t.Fatalf("ACL rollback was not exact: %+v", runner.entries)
	}
}

func TestACLRejectsMaskCollisionAndUnavailableSupportBeforeMutation(t *testing.T) {
	blocked := baseACL()
	blocked["mask::"] = "rw-"
	runner := &memoryACLRunner{entries: blocked}
	acl := &LinuxACL{getfacl: "getfacl", setfacl: "setfacl", runner: runner}
	original, err := acl.Capture(context.Background(), "/home/owner")
	if err != nil {
		t.Fatal(err)
	}
	if err := acl.GrantTraversal(context.Background(), "/home/owner", 60001, original); err == nil {
		t.Fatal("ACL mask without traversal was accepted")
	}
	if !sameACL(runner.entries, blocked) {
		t.Fatal("rejected ACL grant mutated the directory")
	}
	if _, err := (&LinuxACL{}).Capture(context.Background(), "/home/owner"); err == nil {
		t.Fatal("unavailable ACL support was not rejected before mutation")
	}
}

func TestACLRejectsUnexpectedEntryAfterGrant(t *testing.T) {
	runner := &memoryACLRunner{entries: baseACL()}
	acl := &LinuxACL{getfacl: "getfacl", setfacl: "setfacl", runner: runner}
	original, err := acl.Capture(context.Background(), "/home/owner")
	if err != nil {
		t.Fatal(err)
	}
	runner.entries["group:70000:"] = "--x"
	if err := acl.GrantTraversal(context.Background(), "/home/owner", 60001, original); err == nil {
		t.Fatal("unrelated ACL change was accepted")
	}
}
