package migrator

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"

	"fased-lifecycled/model"
	"fased-lifecycled/platform"
)

const maxHostedLegacyJSONBytes int64 = 1 << 20
const hostedSignerControlSocketReadyTimeout = 10 * time.Second

type HostedSignerMigrationAdapter struct {
	Config     platform.Config
	rootPrefix string
	run        func(context.Context, string, []string) error
	now        func() time.Time
}

type hostedFileSnapshot struct {
	Exists bool   `json:"exists"`
	Mode   uint32 `json:"mode,omitempty"`
	UID    uint32 `json:"uid,omitempty"`
	GID    uint32 `json:"gid,omitempty"`
	Data   []byte `json:"data,omitempty"`
}

type hostedLegacyWallet struct {
	RegistryWalletID  string `json:"registryWalletId"`
	WalletID          string `json:"walletId"`
	Role              string `json:"role"`
	ExpectedPublicKey string `json:"expectedPublicKey"`
	KeystorePath      string `json:"keystorePath"`
	PassphrasePath    string `json:"passphrasePath"`
	PrimaryRPCURL     string `json:"primaryRpcUrl,omitempty"`
}

type hostedSignerRecord struct {
	SchemaVersion   int                  `json:"schemaVersion"`
	Noop            bool                 `json:"noop"`
	Activated       bool                 `json:"activated"`
	NativeStarted   bool                 `json:"nativeStarted,omitempty"`
	NativeCommitted bool                 `json:"nativeCommitted,omitempty"`
	RegistryPath    string               `json:"registryPath"`
	ConfigPath      string               `json:"configPath"`
	PolicyPath      string               `json:"policyPath"`
	NativeMarker    string               `json:"nativeMarker"`
	Registry        hostedFileSnapshot   `json:"registry"`
	Config          hostedFileSnapshot   `json:"config"`
	Wallets         []hostedLegacyWallet `json:"wallets"`
}

func (adapter HostedSignerMigrationAdapter) Prepare(_ context.Context, tx model.Transaction, migration model.Migration) error {
	if err := adapter.validate(tx, migration); err != nil {
		return err
	}
	if _, err := adapter.readRecord(tx); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	registryPath := adapter.resolve(filepath.Join(adapter.Config.OwnerStateRoot, "wallet", "provider-registry.v1.json"))
	configPath := adapter.resolve(filepath.Join(adapter.Config.OwnerStateRoot, "fased.json"))
	registry, err := snapshotHostedJSON(registryPath, false)
	if err != nil {
		return err
	}
	configuration, err := snapshotHostedJSON(configPath, false)
	if err != nil {
		return err
	}
	record := hostedSignerRecord{
		SchemaVersion: 1,
		RegistryPath:  registryPath,
		ConfigPath:    configPath,
		PolicyPath:    filepath.Join(adapter.stateRoot(tx), "policy.json"),
		NativeMarker:  filepath.Join(adapter.stateRoot(tx), "native.json"),
		Registry:      registry,
		Config:        configuration,
	}
	registryObject := map[string]any{}
	if registry.Exists {
		if err := json.Unmarshal(registry.Data, &registryObject); err != nil {
			return errors.New("legacy Hosting wallet registry is invalid")
		}
	}
	legacyKeystores, err := adapter.listLegacyKeystores()
	if err != nil {
		return err
	}
	embedded := embeddedHostedWallets(registryObject)
	if len(embedded) == 0 {
		if len(legacyKeystores) != 0 {
			return errors.New("legacy Hosting key files exist without registered embedded wallets")
		}
		record.Noop = true
		return adapter.writeRecord(tx, record)
	}
	if !registry.Exists {
		return errors.New("legacy Hosting embedded wallets have no durable registry")
	}
	configObject := map[string]any{}
	if configuration.Exists && json.Unmarshal(configuration.Data, &configObject) != nil {
		return errors.New("legacy Hosting configuration is invalid")
	}
	wallets, passphrases, err := adapter.planWallets(registryObject, configObject, embedded)
	if err != nil {
		return err
	}
	covered := map[string]bool{}
	for _, wallet := range wallets {
		covered[wallet.KeystorePath] = true
	}
	for _, path := range legacyKeystores {
		if !covered[path] {
			return fmt.Errorf("legacy Hosting keystore has no registered wallet mapping: %s", path)
		}
	}
	if err := os.MkdirAll(adapter.stateRoot(tx), 0o700); err != nil {
		return err
	}
	if err := os.Chmod(adapter.stateRoot(tx), 0o700); err != nil {
		return err
	}
	record.Wallets = wallets
	for path, contents := range passphrases {
		if err := writeHostedFile(path, contents, 0o600, 0, 0, true); err != nil {
			_ = adapter.removePreparedFiles(record)
			return err
		}
	}
	policy := map[string]any{"schemaVersion": 1, "wallets": make([]map[string]any, 0, len(wallets))}
	for _, wallet := range wallets {
		item := map[string]any{
			"walletId": wallet.WalletID, "expectedPublicKey": wallet.ExpectedPublicKey,
			"keystorePath": wallet.KeystorePath, "passphrasePath": wallet.PassphrasePath,
			"baselineRole": wallet.Role,
		}
		if wallet.PrimaryRPCURL != "" {
			item["primaryRpcUrl"] = wallet.PrimaryRPCURL
		}
		policy["wallets"] = append(policy["wallets"].([]map[string]any), item)
	}
	encoded, err := json.Marshal(policy)
	if err != nil {
		_ = adapter.removePreparedFiles(record)
		return err
	}
	if err := writeHostedFile(record.PolicyPath, append(encoded, '\n'), 0o600, 0, 0, true); err != nil {
		_ = adapter.removePreparedFiles(record)
		return err
	}
	if err := adapter.writeRecord(tx, record); err != nil {
		_ = adapter.removePreparedFiles(record)
		return err
	}
	return nil
}

func (adapter HostedSignerMigrationAdapter) Activate(_ context.Context, tx model.Transaction, migration model.Migration) error {
	if err := adapter.validate(tx, migration); err != nil {
		return err
	}
	record, err := adapter.readRecord(tx)
	if err != nil || record.Noop {
		return err
	}
	if record.Activated {
		return nil
	}
	if err := requireHostedSnapshotCurrent(record.RegistryPath, record.Registry); err != nil {
		return err
	}
	if err := requireHostedSnapshotCurrent(record.ConfigPath, record.Config); err != nil {
		return err
	}
	var registry map[string]any
	if err := json.Unmarshal(record.Registry.Data, &registry); err != nil {
		return errors.New("prepared legacy Hosting registry snapshot is invalid")
	}
	now := adapter.clock().UTC().Format(time.RFC3339Nano)
	providers, _ := registry["providers"].(map[string]any)
	if providers == nil {
		providers = map[string]any{}
		registry["providers"] = providers
	}
	setHostedProvider(providers, "embedded-keystore", false, now)
	setHostedProvider(providers, "local-socket-signer", true, now)
	byID := map[string]hostedLegacyWallet{}
	for _, wallet := range record.Wallets {
		byID[wallet.RegistryWalletID] = wallet
	}
	walletValues, _ := registry["wallets"].([]any)
	for _, raw := range walletValues {
		wallet, ok := raw.(map[string]any)
		if !ok {
			return errors.New("legacy Hosting wallet registry contains an invalid wallet")
		}
		migration, ok := byID[stringValue(wallet["id"])]
		if !ok {
			continue
		}
		wallet["providerId"] = "local-socket-signer"
		metadata, _ := wallet["metadata"].(map[string]any)
		if metadata == nil {
			metadata = map[string]any{}
			wallet["metadata"] = metadata
		}
		metadata["role"], metadata["purpose"] = migration.Role, migration.Role
		metadata["signerWalletId"] = migration.WalletID
		metadata["migratedFromProviderId"] = "embedded-keystore"
		metadata["migratedAt"], wallet["updatedAt"] = now, now
	}
	registry["updatedAt"] = now
	registryBytes, _ := json.MarshalIndent(registry, "", "  ")
	if err := restoreHostedSnapshot(record.RegistryPath, hostedFileSnapshot{Exists: true, Mode: record.Registry.Mode, UID: record.Registry.UID, GID: record.Registry.GID, Data: append(registryBytes, '\n')}); err != nil {
		return err
	}
	record.Activated = true
	return adapter.writeRecord(tx, record)
}

func (adapter HostedSignerMigrationAdapter) Verify(ctx context.Context, tx model.Transaction, migration model.Migration) error {
	if err := adapter.validate(tx, migration); err != nil {
		return err
	}
	record, err := adapter.readRecord(tx)
	if err != nil || record.Noop {
		return err
	}
	if !record.Activated {
		return errors.New("legacy Hosting signer migration was not activated")
	}
	return adapter.runNative(ctx, tx, record, "validate")
}

func (adapter HostedSignerMigrationAdapter) Commit(ctx context.Context, tx model.Transaction, migration model.Migration) error {
	if err := adapter.validate(tx, migration); err != nil {
		return err
	}
	record, err := adapter.readRecord(tx)
	if err != nil {
		return err
	}
	if !record.Noop && !record.Activated {
		return errors.New("legacy Hosting signer migration was not activated")
	}
	if !record.Noop && !record.NativeCommitted {
		if !record.NativeStarted {
			record.NativeStarted = true
			if err := adapter.writeRecord(tx, record); err != nil {
				return err
			}
		}
		if err := adapter.runNative(ctx, tx, record, "prepare"); err != nil {
			return err
		}
		if err := adapter.runNative(ctx, tx, record, "commit"); err != nil {
			return err
		}
		record.NativeCommitted = true
		// Native custody is now the only rollback-safe authority. Retain only the
		// non-secret terminal record needed to make Commit idempotent until the
		// outer engine durably journals MIGRATOR_COMMITTED.
		record.Registry = hostedFileSnapshot{}
		record.Config = hostedFileSnapshot{}
		if err := adapter.writeRecord(tx, record); err != nil {
			return err
		}
	}
	return adapter.retainCommittedState(tx, record)
}

func (adapter HostedSignerMigrationAdapter) Abort(_ context.Context, tx model.Transaction, migration model.Migration) error {
	if err := adapter.validate(tx, migration); err != nil {
		return err
	}
	record, err := adapter.readRecord(tx)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if record.NativeStarted {
		return errors.New("native Hosting signer custody migration has started; retry commit instead of rolling back application state")
	}
	if !record.Noop {
		if err := restoreHostedSnapshot(record.RegistryPath, record.Registry); err != nil {
			return err
		}
	}
	return adapter.removeRolledBackState(tx, record)
}

func (adapter HostedSignerMigrationAdapter) validate(tx model.Transaction, migration model.Migration) error {
	if err := adapter.Config.Validate(); err != nil {
		return err
	}
	if adapter.Config.Profile != model.ProfileHosting || migration != (model.Migration{State: "signer", From: 1, To: 2}) {
		return errors.New("legacy Hosting signer adapter received an unsupported migration")
	}
	return tx.Validate()
}

func (adapter HostedSignerMigrationAdapter) planWallets(registry, configuration map[string]any, embedded []map[string]any) ([]hostedLegacyWallet, map[string][]byte, error) {
	vars := hostedEnv(configuration)
	defaultID := stringValue(registry["defaultWalletId"])
	appWallet := adapter.resolve(filepath.Join(adapter.Config.OwnerStateRoot, "wallet"))
	legacyWallet := adapter.resolve("/home/fased-signer/.fased/wallet")
	seen := map[string]bool{}
	wallets := make([]hostedLegacyWallet, 0, len(embedded))
	passphrases := map[string][]byte{}
	for _, item := range embedded {
		registryID := stringValue(item["id"])
		addresses, _ := item["addresses"].(map[string]any)
		publicKey := stringValue(addresses["solana"])
		if registryID == "" || publicKey == "" {
			return nil, nil, errors.New("every legacy Hosting wallet must have an ID and Solana public address")
		}
		walletID := normalizeHostedWalletID(registryID)
		if len(walletID) > 64 || seen[walletID] {
			return nil, nil, fmt.Errorf("legacy Hosting wallet ID does not map uniquely to the signer: %s", registryID)
		}
		seen[walletID] = true
		suffix := hostedEnvSuffix(registryID)
		keystore, err := adapter.firstPrivateFile([]string{
			vars["FASED_WALLET_SOLANA_KEYSTORE_PATH__"+suffix],
			map[bool]string{true: vars["FASED_WALLET_SOLANA_KEYSTORE_PATH"]}[len(embedded) == 1],
			filepath.Join(appWallet, "keystore-solana-"+registryID+".v1.enc"), filepath.Join(appWallet, "keystore-solana-"+walletID+".v1.enc"),
			filepath.Join(legacyWallet, "keystore-solana-"+registryID+".v1.enc"), filepath.Join(legacyWallet, "keystore-solana-"+walletID+".v1.enc"),
			map[bool]string{true: filepath.Join(appWallet, "keystore-solana.v1.enc")}[len(embedded) == 1],
			map[bool]string{true: filepath.Join(legacyWallet, "keystore-solana.v1.enc")}[len(embedded) == 1],
		})
		if err != nil || keystore == "" {
			return nil, nil, fmt.Errorf("legacy Hosting keystore is missing or unsafe for wallet %s", registryID)
		}
		passphraseSource, err := adapter.firstPrivateFile([]string{
			vars["FASED_WALLET_PASSPHRASE_FILE__"+suffix], vars["FASED_WALLET_PASSPHRASE_FILE"], hostedNestedString(configuration, "wallet", "keystore", "passphraseFile"),
			filepath.Join(appWallet, "passphrase"), filepath.Join(legacyWallet, "passphrase"),
		})
		if err != nil {
			return nil, nil, err
		}
		inline := vars["FASED_WALLET_PASSPHRASE__"+suffix]
		if inline == "" {
			inline = vars["FASED_WALLET_PASSPHRASE"]
		}
		if passphraseSource == "" && inline == "" {
			return nil, nil, fmt.Errorf("legacy Hosting passphrase is missing for wallet %s", registryID)
		}
		var passphrase []byte
		if passphraseSource != "" {
			passphrase, err = readHostedPrivateFile(passphraseSource, maxHostedLegacyJSONBytes)
			if err != nil {
				return nil, nil, err
			}
		} else {
			passphrase = []byte(inline + "\n")
		}
		stagedPassphrase := filepath.Join(appWallet, ".migration-passphrase-"+walletID)
		if _, err := os.Lstat(stagedPassphrase); err == nil || !errors.Is(err, os.ErrNotExist) {
			return nil, nil, fmt.Errorf("legacy Hosting staged passphrase already exists for wallet %s", registryID)
		}
		role, err := hostedWalletRole(item, registryID, defaultID, configuration)
		if err != nil {
			return nil, nil, err
		}
		wallets = append(wallets, hostedLegacyWallet{
			RegistryWalletID: registryID, WalletID: walletID, Role: role, ExpectedPublicKey: publicKey,
			KeystorePath: keystore, PassphrasePath: stagedPassphrase,
			PrimaryRPCURL: firstString(vars["FASED_WALLET_SOLANA_RPC_URL__"+suffix], vars["FASED_WALLET_SOLANA_RPC_URL"], vars["FASED_WALLET_RPC_URL"]),
		})
		passphrases[stagedPassphrase] = passphrase
	}
	return wallets, passphrases, nil
}

func (adapter HostedSignerMigrationAdapter) runNative(ctx context.Context, tx model.Transaction, record hostedSignerRecord, phase string) error {
	binary := adapter.resolve(filepath.Join(adapter.Config.InstallRoot, "generations", strings.TrimPrefix(tx.Target.ID, "sha256:"), "payload", "bin", "fased-signerd"))
	controlSocket := adapter.resolve(adapter.Config.ControlSocket())
	args := []string{"admin", "migration", "hosted-v1", "--control-socket", controlSocket, "--policy-file", record.PolicyPath, "--app-home", adapter.resolve(adapter.Config.OwnerHome()), "--legacy-signer-home", adapter.resolve("/home/fased-signer"), "--state-dir", adapter.resolve(adapter.Config.SignerStateRoot()), "--marker-file", record.NativeMarker, "--phase", phase}
	if adapter.run != nil {
		return adapter.run(ctx, binary, args)
	}
	if err := waitForHostedSignerControlSocket(ctx, controlSocket); err != nil {
		return fmt.Errorf("native hosted signer migration %s readiness: %w", phase, err)
	}
	command := exec.CommandContext(ctx, binary, args...)
	command.Env = []string{"HOME=" + adapter.resolve(adapter.Config.SupervisorRuntimeRoot()), "LANG=C", "LC_ALL=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("native hosted signer migration %s failed: %s", phase, strings.TrimSpace(string(output)))
	}
	return nil
}

func waitForHostedSignerControlSocket(ctx context.Context, path string) error {
	return waitForHostedSignerControlSocketWith(ctx, path, os.Lstat, hostedSignerControlSocketReadyTimeout, 25*time.Millisecond)
}

func waitForHostedSignerControlSocketWith(ctx context.Context, path string, inspect func(string) (os.FileInfo, error), timeout, interval time.Duration) error {
	readyContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		info, err := inspect(path)
		if err == nil {
			if info.Mode()&os.ModeSocket == 0 {
				return errors.New("signer control socket path is not a Unix socket")
			}
			return nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("inspect signer control socket readiness: %w", err)
		}
		select {
		case <-readyContext.Done():
			return fmt.Errorf("signer control socket did not become ready: %w", readyContext.Err())
		case <-ticker.C:
		}
	}
}

func (adapter HostedSignerMigrationAdapter) listLegacyKeystores() ([]string, error) {
	var paths []string
	for _, directory := range []string{adapter.resolve(filepath.Join(adapter.Config.OwnerStateRoot, "wallet")), adapter.resolve("/home/fased-signer/.fased/wallet")} {
		root, err := openHostedDirectory(directory)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		directoryFile, err := root.Open(".")
		if err != nil {
			root.Close()
			return nil, err
		}
		entries, err := directoryFile.ReadDir(-1)
		directoryFile.Close()
		root.Close()
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			matched, _ := filepath.Match("keystore-*.enc", entry.Name())
			if !matched {
				continue
			}
			if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
				return nil, fmt.Errorf("legacy Hosting keystore is not a regular file: %s", filepath.Join(directory, entry.Name()))
			}
			path := filepath.Join(directory, entry.Name())
			if _, err := readHostedPrivateFile(path, 64<<10); err != nil {
				return nil, err
			}
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)
	return paths, nil
}

func (adapter HostedSignerMigrationAdapter) firstPrivateFile(candidates []string) (string, error) {
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if !filepath.IsAbs(candidate) || filepath.Clean(candidate) != candidate {
			continue
		}
		candidate = adapter.resolve(candidate)
		if _, err := readHostedPrivateFile(candidate, maxHostedLegacyJSONBytes); err == nil {
			return candidate, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	return "", nil
}

func (adapter HostedSignerMigrationAdapter) removePreparedFiles(record hostedSignerRecord) error {
	var cleanupErrors []error
	for _, wallet := range record.Wallets {
		for _, path := range []string{wallet.PassphrasePath, wallet.PassphrasePath + ".migrated-v2"} {
			if err := removeHostedFile(path); err != nil {
				cleanupErrors = append(cleanupErrors, fmt.Errorf("remove staged Hosting signer file %s: %w", path, err))
			}
		}
	}
	for _, path := range []string{record.PolicyPath, record.NativeMarker} {
		if err := removeHostedFile(path); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("remove staged Hosting signer file %s: %w", path, err))
		}
	}
	return errors.Join(cleanupErrors...)
}

func (adapter HostedSignerMigrationAdapter) retainCommittedState(tx model.Transaction, record hostedSignerRecord) error {
	var cleanupErrors []error
	for _, wallet := range record.Wallets {
		for _, path := range []string{wallet.PassphrasePath, wallet.PassphrasePath + ".migrated-v2"} {
			if err := removeHostedFile(path); err != nil {
				cleanupErrors = append(cleanupErrors, fmt.Errorf("remove committed Hosting signer passphrase %s: %w", path, err))
			}
		}
	}
	if err := errors.Join(cleanupErrors...); err != nil {
		return err
	}
	entries, err := os.ReadDir(adapter.stateRoot(tx))
	if err != nil {
		return fmt.Errorf("inspect committed Hosting migration state: %w", err)
	}
	expected := map[string]bool{filepath.Base(adapter.recordPath(tx)): true}
	if !record.Noop {
		expected[filepath.Base(record.PolicyPath)] = true
		expected[filepath.Base(record.NativeMarker)] = true
	}
	if len(entries) != len(expected) {
		return errors.New("committed Hosting migration state has unexpected entries")
	}
	for _, entry := range entries {
		if !expected[entry.Name()] {
			return fmt.Errorf("committed Hosting migration state contains unexpected entry %s", entry.Name())
		}
	}
	return nil
}

func (adapter HostedSignerMigrationAdapter) removeRolledBackState(tx model.Transaction, record hostedSignerRecord) error {
	if err := adapter.removePreparedFiles(record); err != nil {
		return err
	}
	entries, err := os.ReadDir(adapter.stateRoot(tx))
	if err != nil {
		return fmt.Errorf("inspect rolled-back Hosting migration state: %w", err)
	}
	for _, entry := range entries {
		if entry.Name() != filepath.Base(adapter.recordPath(tx)) {
			return fmt.Errorf("refuse to remove rolled-back Hosting migration state containing unexpected entry %s", entry.Name())
		}
	}
	if err := removeMigrationRecord(adapter.recordPath(tx)); err != nil {
		return err
	}
	if err := os.Remove(adapter.stateRoot(tx)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove rolled-back Hosting migration state: %w", err)
	}
	return nil
}

func (adapter HostedSignerMigrationAdapter) recordPath(tx model.Transaction) string {
	return filepath.Join(adapter.stateRoot(tx), "state.json")
}
func (adapter HostedSignerMigrationAdapter) stateRoot(tx model.Transaction) string {
	return adapter.resolve(filepath.Join(adapter.Config.LifecycleRoot, "transactions", tx.ID, "migrations", "hosted-signer"))
}
func (adapter HostedSignerMigrationAdapter) resolve(path string) string {
	if adapter.rootPrefix == "" {
		return path
	}
	if path == adapter.rootPrefix || strings.HasPrefix(path, adapter.rootPrefix+string(filepath.Separator)) {
		return path
	}
	return filepath.Join(adapter.rootPrefix, strings.TrimPrefix(path, "/"))
}
func (adapter HostedSignerMigrationAdapter) clock() time.Time {
	if adapter.now != nil {
		return adapter.now()
	}
	return time.Now()
}
func (adapter HostedSignerMigrationAdapter) writeRecord(tx model.Transaction, record hostedSignerRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return writeMigrationRecord(adapter.recordPath(tx), data)
}
func (adapter HostedSignerMigrationAdapter) readRecord(tx model.Transaction) (hostedSignerRecord, error) {
	data, err := os.ReadFile(adapter.recordPath(tx))
	if err != nil {
		return hostedSignerRecord{}, err
	}
	var record hostedSignerRecord
	if json.Unmarshal(data, &record) != nil || record.SchemaVersion != 1 || record.RegistryPath == "" || record.ConfigPath == "" || record.PolicyPath != filepath.Join(adapter.stateRoot(tx), "policy.json") || record.NativeMarker != filepath.Join(adapter.stateRoot(tx), "native.json") {
		return hostedSignerRecord{}, errors.New("legacy Hosting signer migration record is invalid or rebound")
	}
	return record, nil
}

func snapshotHostedJSON(path string, required bool) (hostedFileSnapshot, error) {
	root, err := openHostedDirectory(filepath.Dir(path))
	if errors.Is(err, os.ErrNotExist) && !required {
		return hostedFileSnapshot{}, nil
	}
	if err != nil {
		return hostedFileSnapshot{}, err
	}
	defer root.Close()
	name := filepath.Base(path)
	info, err := root.Lstat(name)
	if errors.Is(err, os.ErrNotExist) && !required {
		return hostedFileSnapshot{}, nil
	}
	if err != nil {
		return hostedFileSnapshot{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxHostedLegacyJSONBytes || info.Mode().Perm()&0o022 != 0 {
		return hostedFileSnapshot{}, fmt.Errorf("legacy Hosting JSON file is unsafe: %s", path)
	}
	file, err := root.Open(name)
	if err != nil {
		return hostedFileSnapshot{}, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return hostedFileSnapshot{}, errors.New("legacy Hosting JSON file changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxHostedLegacyJSONBytes+1))
	if err != nil || int64(len(data)) != info.Size() {
		return hostedFileSnapshot{}, errors.New("legacy Hosting JSON file changed while reading")
	}
	var value any
	if json.Unmarshal(data, &value) != nil {
		return hostedFileSnapshot{}, fmt.Errorf("legacy Hosting JSON file is invalid: %s", path)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return hostedFileSnapshot{}, errors.New("legacy Hosting file owner is unavailable")
	}
	return hostedFileSnapshot{Exists: true, Mode: uint32(info.Mode().Perm()), UID: stat.Uid, GID: stat.Gid, Data: data}, nil
}

func restoreHostedSnapshot(path string, snapshot hostedFileSnapshot) error {
	if !snapshot.Exists {
		return removeHostedFile(path)
	}
	return writeHostedFile(path, snapshot.Data, os.FileMode(snapshot.Mode), snapshot.UID, snapshot.GID, false)
}

func requireHostedSnapshotCurrent(path string, expected hostedFileSnapshot) error {
	current, err := snapshotHostedJSON(path, false)
	if err != nil {
		return err
	}
	if current.Exists != expected.Exists || current.Mode != expected.Mode || current.UID != expected.UID || current.GID != expected.GID || !bytes.Equal(current.Data, expected.Data) {
		return fmt.Errorf("legacy Hosting state changed after migration prepare: %s", path)
	}
	return nil
}

func writeHostedFile(path string, data []byte, mode os.FileMode, uid, gid uint32, exclusive bool) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || len(data) == 0 {
		return errors.New("Hosting migration output is invalid")
	}
	root, err := openHostedDirectory(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer root.Close()
	var temporary *os.File
	var temporaryName string
	for attempt := 0; attempt < 8; attempt++ {
		random := make([]byte, 16)
		if _, err := rand.Read(random); err != nil {
			return err
		}
		temporaryName = ".hosted-migration-" + hex.EncodeToString(random)
		temporary, err = root.OpenFile(temporaryName, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		break
	}
	if err != nil || temporary == nil {
		return errors.New("allocate Hosting migration output")
	}
	defer root.Remove(temporaryName)
	if _, err = temporary.Write(data); err == nil {
		err = temporary.Chmod(mode)
	}
	if err == nil && os.Geteuid() == 0 {
		err = temporary.Chown(int(uid), int(gid))
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	name := filepath.Base(path)
	if exclusive {
		if _, err := root.Lstat(name); err == nil {
			return fmt.Errorf("Hosting migration output already exists: %s", path)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := root.Rename(temporaryName, name); err != nil {
		return err
	}
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func readHostedPrivateFile(path string, limit int64) ([]byte, error) {
	root, err := openHostedDirectory(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	defer root.Close()
	name := filepath.Base(path)
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() <= 0 || info.Size() > limit {
		return nil, fmt.Errorf("legacy Hosting secret file is unsafe: %s", path)
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errors.New("legacy Hosting secret changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) != info.Size() {
		return nil, errors.New("legacy Hosting secret changed while reading")
	}
	return data, nil
}

func openHostedDirectory(path string) (*os.Root, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("legacy Hosting directory path must be absolute and clean")
	}
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if before.Mode()&os.ModeSymlink != 0 || !before.IsDir() {
		return nil, errors.New("legacy Hosting directory must be a non-symlink directory")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path {
		return nil, errors.New("legacy Hosting directory contains a symlink component")
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(before, opened) {
		root.Close()
		return nil, errors.New("legacy Hosting directory changed while opening")
	}
	return root, nil
}

func removeHostedFile(path string) error {
	root, err := openHostedDirectory(filepath.Dir(path))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer root.Close()
	if err := root.Remove(filepath.Base(path)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func embeddedHostedWallets(registry map[string]any) []map[string]any {
	values, _ := registry["wallets"].([]any)
	result := make([]map[string]any, 0)
	for _, raw := range values {
		wallet, ok := raw.(map[string]any)
		if ok && stringValue(wallet["providerId"]) == "embedded-keystore" {
			result = append(result, wallet)
		}
	}
	return result
}

func setHostedProvider(providers map[string]any, id string, enabled bool, now string) {
	provider, _ := providers[id].(map[string]any)
	if provider == nil {
		provider = map[string]any{}
		providers[id] = provider
	}
	provider["enabled"], provider["updatedAt"] = enabled, now
}

func hostedEnv(configuration map[string]any) map[string]string {
	result := map[string]string{}
	environment, _ := configuration["env"].(map[string]any)
	vars, _ := environment["vars"].(map[string]any)
	for key, value := range vars {
		if text, ok := value.(string); ok {
			result[key] = text
		}
	}
	return result
}

func hostedWalletRole(wallet map[string]any, id, defaultID string, configuration map[string]any) (string, error) {
	metadata, _ := wallet["metadata"].(map[string]any)
	for _, candidate := range []string{stringValue(metadata["purpose"]), stringValue(metadata["role"])} {
		role := strings.ToLower(strings.TrimSpace(candidate))
		if role == "agent" || role == "mining" || role == "vault" {
			return role, nil
		}
	}
	label := strings.ToLower(stringValue(wallet["name"]))
	miningID := hostedNestedString(configuration, "plugins", "entries", "sat-mining", "config", "walletId")
	lowerID := strings.ToLower(id)
	if id == miningID || strings.HasPrefix(lowerID, "mining") || strings.Contains(label, "miner") || strings.Contains(label, "mining") {
		return "mining", nil
	}
	if strings.HasPrefix(lowerID, "vault") || strings.Contains(label, "vault") {
		return "vault", nil
	}
	if id == defaultID || strings.HasPrefix(lowerID, "agent") || strings.Contains(label, "agent") {
		return "agent", nil
	}
	return "", fmt.Errorf("legacy Hosting wallet %s has no Agent, Mining, or Vault role", id)
}

func normalizeHostedWalletID(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(value, "_")
	value = strings.Trim(value, "_")
	if value == "" {
		return "default"
	}
	return value
}
func hostedEnvSuffix(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	value = regexp.MustCompile(`[^A-Z0-9]+`).ReplaceAllString(value, "_")
	return strings.Trim(value, "_")
}
func stringValue(value any) string { text, _ := value.(string); return strings.TrimSpace(text) }
func firstString(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
func hostedNestedString(value map[string]any, keys ...string) string {
	var current any = value
	for _, key := range keys {
		object, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = object[key]
	}
	return stringValue(current)
}
