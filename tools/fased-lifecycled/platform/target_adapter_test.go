package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"fased-lifecycled/engine"
	"fased-lifecycled/model"
)

type fakeUnits struct {
	calls       *[]string
	definitions map[string][]byte
}

type fakeLifecycleFiles struct {
	calls       *[]string
	prepared    *map[string]LifecycleFile
	activations *[][]string
}

type fakeTypedState struct{ calls *[]string }

func (state fakeTypedState) Prepare(string) (StatePreparation, error) {
	*state.calls = append(*state.calls, "shared.prepare")
	return StatePreparation{Digest: digestA, ParticipantDigests: testStateParticipantDigests()}, nil
}

func testStateParticipantDigests() map[string]string {
	return map[string]string{
		"application-state": digestA, "configuration": digestA, "wallet": digestA, "mining": digestA,
		"federation": digestA, "plugin-data": digestA, "signer": digestA,
	}
}
func (state fakeTypedState) Activate(string) error {
	*state.calls = append(*state.calls, "shared.activate")
	return nil
}
func (state fakeTypedState) VerifyAccess(context.Context, string) error {
	*state.calls = append(*state.calls, "shared.verify-access")
	return nil
}
func (state fakeTypedState) Restore(string) error {
	*state.calls = append(*state.calls, "shared.restore")
	return nil
}
func (state fakeTypedState) Discard(string) error {
	*state.calls = append(*state.calls, "shared.discard")
	return nil
}
func (state fakeTypedState) Converge() error {
	*state.calls = append(*state.calls, "shared.converge")
	return nil
}

func (files fakeLifecycleFiles) Prepare(_ string, prepared map[string]LifecycleFile) error {
	*files.calls = append(*files.calls, "files.prepare")
	if files.prepared != nil {
		copy := make(map[string]LifecycleFile, len(prepared))
		for target, file := range prepared {
			copy[target] = file
		}
		*files.prepared = copy
	}
	return nil
}
func (files fakeLifecycleFiles) Activate(_ string, targets []string) error {
	*files.calls = append(*files.calls, "files.activate")
	if files.activations != nil {
		*files.activations = append(*files.activations, append([]string(nil), targets...))
	}
	return nil
}

type fakePredecessor struct{ calls *[]string }

func (bridge fakePredecessor) Prepare(context.Context, model.Transaction) error {
	*bridge.calls = append(*bridge.calls, "predecessor.prepare")
	return nil
}
func (bridge fakePredecessor) Quiesce(context.Context, model.Transaction) error { return nil }
func (bridge fakePredecessor) Restore(context.Context, model.Transaction) error { return nil }
func (bridge fakePredecessor) Commit(context.Context, model.Transaction) error {
	*bridge.calls = append(*bridge.calls, "predecessor.commit")
	return nil
}
func (bridge fakePredecessor) Discard(context.Context, model.Transaction) error { return nil }

type fakeFence struct {
	calls     *[]string
	verifyErr error
}

func (fence fakeFence) Ensure(Config) error {
	*fence.calls = append(*fence.calls, "fence.ensure")
	return nil
}
func (fence fakeFence) Verify(Config) error {
	*fence.calls = append(*fence.calls, "fence.verify")
	return fence.verifyErr
}
func (files fakeLifecycleFiles) Restore(string, []string) error {
	*files.calls = append(*files.calls, "files.restore")
	return nil
}
func (files fakeLifecycleFiles) Discard(string) error {
	*files.calls = append(*files.calls, "files.discard")
	return nil
}

func (units *fakeUnits) Prepare(_ string, definitions map[string][]byte) error {
	*units.calls = append(*units.calls, "units.prepare")
	units.definitions = definitions
	return nil
}
func (units *fakeUnits) Activate(string, []string) error {
	*units.calls = append(*units.calls, "units.activate")
	return nil
}
func (units *fakeUnits) Restore(string, []string) error {
	*units.calls = append(*units.calls, "units.restore")
	return nil
}
func (units *fakeUnits) Discard(string) error {
	*units.calls = append(*units.calls, "units.discard")
	return nil
}

type fakeSystemd struct {
	calls    *[]string
	fail     string
	inactive map[string]bool
}

func (systemd fakeSystemd) call(name string) error {
	*systemd.calls = append(*systemd.calls, name)
	if systemd.fail == name {
		return errors.New("injected systemd failure")
	}
	return nil
}
func (systemd fakeSystemd) DaemonReload(context.Context) error { return systemd.call("systemd.reload") }
func (systemd fakeSystemd) Stop(_ context.Context, unit string) error {
	return systemd.call("systemd.stop:" + unit)
}
func (systemd fakeSystemd) Start(_ context.Context, unit string) error {
	err := systemd.call("systemd.start:" + unit)
	if err == nil && systemd.inactive != nil {
		delete(systemd.inactive, unit)
	}
	return err
}
func (systemd fakeSystemd) Enable(_ context.Context, unit string) error {
	return systemd.call("systemd.enable:" + unit)
}
func (systemd fakeSystemd) Disable(_ context.Context, unit string) error {
	return systemd.call("systemd.disable:" + unit)
}
func (systemd fakeSystemd) IsEnabled(_ context.Context, unit string) error {
	return systemd.call("systemd.enabled:" + unit)
}
func (systemd fakeSystemd) IsActive(_ context.Context, unit string) error {
	if err := systemd.call("systemd.active:" + unit); err != nil {
		return err
	}
	if systemd.inactive[unit] {
		return errors.New("inactive")
	}
	return nil
}

type fakeGenerations struct {
	root       string
	dependency string
	calls      *[]string
}

type fakeHealth struct{ calls *[]string }

type fakePlugins struct {
	calls      *[]string
	prepareErr error
	verifyErr  error
}

func (plugins fakePlugins) Prepare(_ context.Context, target model.Generation) (PreparedPluginLock, error) {
	*plugins.calls = append(*plugins.calls, "plugins.prepare:"+target.ID)
	return PreparedPluginLock{Data: []byte("{\"schemaVersion\":1,\"type\":\"fased-plugin-lock\",\"entries\":[]}\n"), Digest: digestA}, plugins.prepareErr
}

func (plugins fakePlugins) Verify(_ context.Context, target model.Generation) (PluginReadinessReceipt, error) {
	*plugins.calls = append(*plugins.calls, "plugins.verify:"+target.ID)
	return PluginReadinessReceipt{Digest: digestA}, plugins.verifyErr
}

type fakeManifestReader struct{ manifest model.Manifest }

func (reader fakeManifestReader) ReadManifest() (model.Manifest, string, error) {
	return reader.manifest, digestA, nil
}

func (health fakeHealth) Verify(_ context.Context, port uint16, target model.Generation) error {
	*health.calls = append(*health.calls, fmt.Sprintf("gateway.ready:%d:%s:%s", port, target.Version, target.Commit))
	return nil
}

func (generations fakeGenerations) GenerationPayloadPath(string) (string, error) {
	return generations.root, nil
}
func (generations fakeGenerations) GenerationDependencyPath(string) (string, error) {
	return generations.dependency, nil
}
func (generations fakeGenerations) ActivateGeneration(current, previous string) error {
	*generations.calls = append(*generations.calls, "generation.activate:"+current+":"+previous)
	return nil
}

func targetAdapter(t *testing.T) (*TargetAdapter, model.Transaction, *[]string) {
	t.Helper()
	tx, identity := manifestTransaction(t, false)
	root := t.TempDir()
	for _, name := range []string{"fased-gateway-launch", "fased-signerd", "node"} {
		path := filepath.Join(root, "bin", name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("binary"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	helper := filepath.Join(root, "runtime", "scripts", "fased-signer-owner-hosting.sh")
	if err := os.MkdirAll(filepath.Dir(helper), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "runtime", "plugin.lock.json"), []byte("{\"schemaVersion\":1,\"type\":\"fased-plugin-lock\",\"entries\":[]}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	operator, gateway, signer := filesystemPrincipals()
	stateRoot := filepath.Join(t.TempDir(), ".fased")
	prepareFilesystemOwnerStateRoot(t, stateRoot, operator)
	if err := os.WriteFile(filepath.Join(stateRoot, "fased.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := NewConfig(model.ProfileProtectedLocal, "example", stateRoot, operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	identity, err = config.Identity()
	if err != nil {
		t.Fatal(err)
	}
	tx.PlatformDigest, err = identity.Digest(model.ProfileProtectedLocal)
	if err != nil {
		t.Fatal(err)
	}
	calls := []string{}
	return &TargetAdapter{Config: config, Identity: identity, Units: &fakeUnits{calls: &calls}, Files: fakeLifecycleFiles{calls: &calls}, TypedState: fakeTypedState{calls: &calls}, Systemd: fakeSystemd{calls: &calls}, Generations: fakeGenerations{root: root, dependency: filepath.Join(root, "dependencies", "node_modules"), calls: &calls}, Health: fakeHealth{calls: &calls}, Predecessor: NoPredecessor{}, Fence: fakeFence{calls: &calls}, Network: NoNetworkPolicy{}, Plugins: fakePlugins{calls: &calls}}, tx, &calls
}

func TestTargetAdapterStagesStartsVerifiesAndCommitsCanonicalServices(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	tx.Phase = model.PhasePrepared
	if err := adapter.Prepare(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Quiesce(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if _, _, err := adapter.PrepareState(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	pluginReceipt, err := adapter.Verify(context.Background(), tx)
	if err != nil {
		t.Fatal(err)
	}
	if pluginReceipt.TransactionID != tx.ID || pluginReceipt.TargetGenerationID != tx.Target.ID ||
		pluginReceipt.StateInventoryDigest != tx.StateInventoryDigest || pluginReceipt.PlanDigest != tx.Target.ID ||
		pluginReceipt.EvidenceDigest != digestA {
		t.Fatalf("plugin readiness was not bound to the transaction: %+v", pluginReceipt)
	}
	if err := adapter.Commit(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"plugins.prepare:" + digestB, "units.prepare", "files.prepare", "systemd.stop:fased-gateway-example.service", "systemd.stop:fased-signerd-example.service", "shared.prepare",
		"shared.activate", "files.activate", "shared.verify-access", "units.activate", "systemd.reload", "systemd.enable:fased-signerd-example.service", "systemd.start:fased-signerd-example.service",
		"systemd.enable:fased-gateway-example.service", "systemd.start:fased-gateway-example.service",
		"systemd.active:fased-signerd-example.service", "systemd.active:fased-gateway-example.service",
		"gateway.ready:18789:0.1.76:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"plugins.verify:" + digestB,
		"generation.activate:" + digestB + ":" + digestA, "files.activate", "units.discard", "files.discard", "shared.discard",
	}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("unexpected target adapter order:\n got=%v\nwant=%v", *calls, want)
	}
	definitions := adapter.Units.(*fakeUnits).definitions
	if len(definitions) != 2 {
		t.Fatalf("target transaction staged a service outside Gateway and signer: %v", definitions)
	}
	combined := string(definitions[adapter.Identity.Services["signer"]]) + string(definitions[adapter.Identity.Services["gateway"]])
	if strings.Contains(combined, "/bin/sh") || !strings.Contains(combined, "NoNewPrivileges=true") ||
		!strings.Contains(combined, fmt.Sprintf("User=%d", adapter.Config.Signer.UID)) {
		t.Fatalf("canonical units lack privilege or direct-exec contracts:\n%s", combined)
	}
	if strings.Contains(combined, "fased-lifecycled") || strings.Contains(combined, "fased-bootstrap") || strings.Contains(combined, "controller-worker") {
		t.Fatalf("application generation selected a privileged lifecycle executable:\n%s", combined)
	}
	if !strings.Contains(combined, "SupplementaryGroups=fscf-example") ||
		!strings.Contains(combined, "RuntimeDirectoryMode=0755") ||
		!strings.Contains(combined, "RuntimeDirectory=fased-local/example fased-local/example/application fased-local/example/operator fased-local/example/control") ||
		!strings.Contains(combined, "Environment=FASED_PROTECTED_LOCAL_INSTANCE=example") ||
		!strings.Contains(combined, "WorkingDirectory="+filepath.Join(adapter.Generations.(fakeGenerations).root, "runtime")) ||
		!strings.Contains(combined, "Environment=HOME="+adapter.Config.OwnerHome()) ||
		!strings.Contains(combined, "Environment=FASED_PLUGIN_STATUS_CACHE_PATH="+filepath.Join(adapter.Config.OwnerStateRoot, "cache", "plugin-status.json")) ||
		!strings.Contains(combined, "Environment=FASED_VERSION=0.1.76") ||
		!strings.Contains(combined, "Environment=FASED_HOST_PROFILE=local") ||
		!strings.Contains(combined, "Environment=FASED_PROTECTED_LOCAL=1") ||
		!strings.Contains(combined, "BindReadOnlyPaths="+filepath.Join(adapter.Generations.(fakeGenerations).root, "dependencies", "node_modules")+":"+filepath.Join(adapter.Generations.(fakeGenerations).root, "runtime", "node_modules")) {
		t.Fatalf("canonical Gateway unit lacks Local runtime context:\n%s", combined)
	}
}

func TestTargetAdapterRequiresPluginLockBeforeMutationAndReadinessBeforeCommit(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	adapter.Plugins = fakePlugins{calls: calls, prepareErr: errors.New("lock drift")}
	if err := adapter.Prepare(context.Background(), tx); err == nil || !strings.Contains(err.Error(), "plugin lock") {
		t.Fatalf("plugin lock failure was accepted: %v", err)
	}
	if !reflect.DeepEqual(*calls, []string{"plugins.prepare:" + digestB}) {
		t.Fatalf("target mutation preceded plugin lock verification: %v", *calls)
	}

	*calls = nil
	adapter.Plugins = fakePlugins{calls: calls, verifyErr: errors.New("mandatory plugin missing")}
	tx.Phase = model.PhasePrepared
	if _, err := adapter.Verify(context.Background(), tx); err == nil || !strings.Contains(err.Error(), "mandatory plugin readiness") {
		t.Fatalf("mandatory plugin readiness failure was accepted: %v", err)
	}
	if got := strings.Join(*calls, ","); strings.Contains(got, "generation.activate:") || strings.Contains(got, "files.activate") {
		t.Fatalf("target commit began after plugin readiness failure: %v", *calls)
	}
}

func TestTargetAdapterQuiesceStopsSignerAfterGatewayStopFailure(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	tx.Phase = model.PhaseSwitched
	gatewayStop := "systemd.stop:" + adapter.Identity.Services["gateway"]
	signerStop := "systemd.stop:" + adapter.Identity.Services["signer"]
	adapter.Systemd = fakeSystemd{calls: calls, fail: gatewayStop}

	if err := adapter.Quiesce(context.Background(), tx); err == nil {
		t.Fatal("expected the injected Gateway stop failure")
	}
	if !reflect.DeepEqual(*calls, []string{gatewayStop, signerStop}) {
		t.Fatalf("quiesce did not stop the signer after the Gateway failure: %v", *calls)
	}
}

func TestFreshTargetDoesNotStopAbsentCanonicalServices(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	tx.PlanAction = "INSTALL"
	tx.Previous = nil
	tx.Phase = model.PhasePrepared
	tx.ManifestDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	if err := adapter.Quiesce(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 {
		t.Fatalf("fresh target stopped absent services: %v", *calls)
	}
}

func TestFreshLocalDefersGatewayUntilOnboardingCreatesConfig(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	tx.PlanAction = "INSTALL"
	tx.Previous = nil
	tx.ManifestDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	if err := adapter.Prepare(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	tx.Phase = model.PhasePrepared
	if err := adapter.Quiesce(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if _, _, err := adapter.PrepareState(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if _, err := adapter.Verify(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"plugins.prepare:" + digestB, "units.prepare", "files.prepare", "shared.prepare", "shared.activate", "files.activate", "shared.verify-access", "units.activate", "systemd.reload",
		"systemd.enable:fased-signerd-example.service", "systemd.start:fased-signerd-example.service",
		"systemd.enable:fased-gateway-example.service", "systemd.active:fased-signerd-example.service",
	}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("fresh Local started or health-checked Gateway before onboarding:\n got=%v\nwant=%v", *calls, want)
	}
}

func TestLocalBridgeVerifiesDurableFenceBeforeLifecycleProjectionAndPredecessor(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	tx.PlanAction = "BRIDGE_PUBLIC_STABLE"
	tx.SourceTopology = "local-user-systemd-v2"
	tx.PublicPredecessorVersion = "0.1.75"
	tx.Previous = nil
	tx.ManifestDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	prepared := map[string]LifecycleFile{}
	activations := [][]string{}
	adapter.Files = fakeLifecycleFiles{calls: calls, prepared: &prepared, activations: &activations}
	adapter.Predecessor = fakePredecessor{calls: calls}
	adapter.Fence = fakeFence{calls: calls}
	if err := adapter.Prepare(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if _, ok := prepared[LocalPredecessorDropInPath]; ok {
		t.Fatal("global predecessor fence was incorrectly assigned to owner rollback storage")
	}
	productVersion := prepared[CanonicalProductVersionPath(adapter.Config)]
	if string(productVersion.Data) != tx.Target.Version+"\n" || productVersion.Mode != 0o600 || productVersion.UID != 0 || productVersion.GID != 0 {
		t.Fatalf("product version projection is not target-derived: %+v", productVersion)
	}
	pluginLock := prepared[CanonicalPluginLockPath(adapter.Config)]
	if !strings.Contains(string(pluginLock.Data), `"type":"fased-plugin-lock"`) || pluginLock.Mode != 0o640 || pluginLock.UID != adapter.Config.Operator.UID {
		t.Fatalf("plugin lock is not generation-derived and transactionally staged: %+v", pluginLock)
	}
	if err := adapter.Commit(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	wantTargets := []string{
		CanonicalProductVersionPath(adapter.Config),
		CanonicalCLIProjectionPath(adapter.Config), CanonicalInstallProjectionPath(adapter.Config),
	}
	if len(activations) != 1 || !reflect.DeepEqual(activations[0], wantTargets) {
		t.Fatalf("Local bridge commit activation order changed: got=%v want=%v", activations, wantTargets)
	}
	wantTail := []string{"fence.verify", "generation.activate:" + digestB + ":", "files.activate", "predecessor.commit", "units.discard", "files.discard", "shared.discard"}
	if !reflect.DeepEqual((*calls)[len(*calls)-len(wantTail):], wantTail) {
		t.Fatalf("predecessor committed before durable fence activation: %v", *calls)
	}
}

func TestLocalBridgeFenceFailurePrecedesAllCommitMutation(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	tx.PlanAction = "BRIDGE_PUBLIC_STABLE"
	tx.SourceTopology = "local-user-systemd-v2"
	tx.PublicPredecessorVersion = "0.1.75"
	tx.Previous = nil
	adapter.Predecessor = fakePredecessor{calls: calls}
	adapter.Fence = fakeFence{calls: calls, verifyErr: errors.New("fence unavailable")}
	if err := adapter.Commit(context.Background(), tx); err == nil {
		t.Fatal("Local bridge committed without its durable predecessor fence")
	}
	if !reflect.DeepEqual(*calls, []string{"fence.verify"}) {
		t.Fatalf("Local bridge mutated state before fence verification: %v", *calls)
	}
}

func TestCompleteOnboardingStartsAndVerifiesExactCommittedGateway(t *testing.T) {
	testCompleteOnboardingStartsAndVerifiesExactCommittedGateway(t, model.ProfileProtectedLocal, "example")
}

func TestHostingCompleteOnboardingStartsAndVerifiesExactCommittedGateway(t *testing.T) {
	testCompleteOnboardingStartsAndVerifiesExactCommittedGateway(t, model.ProfileHosting, "hosting")
}

func testCompleteOnboardingStartsAndVerifiesExactCommittedGateway(t *testing.T, profile model.Profile, instance string) {
	t.Helper()
	stateRoot := filepath.Join(t.TempDir(), ".fased")
	if err := os.MkdirAll(stateRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(stateRoot, "fased.json")
	if err := os.WriteFile(configPath, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	operator := Principal{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
	gateway := Principal{UID: operator.UID + 1, GID: operator.GID + 1}
	signer := Principal{UID: operator.UID + 2, GID: operator.GID + 2}
	config, err := NewConfig(profile, instance, stateRoot, operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := config.Identity()
	if err != nil {
		t.Fatal(err)
	}
	active := model.Generation{ID: digestB, Version: "0.1.76", Commit: commitB, Tree: commitB, ArtifactSetDigest: digestB}
	manifest := model.Manifest{SchemaVersion: model.CurrentManifestSchemaVersion, Profile: profile,
		Platform: identity, ActiveGeneration: &active, StateSchemas: map[string]uint32{"signer": 2},
		Capabilities: model.CapabilityRanges{Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1}, Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1}}, ReleaseSequence: 12, SecurityEpoch: 3}
	calls := []string{}
	adapter := TargetAdapter{Config: config, Identity: identity, TypedState: fakeTypedState{calls: &calls}, Systemd: fakeSystemd{calls: &calls, inactive: map[string]bool{identity.Services["gateway"]: true}}, Health: fakeHealth{calls: &calls}, Manifest: fakeManifestReader{manifest: manifest}, Plugins: fakePlugins{calls: &calls}}
	result, err := adapter.CompleteOnboarding(context.Background())
	if err != nil || result.Outcome != engine.OutcomeUpdated || result.Phase != model.PhaseCommitted {
		t.Fatal(err)
	}
	want := []string{"shared.converge", "systemd.active:" + identity.Services["signer"], "systemd.active:" + identity.Services["gateway"], "systemd.start:" + identity.Services["gateway"], "systemd.active:" + identity.Services["gateway"], "gateway.ready:18789:0.1.76:" + commitB, "plugins.verify:" + digestB}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("unexpected onboarding completion order: got=%v want=%v", calls, want)
	}
}

func TestHostingCompleteOnboardingReturnsAlreadyCurrentForHealthyGateway(t *testing.T) {
	stateRoot := filepath.Join(t.TempDir(), ".fased")
	if err := os.MkdirAll(stateRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateRoot, "fased.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	operator := Principal{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
	config, err := NewConfig(model.ProfileHosting, "hosting", stateRoot, operator,
		Principal{UID: operator.UID + 1, GID: operator.GID + 1}, Principal{UID: operator.UID + 2, GID: operator.GID + 2})
	if err != nil {
		t.Fatal(err)
	}
	identity, _ := config.Identity()
	active := model.Generation{ID: digestB, Version: "0.1.76", Commit: commitB, Tree: commitB, ArtifactSetDigest: digestB}
	manifest := model.Manifest{SchemaVersion: model.CurrentManifestSchemaVersion, Profile: model.ProfileHosting,
		Platform: identity, ActiveGeneration: &active, StateSchemas: map[string]uint32{"signer": 2},
		Capabilities: model.CapabilityRanges{Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1}, Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1}}, ReleaseSequence: 12, SecurityEpoch: 3}
	calls := []string{}
	adapter := TargetAdapter{Config: config, Identity: identity, TypedState: fakeTypedState{calls: &calls}, Systemd: fakeSystemd{calls: &calls}, Health: fakeHealth{calls: &calls}, Manifest: fakeManifestReader{manifest: manifest}, Plugins: fakePlugins{calls: &calls}}
	result, err := adapter.CompleteOnboarding(context.Background())
	if err != nil || result.Outcome != engine.OutcomeAlreadyCurrent || result.Phase != model.PhaseCommitted {
		t.Fatalf("unexpected idempotent onboarding result: result=%+v err=%v", result, err)
	}
	if got := strings.Join(calls, ","); strings.Contains(got, "systemd.start:") {
		t.Fatalf("healthy Gateway was restarted during identical onboarding: %s", got)
	}
}

func TestFreshHostingInstallDefersGatewayUntilOnboarding(t *testing.T) {
	tx, _ := manifestTransaction(t, false)
	operator, gateway, signer := filesystemPrincipals()
	stateRoot := filepath.Join(t.TempDir(), ".fased")
	prepareFilesystemOwnerStateRoot(t, stateRoot, operator)
	config, err := NewConfig(model.ProfileHosting, "hosting", stateRoot, operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := config.Identity()
	if err != nil {
		t.Fatal(err)
	}
	tx.Profile = model.ProfileHosting
	tx.PlanAction = "INSTALL"
	tx.Previous = nil
	tx.PlatformDigest, err = identity.Digest(model.ProfileHosting)
	if err != nil {
		t.Fatal(err)
	}
	calls := []string{}
	adapter := TargetAdapter{Config: config, Identity: identity, Systemd: fakeSystemd{calls: &calls}}
	if !adapter.deferFreshGateway(tx) {
		t.Fatal("fresh Hosting install did not defer Gateway activation until onboarding")
	}
	if err := adapter.Systemd.Start(context.Background(), identity.Services["signer"]); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(calls, ","); strings.Contains(got, identity.Services["gateway"]) {
		t.Fatalf("fresh Hosting started Gateway before onboarding: %s", got)
	}
}

func TestHostingPublicStableBridgeTransactionallyNormalizesGatewayMode(t *testing.T) {
	config, err := NewConfig(model.ProfileHosting, "hosting", "/home/app/.fased",
		Principal{UID: 1000, GID: 1000}, Principal{UID: 1001, GID: 1001}, Principal{UID: 1002, GID: 1002})
	if err != nil {
		t.Fatal(err)
	}
	tx := model.Transaction{PlanAction: "BRIDGE_PUBLIC_STABLE", Migrations: []model.Migration{{State: "configuration", From: 0, To: 1}}}
	original := []byte(`{"gateway":{"mode":"remote","bind":"loopback","auth":{"token":"preserved"},"remote":{"token":"preserved"}},"agents":{"defaults":{"workspace":"/home/app/.fased/workspace"}}}`)
	migrated, err := canonicalGatewayConfigForTransaction(config, tx, original)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(migrated, &decoded); err != nil {
		t.Fatal(err)
	}
	gateway := decoded["gateway"].(map[string]any)
	if gateway["mode"] != "local" || gateway["bind"] != "loopback" || gateway["auth"].(map[string]any)["token"] != "preserved" || gateway["remote"].(map[string]any)["token"] != "preserved" {
		t.Fatalf("Hosting configuration migration lost preserved values: %s", migrated)
	}
	tx.Migrations = nil
	if _, err := canonicalGatewayConfigForTransaction(config, tx, original); err == nil {
		t.Fatal("Hosting bridge normalized configuration without a declared migration")
	}
}

func TestTargetAdapterStagesCanonicalHostingServices(t *testing.T) {
	tx, _ := manifestTransaction(t, false)
	operator, gateway, signer := filesystemPrincipals()
	stateRoot := filepath.Join(t.TempDir(), ".fased")
	prepareFilesystemOwnerStateRoot(t, stateRoot, operator)
	if err := os.WriteFile(filepath.Join(stateRoot, "fased.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := NewConfig(model.ProfileHosting, "hosting", stateRoot, operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := config.Identity()
	if err != nil {
		t.Fatal(err)
	}
	platformDigest, err := identity.Digest(model.ProfileHosting)
	if err != nil {
		t.Fatal(err)
	}
	tx.Profile = model.ProfileHosting
	tx.PlatformDigest = platformDigest

	root := t.TempDir()
	for _, name := range []string{"fased-gateway-launch", "fased-signerd", "node"} {
		path := filepath.Join(root, "bin", name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("binary"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	helper := filepath.Join(root, "runtime", "scripts", "fased-signer-owner-hosting.sh")
	if err := os.MkdirAll(filepath.Dir(helper), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "runtime", "plugin.lock.json"), []byte("{\"schemaVersion\":1,\"type\":\"fased-plugin-lock\",\"entries\":[]}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	calls := []string{}
	units := &fakeUnits{calls: &calls}
	adapter := &TargetAdapter{
		Config: config, Identity: identity, Units: units, Files: fakeLifecycleFiles{calls: &calls}, TypedState: fakeTypedState{calls: &calls},
		Systemd: fakeSystemd{calls: &calls}, Generations: fakeGenerations{root: root, dependency: filepath.Join(root, "dependencies", "node_modules"), calls: &calls},
		Health: fakeHealth{calls: &calls}, Predecessor: NoPredecessor{}, Fence: NoLocalPredecessorFence{}, Network: NoNetworkPolicy{}, Plugins: fakePlugins{calls: &calls},
	}
	tx.Phase = model.PhasePrepared
	if err := adapter.Prepare(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Quiesce(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if _, _, err := adapter.PrepareState(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if _, err := adapter.Verify(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Commit(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"plugins.prepare:" + digestB, "units.prepare", "files.prepare", "systemd.stop:fased-gateway.service", "systemd.stop:fased-signerd.service", "shared.prepare",
		"shared.activate", "files.activate", "shared.verify-access", "units.activate", "systemd.reload", "systemd.enable:fased-signerd.service", "systemd.start:fased-signerd.service",
		"systemd.enable:fased-gateway.service", "systemd.start:fased-gateway.service",
		"systemd.active:fased-signerd.service", "systemd.active:fased-gateway.service",
		"gateway.ready:18789:0.1.76:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"plugins.verify:" + digestB,
		"generation.activate:" + digestB + ":" + digestA, "files.activate", "units.discard", "files.discard", "shared.discard",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("unexpected Hosting adapter order:\n got=%v\nwant=%v", calls, want)
	}
	combined := string(units.definitions[identity.Services["signer"]]) + string(units.definitions[identity.Services["gateway"]])
	if len(units.definitions) != 2 || strings.Contains(combined, "fased-lifecycled") || strings.Contains(combined, "fased-bootstrap") || strings.Contains(combined, "host-controller") {
		t.Fatalf("Hosting target transaction staged a privileged lifecycle service: %v\n%s", units.definitions, combined)
	}
	for _, required := range []string{
		fmt.Sprintf("User=%d", signer.UID), "NoNewPrivileges=true", "Environment=HOME=" + config.OwnerHome(),
		"Environment=FASED_STATE_DIR=" + config.OwnerStateRoot, "Environment=FASED_HOST_PROFILE=hosting",
		"Environment=FASED_PLUGIN_STATUS_CACHE_PATH=" + filepath.Join(config.OwnerStateRoot, "cache", "plugin-status.json"),
		"-state-db /var/lib/fased-signerd/state.db", "-update-gate /var/lib/fased-signer-update-gate/active",
	} {
		if !strings.Contains(combined, required) {
			t.Fatalf("canonical Hosting units are missing %q:\n%s", required, combined)
		}
	}
	if strings.Contains(combined, "fased-local-") || strings.Contains(combined, "/var/lib/fased-local/") {
		t.Fatalf("Hosting units contain Local topology:\n%s", combined)
	}
	if strings.Contains(combined, "FASED_PROTECTED_LOCAL") {
		t.Fatalf("Hosting unit contains the protected Local marker:\n%s", combined)
	}
}

func TestTargetAdapterRestoresPreviousButDoesNotStartAbsentFreshServices(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	if err := adapter.Restore(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*calls, []string{"files.restore", "shared.restore", "units.restore", "systemd.reload", "systemd.start:fased-signerd-example.service", "systemd.start:fased-gateway-example.service"}) {
		t.Fatalf("update restore order changed: %v", *calls)
	}
	*calls = nil
	tx.Previous = nil
	if err := adapter.Restore(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*calls, []string{"files.restore", "shared.restore", "units.restore", "systemd.reload"}) {
		t.Fatalf("fresh rollback started absent services: %v", *calls)
	}
}

func TestDiskUnitStoreRestoresExactPreviousUnit(t *testing.T) {
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewDiskUnitStore(config, "target")
	if err != nil {
		t.Fatal(err)
	}
	store.rootPrefix = t.TempDir()
	identity, _ := config.Identity()
	unit := identity.Services["gateway"]
	unitPath := store.unitPath(unit)
	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unitPath, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := store.Prepare("018f47d2-5a6b-7c8d-9e0f-123456789abc", map[string][]byte{unit: []byte("new\n")}); err != nil {
		t.Fatal(err)
	}
	if err := store.Activate("018f47d2-5a6b-7c8d-9e0f-123456789abc", []string{unit}); err != nil {
		t.Fatal(err)
	}
	if err := store.Restore("018f47d2-5a6b-7c8d-9e0f-123456789abc", []string{unit}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(unitPath)
	if err != nil || string(data) != "old\n" {
		t.Fatalf("unit rollback mismatch: %q err=%v", data, err)
	}
}
