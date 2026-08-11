// Package participant defines version-neutral lifecycle participants.
package participant

import (
	"bytes"
	"crypto/sha256"
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
)

const (
	PluginLockSchemaVersion      uint32 = 1
	PluginReadinessSchemaVersion uint32 = 1
	maxPluginRecordBytes                = 1 << 20
)

var (
	pluginIDPattern         = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	pluginDigestPattern     = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	pluginCapabilityPattern = regexp.MustCompile(`^[a-z][a-z0-9.-]{0,63}$`)
)

type PluginLock struct {
	SchemaVersion uint32            `json:"schemaVersion"`
	Type          string            `json:"type"`
	Entries       []PluginLockEntry `json:"entries"`
}

type PluginLockEntry struct {
	ID            string `json:"id"`
	Origin        string `json:"origin"`
	Digest        string `json:"digest"`
	APICapability string `json:"apiCapability"`
	Required      bool   `json:"required"`
}

type PluginReadiness struct {
	SchemaVersion uint32                 `json:"schemaVersion"`
	Type          string                 `json:"type"`
	GenerationID  string                 `json:"generationId"`
	LockDigest    string                 `json:"lockDigest"`
	Entries       []PluginReadinessEntry `json:"entries"`
}

type PluginReadinessEntry struct {
	ID            string `json:"id"`
	Origin        string `json:"origin"`
	Digest        string `json:"digest"`
	APICapability string `json:"apiCapability"`
	Required      bool   `json:"required"`
	Status        string `json:"status"`
}

type PluginBoundary struct {
	CodeRoot      string
	DataRoot      string
	LockPath      string
	ReadinessPath string
	CodeOwnerUID  uint32
	OperatorUID   uint32
	GatewayUID    uint32
	ConfigGID     uint32
}

func (boundary PluginBoundary) VerifyLock(expectedDigest string) (PluginLock, error) {
	if !pluginDigestPattern.MatchString(expectedDigest) {
		return PluginLock{}, errors.New("expected plugin lock digest is invalid")
	}
	if err := boundary.validatePaths(); err != nil {
		return PluginLock{}, err
	}
	data, err := readBoundedRegular(boundary.LockPath, boundary.OperatorUID, 0o022)
	if err != nil {
		return PluginLock{}, fmt.Errorf("read plugin lock: %w", err)
	}
	lock, err := DecodePluginLock(data)
	if err != nil {
		return PluginLock{}, err
	}
	digest, err := PluginLockDigest(lock)
	if err != nil || digest != expectedDigest {
		return PluginLock{}, errors.New("plugin lock does not match signed release evidence")
	}
	if err := boundary.verifyDataRoot(); err != nil {
		return PluginLock{}, err
	}
	for _, entry := range lock.Entries {
		if entry.Origin != "store" {
			continue
		}
		path := filepath.Join(boundary.CodeRoot, strings.TrimPrefix(entry.Digest, "sha256:"))
		digest, err := immutablePluginTreeDigest(path, boundary.CodeOwnerUID)
		if err != nil {
			return PluginLock{}, fmt.Errorf("plugin %s code store: %w", entry.ID, err)
		}
		if digest != entry.Digest {
			return PluginLock{}, fmt.Errorf("plugin %s code integrity drift", entry.ID)
		}
	}
	return lock, nil
}

func (boundary PluginBoundary) VerifyReadiness(expectedDigest, generationID string) error {
	lock, err := boundary.VerifyLock(expectedDigest)
	if err != nil {
		return err
	}
	data, err := readBoundedRegular(boundary.ReadinessPath, boundary.GatewayUID, 0o077)
	if err != nil {
		return fmt.Errorf("read plugin readiness receipt: %w", err)
	}
	receipt, err := DecodePluginReadiness(data)
	if err != nil {
		return err
	}
	if receipt.GenerationID != generationID || receipt.LockDigest != expectedDigest {
		return errors.New("plugin readiness receipt identity mismatch")
	}
	if len(receipt.Entries) != len(lock.Entries) {
		return errors.New("plugin readiness receipt does not cover the exact lock")
	}
	for index, locked := range lock.Entries {
		ready := receipt.Entries[index]
		if ready.ID != locked.ID || ready.Origin != locked.Origin || ready.Digest != locked.Digest || ready.APICapability != locked.APICapability || ready.Required != locked.Required {
			return errors.New("plugin readiness entry does not match the lock")
		}
		if ready.Required && ready.Status != "loaded" {
			return fmt.Errorf("mandatory plugin %s is not loaded", ready.ID)
		}
		if ready.Status != "loaded" && ready.Status != "disabled" && ready.Status != "error" {
			return fmt.Errorf("plugin %s readiness status is invalid", ready.ID)
		}
	}
	return nil
}

func DecodePluginLock(data []byte) (PluginLock, error) {
	var lock PluginLock
	if err := decodeStrict(data, &lock); err != nil {
		return PluginLock{}, err
	}
	if lock.SchemaVersion != PluginLockSchemaVersion || lock.Type != "fased-plugin-lock" {
		return PluginLock{}, errors.New("plugin lock schema or type is unsupported")
	}
	previous := ""
	for _, entry := range lock.Entries {
		if !pluginIDPattern.MatchString(entry.ID) || entry.ID <= previous || (entry.Origin != "bundled" && entry.Origin != "store") || !pluginDigestPattern.MatchString(entry.Digest) || !pluginCapabilityPattern.MatchString(entry.APICapability) {
			return PluginLock{}, errors.New("plugin lock entries must be canonical, unique, and digest-bound")
		}
		previous = entry.ID
	}
	return lock, nil
}

func DecodePluginReadiness(data []byte) (PluginReadiness, error) {
	var receipt PluginReadiness
	if err := decodeStrict(data, &receipt); err != nil {
		return PluginReadiness{}, err
	}
	if receipt.SchemaVersion != PluginReadinessSchemaVersion || receipt.Type != "fased-plugin-readiness" || !pluginDigestPattern.MatchString(receipt.GenerationID) || !pluginDigestPattern.MatchString(receipt.LockDigest) {
		return PluginReadiness{}, errors.New("plugin readiness schema or identity is invalid")
	}
	previous := ""
	for _, entry := range receipt.Entries {
		if !pluginIDPattern.MatchString(entry.ID) || entry.ID <= previous || !pluginDigestPattern.MatchString(entry.Digest) || !pluginCapabilityPattern.MatchString(entry.APICapability) {
			return PluginReadiness{}, errors.New("plugin readiness entries must be canonical and unique")
		}
		previous = entry.ID
	}
	return receipt, nil
}

func PluginLockDigest(lock PluginLock) (string, error) {
	data, err := json.Marshal(lock)
	if err != nil {
		return "", err
	}
	canonical, err := DecodePluginLock(data)
	if err != nil {
		return "", err
	}
	data, _ = json.Marshal(canonical)
	sum := sha256.Sum256(data)
	return fmt.Sprintf("sha256:%x", sum), nil
}

func (boundary PluginBoundary) validatePaths() error {
	for label, path := range map[string]string{"plugin code root": boundary.CodeRoot, "plugin data root": boundary.DataRoot, "plugin lock": boundary.LockPath, "plugin readiness": boundary.ReadinessPath} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return fmt.Errorf("%s path must be absolute and clean", label)
		}
	}
	if pathWithin(boundary.CodeRoot, boundary.DataRoot) || pathWithin(boundary.DataRoot, boundary.CodeRoot) {
		return errors.New("plugin code and data roots must be separate")
	}
	return nil
}

func (boundary PluginBoundary) verifyDataRoot() error {
	info, err := os.Lstat(boundary.DataRoot)
	if err != nil {
		return fmt.Errorf("plugin data root: %w", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != boundary.GatewayUID || stat.Gid != boundary.ConfigGID || info.Mode().Perm() != 0o770 || info.Mode()&os.ModeSetgid == 0 {
		return errors.New("plugin data root identity or access is unsafe")
	}
	return nil
}

type pluginTreeEntry struct {
	Path   string `json:"path"`
	Mode   uint32 `json:"mode"`
	Digest string `json:"digest,omitempty"`
}

func immutablePluginTreeDigest(root string, ownerUID uint32) (string, error) {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return "", err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("plugin code digest root is not a directory")
	}
	var entries []pluginTreeEntry
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != ownerUID || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o222 != 0 {
			return errors.New("plugin code contains mutable or untrusted content")
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		record := pluginTreeEntry{Path: filepath.ToSlash(relative), Mode: uint32(info.Mode().Perm())}
		if info.Mode().IsRegular() {
			if stat.Nlink != 1 {
				return errors.New("plugin code file must have one link")
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			sum := sha256.Sum256(data)
			record.Digest = fmt.Sprintf("sha256:%x", sum)
		} else if !info.IsDir() {
			return errors.New("plugin code contains unsupported file type")
		}
		entries = append(entries, record)
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Path < entries[right].Path })
	data, _ := json.Marshal(entries)
	sum := sha256.Sum256(data)
	return fmt.Sprintf("sha256:%x", sum), nil
}

func readBoundedRegular(path string, ownerUID uint32, deniedMode os.FileMode) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || stat.Uid != ownerUID || info.Mode().Perm()&deniedMode != 0 || info.Size() <= 0 || info.Size() > maxPluginRecordBytes {
		return nil, errors.New("plugin record identity or access is unsafe")
	}
	return os.ReadFile(path)
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("unexpected trailing plugin JSON")
		}
		return err
	}
	return nil
}

func pathWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
