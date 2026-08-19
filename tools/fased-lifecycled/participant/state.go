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
	Kind            Kind
	Path            string
	RootOnly        bool
	SignerOwned     bool
	ProjectionOwned bool
	SQLite          bool
	// SQLiteMains declares exact database mains inside an otherwise ordinary
	// recursive participant. It keeps a single application-state directory
	// from accidentally treating every *.sqlite file as a lifecycle database.
	SQLiteMains []string
}

func CanonicalStateSpecs(ownerStateRoot, signerStateRoot string) []StateSpec {
	var specs []StateSpec
	for _, name := range []string{"agents", "channels", "cron", "delivery-queue", "devices", "identity", "memory", "schedules", "secrets", "sessions", "workspace"} {
		specs = append(specs, StateSpec{Kind: ApplicationState, Path: filepath.Join(ownerStateRoot, name)})
	}
	specs = append(specs,
		// The task directory otherwise remains ordinary application state, but
		// the managed ledger and any WAL/SHM/journal members are one durable
		// SQLite family. JSON-only predecessor installs remain valid because
		// this declaration is inert until the exact main database exists.
		StateSpec{Kind: ApplicationState, Path: filepath.Join(ownerStateRoot, "tasks"), SQLiteMains: []string{filepath.Join(ownerStateRoot, "tasks", "task-ledger.sqlite")}},
		StateSpec{Kind: Configuration, Path: filepath.Join(ownerStateRoot, "fased.json"), RootOnly: true, ProjectionOwned: true},
		StateSpec{Kind: Configuration, Path: filepath.Join(ownerStateRoot, "install.json"), RootOnly: true, ProjectionOwned: true},
		StateSpec{Kind: Configuration, Path: filepath.Join(ownerStateRoot, "lifecycle.json"), RootOnly: true, ProjectionOwned: true},
		// Bind the Wallet directory metadata separately from its one declared
		// application-owned file. This gives the isolated Gateway the required
		// traversal/write boundary without recursively snapshotting legacy key
		// files. Signer custody remains opaque under signerStateRoot.
		StateSpec{Kind: Wallet, Path: filepath.Join(ownerStateRoot, "wallet"), RootOnly: true},
		StateSpec{Kind: Wallet, Path: filepath.Join(ownerStateRoot, "wallet", "provider-registry.v1.json"), RootOnly: true},
		StateSpec{Kind: Mining, Path: filepath.Join(ownerStateRoot, "sat-mining"), SQLite: true},
		StateSpec{Kind: Federation, Path: filepath.Join(ownerStateRoot, "federation"), SQLite: true},
		StateSpec{Kind: PluginData, Path: filepath.Join(ownerStateRoot, "plugin-data")},
		// Signer database and key contents remain exclusively signer-owned. The
		// lifecycle participant records only the signer root identity and relies
		// on the typed signer RPC for database prepare/commit/rollback.
		StateSpec{Kind: Signer, Path: signerStateRoot, RootOnly: true, SignerOwned: true},
	)
	return specs
}
