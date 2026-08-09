package candidate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type fakeVerifier struct{ calls int }

func (verifier *fakeVerifier) Verify(context.Context, string, string, string) error {
	verifier.calls++
	return nil
}

func TestCandidateVerificationBindsAttestationAndExactFiles(t *testing.T) {
	root := t.TempDir()
	artifactPath := filepath.Join(root, "generation.tar.gz")
	if err := os.WriteFile(artifactPath, []byte("exact"), 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("exact"))
	artifacts := []Artifact{{Name: "generation.tar.gz", SHA256: "sha256:" + hex.EncodeToString(digest[:]), Size: 5}}
	canonical, _ := json.Marshal(artifacts)
	set := sha256.Sum256(canonical)
	descriptor := Descriptor{SchemaVersion: 3, Version: "1.2.3", Commit: "a000000000000000000000000000000000000000", Tree: "b000000000000000000000000000000000000000", LockfileDigest: "sha256:" + string(make([]byte, 64)), SourceRef: "refs/tags/v1.2.3", WorkflowRunID: "1", WorkflowRunAttempt: "1", ArtifactSetDigest: "sha256:" + hex.EncodeToString(set[:]), Artifacts: artifacts}
	// Replace NULs in the fixture digest with a valid hexadecimal value.
	descriptor.LockfileDigest = "sha256:" + "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	descriptorPath := filepath.Join(root, "candidate.json")
	data, _ := json.Marshal(descriptor)
	if err := os.WriteFile(descriptorPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	bundlePath := filepath.Join(root, "attestation.json")
	_ = os.WriteFile(bundlePath, []byte("bundle"), 0o600)
	verifier := &fakeVerifier{}
	if _, err := Verify(context.Background(), verifier, descriptorPath, bundlePath, "1.2.3", map[string]string{"generation.tar.gz": artifactPath}); err != nil {
		t.Fatal(err)
	}
	if verifier.calls != 1 {
		t.Fatal("attestation verifier was not called exactly once")
	}
	if err := os.WriteFile(artifactPath, []byte("wrong"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(context.Background(), verifier, descriptorPath, bundlePath, "1.2.3", map[string]string{"generation.tar.gz": artifactPath}); err == nil {
		t.Fatal("changed candidate bytes were accepted")
	}
}

func TestCandidateVerificationRejectsTrailingDescriptorAndSymlinkEvidence(t *testing.T) {
	root := t.TempDir()
	artifactPath := filepath.Join(root, "generation.tar.gz")
	if err := os.WriteFile(artifactPath, []byte("exact"), 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("exact"))
	artifacts := []Artifact{{Name: "generation.tar.gz", SHA256: "sha256:" + hex.EncodeToString(digest[:]), Size: 5}}
	canonical, _ := json.Marshal(artifacts)
	set := sha256.Sum256(canonical)
	descriptor := Descriptor{
		SchemaVersion: 3, Version: "1.2.3", Commit: "a000000000000000000000000000000000000000",
		Tree: "b000000000000000000000000000000000000000", LockfileDigest: "sha256:" + "c" + string(make([]byte, 63)),
		SourceRef: "refs/tags/v1.2.3", WorkflowRunID: "1", WorkflowRunAttempt: "1",
		ArtifactSetDigest: "sha256:" + hex.EncodeToString(set[:]), Artifacts: artifacts,
	}
	descriptor.LockfileDigest = "sha256:" + "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	data, _ := json.Marshal(descriptor)
	descriptorPath := filepath.Join(root, "candidate.json")
	if err := os.WriteFile(descriptorPath, append(data, []byte("{}")...), 0o600); err != nil {
		t.Fatal(err)
	}
	bundlePath := filepath.Join(root, "attestation.json")
	if err := os.WriteFile(bundlePath, []byte("bundle"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(context.Background(), &fakeVerifier{}, descriptorPath, bundlePath, "1.2.3", map[string]string{"generation.tar.gz": artifactPath}); err == nil {
		t.Fatal("descriptor with trailing JSON was accepted")
	}
	if err := os.WriteFile(descriptorPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	symlinkBundle := filepath.Join(root, "attestation-link.json")
	if err := os.Symlink(bundlePath, symlinkBundle); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(context.Background(), &fakeVerifier{}, descriptorPath, symlinkBundle, "1.2.3", map[string]string{"generation.tar.gz": artifactPath}); err == nil {
		t.Fatal("symlink attestation bundle was accepted")
	}
}
