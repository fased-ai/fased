package main

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"fased-lifecycled/trust"
)

func TestVerifyReleaseSetUsesProductionRootAndBindsIndexedAssets(t *testing.T) {
	directory := t.TempDir()
	rootJSON, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "release", "lifecycle-trust", "root-v1", "fased-lifecycle-root-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "fased-lifecycle-root-v1.json"), rootJSON, 0o600); err != nil {
		t.Fatal(err)
	}
	root, err := trust.VerifyInitialRootChainLink(rootJSON, productionPinnedRootSHA256)
	if err != nil {
		t.Fatal(err)
	}
	assetBody := []byte("immutable application\n")
	assetDigest := sha256.Sum256(assetBody)
	asset := trust.Asset{Name: "application.tar.gz", Size: uint64(len(assetBody)), SHA256: fmt.Sprintf("sha256:%x", assetDigest)}
	for name, body := range map[string][]byte{
		"application.tar.gz":                assetBody,
		releaseIndexAssetName:               []byte("index\n"),
		releaseIndexAttestationAssetName:    []byte("index bundle\n"),
		releaseRootHeadAssetName:            []byte("head\n"),
		releaseRootHeadAttestationAssetName: []byte("head bundle\n"),
	} {
		if err := os.WriteFile(filepath.Join(directory, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	commit := strings.Repeat("a", 40)
	version := "0.1.76-rc.124"
	indexDigestBytes := sha256.Sum256([]byte("index\n"))
	indexDigest := fmt.Sprintf("%x", indexDigestBytes)
	index := trust.ReleaseIndex{
		Version: version, Commit: commit, ReleaseSequence: 44, SecurityEpoch: 1,
		Application:     map[string]trust.Asset{"x64": asset},
		DependencyLayer: map[string]trust.Asset{}, LifecycleHost: map[string]trust.Asset{}, Signer: map[string]trust.Asset{},
	}
	headDigestBytes := sha256.Sum256([]byte("head\n"))
	headDigest := fmt.Sprintf("%x", headDigestBytes)
	head := trust.RootHead{
		RootVersion: root.Version(), RootSHA256: root.Digest(), ReleaseIndexSHA256: indexDigest,
		ReleaseVersion: version, ReleaseSequence: 44, SecurityEpoch: 1, IndexCommit: commit,
		WitnessRef: "refs/tags/v" + version, WitnessCommit: commit,
	}
	var output bytes.Buffer
	verifyIndex := func(trust.VerifiedRoot, []byte, []byte, time.Time) (trust.ReleaseIndex, string, error) {
		return index, indexDigest, nil
	}
	verifyHead := func([]byte, []byte, time.Time) (trust.RootHead, string, error) {
		return head, headDigest, nil
	}
	if err := verifyReleaseSet(directory, version, commit, time.Date(2026, 8, 23, 0, 0, 0, 0, time.UTC), &output, verifyIndex, verifyHead); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Release set verified: version="+version) {
		t.Fatalf("unexpected output: %s", output.String())
	}
	if err := os.WriteFile(filepath.Join(directory, asset.Name), []byte("changed application\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyReleaseSet(directory, version, commit, time.Date(2026, 8, 23, 0, 0, 0, 0, time.UTC), &bytes.Buffer{}, verifyIndex, verifyHead); err == nil || !strings.Contains(err.Error(), "wrong size") {
		t.Fatalf("expected changed asset rejection, got %v", err)
	}
}

func TestVerifyReleaseSetRejectsNonTagIdentityBeforeTrust(t *testing.T) {
	err := verifyReleaseSet(t.TempDir(), "../rc", strings.Repeat("a", 40), time.Now(), &bytes.Buffer{}, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "identity is invalid") {
		t.Fatalf("expected invalid identity, got %v", err)
	}
}
