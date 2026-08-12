package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"fased-lifecycled/engine"
	"fased-lifecycled/model"
)

type GenerationManager interface {
	GenerationPayloadPath(string) (string, error)
	GenerationDependencyPath(string) (string, error)
	ActivateGeneration(string, string) error
}

type GatewayHealth interface {
	Verify(context.Context, uint16, model.Generation) error
}

type Predecessor interface {
	Prepare(context.Context, model.Transaction) error
	Quiesce(context.Context, model.Transaction) error
	Restore(context.Context, model.Transaction) error
	Commit(context.Context, model.Transaction) error
	Discard(context.Context, model.Transaction) error
}

type ManifestReader interface {
	ReadManifest() (model.Manifest, string, error)
}

type TargetAdapter struct {
	Config      Config
	Identity    model.PlatformIdentity
	Units       UnitStore
	Files       LifecycleFileStore
	TypedState  TypedStateStore
	Systemd     Systemd
	Generations GenerationManager
	Health      GatewayHealth
	Predecessor Predecessor
	Fence       LocalPredecessorFence
	Network     NetworkPolicy
	Manifest    ManifestReader
	Plugins     PluginBoundary
}

func (adapter *TargetAdapter) CompleteOnboarding(ctx context.Context) (engine.Result, error) {
	if adapter == nil || (adapter.Config.Profile != model.ProfileProtectedLocal && adapter.Config.Profile != model.ProfileHosting) || adapter.Manifest == nil || adapter.TypedState == nil || adapter.Systemd == nil || adapter.Health == nil || adapter.Plugins == nil {
		return engine.Result{}, errors.New("lifecycle onboarding adapter is incomplete")
	}
	manifest, _, err := adapter.Manifest.ReadManifest()
	if err != nil {
		return engine.Result{}, err
	}
	if err := manifest.Validate(); err != nil || manifest.Profile != adapter.Config.Profile || manifest.ActiveGeneration == nil {
		return engine.Result{}, errors.New("lifecycle onboarding requires a committed active generation")
	}
	configured, err := adapter.Config.Identity()
	if err != nil {
		return engine.Result{}, err
	}
	want, _ := configured.Digest(adapter.Config.Profile)
	got, digestErr := manifest.Platform.Digest(manifest.Profile)
	if digestErr != nil || got != want {
		return engine.Result{}, errors.New("lifecycle onboarding platform identity mismatch")
	}
	if err := validateOnboardingConfig(adapter.Config); err != nil {
		return engine.Result{}, err
	}
	if err := adapter.TypedState.Converge(); err != nil {
		return engine.Result{}, fmt.Errorf("onboarding typed state is unsafe: %w", err)
	}
	if err := adapter.Systemd.IsActive(ctx, adapter.Identity.Services["signer"]); err != nil {
		return engine.Result{}, fmt.Errorf("signer is not active before onboarding completion: %w", err)
	}
	gateway := adapter.Identity.Services["gateway"]
	if err := adapter.Systemd.IsActive(ctx, gateway); err == nil {
		if err := adapter.Health.Verify(ctx, adapter.Config.GatewayPort, *manifest.ActiveGeneration); err != nil {
			return engine.Result{}, fmt.Errorf("active Gateway is unhealthy during onboarding completion: %w", err)
		}
		if _, err := adapter.Plugins.Verify(ctx, *manifest.ActiveGeneration); err != nil {
			return engine.Result{}, fmt.Errorf("plugin readiness failed during onboarding completion: %w", err)
		}
		return engine.Result{Outcome: engine.OutcomeAlreadyCurrent, Phase: model.PhaseCommitted}, nil
	}
	if err := adapter.Systemd.Start(ctx, gateway); err != nil {
		return engine.Result{}, err
	}
	if err := adapter.Systemd.IsActive(ctx, gateway); err != nil {
		return engine.Result{}, fmt.Errorf("Gateway is not active after onboarding completion: %w", err)
	}
	if err := adapter.Health.Verify(ctx, adapter.Config.GatewayPort, *manifest.ActiveGeneration); err != nil {
		return engine.Result{}, err
	}
	if _, err := adapter.Plugins.Verify(ctx, *manifest.ActiveGeneration); err != nil {
		return engine.Result{}, fmt.Errorf("plugin readiness failed during onboarding completion: %w", err)
	}
	return engine.Result{Outcome: engine.OutcomeUpdated, Phase: model.PhaseCommitted}, nil
}

func validateOnboardingConfig(config Config) error {
	path := filepath.Join(config.OwnerStateRoot, "fased.json")
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || !ok || stat.Nlink != 1 || stat.Uid != config.Operator.UID ||
		info.Mode().Perm()&0o007 != 0 || info.Mode().Perm()&0o111 != 0 || info.Size() == 0 || info.Size() > 4<<20 {
		return errors.New("lifecycle onboarding configuration is unsafe")
	}
	return nil
}

func (adapter *TargetAdapter) Prepare(ctx context.Context, tx model.Transaction) error {
	if err := adapter.validate(tx); err != nil {
		return err
	}
	pluginLock, err := adapter.Plugins.Prepare(ctx, tx.Target)
	if err != nil {
		return fmt.Errorf("plugin lock verification failed: %w", err)
	}
	if err := adapter.Predecessor.Prepare(ctx, tx); err != nil {
		return err
	}
	if err := adapter.Network.Verify(ctx, adapter.Config, tx); err != nil {
		return err
	}
	payload, err := adapter.Generations.GenerationPayloadPath(tx.Target.ID)
	if err != nil {
		return err
	}
	for _, relative := range []string{"bin/fased-gateway-launch", "bin/fased-signerd", "bin/node", "runtime/scripts/fased-signer-owner-hosting.sh"} {
		if err := requireExecutable(filepath.Join(payload, relative)); err != nil {
			return fmt.Errorf("target generation %s: %w", relative, err)
		}
	}
	dependency, err := adapter.Generations.GenerationDependencyPath(tx.Target.ID)
	if err != nil {
		return err
	}
	if err := adapter.Units.Prepare(tx.ID, adapter.renderTargetUnits(payload, tx.Target, dependency)); err != nil {
		return err
	}
	helper, err := os.ReadFile(filepath.Join(payload, "runtime/scripts/fased-signer-owner-hosting.sh"))
	if err != nil {
		return err
	}
	wrapper, err := RenderSignerOwnerWrapper(adapter.Config)
	if err != nil {
		return err
	}
	projection, err := CanonicalInstallProjectionJSON(adapter.Config, tx)
	if err != nil {
		return err
	}
	cliProjection, err := CanonicalCLIProjectionJSON(adapter.Config)
	if err != nil {
		return err
	}
	configGID, err := canonicalConfigGroupGID(adapter.Config.OwnerStateRoot, adapter.Config.Operator.UID)
	if err != nil {
		return err
	}
	paths := CanonicalSignerOwnerFiles(adapter.Config)
	files := map[string]LifecycleFile{
		paths[0]: {Data: helper, Mode: 0o755, UID: 0, GID: 0},
		paths[1]: {Data: wrapper, Mode: 0o755, UID: 0, GID: 0},
		CanonicalInstallProjectionPath(adapter.Config): {
			Data: projection, Mode: 0o640, UID: adapter.Config.Operator.UID, GID: adapter.Config.Operator.GID,
		},
		CanonicalCLIProjectionPath(adapter.Config): {
			Data: cliProjection, Mode: 0o640, UID: adapter.Config.Operator.UID, GID: configGID,
		},
		CanonicalProductVersionPath(adapter.Config): {
			Data: []byte(tx.Target.Version + "\n"), Mode: 0o600, UID: 0, GID: 0,
		},
		CanonicalPluginLockPath(adapter.Config): {
			Data: pluginLock.Data, Mode: 0o640, UID: adapter.Config.Operator.UID, GID: configGID,
		},
	}
	if !adapter.deferFreshGateway(tx) {
		configPath := CanonicalGatewayConfigPath(adapter.Config)
		if err := validateOnboardingConfig(adapter.Config); err != nil {
			return err
		}
		data, err := readRegularFile(configPath)
		if err != nil {
			return err
		}
		data, err = canonicalGatewayConfigForTransaction(adapter.Config, tx, data)
		if err != nil {
			return err
		}
		gid, err := canonicalConfigGroupGID(adapter.Config.OwnerStateRoot, adapter.Config.Operator.UID)
		if err != nil {
			return err
		}
		files[configPath] = LifecycleFile{Data: data, Mode: 0o660, UID: adapter.Config.Operator.UID, GID: gid}
	}
	return adapter.Files.Prepare(tx.ID, files)
}

func canonicalGatewayConfigForTransaction(config Config, tx model.Transaction, data []byte) ([]byte, error) {
	if config.Profile != model.ProfileHosting || tx.PlanAction != "BRIDGE_PUBLIC_STABLE" {
		return data, nil
	}
	declared := false
	for _, migration := range tx.Migrations {
		if migration.State == "configuration" && migration.From == 0 && migration.To == 1 {
			declared = true
			break
		}
	}
	if !declared {
		return nil, errors.New("Hosting public-stable bridge lacks its declared configuration migration")
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, errors.New("Hosting public-stable Gateway configuration is invalid")
	}
	gateway, ok := document["gateway"].(map[string]any)
	if !ok {
		return nil, errors.New("Hosting public-stable Gateway configuration is missing")
	}
	mode, ok := gateway["mode"].(string)
	if !ok || (mode != "remote" && mode != "local") {
		return nil, errors.New("Hosting public-stable Gateway mode is unsupported")
	}
	if mode == "local" {
		return data, nil
	}
	gateway["mode"] = "local"
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(encoded, '\n'), nil
}

func (adapter *TargetAdapter) Quiesce(ctx context.Context, tx model.Transaction) error {
	var quiesceError error
	if tx.Phase == model.PhasePrepared {
		// Fence the selected predecessor before switching. During
		// rollback it must remain stopped until Restore reactivates it.
		predecessorError := adapter.Predecessor.Quiesce(ctx, tx)
		if tx.Previous == nil {
			quiesceError = predecessorError
		} else {
			quiesceError = errors.Join(predecessorError, adapter.StopTarget(ctx, tx))
		}
	} else {
		quiesceError = adapter.StopTarget(ctx, tx)
	}
	if quiesceError != nil {
		return quiesceError
	}
	return nil
}

func (adapter *TargetAdapter) PrepareState(_ context.Context, tx model.Transaction) (engine.ParticipantReceipt, string, error) {
	prepared, err := adapter.TypedState.Prepare(tx.ID)
	if err != nil {
		return engine.ParticipantReceipt{}, "", err
	}
	receipt := engine.ParticipantReceipt{TransactionID: tx.ID, TargetGenerationID: tx.Target.ID, StateInventoryDigest: tx.StateInventoryDigest, PlanDigest: tx.StateInventoryDigest,
		MemberDigests: engine.StateMemberDigests{
			ApplicationState: prepared.ParticipantDigests["application-state"], Configuration: prepared.ParticipantDigests["configuration"],
			Wallet: prepared.ParticipantDigests["wallet"], Mining: prepared.ParticipantDigests["mining"], Federation: prepared.ParticipantDigests["federation"],
			PluginData: prepared.ParticipantDigests["plugin-data"], Signer: prepared.ParticipantDigests["signer"],
		}}
	return receipt, prepared.Digest, nil
}

func (adapter *TargetAdapter) StopTarget(ctx context.Context, _ model.Transaction) error {
	// Stop both services even when the Gateway is already failed or has been
	// removed by rollback. Returning after the first stop failure can leave the
	// signer running under a bootstrap-created account, which makes principal
	// rollback fail and correctly prevents canonical-root cleanup.
	return errors.Join(
		adapter.Systemd.Stop(ctx, adapter.Identity.Services["gateway"]),
		adapter.Systemd.Stop(ctx, adapter.Identity.Services["signer"]),
	)
}

func (adapter *TargetAdapter) Activate(ctx context.Context, tx model.Transaction) error {
	if err := adapter.TypedState.Activate(tx.ID); err != nil {
		return err
	}
	if err := adapter.Files.Activate(tx.ID, adapter.preStartLifecycleFiles(tx)); err != nil {
		return err
	}
	if err := adapter.TypedState.VerifyAccess(ctx, tx.ID); err != nil {
		return fmt.Errorf("typed state is inaccessible before service start: %w", err)
	}
	if err := adapter.Units.Activate(tx.ID, adapter.targetUnits()); err != nil {
		return err
	}
	if err := adapter.Systemd.DaemonReload(ctx); err != nil {
		return err
	}
	for _, unit := range adapter.startOrder() {
		if err := adapter.Systemd.Enable(ctx, unit); err != nil {
			return err
		}
		if adapter.deferFreshGateway(tx) && unit == adapter.Identity.Services["gateway"] {
			continue
		}
		if err := adapter.Systemd.Start(ctx, unit); err != nil {
			return err
		}
	}
	return nil
}

func (adapter *TargetAdapter) Verify(ctx context.Context, tx model.Transaction) (engine.ParticipantReceipt, error) {
	for _, unit := range adapter.startOrder() {
		if adapter.deferFreshGateway(tx) && unit == adapter.Identity.Services["gateway"] {
			continue
		}
		if err := adapter.Systemd.IsActive(ctx, unit); err != nil {
			return engine.ParticipantReceipt{}, fmt.Errorf("service %s is not active: %w", unit, err)
		}
	}
	if adapter.deferFreshGateway(tx) {
		// Fresh onboarding cannot produce plugin readiness until the owner has
		// written configuration and COMPLETE_ONBOARDING starts Gateway. That
		// boundary verifies the Gateway-written generation-bound receipt before
		// reporting onboarding complete.
		return engine.ParticipantReceipt{}, nil
	}
	if err := adapter.Health.Verify(ctx, adapter.Config.GatewayPort, tx.Target); err != nil {
		return engine.ParticipantReceipt{}, err
	}
	pluginReceipt, err := adapter.Plugins.Verify(ctx, tx.Target)
	if err != nil {
		return engine.ParticipantReceipt{}, fmt.Errorf("mandatory plugin readiness failed: %w", err)
	}
	return engine.ParticipantReceipt{TransactionID: tx.ID, TargetGenerationID: tx.Target.ID, StateInventoryDigest: tx.StateInventoryDigest, PlanDigest: tx.Target.ID, EvidenceDigest: pluginReceipt.Digest}, nil
}

func (adapter *TargetAdapter) Commit(ctx context.Context, tx model.Transaction) error {
	if adapter.localPublicStableBridge(tx) {
		if err := adapter.Fence.Verify(adapter.Config); err != nil {
			return err
		}
	}
	previous := ""
	if tx.Previous != nil {
		previous = tx.Previous.ID
	}
	if err := adapter.Generations.ActivateGeneration(tx.Target.ID, previous); err != nil {
		return err
	}
	if err := adapter.Files.Activate(tx.ID, adapter.commitLifecycleFiles(tx)); err != nil {
		return err
	}
	if err := adapter.Predecessor.Commit(ctx, tx); err != nil {
		return err
	}
	return errors.Join(adapter.Units.Discard(tx.ID), adapter.Files.Discard(tx.ID), adapter.TypedState.Discard(tx.ID))
}

func (adapter *TargetAdapter) Restore(ctx context.Context, tx model.Transaction) error {
	if err := adapter.Files.Restore(tx.ID, adapter.lifecycleFiles(tx)); err != nil {
		return err
	}
	if err := adapter.TypedState.Restore(tx.ID); err != nil {
		return err
	}
	if err := adapter.Units.Restore(tx.ID, adapter.targetUnits()); err != nil {
		return err
	}
	if err := adapter.Systemd.DaemonReload(ctx); err != nil {
		return err
	}
	if tx.Previous == nil {
		return adapter.Predecessor.Restore(ctx, tx)
	}
	for _, unit := range adapter.startOrder() {
		if err := adapter.Systemd.Start(ctx, unit); err != nil {
			return err
		}
	}
	return adapter.Predecessor.Restore(ctx, tx)
}

func (adapter *TargetAdapter) preStartLifecycleFiles(tx model.Transaction) []string {
	files := append(CanonicalSignerOwnerFiles(adapter.Config), CanonicalPluginLockPath(adapter.Config))
	if !adapter.deferFreshGateway(tx) {
		files = append(files, CanonicalGatewayConfigPath(adapter.Config))
	}
	return files
}

func (adapter *TargetAdapter) lifecycleFiles(tx model.Transaction) []string {
	return append(adapter.preStartLifecycleFiles(tx), adapter.commitLifecycleFiles(tx)...)
}

func (adapter *TargetAdapter) commitLifecycleFiles(tx model.Transaction) []string {
	return []string{
		CanonicalProductVersionPath(adapter.Config),
		CanonicalCLIProjectionPath(adapter.Config), CanonicalInstallProjectionPath(adapter.Config),
	}
}

func (adapter *TargetAdapter) localPublicStableBridge(tx model.Transaction) bool {
	return adapter.Config.Profile == model.ProfileProtectedLocal && tx.PlanAction == "BRIDGE_PUBLIC_STABLE"
}

func (adapter *TargetAdapter) Discard(ctx context.Context, tx model.Transaction) error {
	return errors.Join(adapter.Units.Discard(tx.ID), adapter.Files.Discard(tx.ID), adapter.TypedState.Discard(tx.ID), adapter.Predecessor.Discard(ctx, tx))
}

func (adapter *TargetAdapter) validate(tx model.Transaction) error {
	if adapter == nil || adapter.Units == nil || adapter.Files == nil || adapter.TypedState == nil || adapter.Systemd == nil || adapter.Generations == nil || adapter.Health == nil || adapter.Predecessor == nil || adapter.Fence == nil || adapter.Network == nil || adapter.Plugins == nil {
		return errors.New("target platform adapter is incomplete")
	}
	if err := adapter.Config.Validate(); err != nil {
		return err
	}
	identity, err := adapter.Config.Identity()
	if err != nil || identityDigest(identity, tx.Profile) != tx.PlatformDigest || identityDigest(adapter.Identity, tx.Profile) != tx.PlatformDigest {
		return errors.New("target platform adapter does not match transaction identity")
	}
	return nil
}

func identityDigest(identity model.PlatformIdentity, profile model.Profile) string {
	digest, _ := identity.Digest(profile)
	return digest
}

func (adapter *TargetAdapter) targetUnits() []string {
	return []string{adapter.Identity.Services["gateway"], adapter.Identity.Services["signer"]}
}

func (adapter *TargetAdapter) startOrder() []string {
	return []string{adapter.Identity.Services["signer"], adapter.Identity.Services["gateway"]}
}

// A fresh install reaches the product transaction before the unprivileged
// onboarding command has created fased.json. Keep the Gateway unit installed
// and enabled, but start only the signer; onboarding writes the configuration
// and starts the Gateway through COMPLETE_ONBOARDING. Updates and public-stable
// bridges still require Gateway readiness inside the lifecycle transaction.
func (adapter *TargetAdapter) deferFreshGateway(tx model.Transaction) bool {
	return (adapter.Config.Profile == model.ProfileProtectedLocal || adapter.Config.Profile == model.ProfileHosting) &&
		tx.PlanAction == "INSTALL" && tx.Previous == nil
}

func (adapter *TargetAdapter) renderTargetUnits(payload string, target model.Generation, dependency string) map[string][]byte {
	runtimeDirectory := strings.TrimPrefix(adapter.Config.RuntimeRoot, "/run/")
	if adapter.Config.Profile == model.ProfileProtectedLocal {
		runtimeDirectory = strings.Join([]string{
			runtimeDirectory,
			filepath.Join(runtimeDirectory, "application"), filepath.Join(runtimeDirectory, "operator"), filepath.Join(runtimeDirectory, "control"),
		}, " ")
	}
	signerState := adapter.Config.SignerStateRoot()
	updateGate := adapter.Config.UpdateGatePath()
	dependencyMount := ""
	if dependency != "" {
		dependencyMount = fmt.Sprintf("BindReadOnlyPaths=%s:%s\n", dependency, filepath.Join(payload, "runtime/node_modules"))
	}
	signer := fmt.Sprintf(`[Unit]
Description=Fased native signer (%s)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%d
Group=%d
RuntimeDirectory=%s
RuntimeDirectoryMode=0755
UMask=0077
ExecStart=%s -socket %s -operator-socket %s -control-socket %s -socket-mode 0660 -socket-group %s -operator-socket-group %s -application-uid %d -operator-uid %d -control-uid %d -state-db %s/state.db -master-key %s/master.key -update-gate %s -audit-log %s/audit.jsonl
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=%s %s
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
`, adapter.Config.InstanceID, adapter.Config.Signer.UID, adapter.Config.Signer.GID,
		runtimeDirectory, filepath.Join(payload, "bin/fased-signerd"), adapter.Config.ApplicationSocket(),
		adapter.Config.OperatorSocket(), adapter.Config.ControlSocket(), adapter.Config.GatewayGroupName(), adapter.Config.OperatorGroupName(), adapter.Config.Gateway.UID,
		adapter.Config.Operator.UID, adapter.Config.Signer.UID, signerState, signerState,
		updateGate, signerState, signerState, adapter.Config.RuntimeRoot)
	gateway := fmt.Sprintf(`[Unit]
Description=Fased Gateway (%s)
After=%s network-online.target
Wants=%s network-online.target

[Service]
Type=simple
User=%d
Group=%d
SupplementaryGroups=%s
UMask=0007
WorkingDirectory=%s/runtime
Environment=HOME=%s
Environment=FASED_STATE_DIR=%s
Environment=FASED_CONFIG_PATH=%s/fased.json
Environment=FASED_CONFIG_DIR=%s
Environment=FASED_PLUGIN_STATUS_CACHE_PATH=%s/cache/plugin-status.json
Environment=FASED_PLUGIN_READINESS_PATH=%s/cache/plugin-readiness.json
Environment=FASED_PLUGIN_CODE_ROOT=%s/plugin-code
Environment=FASED_PLUGIN_DATA_ROOT=%s/plugin-data
Environment=FASED_PLUGIN_LOCK_PATH=%s/plugin.lock.json
Environment=FASED_GENERATION_ID=%s
Environment=FASED_MANAGED_RUNTIME_ROOT=%s/runtime
Environment=FASED_GATEWAY_MODE=managed
Environment=FASED_MANAGED_INTERNAL=1
Environment=FASED_GATEWAY_SERVICE=1
Environment=FASED_RUNTIME_SOURCE=managed-package
Environment=FASED_VERSION=%s
Environment=FASED_HOST_PROFILE=%s
%sEnvironment=FASED_GATEWAY_PORT=%d
Environment=FASED_WALLET_LOCAL_SIGNER_SOCKET=%s
ExecStart=%s
Restart=always
RestartSec=1
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
%sReadWritePaths=%s
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
`, adapter.Config.InstanceID, adapter.Identity.Services["signer"], adapter.Identity.Services["signer"],
		adapter.Config.Gateway.UID, adapter.Config.Gateway.GID, adapter.Config.ConfigGroupName(), payload,
		adapter.Config.OwnerHome(), adapter.Config.OwnerStateRoot,
		adapter.Config.OwnerStateRoot, adapter.Config.OwnerStateRoot, adapter.Config.OwnerStateRoot, adapter.Config.OwnerStateRoot, adapter.Config.InstallRoot, adapter.Config.OwnerStateRoot, adapter.Config.OwnerStateRoot, target.ID, payload, target.Version, profileEnvironment(adapter.Config.Profile), protectedLocalEnvironment(adapter.Config.Profile, adapter.Config.InstanceID), adapter.Config.GatewayPort, adapter.Config.ApplicationSocket(),
		filepath.Join(payload, "bin/fased-gateway-launch"), dependencyMount, adapter.Config.OwnerStateRoot)
	return map[string][]byte{
		adapter.Identity.Services["signer"]: []byte(signer), adapter.Identity.Services["gateway"]: []byte(gateway),
	}
}

func profileEnvironment(profile model.Profile) string {
	if profile == model.ProfileProtectedLocal {
		return "local"
	}
	return "hosting"
}

func protectedLocalEnvironment(profile model.Profile, instanceID string) string {
	if profile == model.ProfileProtectedLocal {
		return fmt.Sprintf("Environment=FASED_PROTECTED_LOCAL=1\nEnvironment=FASED_PROTECTED_LOCAL_INSTANCE=%s\n", instanceID)
	}
	return ""
}

func requireExecutable(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o111 == 0 {
		return errors.New("required generation entrypoint is not a regular executable")
	}
	return nil
}
