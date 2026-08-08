// Package migrator executes an explicit, allowlisted state-schema plan.
package migrator

import (
	"context"
	"errors"
	"fmt"

	"fased-lifecycled/engine"
	"fased-lifecycled/model"
)

type Adapter interface {
	Prepare(context.Context, model.Transaction, model.Migration) error
	Activate(context.Context, model.Transaction, model.Migration) error
	Verify(context.Context, model.Transaction, model.Migration) error
	Commit(context.Context, model.Transaction, model.Migration) error
	Abort(context.Context, model.Transaction, model.Migration) error
}

type Key struct {
	State string
	From  uint32
	To    uint32
}

type SchemaMigrator struct {
	Registry map[Key]Adapter
}

func (migrator *SchemaMigrator) Prepare(ctx context.Context, tx model.Transaction) (engine.ParticipantReceipt, error) {
	steps, err := migrator.steps(tx)
	if err != nil {
		return engine.ParticipantReceipt{}, err
	}
	for index, step := range steps {
		if err := step.adapter.Prepare(ctx, tx, step.migration); err != nil {
			for rollback := index - 1; rollback >= 0; rollback-- {
				_ = steps[rollback].adapter.Abort(ctx, tx, steps[rollback].migration)
			}
			return engine.ParticipantReceipt{}, fmt.Errorf("prepare migration %s: %w", step.migration.State, err)
		}
	}
	return receipt(tx), nil
}

func (migrator *SchemaMigrator) Activate(ctx context.Context, tx model.Transaction) error {
	return migrator.each(ctx, tx, "activate", func(adapter Adapter, migration model.Migration) error {
		return adapter.Activate(ctx, tx, migration)
	})
}

func (migrator *SchemaMigrator) Verify(ctx context.Context, tx model.Transaction, participant engine.ParticipantReceipt) error {
	if participant != receipt(tx) {
		return errors.New("migration receipt does not match transaction")
	}
	return migrator.each(ctx, tx, "verify", func(adapter Adapter, migration model.Migration) error {
		return adapter.Verify(ctx, tx, migration)
	})
}

func (migrator *SchemaMigrator) Commit(ctx context.Context, tx model.Transaction) error {
	return migrator.each(ctx, tx, "commit", func(adapter Adapter, migration model.Migration) error {
		return adapter.Commit(ctx, tx, migration)
	})
}

func (migrator *SchemaMigrator) Abort(ctx context.Context, tx model.Transaction) error {
	steps, err := migrator.steps(tx)
	if err != nil {
		return err
	}
	var failures []error
	for index := len(steps) - 1; index >= 0; index-- {
		if err := steps[index].adapter.Abort(ctx, tx, steps[index].migration); err != nil {
			failures = append(failures, fmt.Errorf("abort migration %s: %w", steps[index].migration.State, err))
		}
	}
	return errors.Join(failures...)
}

func (migrator *SchemaMigrator) each(ctx context.Context, tx model.Transaction, operation string, call func(Adapter, model.Migration) error) error {
	steps, err := migrator.steps(tx)
	if err != nil {
		return err
	}
	for _, step := range steps {
		if err := call(step.adapter, step.migration); err != nil {
			return fmt.Errorf("%s migration %s: %w", operation, step.migration.State, err)
		}
	}
	return nil
}

type selectedStep struct {
	migration model.Migration
	adapter   Adapter
}

func (migrator *SchemaMigrator) steps(tx model.Transaction) ([]selectedStep, error) {
	if migrator == nil || migrator.Registry == nil {
		return nil, errors.New("migration registry is unavailable")
	}
	if err := tx.Validate(); err != nil {
		return nil, err
	}
	steps := make([]selectedStep, 0, len(tx.Migrations))
	for _, migration := range tx.Migrations {
		adapter := migrator.Registry[Key{State: migration.State, From: migration.From, To: migration.To}]
		if adapter == nil {
			return nil, fmt.Errorf("no explicit migration adapter for %s %d -> %d", migration.State, migration.From, migration.To)
		}
		steps = append(steps, selectedStep{migration: migration, adapter: adapter})
	}
	return steps, nil
}

func receipt(tx model.Transaction) engine.ParticipantReceipt {
	return engine.ParticipantReceipt{
		TransactionID: tx.ID, TargetGenerationID: tx.Target.ID,
		StateInventoryDigest: tx.StateInventoryDigest, PlanDigest: tx.MigrationPlanDigest,
	}
}
