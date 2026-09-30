package main

import (
	"context"
	"errors"
	"time"

	"fased-lifecycled/daemon"
	"fased-lifecycled/hostsecurity"
	"fased-lifecycled/model"
	"fased-lifecycled/protocol"
	"fased-lifecycled/publicupdate"
	"fased-lifecycled/store"
)

func matchesHostingCurrent(manifest model.Manifest, authority store.CandidateAuthority, request publicupdate.Request, previous publicupdate.Receipt) bool {
	active := manifest.ActiveGeneration
	return manifest.Profile == model.ProfileHosting && active != nil && active.ID == previous.ActiveGenerationID &&
		active.Version == request.Version && manifest.ReleaseSequence == request.ReleaseSequence && manifest.SecurityEpoch == request.SecurityEpoch &&
		authority.GenerationID == active.ID && authority.ReleaseSequence == request.ReleaseSequence && authority.SecurityEpoch == request.SecurityEpoch &&
		authority.ReleaseIndex == request.ReleaseIndexDigest && authority.ReleaseAuthority == request.ReleaseAuthorityDigest && authority.PluginLockDigest == request.PluginLockDigest
}

func verifyInstalledHostingRelease(ctx context.Context, request publicupdate.Request, previous publicupdate.Receipt, lease *hostsecurity.MutationLock) (protocol.Response, error) {
	config, err := loadConfig("/var/lib/fased-lifecycled/platform.json", 0)
	if err != nil {
		return protocol.Response{}, err
	}
	if config.Profile != model.ProfileHosting || config.GatewayPort != request.GatewayPort {
		return protocol.Response{}, errors.New("checked Hosting platform identity changed")
	}
	state, err := store.OpenExistingLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot})
	if err != nil {
		return protocol.Response{}, err
	}
	manifest, digest, err := state.ReadManifest()
	if err != nil {
		return protocol.Response{}, err
	}
	if manifest.ActiveGeneration == nil {
		return protocol.Response{}, errors.New("checked Hosting generation is absent")
	}
	authority, err := state.ReadCandidateAuthority(manifest.ActiveGeneration.ID)
	if err != nil {
		return protocol.Response{}, err
	}
	if !matchesHostingCurrent(manifest, authority, request, previous) {
		return protocol.Response{}, errors.New("checked Hosting release differs from installed authority")
	}
	id, err := randomRequestID()
	if err != nil {
		return protocol.Response{}, err
	}
	file, err := lease.DupForChild()
	if err != nil {
		return protocol.Response{}, err
	}
	defer file.Close()
	response, err := daemon.CallWithLease(ctx, config.SupervisorSocket(), protocol.Request{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: id,
		Operation: protocol.OperationConverge, TargetGenerationID: manifest.ActiveGeneration.ID, ExpectedManifestDigest: digest}, 5*time.Minute, file)
	if err != nil {
		return protocol.Response{}, err
	}
	if response.Outcome != "ALREADY_CURRENT" || response.ActiveGenerationID != manifest.ActiveGeneration.ID || !validDigestID(response.ConvergenceReceiptDigest) {
		return protocol.Response{}, errors.New("checked Hosting release lacks live convergence proof")
	}
	return response, nil
}
