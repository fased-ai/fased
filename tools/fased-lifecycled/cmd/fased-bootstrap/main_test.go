package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"fased-lifecycled/host"
	"fased-lifecycled/hostsecurity"
	"fased-lifecycled/model"
	"fased-lifecycled/platform"
	"fased-lifecycled/protocol"
	"fased-lifecycled/trust"
)

type fixtureKey struct {
	id      string
	record  trust.Key
	private ed25519.PrivateKey
}

func fixtureKeyPair(t *testing.T) fixtureKey {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(der)
	return fixtureKey{id: hex.EncodeToString(digest[:]), record: trust.Key{KeyType: "ed25519", Scheme: "ed25519", PublicKey: base64.StdEncoding.EncodeToString(der)}, private: private}
}

func TestOfflineRootBootstrapStagesAndExecutesVerifiedHost(t *testing.T) {
	if os.Getenv("FASED_TEST_HOST_HELPER") == "1" {
		return
	}
	oldMask := syscall.Umask(0o077)
	defer syscall.Umask(oldMask)
	now := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
	rootKeys := []fixtureKey{fixtureKeyPair(t), fixtureKeyPair(t), fixtureKeyPair(t)}
	metadata := trust.RootMetadata{SchemaVersion: 1, Type: "fased-lifecycle-root", Version: 1, IssuedAt: now.Add(-time.Hour).Format(time.RFC3339), ExpiresAt: now.Add(24 * time.Hour).Format(time.RFC3339), Keys: map[string]trust.Key{}, Root: trust.RootRole{Threshold: 2}, ReleaseAuthority: &trust.ReleaseAuthority{Type: "github-artifact-attestation-v1", Repository: "fased-ai/fased", Workflow: "fased-ai/fased/.github/workflows/hosted-runtime-release.yml", SourceRefPrefix: "refs/tags/v", DenySelfHostedRunners: true}, Revocations: trust.Revocations{ReleaseVersions: []string{}, TargetDigests: []string{}, DelegatedKeyIDs: []string{}}}
	for _, key := range rootKeys {
		metadata.Keys[key.id] = key.record
		metadata.Root.KeyIDs = append(metadata.Root.KeyIDs, key.id)
	}
	sortStrings(metadata.Root.KeyIDs)
	rootJSON, err := trust.SignRoot(metadata, []trust.SigningKey{{KeyID: rootKeys[0].id, PrivateKey: rootKeys[0].private}, {KeyID: rootKeys[1].id, PrivateKey: rootKeys[1].private}})
	if err != nil {
		t.Fatal(err)
	}
	rootDigest := sha256.Sum256(rootJSON)
	executable, err := os.ReadFile(mustExecutable(t))
	if err != nil {
		t.Fatal(err)
	}
	hostDigest := sha256.Sum256(executable)
	hostAsset := trust.Asset{Name: "fased-lifecycled-linux-x64", Size: uint64(len(executable)), SHA256: fmt.Sprintf("sha256:%x", hostDigest), PrivilegedComponent: "lifecycle-host", Protocols: &trust.HostProtocols{Manifest: trust.ProtocolRange{Min: 2, Max: 2}, Journal: trust.ProtocolRange{Min: 1, Max: 1}, Participant: trust.ProtocolRange{Min: 1, Max: 1}, Platform: trust.ProtocolRange{Min: 1, Max: 2}}}
	fixtureAsset := func(name, body string) (trust.Asset, []byte) {
		data := []byte(body)
		digest := sha256.Sum256(data)
		return trust.Asset{Name: name, Size: uint64(len(data)), SHA256: fmt.Sprintf("sha256:%x", digest)}, data
	}
	applicationAsset, applicationBytes := fixtureAsset("application.tar.gz", "application")
	dependencyAsset, dependencyBytes := fixtureAsset("dependencies.tar.gz", "dependencies")
	signerAsset, signerBytes := fixtureAsset("fased-signerd-linux-amd64", "signer")
	index := trust.ReleaseIndex{SchemaVersion: 1, Type: "fased-release-index", Channel: "beta", Version: "0.1.76-rc.74", ReleaseSequence: 42, SecurityEpoch: 3, Commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Tree: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ArtifactSetDigest: applicationAsset.SHA256, Application: map[string]trust.Asset{"x64": applicationAsset}, DependencyLayer: map[string]trust.Asset{"x64": dependencyAsset}, LifecycleHost: map[string]trust.Asset{"x64": hostAsset}, Signer: map[string]trust.Asset{"x64": signerAsset}, StateSchemas: map[string]uint32{"signer": 2}, Capabilities: model.CapabilityRanges{Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1}, Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1}}, PluginLockDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(30 * time.Minute).Format(time.RFC3339)}
	indexJSON, err := trust.EncodeReleaseIndex(index)
	if err != nil {
		t.Fatal(err)
	}
	indexAttestation := []byte("fixture attestation")
	assets := map[string][]byte{
		"/root.json": rootJSON, "/index.json": indexJSON, "/index.attestation.json": indexAttestation,
		"/release/" + hostAsset.Name: executable, "/release/" + applicationAsset.Name: applicationBytes,
		"/release/" + dependencyAsset.Name: dependencyBytes, "/release/" + signerAsset.Name: signerBytes,
	}
	fixtureRoot := bootstrapFixtureRoot(t)
	requestedPaths := []string{}
	client := &http.Client{Transport: bootstrapRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		requestedPaths = append(requestedPaths, request.URL.Path)
		if request.URL.Path == "/release/"+signerAsset.Name {
			if _, err := os.Lstat(filepath.Join(fixtureRoot, "host", "host-current")); !os.IsNotExist(err) {
				t.Fatalf("lifecycle host activated before the complete indexed object set was acquired: %v", err)
			}
		}
		data, ok := assets[request.URL.Path]
		if !ok {
			return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader("missing")), Request: request}, nil
		}
		return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(data)), Header: http.Header{"Content-Length": []string{fmt.Sprint(len(data))}}, Body: io.NopCloser(strings.NewReader(string(data))), Request: request}, nil
	})}
	request := bootstrapRequest{StateRoot: filepath.Join(fixtureRoot, "state"), HostRoot: filepath.Join(fixtureRoot, "host"), RootURL: "https://fixture.invalid/root.json", IndexURL: "https://fixture.invalid/index.json", IndexAttestationURL: "https://fixture.invalid/index.attestation.json", ReleaseBaseURL: "https://fixture.invalid/release", Channel: "beta", Version: index.Version, Architecture: "x64", PinnedRootSHA256: hex.EncodeToString(rootDigest[:]), OwnerUID: uint32(os.Geteuid()), Client: client, Now: now, VerifyIndex: func(root trust.VerifiedRoot, indexJSON, bundleJSON []byte, now time.Time) (bootstrapVerifiedReleaseIndex, error) {
		if string(bundleJSON) != string(indexAttestation) {
			t.Fatal("bootstrap did not pass the fetched attestation bundle to the verifier")
		}
		decoded, decodeErr := trust.DecodeReleaseIndex(indexJSON)
		if decodeErr != nil {
			return bootstrapVerifiedReleaseIndex{}, decodeErr
		}
		indexDigest := sha256.Sum256(indexJSON)
		authorityDigest := sha256.Sum256(bundleJSON)
		return bootstrapVerifiedReleaseIndex{Index: decoded, Digest: hex.EncodeToString(indexDigest[:]), ReleaseAuthorityDigest: hex.EncodeToString(authorityDigest[:])}, nil
	}, Inspect: func(ctx context.Context, candidate host.StagedHost) error {
		command := exec.CommandContext(ctx, candidate.Path, "-test.run=TestOfflineRootBootstrapStagesAndExecutesVerifiedHost")
		command.Env = append(os.Environ(), "FASED_TEST_HOST_HELPER=1")
		return command.Run()
	}}
	result, err := execute(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.ReleaseSequence != 42 || result.SecurityEpoch != 3 || result.HostDigest != hex.EncodeToString(hostDigest[:]) {
		t.Fatalf("bootstrap result lost signed identity: %+v", result)
	}
	if !strings.HasPrefix(result.ReleaseIndexDigest, "sha256:") || len(result.ReleaseIndexDigest) != 71 ||
		!strings.HasPrefix(result.ReleaseAuthorityDigest, "sha256:") || len(result.ReleaseAuthorityDigest) != 71 {
		t.Fatalf("bootstrap result lost algorithm-bound trust digests: %+v", result)
	}
	wantArtifactTransferred := hostAsset.Size + applicationAsset.Size + dependencyAsset.Size + signerAsset.Size
	wantMetadataTransferred := uint64(len(rootJSON) + len(indexJSON) + len(indexAttestation))
	wantTransferred := wantArtifactTransferred + wantMetadataTransferred
	if result.Performance.TransferredBytes != wantTransferred || result.Performance.ArtifactTransferredBytes != wantArtifactTransferred ||
		result.Performance.MetadataTransferredBytes != wantMetadataTransferred || result.Performance.CacheHits != 0 || result.Performance.CacheMisses != 4 ||
		result.Performance.MetadataMillis == 0 || result.Performance.SignatureVerificationMillis == 0 || result.Performance.AssetAcquisitionMillis == 0 ||
		result.Performance.ExtractionMillis == 0 || result.Performance.FsyncMillis == 0 || result.Performance.ActivationMillis == 0 || result.Performance.TotalMillis == 0 {
		t.Fatalf("bootstrap performance evidence is incomplete: %+v", result.Performance)
	}
	if current, err := os.ReadFile(filepath.Join(fixtureRoot, "host", "host-current")); err != nil || string(current) != result.HostDigest+"\n" {
		t.Fatalf("host pointer was not committed: %q err=%v", current, err)
	}
	for _, path := range []string{result.ApplicationPath, result.DependencyPath, result.SignerPath} {
		if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
			t.Fatalf("indexed release asset was not retained in the verified inbox: %s err=%v", path, err)
		}
	}
	for _, obsolete := range requestedPaths {
		if strings.Contains(strings.ToLower(obsolete), "delegation") {
			t.Fatalf("bootstrap fetched obsolete delegation metadata: %v", requestedPaths)
		}
	}
	warmResult, err := execute(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if warmResult.Performance.TransferredBytes != wantMetadataTransferred || warmResult.Performance.ArtifactTransferredBytes != 0 ||
		warmResult.Performance.MetadataTransferredBytes != wantMetadataTransferred || warmResult.Performance.CacheHits != 4 || warmResult.Performance.CacheMisses != 0 {
		t.Fatalf("warm bootstrap did not reuse the verified inbox: %+v", warmResult.Performance)
	}
}

func TestBootstrapRejectsCallerSelectedTrustPinAndNonHTTPS(t *testing.T) {
	request := bootstrapRequest{StateRoot: "/var/lib/fased-lifecycled", HostRoot: "/opt/fased/lifecycle", RootURL: "http://example.invalid/root", IndexURL: "https://example.invalid/index", IndexAttestationURL: "https://example.invalid/index.attestation.json", ReleaseBaseURL: "https://example.invalid/release", Channel: "beta", Version: "0.1.0", Architecture: "x64", PinnedRootSHA256: productionPinnedRootSHA256, OwnerUID: uint32(os.Geteuid()), Now: time.Now(), Inspect: func(context.Context, host.StagedHost) error { return nil }}
	if _, err := execute(context.Background(), request); err == nil {
		t.Fatal("plain HTTP root metadata was accepted")
	}
}

func TestBootstrapRejectsObsoleteDelegationSelector(t *testing.T) {
	if err := run([]string{"--delegation-url", "https://example.invalid/delegation.json"}, io.Discard); err == nil {
		t.Fatal("bootstrap accepted the removed delegation selector")
	}
}

func TestPublicBootstrapRequiresTerminalGenerationAndConvergenceDigests(t *testing.T) {
	valid := []byte(`{"schemaVersion":1,"requestId":"018f47d2-5a6b-7c8d-9e0f-123456789abc","outcome":"UPDATED","activeGenerationId":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","convergenceReceiptDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`)
	if _, err := decodeTerminalLifecycleResponse(valid); err != nil {
		t.Fatalf("valid terminal lifecycle response was rejected: %v", err)
	}
	repaired := []byte(strings.Replace(string(valid), `"UPDATED"`, `"REPAIRED"`, 1))
	if _, err := decodeTerminalLifecycleResponse(repaired); err != nil {
		t.Fatalf("valid terminal repair response was rejected: %v", err)
	}
	for name, candidate := range map[string][]byte{
		"failure-outcome": []byte(strings.Replace(string(valid), `"UPDATED"`, `"REPAIR_REQUIRED"`, 1)),
		"missing-receipt": []byte(strings.Replace(string(valid), `"convergenceReceiptDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"`, `"convergenceReceiptDigest":""`, 1)),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeTerminalLifecycleResponse(candidate); err == nil {
				t.Fatal("non-terminal lifecycle response was accepted")
			}
		})
	}
}

func TestLifecyclePerformanceOutputBindsTimingBytesAndCacheEvidence(t *testing.T) {
	formatted := formatLifecyclePerformance(publicLifecyclePerformance{
		ReleaseResolutionMillis: 2,
		ApplyMillis:             7,
		OnboardingMillis:        11,
		TotalMillis:             31,
		TransactionStatus:       "measured",
		Transaction: &protocol.PerformanceEvidence{
			QuiesceMillis: 8, SwitchMillis: 10, ServiceReadinessMillis: 12, TotalMillis: 30,
		},
		Acquisition: bootstrapPerformance{
			MetadataMillis:              1,
			SignatureVerificationMillis: 3,
			AssetAcquisitionMillis:      5,
			ExtractionMillis:            4,
			FsyncMillis:                 9,
			ActivationMillis:            6,
			TransferredBytes:            1234,
			MetadataTransferredBytes:    34,
			ArtifactTransferredBytes:    1200,
			CacheHits:                   3,
			CacheMisses:                 1,
		},
	})
	want := "Lifecycle performance: resolution=2ms metadata=1ms verify=3ms assets=5ms extraction=4ms fsync=9ms activation=6ms transaction=measured quiesce=8ms switch=10ms readiness=12ms apply=7ms onboarding=11ms total=31ms transferred=1234B metadata-bytes=34B artifact-bytes=1200B cache-hits=3 cache-misses=1"
	if formatted != want {
		t.Fatalf("performance evidence changed: %q", formatted)
	}
	legacy := publicLifecyclePerformance{TransactionStatus: transactionPerformanceStatus("UPDATED", nil)}
	if got := formatLifecyclePerformance(legacy); !strings.Contains(got, "transaction=unavailable quiesce=na switch=na readiness=na") {
		t.Fatalf("missing predecessor performance was presented as measured: %q", got)
	}
	noop := publicLifecyclePerformance{TransactionStatus: transactionPerformanceStatus("ALREADY_CURRENT", nil)}
	if got := formatLifecyclePerformance(noop); !strings.Contains(got, "transaction=not-applicable quiesce=na switch=na readiness=na") {
		t.Fatalf("no-op transaction phases were not explicit: %q", got)
	}
}

func TestPublicLifecycleRoutesInstallAndUpdateWithoutCallerTrustSelectors(t *testing.T) {
	t.Setenv("SUDO_USER", "owner")
	install, err := parsePublicLifecycleRequest("install", []string{"--profile", "protected-local", "--channel", "beta", "--version", "0.1.76-rc.74", "--operator-user", "owner", "--no-onboard"})
	if err != nil {
		t.Fatal(err)
	}
	if install.Operation != "install" || install.Profile != model.ProfileProtectedLocal || install.Version != "0.1.76-rc.74" || install.Onboard {
		t.Fatalf("install route was not bound: %+v", install)
	}
	update, err := parsePublicLifecycleRequest("update", []string{"--channel", "stable", "--operator-user", "owner"})
	if err != nil {
		t.Fatal(err)
	}
	if update.Operation != "update" || update.Version != "" || update.Onboard {
		t.Fatalf("update route was not bound: %+v", update)
	}
	if !update.ChannelExplicit {
		t.Fatal("explicit update channel was not distinguished from the default")
	}
	implicit, err := parsePublicLifecycleRequest("update", []string{"--operator-user", "owner"})
	if err != nil || implicit.ChannelExplicit {
		t.Fatalf("implicit update channel was not preserved for installed-policy binding: request=%+v err=%v", implicit, err)
	}
	if update.GatewayPort != 0 {
		t.Fatalf("update invented an installation port: %+v", update)
	}
	if update.Timeout != 8*time.Minute {
		t.Fatalf("update lost its bounded default timeout: %+v", update)
	}
	repair, err := parsePublicLifecycleRequest("repair", []string{"--operator-user", "owner"})
	if err != nil || repair.Operation != "repair" || repair.Version != "" || repair.Onboard {
		t.Fatalf("managed repair route was not bound to installed identity: request=%+v err=%v", repair, err)
	}
	if _, err := parsePublicLifecycleRequest("repair", []string{"--channel", "beta", "--version", "0.1.76-rc.96", "--operator-user", "owner"}); err == nil {
		t.Fatal("managed repair accepted a caller-selected release")
	}
	beta, err := parsePublicLifecycleRequest("update", []string{"--tag", "beta", "--timeout", "120", "--yes", "--operator-user", "owner"})
	if err != nil || beta.Channel != "beta" || beta.Version != "" || beta.Timeout != 2*time.Minute {
		t.Fatalf("managed beta discovery route was not normalized: request=%+v err=%v", beta, err)
	}
	exact, err := parsePublicLifecycleRequest("update", []string{"--channel", "beta", "--tag", "v0.1.77-rc.1", "--operator-user", "owner"})
	if err != nil || exact.Channel != "beta" || exact.Version != "0.1.77-rc.1" {
		t.Fatalf("exact managed update route was not preserved: request=%+v err=%v", exact, err)
	}
	if _, err := parsePublicLifecycleRequest("update", []string{"--channel", "stable", "--operator-user", "owner", "--gateway-port", "19456"}); err == nil {
		t.Fatal("update accepted a caller-selected replacement Gateway port")
	}
	if _, err := parsePublicLifecycleRequest("update", []string{"--timeout", "1801", "--operator-user", "owner"}); err == nil {
		t.Fatal("update accepted an unbounded timeout")
	}
	if _, err := parsePublicLifecycleRequest("update", []string{"--profile", "protected-local", "--profile", "hosting"}); err == nil {
		t.Fatal("update accepted a profile override after its authorized sudo prefix")
	}
	if _, err := parsePublicLifecycleRequest("update", []string{"--profile", "protected-local", "--operator-user", "other"}); err == nil {
		t.Fatal("update accepted an operator other than the authenticated sudo peer")
	}
	hosting, err := parsePublicLifecycleRequest("install", []string{"--profile", "hosting", "--channel", "beta", "--version", "0.1.76-rc.97", "--operator-user", "app", "--ts-authkey-file", "/root/tailscale.key", "--tailnet-access-confirmed"})
	if err != nil || hosting.TailscaleAuthKeyFile != "/root/tailscale.key" || !hosting.TailnetAccessConfirmed {
		t.Fatalf("Hosting security selectors were not bounded: request=%+v err=%v", hosting, err)
	}
	if _, err := parsePublicLifecycleRequest("install", []string{"--profile", "protected-local", "--version", "1.2.3", "--operator-user", "owner", "--ts-authkey-file", "/root/tailscale.key"}); err == nil {
		t.Fatal("Local install accepted Hosting Tailscale authority")
	}
	if _, err := parsePublicLifecycleRequest("update", []string{"--profile", "hosting", "--operator-user", "owner", "--tailnet-access-confirmed"}); err == nil {
		t.Fatal("update accepted an install-only tailnet confirmation")
	}
}

func TestManagedUninstallRejectsLegacyDestructiveScopesBeforeAuthority(t *testing.T) {
	for _, arguments := range [][]string{
		{"--profile", "protected-local", "--operator-user", "owner", "--yes", "--state"},
		{"--profile", "protected-local", "--operator-user", "owner", "--yes", "--workspace"},
		{"--profile", "protected-local", "--operator-user", "owner", "--yes", "--all"},
		{"--profile", "protected-local", "--profile", "hosting", "--operator-user", "owner", "--yes"},
	} {
		if err := runPublicUninstall(arguments, io.Discard); err == nil || !strings.Contains(err.Error(), "invalid managed uninstall") && !strings.Contains(err.Error(), "selected exactly once") {
			t.Fatalf("legacy destructive uninstall selector was accepted: args=%v err=%v", arguments, err)
		}
	}
}

func TestManagedRollbackRequiresExactAuthorizationFileBeforeAuthority(t *testing.T) {
	for _, arguments := range [][]string{
		{"--profile", "protected-local", "--operator-user", "owner"},
		{"--profile", "protected-local", "--profile", "hosting", "--operator-user", "owner", "--authorization-file", "/tmp/grant.json"},
		{"--profile", "protected-local", "--operator-user", "owner", "--authorization-file", "relative.json"},
		{"--profile", "protected-local", "--operator-user", "owner", "--authorization-file", "/tmp/grant.json", "--timeout", "601"},
	} {
		if err := runPublicRollback(arguments, io.Discard); err == nil || !strings.Contains(err.Error(), "invalid managed rollback") && !strings.Contains(err.Error(), "selected exactly once") {
			t.Fatalf("unsafe rollback arguments were accepted: args=%v err=%v", arguments, err)
		}
	}
}

func TestRollbackInputReaderRequiresOneBoundSecureFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "grant.json")
	if err := os.WriteFile(path, []byte("signed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := readSecureRollbackInput(path, 64, uint32(os.Geteuid()))
	if err != nil || string(data) != "signed\n" {
		t.Fatalf("secure rollback input rejected: data=%q err=%v", data, err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readSecureRollbackInput(path, 64, uint32(os.Geteuid())); err == nil {
		t.Fatal("group/world-readable rollback input was accepted")
	}
	link := filepath.Join(root, "grant-link.json")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readSecureRollbackInput(link, 64, uint32(os.Geteuid())); err == nil {
		t.Fatal("symlinked rollback input was accepted")
	}
}

func TestInstalledUpdateChannelUsesRootPolicyAndBoundsLegacyInference(t *testing.T) {
	request := publicLifecycleRequest{Operation: "update", Channel: "stable"}
	if err := bindInstalledUpdateChannel(&request, "beta", installedLifecycleStatus{Version: "0.1.76-rc.96"}); err != nil || request.Channel != "beta" {
		t.Fatalf("root-owned beta policy was not selected: request=%+v err=%v", request, err)
	}
	explicit := publicLifecycleRequest{Operation: "update", Channel: "stable", ChannelExplicit: true}
	if err := bindInstalledUpdateChannel(&explicit, "beta", installedLifecycleStatus{Version: "0.1.76-rc.96"}); err != nil || explicit.Channel != "stable" {
		t.Fatalf("explicit channel selection was overwritten: request=%+v err=%v", explicit, err)
	}
	legacy := publicLifecycleRequest{Operation: "update", Channel: "stable"}
	if err := bindInstalledUpdateChannel(&legacy, "", installedLifecycleStatus{Version: "0.1.76-rc.96"}); err != nil || legacy.Channel != "beta" {
		t.Fatalf("legacy prerelease channel was not inferred once: request=%+v err=%v", legacy, err)
	}
	stable := publicLifecycleRequest{Operation: "update", Channel: "stable"}
	if err := bindInstalledUpdateChannel(&stable, "", installedLifecycleStatus{Version: "0.1.75"}); err != nil || stable.Channel != "stable" {
		t.Fatalf("legacy stable channel inference changed: request=%+v err=%v", stable, err)
	}
	unknown := publicLifecycleRequest{Operation: "update", Channel: "stable"}
	if err := bindInstalledUpdateChannel(&unknown, "nightly", installedLifecycleStatus{Version: "0.1.75"}); err == nil {
		t.Fatal("unknown installed update policy was accepted")
	}
}

func TestInstalledLifecycleStatusIsBoundToCanonicalPlatformIdentity(t *testing.T) {
	config, err := platform.NewConfig(
		model.ProfileProtectedLocal, "0123456789abcdef", "/home/owner/.fased",
		platform.Principal{UID: 1000, GID: 1000}, platform.Principal{UID: 1001, GID: 1001}, platform.Principal{UID: 1002, GID: 1002},
	)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := config.Identity()
	if err != nil {
		t.Fatal(err)
	}
	digest := "sha256:" + strings.Repeat("a", 64)
	generation := model.Generation{ID: digest, Version: "0.1.76-rc.90", Commit: strings.Repeat("b", 40), Tree: strings.Repeat("c", 40), ArtifactSetDigest: digest}
	capability := model.CapabilityRange{Min: 1, Max: 1}
	manifest := model.Manifest{
		SchemaVersion: model.CurrentManifestSchemaVersion, Profile: config.Profile, Platform: identity,
		ActiveGeneration: &generation, StateSchemas: map[string]uint32{"signer": 2},
		Capabilities:    model.CapabilityRanges{Supervisor: capability, Controller: capability, Migrator: capability, Signer: capability},
		ReleaseSequence: 12, SecurityEpoch: 3,
	}
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	status, err := decodeInstalledLifecycleStatus(config, config.Profile, manifestData)
	if err != nil {
		t.Fatal(err)
	}
	if status.Version != generation.Version || status.ActiveGenerationID != generation.ID || status.ReleaseSequence != 12 || status.SecurityEpoch != 3 {
		t.Fatalf("installed lifecycle status lost canonical identity: %+v", status)
	}

	manifest.Platform.ConfigurationDigest = "sha256:" + strings.Repeat("d", 64)
	manifestData, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeInstalledLifecycleStatus(config, config.Profile, manifestData); err == nil {
		t.Fatal("status accepted a manifest bound to a different platform configuration")
	}
}

func TestPublicUpdateSelectsAnAttestedReplayProtectedChannelIndex(t *testing.T) {
	now := time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
	rootKeys := []fixtureKey{fixtureKeyPair(t), fixtureKeyPair(t), fixtureKeyPair(t)}
	rootMetadata := trust.RootMetadata{SchemaVersion: 1, Type: "fased-lifecycle-root", Version: 1,
		IssuedAt: now.Add(-time.Hour).Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339),
		Keys: map[string]trust.Key{}, Root: trust.RootRole{Threshold: 2},
		ReleaseAuthority: &trust.ReleaseAuthority{Type: "github-artifact-attestation-v1", Repository: "fased-ai/fased", Workflow: "fased-ai/fased/.github/workflows/hosted-runtime-release.yml", SourceRefPrefix: "refs/tags/v", DenySelfHostedRunners: true},
		Revocations:      trust.Revocations{ReleaseVersions: []string{}, TargetDigests: []string{}, DelegatedKeyIDs: []string{}}}
	for _, key := range rootKeys {
		rootMetadata.Keys[key.id] = key.record
		rootMetadata.Root.KeyIDs = append(rootMetadata.Root.KeyIDs, key.id)
	}
	sortStrings(rootMetadata.Root.KeyIDs)
	rootJSON, err := trust.SignRoot(rootMetadata, []trust.SigningKey{{KeyID: rootKeys[0].id, PrivateKey: rootKeys[0].private}, {KeyID: rootKeys[1].id, PrivateKey: rootKeys[1].private}})
	if err != nil {
		t.Fatal(err)
	}
	rootDigest := sha256.Sum256(rootJSON)
	digest := "sha256:" + strings.Repeat("a", 64)
	asset := trust.Asset{Name: "application.tar.gz", Size: 1, SHA256: digest}
	hostAsset := asset
	hostAsset.Name = "fased-lifecycled-linux-x64"
	hostAsset.PrivilegedComponent = "lifecycle-host"
	hostAsset.Protocols = &trust.HostProtocols{Manifest: trust.ProtocolRange{Min: 2, Max: 2}, Journal: trust.ProtocolRange{Min: 1, Max: 1}, Participant: trust.ProtocolRange{Min: 1, Max: 1}, Platform: trust.ProtocolRange{Min: 1, Max: 2}}
	capability := model.CapabilityRange{Min: 1, Max: 1}
	index := trust.ReleaseIndex{SchemaVersion: 1, Type: "fased-release-index", Channel: "stable", Version: "0.1.76",
		ReleaseSequence: 42, SecurityEpoch: 3, Commit: strings.Repeat("b", 40), Tree: strings.Repeat("c", 40), ArtifactSetDigest: digest,
		Application: map[string]trust.Asset{"x64": asset}, DependencyLayer: map[string]trust.Asset{"x64": asset}, LifecycleHost: map[string]trust.Asset{"x64": hostAsset}, Signer: map[string]trust.Asset{"x64": asset},
		StateSchemas: map[string]uint32{"signer": 2}, Capabilities: model.CapabilityRanges{Supervisor: capability, Controller: capability, Migrator: capability, Signer: capability}, PluginLockDigest: digest,
		IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339)}
	indexJSON, err := trust.EncodeReleaseIndex(index)
	if err != nil {
		t.Fatal(err)
	}
	attestationJSON := []byte("attestation fixture")
	indexDigest := sha256.Sum256(indexJSON)
	rootHead := trust.RootHead{
		SchemaVersion: 1, Type: "fased-lifecycle-root-head", Channel: "stable",
		RootVersion: 1, RootSHA256: hex.EncodeToString(rootDigest[:]),
		ReleaseIndexSHA256: hex.EncodeToString(indexDigest[:]), ReleaseVersion: index.Version,
		ReleaseSequence: index.ReleaseSequence, SecurityEpoch: index.SecurityEpoch, IndexCommit: index.Commit,
		WitnessRef: "refs/tags/v" + index.Version, WitnessCommit: index.Commit,
		IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339),
	}
	rootHeadJSON, err := json.Marshal(rootHead)
	if err != nil {
		t.Fatal(err)
	}
	assets := map[string][]byte{
		"/channel/" + releaseRootAssetName:                rootJSON,
		"/channel/" + releaseIndexAssetName:               indexJSON,
		"/channel/" + releaseIndexAttestationAssetName:    attestationJSON,
		"/channel/" + releaseRootHeadAssetName:            rootHeadJSON,
		"/channel/" + releaseRootHeadAttestationAssetName: attestationJSON,
	}
	client := &http.Client{Transport: bootstrapRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		data, ok := assets[request.URL.Path]
		if !ok {
			return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader("missing")), Request: request}, nil
		}
		return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(data)), Body: io.NopCloser(strings.NewReader(string(data))), Request: request}, nil
	})}
	verify := func(_ trust.VerifiedRoot, candidate, bundle []byte, _ time.Time) (bootstrapVerifiedReleaseIndex, error) {
		if string(bundle) != string(attestationJSON) {
			return bootstrapVerifiedReleaseIndex{}, errors.New("wrong attestation")
		}
		decoded, err := trust.DecodeReleaseIndex(candidate)
		if err != nil {
			return bootstrapVerifiedReleaseIndex{}, err
		}
		digest := sha256.Sum256(candidate)
		return bootstrapVerifiedReleaseIndex{Index: decoded, Digest: hex.EncodeToString(digest[:]), ReleaseAuthorityDigest: strings.Repeat("d", 64)}, nil
	}
	verifyHead := func(candidate, bundle []byte, observed time.Time) (trust.RootHead, error) {
		if string(bundle) != string(attestationJSON) {
			return trust.RootHead{}, errors.New("wrong root-head attestation")
		}
		return trust.DecodeRootHead(candidate, observed)
	}

	rootState := t.TempDir()
	if err := os.Chmod(rootState, 0o700); err != nil {
		t.Fatal(err)
	}
	selection, err := discoverSignedChannelRelease(context.Background(), "stable", client, "https://fixture.invalid/channel", hex.EncodeToString(rootDigest[:]), rootState, uint32(os.Geteuid()), 41, 3, now, verify, verifyHead)
	if err != nil {
		t.Fatal(err)
	}
	if selection.Version != index.Version || selection.ReleaseSequence != 42 || selection.SecurityEpoch != 3 || len(selection.IndexDigest) != 64 {
		t.Fatalf("signed channel selection lost release identity: %+v", selection)
	}
	if _, err := discoverSignedChannelRelease(context.Background(), "stable", client, "https://fixture.invalid/channel", hex.EncodeToString(rootDigest[:]), rootState, uint32(os.Geteuid()), 43, 3, now, verify, verifyHead); err == nil {
		t.Fatal("signed channel selection accepted a replay below the installed release sequence")
	}
	tamperedHead := rootHead
	tamperedHead.ReleaseIndexSHA256 = strings.Repeat("e", 64)
	assets["/channel/"+releaseRootHeadAssetName], err = json.Marshal(tamperedHead)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := discoverSignedChannelRelease(context.Background(), "stable", client, "https://fixture.invalid/channel", hex.EncodeToString(rootDigest[:]), rootState, uint32(os.Geteuid()), 41, 3, now, verify, verifyHead); err == nil {
		t.Fatal("channel discovery accepted an index outside the witnessed root-head")
	}
	assets["/channel/"+releaseRootHeadAssetName] = rootHeadJSON
	result := bootstrapResult{Version: selection.Version, ReleaseSequence: selection.ReleaseSequence, SecurityEpoch: selection.SecurityEpoch,
		ReleaseIndexDigest: "sha256:" + selection.IndexDigest, ReleaseAuthorityDigest: "sha256:" + selection.ReleaseAuthorityDigest}
	if err := validateSignedChannelResult(selection, result); err != nil {
		t.Fatal(err)
	}
	result.ReleaseIndexDigest = "sha256:" + strings.Repeat("e", 64)
	if err := validateSignedChannelResult(selection, result); err == nil {
		t.Fatal("exact release was not bound to the selected channel index digest")
	}
}

func TestPublicRootRotationIsDiscoveredAndBecomesADurableFloor(t *testing.T) {
	now := time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
	oldKeys := []fixtureKey{fixtureKeyPair(t), fixtureKeyPair(t), fixtureKeyPair(t)}
	newKeys := []fixtureKey{fixtureKeyPair(t), fixtureKeyPair(t), fixtureKeyPair(t)}
	newestKeys := []fixtureKey{fixtureKeyPair(t), fixtureKeyPair(t), fixtureKeyPair(t)}
	metadata := func(version uint64, keys []fixtureKey, issuedAt, expiresAt time.Time) trust.RootMetadata {
		root := trust.RootMetadata{SchemaVersion: 1, Type: "fased-lifecycle-root", Version: version,
			IssuedAt: issuedAt.Format(time.RFC3339), ExpiresAt: expiresAt.Format(time.RFC3339),
			Keys: map[string]trust.Key{}, Root: trust.RootRole{Threshold: 2},
			ReleaseAuthority: &trust.ReleaseAuthority{Type: "github-artifact-attestation-v1", Repository: "fased-ai/fased", Workflow: "fased-ai/fased/.github/workflows/hosted-runtime-release.yml", SourceRefPrefix: "refs/tags/v", DenySelfHostedRunners: true},
			Revocations:      trust.Revocations{ReleaseVersions: []string{}, TargetDigests: []string{}, DelegatedKeyIDs: []string{}}}
		for _, key := range keys {
			root.Keys[key.id] = key.record
			root.Root.KeyIDs = append(root.Root.KeyIDs, key.id)
		}
		sortStrings(root.Root.KeyIDs)
		return root
	}
	rootV1, err := trust.SignRoot(metadata(1, oldKeys, now.Add(-72*time.Hour), now.Add(-48*time.Hour)), []trust.SigningKey{{KeyID: oldKeys[0].id, PrivateKey: oldKeys[0].private}, {KeyID: oldKeys[1].id, PrivateKey: oldKeys[1].private}})
	if err != nil {
		t.Fatal(err)
	}
	rootV2Metadata := metadata(2, newKeys, now.Add(-48*time.Hour), now.Add(-24*time.Hour))
	rootV2Metadata.Revocations.ReleaseVersions = []string{"0.1.75"}
	rootV2, err := trust.SignRoot(rootV2Metadata, []trust.SigningKey{
		{KeyID: oldKeys[0].id, PrivateKey: oldKeys[0].private}, {KeyID: oldKeys[1].id, PrivateKey: oldKeys[1].private},
		{KeyID: newKeys[0].id, PrivateKey: newKeys[0].private}, {KeyID: newKeys[1].id, PrivateKey: newKeys[1].private},
	})
	if err != nil {
		t.Fatal(err)
	}
	rootV3, err := trust.SignRoot(metadata(3, newestKeys, now.Add(-time.Hour), now.Add(time.Hour)), []trust.SigningKey{
		{KeyID: newKeys[0].id, PrivateKey: newKeys[0].private}, {KeyID: newKeys[1].id, PrivateKey: newKeys[1].private},
		{KeyID: newestKeys[0].id, PrivateKey: newestKeys[0].private}, {KeyID: newestKeys[1].id, PrivateKey: newestKeys[1].private},
	})
	if err != nil {
		t.Fatal(err)
	}
	rootV3Digest := sha256.Sum256(rootV3)
	rootV1Digest := sha256.Sum256(rootV1)
	stateRoot := t.TempDir()
	if err := os.Chmod(stateRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	clientFor := func(includeRotation bool) *http.Client {
		return &http.Client{Transport: bootstrapRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			var data []byte
			switch request.URL.Path {
			case "/channel/" + releaseRootAssetName:
				data = rootV1
			case "/channel/" + rootRotationAssetName(2):
				if includeRotation {
					data = rootV2
				}
			case "/channel/" + rootRotationAssetName(3):
				if includeRotation {
					data = rootV3
				}
			}
			if len(data) == 0 {
				return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader("missing")), Request: request}, nil
			}
			return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(data)), Body: io.NopCloser(bytes.NewReader(data)), Request: request}, nil
		})}
	}

	if _, err := resolveTrustedRoot(context.Background(), clientFor(false), stateRoot, uint32(os.Geteuid()),
		"https://fixture.invalid/channel/"+releaseRootAssetName, "https://fixture.invalid/channel", nil,
		hex.EncodeToString(rootV1Digest[:]), 0, "", now); err == nil {
		t.Fatal("expired final root was accepted without a current successor")
	}
	if _, err := resolveTrustedRoot(context.Background(), clientFor(false), stateRoot, uint32(os.Geteuid()),
		"https://fixture.invalid/channel/"+releaseRootAssetName, "https://fixture.invalid/channel", nil,
		hex.EncodeToString(rootV1Digest[:]), 3, hex.EncodeToString(rootV3Digest[:]), now); err == nil {
		t.Fatal("release-host 404 suppressed a positively witnessed root rotation")
	}
	root, err := resolveTrustedRoot(context.Background(), clientFor(true), stateRoot, uint32(os.Geteuid()),
		"https://fixture.invalid/channel/"+releaseRootAssetName, "https://fixture.invalid/channel", nil,
		hex.EncodeToString(rootV1Digest[:]), 3, hex.EncodeToString(rootV3Digest[:]), now)
	if err != nil || root.Version() != 3 {
		t.Fatalf("public root rotation was not discovered: version=%d err=%v", root.Version(), err)
	}
	for version, expected := range map[uint64][]byte{2: rootV2, 3: rootV3} {
		cachePath := filepath.Join(stateRoot, trustedRootCacheDirectory, rootRotationAssetName(version))
		if cached, err := os.ReadFile(cachePath); err != nil || !bytes.Equal(cached, expected) {
			t.Fatalf("verified root rotation %d was not persisted exactly: err=%v", version, err)
		}
	}

	root, err = resolveTrustedRoot(context.Background(), clientFor(false), stateRoot, uint32(os.Geteuid()),
		"https://fixture.invalid/channel/"+releaseRootAssetName, "https://fixture.invalid/channel", nil,
		hex.EncodeToString(rootV1Digest[:]), 3, hex.EncodeToString(rootV3Digest[:]), now)
	if err != nil || root.Version() != 3 {
		t.Fatalf("network suppression rolled back the cached root floor: version=%d err=%v", root.Version(), err)
	}
}

func TestUpdateBindsExistingPlatformPortWithoutChangingTopology(t *testing.T) {
	operator := publicOperator{Name: "owner", Home: "/home/owner", UID: 1000, GID: 1000}
	config, err := platform.NewConfigWithGatewayPort(
		model.ProfileProtectedLocal, "0123456789abcdef", "/home/owner/.fased", 19456,
		platform.Principal{UID: 1000, GID: 1000}, platform.Principal{UID: 1001, GID: 1001}, platform.Principal{UID: 1002, GID: 1002},
	)
	if err != nil {
		t.Fatal(err)
	}
	request := publicLifecycleRequest{Operation: "update", Profile: model.ProfileProtectedLocal, OperatorUser: "owner"}
	if err := bindInstalledUpdatePlatform(&request, operator, config); err != nil {
		t.Fatal(err)
	}
	if request.GatewayPort != 19456 {
		t.Fatalf("update did not preserve the installed Gateway port: %+v", request)
	}
	wrong := config
	wrong.OwnerStateRoot = "/home/other/.fased"
	if err := bindInstalledUpdatePlatform(&request, operator, wrong); err == nil {
		t.Fatal("update accepted a different installed platform identity")
	}
}

func TestPublicLifecycleRouteRejectsAmbiguousOrLegacySelectors(t *testing.T) {
	for _, fixture := range [][]string{
		{"--profile", "portable", "--version", "1.2.3", "--operator-user", "owner"},
		{"--profile", "hosting", "--channel", "stable", "--version", "1.2.3-rc.1", "--operator-user", "app"},
		{"--profile", "hosting", "--operator-user", "app", "--source-install"},
	} {
		if _, err := parsePublicLifecycleRequest("install", fixture); err == nil {
			t.Fatalf("unsafe public lifecycle selector was accepted: %v", fixture)
		}
	}
}

func TestOnboardingCommandBindsCanonicalProfileEnvironment(t *testing.T) {
	operator := publicOperator{Name: "owner", Home: "/home/owner", UID: 1000, GID: 1000}
	local, err := platform.NewConfig(
		model.ProfileProtectedLocal, "0123456789abcdef", "/home/owner/.fased",
		platform.Principal{UID: 1000, GID: 1000}, platform.Principal{UID: 1001, GID: 1001}, platform.Principal{UID: 1002, GID: 1002},
	)
	if err != nil {
		t.Fatal(err)
	}
	localArgs := strings.Join(onboardingCommandArgs(publicLifecycleRequest{Profile: model.ProfileProtectedLocal}, operator, local, "/home/owner/.fased/bin/fased"), "\n")
	for _, required := range []string{
		"HOME=/home/owner", "FASED_STATE_DIR=/home/owner/.fased", "FASED_CONFIG_PATH=/home/owner/.fased/fased.json",
		"FASED_INSTALLER_ONBOARD=1", "FASED_INSTALL_LIFECYCLE_COMMITTED=1", "FASED_PROTECTED_LOCAL=1",
		"FASED_PROTECTED_LOCAL_INSTANCE=0123456789abcdef", // pragma: allowlist secret
		"FASED_LIFECYCLE_INSTALL_ROOT=" + local.InstallRoot,
		"FASED_WALLET_LOCAL_SIGNER_BIN=" + filepath.Join(local.InstallRoot, "current", "payload", "bin", "fased-signerd"),
		"FASED_WALLET_LOCAL_SIGNER_SOCKET=" + local.ApplicationSocket(),
		"FASED_HOST_UPDATER_SOCKET=" + local.SupervisorSocket(),
	} {
		if !strings.Contains(localArgs, required) {
			t.Fatalf("Local onboarding omitted %q from %s", required, localArgs)
		}
	}
	hosting, err := platform.NewConfig(
		model.ProfileHosting, "hosting", "/home/app/.fased",
		platform.Principal{UID: 1001, GID: 1001}, platform.Principal{UID: 1002, GID: 1002}, platform.Principal{UID: 1003, GID: 1003},
	)
	if err != nil {
		t.Fatal(err)
	}
	hostArgs := strings.Join(onboardingCommandArgs(publicLifecycleRequest{Profile: model.ProfileHosting, Channel: "beta", Version: "0.1.76-rc.97"}, publicOperator{Name: "app", Home: "/home/app", UID: 1001, GID: 1001}, hosting, "/home/app/.fased/bin/fased"), "\n")
	for _, required := range []string{"FASED_HOST_PROFILE=hosting", "FASED_HOST_ROOT_PREPARED=1", "FASED_UPDATE_CHANNEL=beta", "FASED_HOSTING_RELEASE=0.1.76-rc.97", "FASED_WALLET_LOCAL_SIGNER_SOCKET=" + hosting.ApplicationSocket(), "--host-security-capable"} {
		if !strings.Contains(hostArgs, required) {
			t.Fatalf("Hosting onboarding omitted %q from %s", required, hostArgs)
		}
	}
	if strings.Contains(hostArgs, "FASED_PROTECTED_LOCAL=") {
		t.Fatalf("Hosting onboarding inherited Local authority: %s", hostArgs)
	}
	for _, fixture := range []struct {
		name    string
		request publicLifecycleRequest
		config  platform.Config
		profile string
	}{
		{name: "Local", request: publicLifecycleRequest{Profile: model.ProfileProtectedLocal, OnboardArgs: []string{"--flow", "manual"}}, config: local, profile: "local"},
		{name: "Hosting", request: publicLifecycleRequest{Profile: model.ProfileHosting, Channel: "beta", Version: "0.1.76-rc.97", OnboardArgs: []string{"--flow", "manual"}}, config: hosting, profile: "hosting"},
	} {
		args := onboardingCommandArgs(fixture.request, operator, fixture.config, "/home/owner/.fased/bin/fased")
		want := []string{"--host-profile", fixture.profile}
		if got := args[len(args)-len(want):]; !slices.Equal(got, want) {
			t.Fatalf("%s onboarding command tail = %v, want %v", fixture.name, got, want)
		}
		joined := strings.Join(args, "\n")
		if !strings.Contains(joined, "onboard\n--install-daemon\n--flow\nmanual") || strings.Index(joined, "--flow\nmanual") > strings.Index(joined, "--host-profile\n"+fixture.profile) {
			t.Fatalf("%s user onboarding arguments could override the lifecycle profile: %v", fixture.name, args)
		}
	}
}

func TestInteractiveOnboardingDoesNotInheritMachineDeadline(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	cancel()
	interactive, detached := onboardingPhaseContext(parent, publicLifecycleRequest{})
	if !detached {
		t.Fatal("interactive onboarding was not detached from the machine deadline")
	}
	if err := interactive.Err(); err != nil {
		t.Fatalf("interactive onboarding inherited the machine deadline: %v", err)
	}
	scripted, detached := onboardingPhaseContext(parent, publicLifecycleRequest{OnboardArgs: []string{"--non-interactive"}})
	if detached {
		t.Fatal("scripted onboarding escaped the machine deadline")
	}
	if !errors.Is(scripted.Err(), context.Canceled) {
		t.Fatalf("scripted onboarding lost the machine deadline: %v", scripted.Err())
	}
}

func TestPublicInstallRejectsOnboardingProfileOverride(t *testing.T) {
	_, err := parsePublicLifecycleRequest("install", []string{
		"--profile", "hosting", "--channel", "beta", "--version", "0.1.76-rc.114", "--operator-user", "app",
		"--", "--host-profile", "local",
	})
	if err == nil || !strings.Contains(err.Error(), "selected by the lifecycle profile") {
		t.Fatalf("Hosting install accepted an onboarding profile override: %v", err)
	}
}

func TestLifecyclePhaseProgressIsBoundedAndKeepsJSONSilent(t *testing.T) {
	var nonTerminal bytes.Buffer
	nonTerminalProgress := beginLifecyclePhase(&nonTerminal, false, "acquiring the verified lifecycle release")
	nonTerminalProgress.Stop()
	if got, want := nonTerminal.String(), "Phase: acquiring the verified lifecycle release\n"; got != want {
		t.Fatalf("non-terminal progress = %q, want %q", got, want)
	}

	var jsonOutput bytes.Buffer
	if progress := beginLifecyclePhase(&jsonOutput, true, "applying the lifecycle generation"); progress != nil {
		t.Fatal("JSON lifecycle output started progress rendering")
	}
	if jsonOutput.Len() != 0 {
		t.Fatalf("JSON lifecycle output was corrupted: %q", jsonOutput.String())
	}

	var terminal bytes.Buffer
	terminalProgress := newLifecyclePhaseProgress(&terminal, "applying the lifecycle generation", true, time.Millisecond)
	time.Sleep(5 * time.Millisecond)
	terminalProgress.Stop()
	stopped := terminal.String()
	time.Sleep(3 * time.Millisecond)
	if terminal.String() != stopped {
		t.Fatal("terminal lifecycle heartbeat survived Stop")
	}
	if !strings.Contains(stopped, "Phase: applying the lifecycle generation") || !strings.HasSuffix(stopped, "\r\033[2K") {
		t.Fatalf("terminal progress did not render and clear its phase: %q", stopped)
	}
}

func TestLifecycleApplyStopsTerminalProgressBeforeVerboseOutput(t *testing.T) {
	var output bytes.Buffer
	applyProgress := newLifecyclePhaseProgress(&output, "applying the lifecycle generation", true, time.Hour)
	verbosePayload := []byte("lifecycle diagnostic payload\n")
	buffered := lifecycleHostVerboseOutput(publicLifecycleRequest{Verbose: true}, verbosePayload)
	if !bytes.Equal(buffered, verbosePayload) {
		t.Fatalf("verbose lifecycle payload was lost while buffering: %q", buffered)
	}
	applyProgress.Stop()
	emitLifecycleHostVerbose(&output, buffered)

	got := output.String()
	clearAt := strings.LastIndex(got, "\r\033[2K")
	payloadAt := strings.Index(got, string(verbosePayload))
	if clearAt == -1 || payloadAt == -1 || clearAt >= payloadAt {
		t.Fatalf("terminal progress was not cleared before verbose payload: %q", got)
	}
	if !strings.HasSuffix(got, string(verbosePayload)) {
		t.Fatalf("verbose lifecycle payload was interleaved or changed: %q", got)
	}
	jsonRequest := publicLifecycleRequest{Verbose: true, JSON: true}
	jsonVerbose := lifecycleHostVerboseOutput(jsonRequest, verbosePayload)
	if !bytes.Equal(jsonVerbose, verbosePayload) {
		t.Fatalf("JSON verbose lifecycle payload was lost: %q", jsonVerbose)
	}
	var jsonMachineOutput, jsonDiagnostics bytes.Buffer
	emitLifecycleHostVerbose(lifecycleHostVerboseOutputWriter(jsonRequest, &jsonMachineOutput, &jsonDiagnostics), jsonVerbose)
	if jsonMachineOutput.Len() != 0 {
		t.Fatalf("JSON lifecycle verbose bytes corrupted machine output: %q", jsonMachineOutput.String())
	}
	if !bytes.Equal(jsonDiagnostics.Bytes(), verbosePayload) {
		t.Fatalf("JSON lifecycle diagnostics changed or lost verbose bytes: %q", jsonDiagnostics.Bytes())
	}
}

func TestJSONOnboardingRoutesDiagnosticsAwayFromMachineOutput(t *testing.T) {
	for _, request := range []publicLifecycleRequest{
		{Operation: "install", JSON: true},
		{Operation: "install", JSON: true, Verbose: true},
	} {
		var machineOutput, diagnostics bytes.Buffer
		childStdout, childStderr := onboardingProcessOutputWriters(request, &machineOutput, &diagnostics)
		if _, err := childStdout.Write([]byte("onboarding stdout\n")); err != nil {
			t.Fatal(err)
		}
		if _, err := childStderr.Write([]byte("onboarding stderr\n")); err != nil {
			t.Fatal(err)
		}
		if request.Verbose {
			if _, err := onboardingVerboseOutputWriter(request, &machineOutput, &diagnostics).Write([]byte("onboarding completion\n")); err != nil {
				t.Fatal(err)
			}
		}
		if machineOutput.Len() != 0 {
			t.Fatalf("JSON onboarding wrote diagnostics to machine output: %q", machineOutput.String())
		}
		if !strings.Contains(diagnostics.String(), "onboarding stdout\n") || !strings.Contains(diagnostics.String(), "onboarding stderr\n") {
			t.Fatalf("JSON onboarding diagnostics were not retained: %q", diagnostics.String())
		}
		if request.Verbose && !strings.Contains(diagnostics.String(), "onboarding completion\n") {
			t.Fatalf("JSON verbose onboarding diagnostic was not retained: %q", diagnostics.String())
		}
	}
}

func TestHostingBrowserAuthenticationIsIndependentFromApplicationOnboarding(t *testing.T) {
	if !publicRequestAllowsBrowserAuthentication(publicLifecycleRequest{Operation: "install"}) {
		t.Fatal("ordinary installer lost interactive Tailscale authentication")
	}
	if !publicRequestAllowsBrowserAuthentication(publicLifecycleRequest{
		Operation: "install", OnboardArgs: []string{"--non-interactive"},
	}) {
		t.Fatal("scripted application onboarding suppressed the Tailscale login URL")
	}
	if publicRequestAllowsBrowserAuthentication(publicLifecycleRequest{Operation: "install", JSON: true}) {
		t.Fatal("JSON Hosting request selected an interactive auth flow")
	}
}

func TestCommittedHostingSecurityTransactionSkipsFinalization(t *testing.T) {
	if hostingSecurityTransactionNeedsFinalization(hostsecurity.State{Phase: hostsecurity.PhaseCommitted}) {
		t.Fatal("reused committed Hosting security transaction selected completion mutations")
	}
	for _, phase := range []hostsecurity.Phase{
		hostsecurity.PhaseRuntimeReady,
		hostsecurity.PhaseOnboardingPending,
		hostsecurity.PhaseOnboardingComplete,
		hostsecurity.PhaseHardening,
	} {
		if !hostingSecurityTransactionNeedsFinalization(hostsecurity.State{Phase: phase}) {
			t.Fatalf("pending Hosting security phase %s skipped required completion", phase)
		}
	}
}

func TestHostingSecurityLogIsBoundedAndSecure(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "log")
	path := filepath.Join(directory, "hosting-security.log")
	log, err := openBoundedHostingSecurityLog(directory, path, uint32(os.Getuid()), 8)
	if err != nil {
		t.Fatal(err)
	}
	if written, err := log.Write([]byte("123456789")); err == nil || written != 8 {
		t.Fatalf("oversized log write was not bounded: written=%d err=%v", written, err)
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil || info.Size() != 8 || info.Mode().Perm() != 0o600 {
		t.Fatalf("bounded log identity: info=%v err=%v", info, err)
	}
}

func TestOnboardingRunsOnlyForFreshInstall(t *testing.T) {
	install := publicLifecycleRequest{Operation: "install", Onboard: true}
	if !shouldRunOnboarding(install, "UPDATED", false) {
		t.Fatal("fresh install did not select onboarding")
	}
	for _, test := range []struct {
		name          string
		request       publicLifecycleRequest
		outcome       string
		configExisted bool
	}{
		{name: "public stable bridge", request: install, outcome: "UPDATED", configExisted: true},
		{name: "already current", request: install, outcome: "ALREADY_CURRENT"},
		{name: "no onboard", request: publicLifecycleRequest{Operation: "install"}, outcome: "UPDATED"},
		{name: "update", request: publicLifecycleRequest{Operation: "update", Onboard: true}, outcome: "UPDATED"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if shouldRunOnboarding(test.request, test.outcome, test.configExisted) {
				t.Fatal("non-fresh lifecycle operation selected onboarding")
			}
		})
	}
}

func bootstrapFixtureRoot(t *testing.T) string {
	t.Helper()
	if base := os.Getenv("FASED_ROOT_FIXTURE_BASE"); base != "" {
		root := filepath.Join(base, "bootstrap")
		if err := os.Mkdir(root, 0o700); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(root) })
		return root
	}
	root, err := os.MkdirTemp(".", ".bootstrap-fixture-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	absolute, err := filepath.Abs(root)
	if err != nil {
		t.Fatal(err)
	}
	return absolute
}
func mustExecutable(t *testing.T) string {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return executable
}
func sortStrings(values []string) {
	for left := range values {
		for right := left + 1; right < len(values); right++ {
			if values[right] < values[left] {
				values[left], values[right] = values[right], values[left]
			}
		}
	}
}

type bootstrapRoundTripFunc func(*http.Request) (*http.Response, error)

func (function bootstrapRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestPublicTrustRouteUsesOnlyCompileTimeFixturePair(t *testing.T) {
	oldBase, oldPin := branchFixtureMetadataBase, branchFixturePinnedRootSHA256
	t.Cleanup(func() {
		branchFixtureMetadataBase, branchFixturePinnedRootSHA256 = oldBase, oldPin
	})
	branchFixtureMetadataBase, branchFixturePinnedRootSHA256 = "", ""
	route, err := publicTrustRoute("0.1.76-rc.74")
	wantBase := productionReleaseBase + "/v0.1.76-rc.74"
	if err != nil || route.ReleaseBaseURL != wantBase || route.RootURL != wantBase+"/fased-lifecycle-root-v1.json" ||
		route.IndexURL != wantBase+"/fased-release-index-v1.json" ||
		route.IndexAttestationURL != wantBase+"/fased-release-index-v1.json.attestation.json" ||
		route.PinnedRootSHA256 != productionPinnedRootSHA256 || route.VerifyIndex != nil {
		t.Fatalf("production trust route is not the exact immutable release: route=%+v err=%v", route, err)
	}
	branchFixtureMetadataBase = productionReleaseBase + "/v0.1.76-rc.73"
	branchFixturePinnedRootSHA256 = strings.Repeat("a", 64)
	route, err = publicTrustRoute("0.1.76-rc.73")
	if err != nil || route.ReleaseBaseURL != branchFixtureMetadataBase || route.PinnedRootSHA256 != branchFixturePinnedRootSHA256 || route.VerifyIndex == nil {
		t.Fatalf("compiled fixture trust route was not selected: route=%+v err=%v", route, err)
	}
	branchFixturePinnedRootSHA256 = ""
	if _, err := publicTrustRoute("0.1.76-rc.73"); err == nil {
		t.Fatal("incomplete fixture trust route was accepted")
	}
}

func TestBranchFixtureRouteVerifiesDelegatedUnpublishedIndex(t *testing.T) {
	now := time.Date(2026, 8, 12, 18, 0, 0, 0, time.UTC)
	rootKeys := []fixtureKey{fixtureKeyPair(t), fixtureKeyPair(t), fixtureKeyPair(t)}
	releaseKey := fixtureKeyPair(t)
	metadata := trust.RootMetadata{SchemaVersion: 1, Type: "fased-lifecycle-root", Version: 1,
		IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339),
		Keys: map[string]trust.Key{}, Root: trust.RootRole{Threshold: 2},
		ReleaseAuthority: &trust.ReleaseAuthority{Type: "github-artifact-attestation-v1", Repository: "fased-ai/fased", Workflow: "fased-ai/fased/.github/workflows/hosted-runtime-release.yml", SourceRefPrefix: "refs/tags/v", DenySelfHostedRunners: true},
		Revocations:      trust.Revocations{ReleaseVersions: []string{}, TargetDigests: []string{}, DelegatedKeyIDs: []string{}}}
	for _, key := range rootKeys {
		metadata.Keys[key.id] = key.record
		metadata.Root.KeyIDs = append(metadata.Root.KeyIDs, key.id)
	}
	sortStrings(metadata.Root.KeyIDs)
	signers := []trust.SigningKey{{KeyID: rootKeys[0].id, PrivateKey: rootKeys[0].private}, {KeyID: rootKeys[1].id, PrivateKey: rootKeys[1].private}}
	rootJSON, err := trust.SignRoot(metadata, signers)
	if err != nil {
		t.Fatal(err)
	}
	rootDigest := sha256.Sum256(rootJSON)
	verifiedRoot, err := trust.VerifyInitialRoot(rootJSON, hex.EncodeToString(rootDigest[:]), now)
	if err != nil {
		t.Fatal(err)
	}
	delegationJSON, err := trust.SignDelegation(trust.Delegation{SchemaVersion: 1, Type: "fased-release-delegation", Version: 1,
		IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339),
		KeyID: releaseKey.id, Key: releaseKey.record, Channels: []string{"beta"}, MinReleaseSequence: 1, MaxReleaseSequence: 1, SecurityEpoch: 1}, signers)
	if err != nil {
		t.Fatal(err)
	}
	digest := "sha256:" + strings.Repeat("a", 64)
	asset := trust.Asset{Name: "payload.tar.gz", Size: 1, SHA256: digest}
	hostAsset := asset
	hostAsset.Name = "fased-lifecycled-linux-amd64"
	hostAsset.PrivilegedComponent = "lifecycle-host"
	hostAsset.Protocols = &trust.HostProtocols{Manifest: trust.ProtocolRange{Min: 2, Max: 2}, Journal: trust.ProtocolRange{Min: 1, Max: 1}, Participant: trust.ProtocolRange{Min: 1, Max: 1}, Platform: trust.ProtocolRange{Min: 1, Max: 2}}
	indexJSON, err := trust.SignReleaseIndex(trust.ReleaseIndex{SchemaVersion: 1, Type: "fased-release-index", Channel: "beta", Version: "0.1.76-rc.74",
		ReleaseSequence: 1, SecurityEpoch: 1, Commit: strings.Repeat("b", 40), Tree: strings.Repeat("c", 40), ArtifactSetDigest: digest,
		Application: map[string]trust.Asset{"x64": asset}, DependencyLayer: map[string]trust.Asset{"x64": asset}, LifecycleHost: map[string]trust.Asset{"x64": hostAsset}, Signer: map[string]trust.Asset{"x64": asset},
		StateSchemas: map[string]uint32{"signer": 1}, Capabilities: model.CapabilityRanges{Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1}, Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1}}, PluginLockDigest: digest,
		IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339)}, trust.SigningKey{KeyID: releaseKey.id, PrivateKey: releaseKey.private})
	if err != nil {
		t.Fatal(err)
	}
	verified, err := verifyDelegatedBranchReleaseIndex(verifiedRoot, indexJSON, delegationJSON, now)
	if err != nil || verified.Index.Version != "0.1.76-rc.74" || len(verified.ReleaseAuthorityDigest) != 64 {
		t.Fatalf("delegated branch index was not verified: verified=%+v err=%v", verified, err)
	}
}

func TestPublicTrustRouteRequiresExactVersionAndHasNoDelegationOrUpdatesDomain(t *testing.T) {
	oldBase, oldPin := branchFixtureMetadataBase, branchFixturePinnedRootSHA256
	t.Cleanup(func() {
		branchFixtureMetadataBase, branchFixturePinnedRootSHA256 = oldBase, oldPin
	})
	branchFixtureMetadataBase, branchFixturePinnedRootSHA256 = "", ""
	if _, err := publicTrustRoute(""); err == nil {
		t.Fatal("production trust route accepted a mutable channel without an exact version")
	}
	route, err := publicTrustRoute("0.1.76-rc.74")
	if err != nil {
		t.Fatal(err)
	}
	encoded := fmt.Sprintf("%+v", route)
	if strings.Contains(encoded, "updates.fased.ai") || strings.Contains(strings.ToLower(encoded), "delegation") {
		t.Fatalf("production trust route retained obsolete metadata authority: %s", encoded)
	}
}
