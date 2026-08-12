package trust

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"time"

	"fased-lifecycled/model"
)

const maxReleaseIndexLifetime = 24 * time.Hour

var (
	digestPattern    = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	gitPattern       = regexp.MustCompile(`^[0-9a-f]{40}$`)
	versionPattern   = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$`)
	assetNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$`)
)

type Asset struct {
	Name                string         `json:"name"`
	Size                uint64         `json:"size"`
	SHA256              string         `json:"sha256"`
	PrivilegedComponent string         `json:"privilegedComponent,omitempty"`
	Protocols           *HostProtocols `json:"protocols,omitempty"`
}

type ProtocolRange struct {
	Min uint32 `json:"min"`
	Max uint32 `json:"max"`
}

type HostProtocols struct {
	Manifest    ProtocolRange `json:"manifest"`
	Journal     ProtocolRange `json:"journal"`
	Participant ProtocolRange `json:"participant"`
	Platform    ProtocolRange `json:"platform"`
}

func (protocols HostProtocols) Validate() error {
	for name, versionRange := range map[string]ProtocolRange{"manifest": protocols.Manifest, "journal": protocols.Journal, "participant": protocols.Participant, "platform": protocols.Platform} {
		if versionRange.Min == 0 || versionRange.Max < versionRange.Min {
			return fmt.Errorf("lifecycle-host %s protocol range is invalid", name)
		}
	}
	return nil
}

type ReleaseIndex struct {
	SchemaVersion     uint32                 `json:"schemaVersion"`
	Type              string                 `json:"type"`
	Channel           string                 `json:"channel"`
	Version           string                 `json:"version"`
	ReleaseSequence   uint64                 `json:"releaseSequence"`
	SecurityEpoch     uint64                 `json:"securityEpoch"`
	Commit            string                 `json:"commit"`
	Tree              string                 `json:"tree"`
	ArtifactSetDigest string                 `json:"artifactSetDigest"`
	Application       map[string]Asset       `json:"application"`
	DependencyLayer   map[string]Asset       `json:"dependencyLayer"`
	LifecycleHost     map[string]Asset       `json:"lifecycleHost"`
	Signer            map[string]Asset       `json:"signer"`
	StateSchemas      map[string]uint32      `json:"stateSchemas"`
	Capabilities      model.CapabilityRanges `json:"capabilities"`
	PluginLockDigest  string                 `json:"pluginLockDigest"`
	IssuedAt          string                 `json:"issuedAt"`
	ExpiresAt         string                 `json:"expiresAt"`
}

type VerifiedReleaseIndex struct {
	index                  ReleaseIndex
	digest                 string
	releaseAuthorityDigest string
}

func (verified VerifiedReleaseIndex) Index() ReleaseIndex { return cloneReleaseIndex(verified.index) }
func (verified VerifiedReleaseIndex) Digest() string      { return verified.digest }
func (verified VerifiedReleaseIndex) ReleaseAuthorityDigest() string {
	return verified.releaseAuthorityDigest
}

func SignReleaseIndex(index ReleaseIndex, key SigningKey) ([]byte, error) {
	if err := validateReleaseIndex(index, time.Time{}); err != nil {
		return nil, err
	}
	if key.KeyID == "" || len(key.PrivateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("release-index signing key is invalid")
	}
	return signEnvelope(index, []SigningKey{key})
}

func DecodeReleaseIndex(data []byte) (ReleaseIndex, error) {
	var index ReleaseIndex
	if err := decodeStrict(data, &index); err != nil {
		return ReleaseIndex{}, err
	}
	if err := validateReleaseIndex(index, time.Time{}); err != nil {
		return ReleaseIndex{}, err
	}
	return index, nil
}

// EncodeReleaseIndex emits the canonical raw artifact that GitHub's protected
// release workflow attests. Ordinary releases do not introduce another Fased
// signing key or wrap this artifact in a private-key envelope.
func EncodeReleaseIndex(index ReleaseIndex) ([]byte, error) {
	if err := validateReleaseIndex(index, time.Time{}); err != nil {
		return nil, err
	}
	return canonicalStruct(index)
}

func VerifyReleaseIndex(delegation VerifiedDelegation, data []byte, now time.Time) (VerifiedReleaseIndex, error) {
	var envelope rawEnvelope
	if err := decodeStrict(data, &envelope); err != nil {
		return VerifiedReleaseIndex{}, err
	}
	var index ReleaseIndex
	if err := decodeStrict(envelope.Signed, &index); err != nil {
		return VerifiedReleaseIndex{}, err
	}
	if err := validateReleaseIndex(index, now); err != nil {
		return VerifiedReleaseIndex{}, err
	}
	if !contains(delegation.delegation.Channels, index.Channel) || index.ReleaseSequence < delegation.delegation.MinReleaseSequence || index.ReleaseSequence > delegation.delegation.MaxReleaseSequence || index.SecurityEpoch != delegation.delegation.SecurityEpoch {
		return VerifiedReleaseIndex{}, errors.New("release index exceeds its delegated authority")
	}
	_, verified, err := verifyEnvelope(data, map[string]ed25519.PublicKey{delegation.delegation.KeyID: delegation.key})
	if err != nil {
		return VerifiedReleaseIndex{}, err
	}
	if len(verified) != 1 || !verified[delegation.delegation.KeyID] {
		return VerifiedReleaseIndex{}, errors.New("release index is not signed by its delegated key")
	}
	digest, err := digestDocument(data)
	if err != nil {
		return VerifiedReleaseIndex{}, err
	}
	return VerifiedReleaseIndex{index: cloneReleaseIndex(index), digest: digest, releaseAuthorityDigest: delegation.digest}, nil
}

func cloneReleaseIndex(index ReleaseIndex) ReleaseIndex {
	clone := index
	clone.Application = cloneAssets(index.Application)
	clone.DependencyLayer = cloneAssets(index.DependencyLayer)
	clone.LifecycleHost = cloneAssets(index.LifecycleHost)
	clone.Signer = cloneAssets(index.Signer)
	clone.StateSchemas = make(map[string]uint32, len(index.StateSchemas))
	for name, version := range index.StateSchemas {
		clone.StateSchemas[name] = version
	}
	return clone
}

func cloneAssets(source map[string]Asset) map[string]Asset {
	result := make(map[string]Asset, len(source))
	for arch, asset := range source {
		result[arch] = asset
	}
	return result
}

func validateReleaseIndex(index ReleaseIndex, now time.Time) error {
	if index.SchemaVersion != 1 || index.Type != "fased-release-index" || (index.Channel != "beta" && index.Channel != "stable") || !versionPattern.MatchString(index.Version) || index.ReleaseSequence == 0 || index.SecurityEpoch == 0 || !gitPattern.MatchString(index.Commit) || !gitPattern.MatchString(index.Tree) || !digestPattern.MatchString(index.ArtifactSetDigest) || !digestPattern.MatchString(index.PluginLockDigest) {
		return errors.New("release index identity is malformed")
	}
	if _, _, err := validity(index.IssuedAt, index.ExpiresAt, now, maxReleaseIndexLifetime); err != nil {
		return err
	}
	for label, assets := range map[string]map[string]Asset{"application": index.Application, "dependencyLayer": index.DependencyLayer, "lifecycleHost": index.LifecycleHost, "signer": index.Signer} {
		if err := validateAssets(label, assets); err != nil {
			return err
		}
	}
	if len(index.StateSchemas) == 0 {
		return errors.New("release index state schema inventory is empty")
	}
	for name, version := range index.StateSchemas {
		if name == "" || version == 0 {
			return errors.New("release index state schema is invalid")
		}
	}
	if err := index.Capabilities.Validate(); err != nil {
		return fmt.Errorf("release index capabilities: %w", err)
	}
	return nil
}

func validateAssets(label string, assets map[string]Asset) error {
	if len(assets) == 0 {
		return fmt.Errorf("%s assets are empty", label)
	}
	arches := make([]string, 0, len(assets))
	for arch := range assets {
		arches = append(arches, arch)
	}
	sort.Strings(arches)
	for _, arch := range arches {
		asset := assets[arch]
		if (arch != "x64" && arch != "arm64") || !assetNamePattern.MatchString(asset.Name) || asset.Size == 0 || !digestPattern.MatchString(asset.SHA256) {
			return fmt.Errorf("%s asset %q is invalid", label, arch)
		}
		if label == "lifecycleHost" {
			if asset.PrivilegedComponent != "lifecycle-host" || asset.Protocols == nil {
				return fmt.Errorf("%s asset %q lacks its privileged identity", label, arch)
			}
			if err := asset.Protocols.Validate(); err != nil {
				return err
			}
		} else if asset.PrivilegedComponent != "" || asset.Protocols != nil {
			return fmt.Errorf("%s asset %q claims privileged lifecycle authority", label, arch)
		}
	}
	return nil
}
