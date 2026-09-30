package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"fased-lifecycled/daemon"
	"fased-lifecycled/host"
	"fased-lifecycled/hostsecurity"
	"fased-lifecycled/model"
	"fased-lifecycled/platform"
	"fased-lifecycled/protocol"
	"fased-lifecycled/publicupdate"
	"fased-lifecycled/store"
	"fased-lifecycled/trust"
	"runtime"
)

func validCurrentDigest(value string) bool {
	return strings.HasPrefix(value, "sha256:") && plainSHA256(strings.TrimPrefix(value, "sha256:"))
}

func matchesCurrentRelease(manifest model.Manifest, authority store.CandidateAuthority, verified bootstrapVerifiedReleaseIndex) bool {
	index := verified.Index
	active := manifest.ActiveGeneration
	return active != nil && active.Version == index.Version && active.Commit == index.Commit && active.Tree == index.Tree &&
		active.ArtifactSetDigest == active.ID && manifest.ReleaseSequence == index.ReleaseSequence && manifest.SecurityEpoch == index.SecurityEpoch &&
		authority.GenerationID == active.ID && authority.ReleaseSequence == index.ReleaseSequence && authority.SecurityEpoch == index.SecurityEpoch &&
		authority.ReleaseIndex == "sha256:"+verified.Digest && authority.ReleaseAuthority == "sha256:"+verified.ReleaseAuthorityDigest &&
		authority.PluginLockDigest == index.PluginLockDigest
}

// Reuse only an exactly attested installed generation. CONVERGE retains the
// existing supervisor's pending-journal recovery, manifest CAS and live-service
// checks. A repair request and Hosting's target-owned route remain unchanged.
func currentReleaseConverger(config platform.Config, lease *hostsecurity.MutationLock, selection *signedChannelSelection) func(context.Context, bootstrapVerifiedReleaseIndex) (protocol.Response, bool, error) {
	return func(ctx context.Context, verified bootstrapVerifiedReleaseIndex) (protocol.Response, bool, error) {
		if selection != nil {
			if err := validateSignedChannelResult(*selection, bootstrapResult{Version: verified.Index.Version,
				ReleaseSequence: verified.Index.ReleaseSequence, SecurityEpoch: verified.Index.SecurityEpoch,
				ReleaseIndexDigest: "sha256:" + verified.Digest, ReleaseAuthorityDigest: "sha256:" + verified.ReleaseAuthorityDigest}); err != nil {
				return protocol.Response{}, false, err
			}
		}
		state, err := store.OpenExistingLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot})
		if err != nil {
			return protocol.Response{}, false, err
		}
		manifest, digest, err := state.ReadManifest()
		if err != nil {
			return protocol.Response{}, false, err
		}
		if manifest.ActiveGeneration == nil {
			return protocol.Response{}, false, nil
		}
		authority, err := state.ReadCandidateAuthority(manifest.ActiveGeneration.ID)
		if err != nil {
			return protocol.Response{}, false, err
		}
		if !matchesCurrentRelease(manifest, authority, verified) {
			return protocol.Response{}, false, nil
		}
		id, err := publicRequestID()
		if err != nil {
			return protocol.Response{}, false, err
		}
		if lease == nil {
			return protocol.Response{}, false, errors.New("lifecycle mutation lease is unavailable")
		}
		file, err := lease.DupForChild()
		if err != nil {
			return protocol.Response{}, false, err
		}
		defer file.Close()
		response, err := daemon.CallWithLease(ctx, config.SupervisorSocket(), protocol.Request{
			SchemaVersion: protocol.CurrentSchemaVersion, RequestID: id, Operation: protocol.OperationConverge,
			TargetGenerationID: manifest.ActiveGeneration.ID, ExpectedManifestDigest: digest,
		}, 5*time.Minute, file)
		if err != nil {
			return protocol.Response{}, false, err
		}
		if response.Outcome != "ALREADY_CURRENT" || response.ActiveGenerationID != manifest.ActiveGeneration.ID || !validCurrentDigest(response.ConvergenceReceiptDigest) {
			return protocol.Response{}, false, errors.New("installed release failed live convergence verification")
		}
		return response, true, nil
	}
}

func writeCurrentReleaseOutcome(output io.Writer, request publicLifecycleRequest, result bootstrapResult, performance publicLifecyclePerformance) error {
	response := result.CurrentConvergence
	if request.JSON {
		return json.NewEncoder(output).Encode(struct {
			Status                   string                     `json:"status"`
			Version                  string                     `json:"version"`
			ReleaseSequence          uint64                     `json:"releaseSequence"`
			SecurityEpoch            uint64                     `json:"securityEpoch"`
			ActiveGenerationID       string                     `json:"activeGenerationId"`
			ConvergenceReceiptDigest string                     `json:"convergenceReceiptDigest"`
			Performance              publicLifecyclePerformance `json:"performance"`
		}{response.Outcome, result.Version, result.ReleaseSequence, result.SecurityEpoch, response.ActiveGenerationID, response.ConvergenceReceiptDigest, performance})
	}
	if err := writeLifecycleOutcome(output, "Already current: "+result.Version); err != nil {
		return err
	}
	if request.Verbose {
		_, err := fmt.Fprintln(output, formatLifecyclePerformance(performance))
		return err
	}
	return nil
}

var findCurrentHostingHost = func(asset trust.Asset) (host.StagedHost, bool, error) {
	stored, err := host.OpenStore(platform.LifecycleHostRootForOS(runtime.GOOS), 0)
	if err != nil {
		return host.StagedHost{}, false, err
	}
	defer stored.Close()
	return stored.VerifiedCurrent(asset)
}

func hostingCurrentReleaseConverger(request publicLifecycleRequest, previous publicupdate.Receipt, lease *hostsecurity.MutationLock, selection *signedChannelSelection, pin string) func(context.Context, bootstrapVerifiedReleaseIndex) (protocol.Response, bool, error) {
	return func(ctx context.Context, verified bootstrapVerifiedReleaseIndex) (protocol.Response, bool, error) {
		index := verified.Index
		if selection != nil {
			if err := validateSignedChannelResult(*selection, bootstrapResult{Version: index.Version, ReleaseSequence: index.ReleaseSequence, SecurityEpoch: index.SecurityEpoch, ReleaseIndexDigest: "sha256:" + verified.Digest, ReleaseAuthorityDigest: "sha256:" + verified.ReleaseAuthorityDigest}); err != nil {
				return protocol.Response{}, false, err
			}
		}
		if index.Version != previous.Version || index.Channel != previous.Channel || index.ReleaseSequence != previous.ReleaseSequence || index.SecurityEpoch != previous.SecurityEpoch {
			return protocol.Response{}, false, nil
		}
		asset, ok := selectPlatformAsset(index.LifecycleHost, bootstrapRequest{OperatingSystem: runtime.GOOS, Architecture: architecture()})
		if !ok || asset.Protocols == nil {
			return protocol.Response{}, false, errors.New("checked Hosting release lacks lifecycle host")
		}
		installed, current, err := findCurrentHostingHost(asset)
		if err != nil || !current {
			return protocol.Response{}, false, err
		}
		check := publicupdate.Request{SchemaVersion: publicupdate.SchemaVersion, Operation: "check", Profile: model.ProfileHosting,
			Channel: index.Channel, Version: index.Version, OperatorUser: previous.OperatorUser, GatewayPort: previous.GatewayPort, PlatformIdentity: previous.PlatformIdentity,
			TimeoutSeconds: uint32(request.Timeout / time.Second), TrustRootSHA256: pin, HostDigest: installed.Digest,
			ReleaseSequence: index.ReleaseSequence, SecurityEpoch: index.SecurityEpoch, ManifestProtocolMin: asset.Protocols.Manifest.Min, ManifestProtocolMax: asset.Protocols.Manifest.Max,
			ReleaseIndexDigest: "sha256:" + verified.Digest, ReleaseAuthorityDigest: "sha256:" + verified.ReleaseAuthorityDigest, PluginLockDigest: index.PluginLockDigest,
			ExpectedPreviousSequence: previous.ReleaseSequence, ExpectedPreviousEpoch: previous.SecurityEpoch}
		if err := check.Validate(); err != nil {
			return protocol.Response{}, false, err
		}
		response, err := invokeTargetOwnedHostingUpdate(ctx, installed.Path, check, lease)
		if err != nil {
			return protocol.Response{}, false, err
		}
		committed, err := readPublicHostingReceipt()
		if err != nil {
			return protocol.Response{}, false, err
		}
		if err := publicupdate.ExactReceipt(committed, check); err != nil {
			return protocol.Response{}, false, err
		}
		if response.Outcome != "ALREADY_CURRENT" || response.ActiveGenerationID != previous.ActiveGenerationID || committed.ActiveGenerationID != response.ActiveGenerationID || committed.ConvergenceReceiptDigest != response.ConvergenceReceiptDigest || !validCurrentDigest(response.ConvergenceReceiptDigest) {
			return protocol.Response{}, false, errors.New("checked Hosting release lacks exact live receipt")
		}
		return response, true, nil
	}
}
