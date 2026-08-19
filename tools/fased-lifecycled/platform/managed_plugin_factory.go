package platform

import (
	"errors"
	"path/filepath"

	"fased-lifecycled/participant"
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

func managedPluginProductionBoundary(config Config, tx ManagedPluginTransaction, configGID uint32) participant.PluginBoundary {
	return participant.PluginBoundary{CodeRoot: tx.CodeRoot, DataRoot: filepath.Join(config.OwnerStateRoot, "plugin-data"), LockPath: CanonicalPluginLockPath(config), ReadinessPath: filepath.Join(config.OwnerStateRoot, "cache", "plugin-readiness.json"), CodeOwnerUID: tx.CodeOwnerUID, OperatorUID: config.Operator.UID, GatewayUID: config.Gateway.UID, ConfigGID: configGID}
}
