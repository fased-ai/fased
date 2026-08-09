package engine

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"fased-lifecycled/model"
	"fased-lifecycled/store"
)

const (
	digestA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	digestB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	commitA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	commitB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func transaction(phase model.Phase) model.Transaction {
	revision := map[model.Phase]uint64{
		model.PhaseIdle: 1, model.PhaseStaged: 2, model.PhasePrepared: 3,
		model.PhaseSwitched: 4, model.PhaseVerified: 5, model.PhaseCommitted: 6,
		model.PhaseRolledBack: 5,
	}[phase]
	previous := model.Generation{ID: digestA, Version: "0.1.75", Commit: commitA, Tree: commitA, ArtifactSetDigest: digestA}
	return model.Transaction{
		SchemaVersion:      model.CurrentTransactionSchemaVersion,
		ID:                 "018f47d2-5a6b-7c8d-9e0f-123456789abc",
		Profile:            model.ProfileProtectedLocal,
		PlanAction:         "UPDATE",
		Phase:              phase,
		Revision:           revision,
		Target:             model.Generation{ID: digestB, Version: "0.1.76", Commit: commitB, Tree: commitB, ArtifactSetDigest: digestB},
		TargetStateSchemas: map[string]uint32{"signer": 2},
		TargetCapabilities: model.CapabilityRanges{
			Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1},
			Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1},
		},
		Previous:             &previous,
		ManifestDigest:       digestA,
		StateInventoryDigest: digestB,
		MigrationPlanDigest:  digestA,
		SignerPlanDigest:     digestB,
		PlatformDigest:       digestA,
	}
}

type fakeJournal struct {
	writes []model.Transaction
	latest map[store.Authority]model.Transaction
}

func (journal *fakeJournal) CommitJournal(authority store.Authority, tx model.Transaction) error {
	if authority != store.AuthorityTargetController && authority != store.AuthoritySupervisor {
		return errors.New("wrong journal authority")
	}
	journal.writes = append(journal.writes, tx)
	if journal.latest == nil {
		journal.latest = make(map[store.Authority]model.Transaction)
	}
	journal.latest[authority] = tx
	return nil
}

func (journal *fakeJournal) ReadJournal(authority store.Authority, transactionID string) (model.Transaction, error) {
	tx, ok := journal.latest[authority]
	if !ok || tx.ID != transactionID {
		return model.Transaction{}, errors.New("journal not found")
	}
	return tx, nil
}

type fakeGenerationStore struct {
	calls *[]string
	fail  error
}

func (generations fakeGenerationStore) StageGeneration(string) error {
	*generations.calls = append(*generations.calls, "generation.stage")
	return generations.fail
}

type fakeParticipant struct {
	name   string
	calls  *[]string
	failAt string
}

func (participant fakeParticipant) Prepare(_ context.Context, tx model.Transaction) (ParticipantReceipt, error) {
	*participant.calls = append(*participant.calls, participant.name+".prepare")
	if participant.failAt == "prepare" {
		return ParticipantReceipt{}, errors.New("injected prepare failure")
	}
	digest := tx.MigrationPlanDigest
	if participant.name == "signer" {
		digest = tx.SignerPlanDigest
	}
	return ParticipantReceipt{TransactionID: tx.ID, TargetGenerationID: tx.Target.ID, StateInventoryDigest: tx.StateInventoryDigest, PlanDigest: digest}, nil
}

func (participant fakeParticipant) Verify(_ context.Context, _ model.Transaction, _ ParticipantReceipt) error {
	*participant.calls = append(*participant.calls, participant.name+".verify")
	if participant.failAt == "verify" {
		return errors.New("injected verify failure")
	}
	return nil
}

func (participant fakeParticipant) Activate(_ context.Context, _ model.Transaction) error {
	*participant.calls = append(*participant.calls, participant.name+".activate")
	if participant.failAt == "activate" {
		return errors.New("injected activate failure")
	}
	return nil
}

func (participant fakeParticipant) Commit(_ context.Context, _ model.Transaction) error {
	*participant.calls = append(*participant.calls, participant.name+".commit")
	if participant.failAt == "commit" {
		return errors.New("injected commit failure")
	}
	return nil
}

func (participant fakeParticipant) Abort(_ context.Context, _ model.Transaction) error {
	*participant.calls = append(*participant.calls, participant.name+".abort")
	return nil
}

type fakeAdapter struct {
	calls  *[]string
	failAt string
}

func (adapter fakeAdapter) Prepare(context.Context, model.Transaction) error {
	*adapter.calls = append(*adapter.calls, "adapter.prepare")
	return nil
}

func (adapter fakeAdapter) Verify(context.Context, model.Transaction) error {
	*adapter.calls = append(*adapter.calls, "adapter.verify")
	return nil
}

func (adapter fakeAdapter) Commit(context.Context, model.Transaction) error {
	*adapter.calls = append(*adapter.calls, "adapter.commit")
	return nil
}

func (adapter fakeAdapter) Quiesce(context.Context, model.Transaction) error {
	*adapter.calls = append(*adapter.calls, "adapter.quiesce")
	if adapter.failAt == "quiesce" {
		return errors.New("injected quiesce failure")
	}
	return nil
}

func (adapter fakeAdapter) Activate(context.Context, model.Transaction) error {
	*adapter.calls = append(*adapter.calls, "adapter.activate")
	if adapter.failAt == "activate" {
		return errors.New("injected adapter activation failure")
	}
	return nil
}

func (adapter fakeAdapter) Restore(context.Context, model.Transaction) error {
	*adapter.calls = append(*adapter.calls, "adapter.restore")
	return nil
}

func (adapter fakeAdapter) Discard(context.Context, model.Transaction) error {
	*adapter.calls = append(*adapter.calls, "adapter.discard")
	return nil
}

type fakeInstallation struct {
	calls *[]string
}

func (installation fakeInstallation) Commit(context.Context, model.Transaction) error {
	*installation.calls = append(*installation.calls, "installation.commit")
	return nil
}

func newEngine(calls *[]string, adapterFail, signerFail string) (*TargetEngine, *fakeJournal) {
	journal := &fakeJournal{}
	return &TargetEngine{
		Journal:      journal,
		Generations:  fakeGenerationStore{calls: calls},
		Migrator:     fakeParticipant{name: "migrator", calls: calls},
		Signer:       fakeParticipant{name: "signer", calls: calls, failAt: signerFail},
		Adapter:      fakeAdapter{calls: calls, failAt: adapterFail},
		Installation: fakeInstallation{calls: calls},
	}, journal
}

func TestTargetEngineCommitsOneOrderedTransaction(t *testing.T) {
	var calls []string
	engine, journal := newEngine(&calls, "", "")
	result, err := engine.Run(context.Background(), transaction(model.PhaseIdle))
	if err != nil {
		t.Fatal(err)
	}
	if result.Phase != model.PhaseVerified || result.Outcome != OutcomePrepared {
		t.Fatalf("unexpected result: %+v", result)
	}
	result, err = engine.Commit(context.Background(), transaction(model.PhaseIdle).ID)
	if err != nil || result.Phase != model.PhaseCommitted || result.Outcome != OutcomeUpdated {
		t.Fatalf("explicit target commit failed: %+v err=%v", result, err)
	}
	wantCalls := []string{
		"generation.stage", "migrator.prepare", "signer.prepare", "adapter.prepare",
		"adapter.quiesce", "migrator.activate", "adapter.activate", "migrator.verify", "signer.verify", "adapter.verify",
		"migrator.commit", "signer.commit", "adapter.commit", "installation.commit",
	}
	if !reflect.DeepEqual(calls, wantCalls) {
		t.Fatalf("unexpected call order:\n got=%v\nwant=%v", calls, wantCalls)
	}
	wantPhases := []model.Phase{model.PhaseIdle, model.PhaseStaged, model.PhasePrepared, model.PhaseSwitched, model.PhaseVerified, model.PhaseCommitted}
	if len(journal.writes) != len(wantPhases) {
		t.Fatalf("unexpected journal writes: %+v", journal.writes)
	}
	for index, phase := range wantPhases {
		if journal.writes[index].Phase != phase {
			t.Fatalf("journal phase %d: got %s want %s", index, journal.writes[index].Phase, phase)
		}
	}
}

func TestTargetEngineRestoresAfterSwitchFailure(t *testing.T) {
	var calls []string
	engine, journal := newEngine(&calls, "activate", "")
	result, err := engine.Run(context.Background(), transaction(model.PhaseIdle))
	if err == nil || result.Outcome != OutcomeRolledBack || result.Phase != model.PhaseRolledBack {
		t.Fatalf("unexpected failure result: %+v err=%v", result, err)
	}
	wantTail := []string{"adapter.quiesce", "migrator.activate", "adapter.activate", "adapter.quiesce", "signer.abort", "migrator.abort", "adapter.restore", "adapter.discard"}
	if !reflect.DeepEqual(calls[len(calls)-len(wantTail):], wantTail) {
		t.Fatalf("unexpected rollback order: %v", calls)
	}
	if journal.writes[len(journal.writes)-1].Phase != model.PhaseRolledBack {
		t.Fatalf("rollback was not journaled: %+v", journal.writes)
	}
}

func TestRecoverCompletesVerifiedAndRollsBackSwitched(t *testing.T) {
	var verifiedCalls []string
	verifiedEngine, _ := newEngine(&verifiedCalls, "", "")
	verified, err := verifiedEngine.Recover(context.Background(), transaction(model.PhaseVerified))
	if err != nil || verified.Phase != model.PhaseCommitted {
		t.Fatalf("verified recovery failed: %+v err=%v", verified, err)
	}

	var switchedCalls []string
	switchedEngine, _ := newEngine(&switchedCalls, "", "")
	switched, err := switchedEngine.Recover(context.Background(), transaction(model.PhaseSwitched))
	if err != nil || switched.Phase != model.PhaseRolledBack {
		t.Fatalf("switched recovery failed: %+v err=%v", switched, err)
	}
	if len(switchedCalls) == 0 || switchedCalls[0] != "adapter.quiesce" {
		t.Fatalf("switched recovery did not quiesce target first: %v", switchedCalls)
	}
}
