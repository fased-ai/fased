package platform

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	stateparticipant "fased-lifecycled/participant"
)

type managedArchiveMember struct {
	header tar.Header
	data   string
}

func managedTransactionFixture(t *testing.T, members []managedArchiveMember) (ManagedPluginTransaction, ManagedPluginStageRequest, string, string) {
	t.Helper()
	root := t.TempDir()
	codeRoot := filepath.Join(root, "plugin-code")
	transactionRoot := filepath.Join(root, "transactions")
	archivePath := filepath.Join(root, "plugin.tar.gz")
	if err := os.Mkdir(codeRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(transactionRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	archiveData := managedPluginArchive(t, members)
	if err := os.WriteFile(archivePath, archiveData, 0o444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(archivePath, 0o444); err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(root, "expected")
	if err := os.Mkdir(expected, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, member := range members {
		if member.header.Typeflag != tar.TypeReg && member.header.Typeflag != tar.TypeRegA {
			continue
		}
		path := filepath.Join(expected, filepath.FromSlash(member.header.Name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		mode := os.FileMode(0o444)
		if member.header.Mode&0o111 != 0 {
			mode = 0o555
		}
		if err := os.WriteFile(path, []byte(member.data), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
	}
	if err := filepath.WalkDir(expected, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.Chmod(path, 0o555)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = makePluginTreeRemovable(expected) })
	uid := uint32(os.Getuid())
	digest, err := stateparticipant.ImmutablePluginTreeDigest(expected, uid)
	if err != nil {
		t.Fatal(err)
	}
	archiveSum := sha256.Sum256(archiveData)
	archiveDigest := fmt.Sprintf("sha256:%x", archiveSum)
	catalog := stateparticipant.ManagedPluginCatalog{SchemaVersion: stateparticipant.ManagedPluginCatalogSchemaVersion, Type: "fased-managed-plugin-catalog", Entries: []stateparticipant.ManagedPluginCatalogEntry{{ID: "demo", Digest: digest, ArchiveDigest: archiveDigest, APICapability: "fased.plugin.v1", Required: true}}}
	catalogData, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	catalogDigest, err := stateparticipant.ManagedPluginCatalogDigest(catalog)
	if err != nil {
		t.Fatal(err)
	}
	transaction := ManagedPluginTransaction{CodeRoot: codeRoot, TransactionRoot: transactionRoot, CodeOwnerUID: uid, CodeOwnerGID: uint32(os.Getgid()), ArchiveOwnerUID: uid}
	request := ManagedPluginStageRequest{TransactionID: "plugin-transaction-1", CatalogData: catalogData, ExpectedCatalogDigest: catalogDigest, BaseLock: stateparticipant.PluginLock{SchemaVersion: stateparticipant.PluginLockSchemaVersion, Type: "fased-plugin-lock"}, Archives: []ManagedPluginArchiveSource{{ID: "demo", Path: archivePath, SHA256: archiveDigest}}}
	return transaction, request, root, digest
}

func managedPluginArchive(t *testing.T, members []managedArchiveMember) []byte {
	t.Helper()
	var data bytes.Buffer
	writer := gzip.NewWriter(&data)
	tarWriter := tar.NewWriter(writer)
	for _, member := range members {
		if member.header.Size == 0 {
			member.header.Size = int64(len(member.data))
		}
		if err := tarWriter.WriteHeader(&member.header); err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(tarWriter, member.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := tarWriter.Close(); err != nil && members[0].header.Size == int64(len(members[0].data)) {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestManagedPluginTransactionStagesImmutableCandidateWithoutLiveMutation(t *testing.T) {
	transaction, request, root, digest := managedTransactionFixture(t, []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "export default 1\n"}})
	liveLock := filepath.Join(root, "plugin.lock.json")
	liveData := filepath.Join(root, "plugin-data", "preserved")
	if err := os.MkdirAll(filepath.Dir(liveData), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(liveLock, []byte("live lock"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(liveData, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := transaction.Stage(request)
	if err != nil {
		t.Fatal(err)
	}
	defer transaction.Discard(request.TransactionID)
	if result.CandidateLockDigest == "" || len(result.CandidateLock.Entries) != 1 || result.CandidateLock.Entries[0].Digest != digest {
		t.Fatalf("candidate lock was not prepared from catalog: %+v", result)
	}
	if contents, err := os.ReadFile(liveLock); err != nil || string(contents) != "live lock" {
		t.Fatalf("live lock changed: %q %v", contents, err)
	}
	if contents, err := os.ReadFile(liveData); err != nil || string(contents) != "data" {
		t.Fatalf("live plugin data changed: %q %v", contents, err)
	}
	if _, err := os.Lstat(transaction.objectPath(digest)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stage activated code destination: %v", err)
	}
	staged, err := stateparticipant.ImmutablePluginTreeDigest(transaction.stagingObjectPath(request.TransactionID, digest), transaction.CodeOwnerUID)
	if err != nil || staged != digest {
		t.Fatalf("staged tree is not immutable catalog identity: %s %v", staged, err)
	}
	info, err := os.Lstat(filepath.Join(transaction.stagingRoot(request.TransactionID), "archives", "demo.tar.gz"))
	if err != nil {
		t.Fatal(err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != transaction.CodeOwnerUID || info.Mode().Perm() != 0o400 {
		t.Fatalf("operator archive was not copied into code-owner-only staging: %+v", info)
	}
}

func TestManagedPluginTransactionRefusesUnsafeNamespace(t *testing.T) {
	transaction, _, _, _ := managedTransactionFixture(t, []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "export default 1\n"}})
	t.Cleanup(func() { _ = makePluginTreeRemovable(transaction.CodeRoot) })
	unsafe := filepath.Join(transaction.TransactionRoot, "unsafe")
	if err := os.Symlink(transaction.CodeRoot, unsafe); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.recordIDs(); err == nil {
		t.Fatal("symlink transaction namespace entry was accepted")
	}
	if err := os.Remove(unsafe); err != nil {
		t.Fatal(err)
	}
}

func TestManagedPluginTransactionRejectsDigestMismatchTraversalSymlinkHardlinkAndBounds(t *testing.T) {
	cases := []struct {
		name    string
		members []managedArchiveMember
		mutate  func(*ManagedPluginStageRequest)
		tamper  bool
	}{
		{name: "digest mismatch", members: []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "one"}}, tamper: true},
		{name: "traversal", members: []managedArchiveMember{{header: tar.Header{Name: "../escape", Typeflag: tar.TypeReg, Mode: 0o644}, data: "one"}}},
		{name: "symlink", members: []managedArchiveMember{{header: tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Linkname: "index.js"}}}},
		{name: "hardlink", members: []managedArchiveMember{{header: tar.Header{Name: "link", Typeflag: tar.TypeLink, Linkname: "index.js"}}}},
		{name: "expanded size bound", members: []managedArchiveMember{{header: tar.Header{Name: "big", Typeflag: tar.TypeReg, Mode: 0o644, Size: maxManagedPluginExpandedBytes + 1}}}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			transaction, request, _, _ := managedTransactionFixture(t, testCase.members)
			if testCase.mutate != nil {
				testCase.mutate(&request)
			}
			if testCase.tamper {
				if err := os.Chmod(request.Archives[0].Path, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(request.Archives[0].Path, []byte("changed archive bytes"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(request.Archives[0].Path, 0o444); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := transaction.Stage(request); err == nil {
				t.Fatal("unsafe archive/catalog input was accepted")
			}
		})
	}
}

func TestManagedPluginTransactionRollbackPreservesExistingExactDestination(t *testing.T) {
	transaction, request, _, digest := managedTransactionFixture(t, []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "export default 1\n"}})
	if _, err := transaction.Stage(request); err != nil {
		t.Fatal(err)
	}
	destination := transaction.objectPath(digest)
	if err := transaction.copyStagedObject(request.TransactionID, digest, destination); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Activate(request.TransactionID); err != nil {
		t.Fatal(err)
	}
	if err := transaction.Rollback(request.TransactionID); err != nil {
		t.Fatal(err)
	}
	if actual, err := stateparticipant.ImmutablePluginTreeDigest(destination, transaction.CodeOwnerUID); err != nil || actual != digest {
		t.Fatalf("rollback removed or changed a pre-existing exact destination: %s %v", actual, err)
	}
	if err := transaction.Discard(request.TransactionID); err != nil {
		t.Fatal(err)
	}
	if err := makePluginTreeRemovable(destination); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(destination); err != nil {
		t.Fatal(err)
	}
}

func TestManagedPluginTransactionRejectsUnsafeDurableRecord(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*testing.T, ManagedPluginTransaction, string)
	}{
		{name: "symlink", mutate: func(t *testing.T, transaction ManagedPluginTransaction, transactionID string) {
			t.Helper()
			path := transaction.recordPath(transactionID)
			backup := path + ".backup"
			if err := os.Rename(path, backup); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(backup, path); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "wrong mode", mutate: func(t *testing.T, transaction ManagedPluginTransaction, transactionID string) {
			t.Helper()
			if err := os.Chmod(transaction.recordPath(transactionID), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "oversize", mutate: func(t *testing.T, transaction ManagedPluginTransaction, transactionID string) {
			t.Helper()
			if err := os.Truncate(transaction.recordPath(transactionID), maxManagedPluginRecordBytes+1); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "record root mode", mutate: func(t *testing.T, transaction ManagedPluginTransaction, transactionID string) {
			t.Helper()
			if err := os.Chmod(transaction.recordRoot(transactionID), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			transaction, request, _, _ := managedTransactionFixture(t, []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "export default 1\n"}})
			if _, err := transaction.Stage(request); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = transaction.removeTransactionRoots(request.TransactionID) })
			testCase.mutate(t, transaction, request.TransactionID)
			if _, err := transaction.Activate(request.TransactionID); err == nil {
				t.Fatal("unsafe durable record was accepted for activation")
			}
			if err := transaction.Rollback(request.TransactionID); err == nil {
				t.Fatal("unsafe durable record was accepted for rollback")
			}
			if err := transaction.Discard(request.TransactionID); err == nil {
				t.Fatal("unsafe durable record was accepted for discard")
			}
		})
	}
}

func TestManagedPluginTransactionReplayCollisionRollbackAndDiscard(t *testing.T) {
	transaction, request, _, digest := managedTransactionFixture(t, []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "export default 1\n"}})
	first, err := transaction.Stage(request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := transaction.Stage(request)
	if err != nil || first.CandidateLockDigest != second.CandidateLockDigest || !bytes.Equal(first.CandidateLockData, second.CandidateLockData) {
		t.Fatalf("same transaction did not replay idempotently: %#v %v", second, err)
	}
	collision := transaction.objectPath(digest)
	if err := os.Mkdir(collision, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(collision, "different.js"), []byte("different"), 0o444); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Activate(request.TransactionID); err == nil {
		t.Fatal("destination collision was accepted")
	}
	if err := os.RemoveAll(collision); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Activate(request.TransactionID); err != nil {
		t.Fatal(err)
	}
	if err := transaction.Rollback(request.TransactionID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(collision); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rollback did not remove transaction-created destination: %v", err)
	}
	if _, err := transaction.Activate(request.TransactionID); err != nil {
		t.Fatalf("transaction could not replay deterministically after rollback: %v", err)
	}
	if err := transaction.Rollback(request.TransactionID); err != nil {
		t.Fatal(err)
	}
	if err := transaction.Discard(request.TransactionID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(transaction.recordPath(request.TransactionID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("discard left durable transaction record: %v", err)
	}
	if _, err := os.Lstat(transaction.stagingRoot(request.TransactionID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("discard left transaction staging: %v", err)
	}
}

func TestManagedPluginTransactionRecoversExactInterruptedCopyResidue(t *testing.T) {
	transaction, request, _, digest := managedTransactionFixture(t, []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "export default 1\n"}})
	t.Cleanup(func() { _ = makePluginTreeRemovable(transaction.CodeRoot) })
	if _, err := transaction.Stage(request); err != nil {
		t.Fatal(err)
	}
	temporary := transaction.objectPath(digest) + ".staging-" + request.TransactionID
	if err := os.Mkdir(temporary, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(temporary, "partial.js"), []byte("partial"), 0o444); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Activate(request.TransactionID); err != nil {
		t.Fatalf("exact interrupted copy residue was not recovered: %v", err)
	}
	if _, err := os.Lstat(temporary); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("interrupted copy residue remains after retry: %v", err)
	}
	if actual, err := stateparticipant.ImmutablePluginTreeDigest(transaction.objectPath(digest), transaction.CodeOwnerUID); err != nil || actual != digest {
		t.Fatalf("retry did not publish exact immutable object: %s %v", actual, err)
	}
}

func TestManagedPluginTransactionRejectsUnsafeInterruptedCopyResidue(t *testing.T) {
	transaction, request, _, digest := managedTransactionFixture(t, []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "export default 1\n"}})
	t.Cleanup(func() { _ = makePluginTreeRemovable(transaction.CodeRoot) })
	if _, err := transaction.Stage(request); err != nil {
		t.Fatal(err)
	}
	temporary := transaction.objectPath(digest) + ".staging-" + request.TransactionID
	if err := os.Mkdir(temporary, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(transaction.stagingObjectPath(request.TransactionID, digest), filepath.Join(temporary, "substitution")); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Activate(request.TransactionID); err == nil || !strings.Contains(err.Error(), "residue is unsafe") {
		t.Fatalf("unsafe interrupted copy residue was not rejected: %v", err)
	}
	if _, err := os.Lstat(temporary); err != nil {
		t.Fatalf("unsafe residue was destructively removed: %v", err)
	}
}

func TestManagedPluginTransactionRecoversExactPreRecordResidue(t *testing.T) {
	transaction, request, _, _ := managedTransactionFixture(t, []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "export default 1\n"}})
	managedPluginPreRecordInterruption = func() error { return errors.New("injected pre-record interruption") }
	t.Cleanup(func() { managedPluginPreRecordInterruption = nil })
	if _, err := transaction.Stage(request); err == nil {
		t.Fatal("pre-record interruption was accepted")
	}
	if _, err := os.Lstat(transaction.stagingRoot(request.TransactionID)); err != nil {
		t.Fatalf("pre-record residue was not retained for recovery: %v", err)
	}
	managedPluginPreRecordInterruption = nil
	if _, err := transaction.Stage(request); err != nil {
		t.Fatalf("exact pre-record residue did not recover on retry: %v", err)
	}
	t.Cleanup(func() { _ = transaction.Discard(request.TransactionID) })
}

func TestManagedPluginTransactionRefusesHardlinkedPreRecordResidue(t *testing.T) {
	transaction, request, _, digest := managedTransactionFixture(t, []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "export default 1\n"}})
	managedPluginPreRecordInterruption = func() error { return errors.New("injected pre-record interruption") }
	t.Cleanup(func() { managedPluginPreRecordInterruption = nil })
	if _, err := transaction.Stage(request); err == nil {
		t.Fatal("pre-record interruption was accepted")
	}
	managedPluginPreRecordInterruption = nil
	object := transaction.stagingObjectPath(request.TransactionID, digest)
	if err := makePluginTreeRemovable(object); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(object, "index.js"), filepath.Join(object, "index-copy.js")); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Stage(request); err == nil || !strings.Contains(err.Error(), "unsafe") {
		t.Fatalf("hardlinked pre-record residue was accepted: %v", err)
	}
	t.Cleanup(func() { _ = transaction.removeTransactionRoots(request.TransactionID) })
}

func TestManagedPluginTransactionFailsBeforeMutationWhenCreatedRootCannotSync(t *testing.T) {
	transaction, request, _, _ := managedTransactionFixture(t, []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "export default 1\n"}})
	managedPluginCreatedRootSync = func(parent string) error {
		if parent == transaction.TransactionRoot {
			return errors.New("injected parent fsync failure")
		}
		return syncPluginDirectory(parent)
	}
	t.Cleanup(func() { managedPluginCreatedRootSync = syncPluginDirectory })
	if _, err := transaction.Stage(request); err == nil {
		t.Fatal("root creation fsync failure was accepted")
	}
	if _, err := os.Lstat(transaction.recordPath(request.TransactionID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed root creation published a durable record: %v", err)
	}
}

func TestManagedPluginTransactionRejectsOversizeDurableRecordBeforeRoots(t *testing.T) {
	transaction, request, _, _ := managedTransactionFixture(t, []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "export default 1\n"}})
	entries := make([]stateparticipant.ManagedPluginCatalogEntry, 0, 4096)
	for index := 0; index < 4096; index++ {
		entries = append(entries, stateparticipant.ManagedPluginCatalogEntry{ID: fmt.Sprintf("plugin-%04d", index), Digest: "sha256:" + strings.Repeat("a", 64), ArchiveDigest: "sha256:" + strings.Repeat("b", 64), APICapability: "fased.plugin.v1", Required: true})
	}
	catalog := stateparticipant.ManagedPluginCatalog{SchemaVersion: stateparticipant.ManagedPluginCatalogSchemaVersion, Type: "fased-managed-plugin-catalog", Entries: entries}
	data, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := stateparticipant.ManagedPluginCatalogDigest(catalog)
	if err != nil {
		t.Fatal(err)
	}
	request.CatalogData, request.ExpectedCatalogDigest, request.Archives = data, digest, nil
	if _, err := transaction.Stage(request); err == nil || !strings.Contains(err.Error(), "byte budget") {
		t.Fatalf("oversize durable record was accepted before roots: %v", err)
	}
	if _, err := os.Lstat(transaction.recordRoot(request.TransactionID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("oversize record created a transaction root: %v", err)
	}
	if _, err := os.Lstat(transaction.stagingRoot(request.TransactionID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("oversize record created staging: %v", err)
	}
}
