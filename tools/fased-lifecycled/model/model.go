// Package model defines the durable, version-neutral lifecycle contract.
// It is intentionally pure: it does not access files, services, processes, or the network.
package model

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
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
	Platform           PlatformIdentity  `json:"platform"`
	ActiveGeneration   *Generation       `json:"activeGeneration,omitempty"`
	PreviousGeneration *Generation       `json:"previousGeneration,omitempty"`
	StateSchemas       map[string]uint32 `json:"stateSchemas"`
	Capabilities       CapabilityRanges  `json:"capabilities"`
}

type PlatformIdentity struct {
	Adapter             string            `json:"adapter"`
	InstanceID          string            `json:"instanceId"`
	ConfigurationDigest string            `json:"configurationDigest"`
	Services            map[string]string `json:"services"`
}

type Transaction struct {
	SchemaVersion        uint32            `json:"schemaVersion"`
	ID                   string            `json:"transactionId"`
	Profile              Profile           `json:"profile"`
	Phase                Phase             `json:"phase"`
	Revision             uint64            `json:"revision"`
	Target               Generation        `json:"target"`
	TargetStateSchemas   map[string]uint32 `json:"targetStateSchemas"`
	TargetCapabilities   CapabilityRanges  `json:"targetCapabilities"`
	Previous             *Generation       `json:"previous,omitempty"`
	ManifestDigest       string            `json:"manifestDigest"`
	StateInventoryDigest string            `json:"stateInventoryDigest"`
	MigrationPlanDigest  string            `json:"migrationPlanDigest"`
	SignerPlanDigest     string            `json:"signerPlanDigest"`
	PlatformDigest       string            `json:"platformDigest"`
	Migrations           []Migration       `json:"migrations"`
}

// TransactionEnvelope contains the immutable identity shared by the
// supervisor and target-controller journals. Authority records may advance
// independently, but they cannot disagree about what is being installed or
// which state, signer, platform, and rollback generation are bound to it.
type TransactionEnvelope struct {
	SchemaVersion        uint32            `json:"schemaVersion"`
	ID                   string            `json:"transactionId"`
	Profile              Profile           `json:"profile"`
	Target               Generation        `json:"target"`
	TargetStateSchemas   map[string]uint32 `json:"targetStateSchemas"`
	TargetCapabilities   CapabilityRanges  `json:"targetCapabilities"`
	Previous             *Generation       `json:"previous,omitempty"`
	ManifestDigest       string            `json:"manifestDigest"`
	StateInventoryDigest string            `json:"stateInventoryDigest"`
	MigrationPlanDigest  string            `json:"migrationPlanDigest"`
	SignerPlanDigest     string            `json:"signerPlanDigest"`
	PlatformDigest       string            `json:"platformDigest"`
	Migrations           []Migration       `json:"migrations"`
}

type Migration struct {
	State string `json:"state"`
	From  uint32 `json:"from"`
	To    uint32 `json:"to"`
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
	platformNamePattern  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
	instanceIDPattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	serviceNamePattern   = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	unitNamePattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service$`)
)

func (p PlatformIdentity) Validate(profile Profile) error {
	want := "linux-systemd-local-v1"
	if profile == ProfileHosting {
		want = "linux-systemd-hosting-v1"
	}
	if p.Adapter != want || !platformNamePattern.MatchString(p.Adapter) {
		return fmt.Errorf("platform adapter must be %q for profile %q", want, profile)
	}
	if !instanceIDPattern.MatchString(p.InstanceID) {
		return errors.New("platform instance id is invalid")
	}
	if !digestPattern.MatchString(p.ConfigurationDigest) {
		return errors.New("platform configuration must be a lowercase sha256 digest")
	}
	expected, err := NewPlatformIdentity(profile, p.InstanceID, p.ConfigurationDigest)
	if err != nil {
		return err
	}
	required := []string{"controller", "gateway", "signer", "supervisor"}
	if len(p.Services) != len(required) {
		return errors.New("platform services must contain the exact required service set")
	}
	for _, role := range required {
		unit, ok := p.Services[role]
		if !ok || !serviceNamePattern.MatchString(role) || !unitNamePattern.MatchString(unit) || unit != expected.Services[role] {
			return fmt.Errorf("platform service %q is missing or invalid", role)
		}
	}
	return nil
}

func NewPlatformIdentity(profile Profile, instanceID, configurationDigest string) (PlatformIdentity, error) {
	if err := validateProfile(profile); err != nil {
		return PlatformIdentity{}, err
	}
	if !instanceIDPattern.MatchString(instanceID) {
		return PlatformIdentity{}, errors.New("platform instance id is invalid")
	}
	if !digestPattern.MatchString(configurationDigest) {
		return PlatformIdentity{}, errors.New("platform configuration must be a lowercase sha256 digest")
	}
	adapter := "linux-systemd-local-v1"
	services := map[string]string{
		"controller": fmt.Sprintf("fased-local-controller-worker-%s.service", instanceID),
		"gateway":    fmt.Sprintf("fased-gateway-%s.service", instanceID),
		"signer":     fmt.Sprintf("fased-signerd-%s.service", instanceID),
		"supervisor": fmt.Sprintf("fased-local-controller-%s.service", instanceID),
	}
	if profile == ProfileHosting {
		adapter = "linux-systemd-hosting-v1"
		services = map[string]string{
			"controller": "fased-host-controller.service", "gateway": "fased-gateway.service",
			"signer": "fased-signerd.service", "supervisor": "fased-host-updater.service",
		}
	}
	return PlatformIdentity{Adapter: adapter, InstanceID: instanceID, ConfigurationDigest: configurationDigest, Services: services}, nil
}

func (p PlatformIdentity) Digest(profile Profile) (string, error) {
	if err := p.Validate(profile); err != nil {
		return "", err
	}
	roles := make([]string, 0, len(p.Services))
	for role := range p.Services {
		roles = append(roles, role)
	}
	sort.Strings(roles)
	type service struct{ Role, Unit string }
	canonical := struct {
		Adapter, InstanceID, ConfigurationDigest string
		Services                                 []service
	}{Adapter: p.Adapter, InstanceID: p.InstanceID, ConfigurationDigest: p.ConfigurationDigest}
	for _, role := range roles {
		canonical.Services = append(canonical.Services, service{Role: role, Unit: p.Services[role]})
	}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return fmt.Sprintf("sha256:%x", digest), nil
}

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
	if err := m.Platform.Validate(m.Profile); err != nil {
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
	if len(t.TargetStateSchemas) == 0 {
		return errors.New("transaction target state schema inventory must not be empty")
	}
	for name, version := range t.TargetStateSchemas {
		if !stateSchemaPattern.MatchString(name) || version == 0 {
			return fmt.Errorf("transaction target state schema %q is invalid", name)
		}
	}
	if err := t.TargetCapabilities.Validate(); err != nil {
		return fmt.Errorf("transaction target capabilities: %w", err)
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
	if !digestPattern.MatchString(t.MigrationPlanDigest) {
		return errors.New("migration plan binding must be a lowercase sha256 digest")
	}
	if !digestPattern.MatchString(t.SignerPlanDigest) {
		return errors.New("signer plan binding must be a lowercase sha256 digest")
	}
	if !digestPattern.MatchString(t.PlatformDigest) {
		return errors.New("platform binding must be a lowercase sha256 digest")
	}
	previousState := ""
	for _, migration := range t.Migrations {
		if !stateSchemaPattern.MatchString(migration.State) || migration.State <= previousState {
			return errors.New("transaction migrations must use unique sorted state names")
		}
		if migration.To == 0 || migration.From >= migration.To {
			return fmt.Errorf("transaction migration %q is not monotonic", migration.State)
		}
		previousState = migration.State
	}
	return nil
}

func (t Transaction) Envelope() (TransactionEnvelope, error) {
	if err := t.Validate(); err != nil {
		return TransactionEnvelope{}, err
	}
	return TransactionEnvelope{
		SchemaVersion: t.SchemaVersion, ID: t.ID, Profile: t.Profile,
		Target: t.Target, TargetStateSchemas: t.TargetStateSchemas,
		TargetCapabilities: t.TargetCapabilities, Previous: t.Previous,
		ManifestDigest: t.ManifestDigest, StateInventoryDigest: t.StateInventoryDigest,
		MigrationPlanDigest: t.MigrationPlanDigest, SignerPlanDigest: t.SignerPlanDigest,
		PlatformDigest: t.PlatformDigest, Migrations: t.Migrations,
	}, nil
}

func (e TransactionEnvelope) Validate() error {
	probe := Transaction{
		SchemaVersion: e.SchemaVersion, ID: e.ID, Profile: e.Profile,
		Phase: PhaseIdle, Revision: 1, Target: e.Target,
		TargetStateSchemas: e.TargetStateSchemas, TargetCapabilities: e.TargetCapabilities,
		Previous: e.Previous, ManifestDigest: e.ManifestDigest,
		StateInventoryDigest: e.StateInventoryDigest, MigrationPlanDigest: e.MigrationPlanDigest,
		SignerPlanDigest: e.SignerPlanDigest, PlatformDigest: e.PlatformDigest,
		Migrations: e.Migrations,
	}
	return probe.Validate()
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

func DecodeTransactionEnvelope(reader io.Reader) (TransactionEnvelope, error) {
	var envelope TransactionEnvelope
	if err := decodeStrict(reader, &envelope); err != nil {
		return TransactionEnvelope{}, err
	}
	if err := envelope.Validate(); err != nil {
		return TransactionEnvelope{}, err
	}
	return envelope, nil
}

func CanonicalTransactionEnvelopeJSON(envelope TransactionEnvelope) ([]byte, error) {
	if err := envelope.Validate(); err != nil {
		return nil, err
	}
	return json.Marshal(envelope)
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
