package engine

import (
	"context"
	"errors"
	"fmt"

	"fased-lifecycled/model"
	"fased-lifecycled/store"
)

type ControllerAuthority interface {
	Stage(context.Context, model.Transaction) error
	Prepare(context.Context, model.Transaction) error
	Switch(context.Context, model.Transaction) error
	Verify(context.Context, model.Transaction, Result) error
	Commit(context.Context, model.Transaction) error
	Restore(context.Context, model.Transaction) error
	Discard(context.Context, model.Transaction) error
}

type TargetAuthority interface {
	Run(context.Context, model.Transaction) (Result, error)
	Commit(context.Context, string) (Result, error)
	Abort(context.Context, string) (Result, error)
	Recover(context.Context, string) (Result, error)
}

type SupervisorEngine struct {
	Journal    Journal
	Controller ControllerAuthority
	Target     TargetAuthority
}

func (engine *SupervisorEngine) Run(ctx context.Context, tx model.Transaction) (Result, error) {
	if err := engine.validate(); err != nil {
		return Result{}, err
	}
	if tx.Phase != model.PhaseIdle || tx.Revision != 1 {
		return Result{}, errors.New("new supervisor transaction must begin at IDLE revision 1")
	}
	if err := tx.Validate(); err != nil {
		return Result{}, err
	}
	if err := engine.Journal.CommitJournal(store.AuthoritySupervisor, tx); err != nil {
		return Result{}, err
	}
	if err := engine.Controller.Stage(ctx, tx); err != nil {
		return Result{Outcome: OutcomeRolledBack, Phase: model.PhaseIdle}, err
	}
	var err error
	tx, err = engine.advance(tx, model.PhaseStaged)
	if err != nil {
		return Result{}, err
	}
	if err := engine.Controller.Prepare(ctx, tx); err != nil {
		return engine.rollback(ctx, tx, false, err)
	}
	tx, err = engine.advance(tx, model.PhasePrepared)
	if err != nil {
		return Result{}, err
	}
	if err := engine.Controller.Switch(ctx, tx); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	tx, err = engine.advance(tx, model.PhaseSwitched)
	if err != nil {
		return Result{}, err
	}
	targetTx := tx
	targetTx.Phase = model.PhaseIdle
	targetTx.Revision = 1
	targetResult, targetErr := engine.Target.Run(ctx, targetTx)
	if targetErr != nil || targetResult.Phase != model.PhaseVerified {
		if targetErr == nil {
			targetErr = errors.New("target controller did not verify its product transaction")
		}
		_, _ = engine.Target.Abort(ctx, tx.ID)
		return engine.rollback(ctx, tx, true, targetErr)
	}
	if err := engine.Controller.Verify(ctx, tx, targetResult); err != nil {
		_, abortErr := engine.Target.Abort(ctx, tx.ID)
		if abortErr != nil {
			err = errors.Join(err, abortErr)
		}
		return engine.rollback(ctx, tx, true, err)
	}
	targetResult, err = engine.Target.Commit(ctx, tx.ID)
	if err != nil || targetResult.Phase != model.PhaseCommitted {
		if err == nil {
			err = errors.New("target controller did not commit its verified product transaction")
		}
		return Result{Outcome: OutcomeRecoveryPending, Phase: tx.Phase}, err
	}
	tx, err = engine.advance(tx, model.PhaseVerified)
	if err != nil {
		return Result{}, err
	}
	if err := engine.Controller.Commit(ctx, tx); err != nil {
		return Result{Outcome: OutcomeRecoveryPending, Phase: model.PhaseVerified}, err
	}
	tx, err = engine.advance(tx, model.PhaseCommitted)
	if err != nil {
		return Result{}, err
	}
	return Result{Outcome: OutcomeUpdated, Phase: tx.Phase}, nil
}

func (engine *SupervisorEngine) Recover(ctx context.Context, tx model.Transaction) (Result, error) {
	if err := engine.validate(); err != nil {
		return Result{}, err
	}
	decision, err := model.Recover(tx)
	if err != nil {
		return Result{}, err
	}
	switch decision.Action {
	case model.RecoveryNoop:
		return Result{Outcome: OutcomeRolledBack, Phase: model.PhaseIdle}, nil
	case model.RecoveryDiscardStaged, model.RecoveryAbortPrepared:
		return engine.rollback(ctx, tx, false, nil)
	case model.RecoveryRestorePrevious:
		targetResult, targetErr := engine.Target.Recover(ctx, tx.ID)
		if targetErr == nil && targetResult.Phase == model.PhaseCommitted {
			if verifyErr := engine.Controller.Verify(ctx, tx, targetResult); verifyErr == nil {
				tx, err = engine.advance(tx, model.PhaseVerified)
				if err != nil {
					return Result{}, err
				}
				return engine.completeCommit(ctx, tx)
			}
		}
		return engine.rollback(ctx, tx, true, targetErr)
	case model.RecoveryCompleteCommit:
		return engine.completeCommit(ctx, tx)
	case model.RecoveryAlreadyCurrent:
		return Result{Outcome: OutcomeAlreadyCurrent, Phase: model.PhaseCommitted}, nil
	case model.RecoveryRetryAllowed:
		return Result{Outcome: OutcomeRolledBack, Phase: model.PhaseRolledBack}, nil
	default:
		return Result{}, errors.New("unsupported supervisor recovery decision")
	}
}

func (engine *SupervisorEngine) completeCommit(ctx context.Context, tx model.Transaction) (Result, error) {
	if err := engine.Controller.Commit(ctx, tx); err != nil {
		return Result{Outcome: OutcomeRecoveryPending, Phase: model.PhaseVerified}, err
	}
	committed, err := engine.advance(tx, model.PhaseCommitted)
	if err != nil {
		return Result{}, err
	}
	return Result{Outcome: OutcomeUpdated, Phase: committed.Phase}, nil
}

func (engine *SupervisorEngine) advance(tx model.Transaction, phase model.Phase) (model.Transaction, error) {
	next, err := model.Advance(tx, phase)
	if err != nil {
		return model.Transaction{}, err
	}
	if err := engine.Journal.CommitJournal(store.AuthoritySupervisor, next); err != nil {
		return model.Transaction{}, err
	}
	return next, nil
}

func (engine *SupervisorEngine) rollback(ctx context.Context, tx model.Transaction, restore bool, cause error) (Result, error) {
	var rollbackErrors []error
	if restore {
		rollbackErrors = appendIfError(rollbackErrors, engine.Controller.Restore(ctx, tx))
	}
	rollbackErrors = appendIfError(rollbackErrors, engine.Controller.Discard(ctx, tx))
	rolled, err := engine.advance(tx, model.PhaseRolledBack)
	rollbackErrors = appendIfError(rollbackErrors, err)
	combined := errors.Join(append([]error{cause}, rollbackErrors...)...)
	if err != nil {
		return Result{Outcome: OutcomeRecoveryPending, Phase: tx.Phase}, combined
	}
	return Result{Outcome: OutcomeRolledBack, Phase: rolled.Phase}, combined
}

func (engine *SupervisorEngine) validate() error {
	if engine == nil || engine.Journal == nil || engine.Controller == nil || engine.Target == nil {
		return fmt.Errorf("supervisor engine requires journal, controller authority, and target authority")
	}
	return nil
}
