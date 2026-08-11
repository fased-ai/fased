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
	metadata := trust.RootMetadata{SchemaVersion: 1, Type: "fased-lifecycle-root", Version: 1, IssuedAt: now.Add(-time.Hour).Format(time.RFC3339), ExpiresAt: now.Add(24 * time.Hour).Format(time.RFC3339), Keys: map[string]trust.Key{}, Root: trust.RootRole{Threshold: 2}, Revocations: trust.Revocations{ReleaseVersions: []string{}, TargetDigests: []string{}, DelegatedKeyIDs: []string{}}}
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
	releaseKey := fixtureKeyPair(t)
	delegationJSON, err := trust.SignDelegation(trust.Delegation{SchemaVersion: 1, Type: "fased-release-delegation", Version: 1, IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339), KeyID: releaseKey.id, Key: releaseKey.record, Channels: []string{"beta"}, MinReleaseSequence: 40, MaxReleaseSequence: 50, SecurityEpoch: 3}, []trust.SigningKey{{KeyID: rootKeys[0].id, PrivateKey: rootKeys[0].private}, {KeyID: rootKeys[1].id, PrivateKey: rootKeys[1].private}})
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.ReadFile(mustExecutable(t))
	if err != nil {
		t.Fatal(err)
	}
	hostDigest := sha256.Sum256(executable)
	hostAsset := trust.Asset{Name: "fased-lifecycled-linux-x64", Size: uint64(len(executable)), SHA256: fmt.Sprintf("sha256:%x", hostDigest), PrivilegedComponent: "lifecycle-host", Protocols: &trust.HostProtocols{Manifest: trust.ProtocolRange{Min: 2, Max: 2}, Journal: trust.ProtocolRange{Min: 1, Max: 1}, Participant: trust.ProtocolRange{Min: 1, Max: 1}, Platform: trust.ProtocolRange{Min: 1, Max: 2}}}
	plainBytes := []byte{'x'}
	plainDigest := sha256.Sum256(plainBytes)
	plain := trust.Asset{Name: "placeholder", Size: uint64(len(plainBytes)), SHA256: fmt.Sprintf("sha256:%x", plainDigest)}
	index := trust.ReleaseIndex{SchemaVersion: 1, Type: "fased-release-index", Channel: "beta", Version: "0.1.76-rc.74", ReleaseSequence: 42, SecurityEpoch: 3, Commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Tree: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ArtifactSetDigest: plain.SHA256, Application: map[string]trust.Asset{"x64": plain}, DependencyLayer: map[string]trust.Asset{"x64": plain}, LifecycleHost: map[string]trust.Asset{"x64": hostAsset}, Signer: map[string]trust.Asset{"x64": plain}, StateSchemas: map[string]uint32{"signer": 2}, Capabilities: model.CapabilityRanges{Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1}, Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1}}, PluginLockDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(30 * time.Minute).Format(time.RFC3339)}
	indexJSON, err := trust.SignReleaseIndex(index, trust.SigningKey{KeyID: releaseKey.id, PrivateKey: releaseKey.private})
	if err != nil {
		t.Fatal(err)
	}
	assets := map[string][]byte{"/root.json": rootJSON, "/delegation.json": delegationJSON, "/index.json": indexJSON, "/release/" + hostAsset.Name: executable, "/release/" + plain.Name: plainBytes}
	client := &http.Client{Transport: bootstrapRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		data, ok := assets[request.URL.Path]
		if !ok {
			return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader("missing")), Request: request}, nil
		}
		return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(data)), Header: http.Header{"Content-Length": []string{fmt.Sprint(len(data))}}, Body: io.NopCloser(strings.NewReader(string(data))), Request: request}, nil
	})}
	fixtureRoot := bootstrapFixtureRoot(t)
	request := bootstrapRequest{StateRoot: filepath.Join(fixtureRoot, "state"), HostRoot: filepath.Join(fixtureRoot, "host"), RootURL: "https://fixture.invalid/root.json", DelegationURL: "https://fixture.invalid/delegation.json", IndexURL: "https://fixture.invalid/index.json", ReleaseBaseURL: "https://fixture.invalid/release", Channel: "beta", Version: index.Version, Architecture: "x64", PinnedRootSHA256: hex.EncodeToString(rootDigest[:]), OwnerUID: uint32(os.Geteuid()), Client: client, Now: now, Inspect: func(ctx context.Context, candidate host.StagedHost) error {
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
	if current, err := os.ReadFile(filepath.Join(fixtureRoot, "host", "host-current")); err != nil || string(current) != result.HostDigest+"\n" {
		t.Fatalf("host pointer was not committed: %q err=%v", current, err)
	}
	for _, path := range []string{result.ApplicationPath, result.DependencyPath, result.SignerPath} {
		if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
			t.Fatalf("indexed release asset was not retained in the verified inbox: %s err=%v", path, err)
		}
	}
}

func TestBootstrapRejectsCallerSelectedTrustPinAndNonHTTPS(t *testing.T) {
	request := bootstrapRequest{StateRoot: "/var/lib/fased-lifecycled", HostRoot: "/opt/fased/lifecycle", RootURL: "http://example.invalid/root", DelegationURL: "https://example.invalid/delegation", IndexURL: "https://example.invalid/index", ReleaseBaseURL: "https://example.invalid/release", Channel: "beta", Version: "0.1.0", Architecture: "x64", PinnedRootSHA256: productionPinnedRootSHA256, OwnerUID: uint32(os.Geteuid()), Now: time.Now(), Inspect: func(context.Context, host.StagedHost) error { return nil }}
	if _, err := execute(context.Background(), request); err == nil {
		t.Fatal("plain HTTP root metadata was accepted")
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
		"FASED_PROTECTED_LOCAL_INSTANCE=0123456789abcdef", "FASED_WALLET_LOCAL_SIGNER_SOCKET=" + local.ApplicationSocket(),
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
	base, pin, err := publicTrustRoute()
	if err != nil || base != productionMetadataBase || pin != productionPinnedRootSHA256 {
		t.Fatalf("production trust route changed: base=%q pin=%q err=%v", base, pin, err)
	}
	branchFixtureMetadataBase = productionReleaseBase + "/v0.1.76-rc.73/lifecycle/v1"
	branchFixturePinnedRootSHA256 = strings.Repeat("a", 64)
	base, pin, err = publicTrustRoute()
	if err != nil || base != branchFixtureMetadataBase || pin != branchFixturePinnedRootSHA256 {
		t.Fatalf("compiled fixture trust route was not selected: base=%q pin=%q err=%v", base, pin, err)
	}
	branchFixturePinnedRootSHA256 = ""
	if _, _, err := publicTrustRoute(); err == nil {
		t.Fatal("incomplete fixture trust route was accepted")
	}
}
