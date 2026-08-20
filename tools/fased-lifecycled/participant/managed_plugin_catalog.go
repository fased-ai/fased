package participant

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

const ManagedPluginCatalogSchemaVersion uint32 = 1

type ManagedPluginCatalog struct {
	SchemaVersion uint32                      `json:"schemaVersion"`
	Type          string                      `json:"type"`
	Entries       []ManagedPluginCatalogEntry `json:"entries"`
}

// ManagedPluginCatalogEntry binds a third-party plugin's immutable expanded
// tree to one exact locally acquired archive. ArchiveDigest is deliberately an
// input identity, not a URL or registry selector.
type ManagedPluginCatalogEntry struct {
	ID            string `json:"id"`
	Digest        string `json:"digest"`
	ArchiveDigest string `json:"archiveDigest"`
	APICapability string `json:"apiCapability"`
	Required      bool   `json:"required"`
}

func DecodeManagedPluginCatalog(data []byte) (ManagedPluginCatalog, error) {
	var catalog ManagedPluginCatalog
	if err := decodeStrict(data, &catalog); err != nil {
		return ManagedPluginCatalog{}, err
	}
	if catalog.SchemaVersion != ManagedPluginCatalogSchemaVersion || catalog.Type != "fased-managed-plugin-catalog" || len(catalog.Entries) == 0 || len(catalog.Entries) > 4096 {
		return ManagedPluginCatalog{}, errors.New("managed plugin catalog schema or type is unsupported")
	}
	previous := ""
	for _, entry := range catalog.Entries {
		if !pluginIDPattern.MatchString(entry.ID) || entry.ID <= previous || !pluginDigestPattern.MatchString(entry.Digest) || !pluginDigestPattern.MatchString(entry.ArchiveDigest) || !pluginCapabilityPattern.MatchString(entry.APICapability) {
			return ManagedPluginCatalog{}, errors.New("managed plugin catalog entries must be canonical, unique, and digest-bound")
		}
		previous = entry.ID
	}
	canonical, err := json.Marshal(catalog)
	if err != nil {
		return ManagedPluginCatalog{}, err
	}
	if !bytes.Equal(data, canonical) {
		return ManagedPluginCatalog{}, errors.New("managed plugin catalog must use exact canonical JSON")
	}
	return catalog, nil
}

func ManagedPluginCatalogDigest(catalog ManagedPluginCatalog) (string, error) {
	data, err := json.Marshal(catalog)
	if err != nil {
		return "", err
	}
	if _, err := DecodeManagedPluginCatalog(data); err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return fmt.Sprintf("sha256:%x", sum), nil
}

// MergeManagedPluginCatalog builds a candidate lock only. It never reads or
// mutates the installed operator lock. Catalog entries may replace a prior
// store selection with the same ID but can never shadow generation-owned code.
func MergeManagedPluginCatalog(base PluginLock, catalog ManagedPluginCatalog) (PluginLock, error) {
	if _, err := PluginLockDigest(base); err != nil {
		return PluginLock{}, fmt.Errorf("base plugin lock: %w", err)
	}
	if _, err := ManagedPluginCatalogDigest(catalog); err != nil {
		return PluginLock{}, fmt.Errorf("managed plugin catalog: %w", err)
	}
	entries := make(map[string]PluginLockEntry, len(base.Entries)+len(catalog.Entries))
	for _, entry := range base.Entries {
		entries[entry.ID] = entry
	}
	for _, entry := range catalog.Entries {
		if previous, ok := entries[entry.ID]; ok && previous.Origin == "bundled" {
			return PluginLock{}, fmt.Errorf("managed plugin %s conflicts with bundled plugin identity", entry.ID)
		}
		entries[entry.ID] = PluginLockEntry{ID: entry.ID, Origin: "store", Digest: entry.Digest, APICapability: entry.APICapability, Required: entry.Required}
	}
	merged := PluginLock{SchemaVersion: PluginLockSchemaVersion, Type: "fased-plugin-lock"}
	for _, entry := range entries {
		merged.Entries = append(merged.Entries, entry)
	}
	sort.Slice(merged.Entries, func(left, right int) bool { return merged.Entries[left].ID < merged.Entries[right].ID })
	if _, err := PluginLockDigest(merged); err != nil {
		return PluginLock{}, err
	}
	return merged, nil
}
