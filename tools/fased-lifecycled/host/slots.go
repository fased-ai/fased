package host

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"fased-lifecycled/acquire"
	"fased-lifecycled/trust"
)

type Store struct {
	root     *os.Root
	path     string
	ownerUID uint32
}
type StagedHost struct {
	Digest    string
	Path      string
	Protocols trust.HostProtocols
}

func OpenStore(path string, ownerUID uint32) (*Store, error) {
	root, err := acquire.OpenSecureRoot(path, ownerUID, true)
	if err != nil {
		return nil, err
	}
	if err := ensureChild(root, "hosts", ownerUID); err != nil {
		root.Close()
		return nil, err
	}
	return &Store{root: root, path: path, ownerUID: ownerUID}, nil
}
func (store *Store) Close() error {
	if store == nil || store.root == nil {
		return nil
	}
	return store.root.Close()
}

func (store *Store) Stage(object *acquire.Object, asset trust.Asset, requirements Requirements) (StagedHost, error) {
	if store == nil || store.root == nil || object == nil || asset.PrivilegedComponent != "lifecycle-host" || asset.Protocols == nil {
		return StagedHost{}, errors.New("lifecycle-host staging identity is incomplete")
	}
	if err := VerifyCompatibility(*asset.Protocols, requirements); err != nil {
		return StagedHost{}, err
	}
	receipt := object.Receipt()
	if receipt.Asset != asset.Name || receipt.SHA256 != asset.SHA256 || receipt.Size != asset.Size {
		return StagedHost{}, errors.New("verified inbox receipt differs from lifecycle-host identity")
	}
	digest := strings.TrimPrefix(asset.SHA256, "sha256:")
	hosts, err := store.root.OpenRoot("hosts")
	if err != nil {
		return StagedHost{}, err
	}
	defer hosts.Close()
	if err := ensureChild(hosts, digest, store.ownerUID); err != nil {
		return StagedHost{}, err
	}
	directory, err := hosts.OpenRoot(digest)
	if err != nil {
		return StagedHost{}, err
	}
	defer directory.Close()
	if existing, err := openHost(directory, store.ownerUID, asset); err == nil {
		existing.Close()
		return store.staged(asset, digest), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return StagedHost{}, err
	}
	tempName, err := randomSlotName()
	if err != nil {
		return StagedHost{}, err
	}
	temp, err := directory.OpenFile(tempName, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o500)
	if err != nil {
		return StagedHost{}, err
	}
	cleanup := true
	defer func() {
		temp.Close()
		if cleanup {
			_ = directory.Remove(tempName)
		}
	}()
	if err := temp.Chmod(0o500); err != nil {
		return StagedHost{}, err
	}
	written, err := object.CopyTo(temp)
	if err != nil || uint64(written) != asset.Size {
		return StagedHost{}, errors.New("lifecycle-host import did not consume the exact verified object")
	}
	if err := temp.Sync(); err != nil {
		return StagedHost{}, err
	}
	if err := temp.Close(); err != nil {
		return StagedHost{}, err
	}
	if err := directory.Link(tempName, "fased-lifecycled"); err != nil {
		return StagedHost{}, err
	}
	if err := directory.Remove(tempName); err != nil {
		return StagedHost{}, err
	}
	cleanup = false
	if err := syncRoot(directory); err != nil {
		return StagedHost{}, err
	}
	final, err := openHost(directory, store.ownerUID, asset)
	if err != nil {
		return StagedHost{}, err
	}
	final.Close()
	return store.staged(asset, digest), nil
}

func (store *Store) Activate(target StagedHost, inspect func(StagedHost) error) error {
	if store == nil || store.root == nil || target.Digest == "" || inspect == nil {
		return errors.New("lifecycle-host activation is incomplete")
	}
	if err := store.verifyStaged(target); err != nil {
		return err
	}
	current, err := store.readPointer("host-current")
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if current == target.Digest {
		return inspect(target)
	}
	if current != "" {
		if err := store.writePointer("host-previous", current); err != nil {
			return err
		}
	}
	if err := store.writePointer("host-current", target.Digest); err != nil {
		return err
	}
	if err := inspect(target); err != nil {
		if current == "" {
			return errors.Join(err, store.root.Remove("host-current"), syncRoot(store.root))
		}
		return errors.Join(err, store.writePointer("host-current", current))
	}
	return nil
}

func (store *Store) Current() (string, error)  { return store.readPointer("host-current") }
func (store *Store) Previous() (string, error) { return store.readPointer("host-previous") }

func (store *Store) staged(asset trust.Asset, digest string) StagedHost {
	return StagedHost{Digest: digest, Path: filepath.Join(store.path, "hosts", digest, "fased-lifecycled"), Protocols: *asset.Protocols}
}
func (store *Store) verifyStaged(host StagedHost) error {
	info, err := os.Lstat(host.Path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o500 {
		return errors.New("staged lifecycle host is not an immutable executable")
	}
	digest, err := hashFile(host.Path)
	if err != nil {
		return err
	}
	if digest != "sha256:"+host.Digest {
		return errors.New("staged lifecycle-host digest changed")
	}
	return nil
}

func ensureChild(parent *os.Root, name string, ownerUID uint32) error {
	info, err := parent.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		if err := parent.Mkdir(name, 0o700); err != nil {
			return err
		}
		if err := parent.Chmod(name, 0o700); err != nil {
			return err
		}
		info, err = parent.Lstat(name)
	}
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 || !ok || (stat.Uid != 0 && stat.Uid != ownerUID) {
		return errors.New("lifecycle-host directory is unsafe")
	}
	child, err := parent.OpenRoot(name)
	if err != nil {
		return err
	}
	defer child.Close()
	opened, err := child.Stat(".")
	if err != nil || !os.SameFile(info, opened) {
		return errors.New("lifecycle-host directory changed while opening")
	}
	return syncRoot(child)
}

func openHost(root *os.Root, ownerUID uint32, asset trust.Asset) (*os.File, error) {
	before, err := root.Lstat("fased-lifecycled")
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Mode().Perm() != 0o500 {
		return nil, errors.New("existing lifecycle host is unsafe")
	}
	file, err := root.Open("fased-lifecycled")
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	stat, ok := after.Sys().(*syscall.Stat_t)
	if !os.SameFile(before, after) || !ok || stat.Nlink != 1 || (stat.Uid != 0 && stat.Uid != ownerUID) || uint64(after.Size()) != asset.Size {
		file.Close()
		return nil, errors.New("existing lifecycle host identity is unsafe")
	}
	digest, err := hashOpen(file)
	if err != nil || digest != asset.SHA256 {
		file.Close()
		return nil, errors.New("existing lifecycle host digest conflicts")
	}
	return file, nil
}
func (store *Store) readPointer(name string) (string, error) {
	before, err := store.root.Lstat(name)
	if err != nil {
		return "", err
	}
	if !before.Mode().IsRegular() || before.Mode().Perm() != 0o600 {
		return "", errors.New("lifecycle-host pointer is unsafe")
	}
	file, err := store.root.Open(name)
	if err != nil {
		return "", err
	}
	defer file.Close()
	after, err := file.Stat()
	stat, ok := after.Sys().(*syscall.Stat_t)
	if err != nil || !os.SameFile(before, after) || !ok || stat.Nlink != 1 || (stat.Uid != 0 && stat.Uid != store.ownerUID) {
		return "", errors.New("lifecycle-host pointer identity changed")
	}
	data, err := io.ReadAll(io.LimitReader(file, 66))
	if err != nil {
		return "", err
	}
	value := strings.TrimSuffix(string(data), "\n")
	if len(value) != 64 || strings.Trim(value, "0123456789abcdef") != "" {
		return "", errors.New("lifecycle-host pointer digest is invalid")
	}
	return value, nil
}
func (store *Store) writePointer(name, digest string) error {
	if len(digest) != 64 || strings.Trim(digest, "0123456789abcdef") != "" {
		return errors.New("lifecycle-host pointer digest is invalid")
	}
	tempName, err := randomSlotName()
	if err != nil {
		return err
	}
	tempName = "." + name + "-" + tempName
	file, err := store.root.OpenFile(tempName, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	cleanup := true
	defer func() {
		file.Close()
		if cleanup {
			_ = store.root.Remove(tempName)
		}
	}()
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	if _, err := io.WriteString(file, digest+"\n"); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := store.root.Rename(tempName, name); err != nil {
		return err
	}
	cleanup = false
	return syncRoot(store.root)
}
func randomSlotName() (string, error) {
	data := make([]byte, 16)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(data), nil
}
func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	return hashOpen(file)
}
func hashOpen(file *os.File) (string, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	sum := sha256.New()
	if _, err := io.Copy(sum, file); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(sum.Sum(nil)), nil
}
func syncRoot(root *os.Root) error {
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
func (host StagedHost) String() string { return fmt.Sprintf("%s:%s", host.Digest, host.Path) }
