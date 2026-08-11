package platform

import (
	"context"
	"path/filepath"

	"fased-lifecycled/model"
	stateparticipant "fased-lifecycled/participant"
)

type PluginBoundary interface {
	Prepare(context.Context, model.Generation) error
	Verify(context.Context, model.Generation) error
}

type PluginLockResolver interface {
	PluginLockDigest(string) (string, error)
}

type DiskPluginBoundary struct {
	Config   Config
	Resolver PluginLockResolver
}

func (boundary DiskPluginBoundary) guard() (stateparticipant.PluginBoundary, error) {
	configGID, err := canonicalConfigGroupGID(boundary.Config.OwnerStateRoot, boundary.Config.Operator.UID)
	if err != nil {
		return stateparticipant.PluginBoundary{}, err
	}
	return stateparticipant.PluginBoundary{
		CodeRoot:      filepath.Join(boundary.Config.InstallRoot, "plugin-code"),
		DataRoot:      filepath.Join(boundary.Config.OwnerStateRoot, "plugin-data"),
		LockPath:      filepath.Join(boundary.Config.OwnerStateRoot, "plugin.lock.json"),
		ReadinessPath: filepath.Join(boundary.Config.OwnerStateRoot, "cache", "plugin-readiness.json"),
		CodeOwnerUID:  0, OperatorUID: boundary.Config.Operator.UID,
		GatewayUID: boundary.Config.Gateway.UID, ConfigGID: configGID,
	}, nil
}

func (boundary DiskPluginBoundary) Prepare(_ context.Context, target model.Generation) error {
	digest, err := boundary.Resolver.PluginLockDigest(target.ID)
	if err != nil {
		return err
	}
	guard, err := boundary.guard()
	if err != nil {
		return err
	}
	_, err = guard.VerifyLock(digest)
	return err
}

func (boundary DiskPluginBoundary) Verify(_ context.Context, target model.Generation) error {
	digest, err := boundary.Resolver.PluginLockDigest(target.ID)
	if err != nil {
		return err
	}
	guard, err := boundary.guard()
	if err != nil {
		return err
	}
	return guard.VerifyReadiness(digest, target.ID)
}
