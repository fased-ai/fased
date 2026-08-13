// Package engine coordinates the lifecycle host's product transaction.
package engine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"

	"fased-lifecycled/model"
	"fased-lifecycled/store"
)

type Outcome string

const (
	OutcomeUpdated         Outcome = "UPDATED"
	OutcomeAlreadyCurrent  Outcome = "ALREADY_CURRENT"
	OutcomeRolledBack      Outcome = "ROLLED_BACK"
	OutcomeRecoveryPending Outcome = "RECOVERY_PENDING"
	OutcomePrepared        Outcome = "PREPARED"
)

type Result struct {
	Outcome                  Outcome
	Phase                    model.Phase
	ActiveGenerationID       string
	ConvergenceReceiptDigest string
}

// ConvergenceReceipt is the durable, adapter-produced proof that the
// committed manifest, generation pointer, service processes, Gateway
// readiness identity, and plugin readiness all name the same target.
type ConvergenceReceipt struct {
	TransactionID        string
	TargetGenerationID   string
	StateInventoryDigest string
	PlatformDigest       string
	EvidenceDigest       string
}

type GatewayReceipt struct {
	GenerationID    string
	Version         string
	ReleaseCommit   string
	PID             uint32
	StartedAt       string
	ReadinessDigest string
}

type ParticipantReceipt struct {
	TransactionID        string
	TargetGenerationID   string
	StateInventoryDigest string
	PlanDigest           string
	EvidenceDigest       string
	MemberDigests        StateMemberDigests
}

type StateMemberDigests struct {
	ApplicationState string
	Configuration    string
	Wallet           string
	Mining           string
	Federation       string
	PluginData       string
	Signer           string
}

type Journal interface {
	CommitJournal(store.Authority, model.Transaction) error
}

type TransactionJournal interface {
	Journal
	ReadJournal(store.Authority, string) (model.Transaction, error)
	AppendProgress(model.Transaction, store.ProgressEvent) error
	ReadProgress(string) (store.ProgressRecord, error)
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
	PrepareState(context.Context, model.Transaction) (ParticipantReceipt, string, error)
	StopTarget(context.Context, model.Transaction) error
	Activate(context.Context, model.Transaction) error
	Verify(context.Context, model.Transaction) (ParticipantReceipt, error)
	Commit(context.Context, model.Transaction) error
	Converge(context.Context, model.Transaction) (ConvergenceReceipt, error)
	Finalize(context.Context, model.Transaction) error
	Restore(context.Context, model.Transaction) error
	Discard(context.Context, model.Transaction) error
}

type InstallationCommitter interface {
	Commit(context.Context, model.Transaction) error
}

type TargetEngine struct {
	Journal      TransactionJournal
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
	if err := engine.progress(tx, store.ProgressGenerationStaged, nil, nil); err != nil {
		return Result{}, err
	}
	var err error
	tx, err = engine.advance(tx, model.PhaseStaged)
	if err != nil {
		return Result{}, err
	}
	var migratorReceipt ParticipantReceipt
	signerReceipt, err := engine.Signer.Prepare(ctx, tx)
	if err != nil {
		return engine.rollback(ctx, tx, false, err)
	}
	if err := validateReceipt(signerReceipt, tx, tx.SignerPlanDigest); err != nil {
		return engine.rollback(ctx, tx, false, err)
	}
	if err := engine.participantProgress(tx, store.ProgressSignerPrepared, "signer", signerReceipt, "target/signer"); err != nil {
		return engine.rollback(ctx, tx, false, err)
	}
	if err := engine.Adapter.Prepare(ctx, tx); err != nil {
		return engine.rollback(ctx, tx, false, err)
	}
	if err := engine.progress(tx, store.ProgressPlatformPrepared, nil, undoRecord("platform", "target/platform", tx.PlatformDigest)); err != nil {
		return engine.rollback(ctx, tx, false, err)
	}
	tx, err = engine.advance(tx, model.PhasePrepared)
	if err != nil {
		return Result{}, err
	}
	if err := engine.progress(tx, store.ProgressQuiesceStarted, nil, nil); err != nil {
		return engine.rollback(ctx, tx, false, err)
	}
	if err := engine.Adapter.Quiesce(ctx, tx); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.progress(tx, store.ProgressQuiesced, nil, nil); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	stateReceipt, stateUndoDigest, err := engine.Adapter.PrepareState(ctx, tx)
	if err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := validateReceipt(stateReceipt, tx, tx.StateInventoryDigest); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := validateStateMemberDigests(stateReceipt.MemberDigests); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.progress(tx, store.ProgressStatePrepared, durableReceipt("state", stateReceipt), undoRecord("state", "target/typed-state", stateUndoDigest)); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	migratorReceipt, err = engine.Migrator.Prepare(ctx, tx)
	if err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := validateReceipt(migratorReceipt, tx, tx.MigrationPlanDigest); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.participantProgress(tx, store.ProgressMigratorPrepared, "migrator", migratorReceipt, "target/migrator"); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.Migrator.Activate(ctx, tx); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.progress(tx, store.ProgressMigratorActivated, nil, nil); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.Adapter.Activate(ctx, tx); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.progress(tx, store.ProgressPlatformActivated, nil, nil); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	tx, err = engine.advance(tx, model.PhaseSwitched)
	if err != nil {
		return Result{}, err
	}
	if err := engine.Migrator.Verify(ctx, tx, migratorReceipt); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.progress(tx, store.ProgressMigratorVerified, durableReceipt("migrator", migratorReceipt), nil); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.Signer.Verify(ctx, tx, signerReceipt); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if err := engine.progress(tx, store.ProgressSignerVerified, durableReceipt("signer", signerReceipt), nil); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	pluginReceipt, err := engine.Adapter.Verify(ctx, tx)
	if err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	if pluginReceipt != (ParticipantReceipt{}) {
		if err := validateReceipt(pluginReceipt, tx, tx.Target.ID); err != nil || !validDigest(pluginReceipt.EvidenceDigest) {
			return engine.rollback(ctx, tx, true, errors.Join(err, errors.New("plugin readiness receipt is not durably bound")))
		}
		if err := engine.progress(tx, store.ProgressPluginVerified, durableReceipt("plugin", pluginReceipt), nil); err != nil {
			return engine.rollback(ctx, tx, true, err)
		}
	} else if tx.PlanAction != "INSTALL" || tx.Previous != nil {
		return engine.rollback(ctx, tx, true, errors.New("mandatory plugin readiness receipt is missing"))
	}
	if err := engine.progress(tx, store.ProgressPlatformVerified, nil, nil); err != nil {
		return engine.rollback(ctx, tx, true, err)
	}
	tx, err = engine.advance(tx, model.PhaseVerified)
	if err != nil {
		return Result{}, err
	}
	return Result{Outcome: OutcomePrepared, Phase: tx.Phase}, nil
}

func (engine *TargetEngine) Commit(ctx context.Context, transactionID string) (Result, error) {
	if err := engine.validate(); err != nil {
		return Result{}, err
	}
	tx, err := engine.Journal.ReadJournal(store.AuthorityTargetController, transactionID)
	if err != nil {
		return Result{}, err
	}
	if tx.Phase == model.PhaseCommitted {
		digest, err := engine.convergenceDigest(tx)
		return Result{Outcome: OutcomeAlreadyCurrent, Phase: tx.Phase, ActiveGenerationID: tx.Target.ID, ConvergenceReceiptDigest: digest}, err
	}
	if tx.Phase != model.PhaseVerified {
		return Result{}, errors.New("target transaction is not ready to commit")
	}
	receiptDigest, err := engine.commit(ctx, tx)
	if err != nil {
		return Result{Outcome: OutcomeRecoveryPending, Phase: model.PhaseVerified}, err
	}
	tx, err = engine.advance(tx, model.PhaseCommitted)
	if err != nil {
		return Result{}, err
	}
	return Result{Outcome: OutcomeUpdated, Phase: tx.Phase, ActiveGenerationID: tx.Target.ID, ConvergenceReceiptDigest: receiptDigest}, nil
}

func (engine *TargetEngine) Abort(ctx context.Context, transactionID string) (Result, error) {
	if err := engine.validate(); err != nil {
		return Result{}, err
	}
	tx, err := engine.Journal.ReadJournal(store.AuthorityTargetController, transactionID)
	if err != nil {
		return Result{}, err
	}
	if tx.Phase == model.PhaseCommitted {
		return Result{}, errors.New("committed target transaction cannot be aborted")
	}
	if tx.Phase == model.PhaseRolledBack {
		return Result{Outcome: OutcomeRolledBack, Phase: tx.Phase}, nil
	}
	restore := tx.Phase == model.PhaseSwitched || tx.Phase == model.PhaseVerified
	return engine.rollback(ctx, tx, restore, nil)
}

func (engine *TargetEngine) Recover(ctx context.Context, tx model.Transaction) (Result, error) {
	if err := engine.validate(); err != nil {
		return Result{}, err
	}
	durable, err := engine.Journal.ReadJournal(store.AuthorityTargetController, tx.ID)
	if err != nil {
		return Result{}, err
	}
	tx = durable
	if err := engine.validateRecoveryProgress(tx); err != nil {
		return Result{}, err
	}
	decision, err := model.Recover(tx)
	if err != nil {
		return Result{}, err
	}
	switch decision.Action {
	case model.RecoveryNoop:
		return engine.rollback(ctx, tx, false, nil)
	case model.RecoveryDiscardStaged, model.RecoveryAbortPrepared:
		done, progressErr := engine.completedProgress(tx)
		if progressErr != nil {
			return Result{}, progressErr
		}
		return engine.rollback(ctx, tx, done[store.ProgressQuiesceStarted], nil)
	case model.RecoveryRestorePrevious:
		return engine.rollback(ctx, tx, true, nil)
	case model.RecoveryCompleteCommit:
		receiptDigest, commitErr := engine.commit(ctx, tx)
		if commitErr != nil {
			return Result{Outcome: OutcomeRecoveryPending, Phase: model.PhaseVerified}, commitErr
		}
		tx, err = engine.advance(tx, model.PhaseCommitted)
		if err != nil {
			return Result{}, err
		}
		return Result{Outcome: OutcomeUpdated, Phase: tx.Phase, ActiveGenerationID: tx.Target.ID, ConvergenceReceiptDigest: receiptDigest}, nil
	case model.RecoveryAlreadyCurrent:
		digest, digestErr := engine.convergenceDigest(tx)
		return Result{Outcome: OutcomeAlreadyCurrent, Phase: model.PhaseCommitted, ActiveGenerationID: tx.Target.ID, ConvergenceReceiptDigest: digest}, digestErr
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

func (engine *TargetEngine) commit(ctx context.Context, tx model.Transaction) (string, error) {
	done, err := engine.completedProgress(tx)
	if err != nil {
		return "", err
	}
	if !done[store.ProgressMigratorCommitted] {
		if err := engine.Migrator.Commit(ctx, tx); err != nil {
			return "", fmt.Errorf("commit migrator: %w", err)
		}
		if err := engine.progress(tx, store.ProgressMigratorCommitted, nil, nil); err != nil {
			return "", err
		}
	}
	if !done[store.ProgressSignerCommitted] {
		if err := engine.Signer.Commit(ctx, tx); err != nil {
			return "", fmt.Errorf("commit signer: %w", err)
		}
		if err := engine.progress(tx, store.ProgressSignerCommitted, nil, nil); err != nil {
			return "", err
		}
	}
	if !done[store.ProgressPlatformCommitted] {
		if err := engine.Adapter.Commit(ctx, tx); err != nil {
			return "", fmt.Errorf("commit platform adapter: %w", err)
		}
		if err := engine.progress(tx, store.ProgressPlatformCommitted, nil, nil); err != nil {
			return "", err
		}
	}
	if !done[store.ProgressManifestCommitted] {
		if err := engine.Installation.Commit(ctx, tx); err != nil {
			return "", fmt.Errorf("commit installation manifest: %w", err)
		}
		if err := engine.progress(tx, store.ProgressManifestCommitted, nil, nil); err != nil {
			return "", err
		}
	}
	if !done[store.ProgressTerminalConvergenceVerified] {
		receipt, convergeErr := engine.Adapter.Converge(ctx, tx)
		if convergeErr != nil {
			return "", fmt.Errorf("prove terminal convergence: %w", convergeErr)
		}
		if err := validateConvergenceReceipt(receipt, tx); err != nil {
			return "", err
		}
		if err := engine.progress(tx, store.ProgressTerminalConvergenceVerified, durableConvergenceReceipt(receipt), nil); err != nil {
			return "", err
		}
		done[store.ProgressTerminalConvergenceVerified] = true
	}
	receiptDigest, err := engine.convergenceDigest(tx)
	if err != nil {
		return "", err
	}
	if !done[store.ProgressPlatformFinalized] {
		if err := engine.Adapter.Finalize(ctx, tx); err != nil {
			return "", fmt.Errorf("finalize platform adapter: %w", err)
		}
		if err := engine.progress(tx, store.ProgressPlatformFinalized, nil, nil); err != nil {
			return "", err
		}
	}
	return receiptDigest, nil
}

func (engine *TargetEngine) rollback(ctx context.Context, tx model.Transaction, restore bool, cause error) (Result, error) {
	done, progressErr := engine.completedProgress(tx)
	if progressErr != nil && tx.Phase != model.PhaseIdle {
		return Result{Outcome: OutcomeRecoveryPending, Phase: tx.Phase}, errors.Join(cause, progressErr)
	}
	var rollbackErrors []error
	if !done[store.ProgressRollbackStarted] {
		rollbackErrors = appendIfError(rollbackErrors, engine.progress(tx, store.ProgressRollbackStarted, nil, nil))
	}
	if restore && !done[store.ProgressTargetStopped] {
		if err := engine.Adapter.StopTarget(ctx, tx); err != nil {
			rollbackErrors = append(rollbackErrors, err)
		} else {
			rollbackErrors = appendIfError(rollbackErrors, engine.progress(tx, store.ProgressTargetStopped, nil, nil))
		}
	}
	if done[store.ProgressSignerPrepared] && !done[store.ProgressSignerAborted] {
		if err := engine.Signer.Abort(ctx, tx); err != nil {
			rollbackErrors = append(rollbackErrors, err)
		} else {
			rollbackErrors = appendIfError(rollbackErrors, engine.progress(tx, store.ProgressSignerAborted, nil, nil))
		}
	}
	if done[store.ProgressMigratorPrepared] && !done[store.ProgressMigratorAborted] {
		if err := engine.Migrator.Abort(ctx, tx); err != nil {
			rollbackErrors = append(rollbackErrors, err)
		} else {
			rollbackErrors = appendIfError(rollbackErrors, engine.progress(tx, store.ProgressMigratorAborted, nil, nil))
		}
	}
	if restore && !done[store.ProgressPlatformRestored] {
		if err := engine.Adapter.Restore(ctx, tx); err != nil {
			rollbackErrors = append(rollbackErrors, err)
		} else {
			rollbackErrors = appendIfError(rollbackErrors, engine.progress(tx, store.ProgressPlatformRestored, nil, nil))
		}
	}
	if !done[store.ProgressPlatformDiscarded] {
		if err := engine.Adapter.Discard(ctx, tx); err != nil {
			rollbackErrors = append(rollbackErrors, err)
		} else {
			rollbackErrors = appendIfError(rollbackErrors, engine.progress(tx, store.ProgressPlatformDiscarded, nil, nil))
		}
	}
	if len(rollbackErrors) > 0 {
		return Result{Outcome: OutcomeRecoveryPending, Phase: tx.Phase}, errors.Join(append([]error{cause}, rollbackErrors...)...)
	}
	if !done[store.ProgressRollbackCompleted] {
		if err := engine.progress(tx, store.ProgressRollbackCompleted, nil, nil); err != nil {
			return Result{Outcome: OutcomeRecoveryPending, Phase: tx.Phase}, errors.Join(cause, err)
		}
	}
	rolled, err := engine.advance(tx, model.PhaseRolledBack)
	if err != nil {
		return Result{Outcome: OutcomeRecoveryPending, Phase: tx.Phase}, errors.Join(cause, err)
	}
	return Result{Outcome: OutcomeRolledBack, Phase: rolled.Phase}, cause
}

func (engine *TargetEngine) participantProgress(tx model.Transaction, step store.ProgressStep, participant string, receipt ParticipantReceipt, locator string) error {
	return engine.progress(tx, step, durableReceipt(participant, receipt), undoRecord(participant, locator, receipt.PlanDigest))
}

func (engine *TargetEngine) progress(tx model.Transaction, step store.ProgressStep, receipt *store.DurableParticipantReceipt, undo *store.DurableUndoRecord) error {
	return engine.Journal.AppendProgress(tx, store.ProgressEvent{Step: step, Receipt: receipt, Undo: undo})
}

func durableReceipt(participant string, receipt ParticipantReceipt) *store.DurableParticipantReceipt {
	members := []store.DurableParticipantMember(nil)
	if receipt.MemberDigests != (StateMemberDigests{}) {
		members = []store.DurableParticipantMember{
			{Participant: "application-state", Digest: receipt.MemberDigests.ApplicationState},
			{Participant: "configuration", Digest: receipt.MemberDigests.Configuration},
			{Participant: "wallet", Digest: receipt.MemberDigests.Wallet},
			{Participant: "mining", Digest: receipt.MemberDigests.Mining},
			{Participant: "federation", Digest: receipt.MemberDigests.Federation},
			{Participant: "plugin-data", Digest: receipt.MemberDigests.PluginData},
			{Participant: "signer", Digest: receipt.MemberDigests.Signer},
		}
	}
	sort.Slice(members, func(i, j int) bool { return members[i].Participant < members[j].Participant })
	return &store.DurableParticipantReceipt{Participant: participant, TransactionID: receipt.TransactionID, TargetGenerationID: receipt.TargetGenerationID, StateInventoryDigest: receipt.StateInventoryDigest, PlanDigest: receipt.PlanDigest, EvidenceDigest: receipt.EvidenceDigest, Members: members}
}

func durableConvergenceReceipt(receipt ConvergenceReceipt) *store.DurableParticipantReceipt {
	return &store.DurableParticipantReceipt{
		Participant: "convergence", TransactionID: receipt.TransactionID,
		TargetGenerationID: receipt.TargetGenerationID, StateInventoryDigest: receipt.StateInventoryDigest,
		PlanDigest: receipt.PlatformDigest, EvidenceDigest: receipt.EvidenceDigest,
	}
}

func validateConvergenceReceipt(receipt ConvergenceReceipt, tx model.Transaction) error {
	if receipt.TransactionID != tx.ID || receipt.TargetGenerationID != tx.Target.ID ||
		receipt.StateInventoryDigest != tx.StateInventoryDigest || receipt.PlatformDigest != tx.PlatformDigest ||
		!validDigest(receipt.EvidenceDigest) {
		return errors.New("terminal convergence receipt does not match the immutable transaction")
	}
	return nil
}

func (engine *TargetEngine) convergenceDigest(tx model.Transaction) (string, error) {
	record, err := engine.Journal.ReadProgress(tx.ID)
	if err != nil {
		return "", err
	}
	if err := store.ValidateProgress(record, tx); err != nil {
		return "", err
	}
	for _, event := range record.Events {
		if event.Step == store.ProgressTerminalConvergenceVerified && event.Receipt != nil && event.Receipt.Participant == "convergence" {
			return event.Receipt.EvidenceDigest, nil
		}
	}
	return "", errors.New("durable terminal convergence receipt is unavailable")
}

func undoRecord(participant, locator, digest string) *store.DurableUndoRecord {
	return &store.DurableUndoRecord{Participant: participant, Locator: locator, Digest: digest}
}

func (engine *TargetEngine) validateRecoveryProgress(tx model.Transaction) error {
	if tx.Phase == model.PhaseIdle {
		return nil
	}
	record, err := engine.Journal.ReadProgress(tx.ID)
	if err != nil {
		return fmt.Errorf("durable transaction progress is unavailable: %w", err)
	}
	if err := store.ValidateProgress(record, tx); err != nil {
		return fmt.Errorf("durable transaction progress is invalid: %w", err)
	}
	required := store.ProgressGenerationStaged
	switch tx.Phase {
	case model.PhasePrepared:
		required = store.ProgressPlatformPrepared
	case model.PhaseSwitched:
		required = store.ProgressPlatformActivated
	case model.PhaseVerified:
		required = store.ProgressPlatformVerified
	case model.PhaseCommitted:
		required = store.ProgressPlatformFinalized
	case model.PhaseRolledBack:
		required = store.ProgressRollbackCompleted
	}
	foundRequired := false
	foundPlugin := false
	for _, event := range record.Events {
		foundRequired = foundRequired || event.Step == required
		foundPlugin = foundPlugin || (event.Step == store.ProgressPluginVerified && event.Receipt != nil && event.Receipt.Participant == "plugin")
	}
	if !foundRequired {
		return fmt.Errorf("durable transaction progress lacks required step %s", required)
	}
	if (tx.Phase == model.PhaseVerified || tx.Phase == model.PhaseCommitted) && (tx.PlanAction != "INSTALL" || tx.Previous != nil) && !foundPlugin {
		return errors.New("durable transaction progress lacks mandatory plugin readiness")
	}
	return nil
}

func (engine *TargetEngine) completedProgress(tx model.Transaction) (map[store.ProgressStep]bool, error) {
	completed := make(map[store.ProgressStep]bool)
	record, err := engine.Journal.ReadProgress(tx.ID)
	if errors.Is(err, os.ErrNotExist) && tx.Phase == model.PhaseIdle {
		return completed, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read durable transaction progress: %w", err)
	}
	if err := store.ValidateProgress(record, tx); err != nil {
		return nil, fmt.Errorf("validate durable transaction progress: %w", err)
	}
	for _, event := range record.Events {
		completed[event.Step] = true
	}
	return completed, nil
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

func validateStateMemberDigests(members StateMemberDigests) error {
	for _, digest := range []string{members.ApplicationState, members.Configuration, members.Wallet, members.Mining, members.Federation, members.PluginData, members.Signer} {
		if !validDigest(digest) {
			return errors.New("typed state receipt contains an invalid participant binding")
		}
	}
	return nil
}

func validDigest(value string) bool {
	if len(value) != 71 || value[:7] != "sha256:" {
		return false
	}
	for _, character := range value[7:] {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func appendIfError(existing []error, err error) []error {
	if err != nil {
		return append(existing, err)
	}
	return existing
}
