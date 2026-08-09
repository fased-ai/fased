// Package bootstrap owns the root-only pre-manifest lifecycle transaction.
package bootstrap

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"fased-lifecycled/model"
	"fased-lifecycled/platform"
	"fased-lifecycled/store"
)

type PlatformBootstrapRequest struct {
	TransactionID           string
	Profile                 model.Profile
	InstanceIDAssertion     string
	OperatorUser            string
	OwnerStateRoot          string
	GatewayPort             uint16
	ExpectedRegistryOwner   uint32
	RegistryPath            string
	JournalPath             string
	StableDaemonPath        string
	StableDaemon            []byte
	Principals              platform.PrincipalSystem
	ACL                     platform.HomeACL
	Systemd                 platform.Systemd
	InstanceIDSource        platform.InstanceIDSource
	ExistingConfigValidator func(platform.Config) error
}

type PlatformBootstrapResult struct {
	Config      platform.Config
	Transaction *platform.AppliedBootstrapTransaction
}

func BeginPlatformBootstrap(ctx context.Context, request PlatformBootstrapRequest) (PlatformBootstrapResult, error) {
	if request.Principals == nil || request.Systemd == nil || request.GatewayPort == 0 || len(request.StableDaemon) == 0 ||
		!filepath.IsAbs(request.JournalPath) || !filepath.IsAbs(request.StableDaemonPath) {
		return PlatformBootstrapResult{}, errors.New("platform bootstrap dependencies are incomplete")
	}
	journal, err := platform.OpenBootstrapJournal(request.JournalPath, request.TransactionID)
	if err != nil {
		return PlatformBootstrapResult{}, err
	}
	operator, exists, err := request.Principals.LookupUser(ctx, request.OperatorUser)
	if err != nil || (!exists && request.Profile != model.ProfileHosting) || (exists && (operator.UID == 0 || operator.Home != filepath.Dir(request.OwnerStateRoot))) {
		return PlatformBootstrapResult{}, errors.New("platform bootstrap operator is unavailable or unsafe")
	}
	instanceID := "hosting"
	var allocation platform.LocalInstanceAllocation
	steps := []platform.BootstrapStep{}
	if request.Profile == model.ProfileProtectedLocal {
		if request.RegistryPath == "" {
			request.RegistryPath = platform.LocalInstanceRegistryPath
		}
		allocation, err = platform.PlanLocalInstance(request.RegistryPath, request.ExpectedRegistryOwner, platform.LocalInstanceRequest{
			TransactionID: request.TransactionID, OperatorUID: operator.UID, OperatorUser: request.OperatorUser,
			Profile: string(request.Profile), StateDir: request.OwnerStateRoot,
		}, request.InstanceIDSource, timeNow())
		if err != nil {
			return PlatformBootstrapResult{}, err
		}
		instanceID = allocation.Entry.InstanceID
		if request.InstanceIDAssertion != "" && request.InstanceIDAssertion != instanceID {
			return PlatformBootstrapResult{}, errors.New("caller instance assertion differs from the authoritative Local registry")
		}
		steps = append(steps, platform.BootstrapStep{Phase: platform.BootstrapPhaseRegistry, Apply: func() (platform.BootstrapUndo, error) {
			if !allocation.Created {
				return func() error { return nil }, nil
			}
			if err := platform.CommitLocalInstance(request.RegistryPath, request.ExpectedRegistryOwner, &allocation); err != nil {
				return nil, err
			}
			return func() error {
				return platform.RollbackLocalInstance(request.RegistryPath, request.ExpectedRegistryOwner, &allocation)
			}, nil
		}})
	} else if request.Profile != model.ProfileHosting {
		return PlatformBootstrapResult{}, errors.New("platform bootstrap profile is unsupported")
	}

	configPath := platformConfigPath(request.Profile, instanceID)
	existingConfig, configExists, err := readExistingPlatformConfig(configPath)
	if err != nil {
		return PlatformBootstrapResult{}, err
	}
	if request.ExistingConfigValidator != nil && configExists {
		if err := request.ExistingConfigValidator(existingConfig); err != nil {
			return PlatformBootstrapResult{}, err
		}
	}

	var principals platform.BootstrapPrincipals
	var config platform.Config
	steps = append(steps, platform.BootstrapStep{Phase: platform.BootstrapPhasePrincipals, Apply: func() (platform.BootstrapUndo, error) {
		var changes *platform.PrincipalChanges
		principals, changes, err = platform.ProvisionBootstrapPrincipalsTransactional(ctx, request.Principals, platform.BootstrapRequest{
			Profile: request.Profile, InstanceID: instanceID, OperatorUser: request.OperatorUser, OwnerStateRoot: request.OwnerStateRoot,
		})
		if err != nil {
			return nil, err
		}
		config, err = platform.NewConfigWithGatewayPort(request.Profile, instanceID, request.OwnerStateRoot, request.GatewayPort,
			principals.Operator, principals.Gateway, principals.Signer)
		if err != nil {
			return nil, errors.Join(err, changes.Rollback(ctx))
		}
		if configExists && existingConfig != config {
			return nil, errors.Join(errors.New("existing platform configuration differs; explicit repair is required"), changes.Rollback(ctx))
		}
		return func() error { return changes.Rollback(ctx) }, nil
	}})
	steps = append(steps, platform.BootstrapStep{Phase: platform.BootstrapPhasePaths, Apply: func() (platform.BootstrapUndo, error) {
		plan, err := platform.BootstrapPathPlan(config, principals)
		if err != nil {
			return nil, err
		}
		changes, err := platform.ApplyBootstrapPathPlanTransactional(plan)
		if err != nil {
			return nil, err
		}
		return changes.Rollback, nil
	}})
	if request.Profile == model.ProfileProtectedLocal {
		steps = append(steps, platform.BootstrapStep{Phase: platform.BootstrapPhaseACL, Apply: func() (platform.BootstrapUndo, error) {
			if request.ACL == nil {
				return nil, errors.New("Local ACL support is unavailable before mutation")
			}
			home := filepath.Dir(request.OwnerStateRoot)
			snapshot, err := request.ACL.Capture(ctx, home)
			if err != nil {
				return nil, err
			}
			hasTraversal, err := request.ACL.HasExactTraversal(snapshot, principals.Gateway.UID)
			if err != nil {
				return nil, err
			}
			if hasTraversal {
				if !configExists {
					return nil, errors.New("unmanaged Gateway UID collides with an existing owner-home ACL entry")
				}
				return func() error { return nil }, nil
			}
			if err := request.ACL.GrantTraversal(ctx, home, principals.Gateway.UID, snapshot); err != nil {
				return nil, err
			}
			return func() error { return request.ACL.Restore(ctx, home, snapshot) }, nil
		}})
	}
	steps = append(steps, platform.BootstrapStep{Phase: platform.BootstrapPhaseDaemon, Apply: func() (platform.BootstrapUndo, error) {
		replacement, err := platform.InstallFileTransactional(request.StableDaemonPath, request.StableDaemon, 0o755, 0, 0)
		if err != nil {
			return nil, err
		}
		return replacement.Rollback, nil
	}})
	steps = append(steps, platform.BootstrapStep{Phase: platform.BootstrapPhaseConfig, Apply: func() (platform.BootstrapUndo, error) {
		if _, err := store.OpenLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot}); err != nil {
			return nil, err
		}
		data, err := platform.CanonicalConfigJSON(config)
		if err != nil {
			return nil, err
		}
		replacement, err := platform.InstallFileTransactional(filepath.Join(config.LifecycleRoot, "platform.json"), data, 0o600, 0, 0)
		if err != nil {
			return nil, err
		}
		return replacement.Rollback, nil
	}})
	steps = append(steps, platform.BootstrapStep{Phase: platform.BootstrapPhaseUnits, Apply: func() (platform.BootstrapUndo, error) {
		identity, err := config.Identity()
		if err != nil {
			return nil, err
		}
		unit := identity.Services["supervisor"]
		unitData, err := platform.RenderSupervisorUnit(config, request.StableDaemonPath)
		if err != nil {
			return nil, err
		}
		wasEnabled := request.Systemd.IsEnabled(ctx, unit) == nil
		wasActive := request.Systemd.IsActive(ctx, unit) == nil
		if wasActive {
			if err := request.Systemd.Stop(ctx, unit); err != nil {
				return nil, err
			}
		}
		replacement, err := platform.InstallFileTransactional(filepath.Join(config.UnitRoot, unit), unitData, 0o644, 0, 0)
		if err != nil {
			if wasActive {
				_ = request.Systemd.Start(ctx, unit)
			}
			return nil, err
		}
		if err := request.Systemd.DaemonReload(ctx); err != nil {
			return nil, errors.Join(err, replacement.Rollback())
		}
		if !wasEnabled {
			if err := request.Systemd.Enable(ctx, unit); err != nil {
				return nil, errors.Join(err, replacement.Rollback())
			}
		}
		undo := func() error {
			var failures []error
			failures = append(failures, request.Systemd.Stop(ctx, unit))
			if !wasEnabled {
				failures = append(failures, request.Systemd.Disable(ctx, unit))
			}
			failures = append(failures, replacement.Rollback(), request.Systemd.DaemonReload(ctx))
			if wasActive {
				failures = append(failures, request.Systemd.Start(ctx, unit))
			}
			return errors.Join(failures...)
		}
		return undo, nil
	}})

	transaction, err := platform.BeginBootstrapTransaction(journal, steps)
	if err != nil {
		return PlatformBootstrapResult{}, err
	}
	return PlatformBootstrapResult{Config: config, Transaction: transaction}, nil
}

var timeNow = time.Now

func platformConfigPath(profile model.Profile, instanceID string) string {
	if profile == model.ProfileHosting {
		return "/var/lib/fased-lifecycled/platform.json"
	}
	return filepath.Join("/var/lib/fased-local", instanceID, "lifecycle", "platform.json")
}

func readExistingPlatformConfig(path string) (platform.Config, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return platform.Config{}, false, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 {
		return platform.Config{}, false, errors.New("existing platform configuration is unsafe")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return platform.Config{}, false, err
	}
	config, err := platform.DecodeConfig(data)
	if err != nil {
		return platform.Config{}, false, err
	}
	return config, true, nil
}
