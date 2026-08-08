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

func (state fakeStore) ReadGenerationContract(string) (bundle.Inventory, model.Generation, error) {
	return state.inventory, state.generation, nil
}

type fakeInventory struct {
	calls int
}

func (inventory *fakeInventory) Bind(context.Context, *model.Manifest, bundle.Inventory, planner.Plan) (string, string, error) {
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
		Artifacts: []bundle.Artifact{{Path: "bin/fased", SHA256: digestB, Size: 1, Executable: true}},
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
