package platform

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"fased-lifecycled/engine"
	"fased-lifecycled/model"
)

type ControllerGenerationManager interface {
	GenerationPayloadPath(string) (string, error)
	ActivateControllerGeneration(string, string) error
}

type ControllerAdapter struct {
	Config      Config
	Identity    model.PlatformIdentity
	Units       UnitStore
	Systemd     Systemd
	Generations ControllerGenerationManager
}

func (adapter *ControllerAdapter) Stage(_ context.Context, tx model.Transaction) error {
	if err := adapter.validate(tx); err != nil {
		return err
	}
	payload, err := adapter.Generations.GenerationPayloadPath(tx.Target.ID)
	if err != nil {
		return err
	}
	entrypoint := filepath.Join(payload, "bin/fased-lifecycled")
	if err := requireExecutable(entrypoint); err != nil {
		return err
	}
	unit := adapter.Identity.Services["controller"]
	return adapter.Units.Prepare(tx.ID, map[string][]byte{unit: adapter.renderControllerUnit(entrypoint)})
}

func (adapter *ControllerAdapter) Prepare(_ context.Context, tx model.Transaction) error {
	return adapter.validate(tx)
}

func (adapter *ControllerAdapter) Switch(ctx context.Context, tx model.Transaction) error {
	unit := adapter.Identity.Services["controller"]
	if tx.Previous != nil || tx.PlanAction == "BRIDGE_PUBLIC_STABLE" {
		if err := adapter.Systemd.Stop(ctx, unit); err != nil {
			return err
		}
	}
	if err := adapter.Units.Activate(tx.ID, []string{unit}); err != nil {
		return err
	}
	if err := adapter.Systemd.DaemonReload(ctx); err != nil {
		return err
	}
	if err := adapter.Systemd.Enable(ctx, unit); err != nil {
		return err
	}
	return adapter.Systemd.Start(ctx, unit)
}

func (adapter *ControllerAdapter) Verify(ctx context.Context, _ model.Transaction, target engine.Result) error {
	if target.Phase != model.PhaseVerified || target.Outcome != engine.OutcomePrepared {
		return errors.New("controller cannot verify an unprepared target transaction")
	}
	return adapter.Systemd.IsActive(ctx, adapter.Identity.Services["controller"])
}

func (adapter *ControllerAdapter) Commit(_ context.Context, tx model.Transaction) error {
	previous := ""
	if tx.Previous != nil {
		previous = tx.Previous.ID
	}
	if err := adapter.Generations.ActivateControllerGeneration(tx.Target.ID, previous); err != nil {
		return err
	}
	return adapter.Units.Discard(tx.ID)
}

func (adapter *ControllerAdapter) Restore(ctx context.Context, tx model.Transaction) error {
	unit := adapter.Identity.Services["controller"]
	if err := adapter.Systemd.Stop(ctx, unit); err != nil {
		return err
	}
	if err := adapter.Units.Restore(tx.ID, []string{unit}); err != nil {
		return err
	}
	if err := adapter.Systemd.DaemonReload(ctx); err != nil {
		return err
	}
	if tx.Previous == nil && tx.PlanAction != "BRIDGE_PUBLIC_STABLE" {
		return nil
	}
	return adapter.Systemd.Start(ctx, unit)
}

func (adapter *ControllerAdapter) Discard(_ context.Context, tx model.Transaction) error {
	return adapter.Units.Discard(tx.ID)
}

func (adapter *ControllerAdapter) validate(tx model.Transaction) error {
	if adapter == nil || adapter.Units == nil || adapter.Systemd == nil || adapter.Generations == nil {
		return errors.New("controller platform adapter is incomplete")
	}
	if err := adapter.Config.Validate(); err != nil {
		return err
	}
	configured, err := adapter.Config.Identity()
	if err != nil || identityDigest(configured, tx.Profile) != tx.PlatformDigest || identityDigest(adapter.Identity, tx.Profile) != tx.PlatformDigest {
		return errors.New("controller platform adapter does not match transaction identity")
	}
	return nil
}

func (adapter *ControllerAdapter) renderControllerUnit(entrypoint string) []byte {
	controllerRuntimeRoot := adapter.Config.ControllerRuntimeRoot()
	runtimeDirectory := strings.TrimPrefix(controllerRuntimeRoot, "/run/")
	unit := fmt.Sprintf(`[Unit]
Description=Fased target lifecycle controller (%s)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
RuntimeDirectory=%s
RuntimeDirectoryMode=0710
UMask=0077
ExecStart=%s target --config %s/platform.json --socket %s
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%s %s %s %s %s %s
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETUID CAP_SETGID
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
`, adapter.Config.InstanceID, runtimeDirectory, entrypoint, adapter.Config.LifecycleRoot,
		adapter.Config.ControllerSocket(), adapter.Config.InstallRoot, adapter.Config.LifecycleRoot,
		adapter.Config.ProductStateRoot, adapter.Config.OwnerStateRoot, adapter.Config.UnitRoot,
		filepath.Dir(adapter.Config.UpdateGatePath()))
	return []byte(unit)
}
