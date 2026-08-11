package acquire

import (
	"bytes"
	"context"
	"crypto/sha256"
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

func TestInboxNormalizesRestrictiveUmaskAndBindsOpenObject(t *testing.T) {
	oldMask := syscall.Umask(0o077)
	defer syscall.Umask(oldMask)
	root := filepath.Join(t.TempDir(), "lifecycle")
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
	root := filepath.Join(t.TempDir(), "lifecycle")
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
