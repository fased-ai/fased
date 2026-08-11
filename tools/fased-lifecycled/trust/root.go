package trust

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"time"
)

const maxRootLifetime = 5 * 366 * 24 * time.Hour

type RootRole struct {
	KeyIDs    []string `json:"keyIds"`
	Threshold uint32   `json:"threshold"`
}
type ReleaseAuthority struct {
	Type                  string `json:"type"`
	Repository            string `json:"repository"`
	Workflow              string `json:"workflow"`
	SourceRefPrefix       string `json:"sourceRefPrefix"`
	DenySelfHostedRunners bool   `json:"denySelfHostedRunners"`
}
type Revocations struct {
	ReleaseVersions []string `json:"releaseVersions"`
	TargetDigests   []string `json:"targetDigests"`
	DelegatedKeyIDs []string `json:"delegatedKeyIds,omitempty"`
}
type RootMetadata struct {
	SchemaVersion    uint32            `json:"schemaVersion"`
	Type             string            `json:"type"`
	Version          uint64            `json:"version"`
	IssuedAt         string            `json:"issuedAt"`
	ExpiresAt        string            `json:"expiresAt"`
	Keys             map[string]Key    `json:"keys"`
	Root             RootRole          `json:"root"`
	ReleaseAuthority *ReleaseAuthority `json:"releaseAuthority,omitempty"`
	Revocations      Revocations       `json:"revocations"`
}
type VerifiedRoot struct {
	metadata RootMetadata
	digest   string
	keys     map[string]ed25519.PublicKey
}

func (root VerifiedRoot) Version() uint64 { return root.metadata.Version }
func (root VerifiedRoot) Digest() string  { return root.digest }

func SignRoot(metadata RootMetadata, keys []SigningKey) ([]byte, error) {
	if _, err := validateRootMetadata(metadata, time.Time{}); err != nil {
		return nil, err
	}
	return signEnvelope(metadata, keys)
}

func VerifyInitialRoot(data []byte, pinnedSHA256 string, now time.Time) (VerifiedRoot, error) {
	digest, err := digestDocument(data)
	if err != nil {
		return VerifiedRoot{}, err
	}
	if digest != pinnedSHA256 {
		return VerifiedRoot{}, errors.New("initial lifecycle root does not match its immutable pin")
	}
	var probe rawEnvelope
	if err := decodeStrict(data, &probe); err != nil {
		return VerifiedRoot{}, err
	}
	var metadata RootMetadata
	if err := decodeStrict(probe.Signed, &metadata); err != nil {
		return VerifiedRoot{}, err
	}
	keys, err := validateRootMetadata(metadata, now)
	if err != nil {
		return VerifiedRoot{}, err
	}
	_, verified, err := verifyEnvelope(data, keys)
	if err != nil {
		return VerifiedRoot{}, err
	}
	if err := requireThreshold(metadata.Root, verified); err != nil {
		return VerifiedRoot{}, err
	}
	for _, signature := range probe.Signatures {
		if !contains(metadata.Root.KeyIDs, signature.KeyID) {
			return VerifiedRoot{}, errors.New("initial root contains a signature outside its root role")
		}
	}
	return VerifiedRoot{metadata: metadata, digest: digest, keys: keys}, nil
}

func VerifyRootRotation(trusted VerifiedRoot, data []byte, now time.Time) (VerifiedRoot, error) {
	var probe rawEnvelope
	if err := decodeStrict(data, &probe); err != nil {
		return VerifiedRoot{}, err
	}
	var candidate RootMetadata
	if err := decodeStrict(probe.Signed, &candidate); err != nil {
		return VerifiedRoot{}, err
	}
	candidateKeys, err := validateRootMetadata(candidate, now)
	if err != nil {
		return VerifiedRoot{}, err
	}
	if candidate.Version != trusted.metadata.Version+1 {
		return VerifiedRoot{}, errors.New("root rotation must advance exactly one version")
	}
	union := map[string]ed25519.PublicKey{}
	for id, key := range trusted.keys {
		union[id] = key
	}
	for id, key := range candidateKeys {
		union[id] = key
	}
	_, verified, err := verifyEnvelope(data, union)
	if err != nil {
		return VerifiedRoot{}, err
	}
	if err := requireThreshold(trusted.metadata.Root, verified); err != nil {
		return VerifiedRoot{}, fmt.Errorf("old root: %w", err)
	}
	if err := requireThreshold(candidate.Root, verified); err != nil {
		return VerifiedRoot{}, fmt.Errorf("new root: %w", err)
	}
	digest, err := digestDocument(data)
	if err != nil {
		return VerifiedRoot{}, err
	}
	return VerifiedRoot{metadata: candidate, digest: digest, keys: candidateKeys}, nil
}

func validateRootMetadata(metadata RootMetadata, now time.Time) (map[string]ed25519.PublicKey, error) {
	if metadata.SchemaVersion != 1 || metadata.Type != "fased-lifecycle-root" || metadata.Version == 0 || len(metadata.Keys) != 3 || metadata.Root.Threshold != 2 || len(metadata.Root.KeyIDs) != 3 {
		return nil, errors.New("lifecycle root metadata is malformed")
	}
	if !sort.StringsAreSorted(metadata.Root.KeyIDs) || hasDuplicates(metadata.Root.KeyIDs) {
		return nil, errors.New("root key IDs must be unique and sorted")
	}
	issuedAt, expiresAt, err := validity(metadata.IssuedAt, metadata.ExpiresAt, now, maxRootLifetime)
	if err != nil {
		return nil, err
	}
	_, _ = issuedAt, expiresAt
	keys := map[string]ed25519.PublicKey{}
	for id, record := range metadata.Keys {
		public, err := parseKey(id, record)
		if err != nil {
			return nil, err
		}
		keys[id] = public
	}
	for _, id := range metadata.Root.KeyIDs {
		if _, ok := keys[id]; !ok {
			return nil, errors.New("root role references an undeclared key")
		}
	}
	if !sortedUnique(metadata.Revocations.ReleaseVersions) || !sortedUnique(metadata.Revocations.TargetDigests) || !sortedUnique(metadata.Revocations.DelegatedKeyIDs) {
		return nil, errors.New("root revocations must be unique and sorted")
	}
	return keys, nil
}

func parseKey(id string, record Key) (ed25519.PublicKey, error) {
	if !isKeyID(id) || record.KeyType != "ed25519" || record.Scheme != "ed25519" {
		return nil, errors.New("lifecycle trust key is invalid")
	}
	der, err := base64.StdEncoding.Strict().DecodeString(record.PublicKey)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(der)
	if hex.EncodeToString(sum[:]) != id {
		return nil, errors.New("lifecycle trust key ID does not match its public key")
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	public, ok := parsed.(ed25519.PublicKey)
	if !ok || len(public) != ed25519.PublicKeySize {
		return nil, errors.New("lifecycle trust key is not canonical Ed25519 SPKI")
	}
	canonicalDER, err := x509.MarshalPKIXPublicKey(public)
	if err != nil || !bytes.Equal(canonicalDER, der) {
		return nil, errors.New("lifecycle trust key encoding is not canonical")
	}
	return public, nil
}

func validity(issuedText, expiresText string, now time.Time, max time.Duration) (time.Time, time.Time, error) {
	issued, err := time.Parse(time.RFC3339Nano, issuedText)
	if err != nil {
		return time.Time{}, time.Time{}, errors.New("issuedAt is not RFC3339")
	}
	expires, err := time.Parse(time.RFC3339Nano, expiresText)
	if err != nil {
		return time.Time{}, time.Time{}, errors.New("expiresAt is not RFC3339")
	}
	if !expires.After(issued) || expires.Sub(issued) > max || (!now.IsZero() && (now.Before(issued) || !now.Before(expires))) {
		return time.Time{}, time.Time{}, errors.New("trust metadata validity window is invalid or stale")
	}
	return issued, expires, nil
}

func requireThreshold(role RootRole, verified map[string]bool) error {
	count := 0
	for _, id := range role.KeyIDs {
		if verified[id] {
			count++
		}
	}
	if count < int(role.Threshold) {
		return errors.New("root signature threshold was not met")
	}
	return nil
}
func contains(values []string, value string) bool {
	for _, entry := range values {
		if entry == value {
			return true
		}
	}
	return false
}
func hasDuplicates(values []string) bool {
	for index := 1; index < len(values); index++ {
		if values[index-1] == values[index] {
			return true
		}
	}
	return false
}
func sortedUnique(values []string) bool {
	return sort.StringsAreSorted(values) && !hasDuplicates(values)
}
