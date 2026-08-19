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

// Apply creates or resumes the exact activation journal. It is intentionally
// platform-internal: callers must supply a previously staged transaction ID.
func (activation ManagedPluginActivation) Apply(ctx context.Context, transactionID string) (string, error) {
	guard, configGID, unit, err := activation.validate(transactionID)
	if err != nil {
		return "", err
	}
	return activation.applyBound(ctx, transactionID, guard, configGID, unit)
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
	lock, err := stateparticipant.DecodePluginLock(data)
	if err != nil {
		return err
	}
	if _, err := stateparticipant.PluginLockDigest(lock); err != nil {
		return err
	}
	path := CanonicalPluginLockPath(activation.Config)
	if err := writeAtomicFile(path, data, mode); err != nil {
		return err
	}
	if err := os.Chown(path, int(uid), int(gid)); err != nil {
		return err
	}
	if err := os.Chmod(path, mode); err != nil {
		return err
	}
	return syncPluginDirectory(filepath.Dir(path))
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
	if j.SchemaVersion != managedPluginActivationSchemaVersion || j.TransactionID != transactionID || j.GenerationID != activation.GenerationID || j.GatewayUnit != unit || !activation.validPhase(j.Phase) || j.PreviousLockMode != 0o640 || j.PreviousLockUID != activation.Config.Operator.UID || j.PreviousLockGID != guard.ConfigGID || len(j.PreviousLock) == 0 || len(j.CandidateLock) == 0 {
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
	data, err := json.Marshal(j)
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
