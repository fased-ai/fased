package migrator

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"fased-lifecycled/model"
	"fased-lifecycled/platform"
)

func hostedSignerFixture(t *testing.T) (HostedSignerMigrationAdapter, model.Transaction, model.Migration, string, string) {
	t.Helper()
	root := t.TempDir()
	config, err := platform.NewConfig(
		model.ProfileHosting, "hosting", "/home/app/.fased",
		platform.Principal{UID: 1000, GID: 1000},
		platform.Principal{UID: 1001, GID: 1001},
		platform.Principal{UID: 1002, GID: 1002},
	)
	if err != nil {
		t.Fatal(err)
	}
	walletDirectory := filepath.Join(root, "home/app/.fased/wallet")
	if err := os.MkdirAll(walletDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "home/fased-signer/.fased/wallet"), 0o700); err != nil {
		t.Fatal(err)
	}
	registryPath := filepath.Join(walletDirectory, "provider-registry.v1.json")
	configPath := filepath.Join(root, "home/app/.fased/fased.json")
	registry := map[string]any{
		"version": 1,
		"providers": map[string]any{
			"embedded-keystore":   map[string]any{"enabled": true, "updatedAt": "before"},
			"local-socket-signer": map[string]any{"enabled": false, "updatedAt": "before"},
		},
		"wallets": []any{map[string]any{
			"id": "agent-2", "name": "Agent 2", "providerId": "embedded-keystore",
			"addresses": map[string]any{"solana": "11111111111111111111111111111111"},
			"metadata":  map[string]any{"role": "agent"}, "updatedAt": "before",
		}},
		"defaultWalletId": "agent-2", "updatedAt": "before",
	}
	configuration := map[string]any{
		"wallet": map[string]any{"provider": "embedded-keystore", "keystore": map[string]any{"passphraseFile": "legacy"}},
		"env": map[string]any{"vars": map[string]any{
			"FASED_WALLET_PASSPHRASE":              "fixture-passphrase",
			"FASED_WALLET_SOLANA_RPC_URL__AGENT_2": "https://rpc.example.test",
		}},
	}
	for path, value := range map[string]any{registryPath: registry, configPath: configuration} {
		data, _ := json.MarshalIndent(value, "", "  ")
		if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	keystorePath := filepath.Join(walletDirectory, "keystore-solana-agent-2.v1.enc")
	if err := os.WriteFile(keystorePath, []byte("encrypted-wallet"), 0o600); err != nil {
		t.Fatal(err)
	}
	tx := migrationTransaction("signer", 1, 2)
	tx.Profile = model.ProfileHosting
	predecessor, _ := model.NewPlatformIdentity(model.ProfileHosting, "hosting", digestA)
	tx.PredecessorPlatform = &predecessor
	var calls []string
	adapter := HostedSignerMigrationAdapter{
		Config: config, rootPrefix: root,
		now: func() time.Time { return time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC) },
		run: func(_ context.Context, _ string, args []string) error {
			calls = append(calls, args[len(args)-1])
			return nil
		},
	}
	_ = calls
	return adapter, tx, tx.Migrations[0], registryPath, configPath
}

func TestHostedSignerMigrationActivatesAndRollsBackExactApplicationState(t *testing.T) {
	adapter, tx, migration, registryPath, configPath := hostedSignerFixture(t)
	registryBefore, _ := os.ReadFile(registryPath)
	configBefore, _ := os.ReadFile(configPath)
	if err := adapter.Prepare(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	var registry map[string]any
	data, _ := os.ReadFile(registryPath)
	if json.Unmarshal(data, &registry) != nil {
		t.Fatal("activated registry is invalid")
	}
	wallets := registry["wallets"].([]any)
	if wallets[0].(map[string]any)["providerId"] != "local-socket-signer" {
		t.Fatal("embedded wallet was not routed to the native signer")
	}
	var configuration map[string]any
	data, _ = os.ReadFile(configPath)
	_ = json.Unmarshal(data, &configuration)
	vars := configuration["env"].(map[string]any)["vars"].(map[string]any)
	if _, exists := vars["FASED_WALLET_PASSPHRASE"]; exists {
		t.Fatal("legacy inline passphrase remained Gateway-readable")
	}
	if err := adapter.Verify(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Abort(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(registryPath); !reflect.DeepEqual(got, registryBefore) {
		t.Fatal("rollback did not restore the exact registry bytes")
	}
	if got, _ := os.ReadFile(configPath); !reflect.DeepEqual(got, configBefore) {
		t.Fatal("rollback did not restore the exact configuration bytes")
	}
}

func TestHostedSignerMigrationDefersNativeImportUntilCommit(t *testing.T) {
	adapter, tx, migration, _, _ := hostedSignerFixture(t)
	var phases []string
	adapter.run = func(_ context.Context, binary string, args []string) error {
		if !strings.HasSuffix(binary, "/payload/bin/fased-signerd") {
			t.Fatalf("unexpected target signer binary: %s", binary)
		}
		phases = append(phases, args[len(args)-1])
		return nil
	}
	if err := adapter.Prepare(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Verify(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(phases, []string{"validate"}) {
		t.Fatalf("rollback-capable verification mutated signer state: %v", phases)
	}
	if err := adapter.Commit(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(phases, []string{"validate", "prepare", "commit"}) {
		t.Fatalf("native migration phases are not transactionally ordered: %v", phases)
	}
}

func TestHostedSignerMigrationRetriesCleanupWithoutRepeatingNativeCommit(t *testing.T) {
	adapter, tx, migration, _, _ := hostedSignerFixture(t)
	var phases []string
	adapter.run = func(_ context.Context, _ string, args []string) error {
		phases = append(phases, args[len(args)-1])
		return nil
	}
	if err := adapter.Prepare(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	unexpectedPath := filepath.Join(adapter.stateRoot(tx), "unexpected")
	if err := os.WriteFile(unexpectedPath, []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Commit(context.Background(), tx, migration); err == nil || !strings.Contains(err.Error(), "unexpected entry") {
		t.Fatalf("unsafe cleanup unexpectedly succeeded: %v", err)
	}
	record, err := adapter.readRecord(tx)
	if err != nil {
		t.Fatal(err)
	}
	if !record.NativeCommitted {
		t.Fatal("native custody commit was not durably recorded before cleanup")
	}
	if err := adapter.Abort(context.Background(), tx, migration); err == nil || !strings.Contains(err.Error(), "migration has started") {
		t.Fatalf("committed native custody was allowed to roll back: %v", err)
	}
	if err := os.Remove(unexpectedPath); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Commit(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(phases, []string{"prepare", "commit"}) {
		t.Fatalf("cleanup retry repeated native custody mutation: %v", phases)
	}
	if _, err := os.Stat(adapter.stateRoot(tx)); !os.IsNotExist(err) {
		t.Fatalf("completed migration state was not removed: %v", err)
	}
}

func TestHostedSignerMigrationRetriesNativeCommitInsteadOfRollingBack(t *testing.T) {
	adapter, tx, migration, _, _ := hostedSignerFixture(t)
	failCommit := true
	adapter.run = func(_ context.Context, _ string, args []string) error {
		if args[len(args)-1] == "commit" && failCommit {
			return os.ErrInvalid
		}
		return nil
	}
	if err := adapter.Prepare(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Commit(context.Background(), tx, migration); err == nil {
		t.Fatal("native commit failure was ignored")
	}
	if err := adapter.Abort(context.Background(), tx, migration); err == nil || !strings.Contains(err.Error(), "migration has started") {
		t.Fatalf("partially executed native migration was allowed to roll back: %v", err)
	}
	failCommit = false
	if err := adapter.Commit(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
}

func TestHostedSignerMigrationRejectsOrphanedLegacyKeystore(t *testing.T) {
	adapter, tx, migration, registryPath, _ := hostedSignerFixture(t)
	data, _ := os.ReadFile(registryPath)
	var registry map[string]any
	_ = json.Unmarshal(data, &registry)
	registry["wallets"] = []any{}
	data, _ = json.Marshal(registry)
	if err := os.WriteFile(registryPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Prepare(context.Background(), tx, migration); err == nil || !strings.Contains(err.Error(), "without registered embedded wallets") {
		t.Fatalf("orphaned legacy custody was accepted: %v", err)
	}
}

func TestHostedSignerMigrationRejectsStateChangeAfterPrepare(t *testing.T) {
	adapter, tx, migration, registryPath, _ := hostedSignerFixture(t)
	if err := adapter.Prepare(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(registryPath, []byte(`{"version":1,"wallets":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx, migration); err == nil || !strings.Contains(err.Error(), "changed after migration prepare") {
		t.Fatalf("concurrent legacy state change was overwritten: %v", err)
	}
}

func TestHostedSignerMigrationRejectsSymlinkedWalletDirectory(t *testing.T) {
	adapter, tx, migration, registryPath, _ := hostedSignerFixture(t)
	walletDirectory := filepath.Dir(registryPath)
	realDirectory := walletDirectory + "-real"
	if err := os.Rename(walletDirectory, realDirectory); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realDirectory, walletDirectory); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Prepare(context.Background(), tx, migration); err == nil || !strings.Contains(err.Error(), "non-symlink directory") {
		t.Fatalf("symlinked legacy wallet directory was accepted: %v", err)
	}
}
