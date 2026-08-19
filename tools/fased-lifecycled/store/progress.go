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
	"reflect"
	"sort"
	"strings"

	"fased-lifecycled/model"
)

const CurrentProgressSchemaVersion uint32 = 3

type ProgressStep string

const (
	ProgressGenerationStaged            ProgressStep = "GENERATION_STAGED"
	ProgressMigratorPrepared            ProgressStep = "MIGRATOR_PREPARED"
	ProgressSignerPrepared              ProgressStep = "SIGNER_PREPARED"
	ProgressPlatformPrepared            ProgressStep = "PLATFORM_PREPARED"
	ProgressQuiesceStarted              ProgressStep = "QUIESCE_STARTED"
	ProgressQuiesced                    ProgressStep = "QUIESCED"
	ProgressStatePrepared               ProgressStep = "STATE_PREPARED"
	ProgressMigratorActivated           ProgressStep = "MIGRATOR_ACTIVATED"
	ProgressPlatformActivated           ProgressStep = "PLATFORM_ACTIVATED"
	ProgressMigratorVerified            ProgressStep = "MIGRATOR_VERIFIED"
	ProgressSignerVerified              ProgressStep = "SIGNER_VERIFIED"
	ProgressPluginVerified              ProgressStep = "PLUGIN_VERIFIED"
	ProgressPlatformVerified            ProgressStep = "PLATFORM_VERIFIED"
	ProgressMigratorCommitted           ProgressStep = "MIGRATOR_COMMITTED"
	ProgressSignerCommitted             ProgressStep = "SIGNER_COMMITTED"
	ProgressPlatformCommitted           ProgressStep = "PLATFORM_COMMITTED"
	ProgressManifestCommitted           ProgressStep = "MANIFEST_COMMITTED"
	ProgressTerminalConvergenceVerified ProgressStep = "TERMINAL_CONVERGENCE_VERIFIED"
	ProgressPlatformFinalized           ProgressStep = "PLATFORM_FINALIZED"
	ProgressRollbackStarted             ProgressStep = "ROLLBACK_STARTED"
	ProgressTargetStopped               ProgressStep = "TARGET_STOPPED"
	ProgressSignerAborted               ProgressStep = "SIGNER_ABORTED"
	ProgressMigratorAborted             ProgressStep = "MIGRATOR_ABORTED"
	ProgressPlatformRestored            ProgressStep = "PLATFORM_RESTORED"
	ProgressPlatformDiscarded           ProgressStep = "PLATFORM_DISCARDED"
	ProgressRollbackCompleted           ProgressStep = "ROLLBACK_COMPLETED"
)

type DurableParticipantReceipt struct {
	Participant          string                     `json:"participant"`
	TransactionID        string                     `json:"transactionId"`
	TargetGenerationID   string                     `json:"targetGenerationId"`
	StateInventoryDigest string                     `json:"stateInventoryDigest"`
	PlanDigest           string                     `json:"planDigest"`
	EvidenceDigest       string                     `json:"evidenceDigest,omitempty"`
	Members              []DurableParticipantMember `json:"members,omitempty"`
}

type DurableParticipantMember struct {
	Participant string `json:"participant"`
	Digest      string `json:"digest"`
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
		terminalLegacy, err := s.terminalLegacyTransactionSet(entry.Name())
		if err != nil {
			return model.Transaction{}, err
		}
		if terminalLegacy {
			continue
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

// transactionV1 is the complete immutable schema written by the pre-release-
// authority lifecycle engine. It is accepted only as a terminal historical
// receipt: schema-one transactions are never resumed or used to select a new
// target.
type transactionV1 struct {
	SchemaVersion            uint32                 `json:"schemaVersion"`
	ID                       string                 `json:"transactionId"`
	Profile                  model.Profile          `json:"profile"`
	PlanAction               string                 `json:"planAction"`
	SourceTopology           string                 `json:"sourceTopology,omitempty"`
	PublicPredecessorVersion string                 `json:"publicPredecessorVersion,omitempty"`
	Phase                    model.Phase            `json:"phase"`
	Revision                 uint64                 `json:"revision"`
	Target                   model.Generation       `json:"target"`
	TargetStateSchemas       map[string]uint32      `json:"targetStateSchemas"`
	TargetCapabilities       model.CapabilityRanges `json:"targetCapabilities"`
	Previous                 *model.Generation      `json:"previous,omitempty"`
	ManifestDigest           string                 `json:"manifestDigest"`
	StateInventoryDigest     string                 `json:"stateInventoryDigest"`
	MigrationPlanDigest      string                 `json:"migrationPlanDigest"`
	SignerPlanDigest         string                 `json:"signerPlanDigest"`
	PlatformDigest           string                 `json:"platformDigest"`
	Migrations               []model.Migration      `json:"migrations"`
}

type transactionEnvelopeV1 struct {
	SchemaVersion            uint32                 `json:"schemaVersion"`
	ID                       string                 `json:"transactionId"`
	Profile                  model.Profile          `json:"profile"`
	PlanAction               string                 `json:"planAction"`
	SourceTopology           string                 `json:"sourceTopology,omitempty"`
	PublicPredecessorVersion string                 `json:"publicPredecessorVersion,omitempty"`
	Target                   model.Generation       `json:"target"`
	TargetStateSchemas       map[string]uint32      `json:"targetStateSchemas"`
	TargetCapabilities       model.CapabilityRanges `json:"targetCapabilities"`
	Previous                 *model.Generation      `json:"previous,omitempty"`
	ManifestDigest           string                 `json:"manifestDigest"`
	StateInventoryDigest     string                 `json:"stateInventoryDigest"`
	MigrationPlanDigest      string                 `json:"migrationPlanDigest"`
	SignerPlanDigest         string                 `json:"signerPlanDigest"`
	PlatformDigest           string                 `json:"platformDigest"`
	Migrations               []model.Migration      `json:"migrations"`
}

func (transaction transactionV1) envelope() transactionEnvelopeV1 {
	return transactionEnvelopeV1{
		SchemaVersion: transaction.SchemaVersion, ID: transaction.ID, Profile: transaction.Profile,
		PlanAction: transaction.PlanAction, SourceTopology: transaction.SourceTopology,
		PublicPredecessorVersion: transaction.PublicPredecessorVersion,
		Target:                   transaction.Target, TargetStateSchemas: transaction.TargetStateSchemas,
		TargetCapabilities: transaction.TargetCapabilities, Previous: transaction.Previous,
		ManifestDigest: transaction.ManifestDigest, StateInventoryDigest: transaction.StateInventoryDigest,
		MigrationPlanDigest: transaction.MigrationPlanDigest, SignerPlanDigest: transaction.SignerPlanDigest,
		PlatformDigest: transaction.PlatformDigest, Migrations: transaction.Migrations,
	}
}

func decodeStrictV1(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("unexpected trailing schema-one transaction JSON")
		}
		return err
	}
	return nil
}

func (s *Store) terminalLegacyTransactionSet(transactionID string) (bool, error) {
	dir := filepath.Join(s.stateRoot, "transactions", transactionID)
	supervisorData, err := readRegular(filepath.Join(dir, string(AuthoritySupervisor)+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var header struct {
		SchemaVersion uint32 `json:"schemaVersion"`
	}
	if err := json.Unmarshal(supervisorData, &header); err != nil || header.SchemaVersion != 1 {
		return false, nil
	}
	var supervisor transactionV1
	if err := decodeStrictV1(supervisorData, &supervisor); err != nil {
		return false, fmt.Errorf("schema-one supervisor journal is invalid: %w", err)
	}
	targetData, err := readRegular(filepath.Join(dir, string(AuthorityTargetController)+".json"))
	if err != nil {
		return false, fmt.Errorf("schema-one target journal is unavailable: %w", err)
	}
	var target transactionV1
	if err := decodeStrictV1(targetData, &target); err != nil {
		return false, fmt.Errorf("schema-one target journal is invalid: %w", err)
	}
	envelopeData, err := readRegular(filepath.Join(dir, "envelope.json"))
	if err != nil {
		return false, fmt.Errorf("schema-one transaction envelope is unavailable: %w", err)
	}
	var envelope transactionEnvelopeV1
	if err := decodeStrictV1(envelopeData, &envelope); err != nil {
		return false, fmt.Errorf("schema-one transaction envelope is invalid: %w", err)
	}
	if err := validateTerminalTransactionV1(transactionID, supervisor); err != nil {
		return false, err
	}
	if err := validateTerminalTransactionV1(transactionID, target); err != nil {
		return false, err
	}
	if supervisor.Phase != target.Phase || !reflect.DeepEqual(supervisor.envelope(), target.envelope()) || !reflect.DeepEqual(supervisor.envelope(), envelope) {
		return false, errors.New("schema-one terminal transaction authorities or envelope differ")
	}
	return true, nil
}

func validateTerminalTransactionV1(transactionID string, transaction transactionV1) error {
	if transaction.SchemaVersion != 1 || transaction.ID != transactionID || transaction.Revision == 0 ||
		(transaction.Phase != model.PhaseCommitted && transaction.Phase != model.PhaseRolledBack) {
		return errors.New("schema-one transaction is unfinished or has an invalid identity")
	}
	if transaction.Profile != model.ProfileProtectedLocal && transaction.Profile != model.ProfileHosting {
		return errors.New("schema-one transaction profile is invalid")
	}
	if transaction.PlanAction != "INSTALL" && transaction.PlanAction != "BRIDGE_PUBLIC_STABLE" && transaction.PlanAction != "UPDATE" {
		return errors.New("schema-one transaction action is invalid")
	}
	if err := transaction.Target.Validate(); err != nil {
		return fmt.Errorf("schema-one target: %w", err)
	}
	if transaction.Previous != nil {
		if err := transaction.Previous.Validate(); err != nil || transaction.Previous.ID == transaction.Target.ID {
			return errors.New("schema-one previous generation is invalid")
		}
	}
	if len(transaction.TargetStateSchemas) == 0 || transaction.TargetCapabilities.Validate() != nil {
		return errors.New("schema-one target state or capability inventory is invalid")
	}
	for name, version := range transaction.TargetStateSchemas {
		if name == "" || version == 0 {
			return errors.New("schema-one target state inventory is invalid")
		}
	}
	for _, digest := range []string{transaction.ManifestDigest, transaction.StateInventoryDigest, transaction.MigrationPlanDigest, transaction.SignerPlanDigest, transaction.PlatformDigest} {
		if !validSHA256Digest(digest) {
			return errors.New("schema-one transaction digest is invalid")
		}
	}
	return nil
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
	pluginVerified := false
	manifestCommitted := false
	terminalConvergenceVerified := false
	for _, event := range record.Events {
		if event.Step == ProgressPluginVerified {
			pluginVerified = true
		}
		if (event.Step == ProgressPlatformVerified || event.Step == ProgressManifestCommitted) &&
			(transaction.PlanAction != "INSTALL" || transaction.Previous != nil) && !pluginVerified {
			return errors.New("platform verification precedes mandatory plugin readiness")
		}
		if event.Step == ProgressManifestCommitted {
			manifestCommitted = true
		}
		if event.Step == ProgressTerminalConvergenceVerified {
			if !manifestCommitted {
				return errors.New("terminal convergence precedes committed manifest")
			}
			terminalConvergenceVerified = true
		}
		if event.Step == ProgressPlatformFinalized && !terminalConvergenceVerified {
			return errors.New("platform finalization precedes terminal convergence")
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
		if receipt.Participant == "plugin" {
			wantPlan = transaction.Target.ID
		}
		if receipt.Participant == "convergence" {
			wantPlan = transaction.PlatformDigest
		}
		if (receipt.Participant != "migrator" && receipt.Participant != "signer" && receipt.Participant != "state" && receipt.Participant != "plugin" && receipt.Participant != "convergence") || receipt.TransactionID != transaction.ID || receipt.TargetGenerationID != transaction.Target.ID || receipt.StateInventoryDigest != transaction.StateInventoryDigest || receipt.PlanDigest != wantPlan {
			return errors.New("participant receipt differs from the immutable transaction")
		}
		if receipt.Participant == "plugin" || receipt.Participant == "convergence" || receipt.Participant == "state" && receipt.EvidenceDigest != "" {
			if !validSHA256Digest(receipt.EvidenceDigest) {
				return errors.New("participant evidence digest is invalid")
			}
		} else if receipt.EvidenceDigest != "" {
			return errors.New("non-plugin receipt contains plugin readiness evidence")
		}
		if receipt.Participant == "state" {
			wantMembers := map[string]bool{"application-state": true, "configuration": true, "wallet": true, "mining": true, "federation": true, "plugin-data": true, "signer": true}
			if len(receipt.Members) != len(wantMembers) {
				return errors.New("state receipt does not cover every typed participant")
			}
			previous := ""
			for _, member := range receipt.Members {
				if !wantMembers[member.Participant] || member.Participant <= previous || !validSHA256Digest(member.Digest) {
					return errors.New("state receipt member binding is invalid")
				}
				previous = member.Participant
			}
		} else if len(receipt.Members) != 0 {
			return errors.New("non-state receipt contains state participant members")
		}
	}
	if event.Step == ProgressPluginVerified {
		if event.Receipt == nil || event.Receipt.Participant != "plugin" {
			return errors.New("plugin verification step lacks its readiness receipt")
		}
	} else if event.Receipt != nil && event.Receipt.Participant == "plugin" {
		return errors.New("plugin readiness receipt is attached to the wrong progress step")
	}
	if event.Step == ProgressTerminalConvergenceVerified {
		if event.Receipt == nil || event.Receipt.Participant != "convergence" {
			return errors.New("terminal convergence step lacks its durable receipt")
		}
	} else if event.Receipt != nil && event.Receipt.Participant == "convergence" {
		return errors.New("terminal convergence receipt is attached to the wrong progress step")
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
		ProgressSignerVerified, ProgressPluginVerified, ProgressPlatformVerified, ProgressMigratorCommitted, ProgressSignerCommitted,
		ProgressPlatformCommitted, ProgressManifestCommitted, ProgressRollbackStarted, ProgressTargetStopped,
		ProgressTerminalConvergenceVerified, ProgressPlatformFinalized,
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
