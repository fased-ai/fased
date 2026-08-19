package participant

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestManagedPluginCatalogRejectsNonCanonicalAndBundledCollision(t *testing.T) {
	entry := ManagedPluginCatalogEntry{ID: "demo", Digest: "sha256:" + strings.Repeat("a", 64), ArchiveDigest: "sha256:" + strings.Repeat("b", 64), APICapability: "fased.plugin.v1", Required: true}
	catalog := ManagedPluginCatalog{SchemaVersion: ManagedPluginCatalogSchemaVersion, Type: "fased-managed-plugin-catalog", Entries: []ManagedPluginCatalogEntry{entry}}
	data, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeManagedPluginCatalog(append(data, '\n')); err == nil {
		t.Fatal("non-canonical catalog whitespace was accepted")
	}
	if _, err := MergeManagedPluginCatalog(PluginLock{SchemaVersion: PluginLockSchemaVersion, Type: "fased-plugin-lock", Entries: []PluginLockEntry{{ID: "demo", Origin: "bundled", Digest: "sha256:" + strings.Repeat("c", 64), APICapability: "fased.plugin.v1"}}}, catalog); err == nil {
		t.Fatal("catalog shadowed bundled plugin identity")
	}
}
