package engine

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"fased-lifecycled/model"
	"fased-lifecycled/store"
)

type fakeTarget struct {
	calls  *[]string
	result Result
	err    error
}

func (target fakeTarget) Run(context.Context, model.Transaction) (Result, error) {
	*target.calls = append(*target.calls, "target.run")
	return target.result, target.err
}

func (target fakeTarget) Commit(context.Context, string) (Result, error) {
	*target.calls = append(*target.calls, "target.commit")
	if target.err != nil {
		return target.result, target.err
	}
	return Result{Outcome: OutcomeUpdated, Phase: model.PhaseCommitted}, nil
}

func (target fakeTarget) Abort(context.Context, string) (Result, error) {
	*target.calls = append(*target.calls, "target.abort")
	return Result{Outcome: OutcomeRolledBack, Phase: model.PhaseRolledBack}, nil
}

func (target fakeTarget) Recover(context.Context, model.Transaction) (Result, error) {
	*target.calls = append(*target.calls, "target.recover")
	return target.result, target.err
}

func TestSupervisorCommitsOnlyAfterTargetCommit(t *testing.T) {
	var calls []string
	journal := &fakeJournal{}
	engine := SupervisorEngine{
		Journal: journal,
		Target:  fakeTarget{calls: &calls, result: Result{Outcome: OutcomePrepared, Phase: model.PhaseVerified}},
	}
	result, err := engine.Run(context.Background(), transaction(model.PhaseIdle))
	if err != nil || result.Phase != model.PhaseCommitted {
		t.Fatalf("supervisor run failed: %+v err=%v", result, err)
	}
	want := []string{"target.run", "target.commit"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("unexpected supervisor order: got=%v want=%v", calls, want)
	}
}

func TestSupervisorAbortsInstalledTargetWhenItRollsBack(t *testing.T) {
	var calls []string
	engine := SupervisorEngine{
		Journal: &fakeJournal{},
		Target:  fakeTarget{calls: &calls, result: Result{Outcome: OutcomeRolledBack, Phase: model.PhaseRolledBack}, err: errors.New("target failed")},
	}
	result, err := engine.Run(context.Background(), transaction(model.PhaseIdle))
	if err == nil || result.Phase != model.PhaseRolledBack {
		t.Fatalf("unexpected supervisor failure: %+v err=%v", result, err)
	}
	wantTail := []string{"target.run", "target.abort"}
	if !reflect.DeepEqual(calls[len(calls)-len(wantTail):], wantTail) {
		t.Fatalf("installed target rollback order changed: %v", calls)
	}
}

func TestSupervisorRecoveryFinishesCommittedTarget(t *testing.T) {
	var calls []string
	engine := SupervisorEngine{
		Journal: &fakeJournal{},
		Target:  fakeTarget{calls: &calls, result: Result{Outcome: OutcomeAlreadyCurrent, Phase: model.PhaseCommitted}},
	}
	result, err := engine.Recover(context.Background(), transaction(model.PhaseSwitched))
	if err != nil || result.Phase != model.PhaseCommitted {
		t.Fatalf("supervisor recovery failed: %+v err=%v", result, err)
	}
	want := []string{"target.recover"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("unexpected recovery order: got=%v want=%v", calls, want)
	}
}

func TestSupervisorRecoveryMatrixUsesReopenedAuthorityJournal(t *testing.T) {
	cases := []struct {
		phase model.Phase
		want  model.Phase
	}{
		{phase: model.PhaseIdle, want: model.PhaseRolledBack},
		{phase: model.PhaseStaged, want: model.PhaseRolledBack},
		{phase: model.PhasePrepared, want: model.PhaseRolledBack},
		{phase: model.PhaseSwitched, want: model.PhaseCommitted},
		{phase: model.PhaseVerified, want: model.PhaseCommitted},
		{phase: model.PhaseCommitted, want: model.PhaseCommitted},
		{phase: model.PhaseRolledBack, want: model.PhaseRolledBack},
	}
	for _, test := range cases {
		t.Run(string(test.phase), func(t *testing.T) {
			root := t.TempDir()
			journal, err := store.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			tx := transaction(model.PhaseIdle)
			if err := journal.CommitJournal(store.AuthoritySupervisor, tx); err != nil {
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
				if err := journal.CommitJournal(store.AuthoritySupervisor, tx); err != nil {
					t.Fatal(err)
				}
				if phase == test.phase {
					break
				}
			}
			reopened, err := store.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			durable, err := reopened.ReadJournal(store.AuthoritySupervisor, tx.ID)
			if err != nil {
				t.Fatal(err)
			}
			var calls []string
			engine := SupervisorEngine{Journal: reopened, Target: fakeTarget{calls: &calls, result: Result{Outcome: OutcomeAlreadyCurrent, Phase: model.PhaseCommitted}}}
			result, err := engine.Recover(context.Background(), durable)
			if err != nil || result.Phase != test.want {
				t.Fatalf("reopened supervisor phase %s converged to %+v, want %s: %v", test.phase, result, test.want, err)
			}
		})
	}
}
