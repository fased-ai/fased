package platform

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"fased-lifecycled/model"
)

func repairManifest(tx model.Transaction, identity model.PlatformIdentity) model.Manifest {
	return model.Manifest{
		SchemaVersion: model.CurrentManifestSchemaVersion,
		Profile:       tx.Profile, Platform: identity, ActiveGeneration: &tx.Target,
		PreviousGeneration: tx.Previous, StateSchemas: tx.TargetStateSchemas,
		Capabilities: tx.TargetCapabilities, ReleaseSequence: tx.ReleaseSequence, SecurityEpoch: tx.SecurityEpoch,
	}
}

func TestRepairCurrentRegeneratesExactProjectionAndProvesLiveGeneration(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	manifest := repairManifest(tx, adapter.Identity)
	adapter.Manifest = fakeManifestReader{manifest: manifest}
	generations := adapter.Generations.(fakeGenerations)
	generations.current = tx.Target
	adapter.Generations = generations

	digest, err := adapter.RepairCurrent(context.Background(), tx.ID, manifest, digestA)
	if err != nil || !validDigest(digest) {
		t.Fatalf("repair failed: digest=%q err=%v calls=%v", digest, err, *calls)
	}
	for _, required := range []string{
		"units.prepare", "files.prepare", "systemd.stop:fased-gateway-example.service",
		"systemd.stop:fased-signerd-example.service", "units.activate", "systemd.reload",
		"systemd.start:fased-signerd-example.service", "systemd.start:fased-gateway-example.service",
		"gateway.ready:18789:0.1.76:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "units.discard", "files.discard",
	} {
		found := false
		for _, call := range *calls {
			if call == required {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("repair omitted %q: %v", required, *calls)
		}
	}
	if strings.Contains(strings.Join(*calls, " "), "generation.activate") {
		t.Fatalf("repair changed the active generation: %v", *calls)
	}
}

func TestRepairCurrentRestoresExactUnitsAndFilesAfterStartFailure(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	manifest := repairManifest(tx, adapter.Identity)
	adapter.Manifest = fakeManifestReader{manifest: manifest}
	generations := adapter.Generations.(fakeGenerations)
	generations.current = tx.Target
	adapter.Generations = generations
	systemd := adapter.Systemd.(fakeSystemd)
	systemd.fail = "systemd.start:fased-gateway-example.service"
	adapter.Systemd = systemd

	if _, err := adapter.RepairCurrent(context.Background(), tx.ID, manifest, digestA); err == nil {
		t.Fatal("repair start failure did not fail closed")
	}
	wantSubsequence := []string{"files.restore", "units.restore", "systemd.reload"}
	position := 0
	for _, call := range *calls {
		if position < len(wantSubsequence) && call == wantSubsequence[position] {
			position++
		}
	}
	if position != len(wantSubsequence) {
		t.Fatalf("repair rollback did not restore files then units: calls=%v want=%v", *calls, wantSubsequence)
	}
	if reflect.DeepEqual(*calls, []string{}) {
		t.Fatal("repair failure produced no rollback evidence")
	}
}
