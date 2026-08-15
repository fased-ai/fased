package acquire

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"fased-lifecycled/trust"
)

func testAsset(name string, data []byte) trust.Asset {
	sum := sha256.Sum256(data)
	return trust.Asset{Name: name, Size: uint64(len(data)), SHA256: fmt.Sprintf("sha256:%x", sum)}
}

func privateTestRoot(t *testing.T) string {
	t.Helper()
	base := "."
	if configured := os.Getenv("FASED_ROOT_FIXTURE_BASE"); configured != "" {
		base = configured
	}
	root, err := os.MkdirTemp(base, ".acquire-test-")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o700); err != nil {
		os.RemoveAll(root)
		t.Fatal(err)
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		os.RemoveAll(root)
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(absolute) })
	return absolute
}

func TestInboxNormalizesRestrictiveUmaskAndBindsOpenObject(t *testing.T) {
	oldMask := syscall.Umask(0o077)
	defer syscall.Umask(oldMask)
	root := filepath.Join(privateTestRoot(t), "lifecycle")
	inbox, err := OpenInbox(root, uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer inbox.Close()
	data := []byte("verified lifecycle host")
	asset := testAsset("fased-lifecycled-linux-x64", data)
	object, err := inbox.Put(context.Background(), asset, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer object.Close()
	for _, path := range []string{filepath.Join(root, "inbox"), filepath.Join(root, "inbox", ".staging"), filepath.Join(root, "inbox", asset.SHA256[len("sha256:"):])} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("private directory %s mode=%v err=%v", path, info, err)
		}
	}
	receipt := object.Receipt()
	if receipt.SHA256 != asset.SHA256 || receipt.Device == 0 || receipt.Inode == 0 {
		t.Fatalf("object receipt is incomplete: %+v", receipt)
	}

	canonical := filepath.Join(root, "inbox", receipt.RelativePath)
	quarantined := canonical + ".old"
	if err := os.Rename(canonical, quarantined); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(canonical, []byte("attacker replacement"), 0o400); err != nil {
		t.Fatal(err)
	}
	var copied bytes.Buffer
	if _, err := object.CopyTo(&copied); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(copied.Bytes(), data) {
		t.Fatal("verified object followed a pathname replacement")
	}
}

func TestInboxRejectsTraversalSymlinkHardlinkAndWrongDigest(t *testing.T) {
	root := filepath.Join(privateTestRoot(t), "lifecycle")
	inbox, err := OpenInbox(root, uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer inbox.Close()
	data := []byte("trusted")
	asset := testAsset("../escape", data)
	if _, err := inbox.Put(context.Background(), asset, bytes.NewReader(data)); err == nil {
		t.Fatal("traversal asset name was accepted")
	}
	asset = testAsset("asset", data)
	asset.SHA256 = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := inbox.Put(context.Background(), asset, bytes.NewReader(data)); err == nil {
		t.Fatal("wrong digest was accepted")
	}

	asset = testAsset("asset", data)
	digestDir := filepath.Join(root, "inbox", asset.SHA256[len("sha256:"):])
	if err := os.Mkdir(digestDir, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "outside")
	if err := os.WriteFile(outside, data, 0o400); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(digestDir, asset.Name)); err != nil {
		t.Fatal(err)
	}
	if _, err := inbox.Put(context.Background(), asset, bytes.NewReader(data)); err == nil {
		t.Fatal("symlink inbox object was accepted")
	}
	if err := os.Remove(filepath.Join(digestDir, asset.Name)); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, filepath.Join(digestDir, asset.Name)); err != nil {
		t.Fatal(err)
	}
	if _, err := inbox.Put(context.Background(), asset, bytes.NewReader(data)); err == nil {
		t.Fatal("hardlinked inbox object was accepted")
	}
}

func TestCopyBoundedStopsAtSignedSize(t *testing.T) {
	var output bytes.Buffer
	written, err := copyBounded(context.Background(), &output, io.LimitReader(bytes.NewReader([]byte("too large")), 9), 3)
	if err == nil || written > 3 {
		t.Fatalf("oversized stream was not bounded: written=%d err=%v", written, err)
	}
}

func TestInboxPruneRemovesOnlyValidatedObjectsAndIsIdempotent(t *testing.T) {
	root := filepath.Join(privateTestRoot(t), "lifecycle")
	inbox, err := OpenInbox(root, uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer inbox.Close()
	data := []byte("committed downstream bytes")
	asset := testAsset("asset.tar.gz", data)
	object, err := inbox.Put(context.Background(), asset, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if err := object.Close(); err != nil {
		t.Fatal(err)
	}
	removed, err := inbox.Prune()
	if err != nil || removed != 1 {
		t.Fatalf("prune removed=%d err=%v", removed, err)
	}
	if _, err := os.Lstat(filepath.Join(root, "inbox", asset.SHA256[len("sha256:"):])); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("digest directory survived prune: %v", err)
	}
	if removed, err := inbox.Prune(); err != nil || removed != 0 {
		t.Fatalf("idempotent prune removed=%d err=%v", removed, err)
	}
}

func TestInboxPrunePreservesEverythingOnUnexpectedEntry(t *testing.T) {
	root := filepath.Join(privateTestRoot(t), "lifecycle")
	inbox, err := OpenInbox(root, uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer inbox.Close()
	data := []byte("preserved failure evidence")
	asset := testAsset("asset", data)
	object, err := inbox.Put(context.Background(), asset, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	_ = object.Close()
	if err := os.WriteFile(filepath.Join(root, "inbox", "unexpected"), []byte("stop"), 0o400); err != nil {
		t.Fatal(err)
	}
	if _, err := inbox.Prune(); err == nil {
		t.Fatal("unexpected inbox entry did not stop cleanup")
	}
	if _, err := os.Lstat(filepath.Join(root, "inbox", asset.SHA256[len("sha256:"):], asset.Name)); err != nil {
		t.Fatalf("validated object was deleted before complete validation: %v", err)
	}
}
