package daemon

import (
	"context"
	"errors"
	"os"
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
	value, _ := model.NewPlatformIdentity(model.ProfileProtectedLocal, "test-instance", digestA)
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

type fakeInventory struct {
	calls int
}

func (inventory *fakeInventory) Bind(context.Context, planner.Installation, bundle.Inventory, planner.Plan) (string, string, error) {
	inventory.calls++
	return digestA, digestB, nil
}

type fakeSupervisor struct {
	runs int
	tx   model.Transaction
}

func (supervisor *fakeSupervisor) Run(_ context.Context, tx model.Transaction) (engine.Result, error) {
	supervisor.runs++
	supervisor.tx = tx
	return engine.Result{Outcome: engine.OutcomeUpdated, Phase: model.PhaseCommitted}, nil
}

func (supervisor *fakeSupervisor) Recover(_ context.Context, tx model.Transaction) (engine.Result, error) {
	supervisor.tx = tx
	return engine.Result{Outcome: engine.OutcomeAlreadyCurrent, Phase: model.PhaseCommitted}, nil
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
}

func TestConvergeBindsPublicStableBridgeToPreviousGeneration(t *testing.T) {
	inventory, target := targetContract()
	inventory.StateSchemas = map[string]uint32{
		"federation": 2, "managedInstall": 2, "mining": 1, "signer": 2, "walletRegistry": 1,
	}
	state := fakeStore{inventory: inventory, generation: target}
	bindings := &fakeInventory{}
	supervisor := &fakeSupervisor{}
	service := Service{
		Profile: model.ProfileProtectedLocal, Platform: platform(), Store: state,
		Inventory: bindings, Supervisor: supervisor,
		NewID: func() (string, error) { return transactionID, nil },
	}
	request := protocol.Request{
		SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID,
		Operation: protocol.OperationConverge, TargetGenerationID: target.ID,
		SourceTopology: string(planner.TopologyLocalUserSystemdV1), ExpectedManifestDigest: "absent",
	}
	response, err := service.Handle(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if response.Outcome != string(engine.OutcomeUpdated) || supervisor.tx.Previous != nil {
		t.Fatalf("public-stable bridge was not transaction-bound: response=%+v transaction=%+v", response, supervisor.tx)
	}
	if len(supervisor.tx.Migrations) != 3 || supervisor.tx.Migrations[0] != (model.Migration{State: "federation", From: 1, To: 2}) ||
		supervisor.tx.Migrations[1] != (model.Migration{State: "managedInstall", From: 1, To: 2}) ||
		supervisor.tx.Migrations[2] != (model.Migration{State: "signer", From: 1, To: 2}) {
		t.Fatalf("unexpected bridge migrations: %+v", supervisor.tx.Migrations)
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
