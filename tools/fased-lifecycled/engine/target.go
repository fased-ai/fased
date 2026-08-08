// Package engine coordinates the target-controller product transaction.
package engine

import (
	"context"
	"errors"
	"fmt"

	"fased-lifecycled/model"
	"fased-lifecycled/store"
)

type Outcome string

const (
	OutcomeUpdated         Outcome = "UPDATED"
	OutcomeAlreadyCurrent  Outcome = "ALREADY_CURRENT"
	OutcomeRolledBack      Outcome = "ROLLED_BACK"
	OutcomeRecoveryPending Outcome = "RECOVERY_PENDING"
)

type Result struct {
	Outcome Outcome
	Phase   model.Phase
}

type ParticipantReceipt struct {
	TransactionID        string
	TargetGenerationID   string
	StateInventoryDigest string
	PlanDigest           string
}

type Journal interface {
	CommitJournal(store.Authority, model.Transaction) error
}

type GenerationStore interface {
	StageGeneration(string) error
}

type Participant interface {
	Prepare(context.Context, model.Transaction) (ParticipantReceipt, error)
	Verify(context.Context, model.Transaction, ParticipantReceipt) error
	Commit(context.Context, model.Transaction) error
	Abort(context.Context, model.Transaction) error
}

type MigratorParticipant interface {
	Participant
	Activate(context.Context, model.Transaction) error
}

type PlatformAdapter interface {
	Prepare(context.Context, model.Transaction) error
	Quiesce(context.Context, model.Transaction) error
	Activate(context.Context, model.Transaction) error
	Verify(context.Context, model.Transaction) error
	Commit(context.Context, model.Transaction) error
	Restore(context.Context, model.Transaction) error
	Discard(context.Context, model.Transaction) error
}

type InstallationCommitter interface {
	Commit(context.Context, model.Transaction) error
}

type TargetEngine struct {
	Journal      Journal
	Generations  GenerationStore
	Migrator     MigratorParticipant
	Signer       Participant
	Adapter      PlatformAdapter
	Installation InstallationCommitter
}

func (engine *TargetEngine) Run(ctx context.Context, tx model.Transaction) (Result, error) {
	if err := engine.validate(); err != nil {
		return Result{}, err
	}
	if tx.Phase != model.PhaseIdle || tx.Revision != 1 {
		return Result{}, errors.New("new target transaction must begin at IDLE revision 1")
	}
	if err := tx.Validate(); err != nil {
		return Result{}, err
	}
	if err := engine.Journal.CommitJournal(store.AuthorityTargetController, tx); err != nil {
		return Result{}, err
	}
	if err := engine.Generations.StageGeneration(tx.Target.ID); err != nil {
		return Result{Outcome: OutcomeRolledBack, Phase: model.PhaseIdle}, err
	}
	var err error
	tx, err = engine.advance(tx, model.PhaseStaged)
	if err != nil {
		return Result{}, err
	}
	migratorReceipt, err := engine.Migrator.Prepare(ctx, tx)
	if err != nil {
		return engine.rollback(ctx, tx, false, err)
	}
	if err := validateReceipt(migratorReceipt, tx, tx.MigrationPlanDigest); err != nil {
		return engine.rollback(ctx, tx, false, err)
	}
	signerReceipt, err := engine.Signer.Prepare(ctx, tx)
	if err != nil {
		return engine.rollback(ctx, tx, false, err)
	}
	if err := validateReceipt(signerReceipt, tx, tx.SignerPlanDigest); err != nil {
		return engine.rollback(ctx, tx, false, err)
	}
	if err := engine.Adapter.Prepare(ctx, tx); err != nil {
		return engine.rollback(ctx, tx, false, err)
	}
	tx, err = engine.advance(tx, model.PhasePrepared)
	if err != nil {
		return Result{}, err
	}
	if err := engine.Adapter.Quiesce(ctx, tx); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.Migrator.Activate(ctx, tx); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.Adapter.Activate(ctx, tx); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	tx, err = engine.advance(tx, model.PhaseSwitched)
	if err != nil {
		return Result{}, err
	}
	if err := engine.Migrator.Verify(ctx, tx, migratorReceipt); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.Signer.Verify(ctx, tx, signerReceipt); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.Adapter.Verify(ctx, tx); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	tx, err = engine.advance(tx, model.PhaseVerified)
	if err != nil {
		return Result{}, err
	}
	if err := engine.commit(ctx, tx); err != nil {
		return Result{Outcome: OutcomeRecoveryPending, Phase: model.PhaseVerified}, err
	}
	tx, err = engine.advance(tx, model.PhaseCommitted)
	if err != nil {
		return Result{}, err
	}
	return Result{Outcome: OutcomeUpdated, Phase: tx.Phase}, nil
}

func (engine *TargetEngine) Recover(ctx context.Context, tx model.Transaction) (Result, error) {
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
		return engine.rollback(ctx, tx, true, nil)
	case model.RecoveryCompleteCommit:
		if err := engine.commit(ctx, tx); err != nil {
			return Result{Outcome: OutcomeRecoveryPending, Phase: model.PhaseVerified}, err
		}
		tx, err = engine.advance(tx, model.PhaseCommitted)
		if err != nil {
			return Result{}, err
		}
		return Result{Outcome: OutcomeUpdated, Phase: tx.Phase}, nil
	case model.RecoveryAlreadyCurrent:
		return Result{Outcome: OutcomeAlreadyCurrent, Phase: model.PhaseCommitted}, nil
	case model.RecoveryRetryAllowed:
		return Result{Outcome: OutcomeRolledBack, Phase: model.PhaseRolledBack}, nil
	default:
		return Result{}, errors.New("unsupported target recovery decision")
	}
}

func (engine *TargetEngine) advance(tx model.Transaction, phase model.Phase) (model.Transaction, error) {
	next, err := model.Advance(tx, phase)
	if err != nil {
		return model.Transaction{}, err
	}
	if err := engine.Journal.CommitJournal(store.AuthorityTargetController, next); err != nil {
		return model.Transaction{}, err
	}
	return next, nil
}

func (engine *TargetEngine) commit(ctx context.Context, tx model.Transaction) error {
	if err := engine.Migrator.Commit(ctx, tx); err != nil {
		return fmt.Errorf("commit migrator: %w", err)
	}
	if err := engine.Signer.Commit(ctx, tx); err != nil {
		return fmt.Errorf("commit signer: %w", err)
	}
	if err := engine.Adapter.Commit(ctx, tx); err != nil {
		return fmt.Errorf("commit platform adapter: %w", err)
	}
	if err := engine.Installation.Commit(ctx, tx); err != nil {
		return fmt.Errorf("commit installation manifest: %w", err)
	}
	return nil
}

func (engine *TargetEngine) rollback(ctx context.Context, tx model.Transaction, restore bool, cause error) (Result, error) {
	var rollbackErrors []error
	if restore {
		rollbackErrors = appendIfError(rollbackErrors, engine.Adapter.Quiesce(ctx, tx))
	}
	rollbackErrors = appendIfError(rollbackErrors, engine.Signer.Abort(ctx, tx))
	rollbackErrors = appendIfError(rollbackErrors, engine.Migrator.Abort(ctx, tx))
	if restore {
		rollbackErrors = appendIfError(rollbackErrors, engine.Adapter.Restore(ctx, tx))
	}
	rollbackErrors = appendIfError(rollbackErrors, engine.Adapter.Discard(ctx, tx))
	rolled, err := engine.advance(tx, model.PhaseRolledBack)
	rollbackErrors = appendIfError(rollbackErrors, err)
	combined := errors.Join(append([]error{cause}, rollbackErrors...)...)
	if err != nil {
		return Result{Outcome: OutcomeRecoveryPending, Phase: tx.Phase}, combined
	}
	return Result{Outcome: OutcomeRolledBack, Phase: rolled.Phase}, combined
}

func (engine *TargetEngine) validate() error {
	if engine == nil || engine.Journal == nil || engine.Generations == nil || engine.Migrator == nil || engine.Signer == nil || engine.Adapter == nil || engine.Installation == nil {
		return errors.New("target engine requires every exclusive lifecycle authority")
	}
	return nil
}

func validateReceipt(receipt ParticipantReceipt, tx model.Transaction, planDigest string) error {
	if receipt.TransactionID != tx.ID || receipt.TargetGenerationID != tx.Target.ID || receipt.StateInventoryDigest != tx.StateInventoryDigest || receipt.PlanDigest != planDigest {
		return errors.New("participant receipt does not match the immutable transaction envelope")
	}
	return nil
}

func appendIfError(existing []error, err error) []error {
	if err != nil {
		return append(existing, err)
	}
	return existing
}
