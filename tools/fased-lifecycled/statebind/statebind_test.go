package statebind

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/bundle"
	"fased-lifecycled/model"
	"fased-lifecycled/planner"
)

const testCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func target(t *testing.T) (bundle.Inventory, model.Generation) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "fased"), []byte("generation"), 0o755); err != nil {
		t.Fatal(err)
	}
	capabilities := model.CapabilityRanges{
		Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1},
		Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1},
	}
	inventory, generation, err := bundle.Inspect(root, "0.1.76", testCommit, testCommit, map[string]uint32{"signer": 1}, capabilities)
	if err != nil {
		t.Fatal(err)
	}
	return inventory, generation
}

func TestBindIsDeterministicAndDetectsStateChange(t *testing.T) {
	inventory, generation := target(t)
	state := t.TempDir()
	file := filepath.Join(state, "signer.db")
	if err := os.WriteFile(file, []byte("state-a"), 0o600); err != nil {
		t.Fatal(err)
	}
	plan, err := planner.Build(nil, planner.Target{Profile: model.ProfileProtectedLocal, Generation: generation, StateSchemas: inventory.StateSchemas, Capabilities: inventory.Capabilities})
	if err != nil {
		t.Fatal(err)
	}
	binder := Binder{Specs: []Spec{{Name: "signer", Path: state}}}
	first, signerFirst, err := binder.Bind(context.Background(), nil, inventory, plan)
	if err != nil {
		t.Fatal(err)
	}
	second, signerSecond, err := binder.Bind(context.Background(), nil, inventory, plan)
	if err != nil || second != first || signerSecond != signerFirst {
		t.Fatalf("repeated binding changed: first=%s/%s second=%s/%s err=%v", first, signerFirst, second, signerSecond, err)
	}
	if err := os.WriteFile(file, []byte("state-b"), 0o600); err != nil {
		t.Fatal(err)
	}
	changed, _, err := binder.Bind(context.Background(), nil, inventory, plan)
	if err != nil || changed == first {
		t.Fatalf("state substitution was not reflected: digest=%s err=%v", changed, err)
	}
}

func TestBindRejectsSymlinkHardlinkMissingAndNoncanonicalPlan(t *testing.T) {
	inventory, generation := target(t)
	plan, err := planner.Build(nil, planner.Target{Profile: model.ProfileProtectedLocal, Generation: generation, StateSchemas: inventory.StateSchemas, Capabilities: inventory.Capabilities})
	if err != nil {
		t.Fatal(err)
	}
	state := t.TempDir()
	original := filepath.Join(state, "signer.db")
	if err := os.WriteFile(original, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	binder := Binder{Specs: []Spec{{Name: "signer", Path: state}}}
	badPlan := plan
	badPlan.Digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if _, _, err := binder.Bind(context.Background(), nil, inventory, badPlan); err == nil {
		t.Fatal("noncanonical plan was accepted")
	}
	if err := os.Symlink(original, filepath.Join(state, "alias")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := binder.Bind(context.Background(), nil, inventory, plan); err == nil {
		t.Fatal("symlinked state was accepted")
	}
	if err := os.Remove(filepath.Join(state, "alias")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(original, filepath.Join(state, "hardlink")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := binder.Bind(context.Background(), nil, inventory, plan); err == nil {
		t.Fatal("multiply linked state was accepted")
	}
	missing := Binder{Specs: []Spec{{Name: "signer", Path: filepath.Join(t.TempDir(), "missing")}}}
	platform, _ := model.NewPlatformIdentity(model.ProfileProtectedLocal, "test-instance")
	installed := model.Manifest{SchemaVersion: 1, Profile: model.ProfileProtectedLocal, Platform: platform,
		ActiveGeneration: &generation, StateSchemas: inventory.StateSchemas, Capabilities: inventory.Capabilities}
	installedPlan, err := planner.Build(&installed, planner.Target{Profile: model.ProfileProtectedLocal, Generation: generation, StateSchemas: inventory.StateSchemas, Capabilities: inventory.Capabilities})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := missing.Bind(context.Background(), &installed, inventory, installedPlan); err == nil {
		t.Fatal("missing installed state was accepted")
	}
}
