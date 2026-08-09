// Package planner selects a lifecycle action from declared schemas and capabilities.
package planner

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"fased-lifecycled/model"
)

type Action string

const (
	ActionInstall            Action = "INSTALL"
	ActionBridgePublicStable Action = "BRIDGE_PUBLIC_STABLE"
	ActionUpdate             Action = "UPDATE"
	ActionAlreadyCurrent     Action = "ALREADY_CURRENT"
	ActionRepairRequired     Action = "REPAIR_REQUIRED"
)

type InstallationKind string

const (
	InstallationEmpty        InstallationKind = "EMPTY"
	InstallationManaged      InstallationKind = "MANAGED"
	InstallationPublicStable InstallationKind = "PUBLIC_STABLE"
	InstallationAmbiguous    InstallationKind = "AMBIGUOUS"
)

// Installation is the verified, version-neutral result of topology discovery.
// Public release names are evidence used by discovery; they are not planner
// branches. A public-stable installation must provide the complete installed
// identity needed to bind a bridge transaction.
type Installation struct {
	Kind         InstallationKind
	Profile      model.Profile
	Manifest     *model.Manifest
	Generation   *model.Generation
	StateSchemas map[string]uint32
	Capabilities model.CapabilityRanges
}

type PublicTopology string

const (
	TopologyLegacyLocalSameUser PublicTopology = "legacy-local-same-user-v0"
	TopologyLocalUserSystemdV1  PublicTopology = "local-user-systemd-v1"
	TopologyLocalUserSystemdV2  PublicTopology = "local-user-systemd-v2"
)

// PublicStableInstallation converts a verified public topology into persisted
// state schemas. The bridge replaces the old control plane, so it does not
// claim protocol capabilities that the pre-supervisor installation never had.
func PublicStableInstallation(profile model.Profile, topology PublicTopology) (Installation, error) {
	if profile != model.ProfileProtectedLocal {
		return Installation{}, errors.New("public-stable Local topology requires the protected-local target profile")
	}
	switch topology {
	case TopologyLegacyLocalSameUser, TopologyLocalUserSystemdV1, TopologyLocalUserSystemdV2:
		return Installation{
			Kind: InstallationPublicStable, Profile: profile,
			StateSchemas: map[string]uint32{
				"federation": 0, "managedInstall": 1, "mining": 1, "signer": 1, "walletRegistry": 1,
			},
		}, nil
	default:
		return Installation{}, fmt.Errorf("unsupported public installation topology %q", topology)
	}
}

type Target struct {
	Profile      model.Profile
	Generation   model.Generation
	StateSchemas map[string]uint32
	Capabilities model.CapabilityRanges
}

type Migration struct {
	State string `json:"state"`
	From  uint32 `json:"from"`
	To    uint32 `json:"to"`
}

type Plan struct {
	Action     Action           `json:"action"`
	Profile    model.Profile    `json:"profile"`
	Target     model.Generation `json:"target"`
	Migrations []Migration      `json:"migrations"`
	Digest     string           `json:"digest"`
}

func Build(installed *model.Manifest, target Target) (Plan, error) {
	kind := InstallationManaged
	if installed == nil {
		kind = InstallationEmpty
	}
	return BuildForInstallation(Installation{Kind: kind, Manifest: installed}, target)
}

func BuildForInstallation(installed Installation, target Target) (Plan, error) {
	if err := validateTarget(target); err != nil {
		return Plan{}, err
	}
	switch installed.Kind {
	case InstallationEmpty:
		if installed.Manifest != nil || installed.Generation != nil {
			return Plan{}, errors.New("empty installation contains managed identity")
		}
		plan := Plan{Action: ActionInstall, Profile: target.Profile, Target: target.Generation}
		plan.Migrations = migrationsFrom(nil, target.StateSchemas)
		return bind(plan)
	case InstallationManaged:
		if installed.Manifest == nil {
			return Plan{}, errors.New("managed installation manifest is missing")
		}
		return buildManaged(*installed.Manifest, target)
	case InstallationPublicStable:
		if installed.Manifest != nil {
			return Plan{}, errors.New("public-stable bridge must not contain a canonical manifest")
		}
		if installed.Generation != nil {
			return Plan{}, errors.New("pre-supervisor public stable must not claim a canonical generation")
		}
		if err := validateInstalledSchemas(installed.Profile, installed.StateSchemas, target); err != nil {
			return Plan{}, err
		}
		return bind(Plan{
			Action:     ActionBridgePublicStable,
			Profile:    target.Profile,
			Target:     target.Generation,
			Migrations: migrationsFrom(installed.StateSchemas, target.StateSchemas),
		})
	case InstallationAmbiguous:
		if installed.Profile != "" && installed.Profile != target.Profile {
			return Plan{}, fmt.Errorf("installation profile %q cannot use target profile %q", installed.Profile, target.Profile)
		}
		return bind(Plan{Action: ActionRepairRequired, Profile: target.Profile, Target: target.Generation})
	default:
		return Plan{}, fmt.Errorf("unsupported installation kind %q", installed.Kind)
	}
}

func buildManaged(installed model.Manifest, target Target) (Plan, error) {
	if err := installed.Validate(); err != nil {
		return Plan{}, fmt.Errorf("installed manifest: %w", err)
	}
	if installed.Profile != target.Profile {
		return Plan{}, fmt.Errorf("installation profile %q cannot use target profile %q", installed.Profile, target.Profile)
	}
	if installed.ActiveGeneration == nil {
		return Plan{}, errors.New("managed installation has no active generation")
	}
	if err := validateInstalledState(installed.Profile, installed.StateSchemas, installed.Capabilities, target); err != nil {
		return Plan{}, err
	}
	migrations := migrationsFrom(installed.StateSchemas, target.StateSchemas)
	if installed.ActiveGeneration.ID == target.Generation.ID {
		if len(migrations) != 0 || installed.Capabilities != target.Capabilities {
			return Plan{}, errors.New("active generation identity conflicts with its declared schemas or capabilities")
		}
		return bind(Plan{Action: ActionAlreadyCurrent, Profile: target.Profile, Target: target.Generation, Migrations: migrations})
	}
	return bind(Plan{Action: ActionUpdate, Profile: target.Profile, Target: target.Generation, Migrations: migrations})
}

func validateInstalledState(profile model.Profile, stateSchemas map[string]uint32, capabilities model.CapabilityRanges, target Target) error {
	if err := validateInstalledSchemas(profile, stateSchemas, target); err != nil {
		return err
	}
	return compatibleCapabilities(capabilities, target.Capabilities)
}

func validateInstalledSchemas(profile model.Profile, stateSchemas map[string]uint32, target Target) error {
	if profile != target.Profile {
		return fmt.Errorf("installation profile %q cannot use target profile %q", profile, target.Profile)
	}
	if len(stateSchemas) == 0 {
		return errors.New("installed state schema inventory must not be empty")
	}
	for state, version := range stateSchemas {
		targetVersion, ok := target.StateSchemas[state]
		if !ok {
			return fmt.Errorf("installed state schema %q has no declared target mapping", state)
		}
		if version > targetVersion {
			return fmt.Errorf("installed state schema %q version %d is newer than target version %d", state, version, targetVersion)
		}
	}
	return nil
}

func validateTarget(target Target) error {
	if err := target.Generation.Validate(); err != nil {
		return fmt.Errorf("target generation: %w", err)
	}
	if len(target.StateSchemas) == 0 {
		return errors.New("target state schema inventory must not be empty")
	}
	for name, version := range target.StateSchemas {
		if name == "" || version == 0 {
			return errors.New("target state schemas require nonempty names and nonzero versions")
		}
	}
	if err := target.Capabilities.Validate(); err != nil {
		return err
	}
	switch target.Profile {
	case model.ProfileProtectedLocal, model.ProfileHosting:
		return nil
	default:
		return fmt.Errorf("unsupported target profile %q", target.Profile)
	}
}

func migrationsFrom(current, target map[string]uint32) []Migration {
	names := make([]string, 0, len(target))
	for name := range target {
		names = append(names, name)
	}
	sort.Strings(names)
	migrations := make([]Migration, 0, len(names))
	for _, name := range names {
		from := current[name]
		if from != target[name] {
			migrations = append(migrations, Migration{State: name, From: from, To: target[name]})
		}
	}
	return migrations
}

func compatibleCapabilities(installed, target model.CapabilityRanges) error {
	pairs := []struct {
		name      string
		installed model.CapabilityRange
		target    model.CapabilityRange
	}{
		{"supervisor", installed.Supervisor, target.Supervisor},
		{"controller", installed.Controller, target.Controller},
		{"migrator", installed.Migrator, target.Migrator},
		{"signer", installed.Signer, target.Signer},
	}
	for _, pair := range pairs {
		if pair.installed.Max < pair.target.Min || pair.target.Max < pair.installed.Min {
			return fmt.Errorf("%s capability ranges do not overlap", pair.name)
		}
	}
	return nil
}

func bind(plan Plan) (Plan, error) {
	plan.Digest = ""
	data, err := json.Marshal(plan)
	if err != nil {
		return Plan{}, err
	}
	sum := sha256.Sum256(data)
	plan.Digest = fmt.Sprintf("sha256:%x", sum)
	return plan, nil
}
