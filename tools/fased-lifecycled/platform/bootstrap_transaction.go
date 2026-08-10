package platform

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

const CurrentBootstrapJournalSchemaVersion uint32 = 1

type BootstrapPhase string

const (
	BootstrapPhaseRegistry   BootstrapPhase = "INSTANCE_REGISTRY"
	BootstrapPhasePrincipals BootstrapPhase = "PRINCIPALS"
	BootstrapPhasePaths      BootstrapPhase = "PATHS"
	BootstrapPhaseACL        BootstrapPhase = "ACL"
	BootstrapPhaseDaemon     BootstrapPhase = "DAEMON"
	BootstrapPhaseConfig     BootstrapPhase = "CONFIG"
	BootstrapPhaseLauncher   BootstrapPhase = "LAUNCHER"
	BootstrapPhaseUnits      BootstrapPhase = "UNITS"
)

type BootstrapEvent struct {
	Sequence uint32         `json:"sequence"`
	Phase    BootstrapPhase `json:"phase"`
	State    string         `json:"state"`
}

type BootstrapJournalRecord struct {
	SchemaVersion uint32           `json:"schemaVersion"`
	TransactionID string           `json:"transactionId"`
	Events        []BootstrapEvent `json:"events"`
}

type BootstrapJournal interface {
	Record(BootstrapPhase, string) error
}

type FileBootstrapJournal struct {
	path   string
	record BootstrapJournalRecord
}

func OpenBootstrapJournal(path, transactionID string) (*FileBootstrapJournal, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" || !lockTransactionPattern.MatchString(transactionID) {
		return nil, errors.New("bootstrap journal path or transaction identity is invalid")
	}
	journal := &FileBootstrapJournal{path: path, record: BootstrapJournalRecord{
		SchemaVersion: CurrentBootstrapJournalSchemaVersion, TransactionID: transactionID, Events: []BootstrapEvent{},
	}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return journal, nil
	}
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 || len(data) == 0 || len(data) > maxDurableBootstrapJournal {
		return nil, errors.New("bootstrap journal is unsafe")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&journal.record); err != nil {
		return nil, err
	}
	if journal.record.SchemaVersion > CurrentBootstrapJournalSchemaVersion {
		return nil, errors.New("bootstrap journal schema is newer than supported")
	}
	if journal.record.SchemaVersion != CurrentBootstrapJournalSchemaVersion || journal.record.TransactionID != transactionID {
		return nil, errors.New("bootstrap journal identity is unsupported")
	}
	if err := validateBootstrapEvents(journal.record.Events); err != nil {
		return nil, err
	}
	return journal, nil
}

const maxDurableBootstrapJournal = 1 << 20

func (journal *FileBootstrapJournal) Record(phase BootstrapPhase, state string) error {
	if journal == nil || !validBootstrapPhase(phase) || !validBootstrapState(state) {
		return errors.New("bootstrap journal event is invalid")
	}
	event := BootstrapEvent{Sequence: uint32(len(journal.record.Events) + 1), Phase: phase, State: state}
	journal.record.Events = append(journal.record.Events, event)
	if err := validateBootstrapEvents(journal.record.Events); err != nil {
		journal.record.Events = journal.record.Events[:len(journal.record.Events)-1]
		return err
	}
	data, err := json.Marshal(journal.record)
	if err != nil {
		return err
	}
	if err := ensureBootstrapJournalParent(filepath.Dir(journal.path)); err != nil {
		journal.record.Events = journal.record.Events[:len(journal.record.Events)-1]
		return err
	}
	if err := writeAtomicFile(journal.path, append(data, '\n'), 0o600); err != nil {
		journal.record.Events = journal.record.Events[:len(journal.record.Events)-1]
		return err
	}
	return nil
}

func ensureBootstrapJournalParent(parent string) error {
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(parent, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(parent)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 {
		return errors.New("bootstrap journal directory is unsafe")
	}
	return nil
}

func validateBootstrapEvents(events []BootstrapEvent) error {
	for index, event := range events {
		if event.Sequence != uint32(index+1) || !validBootstrapPhase(event.Phase) || !validBootstrapState(event.State) {
			return errors.New("bootstrap journal contains an invalid event")
		}
	}
	return nil
}

func validBootstrapPhase(phase BootstrapPhase) bool {
	switch phase {
	case BootstrapPhaseRegistry, BootstrapPhasePrincipals, BootstrapPhasePaths, BootstrapPhaseACL, BootstrapPhaseDaemon, BootstrapPhaseConfig, BootstrapPhaseLauncher, BootstrapPhaseUnits:
		return true
	default:
		return false
	}
}

var bootstrapStatePattern = regexp.MustCompile(`^(APPLYING|APPLIED|ROLLING_BACK|ROLLED_BACK)$`)

func validBootstrapState(state string) bool { return bootstrapStatePattern.MatchString(state) }

type BootstrapUndo func() error

type BootstrapStep struct {
	Phase BootstrapPhase
	Apply func() (BootstrapUndo, error)
}

func ExecuteBootstrapTransaction(journal BootstrapJournal, steps []BootstrapStep) error {
	transaction, err := BeginBootstrapTransaction(journal, steps)
	if err != nil {
		return err
	}
	transaction.Commit()
	return nil
}

type AppliedBootstrapTransaction struct {
	journal  BootstrapJournal
	undos    []bootstrapAppliedStep
	finished bool
}

type bootstrapAppliedStep struct {
	phase BootstrapPhase
	undo  BootstrapUndo
}

func BeginBootstrapTransaction(journal BootstrapJournal, steps []BootstrapStep) (*AppliedBootstrapTransaction, error) {
	if journal == nil || len(steps) == 0 {
		return nil, errors.New("bootstrap transaction is incomplete")
	}
	seen := map[BootstrapPhase]bool{}
	undos := make([]bootstrapAppliedStep, 0, len(steps))
	for _, step := range steps {
		if !validBootstrapPhase(step.Phase) || seen[step.Phase] || step.Apply == nil {
			return nil, errors.New("bootstrap transaction contains an invalid or duplicate phase")
		}
		seen[step.Phase] = true
		if err := journal.Record(step.Phase, "APPLYING"); err != nil {
			return nil, rollbackBootstrap(journal, undos, err)
		}
		undo, err := step.Apply()
		if err != nil {
			return nil, rollbackBootstrap(journal, undos, err)
		}
		if undo == nil {
			undo = func() error { return nil }
		}
		undos = append(undos, bootstrapAppliedStep{phase: step.Phase, undo: undo})
		if err := journal.Record(step.Phase, "APPLIED"); err != nil {
			return nil, rollbackBootstrap(journal, undos, err)
		}
	}
	return &AppliedBootstrapTransaction{journal: journal, undos: undos}, nil
}

func rollbackBootstrap(journal BootstrapJournal, undos []bootstrapAppliedStep, cause error) error {
	failures := []error{}
	if cause != nil {
		failures = append(failures, cause)
	}
	for index := len(undos) - 1; index >= 0; index-- {
		entry := undos[index]
		failures = append(failures, journal.Record(entry.phase, "ROLLING_BACK"))
		failures = append(failures, entry.undo())
		failures = append(failures, journal.Record(entry.phase, "ROLLED_BACK"))
	}
	result := errors.Join(failures...)
	if cause == nil {
		return result
	}
	return fmt.Errorf("bootstrap transaction rolled back at %s: %w", time.Now().UTC().Format(time.RFC3339), result)
}

func (transaction *AppliedBootstrapTransaction) Rollback() error {
	if transaction == nil || transaction.finished {
		return nil
	}
	err := rollbackBootstrap(transaction.journal, transaction.undos, nil)
	transaction.finished = true
	return err
}

func (transaction *AppliedBootstrapTransaction) Commit() {
	if transaction != nil {
		transaction.finished = true
	}
}
