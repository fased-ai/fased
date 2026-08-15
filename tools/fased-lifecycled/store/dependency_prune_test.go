package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"fased-lifecycled/bundle"
	"fased-lifecycled/model"
)

func TestPruneDependenciesRetainsCommittedRollbackReferences(t *testing.T) {
	state, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	retained, stale := installDependencyPruneFixture(t, state)
	temporary := filepath.Join(state.installRoot, "dependencies", ".dependency-AbC123")
	if err := os.Mkdir(temporary, 0o755); err != nil {
		t.Fatal(err)
	}

	removed, err := state.PruneDependencies()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Base(temporary), filepath.Base(state.dependencyArchivePath(stale))}
	if !reflect.DeepEqual(removed, want) {
		t.Fatalf("removed dependencies = %v; want %v", removed, want)
	}
	if _, err := os.Lstat(state.dependencyArchivePath(retained)); err != nil {
		t.Fatalf("retained dependency was removed: %v", err)
	}
	for _, path := range []string{state.dependencyArchivePath(stale), temporary} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("stale dependency remains at %s: %v", path, err)
		}
	}
	if replay, err := state.PruneDependencies(); err != nil || len(replay) != 0 {
		t.Fatalf("dependency pruning replay was not idempotent: removed=%v err=%v", replay, err)
	}
}

func TestPruneDependenciesFailsClosedBeforeDeletingValidStaleLayer(t *testing.T) {
	state, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	_, stale := installDependencyPruneFixture(t, state)
	if err := os.WriteFile(filepath.Join(state.installRoot, "dependencies", "unexpected"), []byte("preserve\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := state.PruneDependencies(); err == nil {
		t.Fatal("unexpected dependency entry did not stop pruning")
	}
	if _, err := os.Lstat(state.dependencyArchivePath(stale)); err != nil {
		t.Fatal("pruning removed a stale layer before validating the complete root")
	}
}

func installDependencyPruneFixture(t *testing.T, state *Store) (bundle.DependencyLayer, bundle.DependencyLayer) {
	t.Helper()
	retained := bundle.DependencyLayer{
		Hash: strings.Repeat("c", 64), Asset: "fased-deps-linux-x64.tar.gz", ArchiveSHA256: "sha256:" + strings.Repeat("d", 64),
	}
	stale := bundle.DependencyLayer{
		Hash: strings.Repeat("e", 64), Asset: "fased-deps-linux-x64-old.tar.gz", ArchiveSHA256: "sha256:" + strings.Repeat("f", 64),
	}
	writeDependencyLayerFixture(t, state, retained)
	writeDependencyLayerFixture(t, state, stale)

	writeGeneration := func(name, version, commit, contents string) model.Generation {
		payload := filepath.Join(t.TempDir(), name, "payload")
		if err := os.MkdirAll(filepath.Join(payload, "runtime"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(payload, "runtime", "fased.mjs"), []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
		inventory, generation, err := bundle.InspectWithDependency(payload, version, commit, commit, manifest().StateSchemas, manifest().Capabilities, retained)
		if err != nil {
			t.Fatal(err)
		}
		data, err := bundle.CanonicalInventoryJSON(inventory)
		if err != nil {
			t.Fatal(err)
		}
		root := state.generationPath(generation.ID)
		if err := os.MkdirAll(root, 0o711); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, generationInventoryName), data, 0o600); err != nil {
			t.Fatal(err)
		}
		return generation
	}
	previous := writeGeneration("previous", "0.1.75", commitA, "previous\n")
	active := writeGeneration("active", "0.1.76", commitB, "active\n")
	want := manifest()
	want.ActiveGeneration = &active
	want.PreviousGeneration = &previous
	if _, err := state.CommitManifest(want, ""); err != nil {
		t.Fatal(err)
	}
	for name, generation := range map[string]model.Generation{"current": active, "previous": previous} {
		target := filepath.ToSlash(filepath.Join("generations", strings.TrimPrefix(generation.ID, "sha256:")))
		if err := os.Symlink(target, filepath.Join(state.installRoot, name)); err != nil {
			t.Fatal(err)
		}
	}
	return retained, stale
}

func writeDependencyLayerFixture(t *testing.T, state *Store, layer bundle.DependencyLayer) {
	t.Helper()
	root := state.dependencyArchivePath(layer)
	if err := os.MkdirAll(filepath.Join(root, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	marker := dependencyMarker{SchemaVersion: 1, Hash: layer.Hash, Asset: layer.Asset, ArchiveSHA256: layer.ArchiveSHA256}
	data, err := json.Marshal(marker)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, dependencyMarkerName), append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}
