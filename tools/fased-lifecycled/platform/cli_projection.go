package platform

import (
	"encoding/json"
	"path/filepath"

	"fased-lifecycled/model"
)

const CurrentCLIProjectionSchemaVersion uint32 = 1

type CLIProjection struct {
	SchemaVersion uint32            `json:"schemaVersion"`
	Profile       model.Profile     `json:"profile"`
	InstanceID    string            `json:"instanceId"`
	Environment   map[string]string `json:"environment"`
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
