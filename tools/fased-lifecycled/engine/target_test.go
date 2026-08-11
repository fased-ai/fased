package engine

import (
	"context"
	"errors"
	"os"
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
		ReleaseSequence:    12,
		SecurityEpoch:      3,
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
	events []store.ProgressEvent
}

func (journal *fakeJournal) AppendProgress(_ model.Transaction, event store.ProgressEvent) error {
	event.Sequence = uint32(len(journal.events) + 1)
	journal.events = append(journal.events, event)
	return nil
}

func (journal *fakeJournal) ReadProgress(transactionID string) (store.ProgressRecord, error) {
	if len(journal.events) == 0 {
		return store.ProgressRecord{}, os.ErrNotExist
	}
	return store.ProgressRecord{SchemaVersion: store.CurrentProgressSchemaVersion, TransactionID: transactionID, Events: append([]store.ProgressEvent(nil), journal.events...)}, nil
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

func (adapter fakeAdapter) PrepareState(_ context.Context, tx model.Transaction) (ParticipantReceipt, string, error) {
	*adapter.calls = append(*adapter.calls, "adapter.prepare-state")
	return ParticipantReceipt{TransactionID: tx.ID, TargetGenerationID: tx.Target.ID, StateInventoryDigest: tx.StateInventoryDigest, PlanDigest: tx.StateInventoryDigest}, tx.StateInventoryDigest, nil
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

func (adapter fakeAdapter) StopTarget(context.Context, model.Transaction) error {
	*adapter.calls = append(*adapter.calls, "adapter.stop-target")
	if adapter.failAt == "stop-target" {
		return errors.New("injected target stop failure")
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

type recoveryStateAdapter struct {
	fakeAdapter
	state *string
}

func (adapter recoveryStateAdapter) Restore(ctx context.Context, tx model.Transaction) error {
	if err := adapter.fakeAdapter.Restore(ctx, tx); err != nil {
		return err
	}
	*adapter.state = "previous"
	return nil
}

type recoveryStateInstallation struct {
	fakeInstallation
	state *string
}

func (installation recoveryStateInstallation) Commit(ctx context.Context, tx model.Transaction) error {
	if err := installation.fakeInstallation.Commit(ctx, tx); err != nil {
		return err
	}
	*installation.state = "target"
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
		"generation.stage", "signer.prepare", "adapter.prepare",
		"adapter.quiesce", "adapter.prepare-state", "migrator.prepare", "migrator.activate", "adapter.activate", "migrator.verify", "signer.verify", "adapter.verify",
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
	foundStateReceipt := false
	for _, event := range journal.events {
		if event.Step == store.ProgressStatePrepared && event.Receipt != nil && event.Receipt.Participant == "state" && event.Undo != nil && event.Undo.Digest == digestB {
			foundStateReceipt = true
		}
	}
	if !foundStateReceipt {
		t.Fatalf("post-quiesce typed-state receipt was not journaled: %+v", journal.events)
	}
}

func TestTargetEngineRestoresAfterSwitchFailure(t *testing.T) {
	var calls []string
	engine, journal := newEngine(&calls, "activate", "")
	result, err := engine.Run(context.Background(), transaction(model.PhaseIdle))
	if err == nil || result.Outcome != OutcomeRolledBack || result.Phase != model.PhaseRolledBack {
		t.Fatalf("unexpected failure result: %+v err=%v", result, err)
	}
	wantTail := []string{"adapter.quiesce", "adapter.prepare-state", "migrator.prepare", "migrator.activate", "adapter.activate", "adapter.stop-target", "signer.abort", "migrator.abort", "adapter.restore", "adapter.discard"}
	if !reflect.DeepEqual(calls[len(calls)-len(wantTail):], wantTail) {
		t.Fatalf("unexpected rollback order: %v", calls)
	}
	if journal.writes[len(journal.writes)-1].Phase != model.PhaseRolledBack {
		t.Fatalf("rollback was not journaled: %+v", journal.writes)
	}
}

func TestRecoverCompletesVerifiedAndRollsBackSwitched(t *testing.T) {
	var verifiedCalls []string
	verifiedEngine, verifiedJournal := newEngine(&verifiedCalls, "", "")
	verifiedTx := transaction(model.PhaseVerified)
	_ = verifiedJournal.CommitJournal(store.AuthorityTargetController, verifiedTx)
	_ = verifiedJournal.AppendProgress(verifiedTx, store.ProgressEvent{Step: store.ProgressPlatformVerified})
	verified, err := verifiedEngine.Recover(context.Background(), verifiedTx)
	if err != nil || verified.Phase != model.PhaseCommitted {
		t.Fatalf("verified recovery failed: %+v err=%v", verified, err)
	}

	var switchedCalls []string
	switchedEngine, switchedJournal := newEngine(&switchedCalls, "", "")
	switchedTx := transaction(model.PhaseSwitched)
	_ = switchedJournal.CommitJournal(store.AuthorityTargetController, switchedTx)
	_ = switchedJournal.AppendProgress(switchedTx, store.ProgressEvent{Step: store.ProgressPlatformActivated})
	switched, err := switchedEngine.Recover(context.Background(), switchedTx)
	if err != nil || switched.Phase != model.PhaseRolledBack {
		t.Fatalf("switched recovery failed: %+v err=%v", switched, err)
	}
	if len(switchedCalls) == 0 || switchedCalls[0] != "adapter.stop-target" {
		t.Fatalf("switched recovery did not stop target first: %v", switchedCalls)
	}
}

func TestBridgeWithoutManagedPreviousStopsTargetAfterActivationFailure(t *testing.T) {
	var calls []string
	engine, journal := newEngine(&calls, "activate", "")
	tx := transaction(model.PhaseIdle)
	tx.PlanAction = "BRIDGE_PUBLIC_STABLE"
	tx.SourceTopology = "local-user-systemd-v2"
	tx.PublicPredecessorVersion = "0.1.75"
	tx.Previous = nil
	tx.ManifestDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

	result, err := engine.Run(context.Background(), tx)
	if err == nil || result.Outcome != OutcomeRolledBack || result.Phase != model.PhaseRolledBack {
		t.Fatalf("unexpected bridge failure result: %+v err=%v", result, err)
	}
	wantTail := []string{"adapter.quiesce", "adapter.prepare-state", "migrator.prepare", "migrator.activate", "adapter.activate", "adapter.stop-target", "signer.abort", "migrator.abort", "adapter.restore", "adapter.discard"}
	if !reflect.DeepEqual(calls[len(calls)-len(wantTail):], wantTail) {
		t.Fatalf("bridge rollback did not stop the canonical target: got=%v want-tail=%v", calls, wantTail)
	}
	if journal.writes[len(journal.writes)-1].Phase != model.PhaseRolledBack {
		t.Fatalf("bridge rollback was not journaled: %+v", journal.writes)
	}
}

func TestRecoveryMatrixReopensEveryDurablePhaseAndConvergesExactly(t *testing.T) {
	cases := []struct {
		name      string
		phase     model.Phase
		progress  store.ProgressStep
		initial   string
		expected  string
		wantPhase model.Phase
	}{
		{name: "idle", phase: model.PhaseIdle, initial: "previous", expected: "previous", wantPhase: model.PhaseRolledBack},
		{name: "staged", phase: model.PhaseStaged, progress: store.ProgressGenerationStaged, initial: "previous", expected: "previous", wantPhase: model.PhaseRolledBack},
		{name: "prepared", phase: model.PhasePrepared, progress: store.ProgressPlatformPrepared, initial: "previous", expected: "previous", wantPhase: model.PhaseRolledBack},
		{name: "switched", phase: model.PhaseSwitched, progress: store.ProgressPlatformActivated, initial: "target", expected: "previous", wantPhase: model.PhaseRolledBack},
		{name: "verified", phase: model.PhaseVerified, progress: store.ProgressPlatformVerified, initial: "target", expected: "target", wantPhase: model.PhaseCommitted},
		{name: "committed", phase: model.PhaseCommitted, progress: store.ProgressManifestCommitted, initial: "target", expected: "target", wantPhase: model.PhaseCommitted},
		{name: "rolled-back", phase: model.PhaseRolledBack, progress: store.ProgressRollbackCompleted, initial: "previous", expected: "previous", wantPhase: model.PhaseRolledBack},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			journal, err := store.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			tx := transaction(model.PhaseIdle)
			if err := journal.CommitJournal(store.AuthorityTargetController, tx); err != nil {
				t.Fatal(err)
			}
			path := []model.Phase{model.PhaseStaged, model.PhasePrepared, model.PhaseSwitched, model.PhaseVerified, model.PhaseCommitted}
			if test.phase == model.PhaseRolledBack {
				path = []model.Phase{model.PhaseRolledBack}
			}
			for _, phase := range path {
				if test.phase == model.PhaseIdle {
					break
				}
				tx, err = model.Advance(tx, phase)
				if err != nil {
					t.Fatal(err)
				}
				if err := journal.CommitJournal(store.AuthorityTargetController, tx); err != nil {
					t.Fatal(err)
				}
				if phase == test.phase {
					break
				}
			}
			if test.progress != "" {
				if err := journal.AppendProgress(tx, store.ProgressEvent{Step: test.progress}); err != nil {
					t.Fatal(err)
				}
			}

			// A new Store and TargetEngine model a killed host process reopening
			// only durable journal, progress, receipt, and undo evidence.
			reopened, err := store.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			state := test.initial
			var calls []string
			engine := &TargetEngine{
				Journal: reopened, Generations: fakeGenerationStore{calls: &calls},
				Migrator: fakeParticipant{name: "migrator", calls: &calls}, Signer: fakeParticipant{name: "signer", calls: &calls},
				Adapter:      recoveryStateAdapter{fakeAdapter: fakeAdapter{calls: &calls}, state: &state},
				Installation: recoveryStateInstallation{fakeInstallation: fakeInstallation{calls: &calls}, state: &state},
			}
			result, err := engine.Recover(context.Background(), tx)
			if err != nil {
				t.Fatal(err)
			}
			if result.Phase != test.wantPhase || state != test.expected {
				t.Fatalf("reopened %s converged to phase=%s state=%s, want phase=%s state=%s", test.phase, result.Phase, state, test.wantPhase, test.expected)
			}
		})
	}
}

func TestRecoveryResumesCommitAndRollbackFromDurableSubphase(t *testing.T) {
	t.Run("commit", func(t *testing.T) {
		root := t.TempDir()
		journal, err := store.Open(root)
		if err != nil {
			t.Fatal(err)
		}
		tx := transaction(model.PhaseIdle)
		if err := journal.CommitJournal(store.AuthorityTargetController, tx); err != nil {
			t.Fatal(err)
		}
		for _, phase := range []model.Phase{model.PhaseStaged, model.PhasePrepared, model.PhaseSwitched, model.PhaseVerified} {
			tx, err = model.Advance(tx, phase)
			if err != nil {
				t.Fatal(err)
			}
			if err := journal.CommitJournal(store.AuthorityTargetController, tx); err != nil {
				t.Fatal(err)
			}
		}
		for _, step := range []store.ProgressStep{store.ProgressPlatformVerified, store.ProgressMigratorCommitted} {
			if err := journal.AppendProgress(tx, store.ProgressEvent{Step: step}); err != nil {
				t.Fatal(err)
			}
		}
		reopened, err := store.Open(root)
		if err != nil {
			t.Fatal(err)
		}
		state := "target"
		var calls []string
		engine := &TargetEngine{Journal: reopened, Generations: fakeGenerationStore{calls: &calls}, Migrator: fakeParticipant{name: "migrator", calls: &calls}, Signer: fakeParticipant{name: "signer", calls: &calls}, Adapter: recoveryStateAdapter{fakeAdapter: fakeAdapter{calls: &calls}, state: &state}, Installation: recoveryStateInstallation{fakeInstallation: fakeInstallation{calls: &calls}, state: &state}}
		result, err := engine.Recover(context.Background(), tx)
		if err != nil || result.Phase != model.PhaseCommitted || state != "target" {
			t.Fatalf("commit subphase recovery failed: result=%+v state=%s err=%v", result, state, err)
		}
		for _, call := range calls {
			if call == "migrator.commit" {
				t.Fatalf("durably committed migrator was replayed: %v", calls)
			}
		}
	})

	t.Run("rollback", func(t *testing.T) {
		root := t.TempDir()
		journal, err := store.Open(root)
		if err != nil {
			t.Fatal(err)
		}
		tx := transaction(model.PhaseIdle)
		if err := journal.CommitJournal(store.AuthorityTargetController, tx); err != nil {
			t.Fatal(err)
		}
		for _, phase := range []model.Phase{model.PhaseStaged, model.PhasePrepared, model.PhaseSwitched} {
			tx, err = model.Advance(tx, phase)
			if err != nil {
				t.Fatal(err)
			}
			if err := journal.CommitJournal(store.AuthorityTargetController, tx); err != nil {
				t.Fatal(err)
			}
		}
		for _, step := range []store.ProgressStep{store.ProgressPlatformActivated, store.ProgressRollbackStarted, store.ProgressTargetStopped, store.ProgressSignerAborted} {
			if err := journal.AppendProgress(tx, store.ProgressEvent{Step: step}); err != nil {
				t.Fatal(err)
			}
		}
		reopened, err := store.Open(root)
		if err != nil {
			t.Fatal(err)
		}
		state := "target"
		var calls []string
		engine := &TargetEngine{Journal: reopened, Generations: fakeGenerationStore{calls: &calls}, Migrator: fakeParticipant{name: "migrator", calls: &calls}, Signer: fakeParticipant{name: "signer", calls: &calls}, Adapter: recoveryStateAdapter{fakeAdapter: fakeAdapter{calls: &calls}, state: &state}, Installation: recoveryStateInstallation{fakeInstallation: fakeInstallation{calls: &calls}, state: &state}}
		result, err := engine.Recover(context.Background(), tx)
		if err != nil || result.Phase != model.PhaseRolledBack || state != "previous" {
			t.Fatalf("rollback subphase recovery failed: result=%+v state=%s err=%v", result, state, err)
		}
		for _, call := range calls {
			if call == "adapter.stop-target" || call == "signer.abort" {
				t.Fatalf("durably completed rollback subphase was replayed: %v", calls)
			}
		}
	})
}

func TestPreparedRecoveryRestoresWhenDurableQuiesceStarted(t *testing.T) {
	root := t.TempDir()
	journal, err := store.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	tx := transaction(model.PhaseIdle)
	if err := journal.CommitJournal(store.AuthorityTargetController, tx); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []model.Phase{model.PhaseStaged, model.PhasePrepared} {
		tx, err = model.Advance(tx, phase)
		if err != nil {
			t.Fatal(err)
		}
		if err := journal.CommitJournal(store.AuthorityTargetController, tx); err != nil {
			t.Fatal(err)
		}
	}
	for _, step := range []store.ProgressStep{store.ProgressPlatformPrepared, store.ProgressQuiesceStarted} {
		if err := journal.AppendProgress(tx, store.ProgressEvent{Step: step}); err != nil {
			t.Fatal(err)
		}
	}
	reopened, err := store.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	state := "previous"
	var calls []string
	engine := &TargetEngine{Journal: reopened, Generations: fakeGenerationStore{calls: &calls}, Migrator: fakeParticipant{name: "migrator", calls: &calls}, Signer: fakeParticipant{name: "signer", calls: &calls}, Adapter: recoveryStateAdapter{fakeAdapter: fakeAdapter{calls: &calls}, state: &state}, Installation: recoveryStateInstallation{fakeInstallation: fakeInstallation{calls: &calls}, state: &state}}
	result, err := engine.Recover(context.Background(), tx)
	if err != nil || result.Phase != model.PhaseRolledBack || state != "previous" {
		t.Fatalf("post-quiesce prepared recovery failed: result=%+v state=%s err=%v", result, state, err)
	}
	foundRestore := false
	for _, call := range calls {
		foundRestore = foundRestore || call == "adapter.restore"
	}
	if !foundRestore {
		t.Fatalf("post-quiesce prepared recovery did not restore services: %v", calls)
	}
}
