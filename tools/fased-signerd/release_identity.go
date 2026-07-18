package main

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// These values are intentionally strings so release builders can set them
// with Go -ldflags -X. Unstamped source/test builds remain explicit development
// identities and must never satisfy a production updater's exact-match gate.
var (
	signerBuildVersion     = "dev"
	signerBuildCommit      = "unknown"
	signerBuildInputDigest = "unknown"
	signerBuildDevelopment = "true"
)

var (
	signerReleaseVersionPatternV2 = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
	signerReleaseCommitPatternV2  = regexp.MustCompile(`^[a-f0-9]{40}$`)
	signerReleaseDigestPatternV2  = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

type signerReleaseIdentityV2 struct {
	Version          string `json:"version"`
	Commit           string `json:"commit"`
	BuildInputDigest string `json:"buildInputDigest"`
	Development      bool   `json:"development"`
}

func resolveSignerReleaseIdentityV2(version, commit, digest, development string) (signerReleaseIdentityV2, error) {
	version = strings.TrimSpace(version)
	commit = strings.TrimSpace(commit)
	digest = strings.TrimSpace(digest)
	if version == "" || commit == "" || digest == "" || strings.TrimSpace(development) == "" {
		return signerReleaseIdentityV2{}, errors.New("signer release identity ldflags must not be empty")
	}
	developmentBuild, err := strconv.ParseBool(strings.TrimSpace(development))
	if err != nil {
		return signerReleaseIdentityV2{}, errors.New("signer release development marker must be true or false")
	}
	if developmentBuild {
		if version != "dev" && !signerReleaseVersionPatternV2.MatchString(version) {
			return signerReleaseIdentityV2{}, errors.New("development signer version is invalid")
		}
		if commit != "unknown" && !signerReleaseCommitPatternV2.MatchString(commit) {
			return signerReleaseIdentityV2{}, errors.New("development signer commit is invalid")
		}
		if digest != "unknown" && !signerReleaseDigestPatternV2.MatchString(digest) {
			return signerReleaseIdentityV2{}, errors.New("development signer build-input digest is invalid")
		}
	} else {
		if !signerReleaseVersionPatternV2.MatchString(version) {
			return signerReleaseIdentityV2{}, errors.New("release signer version must be canonical semver")
		}
		if !signerReleaseCommitPatternV2.MatchString(commit) {
			return signerReleaseIdentityV2{}, errors.New("release signer commit must be a full lowercase Git commit")
		}
		if !signerReleaseDigestPatternV2.MatchString(digest) {
			return signerReleaseIdentityV2{}, errors.New("release signer build-input digest must be sha256")
		}
	}
	return signerReleaseIdentityV2{
		Version:          version,
		Commit:           commit,
		BuildInputDigest: digest,
		Development:      developmentBuild,
	}, nil
}

func signerReleaseIdentity() (signerReleaseIdentityV2, error) {
	return resolveSignerReleaseIdentityV2(
		signerBuildVersion,
		signerBuildCommit,
		signerBuildInputDigest,
		signerBuildDevelopment,
	)
}

func formatSignerVersionV2(identity signerReleaseIdentityV2) string {
	return fmt.Sprintf(
		"fased-signerd %s commit=%s buildInputDigest=%s development=%t",
		identity.Version,
		identity.Commit,
		identity.BuildInputDigest,
		identity.Development,
	)
}
