package statebind

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
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

func TestCanonicalStateSpecsCoverExactDeclaredStateAndRealMiningPath(t *testing.T) {
	owner := "/home/owner/.fased"
	specs := CanonicalSpecs(owner, "/opt/fased/local/instance", "/var/lib/fased-local/instance/signer")
	schemas := model.CurrentStateSchemas()
	if len(specs) != len(schemas) {
		t.Fatalf("canonical state spec count=%d schema count=%d", len(specs), len(schemas))
	}
	seen := map[string]Spec{}
	for _, spec := range specs {
		seen[spec.Name] = spec
	}
	for name := range schemas {
		if _, ok := seen[name]; !ok {
			t.Fatalf("declared state %s has no canonical path", name)
		}
	}
	if seen["mining"].Path != filepath.Join(owner, "sat-mining") || !seen["mining"].IgnoreSQLiteTransient {
		t.Fatalf("Mining state is not bound to the semantic sat-mining root: %+v", seen["mining"])
	}
	if seen["walletRegistry"].Path != filepath.Join(owner, "wallet", "provider-registry.v1.json") {
		t.Fatalf("wallet registry state includes signer sockets or material: %+v", seen["walletRegistry"])
	}
}

func TestMiningInventoryIgnoresSQLiteSidecarsButDetectsDatabaseChange(t *testing.T) {
	root := t.TempDir()
	database := filepath.Join(root, "mining.sqlite")
	wal := database + "-wal"
	if err := os.WriteFile(database, []byte("semantic-state-a"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wal, []byte("transient-a"), 0o600); err != nil {
		t.Fatal(err)
	}
	spec := Spec{Name: "mining", Path: root, MaxFiles: 100, MaxBytes: 1 << 20, IgnoreSQLiteTransient: true}
	first, err := inspectState(context.Background(), spec, 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wal, []byte("transient-b-with-different-size"), 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := inspectState(context.Background(), spec, 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("SQLite transient representation changed semantic inventory: first=%+v second=%+v", first, second)
	}
	if err := os.WriteFile(database, []byte("semantic-state-b"), 0o600); err != nil {
		t.Fatal(err)
	}
	third, err := inspectState(context.Background(), spec, 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if reflect.DeepEqual(second, third) {
		t.Fatal("meaningful Mining database change was not detected")
	}
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
	empty := planner.Installation{Kind: planner.InstallationEmpty}
	first, signerFirst, err := binder.Bind(context.Background(), empty, inventory, plan)
	if err != nil {
		t.Fatal(err)
	}
	second, signerSecond, err := binder.Bind(context.Background(), empty, inventory, plan)
	if err != nil || second != first || signerSecond != signerFirst {
		t.Fatalf("repeated binding changed: first=%s/%s second=%s/%s err=%v", first, signerFirst, second, signerSecond, err)
	}
	if err := os.WriteFile(file, []byte("state-b"), 0o600); err != nil {
		t.Fatal(err)
	}
	changed, _, err := binder.Bind(context.Background(), empty, inventory, plan)
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
	empty := planner.Installation{Kind: planner.InstallationEmpty}
	badPlan := plan
	badPlan.Digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if _, _, err := binder.Bind(context.Background(), empty, inventory, badPlan); err == nil {
		t.Fatal("noncanonical plan was accepted")
	}
	if err := os.Symlink(original, filepath.Join(state, "alias")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := binder.Bind(context.Background(), empty, inventory, plan); err == nil {
		t.Fatal("symlinked state was accepted")
	}
	if err := os.Remove(filepath.Join(state, "alias")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(original, filepath.Join(state, "hardlink")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := binder.Bind(context.Background(), empty, inventory, plan); err == nil {
		t.Fatal("multiply linked state was accepted")
	}
	missing := Binder{Specs: []Spec{{Name: "signer", Path: filepath.Join(t.TempDir(), "missing")}}}
	platform, _ := model.NewPlatformIdentity(model.ProfileProtectedLocal, "test-instance", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	installed := model.Manifest{SchemaVersion: 1, Profile: model.ProfileProtectedLocal, Platform: platform,
		ActiveGeneration: &generation, StateSchemas: inventory.StateSchemas, Capabilities: inventory.Capabilities}
	installedPlan, err := planner.Build(&installed, planner.Target{Profile: model.ProfileProtectedLocal, Generation: generation, StateSchemas: inventory.StateSchemas, Capabilities: inventory.Capabilities})
	if err != nil {
		t.Fatal(err)
	}
	managed := planner.Installation{Kind: planner.InstallationManaged, Manifest: &installed}
	if _, _, err := missing.Bind(context.Background(), managed, inventory, installedPlan); err == nil {
		t.Fatal("missing installed state was accepted")
	}
}

func TestBindCanTreatInstallationAsRootIdentityWithoutTraversingSelectors(t *testing.T) {
	inventory, generation := target(t)
	plan, err := planner.Build(nil, planner.Target{Profile: model.ProfileProtectedLocal, Generation: generation, StateSchemas: inventory.StateSchemas, Capabilities: inventory.Capabilities})
	if err != nil {
		t.Fatal(err)
	}
	install := t.TempDir()
	if err := os.MkdirAll(filepath.Join(install, "releases", "one"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("releases/one", filepath.Join(install, "current")); err != nil {
		t.Fatal(err)
	}
	binder := Binder{Specs: []Spec{{Name: "signer", Path: install, RootOnly: true}}}
	if _, _, err := binder.Bind(context.Background(), planner.Installation{Kind: planner.InstallationEmpty}, inventory, plan); err != nil {
		t.Fatalf("installation selector was treated as protected user state: %v", err)
	}
}
