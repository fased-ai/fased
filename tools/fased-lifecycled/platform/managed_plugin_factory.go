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

// PrepareManagedPluginCoreTransition admits the one supported
// pre-managed-plugin representation: a schema-one installation whose exact
// plugin lock is still bound only inside its verified active generation. The
// caller owns the installation-wide lifecycle mutation lease. The durable
// installed manifest, rather than a caller-projected schema hint, selects the
// bridge. A nil activation means that exact pre-P6 bridge was completed and
// there was no P6 journal namespace to converge. Missing lock state in any
// newer manifest remains corruption.
func PrepareManagedPluginCoreTransition(config Config, generationID string, gateway ServiceManager) (*ManagedPluginActivation, error) {
	if gateway == nil {
		return nil, errors.New("managed plugin Gateway service is required")
	}
	if err := config.Validate(); err != nil {
		return nil, err
	}
	state, err := store.OpenExistingLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot})
	if err != nil {
		return nil, err
	}
	manifest, _, err := state.ReadManifest()
	if err != nil {
		return nil, err
	}
	if manifest.SchemaVersion == 1 {
		configGID, gidErr := canonicalConfigGroupGID(config.OwnerStateRoot, config.Operator.UID)
		if gidErr != nil {
			return nil, gidErr
		}
		if bridgeErr := prepareSchemaOneManagedPluginCoreTransition(config, generationID, configGID, 0, 0, state); bridgeErr != nil {
			return nil, bridgeErr
		}
		return nil, nil
	}
	production, err := NewManagedPluginProduction(config, generationID, gateway)
	if err != nil {
		return nil, err
	}
	return &production.Activation, nil
}

func prepareSchemaOneManagedPluginCoreTransition(config Config, generationID string, configGID, codeOwnerUID, codeOwnerGID uint32, resolver schemaOnePluginLockResolver) error {
	manifest, _, err := resolver.ReadManifest()
	if err != nil {
		return fmt.Errorf("verify managed plugin predecessor manifest: %w", err)
	}
	if manifest.SchemaVersion != 1 || manifest.ActiveGeneration == nil || manifest.ActiveGeneration.ID != generationID {
		return errors.New("managed plugin bridge is not bound to the exact active schema-one generation")
	}
	if err := verifyEmptyPreP6ManagedPluginNamespace(managedPluginTransactionRoot(config), codeOwnerUID, codeOwnerGID); err != nil {
		return err
	}
	data, err := verifiedSchemaOneGenerationPluginLock(generationID, codeOwnerUID, resolver)
	if err != nil {
		return err
	}
	path := CanonicalPluginLockPath(config)
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return installSchemaOneManagedPluginLock(path, data, config.Operator.UID, configGID)
	} else if err != nil {
		return err
	}
	installed, err := readInstalledSchemaOneManagedPluginLock(path, config.Operator.UID, configGID)
	if err != nil {
		return err
	}
	if string(installed) != string(data) {
		return errors.New("installed schema-one managed plugin lock differs from the verified active generation")
	}
	return nil
}

func verifyEmptyPreP6ManagedPluginNamespace(path string, uid, gid uint32) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("pre-P6 managed plugin transaction namespace path is invalid")
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errors.New("pre-P6 managed plugin transaction namespace is unsafe")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uid || stat.Gid != gid || info.Mode().Perm() != 0o700 {
		return errors.New("pre-P6 managed plugin transaction namespace is unsafe")
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return errors.New("missing managed plugin lock conflicts with an existing plugin transaction")
	}
	return nil
}

type schemaOnePluginLockResolver interface {
	ReadManifest() (model.Manifest, string, error)
	ReadLegacySchemaOneGenerationContract(string) (bundle.Inventory, model.Generation, string, error)
}

func verifiedSchemaOneGenerationPluginLock(generationID string, sourceOwnerUID uint32, resolver schemaOnePluginLockResolver) ([]byte, error) {
	inventory, generation, payload, err := resolver.ReadLegacySchemaOneGenerationContract(generationID)
	if err != nil {
		return nil, fmt.Errorf("verify schema-one active generation contract: %w", err)
	}
	if generation.ID != generationID || inventory.PluginLockDigest == "" {
		return nil, errors.New("schema-one active generation is missing a plugin lock binding")
	}
	data, err := readSchemaOneGenerationPluginLock(filepath.Join(payload, "runtime", "plugin.lock.json"), sourceOwnerUID)
	if err != nil {
		return nil, err
	}
	lock, err := participant.DecodePluginLock(data)
	if err != nil {
		return nil, err
	}
	digest, err := participant.PluginLockDigest(lock)
	if err != nil || digest != inventory.PluginLockDigest {
		return nil, errors.New("schema-one generation plugin lock does not match its verified inventory")
	}
	return data, nil
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

func readInstalledSchemaOneManagedPluginLock(path string, uid, gid uint32) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || stat.Uid != uid || stat.Gid != gid || info.Mode().Perm() != 0o640 || info.Size() <= 0 || info.Size() > maxManagedPluginRecordBytes {
		return nil, errors.New("installed schema-one managed plugin lock identity or access is unsafe")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !sameManagedPluginArchiveIdentity(info, opened) {
		return nil, errors.New("installed schema-one managed plugin lock changed while opening")
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maxManagedPluginRecordBytes+1))
	if readErr != nil || len(data) == 0 || len(data) > maxManagedPluginRecordBytes {
		return nil, errors.Join(readErr, errors.New("installed schema-one managed plugin lock exceeds byte budget"))
	}
	after, afterErr := file.Stat()
	pathAfter, pathErr := os.Lstat(path)
	if afterErr != nil || pathErr != nil || !sameManagedPluginArchiveIdentity(info, after) || !sameManagedPluginArchiveIdentity(info, pathAfter) {
		return nil, errors.New("installed schema-one managed plugin lock changed while reading")
	}
	return data, nil
}

func managedPluginProductionBoundary(config Config, tx ManagedPluginTransaction, configGID uint32) participant.PluginBoundary {
	return participant.PluginBoundary{CodeRoot: tx.CodeRoot, DataRoot: filepath.Join(config.OwnerStateRoot, "plugin-data"), LockPath: CanonicalPluginLockPath(config), ReadinessPath: filepath.Join(config.OwnerStateRoot, "cache", "plugin-readiness.json"), CodeOwnerUID: tx.CodeOwnerUID, OperatorUID: config.Operator.UID, GatewayUID: config.Gateway.UID, ConfigGID: configGID}
}
