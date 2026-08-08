package engine

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"fased-lifecycled/model"
)

type fakeController struct {
	calls  *[]string
	failAt string
}

func (controller fakeController) call(name string) error {
	*controller.calls = append(*controller.calls, "controller."+name)
	if controller.failAt == name {
		return errors.New("injected controller failure")
	}
	return nil
}

func (controller fakeController) Stage(context.Context, model.Transaction) error {
	return controller.call("stage")
}
func (controller fakeController) Prepare(context.Context, model.Transaction) error {
	return controller.call("prepare")
}
func (controller fakeController) Switch(context.Context, model.Transaction) error {
	return controller.call("switch")
}
func (controller fakeController) Verify(context.Context, model.Transaction, Result) error {
	return controller.call("verify")
}
func (controller fakeController) Commit(context.Context, model.Transaction) error {
	return controller.call("commit")
}
func (controller fakeController) Restore(context.Context, model.Transaction) error {
	return controller.call("restore")
}
func (controller fakeController) Discard(context.Context, model.Transaction) error {
	return controller.call("discard")
}

type fakeTarget struct {
	calls  *[]string
	result Result
	err    error
}

func (target fakeTarget) Run(context.Context, model.Transaction) (Result, error) {
	*target.calls = append(*target.calls, "target.run")
	return target.result, target.err
}

func (target fakeTarget) Recover(context.Context, string) (Result, error) {
	*target.calls = append(*target.calls, "target.recover")
	return target.result, target.err
}

func TestSupervisorCommitsOnlyAfterTargetCommit(t *testing.T) {
	var calls []string
	journal := &fakeJournal{}
	engine := SupervisorEngine{
		Journal:    journal,
		Controller: fakeController{calls: &calls},
		Target:     fakeTarget{calls: &calls, result: Result{Outcome: OutcomeUpdated, Phase: model.PhaseCommitted}},
	}
	result, err := engine.Run(context.Background(), transaction(model.PhaseIdle))
	if err != nil || result.Phase != model.PhaseCommitted {
		t.Fatalf("supervisor run failed: %+v err=%v", result, err)
	}
	want := []string{"controller.stage", "controller.prepare", "controller.switch", "target.run", "controller.verify", "controller.commit"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("unexpected supervisor order: got=%v want=%v", calls, want)
	}
}

func TestSupervisorRestoresControllerWhenTargetRollsBack(t *testing.T) {
	var calls []string
	engine := SupervisorEngine{
		Journal:    &fakeJournal{},
		Controller: fakeController{calls: &calls},
		Target:     fakeTarget{calls: &calls, result: Result{Outcome: OutcomeRolledBack, Phase: model.PhaseRolledBack}, err: errors.New("target failed")},
	}
	result, err := engine.Run(context.Background(), transaction(model.PhaseIdle))
	if err == nil || result.Phase != model.PhaseRolledBack {
		t.Fatalf("unexpected supervisor failure: %+v err=%v", result, err)
	}
	wantTail := []string{"target.run", "controller.restore", "controller.discard"}
	if !reflect.DeepEqual(calls[len(calls)-len(wantTail):], wantTail) {
		t.Fatalf("controller rollback order changed: %v", calls)
	}
}

func TestSupervisorRecoveryFinishesCommittedTarget(t *testing.T) {
	var calls []string
	engine := SupervisorEngine{
		Journal:    &fakeJournal{},
		Controller: fakeController{calls: &calls},
		Target:     fakeTarget{calls: &calls, result: Result{Outcome: OutcomeAlreadyCurrent, Phase: model.PhaseCommitted}},
	}
	result, err := engine.Recover(context.Background(), transaction(model.PhaseSwitched))
	if err != nil || result.Phase != model.PhaseCommitted {
		t.Fatalf("supervisor recovery failed: %+v err=%v", result, err)
	}
	want := []string{"target.recover", "controller.verify", "controller.commit"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("unexpected recovery order: got=%v want=%v", calls, want)
	}
}
