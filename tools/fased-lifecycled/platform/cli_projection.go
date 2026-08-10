package platform

import (
	"encoding/json"
	"fmt"
	"path/filepath"

	"fased-lifecycled/model"
)

const CurrentCLIProjectionSchemaVersion uint32 = 1
const CurrentInstallProjectionSchemaVersion uint32 = 2

type CLIProjection struct {
	SchemaVersion uint32            `json:"schemaVersion"`
	Profile       model.Profile     `json:"profile"`
	InstanceID    string            `json:"instanceId"`
	Environment   map[string]string `json:"environment"`
}

// InstallProjection is the owner-readable compatibility view consumed by the
// public CLI and installer status checks. It is deliberately derived from the
// root-owned transaction and never selects or activates a generation.
type InstallProjection struct {
	SchemaVersion uint32                   `json:"schemaVersion"`
	Profile       model.Profile            `json:"profile"`
	Source        string                   `json:"source"`
	StateDir      string                   `json:"stateDir"`
	ConfigPath    string                   `json:"configPath"`
	Runtime       InstallProjectionRuntime `json:"runtime"`
	Service       InstallProjectionService `json:"service"`
}

type InstallProjectionRuntime struct {
	ActiveVersion   string  `json:"activeVersion"`
	PreviousVersion *string `json:"previousVersion"`
	CurrentLink     string  `json:"currentLink"`
	PreviousLink    string  `json:"previousLink"`
	ReleasesDir     string  `json:"releasesDir"`
}

type InstallProjectionService struct {
	Name     string `json:"name"`
	Scope    string `json:"scope"`
	Launcher string `json:"launcher"`
}

// CanonicalCLIProjection is an owner-readable, non-authoritative projection.
// Root lifecycle state remains authoritative; this only lets onboarding and
// the owner CLI locate the fixed sockets and immutable runtime.
func CanonicalCLIProjection(config Config) (CLIProjection, error) {
	if err := config.Validate(); err != nil {
		return CLIProjection{}, err
	}
	environment := map[string]string{
		"FASED_HOST_PROFILE":               profileEnvironment(config.Profile),
		"FASED_HOST_UPDATER_SOCKET":        config.SupervisorSocket(),
		"FASED_LIFECYCLE_CONFIG":           filepath.Join(config.LifecycleRoot, "platform.json"),
		"FASED_LIFECYCLE_INSTALL_ROOT":     config.InstallRoot,
		"FASED_LIFECYCLE_INSTANCE":         config.InstanceID,
		"FASED_LIFECYCLE_PROFILE":          string(config.Profile),
		"FASED_MANAGED_RUNTIME_ROOT":       filepath.Join(config.InstallRoot, "current", "payload", "runtime"),
		"FASED_RUNTIME_SOURCE":             "go-lifecycle",
		"FASED_WALLET_LOCAL_SIGNER_BIN":    filepath.Join(config.InstallRoot, "current", "payload", "bin", "fased-signerd"),
		"FASED_WALLET_LOCAL_SIGNER_SOCKET": config.ApplicationSocket(),
	}
	if config.Profile == model.ProfileProtectedLocal {
		environment["FASED_PROTECTED_LOCAL"] = "1"
		environment["FASED_PROTECTED_LOCAL_INSTANCE"] = config.InstanceID
		environment["FASED_WALLET_LOCAL_SIGNER_LIFECYCLE"] = "external"
	}
	return CLIProjection{SchemaVersion: CurrentCLIProjectionSchemaVersion, Profile: config.Profile, InstanceID: config.InstanceID, Environment: environment}, nil
}

func CanonicalCLIProjectionJSON(config Config) ([]byte, error) {
	projection, err := CanonicalCLIProjection(config)
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(projection)
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func CanonicalInstallProjection(config Config, tx model.Transaction) (InstallProjection, error) {
	if err := config.Validate(); err != nil {
		return InstallProjection{}, err
	}
	if err := tx.Validate(); err != nil {
		return InstallProjection{}, err
	}
	identity, err := config.Identity()
	if err != nil {
		return InstallProjection{}, err
	}
	digest, err := identity.Digest(tx.Profile)
	if err != nil || tx.Profile != config.Profile || digest != tx.PlatformDigest {
		return InstallProjection{}, fmt.Errorf("install projection transaction does not match platform identity")
	}
	var previous *string
	if tx.Previous != nil {
		value := tx.Previous.Version
		previous = &value
	}
	return InstallProjection{
		SchemaVersion: CurrentInstallProjectionSchemaVersion,
		Profile:       config.Profile,
		Source:        "go-lifecycle",
		StateDir:      config.OwnerStateRoot,
		ConfigPath:    filepath.Join(config.OwnerStateRoot, "fased.json"),
		Runtime: InstallProjectionRuntime{
			ActiveVersion: tx.Target.Version, PreviousVersion: previous,
			CurrentLink:  filepath.Join(config.InstallRoot, "current"),
			PreviousLink: filepath.Join(config.InstallRoot, "previous"),
			ReleasesDir:  filepath.Join(config.InstallRoot, "generations"),
		},
		Service: InstallProjectionService{
			Name: identity.Services["gateway"], Scope: "system",
			Launcher: filepath.Join(config.InstallRoot, "current", "payload", "bin", "fased-gateway-launch"),
		},
	}, nil
}

func CanonicalInstallProjectionJSON(config Config, tx model.Transaction) ([]byte, error) {
	projection, err := CanonicalInstallProjection(config, tx)
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(projection)
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}
