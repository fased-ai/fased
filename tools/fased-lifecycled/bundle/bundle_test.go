package bundle

import (
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/model"
)

const testCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func contract() (map[string]uint32, model.CapabilityRanges) {
	return map[string]uint32{"signer": 1}, model.CapabilityRanges{
		Supervisor: model.CapabilityRange{Min: 1, Max: 1},
		Controller: model.CapabilityRange{Min: 1, Max: 1},
		Migrator:   model.CapabilityRange{Min: 1, Max: 1},
		Signer:     model.CapabilityRange{Min: 1, Max: 1},
	}
}

func inspect(t *testing.T, root string) (Inventory, model.Generation) {
	t.Helper()
	schemas, capabilities := contract()
	inventory, generation, err := Inspect(root, "0.1.76", testCommit, testCommit, schemas, capabilities)
	if err != nil {
		t.Fatal(err)
	}
	return inventory, generation
}

func write(t *testing.T, root, name, contents string, mode os.FileMode) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), mode); err != nil {
		t.Fatal(err)
	}
}

func TestInspectAndVerifyExactGeneration(t *testing.T) {
	root := t.TempDir()
	write(t, root, "bin/fased", "binary", 0o755)
	write(t, root, "lib/runtime.js", "runtime", 0o644)

	inventory, generation := inspect(t, root)
	if len(inventory.Artifacts) != 2 || generation.ID != generation.ArtifactSetDigest {
		t.Fatalf("unexpected inventory identity: %+v %+v", inventory, generation)
	}
	if err := Verify(root, inventory, generation); err != nil {
		t.Fatal(err)
	}
	if err := Verify(root, inventory, generation); err != nil {
		t.Fatalf("repeated verification changed result: %v", err)
	}
}

func TestVerifyRejectsSubstitutionExtraFileAndSymlink(t *testing.T) {
	root := t.TempDir()
	write(t, root, "bin/fased", "binary", 0o755)
	inventory, generation := inspect(t, root)

	write(t, root, "bin/fased", "substituted", 0o755)
	if err := Verify(root, inventory, generation); err == nil {
		t.Fatal("artifact substitution was accepted")
	}
	write(t, root, "bin/fased", "binary", 0o755)
	write(t, root, "extra", "unexpected", 0o644)
	if err := Verify(root, inventory, generation); err == nil {
		t.Fatal("unlisted artifact was accepted")
	}
	if err := os.Remove(filepath.Join(root, "extra")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("fased", filepath.Join(root, "bin", "alias")); err != nil {
		t.Fatal(err)
	}
	schemas, capabilities := contract()
	if _, _, err := Inspect(root, "0.1.76", testCommit, testCommit, schemas, capabilities); err == nil {
		t.Fatal("symlinked artifact was accepted")
	}
}

func TestInventoryRejectsTraversalAndIdentityMismatch(t *testing.T) {
	root := t.TempDir()
	write(t, root, "bin/fased", "binary", 0o755)
	inventory, generation := inspect(t, root)
	inventory.Artifacts[0].Path = "../escape"
	if err := Verify(root, inventory, generation); err == nil {
		t.Fatal("inventory traversal was accepted")
	}

	inventory, generation = inspect(t, root)
	generation.ArtifactSetDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if err := Verify(root, inventory, generation); err == nil {
		t.Fatal("generation identity mismatch was accepted")
	}
}
