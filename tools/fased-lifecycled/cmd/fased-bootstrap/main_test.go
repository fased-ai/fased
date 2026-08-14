package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"fased-lifecycled/host"
	"fased-lifecycled/model"
	"fased-lifecycled/platform"
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
	if update.GatewayPort != 0 {
		t.Fatalf("update invented an installation port: %+v", update)
	}
	if update.Timeout != 8*time.Minute {
		t.Fatalf("update lost its bounded default timeout: %+v", update)
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
}

func TestPublicUpdateDiscoversExactReleaseWithoutNodeOrNPM(t *testing.T) {
	requested := ""
	client := &http.Client{Transport: bootstrapRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		requested = request.URL.String()
		body := `[
			{"tag_name":"v0.1.77-rc.1","draft":false,"prerelease":true},
			{"tag_name":"v0.1.76","draft":false,"prerelease":false},
			{"tag_name":"v0.1.75","draft":true,"prerelease":false}
		]`
		return &http.Response{
			StatusCode:    http.StatusOK,
			ContentLength: int64(len(body)),
			Header:        http.Header{"Content-Type": []string{"application/json"}},
			Body:          io.NopCloser(strings.NewReader(body)),
			Request:       request,
		}, nil
	})}

	stable, err := discoverPublicReleaseVersion(context.Background(), "stable", client, "https://api.github.test/releases")
	if err != nil || stable != "0.1.76" {
		t.Fatalf("stable channel did not resolve to an exact immutable release: version=%q err=%v", stable, err)
	}
	beta, err := discoverPublicReleaseVersion(context.Background(), "beta", client, "https://api.github.test/releases")
	if err != nil || beta != "0.1.77-rc.1" {
		t.Fatalf("beta channel did not resolve to an exact immutable release: version=%q err=%v", beta, err)
	}
	if requested != "https://api.github.test/releases" {
		t.Fatalf("release discovery used an unexpected route: %q", requested)
	}
}

func TestPublicUpdateReleaseDiscoveryFailsClosed(t *testing.T) {
	for name, body := range map[string]string{
		"mutable tag": `[{"tag_name":"latest","draft":false,"prerelease":false}]`,
		"draft only":  `[{"tag_name":"v0.1.76","draft":true,"prerelease":false}]`,
		"wrong shape": `{}`,
	} {
		t.Run(name, func(t *testing.T) {
			client := &http.Client{Transport: bootstrapRoundTripFunc(func(request *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(body)), Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
			})}
			if _, err := discoverPublicReleaseVersion(context.Background(), "stable", client, "https://api.github.test/releases"); err == nil {
				t.Fatal("untrusted discovery returned an unsafe release identity")
			}
		})
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
	hostArgs := strings.Join(onboardingCommandArgs(publicLifecycleRequest{Profile: model.ProfileHosting, Channel: "beta"}, publicOperator{Name: "app", Home: "/home/app", UID: 1001, GID: 1001}, hosting, "/home/app/.fased/bin/fased"), "\n")
	for _, required := range []string{"FASED_HOST_PROFILE=hosting", "FASED_HOST_ROOT_PREPARED=1", "FASED_UPDATE_CHANNEL=beta", "FASED_WALLET_LOCAL_SIGNER_SOCKET=" + hosting.ApplicationSocket()} {
		if !strings.Contains(hostArgs, required) {
			t.Fatalf("Hosting onboarding omitted %q from %s", required, hostArgs)
		}
	}
	if strings.Contains(hostArgs, "FASED_PROTECTED_LOCAL=") {
		t.Fatalf("Hosting onboarding inherited Local authority: %s", hostArgs)
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
