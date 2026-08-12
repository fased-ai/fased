package daemon

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"fased-lifecycled/bundle"
	"fased-lifecycled/engine"
	"fased-lifecycled/model"
	"fased-lifecycled/planner"
	"fased-lifecycled/protocol"
	"fased-lifecycled/store"
)

const (
	digestA       = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	digestB       = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	commitA       = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	commitB       = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	requestID     = "018f47d2-5a6b-7c8d-9e0f-123456789abc"
	transactionID = "118f47d2-5a6b-7c8d-9e0f-123456789abc"
)

func capabilities() model.CapabilityRanges {
	return model.CapabilityRanges{
		Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1},
		Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1},
	}
}

func generation(id, version, commit string) model.Generation {
	return model.Generation{ID: id, Version: version, Commit: commit, Tree: commit, ArtifactSetDigest: id}
}

func platform() model.PlatformIdentity {
	return platformFor(model.ProfileProtectedLocal)
}

func platformFor(profile model.Profile) model.PlatformIdentity {
	instance := "test-instance"
	if profile == model.ProfileHosting {
		instance = "hosting"
	}
	value, _ := model.NewPlatformIdentity(profile, instance, digestA)
	return value
}

type fakeStore struct {
	manifest       *model.Manifest
	manifestDigest string
	inventory      bundle.Inventory
	generation     model.Generation
	journal        model.Transaction
	locks          *int
	stages         *int
}

type pendingFakeStore struct {
	fakeStore
	pending model.Transaction
}

func (state pendingFakeStore) PendingSupervisorTransaction() (model.Transaction, error) {
	return state.pending, nil
}

type fakeMutationLock struct{}

func (fakeMutationLock) Release() error { return nil }

func (state fakeStore) AcquireUpdateLock(string) (store.MutationLock, error) {
	if state.locks != nil {
		*state.locks++
	}
	return fakeMutationLock{}, nil
}

func (state fakeStore) StageGeneration(string) error {
	if state.stages != nil {
		*state.stages++
	}
	return nil
}

func (state fakeStore) ReadManifest() (model.Manifest, string, error) {
	if state.manifest == nil {
		return model.Manifest{}, "", os.ErrNotExist
	}
	return *state.manifest, state.manifestDigest, nil
}

func (state fakeStore) ReadJournal(store.Authority, string) (model.Transaction, error) {
	return state.journal, nil
}

func (state fakeStore) ReadCandidateContract(id string) (bundle.Inventory, model.Generation, error) {
	return state.inventory, state.generation, nil
}

func (state fakeStore) ReadCandidateAuthority(id string) (store.CandidateAuthority, error) {
	return store.CandidateAuthority{SchemaVersion: 1, GenerationID: id, ReleaseSequence: 12, SecurityEpoch: 3, ReleaseIndex: digestA, ReleaseAuthority: digestB}, nil
}

type fakeInventory struct {
	calls int
}

func (inventory *fakeInventory) Bind(context.Context, planner.Installation, bundle.Inventory, planner.Plan) (string, string, error) {
	inventory.calls++
	return digestA, digestB, nil
}

type fakeSupervisor struct {
	runs     int
	recovers int
	tx       model.Transaction
}

type fakeOnboarding struct{ calls int }

type fakePredecessorEvidence struct {
	topology string
	version  string
	calls    int
	failOn   int
	err      error
}

func (evidence *fakePredecessorEvidence) VerifyPublicPredecessorEvidence(topology, version string) error {
	evidence.calls++
	evidence.topology = topology
	evidence.version = version
	if evidence.failOn == 0 || evidence.calls == evidence.failOn {
		return evidence.err
	}
	return nil
}

func (value *fakeOnboarding) CompleteOnboarding(context.Context) (engine.Result, error) {
	value.calls++
	return engine.Result{Outcome: engine.OutcomeUpdated, Phase: model.PhaseCommitted}, nil
}

func (supervisor *fakeSupervisor) Run(_ context.Context, tx model.Transaction) (engine.Result, error) {
	supervisor.runs++
	supervisor.tx = tx
	return engine.Result{Outcome: engine.OutcomeUpdated, Phase: model.PhaseCommitted}, nil
}

func (supervisor *fakeSupervisor) Recover(_ context.Context, tx model.Transaction) (engine.Result, error) {
	supervisor.recovers++
	supervisor.tx = tx
	return engine.Result{Outcome: engine.OutcomeAlreadyCurrent, Phase: model.PhaseCommitted}, nil
}

func TestConvergeRecoversDurableUnfinishedTransactionBeforeNewWork(t *testing.T) {
	inventory, target := targetContract()
	manifest := model.Manifest{
		SchemaVersion: model.CurrentManifestSchemaVersion, Profile: model.ProfileProtectedLocal, Platform: platform(),
		ActiveGeneration: &target, StateSchemas: map[string]uint32{"signer": 1}, Capabilities: capabilities(),
		ReleaseSequence: 12, SecurityEpoch: 3,
	}
	pending := model.Transaction{
		SchemaVersion: model.CurrentTransactionSchemaVersion, ID: transactionID, Profile: model.ProfileProtectedLocal,
		PlanAction: "INSTALL", ReleaseSequence: 12, SecurityEpoch: 3, Phase: model.PhaseIdle, Revision: 1,
		Target: target, TargetStateSchemas: map[string]uint32{"signer": 1}, TargetCapabilities: capabilities(),
		ManifestDigest: digestA, StateInventoryDigest: digestB, MigrationPlanDigest: digestA,
		SignerPlanDigest: digestB, PlatformDigest: digestA,
	}
	supervisor := &fakeSupervisor{}
	service := Service{
		Profile: model.ProfileProtectedLocal, Platform: platform(),
		Store:     pendingFakeStore{fakeStore: fakeStore{manifest: &manifest, manifestDigest: digestA, inventory: inventory, generation: target}, pending: pending},
		Inventory: &fakeInventory{}, Supervisor: supervisor,
	}
	request := protocol.Request{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID, Operation: protocol.OperationConverge, TargetGenerationID: target.ID, ExpectedManifestDigest: digestA}
	response, err := service.Handle(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if supervisor.recovers != 1 || supervisor.runs != 0 || response.Outcome != string(engine.OutcomeAlreadyCurrent) {
		t.Fatalf("new convergence did not recover first: response=%+v recovers=%d runs=%d", response, supervisor.recovers, supervisor.runs)
	}
}

func targetContract() (bundle.Inventory, model.Generation) {
	return bundle.Inventory{
		SchemaVersion: bundle.CurrentInventorySchemaVersion, Version: "0.1.76", Commit: commitB, Tree: commitB,
		StateSchemas: map[string]uint32{"signer": 2}, Capabilities: capabilities(),
		Artifacts: []bundle.Artifact{{Path: "bin/fased", Kind: bundle.ArtifactFile, SHA256: digestB, Size: 1, Executable: true}},
	}, generation(digestB, "0.1.76", commitB)
}

func TestConvergeBuildsTransactionFromStoredContract(t *testing.T) {
	inventory, target := targetContract()
	state := fakeStore{inventory: inventory, generation: target}
	bindings := &fakeInventory{}
	supervisor := &fakeSupervisor{}
	service := Service{
		Profile: model.ProfileProtectedLocal, Platform: platform(), Store: state, Inventory: bindings, Supervisor: supervisor,
		NewID: func() (string, error) { return transactionID, nil },
	}
	request := protocol.Request{
		SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID, Operation: protocol.OperationConverge,
		TargetGenerationID: target.ID, ExpectedManifestDigest: "absent",
	}
	response, err := service.Handle(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if response.Outcome != string(engine.OutcomeUpdated) || supervisor.runs != 1 || bindings.calls != 1 {
		t.Fatalf("unexpected convergence: response=%+v runs=%d inventory=%d", response, supervisor.runs, bindings.calls)
	}
	if supervisor.tx.ID != transactionID || supervisor.tx.Target != target || supervisor.tx.MigrationPlanDigest == "" || supervisor.tx.SignerPlanDigest != digestB {
		t.Fatalf("transaction was not bound from stored evidence: %+v", supervisor.tx)
	}
	if supervisor.tx.ReleaseSequence != 12 || supervisor.tx.SecurityEpoch != 3 {
		t.Fatalf("transaction lost root-bound release authority: %+v", supervisor.tx)
	}
	if supervisor.tx.PlanAction != string(planner.ActionInstall) || supervisor.tx.SourceTopology != "" {
		t.Fatalf("fresh transaction lost its planner identity: %+v", supervisor.tx)
	}
}

func TestCompleteOnboardingUsesCommittedManifestAndTargetController(t *testing.T) {
	testCompleteOnboardingUsesCommittedManifestAndTargetController(t, model.ProfileProtectedLocal)
}

func TestHostingCompleteOnboardingUsesCommittedManifestAndTargetController(t *testing.T) {
	testCompleteOnboardingUsesCommittedManifestAndTargetController(t, model.ProfileHosting)
}

func testCompleteOnboardingUsesCommittedManifestAndTargetController(t *testing.T, profile model.Profile) {
	t.Helper()
	_, target := targetContract()
	identity := platformFor(profile)
	manifest := model.Manifest{SchemaVersion: model.CurrentManifestSchemaVersion, Profile: profile,
		Platform: identity, ActiveGeneration: &target, StateSchemas: map[string]uint32{"signer": 2}, Capabilities: capabilities(), ReleaseSequence: 12, SecurityEpoch: 3}
	completion := &fakeOnboarding{}
	service := Service{Profile: profile, Platform: identity,
		Store: fakeStore{manifest: &manifest, manifestDigest: digestA}, Inventory: &fakeInventory{}, Supervisor: &fakeSupervisor{}, Onboarding: completion}
	request := protocol.Request{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID, Operation: protocol.OperationCompleteOnboarding}
	response, err := service.Handle(context.Background(), request)
	if err != nil || completion.calls != 1 || response.Outcome != string(engine.OutcomeUpdated) || response.ActiveGenerationID != target.ID {
		t.Fatalf("unexpected onboarding completion: response=%+v calls=%d err=%v", response, completion.calls, err)
	}
}

func TestConvergeBindsPublicStableBridgeToPreviousGeneration(t *testing.T) {
	inventory, target := targetContract()
	inventory.StateSchemas = map[string]uint32{
		"federation": 2, "managedInstall": 2, "mining": 1, "signer": 2, "walletRegistry": 1,
	}
	state := fakeStore{inventory: inventory, generation: target}
	bindings := &fakeInventory{}
	supervisor := &fakeSupervisor{}
	evidence := &fakePredecessorEvidence{}
	service := Service{
		Profile: model.ProfileProtectedLocal, Platform: platform(), Store: state,
		Inventory: bindings, Supervisor: supervisor, PredecessorEvidence: evidence,
		NewID: func() (string, error) { return transactionID, nil },
	}
	request := protocol.Request{
		SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID,
		Operation: protocol.OperationConverge, TargetGenerationID: target.ID,
		SourceTopology: string(planner.TopologyLocalUserSystemdV1), PublicPredecessorVersion: "0.1.75", ExpectedManifestDigest: "absent",
	}
	response, err := service.Handle(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if response.Outcome != string(engine.OutcomeUpdated) || supervisor.tx.Previous != nil {
		t.Fatalf("public-stable bridge was not transaction-bound: response=%+v transaction=%+v", response, supervisor.tx)
	}
	if supervisor.tx.PlanAction != string(planner.ActionBridgePublicStable) || supervisor.tx.SourceTopology != string(planner.TopologyLocalUserSystemdV1) || supervisor.tx.PublicPredecessorVersion != "0.1.75" {
		t.Fatalf("bridge transaction lost its source identity: %+v", supervisor.tx)
	}
	if evidence.calls != 2 || evidence.topology != request.SourceTopology || evidence.version != request.PublicPredecessorVersion {
		t.Fatalf("public predecessor evidence was not independently verified: %+v", evidence)
	}
	if len(supervisor.tx.Migrations) != 3 || supervisor.tx.Migrations[0] != (model.Migration{State: "federation", From: 1, To: 2}) ||
		supervisor.tx.Migrations[1] != (model.Migration{State: "managedInstall", From: 1, To: 2}) ||
		supervisor.tx.Migrations[2] != (model.Migration{State: "signer", From: 1, To: 2}) {
		t.Fatalf("unexpected bridge migrations: %+v", supervisor.tx.Migrations)
	}
}

func TestConvergeRejectsUnverifiedPublicPredecessorEvidenceBeforeMutation(t *testing.T) {
	inventory, target := targetContract()
	stages := 0
	supervisor := &fakeSupervisor{}
	service := Service{Profile: model.ProfileProtectedLocal, Platform: platform(),
		Store: fakeStore{inventory: inventory, generation: target, stages: &stages}, Inventory: &fakeInventory{}, Supervisor: supervisor,
		PredecessorEvidence: &fakePredecessorEvidence{failOn: 1, err: errors.New("predecessor evidence mismatch")},
		NewID:               func() (string, error) { return transactionID, nil }}
	request := protocol.Request{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID, Operation: protocol.OperationConverge,
		TargetGenerationID: target.ID, SourceTopology: string(planner.TopologyLocalUserSystemdV1), PublicPredecessorVersion: "0.1.75", ExpectedManifestDigest: "absent"}
	if _, err := service.Handle(context.Background(), request); err == nil || stages != 0 || supervisor.runs != 0 {
		t.Fatalf("unverified predecessor evidence reached mutation: stages=%d runs=%d err=%v", stages, supervisor.runs, err)
	}
}

func TestConvergeRechecksPublicPredecessorEvidenceBeforeTransaction(t *testing.T) {
	inventory, target := targetContract()
	inventory.StateSchemas = map[string]uint32{
		"federation": 2, "managedInstall": 2, "mining": 1, "signer": 2, "walletRegistry": 1,
	}
	stages := 0
	bindings := &fakeInventory{}
	supervisor := &fakeSupervisor{}
	evidence := &fakePredecessorEvidence{failOn: 2, err: errors.New("predecessor changed after binding")}
	service := Service{Profile: model.ProfileProtectedLocal, Platform: platform(),
		Store: fakeStore{inventory: inventory, generation: target, stages: &stages}, Inventory: bindings, Supervisor: supervisor,
		PredecessorEvidence: evidence, NewID: func() (string, error) { return transactionID, nil }}
	request := protocol.Request{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID, Operation: protocol.OperationConverge,
		TargetGenerationID: target.ID, SourceTopology: string(planner.TopologyLocalUserSystemdV1), PublicPredecessorVersion: "0.1.75", ExpectedManifestDigest: "absent"}
	if _, err := service.Handle(context.Background(), request); err == nil || evidence.calls != 2 || stages != 1 || bindings.calls != 1 || supervisor.runs != 0 {
		t.Fatalf("changed predecessor reached transaction: calls=%d stages=%d binds=%d runs=%d err=%v", evidence.calls, stages, bindings.calls, supervisor.runs, err)
	}
}

func TestManifestCASMismatchStopsBeforeInventoryOrMutation(t *testing.T) {
	inventory, target := targetContract()
	active := generation(digestA, "0.1.75", commitA)
	manifest := model.Manifest{
		SchemaVersion: model.CurrentManifestSchemaVersion, Profile: model.ProfileProtectedLocal,
		Platform:         platform(),
		ActiveGeneration: &active, StateSchemas: map[string]uint32{"signer": 1}, Capabilities: capabilities(),
	}
	bindings := &fakeInventory{}
	supervisor := &fakeSupervisor{}
	service := Service{
		Profile:   model.ProfileProtectedLocal,
		Platform:  platform(),
		Store:     fakeStore{manifest: &manifest, manifestDigest: digestA, inventory: inventory, generation: target},
		Inventory: bindings, Supervisor: supervisor,
	}
	request := protocol.Request{
		SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID, Operation: protocol.OperationConverge,
		TargetGenerationID: target.ID, ExpectedManifestDigest: digestB,
	}
	if _, err := service.Handle(context.Background(), request); err == nil {
		t.Fatal("stale manifest CAS was accepted")
	}
	if bindings.calls != 0 || supervisor.runs != 0 {
		t.Fatal("CAS mismatch reached state inventory or mutation")
	}
}

func TestAlreadyCurrentDoesNotAllocateTransaction(t *testing.T) {
	inventory, target := targetContract()
	manifest := model.Manifest{
		SchemaVersion: model.CurrentManifestSchemaVersion, Profile: model.ProfileProtectedLocal,
		Platform:         platform(),
		ActiveGeneration: &target, StateSchemas: inventory.StateSchemas, Capabilities: inventory.Capabilities,
	}
	bindings := &fakeInventory{}
	supervisor := &fakeSupervisor{}
	service := Service{
		Profile:   model.ProfileProtectedLocal,
		Platform:  platform(),
		Store:     fakeStore{manifest: &manifest, manifestDigest: digestA, inventory: inventory, generation: target},
		Inventory: bindings, Supervisor: supervisor,
		NewID: func() (string, error) { return "", errors.New("must not allocate") },
	}
	request := protocol.Request{
		SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID, Operation: protocol.OperationConverge,
		TargetGenerationID: target.ID, ExpectedManifestDigest: digestA,
	}
	response, err := service.Handle(context.Background(), request)
	if err != nil || response.Outcome != string(engine.OutcomeAlreadyCurrent) {
		t.Fatalf("already-current failed: %+v err=%v", response, err)
	}
	if bindings.calls != 0 || supervisor.runs != 0 {
		t.Fatal("already-current performed work")
	}
}

func TestInstalledPlatformMismatchRequiresExplicitRepair(t *testing.T) {
	inventory, target := targetContract()
	active := generation(digestA, "0.1.75", commitA)
	wrong, _ := model.NewPlatformIdentity(model.ProfileProtectedLocal, "other-instance", digestA)
	manifest := model.Manifest{
		SchemaVersion: model.CurrentManifestSchemaVersion, Profile: model.ProfileProtectedLocal,
		Platform: wrong, ActiveGeneration: &active,
		StateSchemas: map[string]uint32{"signer": 1}, Capabilities: capabilities(),
	}
	bindings := &fakeInventory{}
	supervisor := &fakeSupervisor{}
	service := Service{
		Profile: model.ProfileProtectedLocal, Platform: platform(),
		Store:     fakeStore{manifest: &manifest, manifestDigest: digestA, inventory: inventory, generation: target},
		Inventory: bindings, Supervisor: supervisor,
	}
	request := protocol.Request{
		SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID, Operation: protocol.OperationConverge,
		TargetGenerationID: target.ID, ExpectedManifestDigest: digestA,
	}
	if _, err := service.Handle(context.Background(), request); err == nil {
		t.Fatal("platform mismatch was accepted as a normal update")
	}
	if bindings.calls != 0 || supervisor.runs != 0 {
		t.Fatal("platform mismatch reached state inventory or mutation")
	}
}

func TestLegacyControllerTopologyRequiresExplicitBridge(t *testing.T) {
	inventory, target := targetContract()
	active := generation(digestA, "0.1.75", commitA)
	legacy, err := model.LegacyControllerPlatformIdentity(model.ProfileProtectedLocal, "test-instance", digestA)
	if err != nil {
		t.Fatal(err)
	}
	manifest := model.Manifest{
		SchemaVersion: model.CurrentManifestSchemaVersion, Profile: model.ProfileProtectedLocal,
		Platform: legacy, ActiveGeneration: &active, StateSchemas: map[string]uint32{"signer": 1}, Capabilities: capabilities(),
		ReleaseSequence: 11, SecurityEpoch: 3,
	}
	bindings := &fakeInventory{}
	supervisor := &fakeSupervisor{}
	service := Service{Profile: model.ProfileProtectedLocal, Platform: platform(), Store: fakeStore{manifest: &manifest, manifestDigest: digestA, inventory: inventory, generation: target}, Inventory: bindings, Supervisor: supervisor}
	request := protocol.Request{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID, Operation: protocol.OperationConverge, TargetGenerationID: target.ID, ExpectedManifestDigest: digestA}
	if _, err := service.Handle(context.Background(), request); err == nil || !strings.Contains(err.Error(), "explicit bridge path") {
		t.Fatalf("legacy controller topology reached normal managed convergence: %v", err)
	}
	if bindings.calls != 0 || supervisor.runs != 0 {
		t.Fatal("legacy controller topology reached mutation before bridge selection")
	}
}

func TestTargetRequiringNewerStableSupervisorFailsBeforeMutation(t *testing.T) {
	inventory, target := targetContract()
	inventory.Capabilities.Supervisor = model.CapabilityRange{Min: 2, Max: 2}
	bindings := &fakeInventory{}
	supervisor := &fakeSupervisor{}
	service := Service{
		Profile: model.ProfileProtectedLocal, Platform: platform(),
		Store: fakeStore{inventory: inventory, generation: target}, Inventory: bindings, Supervisor: supervisor,
	}
	request := protocol.Request{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID,
		Operation: protocol.OperationConverge, TargetGenerationID: target.ID, ExpectedManifestDigest: "absent"}
	if _, err := service.Handle(context.Background(), request); err == nil {
		t.Fatal("generation requiring an unsupported stable supervisor was accepted")
	}
	if bindings.calls != 0 || supervisor.runs != 0 {
		t.Fatal("unsupported supervisor capability reached state inventory or mutation")
	}
}

func TestUnknownNewerManifestRejectsBeforeAnyMutation(t *testing.T) {
	inventory, target := targetContract()
	active := generation(digestA, "future", commitA)
	manifest := model.Manifest{
		SchemaVersion: model.CurrentManifestSchemaVersion + 1,
		Profile:       model.ProfileProtectedLocal,
		Platform:      platform(), ActiveGeneration: &active,
		StateSchemas: map[string]uint32{"signer": 99}, Capabilities: capabilities(),
	}
	locks, stages := 0, 0
	bindings := &fakeInventory{}
	supervisor := &fakeSupervisor{}
	service := Service{
		Profile: model.ProfileProtectedLocal, Platform: platform(),
		Store: fakeStore{
			manifest: &manifest, manifestDigest: digestA,
			inventory: inventory, generation: target, locks: &locks, stages: &stages,
		},
		Inventory: bindings, Supervisor: supervisor,
		NewID: func() (string, error) { return "", errors.New("must not allocate") },
	}
	request := protocol.Request{
		SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID,
		Operation: protocol.OperationConverge, TargetGenerationID: target.ID,
		ExpectedManifestDigest: digestA,
	}
	response, err := service.Handle(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if response.Outcome != string(planner.ActionRejectUnknownNewer) {
		t.Fatalf("unexpected unknown-newer response: %+v", response)
	}
	if locks != 0 || stages != 0 || bindings.calls != 0 || supervisor.runs != 0 {
		t.Fatalf("unknown-newer installation reached mutation: locks=%d stages=%d inventory=%d runs=%d", locks, stages, bindings.calls, supervisor.runs)
	}
}
