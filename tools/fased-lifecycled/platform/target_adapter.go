package platform

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"fased-lifecycled/model"
)

type GenerationManager interface {
	GenerationPayloadPath(string) (string, error)
	ActivateGeneration(string, string) error
}

type TargetAdapter struct {
	Config      Config
	Identity    model.PlatformIdentity
	Units       UnitStore
	Systemd     Systemd
	Generations GenerationManager
}

func (adapter *TargetAdapter) Prepare(_ context.Context, tx model.Transaction) error {
	if err := adapter.validate(tx); err != nil {
		return err
	}
	payload, err := adapter.Generations.GenerationPayloadPath(tx.Target.ID)
	if err != nil {
		return err
	}
	for _, relative := range []string{"bin/fased-gateway-launch", "bin/fased-signerd"} {
		if err := requireExecutable(filepath.Join(payload, relative)); err != nil {
			return fmt.Errorf("target generation %s: %w", relative, err)
		}
	}
	return adapter.Units.Prepare(tx.ID, adapter.renderTargetUnits(payload))
}

func (adapter *TargetAdapter) Quiesce(ctx context.Context, _ model.Transaction) error {
	if err := adapter.Systemd.Stop(ctx, adapter.Identity.Services["gateway"]); err != nil {
		return err
	}
	return adapter.Systemd.Stop(ctx, adapter.Identity.Services["signer"])
}

func (adapter *TargetAdapter) Activate(ctx context.Context, tx model.Transaction) error {
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
		if err := adapter.Systemd.Start(ctx, unit); err != nil {
			return err
		}
	}
	return nil
}

func (adapter *TargetAdapter) Verify(ctx context.Context, _ model.Transaction) error {
	for _, unit := range adapter.startOrder() {
		if err := adapter.Systemd.IsActive(ctx, unit); err != nil {
			return fmt.Errorf("service %s is not active: %w", unit, err)
		}
	}
	return nil
}

func (adapter *TargetAdapter) Commit(_ context.Context, tx model.Transaction) error {
	previous := ""
	if tx.Previous != nil {
		previous = tx.Previous.ID
	}
	if err := adapter.Generations.ActivateGeneration(tx.Target.ID, previous); err != nil {
		return err
	}
	return adapter.Units.Discard(tx.ID)
}

func (adapter *TargetAdapter) Restore(ctx context.Context, tx model.Transaction) error {
	if err := adapter.Units.Restore(tx.ID, adapter.targetUnits()); err != nil {
		return err
	}
	if err := adapter.Systemd.DaemonReload(ctx); err != nil {
		return err
	}
	if tx.Previous == nil {
		return nil
	}
	for _, unit := range adapter.startOrder() {
		if err := adapter.Systemd.Start(ctx, unit); err != nil {
			return err
		}
	}
	return nil
}

func (adapter *TargetAdapter) Discard(_ context.Context, tx model.Transaction) error {
	return adapter.Units.Discard(tx.ID)
}

func (adapter *TargetAdapter) validate(tx model.Transaction) error {
	if adapter == nil || adapter.Units == nil || adapter.Systemd == nil || adapter.Generations == nil {
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

func (adapter *TargetAdapter) renderTargetUnits(payload string) map[string][]byte {
	runtimeDirectory := strings.TrimPrefix(adapter.Config.RuntimeRoot, "/run/")
	signerState := filepath.Join(adapter.Config.ProductStateRoot, "signer")
	controllerState := filepath.Join(adapter.Config.ProductStateRoot, "controller")
	signer := fmt.Sprintf(`[Unit]
Description=Fased native signer (%s)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%d
Group=%d
RuntimeDirectory=%s
RuntimeDirectoryMode=0750
UMask=0077
ExecStart=%s -socket %s/application.sock -operator-socket %s/operator.sock -control-socket %s/control.sock -application-uid %d -operator-uid %d -control-uid %d -state-db %s/state.db -master-key %s/master.key -update-gate %s/signer-update-gate -audit-log %s/audit.jsonl
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
		runtimeDirectory, filepath.Join(payload, "bin/fased-signerd"), adapter.Config.RuntimeRoot,
		adapter.Config.RuntimeRoot, adapter.Config.RuntimeRoot, adapter.Config.Gateway.UID,
		adapter.Config.Operator.UID, adapter.Config.Signer.UID, signerState, signerState,
		controllerState, signerState, signerState, adapter.Config.RuntimeRoot)
	gateway := fmt.Sprintf(`[Unit]
Description=Fased Gateway (%s)
After=%s network-online.target
Wants=%s network-online.target

[Service]
Type=simple
User=%d
Group=%d
UMask=0007
Environment=FASED_STATE_DIR=%s
Environment=FASED_CONFIG_PATH=%s/fased.json
Environment=FASED_WALLET_LOCAL_SIGNER_SOCKET=%s/application.sock
ExecStart=%s
Restart=always
RestartSec=1
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%s
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
`, adapter.Config.InstanceID, adapter.Identity.Services["signer"], adapter.Identity.Services["signer"],
		adapter.Config.Gateway.UID, adapter.Config.Gateway.GID, adapter.Config.OwnerStateRoot,
		adapter.Config.OwnerStateRoot, adapter.Config.RuntimeRoot,
		filepath.Join(payload, "bin/fased-gateway-launch"), adapter.Config.OwnerStateRoot)
	return map[string][]byte{
		adapter.Identity.Services["signer"]: []byte(signer), adapter.Identity.Services["gateway"]: []byte(gateway),
	}
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
