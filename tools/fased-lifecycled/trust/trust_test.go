package trust

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"fased-lifecycled/model"
	sigroot "github.com/sigstore/sigstore-go/pkg/root"
)

type testKey struct {
	id      string
	record  Key
	private ed25519.PrivateKey
}

func newTestKey(t *testing.T) testKey {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(der)
	return testKey{id: hex.EncodeToString(sum[:]), record: Key{KeyType: "ed25519", Scheme: "ed25519", PublicKey: base64.StdEncoding.EncodeToString(der)}, private: private}
}

func testRoot(t *testing.T, now time.Time) ([]byte, []testKey) {
	t.Helper()
	keys := []testKey{newTestKey(t), newTestKey(t), newTestKey(t)}
	signed := RootMetadata{SchemaVersion: 1, Type: "fased-lifecycle-root", Version: 1,
		IssuedAt: now.Add(-time.Hour).Format(time.RFC3339), ExpiresAt: now.Add(24 * time.Hour).Format(time.RFC3339),
		Keys: map[string]Key{}, Root: RootRole{Threshold: 2}, ReleaseAuthority: testReleaseAuthority(), Revocations: Revocations{ReleaseVersions: []string{}, TargetDigests: []string{}, DelegatedKeyIDs: []string{}}}
	for _, key := range keys {
		signed.Keys[key.id] = key.record
		signed.Root.KeyIDs = append(signed.Root.KeyIDs, key.id)
	}
	sortStrings(signed.Root.KeyIDs)
	data, err := SignRoot(signed, []SigningKey{{KeyID: keys[0].id, PrivateKey: keys[0].private}, {KeyID: keys[1].id, PrivateKey: keys[1].private}})
	if err != nil {
		t.Fatal(err)
	}
	return data, keys
}

func TestRootDelegationAndReleaseIndexVerification(t *testing.T) {
	now := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
	rootJSON, rootKeys := testRoot(t, now)
	pin := sha256.Sum256(rootJSON)
	root, err := VerifyInitialRoot(rootJSON, hex.EncodeToString(pin[:]), now)
	if err != nil {
		t.Fatal(err)
	}

	releaseKey := newTestKey(t)
	delegationJSON, err := SignDelegation(Delegation{SchemaVersion: 1, Type: "fased-release-delegation", Version: 1,
		IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339),
		KeyID: releaseKey.id, Key: releaseKey.record, Channels: []string{"beta", "stable"}, MinReleaseSequence: 10, MaxReleaseSequence: 20, SecurityEpoch: 3,
	}, []SigningKey{{KeyID: rootKeys[0].id, PrivateKey: rootKeys[0].private}, {KeyID: rootKeys[1].id, PrivateKey: rootKeys[1].private}})
	if err != nil {
		t.Fatal(err)
	}
	delegation, err := VerifyDelegation(root, delegationJSON, now)
	if err != nil {
		t.Fatal(err)
	}
	revokedRoot := root
	revokedRoot.metadata.Revocations.DelegatedKeyIDs = []string{releaseKey.id}
	if _, err := VerifyDelegation(revokedRoot, delegationJSON, now); err == nil {
		t.Fatal("revoked delegated key was accepted")
	}

	index := ReleaseIndex{SchemaVersion: 1, Type: "fased-release-index", Channel: "beta", Version: "0.1.76-rc.74",
		ReleaseSequence: 12, SecurityEpoch: 3, Commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Tree: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		ArtifactSetDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", PluginLockDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(30 * time.Minute).Format(time.RFC3339),
		Application: testAssets(), DependencyLayer: testAssets(), LifecycleHost: testHostAssets(), Signer: testAssets(), StateSchemas: map[string]uint32{"signer": 2},
		Capabilities: model.CapabilityRanges{Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1}, Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1}},
	}
	indexJSON, err := SignReleaseIndex(index, SigningKey{KeyID: releaseKey.id, PrivateKey: releaseKey.private})
	if err != nil {
		t.Fatal(err)
	}
	verified, err := VerifyReleaseIndex(delegation, indexJSON, now)
	if err != nil {
		t.Fatal(err)
	}
	verifiedIndex := verified.Index()
	if verifiedIndex.ReleaseSequence != 12 || verifiedIndex.SecurityEpoch != 3 {
		t.Fatalf("authority lost: %+v", verifiedIndex)
	}

	tampered := append([]byte(nil), indexJSON...)
	for i := range tampered {
		if tampered[i] == '4' {
			tampered[i] = '5'
			break
		}
	}
	if _, err := VerifyReleaseIndex(delegation, tampered, now); err == nil {
		t.Fatal("tampered release index was accepted")
	}
	outsideDelegation := index
	outsideDelegation.ReleaseSequence = 21
	outsideJSON, err := SignReleaseIndex(outsideDelegation, SigningKey{KeyID: releaseKey.id, PrivateKey: releaseKey.private})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyReleaseIndex(delegation, outsideJSON, now); err == nil {
		t.Fatal("release sequence outside delegated authority was accepted")
	}
}

func TestGoVerifierAcceptsExistingProductionRoot(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "release", "lifecycle-trust", "root-v1", "fased-lifecycle-root-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	root, err := VerifyInitialRoot(data, "23d3e8235a39729d6ae37a5784eaa717a47e4ac725f5a416e78754ad9b4618ca", time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("existing production root is not Go-compatible: %v", err)
	}
	authority := root.ReleaseAuthority()
	if authority.Repository != "fased-ai/fased" ||
		authority.Workflow != "fased-ai/fased/.github/workflows/hosted-runtime-release.yml" ||
		authority.SourceRefPrefix != "refs/tags/v" || !authority.DenySelfHostedRunners {
		t.Fatalf("existing production release authority was not bound: %+v", authority)
	}
}

func TestGitHubArtifactAttestationVerificationBindsExactAuthority(t *testing.T) {
	trusted, err := sigroot.NewTrustedRootFromJSON(sigstorePublicGoodTrustedRoot)
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := os.ReadFile(filepath.Join("testdata", "fased-hosted-release-v2.fixture"))
	if err != nil {
		t.Fatal(err)
	}
	bundleJSON, err := os.ReadFile(filepath.Join("testdata", "fased-hosted-release-v2.attestation.fixture"))
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(artifact)
	expected := githubAttestationExpectation{
		Repository: "fased-ai/fased", Workflow: "fased-ai/fased/.github/workflows/hosted-runtime-release.yml",
		SourceRef: "refs/tags/v0.1.76-rc.74", Commit: "2ab10b11fd4bd01678a115be05308d37bfba1a50",
		SubjectName: "fased-hosted-release-v2.json", DigestAlgorithm: "sha256", Digest: digest[:],
		DenySelfHosted: true,
	}
	if _, err := verifyGitHubArtifactAttestation(trusted, bundleJSON, expected); err != nil {
		t.Fatalf("public-good attestation was rejected: %v", err)
	}
	mutations := []struct {
		name string
		edit func(*githubAttestationExpectation)
	}{
		{"repository", func(candidate *githubAttestationExpectation) { candidate.Repository = "attacker/fork" }},
		{"workflow", func(candidate *githubAttestationExpectation) {
			candidate.Workflow = "sigstore/sigstore-js/.github/workflows/other.yml"
		}},
		{"source ref", func(candidate *githubAttestationExpectation) { candidate.SourceRef = "refs/tags/v2.0.0" }},
		{"commit", func(candidate *githubAttestationExpectation) {
			candidate.Commit = "0000000000000000000000000000000000000000"
		}},
		{"subject", func(candidate *githubAttestationExpectation) { candidate.SubjectName = "attacker" }},
		{"digest", func(candidate *githubAttestationExpectation) { candidate.Digest[0] ^= 0xff }},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			candidate := expected
			candidate.Digest = append([]byte(nil), expected.Digest...)
			mutation.edit(&candidate)
			if _, err := verifyGitHubArtifactAttestation(trusted, bundleJSON, candidate); err == nil {
				t.Fatal("mutated authority was accepted")
			}
		})
	}
}

func TestEmbeddedSigstoreTrustedRootIsTheReviewedPublicGoodSnapshot(t *testing.T) {
	digest := sha256.Sum256(sigstorePublicGoodTrustedRoot)
	if got := hex.EncodeToString(digest[:]); got != "4364d7724c04cc912ce2a6c45ed2610e8d8d1c4dc857fb500292738d4d9c8d2c" {
		t.Fatalf("embedded Sigstore trusted root changed without review: %s", got)
	}
}

func TestRootRejectsMissingOrWeakenedReleaseAuthority(t *testing.T) {
	now := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
	rootJSON, _ := testRoot(t, now)
	var envelope rawEnvelope
	if err := decodeStrict(rootJSON, &envelope); err != nil {
		t.Fatal(err)
	}
	var metadata RootMetadata
	if err := decodeStrict(envelope.Signed, &metadata); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []func(*RootMetadata){
		func(candidate *RootMetadata) { candidate.ReleaseAuthority = nil },
		func(candidate *RootMetadata) { candidate.ReleaseAuthority.DenySelfHostedRunners = false },
		func(candidate *RootMetadata) { candidate.ReleaseAuthority.Repository = "attacker/fork" },
		func(candidate *RootMetadata) {
			candidate.ReleaseAuthority.Workflow = "attacker/fork/.github/workflows/release.yml"
		},
		func(candidate *RootMetadata) { candidate.ReleaseAuthority.SourceRefPrefix = "refs/heads/" },
	} {
		candidate := metadata
		authority := *metadata.ReleaseAuthority
		candidate.ReleaseAuthority = &authority
		mutation(&candidate)
		if _, err := validateRootMetadata(candidate, now); err == nil {
			t.Fatal("weakened release authority was accepted")
		}
	}
}

func TestDelegationExpiryAndStrictJSONFailClosed(t *testing.T) {
	now := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
	rootJSON, rootKeys := testRoot(t, now)
	pin := sha256.Sum256(rootJSON)
	root, err := VerifyInitialRoot(rootJSON, hex.EncodeToString(pin[:]), now)
	if err != nil {
		t.Fatal(err)
	}
	releaseKey := newTestKey(t)
	delegation := Delegation{SchemaVersion: 1, Type: "fased-release-delegation", Version: 1, IssuedAt: now.Add(-time.Hour).Format(time.RFC3339), ExpiresAt: now.Add(-time.Second).Format(time.RFC3339), KeyID: releaseKey.id, Key: releaseKey.record, Channels: []string{"beta"}, MinReleaseSequence: 1, MaxReleaseSequence: 2, SecurityEpoch: 1}
	data, err := SignDelegation(delegation, []SigningKey{{KeyID: rootKeys[0].id, PrivateKey: rootKeys[0].private}, {KeyID: rootKeys[1].id, PrivateKey: rootKeys[1].private}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyDelegation(root, data, now); err == nil {
		t.Fatal("expired delegation was accepted")
	}
	duplicate := []byte(`{"schemaVersion":1,"schemaVersion":1,"signed":{},"signatures":[]}`)
	if _, err := VerifyDelegation(root, duplicate, now); err == nil {
		t.Fatal("duplicate trust field was accepted")
	}
}

func TestRollbackGrantRequiresRootThresholdAndExactLifetime(t *testing.T) {
	now := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
	rootJSON, rootKeys := testRoot(t, now)
	pin := sha256.Sum256(rootJSON)
	root, err := VerifyInitialRoot(rootJSON, hex.EncodeToString(pin[:]), now)
	if err != nil {
		t.Fatal(err)
	}
	grant := RollbackGrant{SchemaVersion: 1, Type: "fased-rollback-authorization", CurrentGenerationID: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", TargetGenerationID: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", CurrentReleaseSequence: 12, TargetReleaseSequence: 11, SecurityEpoch: 3, Operator: "founder", Reason: "restore known-good generation", IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(4 * time.Minute).Format(time.RFC3339)}
	data, err := SignRollbackGrant(grant, []SigningKey{{KeyID: rootKeys[0].id, PrivateKey: rootKeys[0].private}, {KeyID: rootKeys[1].id, PrivateKey: rootKeys[1].private}})
	if err != nil {
		t.Fatal(err)
	}
	authorization, err := VerifyRollbackGrant(root, data, now)
	if err != nil {
		t.Fatal(err)
	}
	if authorization.TargetReleaseSequence != 11 || authorization.EnvelopeDigest == "" {
		t.Fatalf("rollback authority lost its binding: %+v", authorization)
	}
}

func TestRootRotationRequiresOldAndNewThresholds(t *testing.T) {
	now := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
	rootJSON, oldKeys := testRoot(t, now)
	pin := sha256.Sum256(rootJSON)
	oldRoot, err := VerifyInitialRoot(rootJSON, hex.EncodeToString(pin[:]), now)
	if err != nil {
		t.Fatal(err)
	}
	newKeys := []testKey{newTestKey(t), newTestKey(t), newTestKey(t)}
	metadata := RootMetadata{SchemaVersion: 1, Type: "fased-lifecycle-root", Version: 2, IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(24 * time.Hour).Format(time.RFC3339), Keys: map[string]Key{}, Root: RootRole{Threshold: 2}, ReleaseAuthority: testReleaseAuthority(), Revocations: Revocations{ReleaseVersions: []string{}, TargetDigests: []string{}, DelegatedKeyIDs: []string{}}}
	for _, key := range newKeys {
		metadata.Keys[key.id] = key.record
		metadata.Root.KeyIDs = append(metadata.Root.KeyIDs, key.id)
	}
	sortStrings(metadata.Root.KeyIDs)
	rotation, err := SignRoot(metadata, []SigningKey{{KeyID: oldKeys[0].id, PrivateKey: oldKeys[0].private}, {KeyID: oldKeys[1].id, PrivateKey: oldKeys[1].private}, {KeyID: newKeys[0].id, PrivateKey: newKeys[0].private}, {KeyID: newKeys[1].id, PrivateKey: newKeys[1].private}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyRootRotation(oldRoot, rotation, now); err != nil {
		t.Fatal(err)
	}
	insufficient, err := SignRoot(metadata, []SigningKey{{KeyID: oldKeys[0].id, PrivateKey: oldKeys[0].private}, {KeyID: oldKeys[1].id, PrivateKey: oldKeys[1].private}, {KeyID: newKeys[0].id, PrivateKey: newKeys[0].private}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyRootRotation(oldRoot, insufficient, now); err == nil {
		t.Fatal("root rotation without the new threshold was accepted")
	}
}

func testAssets() map[string]Asset {
	return map[string]Asset{"x64": {Name: "asset-x64", Size: 1, SHA256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
}

func testHostAssets() map[string]Asset {
	protocols := &HostProtocols{Manifest: ProtocolRange{Min: 2, Max: 2}, Journal: ProtocolRange{Min: 1, Max: 1}, Participant: ProtocolRange{Min: 1, Max: 1}, Platform: ProtocolRange{Min: 1, Max: 2}}
	return map[string]Asset{"x64": {Name: "fased-lifecycled-linux-x64", Size: 1, SHA256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", PrivilegedComponent: "lifecycle-host", Protocols: protocols}}
}

func testReleaseAuthority() *ReleaseAuthority {
	return &ReleaseAuthority{
		Type: githubArtifactAttestationAuthority, Repository: "fased-ai/fased",
		Workflow:        "fased-ai/fased/.github/workflows/hosted-runtime-release.yml",
		SourceRefPrefix: githubArtifactAttestationRefPrefix, DenySelfHostedRunners: true,
	}
}
