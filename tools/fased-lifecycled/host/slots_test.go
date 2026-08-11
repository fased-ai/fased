package host

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"fased-lifecycled/acquire"
	"fased-lifecycled/trust"
)

func hostAsset(name string, data []byte, protocols trust.HostProtocols) trust.Asset {
	sum := sha256.Sum256(data)
	return trust.Asset{Name: name, Size: uint64(len(data)), SHA256: fmt.Sprintf("sha256:%x", sum), PrivilegedComponent: "lifecycle-host", Protocols: &protocols}
}
func protocols() trust.HostProtocols {
	return trust.HostProtocols{Manifest: trust.ProtocolRange{Min: 2, Max: 2}, Journal: trust.ProtocolRange{Min: 1, Max: 2}, Participant: trust.ProtocolRange{Min: 1, Max: 1}, Platform: trust.ProtocolRange{Min: 1, Max: 2}}
}
func requirements() Requirements {
	return Requirements{Manifest: 2, Journal: 1, Participant: 1, Platform: 2}
}

func stagedFixture(t *testing.T, root, name string, data []byte) (*Store, StagedHost) {
	t.Helper()
	inbox, err := acquire.OpenInbox(filepath.Join(root, "state"), uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { inbox.Close() })
	asset := hostAsset(name, data, protocols())
	object, err := inbox.Put(context.Background(), asset, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { object.Close() })
	store, err := OpenStore(filepath.Join(root, "install"), uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	host, err := store.Stage(object, asset, requirements())
	if err != nil {
		t.Fatal(err)
	}
	return store, host
}

func TestStoreStagesExactVerifiedObjectWithRestrictiveUmask(t *testing.T) {
	oldMask := syscall.Umask(0o077)
	defer syscall.Umask(oldMask)
	_, staged := stagedFixture(t, t.TempDir(), "fased-lifecycled-linux-x64", []byte("static-host-a"))
	info, err := os.Lstat(staged.Path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o500 {
		t.Fatalf("staged host is unsafe: info=%v err=%v", info, err)
	}
}

func TestStoreActivatesABAndRestoresCurrentOnInspectionFailure(t *testing.T) {
	root := t.TempDir()
	store, first := stagedFixture(t, root, "fased-lifecycled-linux-x64", []byte("static-host-a"))
	if err := store.Activate(first, func(host StagedHost) error { return nil }); err != nil {
		t.Fatal(err)
	}
	secondInbox, err := acquire.OpenInbox(filepath.Join(root, "state"), uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer secondInbox.Close()
	asset := hostAsset("fased-lifecycled-linux-x64-b", []byte("static-host-b"), protocols())
	object, err := secondInbox.Put(context.Background(), asset, bytes.NewReader([]byte("static-host-b")))
	if err != nil {
		t.Fatal(err)
	}
	defer object.Close()
	second, err := store.Stage(object, asset, requirements())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Activate(second, func(host StagedHost) error { return fmt.Errorf("injected inspect failure") }); err == nil {
		t.Fatal("failed host inspection committed")
	}
	current, err := store.Current()
	if err != nil || current != first.Digest {
		t.Fatalf("current host was not restored: current=%q err=%v", current, err)
	}
	previous, err := store.Previous()
	if err != nil || previous != first.Digest {
		t.Fatalf("previous host was not retained: previous=%q err=%v", previous, err)
	}
	if err := store.Activate(second, func(host StagedHost) error { return nil }); err != nil {
		t.Fatal(err)
	}
	current, _ = store.Current()
	previous, _ = store.Previous()
	if current != second.Digest || previous != first.Digest {
		t.Fatalf("A/B pointers are wrong: current=%q previous=%q", current, previous)
	}
}

func TestCompatibilityRejectsUnsupportedProtocol(t *testing.T) {
	unsupported := protocols()
	unsupported.Manifest = trust.ProtocolRange{Min: 3, Max: 3}
	if err := VerifyCompatibility(unsupported, requirements()); err == nil {
		t.Fatal("incompatible lifecycle host was accepted")
	}
}
