package trust

import (
	"crypto/ed25519"
	"errors"
	"sort"
	"time"
)

const maxDelegationLifetime = 90 * 24 * time.Hour

type Delegation struct {
	SchemaVersion      uint32   `json:"schemaVersion"`
	Type               string   `json:"type"`
	Version            uint64   `json:"version"`
	IssuedAt           string   `json:"issuedAt"`
	ExpiresAt          string   `json:"expiresAt"`
	KeyID              string   `json:"keyId"`
	Key                Key      `json:"key"`
	Channels           []string `json:"channels"`
	MinReleaseSequence uint64   `json:"minReleaseSequence"`
	MaxReleaseSequence uint64   `json:"maxReleaseSequence"`
	SecurityEpoch      uint64   `json:"securityEpoch"`
}

type VerifiedDelegation struct {
	delegation Delegation
	digest     string
	key        ed25519.PublicKey
}

func (delegation VerifiedDelegation) Digest() string { return delegation.digest }

func SignDelegation(delegation Delegation, keys []SigningKey) ([]byte, error) {
	if err := validateDelegation(delegation, time.Time{}); err != nil {
		return nil, err
	}
	return signEnvelope(delegation, keys)
}

func VerifyDelegation(root VerifiedRoot, data []byte, now time.Time) (VerifiedDelegation, error) {
	var envelope rawEnvelope
	if err := decodeStrict(data, &envelope); err != nil {
		return VerifiedDelegation{}, err
	}
	var delegation Delegation
	if err := decodeStrict(envelope.Signed, &delegation); err != nil {
		return VerifiedDelegation{}, err
	}
	if err := validateDelegation(delegation, now); err != nil {
		return VerifiedDelegation{}, err
	}
	if contains(root.metadata.Revocations.DelegatedKeyIDs, delegation.KeyID) {
		return VerifiedDelegation{}, errors.New("delegated release key is revoked")
	}
	_, verified, err := verifyEnvelope(data, root.keys)
	if err != nil {
		return VerifiedDelegation{}, err
	}
	if err := requireThreshold(root.metadata.Root, verified); err != nil {
		return VerifiedDelegation{}, err
	}
	key, err := parseKey(delegation.KeyID, delegation.Key)
	if err != nil {
		return VerifiedDelegation{}, err
	}
	digest, err := digestDocument(data)
	if err != nil {
		return VerifiedDelegation{}, err
	}
	return VerifiedDelegation{delegation: delegation, digest: digest, key: key}, nil
}

func validateDelegation(delegation Delegation, now time.Time) error {
	if delegation.SchemaVersion != 1 || delegation.Type != "fased-release-delegation" || delegation.Version == 0 || delegation.MinReleaseSequence == 0 || delegation.MaxReleaseSequence < delegation.MinReleaseSequence || delegation.SecurityEpoch == 0 {
		return errors.New("release delegation is malformed")
	}
	if _, _, err := validity(delegation.IssuedAt, delegation.ExpiresAt, now, maxDelegationLifetime); err != nil {
		return err
	}
	if len(delegation.Channels) == 0 || !sort.StringsAreSorted(delegation.Channels) || hasDuplicates(delegation.Channels) {
		return errors.New("delegated channels must be unique and sorted")
	}
	for _, channel := range delegation.Channels {
		if channel != "beta" && channel != "stable" {
			return errors.New("release delegation contains an unsupported channel")
		}
	}
	_, err := parseKey(delegation.KeyID, delegation.Key)
	return err
}
