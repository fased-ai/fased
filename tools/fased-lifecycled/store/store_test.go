package store

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"fased-lifecycled/bundle"
	"fased-lifecycled/model"
)

func writeGenerationArchive(t *testing.T, archive, source string) {
	t.Helper()
	output, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	compressed := gzip.NewWriter(output)
	written := tar.NewWriter(compressed)
	err = filepath.Walk(source, func(current string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, relErr := filepath.Rel(filepath.Dir(source), current)
		if relErr != nil {
			return relErr
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			link, relErr = os.Readlink(current)
			if relErr != nil {
				return relErr
			}
		}
		header, headerErr := tar.FileInfoHeader(info, link)
		if headerErr != nil {
			return headerErr
		}
		header.Name = filepath.ToSlash(relative)
		if info.IsDir() {
			header.Name += "/"
		}
		if headerErr := written.WriteHeader(header); headerErr != nil {
			return headerErr
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		input, openErr := os.Open(current)
		if openErr != nil {
			return openErr
		}
		_, copyErr := io.Copy(written, input)
		closeErr := input.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
	if err == nil {
		err = written.Close()
	}
	if err == nil {
		err = compressed.Close()
	}
	if err == nil {
		err = output.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
}

func writeRawGenerationArchive(t *testing.T, archive string, headers []*tar.Header) {
	t.Helper()
	output, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	compressed := gzip.NewWriter(output)
	written := tar.NewWriter(compressed)
	for _, header := range headers {
		if err := written.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
	}
	if err := written.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}
}

const (
	digestA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	digestB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	commitA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	commitB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func generation(id, version, commit string) model.Generation {
	return model.Generation{ID: id, Version: version, Commit: commit, Tree: commit, ArtifactSetDigest: id}
}

func manifest() model.Manifest {
	active := generation(digestB, "0.1.76", commitB)
	previous := generation(digestA, "0.1.75", commitA)
	platform, _ := model.NewPlatformIdentity(model.ProfileProtectedLocal, "test-instance", digestA)
	return model.Manifest{
		SchemaVersion:      model.CurrentManifestSchemaVersion,
		Profile:            model.ProfileProtectedLocal,
		Platform:           platform,
		ActiveGeneration:   &active,
		PreviousGeneration: &previous,
		StateSchemas:       map[string]uint32{"signer": 2, "walletRegistry": 1},
		Capabilities: model.CapabilityRanges{
			Supervisor: model.CapabilityRange{Min: 1, Max: 1},
			Controller: model.CapabilityRange{Min: 1, Max: 2},
			Migrator:   model.CapabilityRange{Min: 1, Max: 1},
			Signer:     model.CapabilityRange{Min: 2, Max: 3},
		},
	}
}

func transaction(phase model.Phase) model.Transaction {
	previous := generation(digestA, "0.1.75", commitA)
	return model.Transaction{
		SchemaVersion:        model.CurrentTransactionSchemaVersion,
		ID:                   "018f47d2-5a6b-7c8d-9e0f-123456789abc",
		Profile:              model.ProfileProtectedLocal,
		Phase:                phase,
		Revision:             1,
		Target:               generation(digestB, "0.1.76", commitB),
		TargetStateSchemas:   map[string]uint32{"signer": 2},
		TargetCapabilities:   manifest().Capabilities,
		Previous:             &previous,
		ManifestDigest:       digestA,
		StateInventoryDigest: digestB,
		MigrationPlanDigest:  digestA,
		SignerPlanDigest:     digestB,
		PlatformDigest:       digestA,
	}
}

func TestManifestCompareAndSwapIsCanonicalAndIdempotent(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	digest, err := store.CommitManifest(manifest(), "")
	if err != nil {
		t.Fatal(err)
	}
	if digest == "" {
		t.Fatal("empty manifest digest")
	}
	got, gotDigest, err := store.ReadManifest()
	if err != nil {
		t.Fatal(err)
	}
	if gotDigest != digest || got.ActiveGeneration.ID != digestB {
		t.Fatalf("unexpected manifest read: digest=%s manifest=%+v", gotDigest, got)
	}
	if second, err := store.CommitManifest(manifest(), digest); err != nil || second != digest {
		t.Fatalf("idempotent manifest commit failed: digest=%s err=%v", second, err)
	}
	if _, err := store.CommitManifest(manifest(), digestB); err == nil {
		t.Fatal("stale manifest compare-and-swap succeeded")
	}
}

func TestAuthorityJournalsRequireLinearBoundTransitions(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	start := transaction(model.PhaseIdle)
	if err := store.CommitJournal(AuthoritySupervisor, start); err != nil {
		t.Fatal(err)
	}
	staged, err := model.Advance(start, model.PhaseStaged)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CommitJournal(AuthoritySupervisor, staged); err != nil {
		t.Fatal(err)
	}
	if err := store.CommitJournal(AuthoritySupervisor, staged); err != nil {
		t.Fatalf("idempotent journal commit failed: %v", err)
	}

	skipped := staged
	skipped.Phase = model.PhaseSwitched
	skipped.Revision++
	if err := store.CommitJournal(AuthoritySupervisor, skipped); err == nil {
		t.Fatal("skipped phase was committed")
	}

	rebound := staged
	rebound.Target = generation(digestA, "0.1.75", commitA)
	rebound.Revision++
	if err := store.CommitJournal(AuthoritySupervisor, rebound); err == nil {
		t.Fatal("journal identity mutation was committed")
	}

	if err := store.CommitJournal(AuthorityTargetController, start); err != nil {
		t.Fatalf("separate target-controller journal failed: %v", err)
	}
	got, err := store.ReadJournal(AuthorityTargetController, start.ID)
	if err != nil || got.Phase != model.PhaseIdle {
		t.Fatalf("unexpected target journal: %+v err=%v", got, err)
	}
}

func TestStoreRejectsSymlinkedDurableFiles(t *testing.T) {
	root := t.TempDir()
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "outside.json")
	if err := os.WriteFile(target, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, manifestName)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.ReadManifest(); err == nil {
		t.Fatal("symlinked manifest was accepted")
	}
}

func TestGenerationInventoryHasItsOwnBoundedSizeClass(t *testing.T) {
	root := t.TempDir()
	inventoryPath := filepath.Join(root, generationInventoryName)
	data := bytes.Repeat([]byte{'a'}, maxDurableRecordSize+1)
	if err := os.WriteFile(inventoryPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readRegular(inventoryPath); err == nil {
		t.Fatal("oversized durable record was accepted")
	}
	got, err := readGenerationInventory(inventoryPath)
	if err != nil {
		t.Fatalf("valid generation inventory size was rejected: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("generation inventory bytes changed while reading")
	}
	if err := os.Truncate(inventoryPath, maxGenerationInventorySize+1); err != nil {
		t.Fatal(err)
	}
	if _, err := readGenerationInventory(inventoryPath); err == nil {
		t.Fatal("oversized generation inventory was accepted")
	}
}

func TestStageAndActivateUseOnlyContentAddressedStorePaths(t *testing.T) {
	root := t.TempDir()
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	payload := filepath.Join(root, "source")
	if err := os.MkdirAll(filepath.Join(payload, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payload, "bin", "fased"), []byte("verified"), 0o755); err != nil {
		t.Fatal(err)
	}
	stateSchemas := map[string]uint32{"signer": 1}
	capabilities := manifest().Capabilities
	inventory, expected, err := bundle.Inspect(payload, "0.1.76", commitB, commitB, stateSchemas, capabilities)
	if err != nil {
		t.Fatal(err)
	}
	inbox := store.inboxGenerationPath(expected.ID)
	if err := os.MkdirAll(inbox, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(payload, filepath.Join(inbox, generationPayloadName)); err != nil {
		t.Fatal(err)
	}
	inventoryJSON, err := bundle.CanonicalInventoryJSON(inventory)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inbox, generationInventoryName), inventoryJSON, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := store.StageGeneration(expected.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.StageGeneration(expected.ID); err != nil {
		t.Fatalf("idempotent staging failed: %v", err)
	}
	if err := store.ActivateGeneration(expected.ID, ""); err != nil {
		t.Fatal(err)
	}
	current, err := store.ResolveGeneration("current")
	if err != nil || current != expected {
		t.Fatalf("unexpected active generation: %+v err=%v", current, err)
	}
	if _, err := store.ResolveGeneration("../../escape"); err == nil {
		t.Fatal("arbitrary pointer selection was accepted")
	}
}

func TestImportGenerationCopiesAndReverifiesExactBytes(t *testing.T) {
	root := t.TempDir()
	state, err := Open(filepath.Join(root, "state"))
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "external-generation")
	payload := filepath.Join(source, generationPayloadName)
	if err := os.MkdirAll(filepath.Join(payload, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payload, "bin", "fased"), []byte("verified"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("fased", filepath.Join(payload, "bin", "alias")); err != nil {
		t.Fatal(err)
	}
	inventory, expected, err := bundle.Inspect(payload, "0.1.76", commitB, commitB,
		map[string]uint32{"signer": 1}, manifest().Capabilities)
	if err != nil {
		t.Fatal(err)
	}
	data, err := bundle.CanonicalInventoryJSON(inventory)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, generationInventoryName), data, 0o600); err != nil {
		t.Fatal(err)
	}

	imported, err := state.ImportGeneration(source)
	if err != nil || imported != expected {
		t.Fatalf("unexpected import: %+v err=%v", imported, err)
	}
	if second, err := state.ImportGeneration(source); err != nil || second != expected {
		t.Fatalf("idempotent import failed: %+v err=%v", second, err)
	}
	importedAlias := filepath.Join(state.inboxGenerationPath(expected.ID), generationPayloadName, "bin", "alias")
	if target, err := os.Readlink(importedAlias); err != nil || target != "fased" {
		t.Fatalf("safe imported symlink was not preserved: target=%q err=%v", target, err)
	}
	if err := os.WriteFile(filepath.Join(payload, "bin", "fased"), []byte("substituted"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := state.ImportGeneration(source); err == nil {
		t.Fatal("tampered import source was accepted")
	}
}

func TestImportGenerationArchiveExtractsDirectlyAndReverifiesExactBytes(t *testing.T) {
	root := t.TempDir()
	state, err := Open(filepath.Join(root, "state"))
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "generation")
	payload := filepath.Join(source, generationPayloadName)
	if err := os.MkdirAll(filepath.Join(payload, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payload, "bin", "fased"), []byte("verified"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("fased", filepath.Join(payload, "bin", "alias")); err != nil {
		t.Fatal(err)
	}
	inventory, expected, err := bundle.Inspect(payload, "0.1.76", commitB, commitB,
		map[string]uint32{"signer": 1}, manifest().Capabilities)
	if err != nil {
		t.Fatal(err)
	}
	data, err := bundle.CanonicalInventoryJSON(inventory)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, generationInventoryName), data, 0o600); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(root, "generation.tar.gz")
	writeGenerationArchive(t, archive, source)

	previousUmask := syscall.Umask(0o117)
	imported, err := state.ImportGenerationArchive(archive)
	syscall.Umask(previousUmask)
	if err != nil || imported != expected {
		t.Fatalf("unexpected archive import: %+v err=%v", imported, err)
	}
	importedExecutable := filepath.Join(
		state.inboxGenerationPath(expected.ID),
		generationPayloadName,
		"bin",
		"fased",
	)
	info, statErr := os.Stat(importedExecutable)
	if statErr != nil {
		t.Fatal(statErr)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("archived executable mode = %04o; want 0755", info.Mode().Perm())
	}
	importedRootInfo, statErr := os.Stat(state.inboxGenerationPath(expected.ID))
	if statErr != nil {
		t.Fatal(statErr)
	}
	if importedRootInfo.Mode().Perm() != 0o711 {
		t.Fatalf("archived generation mode = %04o; want 0711", importedRootInfo.Mode().Perm())
	}
	if second, err := state.ImportGenerationArchive(archive); err != nil || second != expected {
		t.Fatalf("idempotent archive import failed: %+v err=%v", second, err)
	}
	importedAlias := filepath.Join(state.inboxGenerationPath(expected.ID), generationPayloadName, "bin", "alias")
	if target, err := os.Readlink(importedAlias); err != nil || target != "fased" {
		t.Fatalf("safe archived symlink was not preserved: target=%q err=%v", target, err)
	}
}

func TestGenerationArchiveExtractionRejectsTraversalAndEscapingSymlinks(t *testing.T) {
	for name, malicious := range map[string]*tar.Header{
		"traversal": {
			Name:     "generation/../../outside",
			Typeflag: tar.TypeReg,
			Mode:     0o600,
		},
		"absolute symlink": {
			Name:     "generation/payload/escape",
			Typeflag: tar.TypeSymlink,
			Linkname: "/tmp/outside",
		},
		"relative symlink": {
			Name:     "generation/payload/escape",
			Typeflag: tar.TypeSymlink,
			Linkname: "../../../outside",
		},
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			archive := filepath.Join(root, "malicious.tar.gz")
			writeRawGenerationArchive(t, archive, []*tar.Header{
				{Name: "generation/", Typeflag: tar.TypeDir, Mode: 0o700},
				{Name: "generation/payload/", Typeflag: tar.TypeDir, Mode: 0o755},
				malicious,
			})
			destination := filepath.Join(root, "destination")
			if err := os.Mkdir(destination, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := extractGenerationArchive(archive, destination); err == nil {
				t.Fatal("unsafe archive entry was accepted")
			}
		})
	}
}

func TestCopyRegularTreePreservesExecutableModeUnderRestrictiveUmask(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	destination := filepath.Join(root, "destination")
	if err := os.MkdirAll(filepath.Join(source, generationPayloadName, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(destination, 0o700); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(source, generationPayloadName, "bin", "launcher")
	if err := os.WriteFile(launcher, []byte("exact"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, generationInventoryName), []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	previousUmask := syscall.Umask(0o117)
	defer syscall.Umask(previousUmask)
	if err := copyRegularTree(source, destination); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(destination, generationPayloadName, "bin", "launcher"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("copied executable mode is %04o, expected 0755", info.Mode().Perm())
	}
	for _, directory := range []string{".", generationPayloadName, filepath.Join(generationPayloadName, "bin")} {
		directoryInfo, err := os.Stat(filepath.Join(destination, directory))
		if err != nil {
			t.Fatal(err)
		}
		expected := os.FileMode(0o755)
		if directory == "." {
			expected = 0o711
		}
		if directoryInfo.Mode().Perm() != expected {
			t.Fatalf("copied directory %s mode is %04o, expected %04o", directory, directoryInfo.Mode().Perm(), expected)
		}
	}
	inventoryInfo, err := os.Stat(filepath.Join(destination, generationInventoryName))
	if err != nil {
		t.Fatal(err)
	}
	if inventoryInfo.Mode().Perm() != 0o600 {
		t.Fatalf("copied inventory mode is %04o, expected 0600", inventoryInfo.Mode().Perm())
	}
}

func TestStoreMakesOnlyGenerationTraversalPublic(t *testing.T) {
	root := filepath.Join(t.TempDir(), "lifecycle")
	previousUmask := syscall.Umask(0o117)
	defer syscall.Umask(previousUmask)
	state, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	rootInfo, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	if rootInfo.Mode().Perm() != 0o711 {
		t.Fatalf("lifecycle root is not traverse-only: mode=%04o", rootInfo.Mode().Perm())
	}
	if err := os.MkdirAll(filepath.Join(root, "inbox"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(root, "inbox"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := state.StageGeneration(digestA); err == nil {
		// No generation exists; the call must fail before making any target.
		t.Fatal("missing generation was staged")
	}
	inboxInfo, err := os.Stat(filepath.Join(root, "inbox"))
	if err != nil {
		t.Fatal(err)
	}
	if inboxInfo.Mode().Perm() != 0o700 {
		t.Fatalf("inbox lost root-only mode: mode=%04o", inboxInfo.Mode().Perm())
	}
}

func TestStageRejectsTamperedInboxWithoutMovingIt(t *testing.T) {
	root := t.TempDir()
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	payload := filepath.Join(root, "source")
	if err := os.MkdirAll(payload, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payload, "fased"), []byte("verified"), 0o755); err != nil {
		t.Fatal(err)
	}
	stateSchemas := map[string]uint32{"signer": 1}
	capabilities := manifest().Capabilities
	inventory, expected, err := bundle.Inspect(payload, "0.1.76", commitB, commitB, stateSchemas, capabilities)
	if err != nil {
		t.Fatal(err)
	}
	inbox := store.inboxGenerationPath(expected.ID)
	if err := os.MkdirAll(inbox, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(payload, filepath.Join(inbox, generationPayloadName)); err != nil {
		t.Fatal(err)
	}
	inventoryJSON, err := bundle.CanonicalInventoryJSON(inventory)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inbox, generationInventoryName), inventoryJSON, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inbox, generationPayloadName, "fased"), []byte("tampered"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := store.StageGeneration(expected.ID); err == nil {
		t.Fatal("tampered inbox was staged")
	}
	if _, err := os.Stat(inbox); err != nil {
		t.Fatalf("failed staging moved or deleted inbox: %v", err)
	}
}
