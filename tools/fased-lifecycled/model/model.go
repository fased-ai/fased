// Package model defines the durable, version-neutral lifecycle contract.
// It is intentionally pure: it does not access files, services, processes, or the network.
package model

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"time"
)

const (
	CurrentManifestSchemaVersion       uint32 = 2
	CurrentTransactionSchemaVersion    uint32 = 2
	RollbackAuthorizationSchemaVersion uint32 = 1
	MaxRollbackAuthorizationLifetime          = 10 * time.Minute
)

// CurrentStateSchemas is the single declared preservation contract shared by
// inventory generation, planning, migration selection, and runtime binding.
// Callers receive a copy so no component can mutate global policy.
func CurrentStateSchemas() map[string]uint32 {
	return map[string]uint32{
		"agents": 1, "channels": 1, "configuration": 1, "credentials": 1,
		"cron": 1, "deliveryQueue": 1, "devices": 1, "federation": 2,
		"identity": 1, "managedInstall": 2, "memory": 1, "mining": 1,
		"pluginState": 1, "schedules": 1, "secrets": 1, "sessions": 1,
		"signer": 2, "tasks": 1, "walletRegistry": 1,
	}
}

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
	ReleaseSequence    uint64            `json:"releaseSequence"`
	SecurityEpoch      uint64            `json:"securityEpoch"`
}

type manifestSchemaOne struct {
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
	SchemaVersion               uint32            `json:"schemaVersion"`
	ID                          string            `json:"transactionId"`
	Profile                     Profile           `json:"profile"`
	PlanAction                  string            `json:"planAction"`
	SourceTopology              string            `json:"sourceTopology,omitempty"`
	PublicPredecessorVersion    string            `json:"publicPredecessorVersion,omitempty"`
	ReleaseSequence             uint64            `json:"releaseSequence"`
	SecurityEpoch               uint64            `json:"securityEpoch"`
	ReleaseIndexDigest          string            `json:"releaseIndexDigest"`
	ReleaseAuthorityDigest      string            `json:"releaseAuthorityDigest"`
	TargetManifestProtocolMin   uint32            `json:"targetManifestProtocolMin"`
	TargetManifestProtocolMax   uint32            `json:"targetManifestProtocolMax"`
	PredecessorManifestSchema   uint32            `json:"predecessorManifestSchema,omitempty"`
	PredecessorPlatform         *PlatformIdentity `json:"predecessorPlatform,omitempty"`
	RollbackAuthorizationDigest string            `json:"rollbackAuthorizationDigest,omitempty"`
	Phase                       Phase             `json:"phase"`
	Revision                    uint64            `json:"revision"`
	Target                      Generation        `json:"target"`
	TargetStateSchemas          map[string]uint32 `json:"targetStateSchemas"`
	TargetCapabilities          CapabilityRanges  `json:"targetCapabilities"`
	Previous                    *Generation       `json:"previous,omitempty"`
	ManifestDigest              string            `json:"manifestDigest"`
	StateInventoryDigest        string            `json:"stateInventoryDigest"`
	MigrationPlanDigest         string            `json:"migrationPlanDigest"`
	SignerPlanDigest            string            `json:"signerPlanDigest"`
	PlatformDigest              string            `json:"platformDigest"`
	Migrations                  []Migration       `json:"migrations"`
}

// TransactionEnvelope contains the immutable identity shared by the
// supervisor and target-controller journals. Authority records may advance
// independently, but they cannot disagree about what is being installed or
// which state, signer, platform, and rollback generation are bound to it.
type TransactionEnvelope struct {
	SchemaVersion               uint32            `json:"schemaVersion"`
	ID                          string            `json:"transactionId"`
	Profile                     Profile           `json:"profile"`
	PlanAction                  string            `json:"planAction"`
	SourceTopology              string            `json:"sourceTopology,omitempty"`
	PublicPredecessorVersion    string            `json:"publicPredecessorVersion,omitempty"`
	ReleaseSequence             uint64            `json:"releaseSequence"`
	SecurityEpoch               uint64            `json:"securityEpoch"`
	ReleaseIndexDigest          string            `json:"releaseIndexDigest"`
	ReleaseAuthorityDigest      string            `json:"releaseAuthorityDigest"`
	TargetManifestProtocolMin   uint32            `json:"targetManifestProtocolMin"`
	TargetManifestProtocolMax   uint32            `json:"targetManifestProtocolMax"`
	PredecessorManifestSchema   uint32            `json:"predecessorManifestSchema,omitempty"`
	PredecessorPlatform         *PlatformIdentity `json:"predecessorPlatform,omitempty"`
	RollbackAuthorizationDigest string            `json:"rollbackAuthorizationDigest,omitempty"`
	Target                      Generation        `json:"target"`
	TargetStateSchemas          map[string]uint32 `json:"targetStateSchemas"`
	TargetCapabilities          CapabilityRanges  `json:"targetCapabilities"`
	Previous                    *Generation       `json:"previous,omitempty"`
	ManifestDigest              string            `json:"manifestDigest"`
	StateInventoryDigest        string            `json:"stateInventoryDigest"`
	MigrationPlanDigest         string            `json:"migrationPlanDigest"`
	SignerPlanDigest            string            `json:"signerPlanDigest"`
	PlatformDigest              string            `json:"platformDigest"`
	Migrations                  []Migration       `json:"migrations"`
}

// RollbackAuthorization is verified trust evidence, not compatibility policy.
// The planner may select an older sequence only when every field matches the
// current and target identities and the bounded authorization is still live.
type RollbackAuthorization struct {
	SchemaVersion          uint32 `json:"schemaVersion"`
	CurrentGenerationID    string `json:"currentGenerationId"`
	TargetGenerationID     string `json:"targetGenerationId"`
	CurrentReleaseSequence uint64 `json:"currentReleaseSequence"`
	TargetReleaseSequence  uint64 `json:"targetReleaseSequence"`
	SecurityEpoch          uint64 `json:"securityEpoch"`
	Operator               string `json:"operator"`
	Reason                 string `json:"reason"`
	IssuedAt               string `json:"issuedAt"`
	ExpiresAt              string `json:"expiresAt"`
	EnvelopeDigest         string `json:"envelopeDigest"`
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
	operatorPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$`)
)

func (authorization RollbackAuthorization) ValidateAt(now time.Time) error {
	if authorization.SchemaVersion != RollbackAuthorizationSchemaVersion {
		return fmt.Errorf("unsupported rollback authorization schema %d", authorization.SchemaVersion)
	}
	if !digestPattern.MatchString(authorization.CurrentGenerationID) || !digestPattern.MatchString(authorization.TargetGenerationID) || authorization.CurrentGenerationID == authorization.TargetGenerationID {
		return errors.New("rollback authorization generation binding is invalid")
	}
	if authorization.CurrentReleaseSequence == 0 || authorization.TargetReleaseSequence == 0 || authorization.TargetReleaseSequence >= authorization.CurrentReleaseSequence {
		return errors.New("rollback authorization sequence binding is not a downgrade")
	}
	if authorization.SecurityEpoch == 0 {
		return errors.New("rollback authorization security epoch must be nonzero")
	}
	if !operatorPattern.MatchString(authorization.Operator) || len(authorization.Reason) < 8 || len(authorization.Reason) > 256 {
		return errors.New("rollback authorization operator or reason is invalid")
	}
	issuedAt, err := time.Parse(time.RFC3339, authorization.IssuedAt)
	if err != nil || issuedAt.Format(time.RFC3339) != authorization.IssuedAt {
		return errors.New("rollback authorization issuedAt is not canonical UTC RFC3339")
	}
	expiresAt, err := time.Parse(time.RFC3339, authorization.ExpiresAt)
	if err != nil || expiresAt.Format(time.RFC3339) != authorization.ExpiresAt {
		return errors.New("rollback authorization expiresAt is not canonical UTC RFC3339")
	}
	if !expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > MaxRollbackAuthorizationLifetime || now.Before(issuedAt) || !now.Before(expiresAt) {
		return errors.New("rollback authorization is expired, premature, or exceeds its lifetime")
	}
	if !digestPattern.MatchString(authorization.EnvelopeDigest) {
		return errors.New("rollback authorization envelope digest is invalid")
	}
	return nil
}

func (p PlatformIdentity) Validate(profile Profile) error {
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
	legacy := p.Adapter == legacyPlatformAdapter(profile)
	if p.Adapter != expected.Adapter && !legacy {
		return fmt.Errorf("platform adapter %q is unsupported for profile %q", p.Adapter, profile)
	}
	if legacy {
		expected, err = LegacyControllerPlatformIdentity(profile, p.InstanceID, p.ConfigurationDigest)
		if err != nil {
			return err
		}
	}
	required := []string{"gateway", "signer", "supervisor"}
	if legacy {
		required = append(required, "controller")
	}
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
	return platformIdentity(profile, instanceID, configurationDigest, false)
}

// LegacyControllerPlatformIdentity exists only to decode and inspect the v1
// controller-worker topology during bridge discovery. New installations and
// transactions must use NewPlatformIdentity's three-service topology.
func LegacyControllerPlatformIdentity(profile Profile, instanceID, configurationDigest string) (PlatformIdentity, error) {
	return platformIdentity(profile, instanceID, configurationDigest, true)
}

func (p PlatformIdentity) IsLegacyControllerWorker(profile Profile) bool {
	return p.Adapter == legacyPlatformAdapter(profile) && p.Validate(profile) == nil
}

func platformIdentity(profile Profile, instanceID, configurationDigest string, legacy bool) (PlatformIdentity, error) {
	if err := validateProfile(profile); err != nil {
		return PlatformIdentity{}, err
	}
	if !instanceIDPattern.MatchString(instanceID) {
		return PlatformIdentity{}, errors.New("platform instance id is invalid")
	}
	if !digestPattern.MatchString(configurationDigest) {
		return PlatformIdentity{}, errors.New("platform configuration must be a lowercase sha256 digest")
	}
	adapter := "linux-systemd-local-v2"
	services := map[string]string{
		"gateway":    fmt.Sprintf("fased-gateway-%s.service", instanceID),
		"signer":     fmt.Sprintf("fased-signerd-%s.service", instanceID),
		"supervisor": fmt.Sprintf("fased-local-controller-%s.service", instanceID),
	}
	if profile == ProfileHosting {
		adapter = "linux-systemd-hosting-v2"
		services = map[string]string{
			"gateway": "fased-gateway.service",
			"signer":  "fased-signerd.service", "supervisor": "fased-host-updater.service",
		}
	}
	if legacy {
		adapter = legacyPlatformAdapter(profile)
		if profile == ProfileProtectedLocal {
			services["controller"] = fmt.Sprintf("fased-local-controller-worker-%s.service", instanceID)
		} else {
			services["controller"] = "fased-host-controller.service"
		}
	}
	return PlatformIdentity{Adapter: adapter, InstanceID: instanceID, ConfigurationDigest: configurationDigest, Services: services}, nil
}

func legacyPlatformAdapter(profile Profile) string {
	if profile == ProfileHosting {
		return "linux-systemd-hosting-v1"
	}
	return "linux-systemd-local-v1"
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
	if err := ValidateVersion(g.Version); err != nil {
		return fmt.Errorf("generation %w", err)
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

func ValidateVersion(version string) error {
	if !versionPattern.MatchString(version) {
		return errors.New("version must be a semantic version without a v prefix")
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
	if err := m.validateInstalledBase(); err != nil {
		return err
	}
	if m.ReleaseSequence == 0 || m.SecurityEpoch == 0 {
		return errors.New("manifest release sequence and security epoch must be nonzero")
	}
	return nil
}

// ValidateInstalled accepts every explicitly supported durable manifest
// schema. Schema one predates monotonic release authority; that authority is
// supplied only by the verified schema-two target and is never synthesized
// into the predecessor record.
func (m Manifest) ValidateInstalled() error {
	switch m.SchemaVersion {
	case 1:
		if m.ReleaseSequence != 0 || m.SecurityEpoch != 0 {
			return errors.New("manifest schema one cannot contain release authority")
		}
		return m.validateInstalledBase()
	case CurrentManifestSchemaVersion:
		return m.Validate()
	default:
		if m.SchemaVersion > CurrentManifestSchemaVersion {
			return fmt.Errorf("manifest schema %d is newer than supported schema %d", m.SchemaVersion, CurrentManifestSchemaVersion)
		}
		return fmt.Errorf("unsupported manifest schema %d", m.SchemaVersion)
	}
}

func (m Manifest) validateInstalledBase() error {
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
	if t.ReleaseSequence == 0 || t.SecurityEpoch == 0 {
		return errors.New("transaction release sequence and security epoch must be nonzero")
	}
	if !digestPattern.MatchString(t.ReleaseIndexDigest) || !digestPattern.MatchString(t.ReleaseAuthorityDigest) {
		return errors.New("transaction release authority binding is invalid")
	}
	if t.TargetManifestProtocolMin == 0 || t.TargetManifestProtocolMax < t.TargetManifestProtocolMin ||
		CurrentManifestSchemaVersion < t.TargetManifestProtocolMin || CurrentManifestSchemaVersion > t.TargetManifestProtocolMax {
		return errors.New("transaction target manifest protocol range is invalid")
	}
	switch t.PlanAction {
	case "INSTALL", "UPDATE":
		if t.SourceTopology != "" || t.PublicPredecessorVersion != "" {
			return errors.New("non-bridge transaction contains public predecessor evidence")
		}
	case "BRIDGE_PUBLIC_STABLE":
		if !platformNamePattern.MatchString(t.SourceTopology) {
			return errors.New("public-stable transaction source topology is invalid")
		}
		if err := ValidateVersion(t.PublicPredecessorVersion); err != nil {
			return fmt.Errorf("public-stable predecessor version: %w", err)
		}
	case "ROLLBACK":
		if t.SourceTopology != "" || t.PublicPredecessorVersion != "" || !digestPattern.MatchString(t.RollbackAuthorizationDigest) {
			return errors.New("rollback transaction authorization binding is invalid")
		}
	default:
		return errors.New("transaction plan action is not mutable")
	}
	if t.PlanAction != "ROLLBACK" && t.RollbackAuthorizationDigest != "" {
		return errors.New("non-rollback transaction contains rollback authorization")
	}
	absent := "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	switch t.PlanAction {
	case "INSTALL":
		if t.Previous != nil || t.ManifestDigest != absent || t.PredecessorManifestSchema != 0 || t.PredecessorPlatform != nil {
			return errors.New("fresh installation transaction has predecessor state")
		}
	case "BRIDGE_PUBLIC_STABLE":
		if t.Previous != nil || t.ManifestDigest != absent || t.PredecessorManifestSchema != 0 || t.PredecessorPlatform != nil {
			return errors.New("public-stable bridge has canonical predecessor state")
		}
	case "UPDATE", "ROLLBACK":
		if t.Previous == nil || t.ManifestDigest == absent || t.PredecessorManifestSchema == 0 || t.PredecessorManifestSchema > CurrentManifestSchemaVersion || t.PredecessorPlatform == nil {
			return errors.New("managed update is missing its canonical predecessor")
		}
		if err := t.PredecessorPlatform.Validate(t.Profile); err != nil {
			return fmt.Errorf("managed predecessor platform: %w", err)
		}
		if t.PredecessorManifestSchema < t.TargetManifestProtocolMin || t.PredecessorManifestSchema > t.TargetManifestProtocolMax {
			return errors.New("target lifecycle host does not support the predecessor manifest schema")
		}
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
		PlanAction: t.PlanAction, SourceTopology: t.SourceTopology, PublicPredecessorVersion: t.PublicPredecessorVersion,
		ReleaseSequence: t.ReleaseSequence, SecurityEpoch: t.SecurityEpoch, RollbackAuthorizationDigest: t.RollbackAuthorizationDigest,
		ReleaseIndexDigest: t.ReleaseIndexDigest, ReleaseAuthorityDigest: t.ReleaseAuthorityDigest,
		TargetManifestProtocolMin: t.TargetManifestProtocolMin, TargetManifestProtocolMax: t.TargetManifestProtocolMax,
		PredecessorManifestSchema: t.PredecessorManifestSchema,
		PredecessorPlatform:       t.PredecessorPlatform,
		Target:                    t.Target, TargetStateSchemas: t.TargetStateSchemas,
		TargetCapabilities: t.TargetCapabilities, Previous: t.Previous,
		ManifestDigest: t.ManifestDigest, StateInventoryDigest: t.StateInventoryDigest,
		MigrationPlanDigest: t.MigrationPlanDigest, SignerPlanDigest: t.SignerPlanDigest,
		PlatformDigest: t.PlatformDigest, Migrations: t.Migrations,
	}, nil
}

func (e TransactionEnvelope) Validate() error {
	probe := Transaction{
		SchemaVersion: e.SchemaVersion, ID: e.ID, Profile: e.Profile,
		PlanAction: e.PlanAction, SourceTopology: e.SourceTopology, PublicPredecessorVersion: e.PublicPredecessorVersion,
		ReleaseSequence: e.ReleaseSequence, SecurityEpoch: e.SecurityEpoch, RollbackAuthorizationDigest: e.RollbackAuthorizationDigest,
		ReleaseIndexDigest: e.ReleaseIndexDigest, ReleaseAuthorityDigest: e.ReleaseAuthorityDigest,
		TargetManifestProtocolMin: e.TargetManifestProtocolMin, TargetManifestProtocolMax: e.TargetManifestProtocolMax,
		PredecessorManifestSchema: e.PredecessorManifestSchema,
		PredecessorPlatform:       e.PredecessorPlatform,
		Phase:                     PhaseIdle, Revision: 1, Target: e.Target,
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
		return to == PhaseStaged || to == PhaseRolledBack
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
		return RecoveryDecision{Action: RecoveryDiscardStaged, Result: PhaseRolledBack}, nil
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

// DecodeInstalledManifest strictly decodes a durable predecessor without
// rewriting it. Only the explicitly supported schema-one shape and the current
// canonical schema are accepted.
func DecodeInstalledManifest(reader io.Reader) (Manifest, error) {
	data, err := io.ReadAll(reader)
	if err != nil {
		return Manifest{}, err
	}
	var header struct {
		SchemaVersion uint32 `json:"schemaVersion"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return Manifest{}, err
	}
	if header.SchemaVersion != 1 {
		return DecodeManifest(bytes.NewReader(data))
	}
	var legacy manifestSchemaOne
	if err := decodeStrict(bytes.NewReader(data), &legacy); err != nil {
		return Manifest{}, err
	}
	manifest := Manifest{
		SchemaVersion: legacy.SchemaVersion, Profile: legacy.Profile, Platform: legacy.Platform,
		ActiveGeneration: legacy.ActiveGeneration, PreviousGeneration: legacy.PreviousGeneration,
		StateSchemas: legacy.StateSchemas, Capabilities: legacy.Capabilities,
	}
	if err := manifest.ValidateInstalled(); err != nil {
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
