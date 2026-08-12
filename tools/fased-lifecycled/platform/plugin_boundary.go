package platform

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"

	"fased-lifecycled/model"
	stateparticipant "fased-lifecycled/participant"
)

type PluginBoundary interface {
	Prepare(context.Context, model.Transaction) (PreparedPluginLock, error)
	Activate(model.Transaction) error
	Restore(model.Transaction) error
	Discard(model.Transaction) error
	Verify(context.Context, model.Generation) (PluginReadinessReceipt, error)
}

type PreparedPluginLock struct {
	Data   []byte
	Digest string
}

type PluginReadinessReceipt struct {
	Digest string
}

type PluginLockResolver interface {
	PluginLockDigest(string) (string, error)
	GenerationPayloadPath(string) (string, error)
}

type DiskPluginBoundary struct {
	Config          Config
	Resolver        PluginLockResolver
	SourceOwnerUID  uint32
	CodeRoot        string
	TransactionRoot string
	LegacyRoot      string
}

func (boundary DiskPluginBoundary) guard() (stateparticipant.PluginBoundary, error) {
	configGID, err := canonicalConfigGroupGID(boundary.Config.OwnerStateRoot, boundary.Config.Operator.UID)
	if err != nil {
		return stateparticipant.PluginBoundary{}, err
	}
	return stateparticipant.PluginBoundary{
		CodeRoot:      boundary.codeRoot(),
		DataRoot:      filepath.Join(boundary.Config.OwnerStateRoot, "plugin-data"),
		LockPath:      filepath.Join(boundary.Config.OwnerStateRoot, "plugin.lock.json"),
		ReadinessPath: filepath.Join(boundary.Config.OwnerStateRoot, "cache", "plugin-readiness.json"),
		CodeOwnerUID:  0, OperatorUID: boundary.Config.Operator.UID,
		GatewayUID: boundary.Config.Gateway.UID, ConfigGID: configGID,
	}, nil
}

func (boundary DiskPluginBoundary) Prepare(_ context.Context, tx model.Transaction) (PreparedPluginLock, error) {
	target := tx.Target
	digest, err := boundary.Resolver.PluginLockDigest(target.ID)
	if err != nil {
		return PreparedPluginLock{}, err
	}
	payload, err := boundary.Resolver.GenerationPayloadPath(target.ID)
	if err != nil {
		return PreparedPluginLock{}, err
	}
	lockPath := filepath.Join(payload, "runtime", "plugin.lock.json")
	info, err := os.Lstat(lockPath)
	if err != nil {
		return PreparedPluginLock{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || stat.Uid != boundary.SourceOwnerUID || info.Mode().Perm()&0o022 != 0 || info.Size() <= 0 || info.Size() > 1<<20 {
		return PreparedPluginLock{}, errors.New("generation plugin lock identity or access is unsafe")
	}
	data, err := os.ReadFile(lockPath)
	if err != nil {
		return PreparedPluginLock{}, err
	}
	lock, err := stateparticipant.DecodePluginLock(data)
	if err != nil {
		return PreparedPluginLock{}, err
	}
	actual, err := stateparticipant.PluginLockDigest(lock)
	if err != nil || actual != digest {
		return PreparedPluginLock{}, errors.New("generation plugin lock does not match signed release evidence")
	}
	installed := stateparticipant.PluginLock{SchemaVersion: stateparticipant.PluginLockSchemaVersion, Type: "fased-plugin-lock"}
	if _, err := os.Lstat(filepath.Join(boundary.Config.OwnerStateRoot, "plugin.lock.json")); err == nil {
		guard, guardErr := boundary.guard()
		if guardErr != nil {
			return PreparedPluginLock{}, guardErr
		}
		installed, _, err = guard.VerifyInstalledLock()
		if err != nil {
			return PreparedPluginLock{}, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return PreparedPluginLock{}, err
	}
	legacy, err := boundary.prepareLegacyPlugins(tx)
	if err != nil {
		return PreparedPluginLock{}, err
	}
	installed, err = stateparticipant.MergeInstalledPluginLocks(installed, legacy)
	if err != nil {
		return PreparedPluginLock{}, err
	}
	merged, err := stateparticipant.MergeCorePluginLock(lock, installed)
	if err != nil {
		return PreparedPluginLock{}, err
	}
	mergedDigest, err := stateparticipant.PluginLockDigest(merged)
	if err != nil {
		return PreparedPluginLock{}, err
	}
	mergedJSON, err := json.Marshal(merged)
	if err != nil {
		return PreparedPluginLock{}, err
	}
	return PreparedPluginLock{Data: append(mergedJSON, '\n'), Digest: mergedDigest}, nil
}

func (boundary DiskPluginBoundary) codeRoot() string {
	if boundary.CodeRoot != "" {
		return boundary.CodeRoot
	}
	return filepath.Join(boundary.Config.InstallRoot, "plugin-code")
}

func (boundary DiskPluginBoundary) transactionRoot(tx model.Transaction) string {
	if boundary.TransactionRoot != "" {
		return filepath.Join(boundary.TransactionRoot, tx.ID)
	}
	return filepath.Join(boundary.Config.LifecycleRoot, "transactions", tx.ID, "target", "plugins")
}

func (boundary DiskPluginBoundary) legacyRoot() string {
	if boundary.LegacyRoot != "" {
		return boundary.LegacyRoot
	}
	return filepath.Join(boundary.Config.OwnerStateRoot, "extensions")
}

func (boundary DiskPluginBoundary) Verify(ctx context.Context, target model.Generation) (PluginReadinessReceipt, error) {
	prepared, err := boundary.Prepare(ctx, model.Transaction{Target: target})
	if err != nil {
		return PluginReadinessReceipt{}, err
	}
	guard, err := boundary.guard()
	if err != nil {
		return PluginReadinessReceipt{}, err
	}
	digest, err := guard.VerifyReadiness(prepared.Digest, target.ID)
	if err != nil {
		return PluginReadinessReceipt{}, err
	}
	return PluginReadinessReceipt{Digest: digest}, nil
}
