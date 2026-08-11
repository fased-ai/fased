package bundle

import (
	"os"
	"path/filepath"
	"strings"
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

func TestApplicationInventoryRejectsPrivilegedLifecycleExecutables(t *testing.T) {
	for _, name := range []string{"payload/bin/fased-lifecycled", "bin/fased-bootstrap"} {
		t.Run(filepath.Base(name), func(t *testing.T) {
			root := t.TempDir()
			write(t, root, name, "candidate root code", 0o755)
			schemas, capabilities := contract()
			if _, _, err := Inspect(root, "0.1.76", testCommit, testCommit, schemas, capabilities); err == nil || !strings.Contains(err.Error(), "must not contain lifecycle executable") {
				t.Fatalf("application-owned lifecycle executable was accepted: %v", err)
			}
		})
	}
}

func TestDependencyLayerParticipatesInGenerationIdentity(t *testing.T) {
	root := t.TempDir()
	write(t, root, "bin/fased", "binary", 0o755)
	schemas, capabilities := contract()
	layer := DependencyLayer{
		Hash:          strings.Repeat("a", 64),
		Asset:         "fased-hosted-deps-linux-x64-test.tar.gz",
		ArchiveSHA256: "sha256:" + strings.Repeat("b", 64),
	}
	inventory, generation, err := InspectWithDependency(root, "0.1.76", testCommit, testCommit, schemas, capabilities, layer)
	if err != nil {
		t.Fatal(err)
	}
	if inventory.SchemaVersion != CurrentInventorySchemaVersion || inventory.Dependency == nil {
		t.Fatalf("dependency contract was not recorded: %+v", inventory)
	}
	changed := inventory
	copyLayer := *inventory.Dependency
	copyLayer.ArchiveSHA256 = "sha256:" + strings.Repeat("c", 64)
	changed.Dependency = &copyLayer
	if err := Verify(root, changed, generation); err == nil {
		t.Fatal("dependency substitution preserved the generation identity")
	}
}

func TestPluginLockParticipatesInGenerationIdentity(t *testing.T) {
	root := t.TempDir()
	write(t, root, "bin/fased", "binary", 0o755)
	schemas, capabilities := contract()
	layer := DependencyLayer{Hash: strings.Repeat("a", 64), Asset: "fased-hosted-deps-linux-x64-test.tar.gz", ArchiveSHA256: "sha256:" + strings.Repeat("b", 64)}
	lockDigest := "sha256:" + strings.Repeat("c", 64)
	inventory, generation, err := InspectWithDependencyAndPluginLock(root, "0.1.76", testCommit, testCommit, schemas, capabilities, layer, lockDigest)
	if err != nil {
		t.Fatal(err)
	}
	if inventory.PluginLockDigest != lockDigest {
		t.Fatalf("plugin lock was not bound: %+v", inventory)
	}
	changed := inventory
	changed.PluginLockDigest = "sha256:" + strings.Repeat("d", 64)
	if err := Verify(root, changed, generation); err == nil {
		t.Fatal("plugin lock substitution preserved generation identity")
	}
}

func TestVerifyRejectsSubstitutionAndExtraFile(t *testing.T) {
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
}

func TestInspectBindsSafeInTreeSymlinkAndRejectsUnsafeLinks(t *testing.T) {
	root := t.TempDir()
	write(t, root, "bin/fased", "binary", 0o755)
	alias := filepath.Join(root, "bin", "alias")
	if err := os.Symlink("fased", alias); err != nil {
		t.Fatal(err)
	}
	inventory, generation := inspect(t, root)
	if len(inventory.Artifacts) != 2 || inventory.Artifacts[0].Kind != ArtifactSymlink || inventory.Artifacts[0].LinkTarget != "fased" {
		t.Fatalf("safe symlink was not bound exactly: %+v", inventory.Artifacts)
	}
	if err := Verify(root, inventory, generation); err != nil {
		t.Fatalf("safe in-tree symlink did not verify: %v", err)
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside")
	write(t, filepath.Dir(outside), filepath.Base(outside), "outside", 0o644)
	if err := os.Symlink(outside, alias); err != nil {
		t.Fatal(err)
	}
	schemas, capabilities := contract()
	if _, _, err := Inspect(root, "0.1.76", testCommit, testCommit, schemas, capabilities); err == nil {
		t.Fatal("absolute escaping symlink was accepted")
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../outside", alias); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Inspect(root, "0.1.76", testCommit, testCommit, schemas, capabilities); err == nil {
		t.Fatal("relative escaping symlink was accepted")
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

func TestVerifyReportsFirstChangedArtifact(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "runtime.js")
	if err := os.WriteFile(file, []byte("verified"), 0o644); err != nil {
		t.Fatal(err)
	}
	schemas, capabilities := contract()
	inventory, generation, err := Inspect(root, "0.1.76", testCommit, testCommit, schemas, capabilities)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("changed"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Verify(root, inventory, generation); err == nil || !strings.Contains(err.Error(), `artifact identity differs at "runtime.js"`) {
		t.Fatalf("unexpected verification diagnostic: %v", err)
	}
}
