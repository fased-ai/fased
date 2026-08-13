package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"fased-lifecycled/model"
	"fased-lifecycled/trust"
)

func TestRunWritesCanonicalReleaseIndexWithoutAnotherReleaseKey(t *testing.T) {
	directory := t.TempDir()
	now := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
	asset := trust.Asset{Name: "asset-x64", Size: 1, SHA256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	index := trust.ReleaseIndex{SchemaVersion: 1, Type: "fased-release-index", Channel: "beta", Version: "0.1.76-rc.74", ReleaseSequence: 12, SecurityEpoch: 3,
		Commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Tree: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ArtifactSetDigest: asset.SHA256,
		Application: map[string]trust.Asset{"x64": asset}, DependencyLayer: map[string]trust.Asset{"x64": asset}, LifecycleHost: map[string]trust.Asset{"x64": {Name: "fased-lifecycled-linux-x64", Size: 1, SHA256: asset.SHA256, PrivilegedComponent: "lifecycle-host", Protocols: &trust.HostProtocols{Manifest: trust.ProtocolRange{Min: 2, Max: 2}, Journal: trust.ProtocolRange{Min: 1, Max: 1}, Participant: trust.ProtocolRange{Min: 1, Max: 1}, Platform: trust.ProtocolRange{Min: 1, Max: 2}}}}, Signer: map[string]trust.Asset{"x64": asset},
		StateSchemas: map[string]uint32{"signer": 2}, Capabilities: model.CapabilityRanges{Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1}, Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1}},
		PluginLockDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", IssuedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(4 * 365 * 24 * time.Hour).Format(time.RFC3339)}
	input, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	inputPath := filepath.Join(directory, "index.json")
	outputPath := filepath.Join(directory, "fased-release-index-v1.json")
	if err := os.WriteFile(inputPath, input, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--input", inputPath, "--output", outputPath}, os.Stderr); err != nil {
		t.Fatal(err)
	}
	output, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	want, err := trust.EncodeReleaseIndex(index)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(output, want) {
		t.Fatal("release index output is not canonical")
	}
	if bytes.Contains(output, []byte("privateKey")) || bytes.Contains(output, []byte("delegation")) {
		t.Fatal("release index unexpectedly contains a second release-key authority")
	}
	if info, err := os.Stat(outputPath); err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("release index mode is unsafe: info=%v err=%v", info, err)
	}
}

func TestRunRequiresOnlyInputAndOutput(t *testing.T) {
	if err := run([]string{"--private-key", "forbidden"}, os.Stderr); err == nil {
		t.Fatal("obsolete private-key release authority was accepted")
	}
}
