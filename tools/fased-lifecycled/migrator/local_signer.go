package migrator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"fased-lifecycled/model"
	"fased-lifecycled/platform"
)

const maxLegacySignerFileBytes int64 = 4 << 30

type LocalSignerBridgeAdapter struct {
	Config     platform.Config
	rootPrefix string
	skipChown  bool
}

type localSignerBridgeRecord struct {
	SourceState string            `json:"sourceState"`
	SourceKey   string            `json:"sourceKey"`
	SourceAudit string            `json:"sourceAudit,omitempty"`
	Destination string            `json:"destination"`
	Staged      map[string]string `json:"staged"`
	Digests     map[string]string `json:"digests"`
	Migrated    bool              `json:"migrated"`
}

func (adapter LocalSignerBridgeAdapter) Prepare(_ context.Context, tx model.Transaction, migration model.Migration) error {
	if err := adapter.validate(tx, migration); err != nil {
		return err
	}
	statePath, keyPath, auditPath, err := adapter.sourcePaths()
	if err != nil {
		return err
	}
	stateExists, err := secureOptionalLegacyFile(statePath, adapter.Config.Operator.UID)
	if err != nil {
		return err
	}
	keyExists, err := secureOptionalLegacyFile(keyPath, adapter.Config.Operator.UID)
	if err != nil {
		return err
	}
	if stateExists != keyExists {
		return errors.New("legacy Local signer state is incomplete")
	}
	record := localSignerBridgeRecord{
		SourceState: statePath, SourceKey: keyPath, Destination: adapter.resolve(adapter.Config.SignerStateRoot()),
		Staged: map[string]string{}, Digests: map[string]string{}, Migrated: stateExists,
	}
	if auditExists, auditErr := secureOptionalLegacyFile(auditPath, adapter.Config.Operator.UID); auditErr != nil {
		return auditErr
	} else if auditExists {
		record.SourceAudit = auditPath
	}
	if !record.Migrated {
		data, _ := json.Marshal(record)
		return writeMigrationRecord(adapter.markerPath(tx), data)
	}
	for _, name := range []string{"state.db", "master.key", "audit.jsonl"} {
		if _, err := os.Lstat(filepath.Join(record.Destination, name)); err == nil {
			return errors.New("canonical signer state already exists during public-stable bridge")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	stageRoot := filepath.Join(adapter.resolve(adapter.Config.LifecycleRoot), "transactions", tx.ID, "migrations", "signer-bridge")
	if err := os.MkdirAll(stageRoot, 0o700); err != nil {
		return err
	}
	sources := map[string]string{"state.db": statePath, "master.key": keyPath}
	if record.SourceAudit != "" {
		sources["audit.jsonl"] = record.SourceAudit
	}
	for name, source := range sources {
		destination := filepath.Join(stageRoot, name)
		digest, err := copySecureFile(source, destination, -1, -1)
		if err != nil {
			return err
		}
		record.Staged[name] = destination
		record.Digests[name] = digest
	}
	data, _ := json.Marshal(record)
	return writeMigrationRecord(adapter.markerPath(tx), data)
}

func (adapter LocalSignerBridgeAdapter) Activate(_ context.Context, tx model.Transaction, migration model.Migration) error {
	record, err := adapter.readRecord(tx, migration)
	if err != nil || !record.Migrated {
		return err
	}
	if err := os.MkdirAll(record.Destination, 0o700); err != nil {
		return err
	}
	if !adapter.skipChown {
		if err := os.Chown(record.Destination, int(adapter.Config.Signer.UID), int(adapter.Config.Signer.GID)); err != nil {
			return err
		}
	}
	if err := os.Chmod(record.Destination, 0o700); err != nil {
		return err
	}
	for name, staged := range record.Staged {
		destination := filepath.Join(record.Destination, name)
		uid, gid := int(adapter.Config.Signer.UID), int(adapter.Config.Signer.GID)
		if adapter.skipChown {
			uid, gid = -1, -1
		}
		digest, err := copySecureFile(staged, destination, uid, gid)
		if err != nil {
			return err
		}
		if digest != record.Digests[name] {
			return errors.New("legacy Local signer state changed while activating")
		}
	}
	return nil
}

func (adapter LocalSignerBridgeAdapter) Verify(_ context.Context, tx model.Transaction, migration model.Migration) error {
	record, err := adapter.readRecord(tx, migration)
	if err != nil || !record.Migrated {
		return err
	}
	expectedUID := adapter.Config.Signer.UID
	if adapter.skipChown {
		expectedUID = uint32(os.Geteuid())
	}
	for name, want := range record.Digests {
		path := filepath.Join(record.Destination, name)
		if name == "master.key" {
			got, err := digestSecureFile(path, expectedUID)
			if err != nil || got != want {
				return errors.New("canonical signer master key does not match the prepared legacy key")
			}
			continue
		}
		// The attested signer opens and migrates its database and may append to
		// its audit log before lifecycle verification. Their byte digests are
		// therefore expected to change; custody, ownership, and nonempty state
		// remain mandatory, while signer/Gateway readiness proves semantics.
		info, err := os.Lstat(path)
		if err != nil || info.Size() == 0 {
			return errors.New("canonical signer migrated state is unavailable")
		}
		if exists, secureErr := secureOptionalLegacyFile(path, expectedUID); secureErr != nil || !exists {
			return errors.New("canonical signer migrated state is unsafe")
		}
	}
	return nil
}

func (adapter LocalSignerBridgeAdapter) Commit(_ context.Context, tx model.Transaction, migration model.Migration) error {
	record, err := adapter.readRecord(tx, migration)
	if err != nil {
		return err
	}
	if record.Migrated {
		for _, source := range []string{record.SourceState, record.SourceKey, record.SourceAudit} {
			if source == "" {
				continue
			}
			if err := os.Remove(source); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	if record.Migrated {
		stage := firstStaged(record.Staged)
		if stage == "" || !pathWithin(adapter.resolve(adapter.Config.LifecycleRoot), stage) {
			return errors.New("legacy Local signer staging identity is invalid")
		}
		if err := os.RemoveAll(filepath.Dir(stage)); err != nil {
			return err
		}
	}
	return removeMigrationRecord(adapter.markerPath(tx))
}

func (adapter LocalSignerBridgeAdapter) Abort(_ context.Context, tx model.Transaction, migration model.Migration) error {
	record, err := adapter.readRecord(tx, migration)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for name := range record.Staged {
		if err := os.Remove(filepath.Join(record.Destination, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if record.Migrated {
		_ = os.Remove(record.Destination)
		if stage := firstStaged(record.Staged); stage != "" && pathWithin(adapter.resolve(adapter.Config.LifecycleRoot), stage) {
			_ = os.RemoveAll(filepath.Dir(stage))
		}
	}
	return removeMigrationRecord(adapter.markerPath(tx))
}

func (adapter LocalSignerBridgeAdapter) validate(tx model.Transaction, migration model.Migration) error {
	if err := adapter.Config.Validate(); err != nil {
		return err
	}
	if adapter.Config.Profile != model.ProfileProtectedLocal || migration.State != "signer" || migration.From != 1 || migration.To != 2 {
		return errors.New("legacy Local signer adapter received an unsupported migration")
	}
	return tx.Validate()
}

func (adapter LocalSignerBridgeAdapter) sourcePaths() (string, string, string, error) {
	material := filepath.Join(adapter.Config.OwnerStateRoot, "wallet")
	statePath := filepath.Join(material, "signerd-v2.db")
	keyPath := filepath.Join(material, "signerd-v2.master.key")
	auditPath := filepath.Join(material, "local-signer.audit.jsonl")
	data, err := os.ReadFile(filepath.Join(adapter.Config.OwnerStateRoot, "fased.json"))
	if err == nil {
		var config struct {
			Env struct {
				Vars map[string]string `json:"vars"`
			} `json:"env"`
		}
		if len(data) > 1<<20 || json.Unmarshal(data, &config) != nil {
			return "", "", "", errors.New("legacy Local configuration is invalid")
		}
		if value := config.Env.Vars["FASED_WALLET_SIGNER_STATE_DIR"]; value != "" {
			material = value
		}
		if value := config.Env.Vars["FASED_WALLET_LOCAL_SIGNER_STATE_DB"]; value != "" {
			statePath = value
		} else {
			statePath = filepath.Join(material, "signerd-v2.db")
		}
		if value := config.Env.Vars["FASED_WALLET_LOCAL_SIGNER_MASTER_KEY"]; value != "" {
			keyPath = value
		} else {
			keyPath = filepath.Join(material, "signerd-v2.master.key")
		}
		if socket := config.Env.Vars["FASED_WALLET_LOCAL_SIGNER_SOCKET"]; socket != "" {
			auditPath = filepath.Join(filepath.Dir(socket), filepath.Base(socket[:len(socket)-len(filepath.Ext(socket))])+".audit.jsonl")
		} else {
			auditPath = filepath.Join(material, "local-signer.audit.jsonl")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", "", "", err
	}
	for _, candidate := range []string{material, statePath, keyPath, auditPath} {
		if !pathWithin(adapter.Config.OwnerStateRoot, candidate) {
			return "", "", "", errors.New("legacy Local signer path escapes owner state")
		}
	}
	if !pathWithin(material, statePath) || !pathWithin(material, keyPath) || !pathWithin(material, auditPath) {
		return "", "", "", errors.New("legacy Local signer material path escapes its directory")
	}
	return statePath, keyPath, auditPath, nil
}

func (adapter LocalSignerBridgeAdapter) markerPath(tx model.Transaction) string {
	return filepath.Join(adapter.resolve(adapter.Config.LifecycleRoot), "transactions", tx.ID, "migrations", "signer.json")
}

func (adapter LocalSignerBridgeAdapter) readRecord(tx model.Transaction, migration model.Migration) (localSignerBridgeRecord, error) {
	if err := adapter.validate(tx, migration); err != nil {
		return localSignerBridgeRecord{}, err
	}
	data, err := os.ReadFile(adapter.markerPath(tx))
	if err != nil {
		return localSignerBridgeRecord{}, err
	}
	var record localSignerBridgeRecord
	if err := json.Unmarshal(data, &record); err != nil || record.Destination != adapter.resolve(adapter.Config.SignerStateRoot()) {
		return localSignerBridgeRecord{}, errors.New("legacy Local signer migration marker is invalid")
	}
	wantState, wantKey, wantAudit, err := adapter.sourcePaths()
	if err != nil || record.SourceState != wantState || record.SourceKey != wantKey || (record.SourceAudit != "" && record.SourceAudit != wantAudit) {
		return localSignerBridgeRecord{}, errors.New("legacy Local signer migration marker source is rebound")
	}
	stageRoot := filepath.Join(adapter.resolve(adapter.Config.LifecycleRoot), "transactions", tx.ID, "migrations", "signer-bridge")
	allowed := map[string]bool{"state.db": true, "master.key": true, "audit.jsonl": true}
	if (!record.Migrated && (len(record.Staged) != 0 || len(record.Digests) != 0)) || len(record.Staged) != len(record.Digests) {
		return localSignerBridgeRecord{}, errors.New("legacy Local signer migration marker staging is invalid")
	}
	for name, staged := range record.Staged {
		if !allowed[name] || staged != filepath.Join(stageRoot, name) || record.Digests[name] == "" {
			return localSignerBridgeRecord{}, errors.New("legacy Local signer migration marker staging is rebound")
		}
	}
	if record.Migrated && (record.Staged["state.db"] == "" || record.Staged["master.key"] == "") {
		return localSignerBridgeRecord{}, errors.New("legacy Local signer migration marker custody is incomplete")
	}
	return record, nil
}

func secureOptionalLegacyFile(path string, uid uint32) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 || !ok || stat.Nlink != 1 || stat.Uid != uid || info.Size() > maxLegacySignerFileBytes {
		return false, fmt.Errorf("legacy Local signer material is unsafe: %s", path)
	}
	return true, nil
}

func copySecureFile(source, destination string, uid, gid int) (string, error) {
	input, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer input.Close()
	before, err := input.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Size() > maxLegacySignerFileBytes {
		return "", errors.New("legacy Local signer source is unsafe")
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".signer-copy-*")
	if err != nil {
		return "", err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return "", err
	}
	if uid >= 0 && gid >= 0 {
		if err := temporary.Chown(uid, gid); err != nil {
			temporary.Close()
			return "", err
		}
	}
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(temporary, hash), input); err != nil {
		temporary.Close()
		return "", err
	}
	after, err := input.Stat()
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || before.ModTime() != after.ModTime() {
		temporary.Close()
		return "", errors.New("legacy Local signer source changed while copying")
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return "", err
	}
	if err := temporary.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}

func digestSecureFile(path string, uid uint32) (string, error) {
	if exists, err := secureOptionalLegacyFile(path, uid); err != nil || !exists {
		if err == nil {
			err = os.ErrNotExist
		}
		return "", err
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}

func pathWithin(root, candidate string) bool {
	if !filepath.IsAbs(root) || !filepath.IsAbs(candidate) || filepath.Clean(root) != root || filepath.Clean(candidate) != candidate {
		return false
	}
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != "." && relative != ".." && relative != "" && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func firstStaged(staged map[string]string) string {
	for _, value := range staged {
		return value
	}
	return ""
}

func (adapter LocalSignerBridgeAdapter) resolve(path string) string {
	if adapter.rootPrefix == "" {
		return path
	}
	return filepath.Join(adapter.rootPrefix, filepath.Clean(path))
}
