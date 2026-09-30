package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWENPortableSnapshotIntegrity(t *testing.T) {
	raw, err := os.ReadFile("testdata/wen-protocol/source-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Files []struct {
			Path           string `json:"path"`
			SnapshotSHA256 string `json:"snapshotSha256"`
		} `json:"files"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Files) == 0 {
		t.Fatal("empty portable snapshot")
	}
	for _, file := range manifest.Files {
		if filepath.IsAbs(file.Path) || strings.Contains(file.Path, "..") {
			t.Fatal("invalid snapshot path")
		}
		bytes, err := os.ReadFile(filepath.Join("testdata/wen-protocol", file.Path))
		if err != nil {
			t.Fatal(err)
		}
		if wenHashV1(bytes) != file.SnapshotSHA256 {
			t.Fatalf("portable snapshot changed: %s", file.Path)
		}
	}
}
