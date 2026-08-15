package platform

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"

	"fased-lifecycled/model"
)

type currentServiceState struct {
	unit    string
	active  bool
	enabled bool
}

// RepairCurrent regenerates the replaceable service and projection bytes from
// the exact committed generation. It never changes generation, release
// authority, state schema, or user data. Every live mutation has an exact
// unit/file and service-state rollback.
func (adapter *TargetAdapter) RepairCurrent(ctx context.Context, transactionID string, manifest model.Manifest, manifestDigest string) (digest string, resultErr error) {
	if adapter == nil || adapter.Units == nil || adapter.Files == nil || adapter.Systemd == nil || adapter.Generations == nil || adapter.Health == nil || adapter.Plugins == nil {
		return "", errors.New("managed repair adapter is incomplete")
	}
	if err := manifest.Validate(); err != nil || manifest.Profile != adapter.Config.Profile || manifest.ActiveGeneration == nil || !validDigest(manifestDigest) {
		return "", errors.Join(err, errors.New("managed repair manifest is invalid"))
	}
	identity, err := adapter.Config.Identity()
	if err != nil {
		return "", err
	}
	platformDigest, err := identity.Digest(manifest.Profile)
	installedPlatformDigest, manifestPlatformErr := manifest.Platform.Digest(manifest.Profile)
	if err != nil || manifestPlatformErr != nil || installedPlatformDigest != platformDigest || identityDigest(adapter.Identity, manifest.Profile) != platformDigest {
		return "", errors.New("managed repair platform identity differs from the committed manifest")
	}
	tx := model.Transaction{
		SchemaVersion: model.CurrentTransactionSchemaVersion, ID: transactionID, Profile: manifest.Profile,
		PlanAction: "REPAIR_CURRENT", ReleaseSequence: manifest.ReleaseSequence, SecurityEpoch: manifest.SecurityEpoch,
		Target: *manifest.ActiveGeneration, TargetStateSchemas: manifest.StateSchemas, TargetCapabilities: manifest.Capabilities,
		ManifestDigest: manifestDigest, PlatformDigest: platformDigest,
	}
	defer func() {
		resultErr = errors.Join(resultErr, adapter.Files.Discard(tx.ID), adapter.Plugins.Discard(tx), adapter.Units.Discard(tx.ID))
	}()
	pluginLock, err := adapter.Plugins.Prepare(ctx, tx)
	if err != nil {
		return "", fmt.Errorf("plugin lock verification failed: %w", err)
	}
	if err := adapter.Network.Verify(ctx, adapter.Config, tx); err != nil {
		return "", err
	}
	payload, err := adapter.Generations.GenerationPayloadPath(tx.Target.ID)
	if err != nil {
		return "", err
	}
	for _, relative := range []string{"bin/fased-gateway-launch", "bin/fased-signerd", "bin/node", "runtime/scripts/fased-signer-owner-hosting.sh"} {
		if err := requireExecutable(filepath.Join(payload, relative)); err != nil {
			return "", fmt.Errorf("current generation %s: %w", relative, err)
		}
	}
	dependency, err := adapter.Generations.GenerationDependencyPath(tx.Target.ID)
	if err != nil {
		return "", err
	}
	definitions, err := adapter.renderTargetUnits(payload, tx.Target, dependency)
	if err != nil {
		return "", err
	}
	if err := adapter.Units.Prepare(tx.ID, definitions); err != nil {
		return "", err
	}
	projection, err := CanonicalInstallProjectionForManifestJSON(adapter.Config, manifest)
	if err != nil {
		return "", err
	}
	if err := adapter.prepareLifecycleFiles(tx, payload, pluginLock, projection); err != nil {
		return "", err
	}
	states := make([]currentServiceState, 0, len(adapter.targetUnits()))
	for _, unit := range adapter.targetUnits() {
		states = append(states, currentServiceState{unit: unit, active: adapter.Systemd.IsActive(ctx, unit) == nil, enabled: adapter.Systemd.IsEnabled(ctx, unit) == nil})
	}
	mutated := false
	rollback := func(cause error) error {
		if !mutated {
			return cause
		}
		failures := []error{cause}
		for _, unit := range adapter.targetUnits() {
			failures = append(failures, adapter.Systemd.Stop(ctx, unit))
		}
		failures = append(failures, adapter.Files.Restore(tx.ID, adapter.lifecycleFiles(tx)))
		failures = append(failures, adapter.Units.Restore(tx.ID, adapter.targetUnits()))
		failures = append(failures, adapter.Systemd.DaemonReload(ctx))
		for _, state := range states {
			if state.enabled {
				failures = append(failures, adapter.Systemd.Enable(ctx, state.unit))
			} else {
				failures = append(failures, adapter.Systemd.Disable(ctx, state.unit))
			}
		}
		for _, state := range states {
			if state.active {
				failures = append(failures, adapter.Systemd.ResetFailed(ctx, state.unit), adapter.Systemd.Start(ctx, state.unit))
			}
		}
		return fmt.Errorf("managed repair rolled back: %w", errors.Join(failures...))
	}
	mutated = true
	for _, unit := range adapter.targetUnits() {
		if err := adapter.Systemd.Stop(ctx, unit); err != nil {
			return "", rollback(err)
		}
	}
	if err := adapter.Files.Activate(tx.ID, adapter.preStartLifecycleFiles(tx)); err != nil {
		return "", rollback(err)
	}
	if err := adapter.Units.Activate(tx.ID, adapter.targetUnits()); err != nil {
		return "", rollback(err)
	}
	if err := adapter.Systemd.DaemonReload(ctx); err != nil {
		return "", rollback(err)
	}
	for _, unit := range adapter.startOrder() {
		if err := adapter.Systemd.Enable(ctx, unit); err != nil {
			return "", rollback(err)
		}
		if err := adapter.Systemd.ResetFailed(ctx, unit); err != nil {
			return "", rollback(err)
		}
		if err := adapter.Systemd.Start(ctx, unit); err != nil {
			return "", rollback(err)
		}
	}
	if err := adapter.Files.Activate(tx.ID, adapter.commitLifecycleFiles(tx)); err != nil {
		return "", rollback(err)
	}
	digest, err = adapter.VerifyCurrent(ctx, manifest, manifestDigest)
	if err != nil {
		return "", rollback(err)
	}
	return digest, nil
}
