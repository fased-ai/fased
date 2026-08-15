package store

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPruneGenerationsRetainsCommittedRollbackWindow(t *testing.T) {
	state, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	staleID := "sha256:" + strings.Repeat("c", 64)
	installPruneFixture(t, state, staleID)

	removed, err := state.PruneGenerations()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(removed, []string{staleID}) {
		t.Fatalf("removed generations = %v; want %v", removed, []string{staleID})
	}
	for _, id := range []string{digestA, digestB} {
		if info, err := os.Lstat(state.generationPath(id)); err != nil || !info.IsDir() {
			t.Fatalf("retained generation %s was removed: %v", id, err)
		}
	}
	if _, err := os.Lstat(state.generationPath(staleID)); !os.IsNotExist(err) {
		t.Fatalf("stale generation remains: %v", err)
	}
	if replay, err := state.PruneGenerations(); err != nil || len(replay) != 0 {
		t.Fatalf("pruning replay was not idempotent: removed=%v err=%v", replay, err)
	}
}

func TestPruneGenerationsFailsClosedOnUnexpectedEntry(t *testing.T) {
	state, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	staleID := "sha256:" + strings.Repeat("c", 64)
	installPruneFixture(t, state, staleID)
	if err := os.WriteFile(filepath.Join(state.installRoot, "generations", "unexpected"), []byte("do not remove"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := state.PruneGenerations(); err == nil {
		t.Fatal("unexpected generation entry did not stop pruning")
	}
	if _, err := os.Lstat(state.generationPath(staleID)); err != nil {
		t.Fatal("pruning mutated stale generations before validating the complete root")
	}
}

func installPruneFixture(t *testing.T, state *Store, staleID string) {
	t.Helper()
	root := filepath.Join(state.installRoot, "generations")
	if err := os.MkdirAll(root, 0o711); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{digestA, digestB, staleID} {
		if err := os.Mkdir(state.generationPath(id), 0o711); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.ToSlash(filepath.Join("generations", strings.TrimPrefix(digestB, "sha256:"))), filepath.Join(state.installRoot, "current")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.ToSlash(filepath.Join("generations", strings.TrimPrefix(digestA, "sha256:"))), filepath.Join(state.installRoot, "previous")); err != nil {
		t.Fatal(err)
	}
	if _, err := state.CommitManifest(manifest(), ""); err != nil {
		t.Fatal(err)
	}
}
