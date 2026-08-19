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

func (transaction ManagedPluginTransaction) Stage(request ManagedPluginStageRequest) (ManagedPluginStageResult, error) {
	if err := transaction.validate(); err != nil {
		return ManagedPluginStageResult{}, err
	}
	catalog, catalogDigest, candidate, candidateDigest, err := transaction.validateRequest(request)
	if err != nil {
		return ManagedPluginStageResult{}, err
	}
	if existing, err := transaction.readRecord(request.TransactionID); err == nil {
		if existing.CatalogDigest != catalogDigest || existing.CandidateLockDigest != candidateDigest {
			return ManagedPluginStageResult{}, errors.New("managed plugin transaction conflicts with durable record")
		}
		if err := transaction.verifyStaged(existing); err != nil {
			return ManagedPluginStageResult{}, err
		}
		return stageResult(existing)
	} else if !errors.Is(err, os.ErrNotExist) {
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
	record := managedPluginTransactionRecord{Version: managedPluginTransactionVersion, TransactionID: request.TransactionID, CatalogDigest: catalogDigest, CatalogData: append(json.RawMessage(nil), request.CatalogData...), CandidateLock: candidate, CandidateLockDigest: candidateDigest}
	for _, entry := range catalog.Entries {
		archive, archiveErr := transaction.stageVerifiedArchive(request.TransactionID, archives[entry.ID])
		if archiveErr != nil {
			return ManagedPluginStageResult{}, fmt.Errorf("stage managed plugin %s archive: %w", entry.ID, archiveErr)
		}
		destination := transaction.stagingObjectPath(request.TransactionID, entry.Digest)
		if err := transaction.extractArchive(archive, destination, entry.Digest); err != nil {
			return ManagedPluginStageResult{}, fmt.Errorf("stage managed plugin %s: %w", entry.ID, err)
		}
		record.Entries = append(record.Entries, managedPluginTransactionEntry{ID: entry.ID, Digest: entry.Digest})
	}
	if err := transaction.writeRecord(record); err != nil {
		return ManagedPluginStageResult{}, err
	}
	cleanup = false
	return stageResult(record)
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

func (transaction ManagedPluginTransaction) extractArchive(archivePath, destination, expectedDigest string) error {
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
	entries := 0
	var expanded int64
	for {
		header, nextErr := reader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return nextErr
		}
		entries++
		if entries > maxManagedPluginArchiveEntries || !safeArchivePath(header.Name) || seen[header.Name] {
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
			expanded += header.Size
			if expanded > maxManagedPluginExpandedBytes {
				return errors.New("managed plugin archive exceeds expanded byte budget")
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
	if entries == 0 {
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

func (transaction ManagedPluginTransaction) stageVerifiedArchive(transactionID string, source ManagedPluginArchiveSource) (string, error) {
	info, err := os.Lstat(source.Path)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || stat.Uid != transaction.ArchiveOwnerUID || info.Mode().Perm()&0o022 != 0 || info.Size() <= 0 || info.Size() > maxManagedPluginArchiveBytes {
		return "", errors.New("managed plugin archive identity or access is unsafe")
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
	_, copyErr := io.Copy(io.MultiWriter(output, hash), file)
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil {
		return "", errors.Join(copyErr, syncErr, closeErr)
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
	if _, err := os.Lstat(temporary); err == nil {
		return errors.New("managed plugin destination staging collision")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := copyImmutablePluginTree(transaction.stagingObjectPath(transactionID, digest), temporary, transaction.CodeOwnerUID, transaction.CodeOwnerGID); err != nil {
		return err
	}
	if err := os.Rename(temporary, destination); err != nil {
		_ = makePluginTreeRemovable(temporary)
		_ = os.RemoveAll(temporary)
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
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if err := writeAtomicFile(transaction.recordPath(record.TransactionID), data, 0o600); err != nil {
		return err
	}
	return syncPluginDirectory(transaction.recordRoot(record.TransactionID))
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
	return os.Chmod(directory, mode)
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
