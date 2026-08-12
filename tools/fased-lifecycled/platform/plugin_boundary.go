package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"

	"fased-lifecycled/model"
	stateparticipant "fased-lifecycled/participant"
)

type PluginBoundary interface {
	Prepare(context.Context, model.Generation) error
	Verify(context.Context, model.Generation) error
}

type PluginLockResolver interface {
	PluginLockDigest(string) (string, error)
	GenerationPayloadPath(string) (string, error)
}

type DiskPluginBoundary struct {
	Config         Config
	Resolver       PluginLockResolver
	SourceOwnerUID uint32
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
	payload, err := boundary.Resolver.GenerationPayloadPath(target.ID)
	if err != nil {
		return err
	}
	lockPath := filepath.Join(payload, "runtime", "plugin.lock.json")
	info, err := os.Lstat(lockPath)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || stat.Uid != boundary.SourceOwnerUID || info.Mode().Perm()&0o022 != 0 || info.Size() <= 0 || info.Size() > 1<<20 {
		return errors.New("generation plugin lock identity or access is unsafe")
	}
	data, err := os.ReadFile(lockPath)
	if err != nil {
		return err
	}
	lock, err := stateparticipant.DecodePluginLock(data)
	if err != nil {
		return err
	}
	actual, err := stateparticipant.PluginLockDigest(lock)
	if err != nil || actual != digest {
		return errors.New("generation plugin lock does not match signed release evidence")
	}
	return nil
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
