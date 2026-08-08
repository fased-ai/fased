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
	ActionInstall        Action = "INSTALL"
	ActionUpdate         Action = "UPDATE"
	ActionAlreadyCurrent Action = "ALREADY_CURRENT"
)

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
	if err := validateTarget(target); err != nil {
		return Plan{}, err
	}
	if installed == nil {
		plan := Plan{Action: ActionInstall, Profile: target.Profile, Target: target.Generation}
		plan.Migrations = migrationsFrom(nil, target.StateSchemas)
		return bind(plan)
	}
	if err := installed.Validate(); err != nil {
		return Plan{}, fmt.Errorf("installed manifest: %w", err)
	}
	if installed.Profile != target.Profile {
		return Plan{}, fmt.Errorf("installation profile %q cannot use target profile %q", installed.Profile, target.Profile)
	}
	if installed.ActiveGeneration == nil {
		return Plan{}, errors.New("managed installation has no active generation")
	}
	if err := compatibleCapabilities(installed.Capabilities, target.Capabilities); err != nil {
		return Plan{}, err
	}
	for state, version := range installed.StateSchemas {
		targetVersion, ok := target.StateSchemas[state]
		if !ok {
			return Plan{}, fmt.Errorf("installed state schema %q has no declared target mapping", state)
		}
		if version > targetVersion {
			return Plan{}, fmt.Errorf("installed state schema %q version %d is newer than target version %d", state, version, targetVersion)
		}
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
