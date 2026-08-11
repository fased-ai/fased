package engine

import (
	"context"
	"errors"
	"fmt"
	"os"

	"fased-lifecycled/model"
	"fased-lifecycled/store"
)

type TargetAuthority interface {
	Run(context.Context, model.Transaction) (Result, error)
	Commit(context.Context, string) (Result, error)
	Abort(context.Context, string) (Result, error)
	Recover(context.Context, model.Transaction) (Result, error)
}

type SupervisorEngine struct {
	Journal Journal
	Target  TargetAuthority
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
	var err error
	tx, err = engine.advance(tx, model.PhaseStaged)
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
		return engine.rollback(ctx, tx, targetErr)
	}
	tx, err = engine.advance(tx, model.PhasePrepared)
	if err != nil {
		return Result{}, err
	}
	tx, err = engine.advance(tx, model.PhaseSwitched)
	if err != nil {
		return Result{}, err
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
		return engine.rollback(ctx, tx, nil)
	case model.RecoveryDiscardStaged, model.RecoveryAbortPrepared:
		_, abortErr := engine.Target.Abort(ctx, tx.ID)
		if errors.Is(abortErr, os.ErrNotExist) {
			abortErr = nil
		}
		return engine.rollback(ctx, tx, abortErr)
	case model.RecoveryRestorePrevious:
		targetResult, targetErr := engine.Target.Recover(ctx, tx)
		if targetErr == nil && targetResult.Phase == model.PhaseCommitted {
			tx, err = engine.advance(tx, model.PhaseVerified)
			if err != nil {
				return Result{}, err
			}
			return engine.completeCommit(ctx, tx)
		}
		return engine.rollback(ctx, tx, targetErr)
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
	_ = ctx
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

func (engine *SupervisorEngine) rollback(_ context.Context, tx model.Transaction, cause error) (Result, error) {
	var rollbackErrors []error
	rolled, err := engine.advance(tx, model.PhaseRolledBack)
	rollbackErrors = appendIfError(rollbackErrors, err)
	combined := errors.Join(append([]error{cause}, rollbackErrors...)...)
	if err != nil {
		return Result{Outcome: OutcomeRecoveryPending, Phase: tx.Phase}, combined
	}
	return Result{Outcome: OutcomeRolledBack, Phase: rolled.Phase}, combined
}

func (engine *SupervisorEngine) validate() error {
	if engine == nil || engine.Journal == nil || engine.Target == nil {
		return fmt.Errorf("supervisor engine requires journal and installed target authority")
	}
	return nil
}
