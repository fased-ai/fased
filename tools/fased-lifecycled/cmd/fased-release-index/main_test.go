package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"

	"fased-lifecycled/model"
	"fased-lifecycled/trust"
)

func TestRunSignsCanonicalReleaseIndexWithoutExposingKeyMaterial(t *testing.T) {
	directory := t.TempDir()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	keyDigest := sha256.Sum256(publicDER)
	keyID := hex.EncodeToString(keyDigest[:])
	privateDER, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(directory, "release-key.pem")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
	asset := trust.Asset{Name: "asset-x64", Size: 1, SHA256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	index := trust.ReleaseIndex{SchemaVersion: 1, Type: "fased-release-index", Channel: "beta", Version: "0.1.76-rc.74", ReleaseSequence: 12, SecurityEpoch: 3,
		Commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Tree: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ArtifactSetDigest: asset.SHA256,
		Application: map[string]trust.Asset{"x64": asset}, DependencyLayer: map[string]trust.Asset{"x64": asset}, LifecycleHost: map[string]trust.Asset{"x64": {Name: "fased-lifecycled-linux-x64", Size: 1, SHA256: asset.SHA256, PrivilegedComponent: "lifecycle-host", Protocols: &trust.HostProtocols{Manifest: trust.ProtocolRange{Min: 2, Max: 2}, Journal: trust.ProtocolRange{Min: 1, Max: 1}, Participant: trust.ProtocolRange{Min: 1, Max: 1}, Platform: trust.ProtocolRange{Min: 1, Max: 2}}}}, Signer: map[string]trust.Asset{"x64": asset},
		StateSchemas: map[string]uint32{"signer": 2}, Capabilities: model.CapabilityRanges{Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1}, Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1}},
		PluginLockDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", IssuedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339)}
	input, err := json.Marshal(index)
	if err != nil {
		t.Fatal(err)
	}
	inputPath := filepath.Join(directory, "index.json")
	outputPath := filepath.Join(directory, "index.signed.json")
	if err := os.WriteFile(inputPath, input, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--input", inputPath, "--private-key", keyPath, "--key-id", keyID, "--output", outputPath}, os.Stderr); err != nil {
		t.Fatal(err)
	}
	output, err := os.ReadFile(outputPath)
	if err != nil || len(output) == 0 {
		t.Fatalf("signed index was not written: bytes=%d err=%v", len(output), err)
	}
	if info, err := os.Stat(outputPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("signed index mode is unsafe: info=%v err=%v", info, err)
	}
}

func TestRunRejectsPermissivePrivateKey(t *testing.T) {
	directory := t.TempDir()
	keyPath := filepath.Join(directory, "release-key.pem")
	if err := os.WriteFile(keyPath, []byte("not a key"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readPrivateKey(keyPath); err == nil {
		t.Fatal("group-readable release key was accepted")
	}
}
