package bundle

import (
	"os"
	"path/filepath"
	"testing"
)

const testCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

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

	inventory, generation, err := Inspect(root, "0.1.76", testCommit, testCommit)
	if err != nil {
		t.Fatal(err)
	}
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
	inventory, generation, err := Inspect(root, "0.1.76", testCommit, testCommit)
	if err != nil {
		t.Fatal(err)
	}

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
	if _, _, err := Inspect(root, "0.1.76", testCommit, testCommit); err == nil {
		t.Fatal("symlinked artifact was accepted")
	}
}

func TestInventoryRejectsTraversalAndIdentityMismatch(t *testing.T) {
	root := t.TempDir()
	write(t, root, "bin/fased", "binary", 0o755)
	inventory, generation, err := Inspect(root, "0.1.76", testCommit, testCommit)
	if err != nil {
		t.Fatal(err)
	}
	inventory.Artifacts[0].Path = "../escape"
	if err := Verify(root, inventory, generation); err == nil {
		t.Fatal("inventory traversal was accepted")
	}

	inventory, generation, err = Inspect(root, "0.1.76", testCommit, testCommit)
	if err != nil {
		t.Fatal(err)
	}
	generation.ArtifactSetDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if err := Verify(root, inventory, generation); err == nil {
		t.Fatal("generation identity mismatch was accepted")
	}
}
