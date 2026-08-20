package platform

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"fased-lifecycled/bundle"
	"fased-lifecycled/model"
	"fased-lifecycled/participant"
	"fased-lifecycled/store"
)

type ManagedPluginProduction struct {
	Transaction ManagedPluginTransaction
	Activation  ManagedPluginActivation
	BaseLock    participant.PluginLock
}

func NewManagedPluginProduction(config Config, generationID string, gateway ServiceManager) (ManagedPluginProduction, error) {
	if gateway == nil {
		return ManagedPluginProduction{}, errors.New("managed plugin Gateway service is required")
	}
	identity, err := config.Identity()
	if err != nil {
		return ManagedPluginProduction{}, err
	}
	gid, err := canonicalConfigGroupGID(config.OwnerStateRoot, config.Operator.UID)
	if err != nil {
		return ManagedPluginProduction{}, err
	}
	tx := ManagedPluginTransaction{CodeRoot: filepath.Join(config.InstallRoot, "plugin-code"), TransactionRoot: managedPluginTransactionRoot(config), CodeOwnerUID: 0, CodeOwnerGID: 0, ArchiveOwnerUID: config.Operator.UID}
	boundary := managedPluginProductionBoundary(config, tx, gid)
	base, _, err := boundary.VerifyInstalledLock()
	if err != nil {
		return ManagedPluginProduction{}, err
	}
	return ManagedPluginProduction{Transaction: tx, Activation: ManagedPluginActivation{Config: config, Identity: identity, Transaction: tx, Gateway: gateway, GenerationID: generationID}, BaseLock: base}, nil
}

// NewManagedPluginProductionForCoreTransition admits the one supported
// pre-managed-plugin representation: a schema-one installation whose exact
// plugin lock is still bound only inside its verified active generation. The
// caller owns the installation-wide lifecycle mutation lease. Missing lock
// state in any newer manifest remains corruption and fails in the strict
// production constructor below.
func NewManagedPluginProductionForCoreTransition(config Config, generationID string, predecessorManifestSchema uint32, gateway ServiceManager) (ManagedPluginProduction, error) {
	if predecessorManifestSchema == 1 {
		lockPath := CanonicalPluginLockPath(config)
		if _, err := os.Lstat(lockPath); errors.Is(err, os.ErrNotExist) {
			state, openErr := store.OpenExistingLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot})
			if openErr != nil {
				return ManagedPluginProduction{}, openErr
			}
			configGID, gidErr := canonicalConfigGroupGID(config.OwnerStateRoot, config.Operator.UID)
			if gidErr != nil {
				return ManagedPluginProduction{}, gidErr
			}
			if migrateSchemaOneManagedPluginLock(config, generationID, configGID, 0, state); err != nil {
				return ManagedPluginProduction{}, err
			}
		} else if err != nil {
			return ManagedPluginProduction{}, err
		}
	}
	return NewManagedPluginProduction(config, generationID, gateway)
}

type schemaOnePluginLockResolver interface {
	ReadGenerationContract(string) (bundle.Inventory, model.Generation, error)
	GenerationPayloadPath(string) (string, error)
}

func migrateSchemaOneManagedPluginLock(config Config, generationID string, configGID, sourceOwnerUID uint32, resolver schemaOnePluginLockResolver) error {
	inventory, generation, err := resolver.ReadGenerationContract(generationID)
	if err != nil {
		return fmt.Errorf("verify schema-one active generation contract: %w", err)
	}
	if generation.ID != generationID || inventory.PluginLockDigest == "" {
		return errors.New("schema-one active generation is missing a plugin lock binding")
	}
	payload, err := resolver.GenerationPayloadPath(generationID)
	if err != nil {
		return fmt.Errorf("verify schema-one active generation payload: %w", err)
	}
	data, err := readSchemaOneGenerationPluginLock(filepath.Join(payload, "runtime", "plugin.lock.json"), sourceOwnerUID)
	if err != nil {
		return err
	}
	lock, err := participant.DecodePluginLock(data)
	if err != nil {
		return err
	}
	digest, err := participant.PluginLockDigest(lock)
	if err != nil || digest != inventory.PluginLockDigest {
		return errors.New("schema-one generation plugin lock does not match its verified inventory")
	}
	if err := installSchemaOneManagedPluginLock(CanonicalPluginLockPath(config), data, config.Operator.UID, configGID); err != nil {
		return fmt.Errorf("install schema-one managed plugin lock bridge: %w", err)
	}
	return nil
}

func installSchemaOneManagedPluginLock(path string, data []byte, uid, gid uint32) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".fased-plugin-lock-bridge-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	closeFailure := func(cause error) error { return errors.Join(cause, temporary.Close()) }
	if _, err := temporary.Write(data); err != nil {
		return closeFailure(err)
	}
	if err := temporary.Chown(int(uid), int(gid)); err != nil {
		return closeFailure(err)
	}
	if err := temporary.Chmod(0o640); err != nil {
		return closeFailure(err)
	}
	if err := temporary.Sync(); err != nil {
		return closeFailure(err)
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	// Publish without replacement. Even an operator racing the one-time bridge
	// cannot cause root to overwrite an unexpected owner-state object.
	if err := os.Link(temporaryPath, path); err != nil {
		return err
	}
	if err := os.Remove(temporaryPath); err != nil {
		return err
	}
	return syncPluginDirectory(directory)
}

func readSchemaOneGenerationPluginLock(path string, sourceOwnerUID uint32) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("read schema-one generation plugin lock: %w", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || stat.Uid != sourceOwnerUID || info.Mode().Perm()&0o022 != 0 || info.Size() <= 0 || info.Size() > maxManagedPluginRecordBytes {
		return nil, errors.New("schema-one generation plugin lock identity or access is unsafe")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !sameManagedPluginArchiveIdentity(info, opened) {
		return nil, errors.New("schema-one generation plugin lock changed while opening")
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maxManagedPluginRecordBytes+1))
	if readErr != nil || len(data) == 0 || len(data) > maxManagedPluginRecordBytes {
		return nil, errors.Join(readErr, errors.New("schema-one generation plugin lock exceeds byte budget"))
	}
	after, afterErr := file.Stat()
	pathAfter, pathErr := os.Lstat(path)
	if afterErr != nil || pathErr != nil || !sameManagedPluginArchiveIdentity(info, after) || !sameManagedPluginArchiveIdentity(info, pathAfter) {
		return nil, errors.New("schema-one generation plugin lock changed while reading")
	}
	return data, nil
}

func managedPluginProductionBoundary(config Config, tx ManagedPluginTransaction, configGID uint32) participant.PluginBoundary {
	return participant.PluginBoundary{CodeRoot: tx.CodeRoot, DataRoot: filepath.Join(config.OwnerStateRoot, "plugin-data"), LockPath: CanonicalPluginLockPath(config), ReadinessPath: filepath.Join(config.OwnerStateRoot, "cache", "plugin-readiness.json"), CodeOwnerUID: tx.CodeOwnerUID, OperatorUID: config.Operator.UID, GatewayUID: config.Gateway.UID, ConfigGID: configGID}
}
