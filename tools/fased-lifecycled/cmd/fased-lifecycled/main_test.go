package main

import (
	"bytes"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"

	"fased-lifecycled/platform"
	"fased-lifecycled/protocol"
)

func TestWriteConvergenceResponseEmitsBoundedFailureBeforeReturningError(t *testing.T) {
	for _, outcome := range []string{"ROLLED_BACK", "RECOVERY_PENDING", "REPAIR_REQUIRED", "REJECT_UNKNOWN_NEWER", "REJECT_DOWNGRADE"} {
		t.Run(outcome, func(t *testing.T) {
			var output bytes.Buffer
			response := protocol.Response{SchemaVersion: 1, RequestID: "11111111-1111-4111-8111-111111111111", Outcome: outcome, Detail: "injected failure"}
			err := writeConvergenceResponse(&output, response)
			if err == nil || !strings.Contains(err.Error(), outcome) || !strings.Contains(output.String(), `"outcome":"`+outcome+`"`) {
				t.Fatalf("bounded result was not emitted before failure: output=%q err=%v", output.String(), err)
			}
		})
	}
}

func TestStateAccessCheckUsesKernelAccessAndRejectsSymlinks(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "state.json")
	if err := os.WriteFile(file, []byte("state\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runStateAccessCheck([]string{"--path", file}); err != nil {
		t.Fatalf("current identity could not access writable state: %v", err)
	}
	if err := runStateAccessCheck([]string{"--path", root, "--directory"}); err != nil {
		t.Fatalf("current identity could not access writable state directory: %v", err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(file, alias); err != nil {
		t.Fatal(err)
	}
	if err := runStateAccessCheck([]string{"--path", alias}); err == nil {
		t.Fatal("state access check followed a symlink")
	}
}

func TestPrepareSocketParentConvergesAuthorizedTraversal(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "runtime")
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := prepareSocketParent(parent, os.Getegid()); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(parent, "request.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	info, err := os.Lstat(parent)
	if err != nil {
		t.Fatal(err)
	}
	stat := info.Sys().(*syscall.Stat_t)
	if info.Mode().Perm() != 0o710 || stat.Uid != uint32(os.Geteuid()) || stat.Gid != uint32(os.Getegid()) {
		t.Fatalf("%s identity = %d:%d %o, want %d:%d 710", parent, stat.Uid, stat.Gid, info.Mode().Perm(), os.Geteuid(), os.Getegid())
	}
	connection, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("authorized group could not traverse to lifecycle socket: %v", err)
	}
	_ = connection.Close()
}

func TestInitializationLockSerializesAndReleases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bootstrap.lock")
	first, err := acquireInitializationLockAt(path, uint32(os.Geteuid()))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := acquireInitializationLockAt(path, uint32(os.Geteuid())); err == nil {
		t.Fatal("concurrent bootstrap lock acquisition succeeded")
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	second, err := acquireInitializationLockAt(path, uint32(os.Geteuid()))
	if err != nil {
		t.Fatal(err)
	}
	if err := second.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestBootstrapPathRemovalFailuresPreserveCriticalErrors(t *testing.T) {
	removal := &platform.BootstrapPathRemovalError{Path: "/created", Err: syscall.ENOTEMPTY}
	selected, only := bootstrapPathRemovalFailures(removal)
	if !only || len(selected) != 1 || selected[0].Path != "/created" {
		t.Fatalf("typed removal was not selected: only=%v selected=%+v", only, selected)
	}
	critical := errors.New("systemd rollback failed")
	if _, only := bootstrapPathRemovalFailures(errors.Join(removal, critical)); only {
		t.Fatal("critical rollback failure was incorrectly treated as removable residue")
	}
}

func TestPrepareSocketParentRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "runtime")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := prepareSocketParent(link, os.Getegid()); err == nil {
		t.Fatal("symlinked lifecycle socket directory was accepted")
	}
}

func TestInitializationApplyArgumentsSelectsOneVerifiedInput(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "generation.tar.gz")
	topology := "local-user-systemd-v1"
	dependency := filepath.Join(t.TempDir(), "dependencies.tar.gz")
	indexDigest, releaseAuthorityDigest, pluginLockDigest := "sha256:"+strings.Repeat("a", 64), "sha256:"+strings.Repeat("b", 64), "sha256:"+strings.Repeat("c", 64)
	got, err := initializationApplyArguments("/platform.json", archive, dependency, topology, "0.1.75", 12, 3, 1, 2, indexDigest, releaseAuthorityDigest, pluginLockDigest)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--config", "/platform.json", "--generation-archive", archive, "--release-sequence", "12", "--security-epoch", "3", "--manifest-protocol-min", "1", "--manifest-protocol-max", "2", "--release-index-digest", indexDigest, "--release-authority-digest", releaseAuthorityDigest, "--plugin-lock-digest", pluginLockDigest, "--dependency-archive", dependency, "--source-topology", topology, "--public-predecessor-version", "0.1.75"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("arguments = %#v, want %#v", got, want)
	}
	for _, input := range []string{"", "relative"} {
		if _, err := initializationApplyArguments("/platform.json", input, "", "", "", 12, 3, 1, 2, indexDigest, releaseAuthorityDigest, pluginLockDigest); err == nil {
			t.Fatalf("expected generation input %q to be rejected", input)
		}
	}
	if _, err := initializationApplyArguments("/platform.json", archive, "", topology, "", 12, 3, 1, 2, indexDigest, releaseAuthorityDigest, pluginLockDigest); err == nil {
		t.Fatal("bridge apply accepted missing predecessor version")
	}
	if _, err := initializationApplyArguments("/platform.json", archive, "", "", "0.1.75", 12, 3, 1, 2, indexDigest, releaseAuthorityDigest, pluginLockDigest); err == nil {
		t.Fatal("bridge apply accepted predecessor version without topology")
	}
	if _, err := initializationApplyArguments("/platform.json", archive, "", "", "", 0, 0, 0, 0, "", "", ""); err == nil {
		t.Fatal("initialization accepted missing signed release authority")
	}
}

func TestLifecycleRequestArgumentsBindPublicPredecessorEvidence(t *testing.T) {
	arguments := []string{"--socket", "/run/fased/test.sock", "--operation", "CONVERGE", "--request-id", "018f47d2-5a6b-7c8d-9e0f-123456789abc",
		"--target-generation", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "--expected-manifest", "absent",
		"--source-topology", "local-user-systemd-v1", "--public-predecessor-version", "0.1.75"}
	socket, request, err := parseLifecycleRequestArguments(arguments)
	if err != nil || socket != "/run/fased/test.sock" || request.SourceTopology != "local-user-systemd-v1" || request.PublicPredecessorVersion != "0.1.75" {
		t.Fatalf("request predecessor evidence was not forwarded: socket=%q request=%+v err=%v", socket, request, err)
	}
	if _, _, err := parseLifecycleRequestArguments(arguments[:len(arguments)-2]); err == nil {
		t.Fatal("request accepted predecessor topology without its verified version")
	}
}

func TestBootstrapUnitReplacementRestoresPreviousUnit(t *testing.T) {
	root := t.TempDir()
	unit := filepath.Join(root, "fased-local-controller.service")
	if err := os.WriteFile(unit, []byte("legacy\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	replacement, err := replaceBootstrapUnit(unit, []byte("generation\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !replacement.Existed {
		t.Fatal("expected existing unit to be captured")
	}
	if data, err := os.ReadFile(unit); err != nil || string(data) != "generation\n" {
		t.Fatalf("replacement mismatch: %q %v", data, err)
	}
	if err := replacement.Restore(); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(unit); err != nil || string(data) != "legacy\n" {
		t.Fatalf("restore mismatch: %q %v", data, err)
	}
}

func TestBootstrapUnitReplacementRejectsUnsafeExistingUnit(t *testing.T) {
	root := t.TempDir()
	unit := filepath.Join(root, "fased-local-controller.service")
	if err := os.WriteFile(unit, []byte("legacy\n"), 0o666); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(unit, 0o666); err != nil {
		t.Fatal(err)
	}
	if _, err := replaceBootstrapUnit(unit, []byte("generation\n")); err == nil {
		t.Fatal("expected unsafe existing unit to be rejected")
	}
}

func TestStableBinaryDirectoryRemainsInspectableUnderRestrictiveUmask(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "lifecycle", "supervisor-v1")
	previous := syscall.Umask(0o077)
	err := ensureStableBinaryDirectory(directory)
	syscall.Umask(previous)
	if err != nil {
		t.Fatal(err)
	}
	for _, current := range []string{filepath.Dir(directory), directory} {
		info, statErr := os.Lstat(current)
		if statErr != nil {
			t.Fatal(statErr)
		}
		if info.Mode().Perm() != 0o755 {
			t.Fatalf("%s mode = %o, want 755", current, info.Mode().Perm())
		}
	}
}

func TestStableBinaryDirectoryRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	lifecycle := filepath.Join(root, "lifecycle")
	if err := os.Symlink(target, lifecycle); err != nil {
		t.Fatal(err)
	}
	if err := ensureStableBinaryDirectory(filepath.Join(lifecycle, "supervisor-v1")); err == nil {
		t.Fatal("expected symlinked stable binary directory to be rejected")
	}
}
