package store

import (
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/bundle"
	"fased-lifecycled/model"
)

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
