// Package participant defines version-neutral, typed product-state boundaries.
package participant

import "path/filepath"

type Kind string

const (
	ApplicationState Kind = "application-state"
	Configuration    Kind = "configuration"
	Wallet           Kind = "wallet"
	Mining           Kind = "mining"
	Federation       Kind = "federation"
	PluginData       Kind = "plugin-data"
	Signer           Kind = "signer"
)

type StateSpec struct {
	Kind        Kind
	Path        string
	RootOnly    bool
	SignerOwned bool
}

func CanonicalStateSpecs(ownerStateRoot, signerStateRoot string) []StateSpec {
	var specs []StateSpec
	for _, name := range []string{"agents", "channels", "cron", "delivery-queue", "devices", "extensions", "identity", "memory", "schedules", "secrets", "sessions", "tasks", "workspace"} {
		specs = append(specs, StateSpec{Kind: ApplicationState, Path: filepath.Join(ownerStateRoot, name)})
	}
	specs = append(specs,
		StateSpec{Kind: Configuration, Path: filepath.Join(ownerStateRoot, "fased.json"), RootOnly: true},
		StateSpec{Kind: Wallet, Path: filepath.Join(ownerStateRoot, "wallet"), RootOnly: true},
		StateSpec{Kind: Wallet, Path: filepath.Join(ownerStateRoot, "wallet", "provider-registry.v1.json"), RootOnly: true},
		StateSpec{Kind: Mining, Path: filepath.Join(ownerStateRoot, "sat-mining")},
		StateSpec{Kind: Federation, Path: filepath.Join(ownerStateRoot, "federation")},
		StateSpec{Kind: PluginData, Path: filepath.Join(ownerStateRoot, "plugin-data")},
	)
	for _, name := range []string{"state.db", "state.db-wal", "state.db-shm", "state.db-journal", "master.key", "audit.jsonl"} {
		specs = append(specs, StateSpec{Kind: Signer, Path: filepath.Join(signerStateRoot, name), RootOnly: true, SignerOwned: true})
	}
	return specs
}
