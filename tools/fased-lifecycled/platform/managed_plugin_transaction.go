package platform

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"

	stateparticipant "fased-lifecycled/participant"
)

const (
	managedPluginTransactionVersion = 1
	maxManagedPluginArchiveBytes    = 256 * 1024 * 1024
	maxManagedPluginExpandedBytes   = 512 * 1024 * 1024
	maxManagedPluginArchiveEntries  = 100_000
	maxManagedPluginRecordBytes     = 1 << 20
)

var managedPluginTransactionID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
var managedPluginObjectDigest = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Test seams model interruption immediately before a durable transaction
// record and failure to durably publish a newly-created root.  They are never
// set by production callers.
var managedPluginPreRecordInterruption func() error
var managedPluginCreatedRootSync = syncPluginDirectory

// managedPluginArchiveResourceLimits is fixed in production. Tests may lower
// it to prove that the transaction-wide counters are not reset per archive.
var managedPluginArchiveResourceLimits = managedPluginResourceLimits{
	archiveBytes:  maxManagedPluginArchiveBytes,
	expandedBytes: maxManagedPluginExpandedBytes,
	entries:       maxManagedPluginArchiveEntries,
}

// Test-only seam invoked after the first source read while staging an archive.
// It lets the regression mutate the source during an otherwise synchronous
// copy, proving the pinned identity and byte count are checked at completion.
var managedPluginArchiveCopyAfterFirstRead func()

type managedPluginResourceLimits struct {
	archiveBytes  int64
	expandedBytes int64
	entries       int
}

type managedPluginResourceBudget struct {
	limits        managedPluginResourceLimits
	archiveBytes  int64
	expandedBytes int64
	entries       int
}

func newManagedPluginResourceBudget() managedPluginResourceBudget {
	return managedPluginResourceBudget{limits: managedPluginArchiveResourceLimits}
}

func (budget *managedPluginResourceBudget) reserveArchiveBytes(size int64) error {
	if size <= 0 || size > budget.limits.archiveBytes-budget.archiveBytes {
		return errors.New("managed plugin archives exceed cumulative byte budget")
	}
	budget.archiveBytes += size
	return nil
}

func (budget *managedPluginResourceBudget) reserveExpandedBytes(size int64) error {
	if size < 0 || size > budget.limits.expandedBytes-budget.expandedBytes {
		return errors.New("managed plugin archives exceed cumulative expanded byte budget")
	}
	budget.expandedBytes += size
	return nil
}

func (budget *managedPluginResourceBudget) reserveEntry() error {
	if budget.entries >= budget.limits.entries {
		return errors.New("managed plugin archives exceed cumulative entry budget")
	}
	budget.entries++
	return nil
}

type managedPluginArchiveCopyReader struct {
	reader io.Reader
	fired  bool
}

func (reader *managedPluginArchiveCopyReader) Read(data []byte) (int, error) {
	read, err := reader.reader.Read(data)
	if read > 0 && !reader.fired {
		reader.fired = true
		if managedPluginArchiveCopyAfterFirstRead != nil {
			managedPluginArchiveCopyAfterFirstRead()
		}
	}
	return read, err
}

// ManagedPluginTransaction owns only the root-owned immutable code store and
// its durable transaction records. It deliberately has no owner-state or live
// lock path: a later readiness/activation package owns the live lock switch.
type ManagedPluginTransaction struct {
	CodeRoot        string
	TransactionRoot string
	CodeOwnerUID    uint32
	CodeOwnerGID    uint32
	ArchiveOwnerUID uint32
}

type ManagedPluginArchiveSource struct {
	ID     string
	Path   string
	SHA256 string
}

type ManagedPluginStageRequest struct {
	TransactionID         string
	CatalogData           []byte
	ExpectedCatalogDigest string
	BaseLock              stateparticipant.PluginLock
	Archives              []ManagedPluginArchiveSource
}

type ManagedPluginStageResult struct {
	CatalogDigest       string
	CandidateLock       stateparticipant.PluginLock
	CandidateLockData   []byte
	CandidateLockDigest string
}

type managedPluginTransactionRecord struct {
	Version             int                             `json:"version"`
	TransactionID       string                          `json:"transactionId"`
	CatalogDigest       string                          `json:"catalogDigest"`
	CatalogData         json.RawMessage                 `json:"catalog"`
	CandidateLock       stateparticipant.PluginLock     `json:"candidateLock"`
	CandidateLockDigest string                          `json:"candidateLockDigest"`
	Entries             []managedPluginTransactionEntry `json:"entries"`
}

type managedPluginTransactionEntry struct {
	ID      string `json:"id"`
	Digest  string `json:"digest"`
	Created bool   `json:"created"`
}

// RecordExists reports whether the exact transaction has a complete durable
// record. Unsafe, partial, or ambiguous residue remains an error so callers do
// not bypass recovery by treating it as a missing transaction.
func (transaction ManagedPluginTransaction) RecordExists(transactionID string) (bool, error) {
	if err := transaction.validate(); err != nil {
		return false, err
	}
	if !managedPluginTransactionID.MatchString(transactionID) {
		return false, errors.New("managed plugin transaction ID is invalid")
	}
	if _, err := transaction.readRecord(transactionID); errors.Is(err, os.ErrNotExist) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	return true, nil
}

func (transaction ManagedPluginTransaction) Stage(request ManagedPluginStageRequest) (ManagedPluginStageResult, error) {
	if err := transaction.validate(); err != nil {
		return ManagedPluginStageResult{}, err
	}
	record, err := transaction.preflightRecord(request)
	if err != nil {
		return ManagedPluginStageResult{}, err
	}
	if existing, err := transaction.readRecord(request.TransactionID); err == nil {
		if existing.CatalogDigest != record.CatalogDigest || existing.CandidateLockDigest != record.CandidateLockDigest {
			return ManagedPluginStageResult{}, errors.New("managed plugin transaction conflicts with durable record")
		}
		if err := transaction.verifyStaged(existing); err != nil {
			return ManagedPluginStageResult{}, err
		}
		return stageResult(existing)
	} else if !errors.Is(err, os.ErrNotExist) {
		return ManagedPluginStageResult{}, err
	}
	if _, err := transaction.recoverPreRecordResidue(request.TransactionID); err != nil {
		return ManagedPluginStageResult{}, err
	}
	catalog, _, _, _, err := transaction.validateRequest(request)
	if err != nil {
		return ManagedPluginStageResult{}, err
	}
	archives, err := bindManagedPluginArchives(catalog, request.Archives)
	if err != nil {
		return ManagedPluginStageResult{}, err
	}
	if err := transaction.createTransactionRoots(request.TransactionID); err != nil {
		return ManagedPluginStageResult{}, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = transaction.removeTransactionRoots(request.TransactionID)
		}
	}()
	budget := newManagedPluginResourceBudget()
	for _, entry := range catalog.Entries {
		archive, archiveErr := transaction.stageVerifiedArchive(request.TransactionID, archives[entry.ID], &budget)
		if archiveErr != nil {
			return ManagedPluginStageResult{}, fmt.Errorf("stage managed plugin %s archive: %w", entry.ID, archiveErr)
		}
		destination := transaction.stagingObjectPath(request.TransactionID, entry.Digest)
		if err := transaction.extractArchive(archive, destination, entry.Digest, &budget); err != nil {
			return ManagedPluginStageResult{}, fmt.Errorf("stage managed plugin %s: %w", entry.ID, err)
		}
	}
	if managedPluginPreRecordInterruption != nil {
		if err := managedPluginPreRecordInterruption(); err != nil {
			// This models process loss after staging and before record publication:
			// retain only the exact-owned residue for the next leased invocation.
			cleanup = false
			return ManagedPluginStageResult{}, err
		}
	}
	if err := transaction.writeRecord(record); err != nil {
		return ManagedPluginStageResult{}, err
	}
	cleanup = false
	return stageResult(record)
}

// Preflight validates the exact durable stage record without creating a root
// or copying an archive. Activation uses it to additionally bound its journal
// before any plugin mutation.
func (transaction ManagedPluginTransaction) Preflight(request ManagedPluginStageRequest) (ManagedPluginStageResult, error) {
	if err := transaction.validate(); err != nil {
		return ManagedPluginStageResult{}, err
	}
	record, err := transaction.preflightRecord(request)
	if err != nil {
		return ManagedPluginStageResult{}, err
	}
	return stageResult(record)
}

func (transaction ManagedPluginTransaction) preflightRecord(request ManagedPluginStageRequest) (managedPluginTransactionRecord, error) {
	catalog, catalogDigest, candidate, candidateDigest, err := transaction.validateRequest(request)
	if err != nil {
		return managedPluginTransactionRecord{}, err
	}
	record := managedPluginTransactionRecord{Version: managedPluginTransactionVersion, TransactionID: request.TransactionID, CatalogDigest: catalogDigest, CatalogData: append(json.RawMessage(nil), request.CatalogData...), CandidateLock: candidate, CandidateLockDigest: candidateDigest}
	for _, entry := range catalog.Entries {
		record.Entries = append(record.Entries, managedPluginTransactionEntry{ID: entry.ID, Digest: entry.Digest})
	}
	if _, err := marshalManagedPluginRecord(record); err != nil {
		return managedPluginTransactionRecord{}, err
	}
	return record, nil
}

// Activate copies already verified staging content into its one
// content-addressed destination. The staging copy remains so a failed
// activation can be rolled back and deterministically retried.
func (transaction ManagedPluginTransaction) Activate(transactionID string) (ManagedPluginStageResult, error) {
	if err := transaction.validate(); err != nil {
		return ManagedPluginStageResult{}, err
	}
	record, err := transaction.readRecord(transactionID)
	if err != nil {
		return ManagedPluginStageResult{}, err
	}
	if err := transaction.verifyStaged(record); err != nil {
		return ManagedPluginStageResult{}, err
	}
	for index := range record.Entries {
		entry := &record.Entries[index]
		destination := transaction.objectPath(entry.Digest)
		if info, err := os.Lstat(destination); err == nil {
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return ManagedPluginStageResult{}, fmt.Errorf("managed plugin destination %s is unsafe", entry.ID)
			}
			digest, verifyErr := stateparticipant.ImmutablePluginTreeDigest(destination, transaction.CodeOwnerUID)
			if verifyErr != nil || digest != entry.Digest {
				return ManagedPluginStageResult{}, fmt.Errorf("managed plugin destination for %s conflicts with immutable digest", entry.ID)
			}
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return ManagedPluginStageResult{}, err
		}
		entry.Created = true
		if err := transaction.writeRecord(record); err != nil {
			return ManagedPluginStageResult{}, err
		}
		if err := transaction.copyStagedObject(transactionID, entry.Digest, destination); err != nil {
			return ManagedPluginStageResult{}, err
		}
	}
	return stageResult(record)
}

// Rollback removes only destinations this exact transaction created, and only
// after their current immutable identity matches the recorded digest.
func (transaction ManagedPluginTransaction) Rollback(transactionID string) error {
	if err := transaction.validate(); err != nil {
		return err
	}
	record, err := transaction.readRecord(transactionID)
	if err != nil {
		return err
	}
	for index := range record.Entries {
		entry := &record.Entries[index]
		if !entry.Created {
			continue
		}
		destination := transaction.objectPath(entry.Digest)
		digest, verifyErr := stateparticipant.ImmutablePluginTreeDigest(destination, transaction.CodeOwnerUID)
		if errors.Is(verifyErr, os.ErrNotExist) {
			entry.Created = false
			if err := transaction.writeRecord(record); err != nil {
				return err
			}
			continue
		}
		if verifyErr != nil || digest != entry.Digest {
			return fmt.Errorf("refusing to remove changed managed plugin object for %s", entry.ID)
		}
		if err := makePluginTreeRemovable(destination); err != nil {
			return err
		}
		if err := os.RemoveAll(destination); err != nil {
			return err
		}
		if err := syncPluginDirectory(transaction.CodeRoot); err != nil {
			return err
		}
		entry.Created = false
		if err := transaction.writeRecord(record); err != nil {
			return err
		}
	}
	return nil
}

// Discard cleans a staged, non-activated candidate. It refuses to erase an
// activated transaction because that would abandon rollback provenance.
func (transaction ManagedPluginTransaction) Discard(transactionID string) error {
	if err := transaction.validate(); err != nil {
		return err
	}
	record, err := transaction.readRecord(transactionID)
	if err != nil {
		return err
	}
	for _, entry := range record.Entries {
		if entry.Created {
			return errors.New("cannot discard activated managed plugin transaction")
		}
	}
	return transaction.removeTransactionRoots(transactionID)
}

// Finalize removes only replay staging after a separately journaled live-lock
// activation has committed. The durable transaction record remains available
// as immutable provenance for the active candidate lock.
func (transaction ManagedPluginTransaction) Finalize(transactionID string) error {
	if err := transaction.validate(); err != nil {
		return err
	}
	if _, err := transaction.readRecord(transactionID); err != nil {
		return err
	}
	root := transaction.stagingRoot(transactionID)
	if _, err := os.Lstat(root); err == nil {
		if err := makePluginTreeRemovable(root); err != nil {
			return err
		}
		if err := os.RemoveAll(root); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncPluginDirectory(filepath.Dir(root))
}

func (transaction ManagedPluginTransaction) validate() error {
	for label, value := range map[string]string{"managed plugin code root": transaction.CodeRoot, "managed plugin transaction root": transaction.TransactionRoot} {
		if !filepath.IsAbs(value) || filepath.Clean(value) != value {
			return fmt.Errorf("%s path must be absolute and clean", label)
		}
	}
	if pathWithin(transaction.CodeRoot, transaction.TransactionRoot) || pathWithin(transaction.TransactionRoot, transaction.CodeRoot) {
		return errors.New("managed plugin code and transaction roots must be separate")
	}
	return validatePluginCodeRoot(transaction.CodeRoot, transaction.CodeOwnerUID)
}

func (transaction ManagedPluginTransaction) validateRequest(request ManagedPluginStageRequest) (stateparticipant.ManagedPluginCatalog, string, stateparticipant.PluginLock, string, error) {
	if !managedPluginTransactionID.MatchString(request.TransactionID) {
		return stateparticipant.ManagedPluginCatalog{}, "", stateparticipant.PluginLock{}, "", errors.New("managed plugin transaction ID is invalid")
	}
	catalog, err := stateparticipant.DecodeManagedPluginCatalog(request.CatalogData)
	if err != nil {
		return stateparticipant.ManagedPluginCatalog{}, "", stateparticipant.PluginLock{}, "", err
	}
	catalogDigest, err := stateparticipant.ManagedPluginCatalogDigest(catalog)
	if err != nil || catalogDigest != request.ExpectedCatalogDigest {
		return stateparticipant.ManagedPluginCatalog{}, "", stateparticipant.PluginLock{}, "", errors.New("managed plugin catalog does not match its declared digest")
	}
	candidate, err := stateparticipant.MergeManagedPluginCatalog(request.BaseLock, catalog)
	if err != nil {
		return stateparticipant.ManagedPluginCatalog{}, "", stateparticipant.PluginLock{}, "", err
	}
	candidateDigest, err := stateparticipant.PluginLockDigest(candidate)
	if err != nil {
		return stateparticipant.ManagedPluginCatalog{}, "", stateparticipant.PluginLock{}, "", err
	}
	return catalog, catalogDigest, candidate, candidateDigest, nil
}

func bindManagedPluginArchives(catalog stateparticipant.ManagedPluginCatalog, sources []ManagedPluginArchiveSource) (map[string]ManagedPluginArchiveSource, error) {
	bound := make(map[string]ManagedPluginArchiveSource, len(sources))
	for _, source := range sources {
		if _, exists := bound[source.ID]; exists || !managedPluginTransactionID.MatchString(source.ID) || !filepath.IsAbs(source.Path) || filepath.Clean(source.Path) != source.Path {
			return nil, errors.New("managed plugin archive source is invalid")
		}
		bound[source.ID] = source
	}
	if len(bound) != len(catalog.Entries) {
		return nil, errors.New("managed plugin archive sources do not exactly cover catalog")
	}
	for _, entry := range catalog.Entries {
		source, ok := bound[entry.ID]
		if !ok || source.SHA256 != entry.ArchiveDigest {
			return nil, fmt.Errorf("managed plugin archive source for %s does not match catalog", entry.ID)
		}
	}
	return bound, nil
}

func (transaction ManagedPluginTransaction) createTransactionRoots(transactionID string) error {
	if err := secureMkdir(transaction.TransactionRoot, transaction.CodeOwnerUID, transaction.CodeOwnerGID, 0o700); err != nil {
		return err
	}
	if err := secureMkdir(transaction.recordRoot(transactionID), transaction.CodeOwnerUID, transaction.CodeOwnerGID, 0o700); err != nil {
		return err
	}
	if err := secureMkdir(filepath.Join(transaction.CodeRoot, ".managed-plugin-transactions"), transaction.CodeOwnerUID, transaction.CodeOwnerGID, 0o700); err != nil {
		return err
	}
	if err := secureMkdir(transaction.stagingRoot(transactionID), transaction.CodeOwnerUID, transaction.CodeOwnerGID, 0o700); err != nil {
		return err
	}
	return secureMkdir(filepath.Join(transaction.stagingRoot(transactionID), "archives"), transaction.CodeOwnerUID, transaction.CodeOwnerGID, 0o700)
}

// RecoverPreRecordResidue removes only root-owned, non-activated staging for
// one transaction. Callers hold the shared lifecycle lease. A durable record
// is never removed by this method.
func (transaction ManagedPluginTransaction) RecoverPreRecordResidue(transactionID string) (bool, error) {
	if err := transaction.validate(); err != nil || !managedPluginTransactionID.MatchString(transactionID) {
		if err != nil {
			return false, err
		}
		return false, errors.New("managed plugin transaction ID is invalid")
	}
	if _, err := transaction.readRecord(transactionID); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	return transaction.recoverPreRecordResidue(transactionID)
}

// recoverPreRecordResidue removes only root-owned, non-activated staging for
// this transaction. Anything with a durable record/journal or unsafe shape is
// ambiguous and remains fail-closed.
func (transaction ManagedPluginTransaction) recoverPreRecordResidue(transactionID string) (bool, error) {
	recordRoot := transaction.recordRoot(transactionID)
	stagingRoot := transaction.stagingRoot(transactionID)
	recordExists, err := transaction.safePreRecordDirectory(recordRoot)
	if err != nil {
		return false, err
	}
	stagingExists, err := transaction.safePreRecordStaging(stagingRoot)
	if err != nil {
		return false, err
	}
	if !recordExists && !stagingExists {
		return false, nil
	}
	if recordExists {
		entries, err := os.ReadDir(recordRoot)
		if err != nil || len(entries) != 0 {
			return false, errors.New("managed plugin pre-record residue is ambiguous")
		}
	}
	if err := transaction.removeTransactionRoots(transactionID); err != nil {
		return false, err
	}
	return true, nil
}

func (transaction ManagedPluginTransaction) safePreRecordDirectory(root string) (bool, error) {
	info, err := os.Lstat(root)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil || !transaction.safeRecordDirectory(info) {
		return false, errors.New("managed plugin pre-record residue is unsafe")
	}
	return true, nil
}

func (transaction ManagedPluginTransaction) safePreRecordStaging(root string) (bool, error) {
	exists, err := transaction.safePreRecordDirectory(root)
	if err != nil || !exists {
		return exists, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if entry.Name() != "archives" && !managedPluginObjectDigest.MatchString(entry.Name()) {
			return false, errors.New("managed plugin pre-record residue is ambiguous")
		}
	}
	err = filepath.WalkDir(root, func(item string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(item)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || info.Mode()&os.ModeSymlink != 0 || stat.Uid != transaction.CodeOwnerUID || stat.Gid != transaction.CodeOwnerGID || (!info.IsDir() && !info.Mode().IsRegular()) || (info.Mode().IsRegular() && stat.Nlink != 1) {
			return errors.New("managed plugin pre-record residue is unsafe")
		}
		return nil
	})
	if err != nil {
		return false, err
	}
	return true, nil
}

func (transaction ManagedPluginTransaction) extractArchive(archivePath, destination, expectedDigest string, budget *managedPluginResourceBudget) error {
	archive, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer archive.Close()
	if err := os.Mkdir(destination, 0o755); err != nil {
		return err
	}
	if err := os.Chown(destination, int(transaction.CodeOwnerUID), int(transaction.CodeOwnerGID)); err != nil {
		return err
	}
	gzipReader, err := gzip.NewReader(archive)
	if err != nil {
		return err
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	seen := map[string]bool{}
	directories := []string{destination}
	for {
		header, nextErr := reader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return nextErr
		}
		if err := budget.reserveEntry(); err != nil {
			return err
		}
		if !safeArchivePath(header.Name) || seen[header.Name] {
			return errors.New("managed plugin archive contains an unsafe path or exceeds entry budget")
		}
		seen[header.Name] = true
		target := filepath.Join(destination, filepath.FromSlash(header.Name))
		switch header.Typeflag {
		case tar.TypeDir:
			if header.Size != 0 {
				return errors.New("managed plugin archive directory has content")
			}
			if err := os.Mkdir(target, 0o755); err != nil {
				return err
			}
			if err := os.Chown(target, int(transaction.CodeOwnerUID), int(transaction.CodeOwnerGID)); err != nil {
				return err
			}
			directories = append(directories, target)
		case tar.TypeReg, tar.TypeRegA:
			if header.Size < 0 {
				return errors.New("managed plugin archive file size is invalid")
			}
			if err := budget.reserveExpandedBytes(header.Size); err != nil {
				return err
			}
			mode := os.FileMode(0o444)
			if header.FileInfo().Mode()&0o111 != 0 {
				mode = 0o555
			}
			output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if err != nil {
				return err
			}
			copied, copyErr := io.Copy(output, io.LimitReader(reader, header.Size+1))
			chmodErr := output.Chmod(mode)
			syncErr := output.Sync()
			closeErr := output.Close()
			if copyErr != nil || copied != header.Size || chmodErr != nil || syncErr != nil || closeErr != nil {
				return errors.Join(copyErr, chmodErr, syncErr, closeErr, errors.New("managed plugin archive file length changed while extracting"))
			}
			if err := os.Chown(target, int(transaction.CodeOwnerUID), int(transaction.CodeOwnerGID)); err != nil {
				return err
			}
		default:
			return errors.New("managed plugin archive contains unsupported entry type")
		}
	}
	if len(seen) == 0 {
		return errors.New("managed plugin archive is empty")
	}
	for index := len(directories) - 1; index >= 0; index-- {
		if err := os.Chmod(directories[index], 0o555); err != nil {
			return err
		}
		if err := syncPluginDirectory(directories[index]); err != nil {
			return err
		}
	}
	digest, err := stateparticipant.ImmutablePluginTreeDigest(destination, transaction.CodeOwnerUID)
	if err != nil || digest != expectedDigest {
		return errors.New("managed plugin archive tree does not match catalog digest")
	}
	return nil
}

func (transaction ManagedPluginTransaction) stageVerifiedArchive(transactionID string, source ManagedPluginArchiveSource, budget *managedPluginResourceBudget) (string, error) {
	info, err := os.Lstat(source.Path)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || stat.Uid != transaction.ArchiveOwnerUID || info.Mode().Perm()&0o022 != 0 || info.Size() <= 0 || info.Size() > maxManagedPluginArchiveBytes {
		return "", errors.New("managed plugin archive identity or access is unsafe")
	}
	initialSize := info.Size()
	if err := budget.reserveArchiveBytes(initialSize); err != nil {
		return "", err
	}
	file, err := os.Open(source.Path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !sameManagedPluginArchiveIdentity(info, opened) {
		return "", errors.New("managed plugin archive changed while opening")
	}
	staged := filepath.Join(transaction.stagingRoot(transactionID), "archives", source.ID+".tar.gz")
	output, err := os.OpenFile(staged, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o400)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	pinned := io.LimitReader(file, initialSize+1)
	copyReader := &managedPluginArchiveCopyReader{reader: pinned}
	copied, copyErr := io.Copy(io.MultiWriter(output, hash), copyReader)
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil || copied != initialSize || syncErr != nil || closeErr != nil {
		return "", errors.Join(copyErr, syncErr, closeErr, errors.New("managed plugin archive size changed while staging"))
	}
	if fmt.Sprintf("sha256:%x", hash.Sum(nil)) != source.SHA256 {
		return "", errors.New("managed plugin archive does not match declared digest")
	}
	if err := os.Chown(staged, int(transaction.CodeOwnerUID), int(transaction.CodeOwnerGID)); err != nil {
		return "", err
	}
	if err := os.Chmod(staged, 0o400); err != nil {
		return "", err
	}
	after, afterErr := file.Stat()
	pathAfter, pathErr := os.Lstat(source.Path)
	if afterErr != nil || pathErr != nil || !sameManagedPluginArchiveIdentity(info, after) || !sameManagedPluginArchiveIdentity(info, pathAfter) {
		return "", errors.New("managed plugin archive changed while staging")
	}
	if err := syncPluginDirectory(filepath.Dir(staged)); err != nil {
		return "", err
	}
	return staged, nil
}

func sameManagedPluginArchiveIdentity(before, after os.FileInfo) bool {
	return os.SameFile(before, after) && before.Size() == after.Size() && before.ModTime() == after.ModTime()
}

func safeArchivePath(name string) bool {
	return name != "" && !strings.Contains(name, "\\") && !strings.HasPrefix(name, "/") && path.Clean(name) == name && name != "." && !strings.HasPrefix(name, "../")
}

func (transaction ManagedPluginTransaction) copyStagedObject(transactionID, digest, destination string) error {
	temporary := destination + ".staging-" + transactionID
	if err := transaction.removeCopyResidue(temporary); err != nil {
		return err
	}
	if err := copyImmutablePluginTree(transaction.stagingObjectPath(transactionID, digest), temporary, transaction.CodeOwnerUID, transaction.CodeOwnerGID); err != nil {
		return errors.Join(err, transaction.removeCopyResidue(temporary))
	}
	if err := os.Rename(temporary, destination); err != nil {
		_ = makePluginTreeRemovable(temporary)
		_ = os.RemoveAll(temporary)
		return err
	}
	return syncPluginDirectory(transaction.CodeRoot)
}

// removeCopyResidue recovers only the exact root-owned partial tree for this
// content-addressed transaction copy. Any symlink, hard link, ownership drift,
// unexpected mode, or special file remains a fail-closed collision.
func (transaction ManagedPluginTransaction) removeCopyResidue(temporary string) error {
	if _, err := os.Lstat(temporary); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	entries := 0
	err := filepath.WalkDir(temporary, func(item string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		entries++
		if entries > maxManagedPluginArchiveEntries {
			return errors.New("managed plugin destination staging residue exceeds entry budget")
		}
		info, err := os.Lstat(item)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || info.Mode()&os.ModeSymlink != 0 || stat.Uid != transaction.CodeOwnerUID || stat.Gid != transaction.CodeOwnerGID {
			return errors.New("managed plugin destination staging residue is unsafe")
		}
		if info.IsDir() {
			if mode := info.Mode().Perm(); mode != 0o755 && mode != 0o555 {
				return errors.New("managed plugin destination staging residue directory mode is unsafe")
			}
			return nil
		}
		if !info.Mode().IsRegular() || stat.Nlink != 1 {
			return errors.New("managed plugin destination staging residue entry is unsafe")
		}
		if mode := info.Mode().Perm(); mode != 0o444 && mode != 0o555 {
			return errors.New("managed plugin destination staging residue file mode is unsafe")
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := makePluginTreeRemovable(temporary); err != nil {
		return err
	}
	if err := os.RemoveAll(temporary); err != nil {
		return err
	}
	return syncPluginDirectory(transaction.CodeRoot)
}

func copyImmutablePluginTree(source, destination string, ownerUID, ownerGID uint32) error {
	directories := []string{}
	err := filepath.WalkDir(source, func(item string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, item)
		if err != nil {
			return err
		}
		target := destination
		if relative != "." {
			target = filepath.Join(destination, relative)
		}
		info, err := os.Lstat(item)
		if err != nil {
			return err
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
		if !info.Mode().IsRegular() {
			return errors.New("managed plugin staging contains unsupported entry")
		}
		mode := os.FileMode(0o444)
		if info.Mode().Perm()&0o111 != 0 {
			mode = 0o555
		}
		input, err := os.Open(item)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			_ = input.Close()
			return err
		}
		_, copyErr := io.Copy(output, input)
		syncErr := output.Sync()
		closeOutputErr := output.Close()
		closeInputErr := input.Close()
		chownErr := os.Chown(target, int(ownerUID), int(ownerGID))
		if copyErr != nil || syncErr != nil || closeOutputErr != nil || closeInputErr != nil || chownErr != nil {
			return errors.Join(copyErr, syncErr, closeOutputErr, closeInputErr, chownErr)
		}
		return os.Chmod(target, mode)
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

func (transaction ManagedPluginTransaction) readRecord(transactionID string) (managedPluginTransactionRecord, error) {
	if err := transaction.validateRecordRoots(transactionID); err != nil {
		return managedPluginTransactionRecord{}, err
	}
	data, err := transaction.readStableRecord(transaction.recordPath(transactionID))
	if err != nil {
		return managedPluginTransactionRecord{}, err
	}
	var record managedPluginTransactionRecord
	if err := strictManagedPluginJSON(data, &record); err != nil || record.Version != managedPluginTransactionVersion || record.TransactionID != transactionID || !managedPluginTransactionID.MatchString(transactionID) || len(record.Entries) == 0 || len(record.Entries) > 4096 {
		return managedPluginTransactionRecord{}, errors.New("managed plugin transaction record is invalid")
	}
	if _, err := stateparticipant.PluginLockDigest(record.CandidateLock); err != nil {
		return managedPluginTransactionRecord{}, errors.New("managed plugin transaction candidate lock is invalid")
	}
	catalog, catalogErr := stateparticipant.DecodeManagedPluginCatalog(record.CatalogData)
	if catalogErr != nil {
		return managedPluginTransactionRecord{}, errors.New("managed plugin transaction catalog is invalid")
	}
	if digest, digestErr := stateparticipant.ManagedPluginCatalogDigest(catalog); digestErr != nil || digest != record.CatalogDigest {
		return managedPluginTransactionRecord{}, errors.New("managed plugin transaction catalog digest conflicts")
	}
	if len(record.Entries) != len(catalog.Entries) {
		return managedPluginTransactionRecord{}, errors.New("managed plugin transaction catalog entries conflict")
	}
	if digest, _ := stateparticipant.PluginLockDigest(record.CandidateLock); digest != record.CandidateLockDigest {
		return managedPluginTransactionRecord{}, errors.New("managed plugin transaction candidate lock digest conflicts")
	}
	previous := ""
	for index, entry := range record.Entries {
		if !managedPluginTransactionID.MatchString(entry.ID) || entry.ID <= previous || !strings.HasPrefix(entry.Digest, "sha256:") || len(entry.Digest) != len("sha256:")+64 || entry.ID != catalog.Entries[index].ID || entry.Digest != catalog.Entries[index].Digest {
			return managedPluginTransactionRecord{}, errors.New("managed plugin transaction entries are invalid")
		}
		previous = entry.ID
	}
	return record, nil
}

func (transaction ManagedPluginTransaction) validateRecordRoots(transactionID string) error {
	for _, root := range []string{transaction.TransactionRoot, transaction.recordRoot(transactionID)} {
		info, err := os.Lstat(root)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != transaction.CodeOwnerUID || stat.Gid != transaction.CodeOwnerGID || info.Mode().Perm() != 0o700 {
			return errors.New("managed plugin transaction record directory identity or access is unsafe")
		}
	}
	return nil
}

// recordIDs enumerates only a safe, dedicated plugin transaction namespace.
// Any residue that cannot unambiguously be a root-owned transaction directory
// is an unsafe transaction boundary and therefore fails closed.
func (transaction ManagedPluginTransaction) recordIDs() ([]string, error) {
	if err := transaction.validate(); err != nil {
		return nil, err
	}
	info, err := os.Lstat(transaction.TransactionRoot)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil || !transaction.safeRecordDirectory(info) {
		return nil, errors.New("managed plugin transaction root identity or access is unsafe")
	}
	entries, err := os.ReadDir(transaction.TransactionRoot)
	if err != nil {
		return nil, err
	}
	if len(entries) > 4096 {
		return nil, errors.New("managed plugin transaction namespace exceeds entry budget")
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !managedPluginTransactionID.MatchString(entry.Name()) || entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
			return nil, errors.New("managed plugin transaction namespace entry is unsafe")
		}
		entryInfo, entryErr := os.Lstat(filepath.Join(transaction.TransactionRoot, entry.Name()))
		if entryErr != nil || !transaction.safeRecordDirectory(entryInfo) {
			return nil, errors.New("managed plugin transaction record directory identity or access is unsafe")
		}
		ids = append(ids, entry.Name())
	}
	sort.Strings(ids)
	return ids, nil
}

func (transaction ManagedPluginTransaction) safeRecordDirectory(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && info.IsDir() && info.Mode()&os.ModeSymlink == 0 && stat.Uid == transaction.CodeOwnerUID && stat.Gid == transaction.CodeOwnerGID && info.Mode().Perm() == 0o700
}

func (transaction ManagedPluginTransaction) readStableRecord(recordPath string) ([]byte, error) {
	before, err := os.Lstat(recordPath)
	if err != nil {
		return nil, err
	}
	if !transaction.safeRecordInfo(before) {
		return nil, errors.New("managed plugin transaction record identity or access is unsafe")
	}
	file, err := os.Open(recordPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !sameManagedPluginArchiveIdentity(before, opened) || !transaction.safeRecordInfo(opened) {
		return nil, errors.New("managed plugin transaction record changed while opening")
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maxManagedPluginRecordBytes+1))
	if readErr != nil || len(data) == 0 || len(data) > maxManagedPluginRecordBytes {
		return nil, errors.Join(readErr, errors.New("managed plugin transaction record exceeds byte budget"))
	}
	after, afterErr := file.Stat()
	pathAfter, pathErr := os.Lstat(recordPath)
	if afterErr != nil || pathErr != nil || !sameManagedPluginArchiveIdentity(before, after) || !sameManagedPluginArchiveIdentity(before, pathAfter) || !transaction.safeRecordInfo(after) || !transaction.safeRecordInfo(pathAfter) {
		return nil, errors.New("managed plugin transaction record changed while reading")
	}
	return data, nil
}

func (transaction ManagedPluginTransaction) safeRecordInfo(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && stat.Nlink == 1 && stat.Uid == transaction.CodeOwnerUID && stat.Gid == transaction.CodeOwnerGID && info.Mode().Perm() == 0o600 && info.Size() > 0 && info.Size() <= maxManagedPluginRecordBytes
}

func (transaction ManagedPluginTransaction) writeRecord(record managedPluginTransactionRecord) error {
	sort.Slice(record.Entries, func(left, right int) bool { return record.Entries[left].ID < record.Entries[right].ID })
	data, err := marshalManagedPluginRecord(record)
	if err != nil {
		return err
	}
	if err := writeAtomicFile(transaction.recordPath(record.TransactionID), data, 0o600); err != nil {
		return err
	}
	return syncPluginDirectory(transaction.recordRoot(record.TransactionID))
}

func marshalManagedPluginRecord(record managedPluginTransactionRecord) ([]byte, error) {
	data, err := json.Marshal(record)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || len(data) > maxManagedPluginRecordBytes {
		return nil, errors.New("managed plugin transaction record exceeds byte budget")
	}
	return data, nil
}

func (transaction ManagedPluginTransaction) verifyStaged(record managedPluginTransactionRecord) error {
	for _, entry := range record.Entries {
		digest, err := stateparticipant.ImmutablePluginTreeDigest(transaction.stagingObjectPath(record.TransactionID, entry.Digest), transaction.CodeOwnerUID)
		if err != nil || digest != entry.Digest {
			return fmt.Errorf("managed plugin transaction staging for %s is unavailable or changed", entry.ID)
		}
	}
	return nil
}

func stageResult(record managedPluginTransactionRecord) (ManagedPluginStageResult, error) {
	data, err := json.Marshal(record.CandidateLock)
	if err != nil {
		return ManagedPluginStageResult{}, err
	}
	return ManagedPluginStageResult{CatalogDigest: record.CatalogDigest, CandidateLock: record.CandidateLock, CandidateLockData: data, CandidateLockDigest: record.CandidateLockDigest}, nil
}

func (transaction ManagedPluginTransaction) removeTransactionRoots(transactionID string) error {
	for _, root := range []string{transaction.recordRoot(transactionID), transaction.stagingRoot(transactionID)} {
		if _, err := os.Lstat(root); err == nil {
			if err := makePluginTreeRemovable(root); err != nil {
				return err
			}
			if err := os.RemoveAll(root); err != nil {
				return err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	for _, parent := range []string{transaction.TransactionRoot, filepath.Join(transaction.CodeRoot, ".managed-plugin-transactions")} {
		if _, err := os.Lstat(parent); err == nil {
			if err := syncPluginDirectory(parent); err != nil {
				return err
			}
		}
	}
	return nil
}

func secureMkdir(directory string, uid, gid uint32, mode os.FileMode) error {
	if info, err := os.Lstat(directory); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uid || stat.Gid != gid || info.Mode().Perm() != mode {
			return errors.New("managed plugin transaction directory identity or access is unsafe")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Mkdir(directory, mode); err != nil {
		return err
	}
	if err := os.Chown(directory, int(uid), int(gid)); err != nil {
		return err
	}
	if err := os.Chmod(directory, mode); err != nil {
		return err
	}
	return managedPluginCreatedRootSync(filepath.Dir(directory))
}

func strictManagedPluginJSON(data []byte, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("unexpected trailing managed plugin JSON")
		}
		return err
	}
	return nil
}

func (transaction ManagedPluginTransaction) recordRoot(transactionID string) string {
	return filepath.Join(transaction.TransactionRoot, transactionID)
}

func (transaction ManagedPluginTransaction) recordPath(transactionID string) string {
	return filepath.Join(transaction.recordRoot(transactionID), "managed-plugin-transaction.json")
}

func (transaction ManagedPluginTransaction) stagingRoot(transactionID string) string {
	return filepath.Join(transaction.CodeRoot, ".managed-plugin-transactions", transactionID)
}

func (transaction ManagedPluginTransaction) stagingObjectPath(transactionID, digest string) string {
	return filepath.Join(transaction.stagingRoot(transactionID), strings.TrimPrefix(digest, "sha256:"))
}

func (transaction ManagedPluginTransaction) objectPath(digest string) string {
	return filepath.Join(transaction.CodeRoot, strings.TrimPrefix(digest, "sha256:"))
}
