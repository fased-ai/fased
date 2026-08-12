package trust

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	sigbundle "github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/fulcio/certificate"
	sigroot "github.com/sigstore/sigstore-go/pkg/root"
	sigverify "github.com/sigstore/sigstore-go/pkg/verify"
)

const (
	githubActionsOIDCIssuer = "https://token.actions.githubusercontent.com"
	inTotoStatementV1       = "https://in-toto.io/Statement/v1"
	slsaProvenanceV1        = "https://slsa.dev/provenance/v1"
)

// This is the Sigstore Public Good trusted-root snapshot from sigstore-go
// v1.3.0 examples/trusted-root-public-good.json (SHA-256
// 4364d7724c04cc912ce2a6c45ed2610e8d8d1c4dc857fb500292738d4d9c8d2c).
// It validates offline GitHub artifact-attestation bundles and is compiled
// into the static bootstrap; managed hosts do not fetch trust material at
// runtime.
//
//go:embed sigstore-public-good-trusted-root.json
var sigstorePublicGoodTrustedRoot []byte

type githubAttestationExpectation struct {
	Repository, Workflow, SourceRef, Commit, SubjectName, DigestAlgorithm string
	Digest                                                                []byte
	DenySelfHosted                                                        bool
}

// VerifyAttestedReleaseIndex verifies raw release-index bytes against an
// offline GitHub artifact-attestation bundle and the release authority in the
// already threshold-verified Fased root. The release version is evidence used
// to bind the exact tag ref; it is never a compatibility selector.
func VerifyAttestedReleaseIndex(verifiedRoot VerifiedRoot, indexJSON, bundleJSON []byte, now time.Time) (VerifiedReleaseIndex, error) {
	var index ReleaseIndex
	if err := decodeStrict(indexJSON, &index); err != nil {
		return VerifiedReleaseIndex{}, err
	}
	if err := validateReleaseIndex(index, now); err != nil {
		return VerifiedReleaseIndex{}, err
	}
	if err := rejectRevokedRelease(verifiedRoot, index); err != nil {
		return VerifiedReleaseIndex{}, err
	}
	trustedMaterial, err := sigroot.NewTrustedRootFromJSON(sigstorePublicGoodTrustedRoot)
	if err != nil {
		return VerifiedReleaseIndex{}, fmt.Errorf("parse Sigstore trusted root: %w", err)
	}
	indexDigest := sha256.Sum256(indexJSON)
	authority := verifiedRoot.ReleaseAuthority()
	expectation := githubAttestationExpectation{
		Repository: authority.Repository, Workflow: authority.Workflow,
		SourceRef: authority.SourceRefPrefix + index.Version, Commit: index.Commit,
		SubjectName: "fased-release-index-v1.json", DigestAlgorithm: "sha256",
		Digest: indexDigest[:], DenySelfHosted: authority.DenySelfHostedRunners,
	}
	authorityDigest, err := verifyGitHubArtifactAttestation(trustedMaterial, bundleJSON, expectation)
	if err != nil {
		return VerifiedReleaseIndex{}, err
	}
	return VerifiedReleaseIndex{
		index: cloneReleaseIndex(index), digest: hex.EncodeToString(indexDigest[:]),
		releaseAuthorityDigest: authorityDigest,
	}, nil
}

func verifyGitHubArtifactAttestation(trustedMaterial sigroot.TrustedMaterial, bundleJSON []byte, expected githubAttestationExpectation) (string, error) {
	if trustedMaterial == nil || expected.Repository == "" || expected.Workflow == "" ||
		expected.SourceRef == "" || !gitPattern.MatchString(expected.Commit) ||
		expected.SubjectName == "" || expected.DigestAlgorithm == "" || len(expected.Digest) == 0 {
		return "", errors.New("GitHub artifact-attestation expectation is incomplete")
	}
	var attestation sigbundle.Bundle
	if err := attestation.UnmarshalJSON(bundleJSON); err != nil {
		return "", fmt.Errorf("decode GitHub artifact-attestation bundle: %w", err)
	}
	workflowIdentity := "https://github.com/" + expected.Workflow + "@" + expected.SourceRef
	extensions := certificate.Extensions{
		GithubWorkflowRepository:            expected.Repository,
		GithubWorkflowRef:                   expected.SourceRef,
		BuildSignerURI:                      workflowIdentity,
		BuildSignerDigest:                   expected.Commit,
		SourceRepositoryURI:                 "https://github.com/" + expected.Repository,
		SourceRepositoryDigest:              expected.Commit,
		SourceRepositoryRef:                 expected.SourceRef,
		BuildConfigURI:                      workflowIdentity,
		BuildConfigDigest:                   expected.Commit,
		SourceRepositoryVisibilityAtSigning: "public",
	}
	if expected.DenySelfHosted {
		extensions.RunnerEnvironment = "github-hosted"
	}
	identity, err := sigverify.NewCertificateIdentity(
		sigverify.SubjectAlternativeNameMatcher{SubjectAlternativeName: workflowIdentity},
		sigverify.IssuerMatcher{Issuer: githubActionsOIDCIssuer}, extensions,
	)
	if err != nil {
		return "", err
	}
	verifier, err := sigverify.NewVerifier(trustedMaterial,
		sigverify.WithSignedCertificateTimestamps(1),
		sigverify.WithTransparencyLog(1),
		sigverify.WithObserverTimestamps(1),
	)
	if err != nil {
		return "", err
	}
	result, err := verifier.Verify(&attestation, sigverify.NewPolicy(
		sigverify.WithArtifactDigest(expected.DigestAlgorithm, expected.Digest),
		sigverify.WithCertificateIdentity(identity),
	))
	if err != nil {
		return "", fmt.Errorf("verify GitHub artifact attestation: %w", err)
	}
	if result.Statement == nil || result.Statement.GetType() != inTotoStatementV1 ||
		result.Statement.GetPredicateType() != slsaProvenanceV1 || len(result.Statement.GetSubject()) != 1 {
		return "", errors.New("GitHub artifact attestation statement is not the required single-subject SLSA provenance")
	}
	subject := result.Statement.GetSubject()[0]
	if subject.GetName() != expected.SubjectName || len(subject.GetDigest()) != 1 ||
		subject.GetDigest()[expected.DigestAlgorithm] != hex.EncodeToString(expected.Digest) {
		return "", errors.New("GitHub artifact attestation subject differs from the release index")
	}
	bundleDigest := sha256.Sum256(bundleJSON)
	return hex.EncodeToString(bundleDigest[:]), nil
}

func rejectRevokedRelease(root VerifiedRoot, index ReleaseIndex) error {
	if contains(root.metadata.Revocations.ReleaseVersions, index.Version) {
		return errors.New("release version is revoked")
	}
	digests := []string{index.ArtifactSetDigest}
	for _, assets := range []map[string]Asset{index.Application, index.DependencyLayer, index.LifecycleHost, index.Signer} {
		for _, asset := range assets {
			digests = append(digests, asset.SHA256)
		}
	}
	for _, digest := range digests {
		if contains(root.metadata.Revocations.TargetDigests, digest) {
			return errors.New("release target is revoked")
		}
	}
	return nil
}
