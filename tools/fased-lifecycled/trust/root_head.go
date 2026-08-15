package trust

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	sigroot "github.com/sigstore/sigstore-go/pkg/root"
)

const (
	rootHeadType        = "fased-lifecycle-root-head"
	rootHeadSubjectName = "fased-lifecycle-root-head-v1.json"
	rootHeadRepository  = "fased-ai/fased"
	rootHeadWorkflow    = "fased-ai/fased/.github/workflows/hosted-runtime-release.yml"
	rootHeadMainRef     = "refs/heads/main"
	maxRootHeadLifetime = 48 * time.Hour
)

var plainDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// RootHead is a short-lived, independently attested positive statement of the
// root and release-index identities currently selected by a managed channel.
// It prevents an unauthenticated release-host 404 from defining the end of the
// root-rotation chain.
type RootHead struct {
	SchemaVersion      uint32 `json:"schemaVersion"`
	Type               string `json:"type"`
	Channel            string `json:"channel"`
	RootVersion        uint64 `json:"rootVersion"`
	RootSHA256         string `json:"rootSHA256"`
	ReleaseIndexSHA256 string `json:"releaseIndexSHA256"`
	ReleaseVersion     string `json:"releaseVersion"`
	ReleaseSequence    uint64 `json:"releaseSequence"`
	SecurityEpoch      uint64 `json:"securityEpoch"`
	IndexCommit        string `json:"indexCommit"`
	WitnessRef         string `json:"witnessRef"`
	WitnessCommit      string `json:"witnessCommit"`
	IssuedAt           string `json:"issuedAt"`
	ExpiresAt          string `json:"expiresAt"`
}

type VerifiedRootHead struct {
	head              RootHead
	digest            string
	attestationDigest string
}

func (verified VerifiedRootHead) Head() RootHead            { return verified.head }
func (verified VerifiedRootHead) Digest() string            { return verified.digest }
func (verified VerifiedRootHead) AttestationDigest() string { return verified.attestationDigest }

func DecodeRootHead(data []byte, now time.Time) (RootHead, error) {
	var head RootHead
	if err := decodeStrict(data, &head); err != nil {
		return RootHead{}, err
	}
	if err := validateRootHead(head, now); err != nil {
		return RootHead{}, err
	}
	return head, nil
}

func VerifyAttestedRootHead(headJSON, bundleJSON []byte, now time.Time) (VerifiedRootHead, error) {
	head, err := DecodeRootHead(headJSON, now)
	if err != nil {
		return VerifiedRootHead{}, err
	}
	trustedMaterial, err := sigroot.NewTrustedRootFromJSON(sigstorePublicGoodTrustedRoot)
	if err != nil {
		return VerifiedRootHead{}, fmt.Errorf("parse Sigstore trusted root: %w", err)
	}
	digest := sha256.Sum256(headJSON)
	attestationDigest, err := verifyGitHubArtifactAttestation(trustedMaterial, bundleJSON, githubAttestationExpectation{
		Repository: rootHeadRepository, Workflow: rootHeadWorkflow,
		SourceRef: head.WitnessRef, Commit: head.WitnessCommit,
		SubjectName: rootHeadSubjectName, DigestAlgorithm: "sha256", Digest: digest[:],
		DenySelfHosted: true,
	})
	if err != nil {
		return VerifiedRootHead{}, err
	}
	return VerifiedRootHead{head: head, digest: hex.EncodeToString(digest[:]), attestationDigest: attestationDigest}, nil
}

func validateRootHead(head RootHead, now time.Time) error {
	if head.SchemaVersion != 1 || head.Type != rootHeadType ||
		(head.Channel != "stable" && head.Channel != "beta") || head.RootVersion == 0 ||
		!plainDigestPattern.MatchString(head.RootSHA256) ||
		!plainDigestPattern.MatchString(head.ReleaseIndexSHA256) ||
		!versionPattern.MatchString(head.ReleaseVersion) || head.ReleaseSequence == 0 ||
		head.SecurityEpoch == 0 || !gitPattern.MatchString(head.IndexCommit) ||
		!gitPattern.MatchString(head.WitnessCommit) {
		return errors.New("lifecycle root-head identity is malformed")
	}
	if (head.Channel == "stable" && strings.Contains(head.ReleaseVersion, "-")) ||
		(head.Channel == "beta" && !strings.Contains(head.ReleaseVersion, "-")) {
		return errors.New("lifecycle root-head channel and version disagree")
	}
	tagRef := githubArtifactAttestationRefPrefix + head.ReleaseVersion
	if head.WitnessRef != rootHeadMainRef && head.WitnessRef != tagRef {
		return errors.New("lifecycle root-head witness ref is unauthorized")
	}
	if head.WitnessRef == tagRef && head.WitnessCommit != head.IndexCommit {
		return errors.New("tag-attested lifecycle root-head commit differs from the release index")
	}
	if _, _, err := validity(head.IssuedAt, head.ExpiresAt, now, maxRootHeadLifetime); err != nil {
		return fmt.Errorf("lifecycle root-head freshness: %w", err)
	}
	return nil
}
