package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"fased-lifecycled/hostsecurity"
	"fased-lifecycled/model"
	"fased-lifecycled/protocol"
	"fased-lifecycled/publicupdate"
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
