package platform

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"

	"fased-lifecycled/model"
	stateparticipant "fased-lifecycled/participant"
)

const (
	legacyPluginRecordVersion = 1
	maxLegacyPluginEntries    = 100_000
	maxLegacyPluginBytes      = 512 * 1024 * 1024
)

var legacyPluginID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
var legacyPluginDigest = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

type legacyPluginImportRecord struct {
	Version            int                       `json:"version"`
	TransactionID      string                    `json:"transactionId"`
	TargetGenerationID string                    `json:"targetGenerationId"`
	Entries            []legacyPluginImportEntry `json:"entries"`
}

type legacyPluginImportEntry struct {
	ID       string `json:"id"`
	Digest   string `json:"digest"`
	Required bool   `json:"required"`
	Created  bool   `json:"created"`
}

type legacyPluginManifest struct {
	ID string `json:"id"`
}

func (boundary DiskPluginBoundary) prepareLegacyPlugins(tx model.Transaction) (stateparticipant.PluginLock, error) {
	empty := stateparticipant.PluginLock{SchemaVersion: stateparticipant.PluginLockSchemaVersion, Type: "fased-plugin-lock"}
	if tx.PlanAction != "BRIDGE_PUBLIC_STABLE" {
		return empty, nil
	}
	if record, err := boundary.readLegacyPluginRecord(tx); err == nil {
		return record.pluginLock(), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return empty, err
	}
	legacyRoot := boundary.legacyRoot()
	info, err := os.Lstat(legacyRoot)
	if errors.Is(err, os.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return empty, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || (stat.Uid != boundary.Config.Operator.UID && stat.Uid != 0) || info.Mode().Perm()&0o002 != 0 {
		return empty, errors.New("legacy plugin root identity or access is unsafe")
	}
	entries, err := os.ReadDir(legacyRoot)
	if err != nil {
		return empty, err
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })
	if len(entries) == 0 {
		return empty, nil
	}
	transactionRoot := boundary.transactionRoot(tx)
	if err := os.RemoveAll(transactionRoot); err != nil {
		return empty, err
	}
	stagingRoot := filepath.Join(transactionRoot, "staging")
	if err := os.MkdirAll(stagingRoot, 0o700); err != nil {
		return empty, err
	}
	record := legacyPluginImportRecord{Version: legacyPluginRecordVersion, TransactionID: tx.ID, TargetGenerationID: tx.Target.ID}
	for _, entry := range entries {
		name := entry.Name()
		if ignoredLegacyPluginName(name) {
			continue
		}
		if !entry.IsDir() || !legacyPluginID.MatchString(name) {
			return empty, fmt.Errorf("legacy extensions entry %q is ambiguous; move writable data to plugin-data or repair the plugin explicitly", name)
		}
		source := filepath.Join(legacyRoot, name)
		manifestData, err := readStableLegacyPluginFile(filepath.Join(source, "fased.plugin.json"), boundary.Config.Operator.UID)
		if err != nil {
			return empty, fmt.Errorf("legacy plugin %s manifest: %w", name, err)
		}
		var manifest legacyPluginManifest
		if err := json.Unmarshal(manifestData, &manifest); err != nil || manifest.ID != name || !legacyPluginID.MatchString(manifest.ID) {
			return empty, fmt.Errorf("legacy plugin %s has an invalid manifest identity", name)
		}
		staging := filepath.Join(stagingRoot, name)
		if err := copyLegacyPluginTree(source, staging, boundary.Config.Operator.UID, boundary.codeOwnerUID(), boundary.codeOwnerGID()); err != nil {
			return empty, fmt.Errorf("legacy plugin %s import: %w", name, err)
		}
		digest, err := stateparticipant.ImmutablePluginTreeDigest(staging, boundary.codeOwnerUID())
		if err != nil {
			return empty, fmt.Errorf("legacy plugin %s imported identity: %w", name, err)
		}
		record.Entries = append(record.Entries, legacyPluginImportEntry{ID: name, Digest: digest, Required: true})
	}
	if len(record.Entries) == 0 {
		if err := os.RemoveAll(transactionRoot); err != nil {
			return empty, err
		}
		return empty, nil
	}
	if err := boundary.writeLegacyPluginRecord(tx, record); err != nil {
		return empty, err
	}
	return record.pluginLock(), nil
}

func ignoredLegacyPluginName(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	return lower == "" || strings.HasPrefix(lower, ".") || strings.HasSuffix(lower, ".bak") || strings.Contains(lower, ".backup-") || strings.Contains(lower, ".disabled")
}

func (record legacyPluginImportRecord) pluginLock() stateparticipant.PluginLock {
	lock := stateparticipant.PluginLock{SchemaVersion: stateparticipant.PluginLockSchemaVersion, Type: "fased-plugin-lock"}
	for _, entry := range record.Entries {
		lock.Entries = append(lock.Entries, stateparticipant.PluginLockEntry{ID: entry.ID, Origin: "store", Digest: entry.Digest, APICapability: "fased.plugin.v1", Required: entry.Required})
	}
	return lock
}

func (boundary DiskPluginBoundary) Activate(tx model.Transaction) error {
	record, err := boundary.readLegacyPluginRecord(tx)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	codeRoot := boundary.codeRoot()
	if err := validatePluginCodeRoot(codeRoot, boundary.codeOwnerUID()); err != nil {
		return err
	}
	for index := range record.Entries {
		entry := &record.Entries[index]
		destination := filepath.Join(codeRoot, strings.TrimPrefix(entry.Digest, "sha256:"))
		if _, err := os.Lstat(destination); err == nil {
			if entry.Created {
				if err := os.Chmod(destination, 0o555); err != nil {
					return err
				}
			}
			digest, verifyErr := stateparticipant.ImmutablePluginTreeDigest(destination, boundary.codeOwnerUID())
			if verifyErr != nil || digest != entry.Digest {
				return fmt.Errorf("plugin-code destination for %s conflicts with its immutable digest", entry.ID)
			}
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		entry.Created = true
		if err := boundary.writeLegacyPluginRecord(tx, record); err != nil {
			return err
		}
		staging := filepath.Join(boundary.transactionRoot(tx), "staging", entry.ID)
		// The root directory is excluded from the tree digest. Temporarily make
		// only that root owner-writable so rename works on restrictive filesystems;
		// every child remains immutable and the destination is root-owned.
		if err := os.Chmod(staging, 0o755); err != nil {
			return err
		}
		if err := os.Rename(staging, destination); err != nil {
			_ = os.Chmod(staging, 0o555)
			return err
		}
		if err := os.Chmod(destination, 0o555); err != nil {
			return err
		}
		if err := syncPluginDirectory(codeRoot); err != nil {
			return err
		}
	}
	return nil
}

func (boundary DiskPluginBoundary) Restore(tx model.Transaction) error {
	record, err := boundary.readLegacyPluginRecord(tx)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range record.Entries {
		if !entry.Created {
			continue
		}
		destination := filepath.Join(boundary.codeRoot(), strings.TrimPrefix(entry.Digest, "sha256:"))
		digest, err := stateparticipant.ImmutablePluginTreeDigest(destination, boundary.codeOwnerUID())
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil || digest != entry.Digest {
			return fmt.Errorf("refusing to remove changed plugin-code object for %s", entry.ID)
		}
		if err := makePluginTreeRemovable(destination); err != nil {
			return err
		}
		if err := os.RemoveAll(destination); err != nil {
			return err
		}
		if err := syncPluginDirectory(boundary.codeRoot()); err != nil {
			return err
		}
	}
	return nil
}

func (boundary DiskPluginBoundary) Discard(tx model.Transaction) error {
	root := boundary.transactionRoot(tx)
	if _, err := os.Lstat(root); err == nil {
		if err := makePluginTreeRemovable(root); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	parent := filepath.Dir(root)
	if _, err := os.Lstat(parent); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return syncPluginDirectory(parent)
}

func makePluginTreeRemovable(root string) error {
	var directories []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			directories = append(directories, path)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, directory := range directories {
		if err := os.Chmod(directory, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func (boundary DiskPluginBoundary) legacyPluginRecordPath(tx model.Transaction) string {
	return filepath.Join(boundary.transactionRoot(tx), "import.json")
}

func (boundary DiskPluginBoundary) readLegacyPluginRecord(tx model.Transaction) (legacyPluginImportRecord, error) {
	data, err := os.ReadFile(boundary.legacyPluginRecordPath(tx))
	if err != nil {
		return legacyPluginImportRecord{}, err
	}
	var record legacyPluginImportRecord
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil || record.Version != legacyPluginRecordVersion || record.TransactionID != tx.ID || record.TargetGenerationID != tx.Target.ID || len(record.Entries) > 4096 {
		return legacyPluginImportRecord{}, errors.New("legacy plugin import record is invalid")
	}
	previous := ""
	for _, entry := range record.Entries {
		if !legacyPluginID.MatchString(entry.ID) || entry.ID <= previous || !legacyPluginDigest.MatchString(entry.Digest) {
			return legacyPluginImportRecord{}, errors.New("legacy plugin import record entries are invalid")
		}
		previous = entry.ID
	}
	return record, nil
}

func (boundary DiskPluginBoundary) writeLegacyPluginRecord(tx model.Transaction, record legacyPluginImportRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	path := boundary.legacyPluginRecordPath(tx)
	if err := writeAtomicFile(path, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return syncPluginDirectory(filepath.Dir(path))
}

func (boundary DiskPluginBoundary) codeOwnerUID() uint32 {
	if boundary.SourceOwnerUID != 0 {
		return boundary.SourceOwnerUID
	}
	return 0
}

func (boundary DiskPluginBoundary) codeOwnerGID() uint32 {
	if boundary.SourceOwnerUID != 0 {
		return uint32(os.Getgid())
	}
	return 0
}

func validatePluginCodeRoot(path string, ownerUID uint32) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != ownerUID || info.Mode().Perm()&0o022 != 0 {
		return errors.New("plugin-code root identity or access is unsafe")
	}
	return nil
}

func readStableLegacyPluginFile(path string, operatorUID uint32) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := before.Sys().(*syscall.Stat_t)
	if !ok || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || (stat.Uid != operatorUID && stat.Uid != 0) || before.Size() <= 0 || before.Size() > 1<<20 {
		return nil, errors.New("legacy plugin file identity is unsafe")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || before.ModTime() != after.ModTime() {
		return nil, errors.New("legacy plugin file changed while reading")
	}
	return data, nil
}

func copyLegacyPluginTree(source, destination string, operatorUID, ownerUID, ownerGID uint32) error {
	entries := 0
	var bytes int64
	var directories []string
	err := filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		entries++
		if entries > maxLegacyPluginEntries {
			return errors.New("legacy plugin exceeds its entry budget")
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || info.Mode()&os.ModeSymlink != 0 || (stat.Uid != operatorUID && stat.Uid != 0) || info.Mode().Perm()&0o002 != 0 {
			return errors.New("legacy plugin contains an unsafe entry")
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := destination
		if relative != "." {
			target = filepath.Join(destination, relative)
		}
		if info.IsDir() {
			if err := os.Mkdir(target, 0o755); err != nil {
				return err
			}
			if err := os.Chown(target, int(ownerUID), int(ownerGID)); err != nil {
				return err
			}
			directories = append(directories, target)
			return nil
		}
		if !info.Mode().IsRegular() || stat.Nlink != 1 {
			return errors.New("legacy plugin contains an unsupported entry")
		}
		bytes += info.Size()
		if bytes > maxLegacyPluginBytes {
			return errors.New("legacy plugin exceeds its byte budget")
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		before, err := input.Stat()
		if err != nil {
			input.Close()
			return err
		}
		mode := os.FileMode(0o444)
		if info.Mode().Perm()&0o111 != 0 {
			mode = 0o555
		}
		output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			input.Close()
			return err
		}
		_, copyErr := io.Copy(output, input)
		after, statErr := input.Stat()
		closeInputErr := input.Close()
		chownErr := os.Chown(target, int(ownerUID), int(ownerGID))
		chmodErr := output.Chmod(mode)
		syncErr := output.Sync()
		closeOutputErr := output.Close()
		if copyErr != nil || statErr != nil || closeInputErr != nil || chownErr != nil || chmodErr != nil || syncErr != nil || closeOutputErr != nil {
			return errors.Join(copyErr, statErr, closeInputErr, chownErr, chmodErr, syncErr, closeOutputErr)
		}
		if !os.SameFile(before, after) || before.Size() != after.Size() || before.ModTime() != after.ModTime() {
			return errors.New("legacy plugin changed while being imported")
		}
		return nil
	})
	if err != nil {
		return err
	}
	for index := len(directories) - 1; index >= 0; index-- {
		if err := os.Chmod(directories[index], 0o555); err != nil {
			return err
		}
		if err := syncPluginDirectory(directories[index]); err != nil {
			return err
		}
	}
	return nil
}

func syncPluginDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	err = directory.Sync()
	return errors.Join(err, directory.Close())
}
