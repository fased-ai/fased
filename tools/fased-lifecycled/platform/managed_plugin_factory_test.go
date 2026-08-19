package platform

import (
	"os"
	"path/filepath"
	"testing"
)

func TestManagedPluginProductionBoundaryUsesCanonicalConfigGroup(t *testing.T) {
	uid, canonicalGID := uint32(os.Getuid()), uint32(os.Getgid())
	if uid == 0 || canonicalGID == 0 {
		t.Skip("canonical config group proof requires an unprivileged filesystem owner")
	}
	ownerRoot := filepath.Join(t.TempDir(), "owner")
	if err := os.Mkdir(ownerRoot, 0o770); err != nil {
		t.Fatal(err)
	}
	operatorGID := canonicalGID + 1
	config := Config{OwnerStateRoot: ownerRoot, Operator: Principal{UID: uid, GID: operatorGID}, Gateway: Principal{UID: uid + 1, GID: canonicalGID + 2}}
	derivedGID, err := canonicalConfigGroupGID(ownerRoot, uid)
	if err != nil {
		t.Fatal(err)
	}
	tx := ManagedPluginTransaction{CodeRoot: filepath.Join(t.TempDir(), "code"), CodeOwnerUID: uid}
	boundary := managedPluginProductionBoundary(config, tx, derivedGID)
	if boundary.ConfigGID != canonicalGID || boundary.ConfigGID == config.Operator.GID {
		t.Fatalf("plugin boundary config GID = %d, want canonical %d and not operator primary %d", boundary.ConfigGID, canonicalGID, config.Operator.GID)
	}
}
