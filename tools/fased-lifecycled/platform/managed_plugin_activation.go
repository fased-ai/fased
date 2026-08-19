package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"syscall"
	"time"

	"fased-lifecycled/model"
	stateparticipant "fased-lifecycled/participant"
)

const managedPluginActivationSchemaVersion = 1

const (
	managedPluginReadinessDeadline = 60 * time.Second
	managedPluginReadinessPoll     = time.Second
)

var managedPluginActivationDigest = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

type ManagedPluginGatewayService interface {
	Stop(context.Context, string) error
	Start(context.Context, string) error
}

type ManagedPluginReadinessClock interface {
	Now() time.Time
	Wait(context.Context, time.Duration) error
}

type systemManagedPluginReadinessClock struct{}

func (systemManagedPluginReadinessClock) Now() time.Time { return time.Now() }
func (systemManagedPluginReadinessClock) Wait(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type ManagedPluginActivation struct {
	Config         Config
	Identity       model.PlatformIdentity
	Transaction    ManagedPluginTransaction
	Gateway        ManagedPluginGatewayService
	GenerationID   string
	ReadinessClock ManagedPluginReadinessClock
}

type managedPluginActivationPhase string

const (
	managedPluginPrepared             managedPluginActivationPhase = "PREPARED"
	managedPluginGatewayStopped       managedPluginActivationPhase = "GATEWAY_STOPPED"
	managedPluginCodeActivated        managedPluginActivationPhase = "CODE_ACTIVATED"
	managedPluginCandidateLockWritten managedPluginActivationPhase = "CANDIDATE_LOCK_WRITTEN"
	managedPluginCandidateStarted     managedPluginActivationPhase = "CANDIDATE_STARTED"
	managedPluginCandidateReady       managedPluginActivationPhase = "CANDIDATE_READY"
	managedPluginCommitted            managedPluginActivationPhase = "COMMITTED"
	managedPluginRollbackStarted      managedPluginActivationPhase = "ROLLBACK_STARTED"
	managedPluginPreviousLockWritten  managedPluginActivationPhase = "PREVIOUS_LOCK_WRITTEN"
	managedPluginPreviousStarted      managedPluginActivationPhase = "PREVIOUS_STARTED"
	managedPluginPreviousReady        managedPluginActivationPhase = "PREVIOUS_READY"
	managedPluginRolledBack           managedPluginActivationPhase = "ROLLED_BACK"
)

type managedPluginActivationJournal struct {
	SchemaVersion       int                          `json:"schemaVersion"`
	TransactionID       string                       `json:"transactionId"`
	GenerationID        string                       `json:"generationId"`
	GatewayUnit         string                       `json:"gatewayUnit"`
	Phase               managedPluginActivationPhase `json:"phase"`
	PreviousLock        []byte                       `json:"previousLock"`
	PreviousLockDigest  string                       `json:"previousLockDigest"`
	PreviousLockMode    uint32                       `json:"previousLockMode"`
	PreviousLockUID     uint32                       `json:"previousLockUid"`
	PreviousLockGID     uint32                       `json:"previousLockGid"`
	CandidateLock       []byte                       `json:"candidateLock"`
	CandidateLockDigest string                       `json:"candidateLockDigest"`
	ReadinessDigest     string                       `json:"readinessDigest,omitempty"`
}

// Preflight binds the requested catalog to the current installed lock and
// proves that both durable records fit the same readable 1 MiB boundary before
// Stage can create a staging root. The caller holds the installation lease.
func (activation ManagedPluginActivation) Preflight(request ManagedPluginStageRequest) error {
	guard, configGID, unit, err := activation.validate(request.TransactionID)
	if err != nil {
		return err
	}
	return activation.preflightBound(request, guard, configGID, unit)
}

func (activation ManagedPluginActivation) preflightBound(request ManagedPluginStageRequest, guard stateparticipant.PluginBoundary, configGID uint32, unit string) error {
	result, err := activation.Transaction.Preflight(request)
	if err != nil {
		return err
	}
	previous, previousDigest, err := activation.readLiveLock(configGID)
	if err != nil {
		return err
	}
	journal := managedPluginActivationJournal{
		SchemaVersion:       managedPluginActivationSchemaVersion,
		TransactionID:       request.TransactionID,
		GenerationID:        activation.GenerationID,
		GatewayUnit:         unit,
		Phase:               managedPluginPrepared,
		PreviousLock:        previous.data,
		PreviousLockDigest:  previousDigest,
		PreviousLockMode:    uint32(previous.mode.Perm()),
		PreviousLockUID:     previous.uid,
		PreviousLockGID:     previous.gid,
		CandidateLock:       result.CandidateLockData,
		CandidateLockDigest: result.CandidateLockDigest,
	}
	if err := activation.validateJournalPreflight(journal, guard); err != nil {
		return err
	}
	_, err = marshalManagedPluginActivationJournal(maximumManagedPluginActivationJournal(journal))
	return err
}

// Later journal transitions only replace Phase and add a canonical readiness
// digest. Bound the largest serialized shape up front so no later durable
// write can cross the reader limit.
func maximumManagedPluginActivationJournal(journal managedPluginActivationJournal) managedPluginActivationJournal {
	journal.Phase = managedPluginCandidateLockWritten
	journal.ReadinessDigest = "sha256:" + strings.Repeat("f", 64)
	return journal
}

// Apply creates or resumes the exact activation journal. It is intentionally
// platform-internal: callers must supply a previously staged transaction ID.
func (activation ManagedPluginActivation) Apply(ctx context.Context, transactionID string) (string, error) {
	guard, configGID, unit, err := activation.validate(transactionID)
	if err != nil {
		return "", err
	}
	return activation.applyBound(ctx, transactionID, guard, configGID, unit)
}

// AlreadyCurrent recognizes only a durable committed journal whose exact
// candidate readiness still verifies; it never creates a journal or restarts.
func (activation ManagedPluginActivation) AlreadyCurrent(transactionID string) (bool, string, string, error) {
	guard, _, unit, err := activation.validate(transactionID)
	if err != nil {
		return false, "", "", err
	}
	if err := activation.Transaction.validateRecordRoots(transactionID); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, "", "", nil
		}
		return false, "", "", err
	}
	data, err := activation.Transaction.readStableRecord(activation.journalPath(transactionID))
	if errors.Is(err, os.ErrNotExist) {
		return false, "", "", nil
	}
	if err != nil {
		return false, "", "", err
	}
	var journal managedPluginActivationJournal
	if err := strictManagedPluginJSON(data, &journal); err != nil {
		return false, "", "", err
	}
	if err := activation.validateJournal(journal, transactionID, unit, guard); err != nil {
		return false, "", "", err
	}
	if journal.Phase != managedPluginCommitted {
		return false, "", "", nil
	}
	receipt, err := guard.VerifyReadiness(journal.CandidateLockDigest, activation.GenerationID)
	if err != nil {
		return false, "", "", err
	}
	return true, receipt, journal.CandidateLockDigest, nil
}

// CatalogAlreadyCurrent recognizes a catalog already represented by the live
// lock and the current core generation readiness. It is used only when no
// transaction record exists for the generation/base-bound transaction ID.
func (activation ManagedPluginActivation) CatalogAlreadyCurrent(catalog stateparticipant.ManagedPluginCatalog) (bool, string, string, error) {
	guard, configGID, _, err := activation.validate("plugin-current")
	if err != nil {
		return false, "", "", err
	}
	return activation.catalogAlreadyCurrentBound(catalog, guard, configGID)
}

func (activation ManagedPluginActivation) catalogAlreadyCurrentBound(catalog stateparticipant.ManagedPluginCatalog, guard stateparticipant.PluginBoundary, configGID uint32) (bool, string, string, error) {
	current, currentDigest, err := activation.readLiveLock(configGID)
	if err != nil {
		return false, "", "", err
	}
	live, err := stateparticipant.DecodePluginLock(current.data)
	if err != nil {
		return false, "", "", err
	}
	merged, err := stateparticipant.MergeManagedPluginCatalog(live, catalog)
	if err != nil {
		return false, "", "", err
	}
	mergedDigest, err := stateparticipant.PluginLockDigest(merged)
	if err != nil {
		return false, "", "", err
	}
	if mergedDigest != currentDigest {
		return false, "", "", nil
	}
	receipt, err := guard.VerifyReadiness(currentDigest, activation.GenerationID)
	if err != nil {
		return false, "", "", err
	}
	return true, receipt, currentDigest, nil
}

// ResetRolledBack removes only an exact terminal rollback journal. It is safe
// to call repeatedly while holding the shared lifecycle lease: a missing
// journal is already reset, while committed or in-progress journals stay
// untouched. The staging record remains as immutable retry input.
func (activation ManagedPluginActivation) ResetRolledBack(transactionID, catalogDigest string) (bool, error) {
	guard, configGID, unit, err := activation.validate(transactionID)
	if err != nil {
		return false, err
	}
	return activation.resetRolledBackBound(transactionID, catalogDigest, guard, configGID, unit)
}

func (activation ManagedPluginActivation) resetRolledBackBound(transactionID, catalogDigest string, guard stateparticipant.PluginBoundary, configGID uint32, unit string) (bool, error) {
	record, err := activation.Transaction.readRecord(transactionID)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if record.CatalogDigest != catalogDigest {
		return false, errors.New("managed plugin rolled-back transaction catalog conflicts with retry")
	}
	for _, entry := range record.Entries {
		if entry.Created {
			return false, errors.New("managed plugin rolled-back transaction retains created objects")
		}
	}
	data, err := activation.Transaction.readStableRecord(activation.journalPath(transactionID))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var journal managedPluginActivationJournal
	if err := strictManagedPluginJSON(data, &journal); err != nil {
		return false, err
	}
	if err := activation.validateJournal(journal, transactionID, unit, guard); err != nil {
		return false, err
	}
	if journal.Phase != managedPluginRolledBack {
		return false, errors.New("managed plugin transaction is not a terminal rollback")
	}
	if err := activation.Transaction.verifyStaged(record); err != nil {
		return false, err
	}
	if _, liveDigest, err := activation.readLiveLock(configGID); err != nil || liveDigest != journal.PreviousLockDigest {
		if err != nil {
			return false, err
		}
		return false, errors.New("managed plugin rolled-back transaction live lock is ambiguous")
	}
	if _, err := guard.VerifyReadiness(journal.PreviousLockDigest, activation.GenerationID); err != nil {
		return false, fmt.Errorf("managed plugin rolled-back transaction previous readiness is invalid: %w", err)
	}
	if err := os.Remove(activation.journalPath(transactionID)); err != nil {
		return false, err
	}
	if err := syncPluginDirectory(activation.Transaction.recordRoot(transactionID)); err != nil {
		return false, err
	}
	return true, nil
}

// ConvergeOtherUnfinished restores the one-engine transaction rule for the
// dedicated plugin namespace. The caller must hold the installation-wide core
// lifecycle mutation lease. Records with a committed (or rolled-back) journal
// are durable provenance and cannot block later catalog work; every other
// record is resumed to its terminal state before a new transaction is staged.
func (activation ManagedPluginActivation) ConvergeOtherUnfinished(ctx context.Context, transactionID string) error {
	guard, configGID, unit, err := activation.validate(transactionID)
	if err != nil {
		return err
	}
	return activation.convergeOtherUnfinishedBound(ctx, transactionID, guard, configGID, unit)
}

func (activation ManagedPluginActivation) convergeOtherUnfinishedBound(ctx context.Context, transactionID string, guard stateparticipant.PluginBoundary, configGID uint32, unit string) error {
	ids, err := activation.Transaction.recordIDs()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if id == transactionID {
			continue
		}
		if recovered, residueErr := activation.Transaction.RecoverPreRecordResidue(id); residueErr != nil {
			return fmt.Errorf("recover pre-record managed plugin transaction %s: %w", id, residueErr)
		} else if recovered {
			continue
		}
		journal, journalErr := activation.openJournal(id, guard, configGID, unit)
		if journalErr != nil {
			return fmt.Errorf("open unfinished managed plugin transaction %s: %w", id, journalErr)
		}
		if journal.Phase == managedPluginCommitted || journal.Phase == managedPluginRolledBack {
			continue
		}
		if _, currentDigest, readErr := activation.readLiveLock(configGID); readErr != nil {
			return fmt.Errorf("read live lock before converging managed plugin transaction %s: %w", id, readErr)
		} else if currentDigest != journal.PreviousLockDigest && currentDigest != journal.CandidateLockDigest {
			return fmt.Errorf("managed plugin transaction %s conflicts with the current live lock", id)
		}
		if _, applyErr := activation.applyBound(ctx, id, guard, configGID, unit); applyErr != nil {
			return fmt.Errorf("converge unfinished managed plugin transaction %s: %w", id, applyErr)
		}
	}
	return nil
}

func (activation ManagedPluginActivation) applyBound(ctx context.Context, transactionID string, guard stateparticipant.PluginBoundary, configGID uint32, unit string) (string, error) {
	j, err := activation.openJournal(transactionID, guard, configGID, unit)
	if err != nil {
		return "", err
	}
	if j.Phase == managedPluginCommitted {
		if _, err := guard.VerifyReadiness(j.CandidateLockDigest, activation.GenerationID); err != nil {
			return "", fmt.Errorf("committed managed plugin candidate readiness drift: %w", err)
		}
		if err := activation.Transaction.Finalize(transactionID); err != nil {
			return "", err
		}
		return j.ReadinessDigest, nil
	}
	if j.Phase == managedPluginRolledBack {
		return "", errors.New("managed plugin transaction was rolled back")
	}
	if activation.isRollbackPhase(j.Phase) {
		return "", activation.rollback(ctx, guard, j)
	}
	if j.Phase == managedPluginPrepared {
		if err := activation.Gateway.Stop(ctx, unit); err != nil {
			return "", fmt.Errorf("stop managed plugin Gateway: %w", err)
		}
		j.Phase = managedPluginGatewayStopped
		if err := activation.writeJournal(j); err != nil {
			return "", err
		}
	}
	if j.Phase == managedPluginGatewayStopped {
		if _, err := activation.Transaction.Activate(transactionID); err != nil {
			return "", activation.failAndRollback(ctx, guard, j, err)
		}
		j.Phase = managedPluginCodeActivated
		if err := activation.writeJournal(j); err != nil {
			return "", err
		}
	}
	if j.Phase == managedPluginCodeActivated {
		if err := activation.writeLiveLock(j.CandidateLock, 0o640, activation.Config.Operator.UID, configGID); err != nil {
			return "", activation.failAndRollback(ctx, guard, j, err)
		}
		j.Phase = managedPluginCandidateLockWritten
		if err := activation.writeJournal(j); err != nil {
			return "", err
		}
	}
	if j.Phase == managedPluginCandidateLockWritten {
		if err := activation.clearReadiness(); err != nil {
			return "", activation.failAndRollback(ctx, guard, j, err)
		}
		if err := activation.Gateway.Start(ctx, unit); err != nil {
			return "", activation.failAndRollback(ctx, guard, j, err)
		}
		j.Phase = managedPluginCandidateStarted
		if err := activation.writeJournal(j); err != nil {
			return "", err
		}
	}
	if j.Phase == managedPluginCandidateStarted {
		receipt, readinessErr := activation.waitForReadiness(ctx, guard, j.CandidateLockDigest)
		if readinessErr != nil {
			return "", activation.failAndRollback(ctx, guard, j, readinessErr)
		}
		j.ReadinessDigest = receipt
		j.Phase = managedPluginCandidateReady
		if err := activation.writeJournal(j); err != nil {
			return "", err
		}
	}
	if j.Phase == managedPluginCandidateReady {
		j.Phase = managedPluginCommitted
		if err := activation.writeJournal(j); err != nil {
			return "", err
		}
		if err := activation.Transaction.Finalize(transactionID); err != nil {
			return "", err
		}
	}
	return j.ReadinessDigest, nil
}

func (activation ManagedPluginActivation) failAndRollback(ctx context.Context, guard stateparticipant.PluginBoundary, journal managedPluginActivationJournal, cause error) error {
	if rollbackErr := activation.rollback(ctx, guard, journal); rollbackErr != nil {
		return errors.Join(cause, rollbackErr)
	}
	return cause
}

func (activation ManagedPluginActivation) rollback(ctx context.Context, guard stateparticipant.PluginBoundary, journal managedPluginActivationJournal) error {
	if !activation.isRollbackPhase(journal.Phase) {
		journal.Phase = managedPluginRollbackStarted
		if err := activation.writeJournal(journal); err != nil {
			return err
		}
	}
	if journal.Phase == managedPluginRollbackStarted {
		if err := activation.Gateway.Stop(ctx, journal.GatewayUnit); err != nil {
			return fmt.Errorf("stop Gateway for managed plugin rollback: %w", err)
		}
		if err := activation.writeLiveLock(journal.PreviousLock, os.FileMode(journal.PreviousLockMode), journal.PreviousLockUID, journal.PreviousLockGID); err != nil {
			return err
		}
		journal.Phase = managedPluginPreviousLockWritten
		if err := activation.writeJournal(journal); err != nil {
			return err
		}
	}
	if journal.Phase == managedPluginPreviousLockWritten {
		if err := activation.clearReadiness(); err != nil {
			return err
		}
		if err := activation.Gateway.Start(ctx, journal.GatewayUnit); err != nil {
			return fmt.Errorf("restart previous Gateway after managed plugin failure: %w", err)
		}
		journal.Phase = managedPluginPreviousStarted
		if err := activation.writeJournal(journal); err != nil {
			return err
		}
	}
	if journal.Phase == managedPluginPreviousStarted {
		if _, err := activation.waitForReadiness(ctx, guard, journal.PreviousLockDigest); err != nil {
			return fmt.Errorf("previous managed plugin readiness was not restored: %w", err)
		}
		journal.Phase = managedPluginPreviousReady
		if err := activation.writeJournal(journal); err != nil {
			return err
		}
	}
	if journal.Phase == managedPluginPreviousReady {
		if err := activation.Transaction.Rollback(journal.TransactionID); err != nil {
			return err
		}
		journal.Phase = managedPluginRolledBack
		if err := activation.writeJournal(journal); err != nil {
			return err
		}
	}
	return errors.New("managed plugin transaction was rolled back")
}

func (activation ManagedPluginActivation) waitForReadiness(ctx context.Context, guard stateparticipant.PluginBoundary, lockDigest string) (string, error) {
	clock := activation.ReadinessClock
	if clock == nil {
		clock = systemManagedPluginReadinessClock{}
	}
	deadline := clock.Now().Add(managedPluginReadinessDeadline)
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		receipt, err := guard.VerifyReadiness(lockDigest, activation.GenerationID)
		if err == nil {
			return receipt, nil
		}
		if !managedPluginReadinessRetryable(err) {
			return "", err
		}
		now := clock.Now()
		if !now.Before(deadline) {
			return "", fmt.Errorf("managed plugin readiness did not bind the restarted Gateway within %s: %w", managedPluginReadinessDeadline, err)
		}
		delay := managedPluginReadinessPoll
		if remaining := deadline.Sub(now); remaining < delay {
			delay = remaining
		}
		if err := clock.Wait(ctx, delay); err != nil {
			return "", err
		}
	}
}

func managedPluginReadinessRetryable(err error) bool {
	return errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), "plugin readiness receipt identity mismatch")
}

func (activation ManagedPluginActivation) validate(transactionID string) (stateparticipant.PluginBoundary, uint32, string, error) {
	if activation.Gateway == nil || !managedPluginTransactionID.MatchString(transactionID) || !managedPluginActivationDigest.MatchString(activation.GenerationID) {
		return stateparticipant.PluginBoundary{}, 0, "", errors.New("managed plugin activation is incomplete")
	}
	if err := activation.Config.Validate(); err != nil {
		return stateparticipant.PluginBoundary{}, 0, "", err
	}
	expectedIdentity, err := activation.Config.Identity()
	if err != nil || !reflect.DeepEqual(activation.Identity, expectedIdentity) {
		return stateparticipant.PluginBoundary{}, 0, "", errors.New("managed plugin activation Gateway identity is invalid")
	}
	if activation.Transaction.CodeRoot != filepath.Join(activation.Config.InstallRoot, "plugin-code") || activation.Transaction.TransactionRoot != managedPluginTransactionRoot(activation.Config) || activation.Transaction.CodeOwnerUID != 0 || activation.Transaction.CodeOwnerGID != 0 || activation.Transaction.ArchiveOwnerUID != activation.Config.Operator.UID {
		return stateparticipant.PluginBoundary{}, 0, "", errors.New("managed plugin activation transaction is not config-bound")
	}
	configGID, err := canonicalConfigGroupGID(activation.Config.OwnerStateRoot, activation.Config.Operator.UID)
	if err != nil {
		return stateparticipant.PluginBoundary{}, 0, "", err
	}
	guard := stateparticipant.PluginBoundary{CodeRoot: activation.Transaction.CodeRoot, DataRoot: filepath.Join(activation.Config.OwnerStateRoot, "plugin-data"), LockPath: CanonicalPluginLockPath(activation.Config), ReadinessPath: filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), CodeOwnerUID: activation.Transaction.CodeOwnerUID, OperatorUID: activation.Config.Operator.UID, GatewayUID: activation.Config.Gateway.UID, ConfigGID: configGID}
	if _, _, err := guard.VerifyInstalledLock(); err != nil {
		return stateparticipant.PluginBoundary{}, 0, "", fmt.Errorf("validate installed managed plugin lock: %w", err)
	}
	return guard, configGID, expectedIdentity.Services["gateway"], nil
}

func (activation ManagedPluginActivation) openJournal(transactionID string, guard stateparticipant.PluginBoundary, configGID uint32, unit string) (managedPluginActivationJournal, error) {
	if err := activation.Transaction.validateRecordRoots(transactionID); err != nil {
		return managedPluginActivationJournal{}, err
	}
	path := activation.journalPath(transactionID)
	data, err := activation.Transaction.readStableRecord(path)
	if errors.Is(err, os.ErrNotExist) {
		previous, previousDigest, readErr := activation.readLiveLock(configGID)
		if readErr != nil {
			return managedPluginActivationJournal{}, readErr
		}
		result, recordErr := activation.Transaction.readRecord(transactionID)
		if recordErr != nil {
			return managedPluginActivationJournal{}, recordErr
		}
		current, currentErr := stateparticipant.DecodePluginLock(previous.data)
		if currentErr != nil {
			return managedPluginActivationJournal{}, currentErr
		}
		catalog, catalogErr := stateparticipant.DecodeManagedPluginCatalog(result.CatalogData)
		if catalogErr != nil {
			return managedPluginActivationJournal{}, catalogErr
		}
		expectedCandidate, mergeErr := stateparticipant.MergeManagedPluginCatalog(current, catalog)
		if mergeErr != nil {
			return managedPluginActivationJournal{}, mergeErr
		}
		expectedData, marshalErr := json.Marshal(expectedCandidate)
		if marshalErr != nil {
			return managedPluginActivationJournal{}, marshalErr
		}
		recordCandidateData, recordMarshalErr := json.Marshal(result.CandidateLock)
		if recordMarshalErr != nil {
			return managedPluginActivationJournal{}, recordMarshalErr
		}
		expectedDigest, digestErr := stateparticipant.PluginLockDigest(expectedCandidate)
		if digestErr != nil || expectedDigest != result.CandidateLockDigest || string(expectedData) != string(recordCandidateData) {
			return managedPluginActivationJournal{}, errors.New("managed plugin transaction candidate conflicts with the current live lock")
		}
		candidate, candidateErr := stageResult(result)
		if candidateErr != nil {
			return managedPluginActivationJournal{}, candidateErr
		}
		journal := managedPluginActivationJournal{SchemaVersion: managedPluginActivationSchemaVersion, TransactionID: transactionID, GenerationID: activation.GenerationID, GatewayUnit: unit, Phase: managedPluginPrepared, PreviousLock: previous.data, PreviousLockDigest: previousDigest, PreviousLockMode: uint32(previous.mode.Perm()), PreviousLockUID: previous.uid, PreviousLockGID: previous.gid, CandidateLock: candidate.CandidateLockData, CandidateLockDigest: candidate.CandidateLockDigest}
		if err := activation.writeJournal(journal); err != nil {
			return managedPluginActivationJournal{}, err
		}
		return journal, nil
	}
	if err != nil {
		return managedPluginActivationJournal{}, err
	}
	var journal managedPluginActivationJournal
	if err := strictManagedPluginJSON(data, &journal); err != nil {
		return managedPluginActivationJournal{}, err
	}
	if err := activation.validateJournal(journal, transactionID, unit, guard); err != nil {
		return managedPluginActivationJournal{}, err
	}
	return journal, nil
}

type managedPluginLockSnapshot struct {
	data     []byte
	mode     os.FileMode
	uid, gid uint32
}

func (activation ManagedPluginActivation) readLiveLock(configGID uint32) (managedPluginLockSnapshot, string, error) {
	path := CanonicalPluginLockPath(activation.Config)
	info, err := os.Lstat(path)
	if err != nil {
		return managedPluginLockSnapshot{}, "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || stat.Uid != activation.Config.Operator.UID || stat.Gid != configGID || info.Mode().Perm() != 0o640 || info.Size() == 0 || info.Size() > maxManagedPluginRecordBytes {
		return managedPluginLockSnapshot{}, "", errors.New("live managed plugin lock identity or access is unsafe")
	}
	file, err := os.Open(path)
	if err != nil {
		return managedPluginLockSnapshot{}, "", err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !sameManagedPluginArchiveIdentity(info, opened) {
		return managedPluginLockSnapshot{}, "", errors.New("live managed plugin lock changed while opening")
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maxManagedPluginRecordBytes+1))
	if readErr != nil || len(data) == 0 || len(data) > maxManagedPluginRecordBytes {
		return managedPluginLockSnapshot{}, "", errors.Join(readErr, errors.New("live managed plugin lock exceeds byte budget"))
	}
	after, afterErr := file.Stat()
	pathAfter, pathErr := os.Lstat(path)
	if afterErr != nil || pathErr != nil || !activation.safeLiveLockInfo(after, configGID) || !activation.safeLiveLockInfo(pathAfter, configGID) || !sameManagedPluginArchiveIdentity(info, after) || !sameManagedPluginArchiveIdentity(info, pathAfter) {
		return managedPluginLockSnapshot{}, "", errors.New("live managed plugin lock changed while reading")
	}
	lock, err := stateparticipant.DecodePluginLock(data)
	if err != nil {
		return managedPluginLockSnapshot{}, "", err
	}
	digest, err := stateparticipant.PluginLockDigest(lock)
	if err != nil {
		return managedPluginLockSnapshot{}, "", err
	}
	return managedPluginLockSnapshot{data: data, mode: info.Mode(), uid: stat.Uid, gid: stat.Gid}, digest, nil
}

func (activation ManagedPluginActivation) safeLiveLockInfo(info os.FileInfo, configGID uint32) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && stat.Nlink == 1 && stat.Uid == activation.Config.Operator.UID && stat.Gid == configGID && info.Mode().Perm() == 0o640 && info.Size() > 0 && info.Size() <= maxManagedPluginRecordBytes
}

func (activation ManagedPluginActivation) writeLiveLock(data []byte, mode os.FileMode, uid, gid uint32) error {
	if len(data) == 0 || len(data) > maxManagedPluginRecordBytes {
		return errors.New("live managed plugin lock exceeds byte budget")
	}
	lock, err := stateparticipant.DecodePluginLock(data)
	if err != nil {
		return err
	}
	if _, err := stateparticipant.PluginLockDigest(lock); err != nil {
		return err
	}
	path := CanonicalPluginLockPath(activation.Config)
	return writeManagedPluginLiveLock(path, data, mode, uid, gid)
}

// managedPluginLiveLockBeforeRename is test-only fault injection at the final
// interruption boundary. The live name is untouched until all final metadata
// has been applied and the replacement has been fsynced.
var managedPluginLiveLockBeforeRename func() error

func writeManagedPluginLiveLock(path string, data []byte, mode os.FileMode, uid, gid uint32) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".fased-plugin-lock-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	closeFailure := func(cause error) error {
		return errors.Join(cause, temporary.Close())
	}
	if _, err := temporary.Write(data); err != nil {
		return closeFailure(err)
	}
	// Chown can clear special mode bits. Set the final mode after chown, before
	// syncing or renaming, so the live name never names a wrong-owner lock.
	if err := temporary.Chown(int(uid), int(gid)); err != nil {
		return closeFailure(err)
	}
	if err := temporary.Chmod(mode); err != nil {
		return closeFailure(err)
	}
	if err := temporary.Sync(); err != nil {
		return closeFailure(err)
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if managedPluginLiveLockBeforeRename != nil {
		if err := managedPluginLiveLockBeforeRename(); err != nil {
			return err
		}
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	return syncPluginDirectory(directory)
}

// A readiness file is evidence from one Gateway process only. Removing it
// durably before every start prevents a stale matching receipt from proving a
// process that did not observe the newly switched lock.
func (activation ManagedPluginActivation) clearReadiness() error {
	path := filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json")
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	configGID, gidErr := canonicalConfigGroupGID(activation.Config.OwnerStateRoot, activation.Config.Operator.UID)
	if gidErr != nil || !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || stat.Uid != activation.Config.Gateway.UID || stat.Gid != configGID || info.Mode().Perm()&0o077 != 0 {
		return errors.New("managed plugin readiness receipt identity or access is unsafe")
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncPluginDirectory(filepath.Dir(path))
}

func (activation ManagedPluginActivation) validateJournal(j managedPluginActivationJournal, transactionID, unit string, guard stateparticipant.PluginBoundary) error {
	terminal := j.Phase == managedPluginCommitted || j.Phase == managedPluginRolledBack
	if j.SchemaVersion != managedPluginActivationSchemaVersion || j.TransactionID != transactionID || !managedPluginActivationDigest.MatchString(j.GenerationID) || (!terminal && j.GenerationID != activation.GenerationID) || j.GatewayUnit != unit || !activation.validPhase(j.Phase) || j.PreviousLockMode != 0o640 || j.PreviousLockUID != activation.Config.Operator.UID || j.PreviousLockGID != guard.ConfigGID || len(j.PreviousLock) == 0 || len(j.CandidateLock) == 0 {
		return errors.New("managed plugin activation journal is invalid")
	}
	previous, err := stateparticipant.DecodePluginLock(j.PreviousLock)
	if err != nil {
		return err
	}
	if digest, err := stateparticipant.PluginLockDigest(previous); err != nil || digest != j.PreviousLockDigest {
		return errors.New("managed plugin activation previous lock conflicts")
	}
	candidate, err := stateparticipant.DecodePluginLock(j.CandidateLock)
	if err != nil {
		return err
	}
	if digest, err := stateparticipant.PluginLockDigest(candidate); err != nil || digest != j.CandidateLockDigest {
		return errors.New("managed plugin activation candidate lock conflicts")
	}
	record, err := activation.Transaction.readRecord(transactionID)
	if err != nil {
		return err
	}
	result, err := stageResult(record)
	if err != nil || result.CandidateLockDigest != j.CandidateLockDigest || string(result.CandidateLockData) != string(j.CandidateLock) {
		return errors.New("managed plugin activation candidate is not bound to transaction record")
	}
	if j.Phase == managedPluginCommitted && j.ReadinessDigest == "" {
		return errors.New("managed plugin activation completion receipt is missing")
	}
	_ = guard
	return nil
}

func (activation ManagedPluginActivation) writeJournal(j managedPluginActivationJournal) error {
	data, err := marshalManagedPluginActivationJournal(j)
	if err != nil {
		return err
	}
	path := activation.journalPath(j.TransactionID)
	if err := writeAtomicFile(path, data, 0o600); err != nil {
		return err
	}
	if err := os.Chown(path, int(activation.Transaction.CodeOwnerUID), int(activation.Transaction.CodeOwnerGID)); err != nil {
		return err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return err
	}
	return syncPluginDirectory(filepath.Dir(path))
}

func marshalManagedPluginActivationJournal(journal managedPluginActivationJournal) ([]byte, error) {
	data, err := json.Marshal(journal)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || len(data) > maxManagedPluginRecordBytes {
		return nil, errors.New("managed plugin activation journal exceeds byte budget")
	}
	return data, nil
}

func (activation ManagedPluginActivation) validateJournalPreflight(journal managedPluginActivationJournal, guard stateparticipant.PluginBoundary) error {
	if journal.PreviousLockMode != 0o640 || journal.PreviousLockUID != activation.Config.Operator.UID || journal.PreviousLockGID != guard.ConfigGID || len(journal.PreviousLock) == 0 || len(journal.CandidateLock) == 0 {
		return errors.New("managed plugin activation journal is invalid")
	}
	if _, err := stateparticipant.DecodePluginLock(journal.PreviousLock); err != nil {
		return err
	}
	if _, err := stateparticipant.DecodePluginLock(journal.CandidateLock); err != nil {
		return err
	}
	return nil
}

func (activation ManagedPluginActivation) journalPath(transactionID string) string {
	return filepath.Join(activation.Transaction.recordRoot(transactionID), "managed-plugin-activation.json")
}

func managedPluginTransactionRoot(config Config) string {
	return filepath.Join(config.LifecycleRoot, "plugin-transactions")
}
func (activation ManagedPluginActivation) isRollbackPhase(phase managedPluginActivationPhase) bool {
	switch phase {
	case managedPluginRollbackStarted, managedPluginPreviousLockWritten, managedPluginPreviousStarted, managedPluginPreviousReady:
		return true
	default:
		return false
	}
}
func (activation ManagedPluginActivation) validPhase(phase managedPluginActivationPhase) bool {
	switch phase {
	case managedPluginPrepared, managedPluginGatewayStopped, managedPluginCodeActivated, managedPluginCandidateLockWritten, managedPluginCandidateStarted, managedPluginCandidateReady, managedPluginCommitted, managedPluginRollbackStarted, managedPluginPreviousLockWritten, managedPluginPreviousStarted, managedPluginPreviousReady, managedPluginRolledBack:
		return true
	default:
		return false
	}
}
