// Package platform defines the fixed Local and Hosting operating-system adapters.
package platform

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"fased-lifecycled/model"
)

const CurrentConfigSchemaVersion uint32 = 1

type Principal struct {
	UID uint32 `json:"uid"`
	GID uint32 `json:"gid"`
}

type Config struct {
	SchemaVersion    uint32        `json:"schemaVersion"`
	Profile          model.Profile `json:"profile"`
	InstanceID       string        `json:"instanceId"`
	OwnerStateRoot   string        `json:"ownerStateRoot"`
	Operator         Principal     `json:"operator"`
	Gateway          Principal     `json:"gateway"`
	Signer           Principal     `json:"signer"`
	InstallRoot      string        `json:"installRoot"`
	LifecycleRoot    string        `json:"lifecycleRoot"`
	ProductStateRoot string        `json:"productStateRoot"`
	UnitRoot         string        `json:"unitRoot"`
	RuntimeRoot      string        `json:"runtimeRoot"`
}

var instancePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

func NewConfig(profile model.Profile, instanceID, ownerStateRoot string, operator, gateway, signer Principal) (Config, error) {
	config, err := deriveConfig(profile, instanceID, ownerStateRoot, operator, gateway, signer)
	if err != nil {
		return Config{}, err
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func (config Config) Validate() error {
	if config.SchemaVersion > CurrentConfigSchemaVersion {
		return errors.New("platform configuration schema is newer than supported")
	}
	if config.SchemaVersion != CurrentConfigSchemaVersion || !instancePattern.MatchString(config.InstanceID) {
		return errors.New("platform configuration schema or instance identity is invalid")
	}
	if config.Profile != model.ProfileProtectedLocal && config.Profile != model.ProfileHosting {
		return errors.New("platform configuration profile is invalid")
	}
	for name, principal := range map[string]Principal{"operator": config.Operator, "gateway": config.Gateway, "signer": config.Signer} {
		if principal.UID == 0 || principal.GID == 0 {
			return fmt.Errorf("platform %s principal must be unprivileged", name)
		}
	}
	if config.Gateway == config.Signer || config.Operator == config.Signer {
		return errors.New("signer principal must be isolated from operator and gateway")
	}
	paths := map[string]string{
		"owner state": config.OwnerStateRoot, "install": config.InstallRoot,
		"lifecycle": config.LifecycleRoot, "product state": config.ProductStateRoot,
		"unit": config.UnitRoot, "runtime": config.RuntimeRoot,
	}
	for name, path := range paths {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
			return fmt.Errorf("platform %s path must be absolute, clean, and scoped", name)
		}
		if strings.IndexFunc(path, func(value rune) bool { return value <= ' ' || value == 0x7f }) >= 0 {
			return fmt.Errorf("platform %s path contains unsupported whitespace or control characters", name)
		}
	}
	expected, err := deriveConfig(config.Profile, config.InstanceID, config.OwnerStateRoot, config.Operator, config.Gateway, config.Signer)
	if err != nil {
		return err
	}
	if config.InstallRoot != expected.InstallRoot || config.LifecycleRoot != expected.LifecycleRoot || config.ProductStateRoot != expected.ProductStateRoot || config.UnitRoot != expected.UnitRoot || config.RuntimeRoot != expected.RuntimeRoot {
		return errors.New("platform configuration contains noncanonical system paths")
	}
	return nil
}

func deriveConfig(profile model.Profile, instanceID, ownerStateRoot string, operator, gateway, signer Principal) (Config, error) {
	prefix := "local"
	if profile == model.ProfileHosting {
		prefix = "hosting"
	} else if profile != model.ProfileProtectedLocal {
		return Config{}, fmt.Errorf("unsupported platform profile %q", profile)
	}
	return Config{
		SchemaVersion: CurrentConfigSchemaVersion, Profile: profile, InstanceID: instanceID,
		OwnerStateRoot: ownerStateRoot, Operator: operator, Gateway: gateway, Signer: signer,
		InstallRoot:      filepath.Join("/opt/fased", prefix, instanceID),
		LifecycleRoot:    filepath.Join("/var/lib/fased-"+prefix, instanceID, "lifecycle"),
		ProductStateRoot: filepath.Join("/var/lib/fased-"+prefix, instanceID),
		UnitRoot:         "/etc/systemd/system", RuntimeRoot: filepath.Join("/run/fased-"+prefix, instanceID),
	}, nil
}

func (config Config) Digest() (string, error) {
	if err := config.Validate(); err != nil {
		return "", err
	}
	data, err := json.Marshal(config)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return fmt.Sprintf("sha256:%x", digest), nil
}

func (config Config) Identity() (model.PlatformIdentity, error) {
	digest, err := config.Digest()
	if err != nil {
		return model.PlatformIdentity{}, err
	}
	return model.NewPlatformIdentity(config.Profile, config.InstanceID, digest)
}
