package store

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"fased-lifecycled/model"
)

const CurrentProgressSchemaVersion uint32 = 1

type ProgressStep string

const (
	ProgressGenerationStaged  ProgressStep = "GENERATION_STAGED"
	ProgressMigratorPrepared  ProgressStep = "MIGRATOR_PREPARED"
	ProgressSignerPrepared    ProgressStep = "SIGNER_PREPARED"
	ProgressPlatformPrepared  ProgressStep = "PLATFORM_PREPARED"
	ProgressQuiesceStarted    ProgressStep = "QUIESCE_STARTED"
	ProgressQuiesced          ProgressStep = "QUIESCED"
	ProgressStatePrepared     ProgressStep = "STATE_PREPARED"
	ProgressMigratorActivated ProgressStep = "MIGRATOR_ACTIVATED"
	ProgressPlatformActivated ProgressStep = "PLATFORM_ACTIVATED"
	ProgressMigratorVerified  ProgressStep = "MIGRATOR_VERIFIED"
	ProgressSignerVerified    ProgressStep = "SIGNER_VERIFIED"
	ProgressPlatformVerified  ProgressStep = "PLATFORM_VERIFIED"
	ProgressMigratorCommitted ProgressStep = "MIGRATOR_COMMITTED"
	ProgressSignerCommitted   ProgressStep = "SIGNER_COMMITTED"
	ProgressPlatformCommitted ProgressStep = "PLATFORM_COMMITTED"
	ProgressManifestCommitted ProgressStep = "MANIFEST_COMMITTED"
	ProgressRollbackStarted   ProgressStep = "ROLLBACK_STARTED"
	ProgressTargetStopped     ProgressStep = "TARGET_STOPPED"
	ProgressSignerAborted     ProgressStep = "SIGNER_ABORTED"
	ProgressMigratorAborted   ProgressStep = "MIGRATOR_ABORTED"
	ProgressPlatformRestored  ProgressStep = "PLATFORM_RESTORED"
	ProgressPlatformDiscarded ProgressStep = "PLATFORM_DISCARDED"
	ProgressRollbackCompleted ProgressStep = "ROLLBACK_COMPLETED"
)

type DurableParticipantReceipt struct {
	Participant          string `json:"participant"`
	TransactionID        string `json:"transactionId"`
	TargetGenerationID   string `json:"targetGenerationId"`
	StateInventoryDigest string `json:"stateInventoryDigest"`
	PlanDigest           string `json:"planDigest"`
}

type DurableUndoRecord struct {
	Participant string `json:"participant"`
	Locator     string `json:"locator"`
	Digest      string `json:"digest"`
}

type ProgressEvent struct {
	Sequence uint32                     `json:"sequence"`
	Step     ProgressStep               `json:"step"`
	Receipt  *DurableParticipantReceipt `json:"receipt,omitempty"`
	Undo     *DurableUndoRecord         `json:"undo,omitempty"`
}

type ProgressRecord struct {
	SchemaVersion uint32          `json:"schemaVersion"`
	TransactionID string          `json:"transactionId"`
	Events        []ProgressEvent `json:"events"`
}

func (s *Store) AppendProgress(transaction model.Transaction, event ProgressEvent) error {
	if err := transaction.Validate(); err != nil {
		return err
	}
	if err := validateProgressEvent(event, transaction); err != nil {
		return err
	}
	dir := filepath.Join(s.stateRoot, "transactions", transaction.ID)
	if err := s.verifyTransactionEnvelope(dir, transaction); err != nil {
		return err
	}
	path := filepath.Join(dir, "progress.json")
	record, err := s.ReadProgress(transaction.ID)
	if errors.Is(err, os.ErrNotExist) {
		record = ProgressRecord{SchemaVersion: CurrentProgressSchemaVersion, TransactionID: transaction.ID, Events: []ProgressEvent{}}
	} else if err != nil {
		return err
	}
	event.Sequence = uint32(len(record.Events) + 1)
	if len(record.Events) > 0 {
		last := record.Events[len(record.Events)-1]
		probe := event
		probe.Sequence = last.Sequence
		if sameProgressEvent(last, probe) {
			return nil
		}
	}
	record.Events = append(record.Events, event)
	if err := validateProgressRecord(record, transaction); err != nil {
		return err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return writeAtomic(path, data, 0o600)
}

func (s *Store) ReadProgress(transactionID string) (ProgressRecord, error) {
	data, err := readRegular(filepath.Join(s.stateRoot, "transactions", transactionID, "progress.json"))
	if err != nil {
		return ProgressRecord{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var record ProgressRecord
	if err := decoder.Decode(&record); err != nil {
		return ProgressRecord{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return ProgressRecord{}, errors.New("unexpected trailing progress JSON")
		}
		return ProgressRecord{}, err
	}
	if record.SchemaVersion != CurrentProgressSchemaVersion || record.TransactionID != transactionID {
		return ProgressRecord{}, errors.New("progress record identity is unsupported")
	}
	return record, nil
}

// ValidateProgress binds every durable subphase, receipt, and undo locator to
// the immutable transaction envelope reopened from the authority journal.
func ValidateProgress(record ProgressRecord, transaction model.Transaction) error {
	return validateProgressRecord(record, transaction)
}

func (s *Store) PendingSupervisorTransaction() (model.Transaction, error) {
	root := filepath.Join(s.stateRoot, "transactions")
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return model.Transaction{}, os.ErrNotExist
	}
	if err != nil {
		return model.Transaction{}, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	var pending *model.Transaction
	for _, entry := range entries {
		if !entry.IsDir() {
			return model.Transaction{}, errors.New("transaction root contains a non-directory entry")
		}
		tx, err := s.ReadJournal(AuthoritySupervisor, entry.Name())
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return model.Transaction{}, err
		}
		if tx.Phase == model.PhaseCommitted || tx.Phase == model.PhaseRolledBack {
			continue
		}
		if pending != nil {
			return model.Transaction{}, errors.New("multiple unfinished lifecycle transactions require repair")
		}
		copy := tx
		pending = &copy
	}
	if pending == nil {
		return model.Transaction{}, os.ErrNotExist
	}
	return *pending, nil
}

func validateProgressRecord(record ProgressRecord, transaction model.Transaction) error {
	if record.SchemaVersion != CurrentProgressSchemaVersion || record.TransactionID != transaction.ID || len(record.Events) == 0 {
		return errors.New("progress record identity is invalid")
	}
	for index, event := range record.Events {
		if event.Sequence != uint32(index+1) {
			return errors.New("progress sequence is not contiguous")
		}
		if err := validateProgressEvent(event, transaction); err != nil {
			return err
		}
	}
	return nil
}

func validateProgressEvent(event ProgressEvent, transaction model.Transaction) error {
	if !validProgressStep(event.Step) {
		return fmt.Errorf("unsupported progress step %q", event.Step)
	}
	if event.Receipt != nil {
		receipt := event.Receipt
		wantPlan := transaction.MigrationPlanDigest
		if receipt.Participant == "signer" {
			wantPlan = transaction.SignerPlanDigest
		}
		if receipt.Participant == "state" {
			wantPlan = transaction.StateInventoryDigest
		}
		if (receipt.Participant != "migrator" && receipt.Participant != "signer" && receipt.Participant != "state") || receipt.TransactionID != transaction.ID || receipt.TargetGenerationID != transaction.Target.ID || receipt.StateInventoryDigest != transaction.StateInventoryDigest || receipt.PlanDigest != wantPlan {
			return errors.New("participant receipt differs from the immutable transaction")
		}
	}
	if event.Undo != nil {
		undo := event.Undo
		if undo.Participant == "" || undo.Locator == "" || filepath.IsAbs(undo.Locator) || filepath.Clean(undo.Locator) != undo.Locator || undo.Locator == ".." || strings.HasPrefix(undo.Locator, ".."+string(filepath.Separator)) || !validSHA256Digest(undo.Digest) {
			return errors.New("undo record is not a bounded transaction-relative identity")
		}
	}
	return nil
}

func validSHA256Digest(value string) bool {
	if !strings.HasPrefix(value, "sha256:") || len(value) != 71 {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil
}

func validProgressStep(step ProgressStep) bool {
	switch step {
	case ProgressGenerationStaged, ProgressMigratorPrepared, ProgressSignerPrepared, ProgressPlatformPrepared,
		ProgressQuiesceStarted, ProgressQuiesced, ProgressStatePrepared, ProgressMigratorActivated, ProgressPlatformActivated, ProgressMigratorVerified,
		ProgressSignerVerified, ProgressPlatformVerified, ProgressMigratorCommitted, ProgressSignerCommitted,
		ProgressPlatformCommitted, ProgressManifestCommitted, ProgressRollbackStarted, ProgressTargetStopped,
		ProgressSignerAborted, ProgressMigratorAborted, ProgressPlatformRestored, ProgressPlatformDiscarded,
		ProgressRollbackCompleted:
		return true
	default:
		return false
	}
}

func sameProgressEvent(left, right ProgressEvent) bool {
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return bytes.Equal(leftJSON, rightJSON)
}
