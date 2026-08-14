// Package platform defines the fixed Local and Hosting operating-system adapters.
package platform

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	GatewayPort      uint16        `json:"gatewayPort"`
	InstallRoot      string        `json:"installRoot"`
	LifecycleRoot    string        `json:"lifecycleRoot"`
	ProductStateRoot string        `json:"productStateRoot"`
	UnitRoot         string        `json:"unitRoot"`
	RuntimeRoot      string        `json:"runtimeRoot"`
}

var instancePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

func NewConfig(profile model.Profile, instanceID, ownerStateRoot string, operator, gateway, signer Principal) (Config, error) {
	return NewConfigWithGatewayPort(profile, instanceID, ownerStateRoot, 18789, operator, gateway, signer)
}

func NewConfigWithGatewayPort(profile model.Profile, instanceID, ownerStateRoot string, gatewayPort uint16, operator, gateway, signer Principal) (Config, error) {
	config, err := deriveConfig(profile, instanceID, ownerStateRoot, gatewayPort, operator, gateway, signer)
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
	if config.GatewayPort == 0 {
		return errors.New("platform Gateway port is invalid")
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
	expected, err := deriveConfig(config.Profile, config.InstanceID, config.OwnerStateRoot, config.GatewayPort, config.Operator, config.Gateway, config.Signer)
	if err != nil {
		return err
	}
	if config.InstallRoot != expected.InstallRoot || config.LifecycleRoot != expected.LifecycleRoot || config.ProductStateRoot != expected.ProductStateRoot || config.UnitRoot != expected.UnitRoot || config.RuntimeRoot != expected.RuntimeRoot {
		return errors.New("platform configuration contains noncanonical system paths")
	}
	return nil
}

func deriveConfig(profile model.Profile, instanceID, ownerStateRoot string, gatewayPort uint16, operator, gateway, signer Principal) (Config, error) {
	prefix := "local"
	if profile == model.ProfileHosting {
		prefix = "hosting"
	} else if profile != model.ProfileProtectedLocal {
		return Config{}, fmt.Errorf("unsupported platform profile %q", profile)
	}
	config := Config{
		SchemaVersion: CurrentConfigSchemaVersion, Profile: profile, InstanceID: instanceID,
		OwnerStateRoot: ownerStateRoot, Operator: operator, Gateway: gateway, Signer: signer, GatewayPort: gatewayPort,
		InstallRoot:      filepath.Join("/opt/fased", prefix, instanceID),
		LifecycleRoot:    filepath.Join("/var/lib/fased-"+prefix, instanceID, "lifecycle"),
		ProductStateRoot: filepath.Join("/var/lib/fased-"+prefix, instanceID),
		UnitRoot:         "/etc/systemd/system", RuntimeRoot: filepath.Join("/run/fased-"+prefix, instanceID),
	}
	if profile == model.ProfileHosting {
		config.InstallRoot = "/opt/fased"
		config.LifecycleRoot = "/var/lib/fased-lifecycled"
		config.ProductStateRoot = "/var/lib/fased-signerd"
		config.RuntimeRoot = "/run/fased-signerd"
	}
	return config, nil
}

func (config Config) ApplicationSocket() string {
	if config.Profile == model.ProfileProtectedLocal {
		return filepath.Join(config.RuntimeRoot, "application", "app.sock")
	}
	return filepath.Join(config.RuntimeRoot, "app.sock")
}

func (config Config) OperatorSocket() string {
	if config.Profile == model.ProfileProtectedLocal {
		return filepath.Join(config.RuntimeRoot, "operator", "operator.sock")
	}
	return filepath.Join(config.RuntimeRoot, "operator.sock")
}

func (config Config) ControlSocket() string {
	if config.Profile == model.ProfileProtectedLocal {
		return filepath.Join(config.RuntimeRoot, "control", "control.sock")
	}
	return filepath.Join(config.RuntimeRoot, "control.sock")
}

func (config Config) GatewayGroupName() string {
	if config.Profile == model.ProfileProtectedLocal {
		return "fsgw-" + config.InstanceID
	}
	return "fased-gateway"
}

func (config Config) OperatorGroupName() string {
	if config.Profile == model.ProfileProtectedLocal {
		return "fsop-" + config.InstanceID
	}
	return "fased-operator"
}

func (config Config) SignerUserName() string {
	if config.Profile == model.ProfileHosting {
		return "fased-signer"
	}
	return "fssg-" + config.InstanceID
}

func (config Config) ConfigGroupName() string {
	if config.Profile == model.ProfileProtectedLocal {
		return "fscf-" + config.InstanceID
	}
	return "fased-config"
}

func (config Config) OwnerHome() string {
	return filepath.Dir(config.OwnerStateRoot)
}

func (config Config) SupervisorRuntimeRoot() string {
	if config.Profile == model.ProfileProtectedLocal {
		return filepath.Join("/run/fased-local-controller", config.InstanceID)
	}
	return "/run/fased-host-updater"
}

func (config Config) SupervisorSocket() string {
	return filepath.Join(config.SupervisorRuntimeRoot(), "request.sock")
}

func (config Config) UpdateAuthorityPath() string {
	if config.Profile == model.ProfileHosting {
		return "/etc/sudoers.d/fased-hosting-update"
	}
	return filepath.Join("/etc/sudoers.d", "fased-local-"+config.InstanceID+"-update")
}

func (config Config) SignerStateRoot() string {
	if config.Profile == model.ProfileProtectedLocal {
		return filepath.Join(config.ProductStateRoot, "signer")
	}
	return config.ProductStateRoot
}

func (config Config) UpdateGatePath() string {
	if config.Profile == model.ProfileProtectedLocal {
		return filepath.Join(config.ProductStateRoot, "controller", "signer-update-gate")
	}
	return "/var/lib/fased-signer-update-gate/active"
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

func DecodeConfig(data []byte) (Config, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var config Config
	if err := decoder.Decode(&config); err != nil {
		return Config{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Config{}, errors.New("unexpected trailing platform configuration")
		}
		return Config{}, err
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func CanonicalConfigJSON(config Config) ([]byte, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	return json.Marshal(config)
}
