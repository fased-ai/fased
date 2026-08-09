// Package candidate verifies the public release descriptor and GitHub
// attestation before privileged staging accepts acquired bytes.
package candidate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
)

var (
	versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$`)
	namePattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$`)
	digestPattern  = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

type Artifact struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}
type Descriptor struct {
	SchemaVersion      uint32     `json:"schemaVersion"`
	Version            string     `json:"version"`
	Commit             string     `json:"commit"`
	Tree               string     `json:"tree"`
	LockfileDigest     string     `json:"lockfileDigest"`
	SourceRef          string     `json:"sourceRef"`
	WorkflowRunID      string     `json:"workflowRunId"`
	WorkflowRunAttempt string     `json:"workflowRunAttempt"`
	ArtifactSetDigest  string     `json:"artifactSetDigest"`
	Artifacts          []Artifact `json:"artifacts"`
}

type AttestationVerifier interface {
	Verify(context.Context, string, string, string) error
}

type GitHubVerifier struct{ Binary string }

func (verifier GitHubVerifier) Verify(ctx context.Context, descriptor, bundle, version string) error {
	if verifier.Binary != "/usr/bin/gh" && verifier.Binary != "/usr/local/bin/gh" {
		return errors.New("GitHub verifier must use a fixed executable")
	}
	output, err := exec.CommandContext(ctx, verifier.Binary, "attestation", "verify", descriptor, "--repo", "fased-ai/fased", "--bundle", bundle,
		"--signer-workflow", "fased-ai/fased/.github/workflows/hosted-runtime-release.yml", "--source-ref", "refs/tags/v"+version, "--deny-self-hosted-runners").CombinedOutput()
	if err != nil {
		return fmt.Errorf("candidate attestation verification failed: %w: %s", err, output)
	}
	return nil
}

func Verify(ctx context.Context, verifier AttestationVerifier, descriptorPath, bundlePath, version string, files map[string]string) (Descriptor, error) {
	if verifier == nil || !versionPattern.MatchString(version) {
		return Descriptor{}, errors.New("candidate verifier input is invalid")
	}
	for _, evidencePath := range []string{descriptorPath, bundlePath} {
		info, err := os.Lstat(evidencePath)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > 4<<20 {
			return Descriptor{}, errors.New("candidate evidence is unavailable or unsafe")
		}
	}
	if err := verifier.Verify(ctx, descriptorPath, bundlePath, version); err != nil {
		return Descriptor{}, err
	}
	data, err := os.ReadFile(descriptorPath)
	if err != nil || len(data) > 4<<20 {
		return Descriptor{}, errors.New("candidate descriptor is unavailable or oversized")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var descriptor Descriptor
	if decoder.Decode(&descriptor) != nil || decoder.Decode(&struct{}{}) != io.EOF || descriptor.SchemaVersion != 3 || descriptor.Version != version || descriptor.SourceRef != "refs/tags/v"+version ||
		!regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(descriptor.Commit) || !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(descriptor.Tree) ||
		!digestPattern.MatchString(descriptor.LockfileDigest) || !digestPattern.MatchString(descriptor.ArtifactSetDigest) || len(descriptor.Artifacts) == 0 {
		return Descriptor{}, errors.New("candidate descriptor identity is invalid")
	}
	previous := ""
	bound := map[string]Artifact{}
	for _, artifact := range descriptor.Artifacts {
		if !namePattern.MatchString(artifact.Name) || !digestPattern.MatchString(artifact.SHA256) || artifact.Size <= 0 || artifact.Name <= previous {
			return Descriptor{}, errors.New("candidate artifact inventory is invalid")
		}
		previous = artifact.Name
		bound[artifact.Name] = artifact
	}
	canonical, _ := json.Marshal(descriptor.Artifacts)
	setDigest := sha256.Sum256(canonical)
	if "sha256:"+hex.EncodeToString(setDigest[:]) != descriptor.ArtifactSetDigest {
		return Descriptor{}, errors.New("candidate artifact-set digest is invalid")
	}
	for name, path := range files {
		artifact, ok := bound[name]
		if !ok {
			return Descriptor{}, fmt.Errorf("candidate descriptor omits %s", name)
		}
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() != artifact.Size {
			return Descriptor{}, fmt.Errorf("candidate artifact %s identity is unsafe", name)
		}
		digest, err := fileDigest(path)
		if err != nil || digest != artifact.SHA256 {
			return Descriptor{}, fmt.Errorf("candidate artifact %s digest differs", name)
		}
	}
	return descriptor, nil
}

func fileDigest(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}
