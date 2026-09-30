package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"fased-lifecycled/host"
	"fased-lifecycled/hostsecurity"
	"fased-lifecycled/model"
	"fased-lifecycled/protocol"
	"fased-lifecycled/publicupdate"
	"fased-lifecycled/trust"
)

func TestHostingUpdateHandsStableReceiptDirectlyToAcquiredTargetHost(t *testing.T) {
	originalExecute := executePublicLifecycleBootstrap
	originalVerify := verifyPublicLifecycleHost
	originalInvoke := invokeTargetOwnedHostingUpdate
	originalRead := readPublicHostingReceipt
	originalPrune := prunePublicAcquisitionInbox
	t.Cleanup(func() {
		executePublicLifecycleBootstrap = originalExecute
		verifyPublicLifecycleHost = originalVerify
		invokeTargetOwnedHostingUpdate = originalInvoke
		readPublicHostingReceipt = originalRead
		prunePublicAcquisitionInbox = originalPrune
	})
	digest := "sha256:" + strings.Repeat("a", 64)
	previous := publicupdate.Receipt{
		SchemaVersion: publicupdate.SchemaVersion, Profile: model.ProfileHosting, Channel: "beta", Version: "0.1.0-rc.1",
		OperatorUser: "app", GatewayPort: 18789, PlatformIdentity: "linux/x64", ReleaseSequence: 10, SecurityEpoch: 2,
		ActiveGenerationID: digest, ConvergenceReceiptDigest: digest,
	}
	result := bootstrapResult{
		Version: "0.1.0-rc.2", ReleaseSequence: 11, SecurityEpoch: 2, ManifestProtocolMin: 1, ManifestProtocolMax: 99,
		HostDigest: strings.Repeat("b", 64), HostPath: "/verified/target-host", ApplicationPath: "/verified/application",
		DependencyPath: "/verified/dependency", ReleaseIndexDigest: "sha256:" + strings.Repeat("c", 64),
		ReleaseAuthorityDigest: "sha256:" + strings.Repeat("d", 64), PluginLockDigest: "sha256:" + strings.Repeat("e", 64),
	}
	verifyPublicLifecycleHost = func(context.Context) error { return nil }
	executePublicLifecycleBootstrap = func(_ context.Context, request bootstrapRequest) (bootstrapResult, error) {
		if request.Version != result.Version {
			t.Fatalf("unexpected acquired version %q", request.Version)
		}
		return result, nil
	}
	var committed publicupdate.Receipt
	invokeTargetOwnedHostingUpdate = func(_ context.Context, hostPath string, request publicupdate.Request, _ *hostsecurity.MutationLock) (protocol.Response, error) {
		if hostPath != result.HostPath || request.ExpectedPreviousSequence != previous.ReleaseSequence || request.ExpectedPreviousEpoch != previous.SecurityEpoch || request.ManifestProtocolMax != 99 {
			t.Fatalf("stable target handoff mismatch: %#v", request)
		}
		committed = publicupdate.Receipt{
			SchemaVersion: publicupdate.SchemaVersion, Profile: request.Profile, Channel: request.Channel, Version: request.Version,
			OperatorUser: request.OperatorUser, GatewayPort: request.GatewayPort, PlatformIdentity: request.PlatformIdentity,
			ReleaseSequence: request.ReleaseSequence, SecurityEpoch: request.SecurityEpoch,
			ActiveGenerationID: digest, ConvergenceReceiptDigest: digest,
		}
		return protocol.Response{SchemaVersion: protocol.CurrentSchemaVersion, Outcome: "UPDATED", ActiveGenerationID: digest, ConvergenceReceiptDigest: digest}, nil
	}
	readPublicHostingReceipt = func() (publicupdate.Receipt, error) { return committed, nil }
	prunePublicAcquisitionInbox = func(string) error { return nil }
	request := publicLifecycleRequest{Operation: "update", Profile: model.ProfileHosting, Channel: "beta", ChannelExplicit: true,
		Version: result.Version, OperatorUser: "app", GatewayPort: 18789, Timeout: 5 * time.Minute}
	var output strings.Builder
	if err := runTargetOwnedHostingLifecycle(context.Background(), request, publicOperator{Name: "app"}, previous, nil, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Updated successfully: "+result.Version+"\n") {
		t.Fatalf("unexpected output %q", output.String())
	}
}

func TestHostingStatusUsesAuthorityReceiptWithoutPlatformState(t *testing.T) {
	originalRoot := publicLifecycleRootAuthorized
	originalRead := readPublicHostingReceipt
	originalResolve := resolvePublicStatusOperator
	t.Cleanup(func() {
		publicLifecycleRootAuthorized = originalRoot
		readPublicHostingReceipt = originalRead
		resolvePublicStatusOperator = originalResolve
	})
	digest := "sha256:" + strings.Repeat("a", 64)
	publicLifecycleRootAuthorized = func() bool { return true }
	resolvePublicStatusOperator = func(name string, _ model.Profile) (publicOperator, error) { return publicOperator{Name: name}, nil }
	readPublicHostingReceipt = func() (publicupdate.Receipt, error) {
		return publicupdate.Receipt{SchemaVersion: 1, Profile: model.ProfileHosting, Channel: "beta", Version: "0.1.0-rc.2",
			OperatorUser: "app", GatewayPort: 18789, PlatformIdentity: "linux/x64", ReleaseSequence: 11, SecurityEpoch: 2,
			ActiveGenerationID: digest, ConvergenceReceiptDigest: digest}, nil
	}
	var output strings.Builder
	if err := runPublicLifecycleStatus([]string{"--profile", "hosting", "--operator-user", "app"}, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Installed: 0.1.0-rc.2 profile=hosting channel=beta sequence=11 epoch=2") {
		t.Fatalf("unexpected status %q", output.String())
	}
}

func TestHostingCurrentReleaseKeepsStateTargetOwnedAndRequiresFreshReceipt(t *testing.T) {
	originalFind, originalInvoke, originalRead := findCurrentHostingHost, invokeTargetOwnedHostingUpdate, readPublicHostingReceipt
	t.Cleanup(func() {
		findCurrentHostingHost = originalFind
		invokeTargetOwnedHostingUpdate = originalInvoke
		readPublicHostingReceipt = originalRead
	})
	digest := "sha256:" + strings.Repeat("a", 64)
	previous := publicupdate.Receipt{SchemaVersion: 1, Profile: model.ProfileHosting, Channel: "beta", Version: "0.1.0-rc.2", OperatorUser: "app", GatewayPort: 18789, PlatformIdentity: "linux/x64", ReleaseSequence: 11, SecurityEpoch: 2, ActiveGenerationID: digest, ConvergenceReceiptDigest: digest}
	asset := trust.Asset{Name: "fased-lifecycled-linux-x64", Size: 1, SHA256: digest, PrivilegedComponent: "lifecycle-host", Protocols: &trust.HostProtocols{Manifest: trust.ProtocolRange{Min: 2, Max: 2}}}
	verified := bootstrapVerifiedReleaseIndex{Index: trust.ReleaseIndex{Channel: previous.Channel, Version: previous.Version, ReleaseSequence: 11, SecurityEpoch: 2, PluginLockDigest: digest, LifecycleHost: map[string]trust.Asset{"linux-x64": asset}}, Digest: strings.Repeat("b", 64), ReleaseAuthorityDigest: strings.Repeat("c", 64)}
	findCurrentHostingHost = func(trust.Asset) (host.StagedHost, bool, error) {
		return host.StagedHost{Digest: strings.Repeat("a", 64), Path: "/verified/installed-host"}, true, nil
	}
	fresh := previous
	fresh.ConvergenceReceiptDigest = "sha256:" + strings.Repeat("d", 64)
	invoked := 0
	invokeTargetOwnedHostingUpdate = func(_ context.Context, path string, request publicupdate.Request, _ *hostsecurity.MutationLock) (protocol.Response, error) {
		invoked++
		if path != "/verified/installed-host" || request.Operation != "check" || request.ApplicationPath != "" || request.DependencyPath != "" {
			t.Fatalf("metadata check crossed target boundary: %+v", request)
		}
		return protocol.Response{Outcome: "ALREADY_CURRENT", ActiveGenerationID: digest, ConvergenceReceiptDigest: fresh.ConvergenceReceiptDigest}, nil
	}
	readPublicHostingReceipt = func() (publicupdate.Receipt, error) { return fresh, nil }
	check := hostingCurrentReleaseConverger(publicLifecycleRequest{Operation: "update", Timeout: 5 * time.Minute}, previous, nil, nil, strings.Repeat("e", 64))
	if _, current, err := check(context.Background(), verified); err != nil || !current {
		t.Fatalf("metadata Hosting check failed: %v %v", current, err)
	}
	readPublicHostingReceipt = func() (publicupdate.Receipt, error) { return previous, nil }
	if _, current, err := check(context.Background(), verified); err == nil || current {
		t.Fatal("stale receipt substituted for fresh readiness")
	}
	verified.Index.ReleaseSequence++
	before := invoked
	if _, current, err := check(context.Background(), verified); err != nil || current || invoked != before {
		t.Fatal("different release used metadata-only check")
	}
}
