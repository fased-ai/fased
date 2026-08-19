package platform

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"fased-lifecycled/model"
	stateparticipant "fased-lifecycled/participant"
)

type TypedStateStore interface {
	Prepare(string, []string) (StatePreparation, error)
	Activate(string) error
	VerifyAccess(context.Context, string) error
	Restore(string) error
	Discard(string) error
	Converge() error
}

type StatePreparation struct {
	Digest             string
	ParticipantDigests map[string]string
}

const maxTypedStateRecords = 100000

type typedStateRecord struct {
	Participant     string `json:"participant"`
	Path            string `json:"path"`
	Mode            uint32 `json:"mode"`
	UID             uint32 `json:"uid"`
	GID             uint32 `json:"gid"`
	Directory       bool   `json:"directory"`
	SignerOwned     bool   `json:"signerOwned"`
	ProjectionOwned bool   `json:"projectionOwned"`
	MutationOwner   string `json:"mutationOwner,omitempty"`
	SQLite          bool   `json:"sqlite"`
	SQLiteFamily    string `json:"sqliteFamily,omitempty"`
	Backup          string `json:"backup,omitempty"`
	Digest          string `json:"digest,omitempty"`
}

// DiskTypedStateStore is the only active product-state permission and SQLite
// rollback owner. Prepare must be called after Gateway and signer quiescence.
type DiskTypedStateStore struct {
	Config     Config
	Access     StateAccessVerifier
	rootPrefix string
}

func NewDiskTypedStateStore(config Config, access StateAccessVerifier) (*DiskTypedStateStore, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if access == nil {
		return nil, errors.New("typed state store requires an actual UID access verifier")
	}
	return &DiskTypedStateStore{Config: config, Access: access}, nil
}

func (store *DiskTypedStateStore) Prepare(transactionID string, mutationOwnedPaths []string) (StatePreparation, error) {
	mutationOwners, err := store.validateMutationOwners(mutationOwnedPaths)
	if err != nil {
		return StatePreparation{}, err
	}
	records, err := store.discover()
	if err != nil {
		return StatePreparation{}, err
	}
	families := make(map[string]bool)
	for _, record := range records {
		if record.SQLite {
			if _, ok := families[record.SQLiteFamily]; !ok {
				families[record.SQLiteFamily] = false
			}
			if record.Path == record.SQLiteFamily {
				families[record.SQLiteFamily] = true
			}
		}
	}
	for family, hasMain := range families {
		if !hasMain {
			return StatePreparation{}, fmt.Errorf("SQLite family %s has no main database", family)
		}
	}
	for index := range records {
		if mutationOwners[records[index].Path] {
			records[index].MutationOwner = "migrator"
		}
		if records[index].Directory || records[index].SignerOwned {
			continue
		}
		if records[index].ProjectionOwned || records[index].MutationOwner != "" {
			digest, err := stateparticipant.DigestRegularFile(store.resolve(records[index].Path))
			if err != nil {
				return StatePreparation{}, fmt.Errorf("bind %s externally owned state: %w", records[index].Participant, err)
			}
			records[index].Digest = digest
			continue
		}
		backup := filepath.Join(store.transactionRoot(transactionID), "sqlite", fmt.Sprintf("%04d.state", index))
		if !records[index].SQLite {
			backup = filepath.Join(store.transactionRoot(transactionID), "files", fmt.Sprintf("%04d.state", index))
		}
		digest, err := stateparticipant.SnapshotRegularFile(store.resolve(records[index].Path), backup)
		if err != nil {
			return StatePreparation{}, fmt.Errorf("snapshot %s state: %w", records[index].Participant, err)
		}
		records[index].Backup = store.unresolve(backup)
		records[index].Digest = digest
		if records[index].SQLite && records[index].Path == records[index].SQLiteFamily {
			if err := stateparticipant.ValidateSQLiteMain(backup); err != nil {
				return StatePreparation{}, fmt.Errorf("validate %s SQLite family snapshot: %w", records[index].Participant, err)
			}
		}
	}
	for _, record := range records {
		if !record.SQLite {
			continue
		}
		digest, err := stateparticipant.DigestRegularFile(store.resolve(record.Path))
		if err != nil || digest != record.Digest {
			return StatePreparation{}, fmt.Errorf("%s SQLite family changed during post-quiesce snapshot", record.Participant)
		}
	}
	data, err := json.Marshal(records)
	if err != nil {
		return StatePreparation{}, err
	}
	if err := writeAtomicFile(store.recordPath(transactionID), append(data, '\n'), 0o600); err != nil {
		return StatePreparation{}, err
	}
	if err := syncDirectoryChain(store.transactionRoot(transactionID), store.resolve(store.Config.LifecycleRoot)); err != nil {
		return StatePreparation{}, err
	}
	digest := sha256.Sum256(data)
	participants, err := store.participantDigests(records)
	if err != nil {
		return StatePreparation{}, err
	}
	return StatePreparation{Digest: fmt.Sprintf("sha256:%x", digest), ParticipantDigests: participants}, nil
}

func (store *DiskTypedStateStore) participantDigests(records []typedStateRecord) (map[string]string, error) {
	grouped := make(map[string][]typedStateRecord)
	for _, spec := range store.specs() {
		if _, ok := grouped[string(spec.Kind)]; !ok {
			grouped[string(spec.Kind)] = nil
		}
	}
	for _, record := range records {
		grouped[record.Participant] = append(grouped[record.Participant], record)
	}
	result := make(map[string]string, len(grouped))
	for participant, entries := range grouped {
		data, err := json.Marshal(entries)
		if err != nil {
			return nil, err
		}
		digest := sha256.Sum256(data)
		result[participant] = fmt.Sprintf("sha256:%x", digest)
	}
	return result, nil
}

func (store *DiskTypedStateStore) Activate(transactionID string) error {
	records, err := store.read(transactionID)
	if err != nil {
		return err
	}
	configGID, err := canonicalConfigGroupGID(store.resolve(store.Config.OwnerStateRoot), store.Config.Operator.UID)
	if err != nil {
		return err
	}
	migrationWalletDirectory := store.migrationOwnedWalletDirectory(records)
	for _, record := range records {
		path := store.resolve(record.Path)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if record.SignerOwned {
			// The signer participant owns signer database and key contents.
			// This state participant transfers no signer-owned bytes.
			continue
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != record.UID || stat.Gid != record.GID || durableStateMode(info.Mode()) != record.Mode || info.IsDir() != record.Directory {
			return errors.New("typed state changed after post-quiesce snapshot")
		}
		if !record.Directory && record.MutationOwner == "" {
			digest, err := stateparticipant.DigestRegularFile(path)
			if err != nil || digest != record.Digest {
				return errors.New("typed state content changed after post-quiesce snapshot")
			}
		}
		if record.ProjectionOwned {
			// The lifecycle-file transaction is the sole mutation and rollback
			// owner for managed projections. This participant only binds their
			// pre-activation identity and verifies the committed projection.
			continue
		}
		if err := os.Chown(path, int(record.UID), int(configGID)); err != nil {
			return err
		}
		mode := sharedStateMode(info.Mode())
		if record.Path == migrationWalletDirectory {
			// The target Gateway needs only traversal to the explicitly bound
			// registry before signer custody commits. Directory write access here
			// would let it replace still-live legacy keystores or passphrases.
			mode = os.ModeSetgid | 0o710
		}
		if err := os.Chmod(path, mode); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskTypedStateStore) VerifyAccess(ctx context.Context, transactionID string) error {
	records, err := store.read(transactionID)
	if err != nil {
		return err
	}
	current, err := store.discover()
	if err != nil {
		return err
	}
	seen := make(map[string]bool, len(records))
	for _, record := range records {
		seen[record.Path] = true
	}
	for _, record := range current {
		if !seen[record.Path] {
			records = append(records, record)
		}
	}
	configGID, err := canonicalConfigGroupGID(store.resolve(store.Config.OwnerStateRoot), store.Config.Operator.UID)
	if err != nil {
		return err
	}
	migrationWalletDirectory := store.migrationOwnedWalletDirectory(records)
	for _, record := range records {
		if record.ProjectionOwned && record.Path != store.unresolve(CanonicalGatewayConfigPath(store.Config)) {
			// install.json and lifecycle.json describe a committed lifecycle.
			// They remain at their predecessor identity until target health has
			// passed, so requiring the target Gateway to read them before start
			// would either expose an uncommitted transaction or make every
			// public-stable bridge fail. fased.json is the only projection the
			// target process requires during pre-start verification.
			continue
		}
		if record.Path == migrationWalletDirectory {
			// The exact registry-file probe below proves both ancestor traversal
			// and target read/write access without granting pre-commit directory
			// mutation over legacy custody material.
			continue
		}
		info, err := os.Lstat(store.resolve(record.Path))
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return errors.New("typed state identity is unavailable")
		}
		principal := store.Config.Gateway
		groups := []uint32{configGID}
		if record.SignerOwned {
			principal = store.Config.Signer
			groups = nil
		}
		if !principalCanAccess(info.Mode(), stat.Uid, stat.Gid, principal.UID, principal.GID) && (record.SignerOwned || stat.Gid != configGID) {
			return fmt.Errorf("%s state permissions deny target uid %d before kernel probe", record.Participant, principal.UID)
		}
		if err := store.Access.Verify(ctx, store.resolve(record.Path), record.Directory, principal, groups); err != nil {
			return fmt.Errorf("%s state target access: %w", record.Participant, err)
		}
	}
	return nil
}

func principalCanAccess(mode os.FileMode, ownerUID, ownerGID, uid, gid uint32) bool {
	bits := mode.Perm() & 0o007
	if uid == ownerUID {
		bits = (mode.Perm() >> 6) & 0o7
	} else if gid == ownerGID {
		bits = (mode.Perm() >> 3) & 0o7
	}
	want := os.FileMode(0o6)
	if mode.IsDir() {
		want = 0o7
	}
	return bits&want == want
}

func (store *DiskTypedStateStore) Restore(transactionID string) error {
	records, err := store.read(transactionID)
	if errors.Is(err, os.ErrNotExist) {
		// Quiescing may fail before a state snapshot is created. No typed
		// state mutation exists to undo in that case.
		return nil
	}
	if err != nil {
		return err
	}
	want := make(map[string]bool)
	for _, record := range records {
		want[record.Path] = true
	}
	current, err := store.discover()
	if err != nil {
		return err
	}
	for index := len(current) - 1; index >= 0; index-- {
		record := current[index]
		if want[record.Path] {
			continue
		}
		if err := store.removeUnexpected(record); err != nil {
			return err
		}
	}
	for _, record := range records {
		if record.SignerOwned || record.ProjectionOwned || record.MutationOwner != "" {
			continue
		}
		if !record.Directory {
			continue
		}
		path := store.resolve(record.Path)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			if err := os.Mkdir(path, os.FileMode(record.Mode)); err != nil {
				return err
			}
		} else if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("typed state directory cannot be safely restored")
		}
		if err := os.Chown(path, int(record.UID), int(record.GID)); err != nil {
			return err
		}
		if err := os.Chmod(path, os.FileMode(record.Mode)); err != nil {
			return err
		}
	}
	for _, record := range records {
		if record.SignerOwned || record.ProjectionOwned || record.MutationOwner != "" {
			continue
		}
		path := store.resolve(record.Path)
		if record.Directory {
			continue
		}
		if err := stateparticipant.RestoreRegularFile(store.resolve(record.Backup), path, record.Digest, os.FileMode(record.Mode)); err != nil {
			return err
		}
		if err := os.Chown(path, int(record.UID), int(record.GID)); err != nil {
			return err
		}
		if err := os.Chmod(path, os.FileMode(record.Mode)); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskTypedStateStore) removeUnexpected(record typedStateRecord) error {
	path := store.resolve(record.Path)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || info.IsDir() != record.Directory || (!record.Directory && !info.Mode().IsRegular()) {
		return errors.New("unexpected typed state cannot be safely removed")
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncDirectoryChain(filepath.Dir(path), filepath.Dir(path))
}

func (store *DiskTypedStateStore) Discard(transactionID string) error {
	root := store.transactionRoot(transactionID)
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	return syncDirectoryChain(filepath.Dir(root), filepath.Dir(root))
}

func (store *DiskTypedStateStore) Converge() error {
	records, err := store.discover()
	if err != nil {
		return err
	}
	configGID, err := canonicalConfigGroupGID(store.resolve(store.Config.OwnerStateRoot), store.Config.Operator.UID)
	if err != nil {
		return err
	}
	for _, record := range records {
		if record.SignerOwned {
			continue
		}
		path := store.resolve(record.Path)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if err := os.Chown(path, int(record.UID), int(configGID)); err != nil {
			return err
		}
		if err := os.Chmod(path, sharedStateMode(info.Mode())); err != nil {
			return err
		}
	}
	return nil
}

func (store *DiskTypedStateStore) discover() ([]typedStateRecord, error) {
	var records []typedStateRecord
	seen := make(map[string]bool)
	for _, spec := range store.specs() {
		path := store.resolve(spec.Path)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if spec.RootOnly || info.Mode().IsRegular() {
			record, err := store.inspect(spec, path, info)
			if err != nil {
				return nil, err
			}
			if !seen[record.Path] {
				records = append(records, record)
				seen[record.Path] = true
			}
			continue
		}
		err = filepath.WalkDir(path, func(current string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			info, err := os.Lstat(current)
			if err != nil {
				return err
			}
			record, err := store.inspect(spec, current, info)
			if err != nil {
				return err
			}
			if !seen[record.Path] {
				records = append(records, record)
				seen[record.Path] = true
			}
			if len(records) > maxTypedStateRecords {
				return errors.New("typed state inventory exceeds limit")
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Path < records[j].Path })
	return records, nil
}

func (store *DiskTypedStateStore) inspect(spec stateparticipant.StateSpec, path string, info os.FileInfo) (typedStateRecord, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && (!info.Mode().IsRegular() || stat.Nlink != 1)) {
		return typedStateRecord{}, fmt.Errorf("%s state contains an unsafe entry", spec.Kind)
	}
	if spec.SignerOwned {
		if stat.Uid != 0 && stat.Uid != store.Config.Signer.UID {
			return typedStateRecord{}, errors.New("signer state has an unexpected owner")
		}
	} else if stat.Uid != store.Config.Operator.UID && stat.Uid != store.Config.Gateway.UID {
		return typedStateRecord{}, fmt.Errorf("%s state has an unexpected owner", spec.Kind)
	}
	record := typedStateRecord{Participant: string(spec.Kind), Path: store.unresolve(path), Mode: durableStateMode(info.Mode()), UID: stat.Uid, GID: stat.Gid, Directory: info.IsDir(), SignerOwned: spec.SignerOwned, ProjectionOwned: spec.ProjectionOwned}
	if info.Mode().IsRegular() {
		if family, ok := stateparticipant.SQLiteFamilyMain(record.Path); ok {
			if spec.SQLite || containsSQLiteMain(spec.SQLiteMains, family) {
				record.SQLite = true
				record.SQLiteFamily = family
			}
		}
	}
	return record, nil
}

func containsSQLiteMain(mains []string, family string) bool {
	for _, main := range mains {
		if main == family {
			return true
		}
	}
	return false
}

func durableStateMode(mode os.FileMode) uint32 {
	return uint32(mode & (os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky))
}

func sharedStateMode(mode os.FileMode) os.FileMode {
	if mode.IsDir() {
		return os.ModeSetgid | 0o770
	}
	result := mode.Perm() | 0o660
	if mode.Perm()&0o111 != 0 {
		result |= 0o110
	}
	return result & 0o770
}

func (store *DiskTypedStateStore) specs() []stateparticipant.StateSpec {
	return stateparticipant.CanonicalStateSpecs(store.Config.OwnerStateRoot, store.Config.SignerStateRoot())
}

func (store *DiskTypedStateStore) validateMutationOwners(paths []string) (map[string]bool, error) {
	owners := make(map[string]bool, len(paths))
	allowed := filepath.Join(store.Config.OwnerStateRoot, "wallet", "provider-registry.v1.json")
	for _, path := range paths {
		if store.Config.Profile != model.ProfileHosting || path != allowed || owners[path] {
			return nil, errors.New("typed state mutation owner is not canonical")
		}
		owners[path] = true
	}
	return owners, nil
}

func (store *DiskTypedStateStore) migrationOwnedWalletDirectory(records []typedStateRecord) string {
	registry := filepath.Join(store.Config.OwnerStateRoot, "wallet", "provider-registry.v1.json")
	for _, record := range records {
		if record.Path == registry && record.MutationOwner == "migrator" {
			return filepath.Dir(registry)
		}
	}
	return ""
}

func (store *DiskTypedStateStore) read(transactionID string) ([]typedStateRecord, error) {
	data, err := readRegularFile(store.recordPath(transactionID))
	if err != nil {
		return nil, err
	}
	var records []typedStateRecord
	if err := json.Unmarshal(data, &records); err != nil || len(records) > maxTypedStateRecords {
		return nil, errors.New("typed state record is invalid")
	}
	previous := ""
	for _, record := range records {
		if record.Participant == "" || !filepath.IsAbs(record.Path) || filepath.Clean(record.Path) != record.Path || (!pathWithin(store.Config.OwnerStateRoot, record.Path) && !pathWithin(store.Config.SignerStateRoot(), record.Path) && record.Path != store.Config.SignerStateRoot()) {
			return nil, errors.New("typed state record escaped its declared roots")
		}
		if record.Path <= previous || !store.matchesSpec(record) {
			return nil, errors.New("typed state record is not canonical for its participant")
		}
		previous = record.Path
		if !record.Directory && !record.SignerOwned && !stateparticipant.ValidDigest(record.Digest) {
			return nil, errors.New("typed state record lacks a content binding")
		}
		if !record.Directory && !record.SignerOwned && !record.ProjectionOwned && record.MutationOwner == "" && (record.Backup == "" || !pathWithin(store.unresolve(store.transactionRoot(transactionID)), record.Backup)) {
			return nil, errors.New("typed state record lacks rollback evidence")
		}
		if (record.ProjectionOwned || record.MutationOwner != "") && record.Backup != "" {
			return nil, errors.New("externally owned state acquired competing rollback ownership")
		}
		if record.MutationOwner != "" && (record.MutationOwner != "migrator" || store.Config.Profile != model.ProfileHosting || record.Path != filepath.Join(store.Config.OwnerStateRoot, "wallet", "provider-registry.v1.json") || record.Participant != string(stateparticipant.Wallet) || record.Directory || record.SignerOwned || record.ProjectionOwned || record.SQLite) {
			return nil, errors.New("typed state mutation owner is invalid")
		}
		if record.SQLite && (record.SQLiteFamily == "" || !pathWithin(store.Config.OwnerStateRoot, record.SQLiteFamily)) {
			return nil, errors.New("SQLite family record is invalid")
		}
	}
	return records, nil
}

func (store *DiskTypedStateStore) matchesSpec(record typedStateRecord) bool {
	for _, spec := range store.specs() {
		if string(spec.Kind) != record.Participant || spec.SignerOwned != record.SignerOwned || spec.ProjectionOwned != record.ProjectionOwned {
			continue
		}
		if spec.RootOnly {
			if record.Path != spec.Path {
				continue
			}
		} else if record.Path != spec.Path && !pathWithin(spec.Path, record.Path) {
			continue
		}
		family, sqlite := stateparticipant.SQLiteFamilyMain(record.Path)
		if record.SQLite != (sqlite && (spec.SQLite || containsSQLiteMain(spec.SQLiteMains, family))) {
			return false
		}
		if record.SQLite && record.SQLiteFamily != family {
			return false
		}
		return true
	}
	return false
}

func (store *DiskTypedStateStore) transactionRoot(transactionID string) string {
	return store.resolve(filepath.Join(store.Config.LifecycleRoot, "transactions", transactionID, "target", "typed-state"))
}

func (store *DiskTypedStateStore) recordPath(transactionID string) string {
	return filepath.Join(store.transactionRoot(transactionID), "metadata.json")
}

func (store *DiskTypedStateStore) resolve(path string) string {
	if store.rootPrefix == "" {
		return path
	}
	return filepath.Join(store.rootPrefix, filepath.Clean(path))
}

func (store *DiskTypedStateStore) unresolve(path string) string {
	if store.rootPrefix == "" {
		return path
	}
	return string(filepath.Separator) + filepath.ToSlash(strings.TrimPrefix(path, store.rootPrefix+string(filepath.Separator)))
}

func syncDirectoryChain(start, stop string) error {
	current := filepath.Clean(start)
	stop = filepath.Clean(stop)
	for {
		directory, err := os.Open(current)
		if err != nil {
			return err
		}
		err = directory.Sync()
		directory.Close()
		if err != nil {
			return err
		}
		if current == stop {
			return nil
		}
		parent := filepath.Dir(current)
		if parent == current || !pathWithin(stop, current) {
			return errors.New("typed state durability path escaped lifecycle root")
		}
		current = parent
	}
}
