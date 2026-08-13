package main

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"fased-lifecycled/model"
	"fased-lifecycled/trust"
)

func TestRunBuildsVerifiableExactBranchMetadata(t *testing.T) {
	dir := t.TempDir()
	version := "0.1.76-rc.73"
	for name, body := range map[string]string{
		"fased-generation-linux-x64-v" + version + ".tar.gz": "generation",
		"fased-hosted-deps-linux-x64-lock.tar.gz":            "dependencies",
		"fased-lifecycled-linux-amd64":                       "host",
		"fased-signerd-linux-amd64":                          "signer",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	inv := inventory{PluginLockDigest: "sha256:" + strings.Repeat("c", 64), StateSchemas: map[string]uint32{"signer": 2}, Capabilities: model.CapabilityRanges{
		Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1}, Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 2, Max: 2},
	}}
	data, _ := json.Marshal(inv)
	inventoryPath := filepath.Join(dir, "inventory.json")
	if err := os.WriteFile(inventoryPath, data, 0644); err != nil {
		t.Fatal(err)
	}
	issued := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
	commit, tree := strings.Repeat("a", 40), strings.Repeat("b", 40)
	if err := run([]string{"--artifact-dir", dir, "--inventory", inventoryPath, "--version", version, "--commit", commit, "--tree", tree,
		"--artifact-set-digest", "sha256:" + strings.Repeat("d", 64), "--issued-at", issued.Format(time.RFC3339),
		"--release-sequence", "12", "--security-epoch", "3"}); err != nil {
		t.Fatal(err)
	}
	rootJSON, _ := os.ReadFile(filepath.Join(dir, "fased-branch-root.json"))
	pinText, _ := os.ReadFile(filepath.Join(dir, "fased-branch-root.sha256"))
	if _, err := hex.DecodeString(strings.TrimSpace(string(pinText))); err != nil {
		t.Fatal(err)
	}
	root, err := trust.VerifyInitialRoot(rootJSON, strings.TrimSpace(string(pinText)), issued)
	if err != nil {
		t.Fatal(err)
	}
	delegationJSON, _ := os.ReadFile(filepath.Join(dir, "fased-branch-delegation.json"))
	delegation, err := trust.VerifyDelegation(root, delegationJSON, issued)
	if err != nil {
		t.Fatal(err)
	}
	indexJSON, _ := os.ReadFile(filepath.Join(dir, "fased-branch-release-index.json"))
	verified, err := trust.VerifyReleaseIndex(delegation, indexJSON, issued)
	if err != nil {
		t.Fatal(err)
	}
	index := verified.Index()
	if index.Version != version || index.ReleaseSequence != 12 || index.SecurityEpoch != 3 || index.Application["x64"].Name != "fased-generation-linux-x64-v"+version+".tar.gz" || index.PluginLockDigest != inv.PluginLockDigest {
		t.Fatalf("branch metadata lost exact identity: %+v", index)
	}
}
