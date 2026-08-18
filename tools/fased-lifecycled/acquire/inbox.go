package acquire

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"fased-lifecycled/trust"
)

var canonicalAssetName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$`)
var canonicalDigestDirectory = regexp.MustCompile(`^[a-f0-9]{64}$`)
var canonicalStagingObject = regexp.MustCompile(`^[a-f0-9]{32}$`)

type Inbox struct {
	root     *os.Root
	path     string
	ownerUID uint32
}

type Object struct {
	file    *os.File
	receipt Receipt
}

func OpenInbox(lifecycleRoot string, ownerUID uint32) (*Inbox, error) {
	root, err := OpenSecureRoot(lifecycleRoot, ownerUID, true)
	if err != nil {
		return nil, err
	}
	inboxRoot, err := ensureDirectory(root, "inbox", ownerUID, 0o700)
	root.Close()
	if err != nil {
		return nil, err
	}
	staging, err := ensureDirectory(inboxRoot, ".staging", ownerUID, 0o700)
	if err != nil {
		inboxRoot.Close()
		return nil, err
	}
	if err := syncDirectory(staging); err != nil {
		staging.Close()
		inboxRoot.Close()
		return nil, err
	}
	staging.Close()
	return &Inbox{root: inboxRoot, path: filepath.Join(lifecycleRoot, "inbox"), ownerUID: ownerUID}, nil
}

func (inbox *Inbox) Close() error {
	if inbox == nil || inbox.root == nil {
		return nil
	}
	return inbox.root.Close()
}

// Prune removes verified acquisition objects only after their caller has
// committed every downstream lifecycle transaction. It validates the complete
// inbox before deleting anything so an unexpected entry preserves all evidence
// and fails closed.
func (inbox *Inbox) Prune() (int, error) {
	if inbox == nil || inbox.root == nil {
		return 0, errors.New("artifact inbox is unavailable")
	}
	entries, err := readRootDirectory(inbox.root, ".")
	if err != nil {
		return 0, err
	}
	targets := make([]string, 0)
	for _, entry := range entries {
		name := entry.Name()
		if name == ".staging" {
			if err := inbox.validateStagingDirectory(); err != nil {
				return 0, err
			}
			staged, err := readRootDirectory(inbox.root, name)
			if err != nil {
				return 0, err
			}
			for _, object := range staged {
				targets = append(targets, filepath.Join(name, object.Name()))
			}
			continue
		}
		if !canonicalDigestDirectory.MatchString(name) {
			return 0, fmt.Errorf("artifact inbox contains unexpected entry %q", name)
		}
		if err := inbox.validateDigestDirectory(name); err != nil {
			return 0, err
		}
		targets = append(targets, name)
	}
	for _, target := range targets {
		if err := inbox.root.RemoveAll(target); err != nil {
			return 0, err
		}
	}
	if err := syncDirectory(inbox.root); err != nil {
		return 0, err
	}
	return len(targets), nil
}

func (inbox *Inbox) validateStagingDirectory() error {
	info, err := inbox.root.Lstat(".staging")
	if err != nil || validateDirectoryInfo(info, inbox.ownerUID, true) != nil {
		return errors.Join(err, errors.New("artifact staging directory is unsafe"))
	}
	entries, err := readRootDirectory(inbox.root, ".staging")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !canonicalStagingObject.MatchString(entry.Name()) {
			return errors.New("artifact staging directory contains an unexpected entry")
		}
		info, err := inbox.root.Lstat(filepath.Join(".staging", entry.Name()))
		if err != nil || !safePrunableInboxObject(info, inbox.ownerUID, true) {
			return errors.Join(err, errors.New("artifact staging object is unsafe"))
		}
	}
	return nil
}

func (inbox *Inbox) validateDigestDirectory(name string) error {
	info, err := inbox.root.Lstat(name)
	if err != nil || validateDirectoryInfo(info, inbox.ownerUID, true) != nil {
		return errors.Join(err, errors.New("artifact digest directory is unsafe"))
	}
	entries, err := readRootDirectory(inbox.root, name)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !canonicalAssetName.MatchString(entry.Name()) {
			return errors.New("artifact digest directory contains an unexpected entry")
		}
		info, err := inbox.root.Lstat(filepath.Join(name, entry.Name()))
		if err != nil || !safePrunableInboxObject(info, inbox.ownerUID, false) {
			return errors.Join(err, errors.New("artifact inbox object is unsafe"))
		}
	}
	return nil
}

func safePrunableInboxObject(info os.FileInfo, ownerUID uint32, staging bool) bool {
	if info == nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 || (stat.Uid != 0 && stat.Uid != ownerUID) {
		return false
	}
	mode := info.Mode().Perm()
	return mode == 0o400 || staging && mode == 0o600
}

func readRootDirectory(root *os.Root, name string) ([]os.DirEntry, error) {
	directory, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	return directory.ReadDir(-1)
}

func (inbox *Inbox) Put(ctx context.Context, asset trust.Asset, source io.Reader) (*Object, error) {
	started := time.Now()
	var fsyncMillis uint64
	if inbox == nil || inbox.root == nil || source == nil {
		return nil, errors.New("artifact inbox is unavailable")
	}
	if !canonicalAssetName.MatchString(asset.Name) || asset.Size == 0 || !strings.HasPrefix(asset.SHA256, "sha256:") || len(asset.SHA256) != 71 {
		return nil, errors.New("artifact identity is invalid")
	}
	tempName, err := randomName()
	if err != nil {
		return nil, err
	}
	tempPath := filepath.Join(".staging", tempName)
	file, err := inbox.root.OpenFile(tempPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	removeTemp := true
	defer func() {
		if removeTemp {
			file.Close()
			_ = inbox.root.Remove(tempPath)
		}
	}()
	if err := file.Chmod(0o600); err != nil {
		return nil, err
	}
	hash := sha256.New()
	written, err := copyBounded(ctx, io.MultiWriter(file, hash), source, asset.Size)
	if err != nil {
		return nil, err
	}
	actualDigest := "sha256:" + hex.EncodeToString(hash.Sum(nil))
	if written != asset.Size || actualDigest != asset.SHA256 {
		return nil, errors.New("downloaded artifact size or digest differs from the signed index")
	}
	if err := file.Chmod(0o400); err != nil {
		return nil, err
	}
	fsyncStarted := time.Now()
	if err := file.Sync(); err != nil {
		return nil, err
	}
	fsyncMillis += elapsedMillis(fsyncStarted)
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if err := validateObjectInfo(info, inbox.ownerUID, asset.Size); err != nil {
		return nil, err
	}
	digestDir := strings.TrimPrefix(asset.SHA256, "sha256:")
	directory, err := ensureDirectory(inbox.root, digestDir, inbox.ownerUID, 0o700)
	if err != nil {
		return nil, err
	}
	directory.Close()
	finalPath := filepath.Join(digestDir, asset.Name)
	if existing, openErr := openBoundRegular(inbox.root, finalPath, inbox.ownerUID, asset.Size); openErr == nil {
		if digest, digestErr := hashOpenFile(existing); digestErr != nil || digest != asset.SHA256 {
			existing.Close()
			return nil, errors.New("existing inbox object conflicts with signed identity")
		}
		file.Close()
		_ = inbox.root.Remove(tempPath)
		removeTemp = false
		return newObject(existing, asset, finalPath, asset.Size, false, elapsedMillis(started), fsyncMillis), nil
	} else if !errors.Is(openErr, os.ErrNotExist) {
		return nil, openErr
	}
	if err := inbox.root.Rename(tempPath, finalPath); err != nil {
		return nil, err
	}
	removeTemp = false
	fsyncStarted = time.Now()
	if err := syncRelativeDirectory(inbox.root, ".staging"); err != nil {
		file.Close()
		return nil, err
	}
	if err := syncRelativeDirectory(inbox.root, digestDir); err != nil {
		file.Close()
		return nil, err
	}
	if err := syncDirectory(inbox.root); err != nil {
		file.Close()
		return nil, err
	}
	fsyncMillis += elapsedMillis(fsyncStarted)
	return newObject(file, asset, finalPath, asset.Size, false, elapsedMillis(started), fsyncMillis), nil
}

// Open returns an already verified immutable object without consuming network
// bytes. Every call revalidates metadata and content against the signed asset
// identity, so CacheHit never means a name-only or stale-path match.
func (inbox *Inbox) Open(asset trust.Asset) (*Object, error) {
	started := time.Now()
	if inbox == nil || inbox.root == nil || !canonicalAssetName.MatchString(asset.Name) || asset.Size == 0 || !strings.HasPrefix(asset.SHA256, "sha256:") || len(asset.SHA256) != 71 {
		return nil, errors.New("artifact identity is invalid")
	}
	relative := filepath.Join(strings.TrimPrefix(asset.SHA256, "sha256:"), asset.Name)
	file, err := openBoundRegular(inbox.root, relative, inbox.ownerUID, asset.Size)
	if err != nil {
		return nil, err
	}
	digest, err := hashOpenFile(file)
	if err != nil || digest != asset.SHA256 {
		file.Close()
		return nil, errors.Join(err, errors.New("existing inbox object conflicts with signed identity"))
	}
	return newObject(file, asset, relative, 0, true, elapsedMillis(started), 0), nil
}

func (object *Object) Receipt() Receipt { return object.receipt }
func (object *Object) Close() error {
	if object == nil || object.file == nil {
		return nil
	}
	return object.file.Close()
}
func (object *Object) CopyTo(writer io.Writer) (int64, error) {
	if object == nil || object.file == nil || writer == nil {
		return 0, errors.New("verified artifact object is unavailable")
	}
	if _, err := object.file.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	return io.Copy(writer, io.LimitReader(object.file, int64(object.receipt.Size)))
}

func newObject(file *os.File, asset trust.Asset, relative string, transferredBytes uint64, cacheHit bool, durationMillis, fsyncMillis uint64) *Object {
	info, _ := file.Stat()
	device, inode := fileIdentity(info)
	return &Object{file: file, receipt: Receipt{SchemaVersion: 2, Asset: asset.Name, SHA256: asset.SHA256, Size: asset.Size, RelativePath: relative, Device: device, Inode: inode, TransferredBytes: transferredBytes, CacheHit: cacheHit, DurationMillis: durationMillis, FsyncMillis: fsyncMillis}}
}

func elapsedMillis(started time.Time) uint64 {
	elapsed := time.Since(started).Milliseconds()
	if elapsed < 1 {
		return 1
	}
	return uint64(elapsed)
}

func OpenSecureRoot(path string, ownerUID uint32, create bool) (*os.Root, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
		return nil, errors.New("secure root path must be one clean absolute child path")
	}
	current, err := os.OpenRoot("/")
	if err != nil {
		return nil, err
	}
	rootInfo, err := current.Stat(".")
	if err != nil {
		current.Close()
		return nil, err
	}
	rootStat, ok := rootInfo.Sys().(*syscall.Stat_t)
	if !ok {
		current.Close()
		return nil, errors.New("filesystem root identity is unavailable")
	}
	systemUID := rootStat.Uid
	components := strings.Split(strings.TrimPrefix(path, "/"), string(filepath.Separator))
	for _, component := range components {
		if component == "" || component == "." || component == ".." {
			current.Close()
			return nil, errors.New("secure root contains an unsafe component")
		}
		info, statErr := current.Lstat(component)
		if errors.Is(statErr, os.ErrNotExist) && create {
			if err := current.Mkdir(component, 0o700); err != nil {
				current.Close()
				return nil, err
			}
			if err := current.Chmod(component, 0o700); err != nil {
				current.Close()
				return nil, err
			}
			info, statErr = current.Lstat(component)
		}
		if statErr != nil {
			current.Close()
			return nil, statErr
		}
		if err := validateAncestorInfo(info, ownerUID, systemUID); err != nil {
			current.Close()
			return nil, fmt.Errorf("unsafe directory %q: %w", component, err)
		}
		next, err := current.OpenRoot(component)
		if err != nil {
			current.Close()
			return nil, err
		}
		opened, err := next.Stat(".")
		if err != nil || !os.SameFile(info, opened) {
			next.Close()
			current.Close()
			return nil, errors.New("secure directory changed while opening")
		}
		current.Close()
		current = next
	}
	return current, nil
}

func validateAncestorInfo(info os.FileInfo, ownerUID, systemUID uint32) error {
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("path is not a real directory")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || (stat.Uid != systemUID && stat.Uid != ownerUID) {
		return errors.New("directory owner is not trusted")
	}
	if info.Mode().Perm()&0o022 != 0 {
		return errors.New("directory is group/world writable")
	}
	return nil
}

func ensureDirectory(parent *os.Root, name string, ownerUID uint32, mode os.FileMode) (*os.Root, error) {
	if filepath.Base(name) != name || name == "." || name == ".." {
		return nil, errors.New("directory name is unsafe")
	}
	info, err := parent.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		if err := parent.Mkdir(name, mode); err != nil {
			return nil, err
		}
		if err := parent.Chmod(name, mode); err != nil {
			return nil, err
		}
		info, err = parent.Lstat(name)
	}
	if err != nil {
		return nil, err
	}
	if err := validateDirectoryInfo(info, ownerUID, true); err != nil {
		return nil, err
	}
	child, err := parent.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	opened, err := child.Stat(".")
	if err != nil || !os.SameFile(info, opened) {
		child.Close()
		return nil, errors.New("directory changed while opening")
	}
	return child, nil
}

func validateDirectoryInfo(info os.FileInfo, ownerUID uint32, exact bool) error {
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("path is not a real directory")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || (stat.Uid != 0 && stat.Uid != ownerUID) {
		return errors.New("directory owner is not trusted")
	}
	if info.Mode().Perm()&0o022 != 0 {
		return errors.New("directory is group/world writable")
	}
	if exact && info.Mode().Perm() != 0o700 {
		return errors.New("private directory mode is not 0700")
	}
	return nil
}

func openBoundRegular(root *os.Root, name string, ownerUID uint32, size uint64) (*os.File, error) {
	before, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if before.Mode()&os.ModeSymlink != 0 || !before.Mode().IsRegular() {
		return nil, errors.New("artifact object is not a non-symlink regular file")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		file.Close()
		return nil, errors.New("artifact object changed while opening")
	}
	if err := validateObjectInfo(after, ownerUID, size); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func validateObjectInfo(info os.FileInfo, ownerUID uint32, size uint64) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o400 || !ok || stat.Nlink != 1 || (stat.Uid != 0 && stat.Uid != ownerUID) || uint64(info.Size()) != size {
		return errors.New("artifact object identity, owner, link count, or size is invalid")
	}
	return nil
}

func fileIdentity(info os.FileInfo) (uint64, uint64) {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(stat.Dev), stat.Ino
	}
	return 0, 0
}
func hashOpenFile(file *os.File) (string, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}
func copyBounded(ctx context.Context, destination io.Writer, source io.Reader, size uint64) (uint64, error) {
	limited := &io.LimitedReader{R: source, N: int64(size) + 1}
	buffer := make([]byte, 128*1024)
	var written uint64
	for {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		count, readErr := limited.Read(buffer)
		if count > 0 {
			if written+uint64(count) > size {
				return written, errors.New("artifact exceeds signed size")
			}
			output, err := destination.Write(buffer[:count])
			written += uint64(output)
			if err != nil || output != count {
				if err == nil {
					err = io.ErrShortWrite
				}
				return written, err
			}
		}
		if errors.Is(readErr, io.EOF) {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}
func randomName() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}
func syncRelativeDirectory(root *os.Root, name string) error {
	directory, err := root.Open(name)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
func syncDirectory(root *os.Root) error {
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
