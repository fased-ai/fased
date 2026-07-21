package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func hostedMigrationCanonicalTempDirV1(t *testing.T) string {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolve hosted migration test directory: %v", err)
	}
	return directory
}

func validHostedMigrationPolicyV1(t *testing.T) []byte {
	t.Helper()
	encoded, err := json.Marshal(hostedMigrationPolicyFileV1{
		SchemaVersion: hostedMigrationSchemaVersionV1,
		Wallets: []hostedMigrationWalletInputV1{
			{
				WalletID:          "agent_primary",
				ExpectedPublicKey: "11111111111111111111111111111111",
				KeystorePath:      "/home/app/.fased/wallet/keystore-agent.v1.enc",
				PassphrasePath:    "/home/app/.fased/wallet/passphrase",
				Policy: &hostedMigrationPolicyInputV1{
					Role:       "agent",
					Operations: []string{"agentSendNativeSol"},
					Programs:   []string{"11111111111111111111111111111111"},
					Assets: []hostedMigrationPolicyAssetV1{
						{
							Asset:        "solana:native",
							Destinations: []string{"11111111111111111111111111111111"},
							MaxPerTx:     "1",
							MaxDaily:     "10",
						},
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal valid hosted migration policy: %v", err)
	}
	return encoded
}

func currentHostedMigrationOwnerV1(t *testing.T, path string) hostedMigrationOwnerV1 {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("inspect %s: %v", path, err)
	}
	owner, err := hostedMigrationFileOwnerV1(info)
	if err != nil {
		t.Fatalf("read owner for %s: %v", path, err)
	}
	return owner
}

func TestParseHostedMigrationPolicyV1RequiresExactExplicitPolicy(t *testing.T) {
	wallets, err := parseHostedMigrationPolicyV1(validHostedMigrationPolicyV1(t))
	if err != nil {
		t.Fatalf("parse valid hosted migration policy: %v", err)
	}
	if len(wallets) != 1 || wallets[0].WalletID != "agent_primary" {
		t.Fatalf("unexpected normalized migration wallets: %#v", wallets)
	}
	if wallets[0].Policy.Version != 1 || !strings.HasPrefix(wallets[0].Policy.Hash, "sha256:") {
		t.Fatalf("migration policy was not normalized and hashed: %#v", wallets[0].Policy)
	}

	var input hostedMigrationPolicyFileV1
	if err := json.Unmarshal(validHostedMigrationPolicyV1(t), &input); err != nil {
		t.Fatal(err)
	}
	input.Wallets[0].Policy.Assets = nil
	raw, _ := json.Marshal(input)
	if _, err := parseHostedMigrationPolicyV1(raw); err == nil || !strings.Contains(err.Error(), "assets and positive caps") {
		t.Fatalf("expected fail-closed empty asset rejection, got %v", err)
	}
	input.Wallets[0].Policy.Assets = []hostedMigrationPolicyAssetV1{
		{
			Asset:        "solana:native",
			Destinations: []string{"11111111111111111111111111111111", "11111111111111111111111111111111"},
			MaxPerTx:     "1",
			MaxDaily:     "10",
		},
	}
	raw, _ = json.Marshal(input)
	if _, err := parseHostedMigrationPolicyV1(raw); err == nil || !strings.Contains(err.Error(), "duplicates") {
		t.Fatalf("expected duplicate destination rejection, got %v", err)
	}
}

func TestParseHostedMigrationPolicyV1CompilesAutomaticRoleBaselines(t *testing.T) {
	input := hostedMigrationPolicyFileV1{
		SchemaVersion: hostedMigrationSchemaVersionV1,
		Wallets: []hostedMigrationWalletInputV1{
			{
				WalletID:          "agent_2",
				ExpectedPublicKey: "11111111111111111111111111111111",
				KeystorePath:      "/home/app/.fased/wallet/keystore-solana-agent-2.v1.enc",
				PassphrasePath:    "/home/app/.fased/wallet/.migration-passphrase-agent_2",
				BaselineRole:      "agent",
				PrimaryRPCURL:     "https://rpc.example.test",
			},
		},
	}
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	wallets, err := parseHostedMigrationPolicyV1(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(wallets) != 1 || wallets[0].Baseline == nil || wallets[0].Policy.BaselineVersion != 1 || wallets[0].Policy.Role != "agent" || wallets[0].PrimaryRPCURL != "https://rpc.example.test" {
		t.Fatalf("automatic role baseline was not compiled exactly: %#v", wallets)
	}

	input.Wallets[0].WalletID = "mining"
	input.Wallets[0].BaselineRole = "mining"
	raw, _ = json.Marshal(input)
	wallets, err = parseHostedMigrationPolicyV1(raw)
	if err != nil {
		t.Fatal(err)
	}
	if wallets[0].Baseline == nil || wallets[0].Policy.Role != "mining" || wallets[0].Policy.BaselineVersion != 1 ||
		wallets[0].Policy.TypedSATPrograms || len(wallets[0].Policy.Operations) == 0 {
		t.Fatalf("pre-launch Mining migration must receive its reviewed-use baseline: %#v", wallets[0])
	}
}

func TestParseHostedMigrationPolicyV1RejectsUnknownFieldsAndNonCanonicalWalletIDs(t *testing.T) {
	raw := strings.Replace(
		string(validHostedMigrationPolicyV1(t)),
		`"schemaVersion":1`,
		`"schemaVersion":1,"unexpected":true`,
		1,
	)
	if _, err := parseHostedMigrationPolicyV1([]byte(raw)); err == nil || !strings.Contains(err.Error(), "strict JSON") {
		t.Fatalf("expected unknown field rejection, got %v", err)
	}
	raw = strings.Replace(
		string(validHostedMigrationPolicyV1(t)),
		`"walletId":"agent_primary"`,
		`"walletId":"Agent-Primary"`,
		1,
	)
	if _, err := parseHostedMigrationPolicyV1([]byte(raw)); err == nil || !strings.Contains(err.Error(), "already be normalized") {
		t.Fatalf("expected canonical wallet ID rejection, got %v", err)
	}
}

func TestOpenHostedMigrationSourceV1RejectsLinksAndLoosePermissions(t *testing.T) {
	root := filepath.Join(hostedMigrationCanonicalTempDirV1(t), "home", "app", ".fased", "wallet")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "keystore-agent.v1.enc")
	if err := os.WriteFile(source, []byte("encrypted-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	owner := currentHostedMigrationOwnerV1(t, source)
	allowedUIDs := map[uint32]bool{owner.UID: true}
	alias := filepath.Join(root, "keystore-hardlink.v1.enc")
	if err := os.Link(source, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := openHostedMigrationSourceV1(source, []string{root}, allowedUIDs, "legacy material", 64<<10); err == nil || !strings.Contains(err.Error(), "exactly 1 link") {
		t.Fatalf("expected hard-link rejection, got %v", err)
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(root, "keystore-symlink.v1.enc")
	if err := os.Symlink(source, symlink); err != nil {
		t.Fatal(err)
	}
	if _, err := openHostedMigrationSourceV1(symlink, []string{root}, allowedUIDs, "legacy material", 64<<10); err == nil {
		t.Fatal("expected symlink rejection")
	}
	if err := os.Chmod(source, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := openHostedMigrationSourceV1(source, []string{root}, allowedUIDs, "legacy material", 64<<10); err == nil || !strings.Contains(err.Error(), "group or others") {
		t.Fatalf("expected loose permission rejection, got %v", err)
	}
	if err := os.Chmod(source, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("too-large"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := openHostedMigrationSourceV1(source, []string{root}, allowedUIDs, "legacy material", 4); err == nil || !strings.Contains(err.Error(), "invalid size") {
		t.Fatalf("expected oversized source rejection, got %v", err)
	}
}

func TestHostedMigrationRequiresEveryLegacyKeystoreInExplicitPolicy(t *testing.T) {
	root := filepath.Join(hostedMigrationCanonicalTempDirV1(t), "wallet")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	listed := filepath.Join(root, "keystore-agent.v1.enc")
	unlisted := filepath.Join(root, "keystore-vault.v1.enc")
	for _, path := range []string{listed, unlisted} {
		if err := os.WriteFile(path, []byte("encrypted"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	wallets := []hostedMigrationWalletV1{{KeystorePath: listed}}
	if err := requireHostedMigrationLegacyKeystoreCoverageV1([]string{root}, wallets); err == nil || !strings.Contains(err.Error(), "missing from the explicit migration policy") {
		t.Fatalf("expected unlisted legacy keystore rejection, got %v", err)
	}
	wallets = append(wallets, hostedMigrationWalletV1{KeystorePath: unlisted})
	if err := requireHostedMigrationLegacyKeystoreCoverageV1([]string{root}, wallets); err != nil {
		t.Fatalf("expected complete legacy keystore coverage, got %v", err)
	}
}

func TestStageHostedMigrationSourceV1CopiesVerifiedDescriptorIntoSignerOwnedFile(t *testing.T) {
	base := hostedMigrationCanonicalTempDirV1(t)
	root := filepath.Join(base, "home", "app", ".fased", "wallet")
	state := filepath.Join(base, "state")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(state, 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "passphrase")
	moved := filepath.Join(root, "passphrase-original")
	if err := os.WriteFile(source, []byte("verified-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	owner := currentHostedMigrationOwnerV1(t, source)
	handle, err := openHostedMigrationSourceV1(source, []string{root}, map[uint32]bool{owner.UID: true}, "legacy passphrase", 4096)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	if err := os.Rename(source, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	importDirectory, err := ensureHostedMigrationImportDirectoryV1(state, owner)
	if err != nil {
		t.Fatal(err)
	}
	staged, err := stageHostedMigrationSourceV1(importDirectory, "passphrase", "agent", handle, owner, 4096)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanupHostedMigrationStageV1(staged)
	contents, err := os.ReadFile(staged)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "verified-secret" {
		t.Fatalf("staged source changed across pathname replacement: %q", contents)
	}
	info, err := os.Lstat(staged)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 || currentHostedMigrationOwnerV1(t, staged) != owner {
		t.Fatalf("staged file is not signer-owned 0600: mode=%04o", info.Mode().Perm())
	}
}

func TestLinkHostedMigrationDescriptorV1IgnoresSourcePathReplacement(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("descriptor-based hosted migration linking is Linux-only")
	}
	root := hostedMigrationCanonicalTempDirV1(t)
	source := filepath.Join(root, "legacy")
	moved := filepath.Join(root, "legacy-original")
	destination := filepath.Join(root, "quarantine")
	if err := os.WriteFile(source, []byte("verified-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	handle, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	if err := os.Rename(source, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := linkHostedMigrationDescriptorV1(handle, destination); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "verified-secret" {
		t.Fatalf("descriptor link followed replaced pathname: %q", contents)
	}
}

func TestEnsureHostedMigrationImportDirectoryV1RejectsSymlinkBeforeMutation(t *testing.T) {
	state := hostedMigrationCanonicalTempDirV1(t)
	target := filepath.Join(hostedMigrationCanonicalTempDirV1(t), "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(state, "import")); err != nil {
		t.Fatal(err)
	}
	owner := currentHostedMigrationOwnerV1(t, state)
	if _, err := ensureHostedMigrationImportDirectoryV1(state, owner); err == nil || !strings.Contains(err.Error(), "unsafe") {
		t.Fatalf("expected import-directory symlink rejection, got %v", err)
	}
	info, err := os.Lstat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("symlink target was modified before rejection: mode=%04o", info.Mode().Perm())
	}
}

func TestQuarantineHostedMigrationFileV1ConsumesCommittedLegacyMaterialIdempotently(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("descriptor-based hosted migration quarantine is Linux-only")
	}
	root := filepath.Join(hostedMigrationCanonicalTempDirV1(t), "home", "app", ".fased", "wallet")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "keystore-agent.v1.enc")
	if err := os.WriteFile(source, []byte("encrypted-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	owner := currentHostedMigrationOwnerV1(t, source)
	destination, err := quarantineHostedMigrationFileV1(source, []string{root}, map[uint32]bool{owner.UID: true}, owner, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(source); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("legacy source still exists: %v", err)
	}
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("committed transaction copy still exists: %v", err)
	}
	if resumed, err := quarantineHostedMigrationFileV1(source, []string{root}, map[uint32]bool{owner.UID: true}, owner, 64<<10); err != nil || resumed != destination {
		t.Fatalf("resume completed quarantine: destination=%q err=%v", resumed, err)
	}
}

func TestQuarantineHostedMigrationFileV1CompletesInterruptedTwoLinkState(t *testing.T) {
	root := filepath.Join(hostedMigrationCanonicalTempDirV1(t), "wallet")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "passphrase")
	destination := source + ".migrated-v2"
	if err := os.WriteFile(source, []byte("legacy-passphrase"), 0o600); err != nil {
		t.Fatal(err)
	}
	owner := currentHostedMigrationOwnerV1(t, source)
	if err := os.Chmod(source, 0); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(source, destination); err != nil {
		t.Fatal(err)
	}
	if _, err := quarantineHostedMigrationFileV1(source, []string{root}, map[uint32]bool{owner.UID: true}, owner, 4096); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(source); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("source link was not removed: %v", err)
	}
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("interrupted transaction copy still exists after resume: %v", err)
	}
}

func TestHostedMigrationMarkerIsAtomicStrictAndOwnerChecked(t *testing.T) {
	parent := hostedMigrationCanonicalTempDirV1(t)
	path := filepath.Join(parent, "signer-v1-migration.pending")
	owner := currentHostedMigrationOwnerV1(t, parent)
	marker := hostedMigrationMarkerV1{
		SchemaVersion: hostedMigrationSchemaVersionV1,
		PolicySHA256:  "sha256:" + strings.Repeat("a", 64),
	}
	if err := writeHostedMigrationMarkerV1(path, marker); err != nil {
		t.Fatal(err)
	}
	stored, exists, err := readHostedMigrationMarkerV1(path, owner.UID)
	if err != nil || !exists || stored != marker {
		t.Fatalf("read durable marker: stored=%#v exists=%v err=%v", stored, exists, err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("marker mode=%04o, want 0600", info.Mode().Perm())
	}
	if _, _, err := readHostedMigrationMarkerV1(path, owner.UID+1); err == nil || !strings.Contains(err.Error(), "unexpected owner") {
		t.Fatalf("expected owner mismatch rejection, got %v", err)
	}
}
