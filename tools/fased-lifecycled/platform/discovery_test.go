package platform

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/model"
	"fased-lifecycled/planner"
)

func discoveryRequest(t *testing.T, profile model.Profile) DiscoveryRequest {
	t.Helper()
	root := t.TempDir()
	owner := filepath.Join(root, "home", "owner", ".fased")
	install := filepath.Join(root, "opt", "fased")
	state := filepath.Join(root, "var", "lib", "lifecycle")
	for _, path := range []string{owner, install, state} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return DiscoveryRequest{Profile: profile, OwnerStateRoot: owner, CanonicalManifestPath: filepath.Join(state, "installation-manifest.json"), CanonicalInstallRoot: install, SystemRootPrefix: root}
}

func TestDiscoveryClassifiesEmptyManagedAndUnknownNewerWithoutMutation(t *testing.T) {
	request := discoveryRequest(t, model.ProfileProtectedLocal)
	empty, err := DiscoverInstallation(request)
	if err != nil || empty.Installation.Kind != planner.InstallationEmpty {
		t.Fatalf("unexpected empty discovery: %+v err=%v", empty, err)
	}
	active := model.Generation{ID: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Version: "0.1.76", Commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Tree: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ArtifactSetDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	identity, _ := model.NewPlatformIdentity(request.Profile, "test-instance", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
	manifest := model.Manifest{SchemaVersion: 1, Profile: request.Profile, Platform: identity, ActiveGeneration: &active,
		StateSchemas: map[string]uint32{"signer": 2}, Capabilities: model.CapabilityRanges{
			Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1}, Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 2, Max: 2},
		}}
	data, err := model.CanonicalManifestJSON(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(request.CanonicalManifestPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(request.CanonicalInstallRoot, "generations", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("generations", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), filepath.Join(request.CanonicalInstallRoot, "current")); err != nil {
		t.Fatal(err)
	}
	managed, err := DiscoverInstallation(request)
	if err != nil || managed.Installation.Kind != planner.InstallationManaged || managed.Installation.Manifest.ActiveGeneration.ID != active.ID {
		t.Fatalf("unexpected managed discovery: %+v err=%v", managed, err)
	}
	unknown := []byte(`{"schemaVersion":2,"profile":"protected-local"}`)
	if err := os.WriteFile(request.CanonicalManifestPath, unknown, 0o600); err != nil {
		t.Fatal(err)
	}
	newer, err := DiscoverInstallation(request)
	if err != nil || newer.Installation.Kind != planner.InstallationUnknownNewer {
		t.Fatalf("unexpected unknown-newer discovery: %+v err=%v", newer, err)
	}
	after, err := os.ReadFile(request.CanonicalManifestPath)
	if err != nil || string(after) != string(unknown) {
		t.Fatal("unknown-newer discovery mutated its input")
	}
}

func writePublicStableFixture(t *testing.T, request DiscoveryRequest, profile, scope string) {
	t.Helper()
	release := filepath.Join(request.OwnerStateRoot, "runtime", "releases", "active")
	launcher := filepath.Join(request.OwnerStateRoot, "bin", "fased-service")
	if err := os.MkdirAll(release, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(release, "package.json"), []byte(`{"version":"0.1.75"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(launcher), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(launcher, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(release, filepath.Join(request.OwnerStateRoot, "runtime", "current")); err != nil {
		t.Fatal(err)
	}
	record := managedInstallRecord{SchemaVersion: 2, Profile: profile, Source: "managed-artifact", StateDir: request.OwnerStateRoot,
		ConfigPath: filepath.Join(request.OwnerStateRoot, "fased.json"),
		Runtime: managedRuntime{ActiveVersion: "0.1.75", CurrentLink: filepath.Join(request.OwnerStateRoot, "runtime", "current"),
			PreviousLink: filepath.Join(request.OwnerStateRoot, "runtime", "previous"), ReleasesDir: filepath.Join(request.OwnerStateRoot, "runtime", "releases")},
		Package: json.RawMessage(`{}`), Service: managedService{Name: "fased-gateway.service", Scope: scope, Launcher: launcher},
		Updater: json.RawMessage(`{}`), Update: json.RawMessage(`{}`), Release: json.RawMessage(`null`), UpdatedAt: "2026-08-09T00:00:00Z"}
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(request.OwnerStateRoot, "install.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestDiscoveryDerivesPublicStableTopologyFromFactsNotReleaseName(t *testing.T) {
	local := discoveryRequest(t, model.ProfileProtectedLocal)
	writePublicStableFixture(t, local, "local", "user")
	result, err := DiscoverInstallation(local)
	if err != nil || result.Installation.Kind != planner.InstallationPublicStable || result.Topology != planner.TopologyLocalUserSystemdV2 || result.PublicPredecessorVersion != "0.1.75" {
		t.Fatalf("unexpected Local public-stable discovery: %+v err=%v", result, err)
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(local.OwnerStateRoot, "runtime", "current"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resolved, "package.json"), []byte(`{"version":"0.1.74"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	mismatched, err := DiscoverInstallation(local)
	if err != nil || mismatched.Installation.Kind != planner.InstallationAmbiguous {
		t.Fatalf("manifest/runtime version mismatch did not fail closed: %+v err=%v", mismatched, err)
	}
	if err := os.WriteFile(filepath.Join(resolved, "package.json"), []byte(`{"version":"0.1.75"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	verifier := DiscoveryEvidenceVerifier{Request: local}
	if err := verifier.VerifyPublicPredecessorEvidence(string(planner.TopologyLocalUserSystemdV2), "0.1.75"); err != nil {
		t.Fatalf("verified predecessor evidence was rejected: %v", err)
	}
	if err := verifier.VerifyPublicPredecessorEvidence(string(planner.TopologyLocalUserSystemdV2), "0.1.74"); err == nil {
		t.Fatal("forged predecessor version was accepted")
	}
	realRelease := filepath.Join(local.OwnerStateRoot, "runtime", "releases", "real")
	if err := os.Rename(resolved, realRelease); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realRelease, resolved); err != nil {
		t.Fatal(err)
	}
	unsafe, err := DiscoverInstallation(local)
	if err != nil || unsafe.Installation.Kind != planner.InstallationAmbiguous {
		t.Fatalf("symlinked selected release was accepted: %+v err=%v", unsafe, err)
	}

	hosting := discoveryRequest(t, model.ProfileHosting)
	writePublicStableFixture(t, hosting, "hosting", "system")
	for _, unit := range []string{"fased-host-updater.service", "fased-host-controller.service", "fased-gateway.service", "fased-signerd.service"} {
		path := rooted(hosting.SystemRootPrefix, filepath.Join("/etc/systemd/system", unit))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("[Service]\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	result, err = DiscoverInstallation(hosting)
	if err != nil || result.Installation.Kind != planner.InstallationPublicStable || result.Topology != planner.TopologyHostingControllerV2 || result.PublicPredecessorVersion != "0.1.75" {
		t.Fatalf("unexpected Hosting public-stable discovery: %+v err=%v", result, err)
	}
}

func TestDiscoveryRejectsSymlinkedRuntimeRoot(t *testing.T) {
	request := discoveryRequest(t, model.ProfileProtectedLocal)
	writePublicStableFixture(t, request, "local", "user")
	runtimePath := filepath.Join(request.OwnerStateRoot, "runtime")
	externalRuntime := filepath.Join(t.TempDir(), "runtime")
	if err := os.Rename(runtimePath, externalRuntime); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(externalRuntime, "current")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(externalRuntime, "releases", "active"), filepath.Join(externalRuntime, "current")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(externalRuntime, runtimePath); err != nil {
		t.Fatal(err)
	}
	result, err := DiscoverInstallation(request)
	if err != nil || result.Installation.Kind != planner.InstallationAmbiguous {
		t.Fatalf("symlinked runtime root was accepted: %+v err=%v", result, err)
	}
}

func TestDiscoveryClassifiesMixedOrPrivateControlAsRepairRequiredInput(t *testing.T) {
	request := discoveryRequest(t, model.ProfileProtectedLocal)
	writePublicStableFixture(t, request, "protected-local", "system")
	result, err := DiscoverInstallation(request)
	if err != nil || result.Installation.Kind != planner.InstallationAmbiguous {
		t.Fatalf("private control residue was not classified as ambiguous: %+v err=%v", result, err)
	}
}
