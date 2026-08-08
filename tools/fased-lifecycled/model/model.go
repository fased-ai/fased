// Package model defines the durable, version-neutral lifecycle contract.
// It is intentionally pure: it does not access files, services, processes, or the network.
package model

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
)

const (
	CurrentManifestSchemaVersion    uint32 = 1
	CurrentTransactionSchemaVersion uint32 = 1
)

type Profile string

const (
	ProfileProtectedLocal Profile = "protected-local"
	ProfileHosting        Profile = "hosting"
)

type Phase string

const (
	PhaseIdle       Phase = "IDLE"
	PhaseStaged     Phase = "STAGED"
	PhasePrepared   Phase = "PREPARED"
	PhaseSwitched   Phase = "SWITCHED"
	PhaseVerified   Phase = "VERIFIED"
	PhaseCommitted  Phase = "COMMITTED"
	PhaseRolledBack Phase = "ROLLED_BACK"
)

type RecoveryAction string

const (
	RecoveryNoop            RecoveryAction = "NOOP"
	RecoveryDiscardStaged   RecoveryAction = "DISCARD_STAGED"
	RecoveryAbortPrepared   RecoveryAction = "ABORT_PREPARED"
	RecoveryRestorePrevious RecoveryAction = "RESTORE_PREVIOUS"
	RecoveryCompleteCommit  RecoveryAction = "COMPLETE_COMMIT"
	RecoveryAlreadyCurrent  RecoveryAction = "ALREADY_CURRENT"
	RecoveryRetryAllowed    RecoveryAction = "RETRY_ALLOWED"
)

type Generation struct {
	ID                string `json:"id"`
	Version           string `json:"version"`
	Commit            string `json:"commit"`
	Tree              string `json:"tree"`
	ArtifactSetDigest string `json:"artifactSetDigest"`
}

type CapabilityRange struct {
	Min uint32 `json:"min"`
	Max uint32 `json:"max"`
}

type CapabilityRanges struct {
	Supervisor CapabilityRange `json:"supervisor"`
	Controller CapabilityRange `json:"controller"`
	Migrator   CapabilityRange `json:"migrator"`
	Signer     CapabilityRange `json:"signer"`
}

type Manifest struct {
	SchemaVersion      uint32            `json:"schemaVersion"`
	Profile            Profile           `json:"profile"`
	ActiveGeneration   *Generation       `json:"activeGeneration,omitempty"`
	PreviousGeneration *Generation       `json:"previousGeneration,omitempty"`
	StateSchemas       map[string]uint32 `json:"stateSchemas"`
	Capabilities       CapabilityRanges  `json:"capabilities"`
}

type Transaction struct {
	SchemaVersion        uint32      `json:"schemaVersion"`
	ID                   string      `json:"transactionId"`
	Profile              Profile     `json:"profile"`
	Phase                Phase       `json:"phase"`
	Revision             uint64      `json:"revision"`
	Target               Generation  `json:"target"`
	Previous             *Generation `json:"previous,omitempty"`
	ManifestDigest       string      `json:"manifestDigest"`
	StateInventoryDigest string      `json:"stateInventoryDigest"`
}

type RecoveryDecision struct {
	Action RecoveryAction
	Result Phase
}

var (
	digestPattern        = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	gitObjectPattern     = regexp.MustCompile(`^[0-9a-f]{40}$`)
	versionPattern       = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$`)
	transactionIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	stateSchemaPattern   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]{0,63}$`)
)

func (g Generation) Validate() error {
	if !digestPattern.MatchString(g.ID) {
		return errors.New("generation id must be a lowercase sha256 digest")
	}
	if !versionPattern.MatchString(g.Version) {
		return errors.New("generation version must be a semantic version without a v prefix")
	}
	if !gitObjectPattern.MatchString(g.Commit) {
		return errors.New("generation commit must be a full lowercase Git object id")
	}
	if !gitObjectPattern.MatchString(g.Tree) {
		return errors.New("generation tree must be a full lowercase Git object id")
	}
	if !digestPattern.MatchString(g.ArtifactSetDigest) {
		return errors.New("generation artifact set must be a lowercase sha256 digest")
	}
	return nil
}

func (r CapabilityRange) validate(name string) error {
	if r.Min == 0 || r.Max == 0 {
		return fmt.Errorf("%s capability range must be nonzero", name)
	}
	if r.Min > r.Max {
		return fmt.Errorf("%s capability range is inverted", name)
	}
	return nil
}

func (r CapabilityRanges) Validate() error {
	for name, value := range map[string]CapabilityRange{
		"supervisor": r.Supervisor,
		"controller": r.Controller,
		"migrator":   r.Migrator,
		"signer":     r.Signer,
	} {
		if err := value.validate(name); err != nil {
			return err
		}
	}
	return nil
}

func validateProfile(profile Profile) error {
	switch profile {
	case ProfileProtectedLocal, ProfileHosting:
		return nil
	default:
		return fmt.Errorf("unsupported installation profile %q", profile)
	}
}

func (m Manifest) Validate() error {
	if m.SchemaVersion > CurrentManifestSchemaVersion {
		return fmt.Errorf("manifest schema %d is newer than supported schema %d", m.SchemaVersion, CurrentManifestSchemaVersion)
	}
	if m.SchemaVersion != CurrentManifestSchemaVersion {
		return fmt.Errorf("unsupported manifest schema %d", m.SchemaVersion)
	}
	if err := validateProfile(m.Profile); err != nil {
		return err
	}
	if m.ActiveGeneration == nil && m.PreviousGeneration != nil {
		return errors.New("previous generation requires an active generation")
	}
	if m.ActiveGeneration != nil {
		if err := m.ActiveGeneration.Validate(); err != nil {
			return fmt.Errorf("active generation: %w", err)
		}
	}
	if m.PreviousGeneration != nil {
		if err := m.PreviousGeneration.Validate(); err != nil {
			return fmt.Errorf("previous generation: %w", err)
		}
		if m.ActiveGeneration.ID == m.PreviousGeneration.ID {
			return errors.New("active and previous generations must differ")
		}
	}
	if len(m.StateSchemas) == 0 {
		return errors.New("state schema inventory must not be empty")
	}
	for name, version := range m.StateSchemas {
		if !stateSchemaPattern.MatchString(name) {
			return fmt.Errorf("invalid state schema name %q", name)
		}
		if version == 0 {
			return fmt.Errorf("state schema %q must be nonzero", name)
		}
	}
	return m.Capabilities.Validate()
}

func (t Transaction) Validate() error {
	if t.SchemaVersion > CurrentTransactionSchemaVersion {
		return fmt.Errorf("transaction schema %d is newer than supported schema %d", t.SchemaVersion, CurrentTransactionSchemaVersion)
	}
	if t.SchemaVersion != CurrentTransactionSchemaVersion {
		return fmt.Errorf("unsupported transaction schema %d", t.SchemaVersion)
	}
	if !transactionIDPattern.MatchString(t.ID) {
		return errors.New("transaction id must be a lowercase UUID")
	}
	if err := validateProfile(t.Profile); err != nil {
		return err
	}
	if !validPhase(t.Phase) {
		return fmt.Errorf("unsupported transaction phase %q", t.Phase)
	}
	if t.Revision == 0 {
		return errors.New("transaction revision must be nonzero")
	}
	if err := t.Target.Validate(); err != nil {
		return fmt.Errorf("target generation: %w", err)
	}
	if t.Previous != nil {
		if err := t.Previous.Validate(); err != nil {
			return fmt.Errorf("previous generation: %w", err)
		}
		if t.Previous.ID == t.Target.ID {
			return errors.New("target and previous generations must differ")
		}
	}
	if !digestPattern.MatchString(t.ManifestDigest) {
		return errors.New("manifest binding must be a lowercase sha256 digest")
	}
	if !digestPattern.MatchString(t.StateInventoryDigest) {
		return errors.New("state inventory binding must be a lowercase sha256 digest")
	}
	return nil
}

func validPhase(phase Phase) bool {
	switch phase {
	case PhaseIdle, PhaseStaged, PhasePrepared, PhaseSwitched, PhaseVerified, PhaseCommitted, PhaseRolledBack:
		return true
	default:
		return false
	}
}

func Advance(tx Transaction, next Phase) (Transaction, error) {
	if err := tx.Validate(); err != nil {
		return Transaction{}, err
	}
	if !validPhase(next) {
		return Transaction{}, fmt.Errorf("unsupported target phase %q", next)
	}
	if tx.Phase == next {
		return tx, nil
	}
	if !legalTransition(tx.Phase, next) {
		return Transaction{}, fmt.Errorf("illegal lifecycle transition %s -> %s", tx.Phase, next)
	}
	tx.Phase = next
	tx.Revision++
	return tx, nil
}

func legalTransition(from, to Phase) bool {
	switch from {
	case PhaseIdle:
		return to == PhaseStaged
	case PhaseStaged:
		return to == PhasePrepared || to == PhaseRolledBack
	case PhasePrepared:
		return to == PhaseSwitched || to == PhaseRolledBack
	case PhaseSwitched:
		return to == PhaseVerified || to == PhaseRolledBack
	case PhaseVerified:
		return to == PhaseCommitted
	default:
		return false
	}
}

func Recover(tx Transaction) (RecoveryDecision, error) {
	if err := tx.Validate(); err != nil {
		return RecoveryDecision{}, err
	}
	switch tx.Phase {
	case PhaseIdle:
		return RecoveryDecision{Action: RecoveryNoop, Result: PhaseIdle}, nil
	case PhaseStaged:
		return RecoveryDecision{Action: RecoveryDiscardStaged, Result: PhaseRolledBack}, nil
	case PhasePrepared:
		return RecoveryDecision{Action: RecoveryAbortPrepared, Result: PhaseRolledBack}, nil
	case PhaseSwitched:
		return RecoveryDecision{Action: RecoveryRestorePrevious, Result: PhaseRolledBack}, nil
	case PhaseVerified:
		return RecoveryDecision{Action: RecoveryCompleteCommit, Result: PhaseCommitted}, nil
	case PhaseCommitted:
		return RecoveryDecision{Action: RecoveryAlreadyCurrent, Result: PhaseCommitted}, nil
	case PhaseRolledBack:
		return RecoveryDecision{Action: RecoveryRetryAllowed, Result: PhaseRolledBack}, nil
	default:
		return RecoveryDecision{}, fmt.Errorf("unsupported transaction phase %q", tx.Phase)
	}
}

func DecodeManifest(reader io.Reader) (Manifest, error) {
	var manifest Manifest
	if err := decodeStrict(reader, &manifest); err != nil {
		return Manifest{}, err
	}
	if err := manifest.Validate(); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func DecodeTransaction(reader io.Reader) (Transaction, error) {
	var transaction Transaction
	if err := decodeStrict(reader, &transaction); err != nil {
		return Transaction{}, err
	}
	if err := transaction.Validate(); err != nil {
		return Transaction{}, err
	}
	return transaction, nil
}

func CanonicalManifestJSON(manifest Manifest) ([]byte, error) {
	if err := manifest.Validate(); err != nil {
		return nil, err
	}
	return json.Marshal(manifest)
}

func CanonicalTransactionJSON(transaction Transaction) ([]byte, error) {
	if err := transaction.Validate(); err != nil {
		return nil, err
	}
	return json.Marshal(transaction)
}

func decodeStrict(reader io.Reader, target any) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("unexpected trailing JSON value")
		}
		return err
	}
	return nil
}
