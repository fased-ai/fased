package planner

import (
	"testing"

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

func capabilities() model.CapabilityRanges {
	return model.CapabilityRanges{
		Supervisor: model.CapabilityRange{Min: 1, Max: 2},
		Controller: model.CapabilityRange{Min: 2, Max: 3},
		Migrator:   model.CapabilityRange{Min: 1, Max: 2},
		Signer:     model.CapabilityRange{Min: 2, Max: 4},
	}
}

func target() Target {
	return Target{
		Profile:      model.ProfileProtectedLocal,
		Generation:   generation(digestB, "0.1.76", commitB),
		StateSchemas: map[string]uint32{"signer": 3, "walletRegistry": 2},
		Capabilities: capabilities(),
	}
}

func installed() model.Manifest {
	active := generation(digestA, "0.1.75", commitA)
	platform, _ := model.NewPlatformIdentity(model.ProfileProtectedLocal, "test-instance", digestA)
	return model.Manifest{
		SchemaVersion:    model.CurrentManifestSchemaVersion,
		Profile:          model.ProfileProtectedLocal,
		Platform:         platform,
		ActiveGeneration: &active,
		StateSchemas:     map[string]uint32{"signer": 2, "walletRegistry": 2},
		Capabilities:     capabilities(),
	}
}

func TestPlanFreshUpdateAndAlreadyCurrent(t *testing.T) {
	fresh, err := Build(nil, target())
	if err != nil || fresh.Action != ActionInstall || len(fresh.Migrations) != 2 {
		t.Fatalf("unexpected fresh plan: %+v err=%v", fresh, err)
	}

	current := installed()
	update, err := Build(&current, target())
	if err != nil || update.Action != ActionUpdate {
		t.Fatalf("unexpected update plan: %+v err=%v", update, err)
	}
	if len(update.Migrations) != 1 || update.Migrations[0] != (Migration{State: "signer", From: 2, To: 3}) {
		t.Fatalf("unexpected migrations: %+v", update.Migrations)
	}

	selected := target()
	current.ActiveGeneration = &selected.Generation
	current.StateSchemas = selected.StateSchemas
	current.Capabilities = selected.Capabilities
	noop, err := Build(&current, selected)
	if err != nil || noop.Action != ActionAlreadyCurrent || len(noop.Migrations) != 0 {
		t.Fatalf("unexpected no-op plan: %+v err=%v", noop, err)
	}
}

func TestPlanSelectsVersionNeutralPublicStableBridge(t *testing.T) {
	legacy, err := PublicStableInstallation(model.ProfileProtectedLocal, TopologyLocalUserSystemdV1)
	if err != nil {
		t.Fatal(err)
	}
	selected := target()
	selected.StateSchemas = map[string]uint32{
		"federation": 2, "managedInstall": 2, "mining": 1, "signer": 3, "walletRegistry": 2,
	}
	plan, err := BuildForInstallation(legacy, selected)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Action != ActionBridgePublicStable {
		t.Fatalf("public stable selected %q, want %q", plan.Action, ActionBridgePublicStable)
	}
	if len(plan.Migrations) != 4 || plan.Migrations[0] != (Migration{State: "federation", From: 1, To: 2}) ||
		plan.Migrations[1] != (Migration{State: "managedInstall", From: 1, To: 2}) ||
		plan.Migrations[2] != (Migration{State: "signer", From: 1, To: 3}) ||
		plan.Migrations[3] != (Migration{State: "walletRegistry", From: 1, To: 2}) {
		t.Fatalf("unexpected public-stable migrations: %+v", plan.Migrations)
	}
}

func TestPublicStableTopologySelectionIsVersionNeutralAndFailClosed(t *testing.T) {
	for _, topology := range []PublicTopology{TopologyLegacyLocalSameUser, TopologyLocalUserSystemdV1, TopologyLocalUserSystemdV2} {
		installation, err := PublicStableInstallation(model.ProfileProtectedLocal, topology)
		if err != nil || installation.Kind != InstallationPublicStable || installation.StateSchemas["signer"] != 1 {
			t.Fatalf("unexpected topology %q: %+v err=%v", topology, installation, err)
		}
	}
	for _, topology := range []PublicTopology{TopologyHostingRootV0, TopologyHostingControllerV2} {
		installation, err := PublicStableInstallation(model.ProfileHosting, topology)
		if err != nil || installation.Kind != InstallationPublicStable || installation.Profile != model.ProfileHosting {
			t.Fatalf("unexpected Hosting topology %q: %+v err=%v", topology, installation, err)
		}
	}
	if _, err := PublicStableInstallation(model.ProfileProtectedLocal, "private-rc-residue"); err == nil {
		t.Fatal("private or unknown topology was accepted")
	}
}

func TestPlanSeparatesEmptyManagedAndAmbiguousInstallations(t *testing.T) {
	fresh, err := BuildForInstallation(Installation{Kind: InstallationEmpty}, target())
	if err != nil || fresh.Action != ActionInstall {
		t.Fatalf("unexpected empty-installation plan: %+v err=%v", fresh, err)
	}

	current := installed()
	managed, err := BuildForInstallation(Installation{Kind: InstallationManaged, Manifest: &current}, target())
	if err != nil || managed.Action != ActionUpdate {
		t.Fatalf("unexpected managed plan: %+v err=%v", managed, err)
	}

	repair, err := BuildForInstallation(Installation{
		Kind:    InstallationAmbiguous,
		Profile: model.ProfileProtectedLocal,
	}, target())
	if err != nil || repair.Action != ActionRepairRequired {
		t.Fatalf("unexpected ambiguous-installation plan: %+v err=%v", repair, err)
	}
}

func TestPlanFailsClosedForUnknownNewerOrUnmappedState(t *testing.T) {
	current := installed()
	current.StateSchemas["signer"] = 4
	if plan, err := Build(&current, target()); err != nil || plan.Action != ActionRejectUnknownNewer {
		t.Fatalf("unknown newer signer schema was not rejected explicitly: %+v err=%v", plan, err)
	}

	current = installed()
	current.StateSchemas["privateResidue"] = 1
	if plan, err := Build(&current, target()); err != nil || plan.Action != ActionRejectUnknownNewer {
		t.Fatalf("unmapped state schema was not rejected explicitly: %+v err=%v", plan, err)
	}
	if plan, err := BuildForInstallation(Installation{Kind: InstallationUnknownNewer, Profile: model.ProfileProtectedLocal}, target()); err != nil || plan.Action != ActionRejectUnknownNewer {
		t.Fatalf("unknown-newer discovery was not rejected explicitly: %+v err=%v", plan, err)
	}
}

func TestPlanRejectsProfileAndCapabilityMismatch(t *testing.T) {
	current := installed()
	hosting := target()
	hosting.Profile = model.ProfileHosting
	if _, err := Build(&current, hosting); err == nil {
		t.Fatal("cross-profile update was accepted")
	}

	current = installed()
	current.Capabilities.Signer = model.CapabilityRange{Min: 1, Max: 1}
	if plan, err := Build(&current, target()); err != nil || plan.Action != ActionRejectUnknownNewer {
		t.Fatalf("incompatible signer capability was not rejected explicitly: %+v err=%v", plan, err)
	}
}

func TestPlanIsDeterministicAndSorted(t *testing.T) {
	current := installed()
	current.StateSchemas = map[string]uint32{"walletRegistry": 1, "signer": 1}
	first, err := Build(&current, target())
	if err != nil {
		t.Fatal(err)
	}
	second, err := Build(&current, target())
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Migrations) != 2 || first.Migrations[0].State != "signer" || first.Migrations[1].State != "walletRegistry" {
		t.Fatalf("migrations are not sorted: %+v", first.Migrations)
	}
	if first.Digest != second.Digest || first.Digest == "" {
		t.Fatalf("plan digest is not deterministic: %q %q", first.Digest, second.Digest)
	}
}
