package store

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
	"runtime"
	"strings"
	"syscall"

	"fased-lifecycled/bundle"
)

const (
	maxDependencyArchiveEntries = 50_000
	maxDependencyArchiveBytes   = 600 * 1024 * 1024
	dependencyMarkerName        = ".fased-dependency-layer.json"
)

var errDependencyLayerIdentityDiffers = errors.New("installed dependency layer identity differs")

type dependencyMarker struct {
	SchemaVersion uint32 `json:"schemaVersion"`
	Hash          string `json:"hash"`
	Asset         string `json:"asset"`
	ArchiveSHA256 string `json:"archiveSHA256"`
}

func (s *Store) ImportDependencyArchive(archive string, layer bundle.DependencyLayer) error {
	if !filepath.IsAbs(archive) || filepath.Clean(archive) != archive {
		return errors.New("dependency archive path must be absolute and clean")
	}
	info, err := os.Lstat(archive)
	if err != nil {
		return err
	}
	archiveStat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || archiveStat.Nlink != 1 {
		return errors.New("dependency archive must be one regular file")
	}
	if archiveDigest, err := hashDependencyArchive(archive); err != nil {
		return err
	} else if archiveDigest != layer.ArchiveSHA256 {
		return errors.New("dependency archive does not match the generation contract")
	}
	destination := s.dependencyArchivePath(layer)
	if _, err := os.Lstat(destination); err == nil {
		if err := s.verifyDependencyPath(destination, layer); err != nil {
			return err
		}
		if normalizedDependencyMarker(destination) {
			return nil
		}
		return normalizeDependencyMarker(destination)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	legacy := s.dependencyPath(layer.Hash)
	if _, err := os.Lstat(legacy); err == nil {
		if verifyErr := s.verifyDependencyPath(legacy, layer); verifyErr == nil {
			if normalizedDependencyMarker(legacy) {
				return nil
			}
			return normalizeDependencyMarker(legacy)
		} else if !errors.Is(verifyErr, errDependencyLayerIdentityDiffers) {
			return verifyErr
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	root := filepath.Join(s.installRoot, "dependencies")
	if err := os.MkdirAll(root, 0o711); err != nil {
		return err
	}
	if err := os.Chmod(root, 0o711); err != nil {
		return err
	}
	temporary, err := os.MkdirTemp(root, ".dependency-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	if err := os.Chmod(temporary, 0o755); err != nil {
		return err
	}
	if err := extractDependencyArchive(archive, temporary); err != nil {
		return err
	}
	marker := dependencyMarker{SchemaVersion: 1, Hash: layer.Hash, Asset: layer.Asset, ArchiveSHA256: layer.ArchiveSHA256}
	data, err := json.Marshal(marker)
	if err != nil {
		return err
	}
	if err := writeAtomic(filepath.Join(temporary, dependencyMarkerName), append(data, '\n'), 0o600); err != nil {
		return err
	}
	if err := s.verifyDependencyPath(temporary, layer); err != nil {
		return err
	}
	if err := normalizeDependencyMarker(temporary); err != nil {
		return err
	}
	if err := syncDependencyFilesystem(temporary); err != nil {
		return err
	}
	if err := os.Rename(temporary, destination); err != nil {
		return err
	}
	return syncDirectory(root)
}

func normalizedDependencyMarker(root string) bool {
	info, err := os.Lstat(filepath.Join(root, dependencyMarkerName))
	return err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm() == 0o644
}

func normalizeDependencyMarker(root string) error {
	path := filepath.Join(root, dependencyMarkerName)
	before, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := before.Sys().(*syscall.Stat_t)
	if !ok || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || stat.Uid != uint32(os.Geteuid()) || before.Mode().Perm()&0o022 != 0 {
		return errors.New("installed dependency identity marker is unsafe")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		return errors.New("installed dependency identity marker changed while opening")
	}
	if err := file.Chmod(0o644); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	return syncDirectory(root)
}

func (s *Store) GenerationDependency(generationID string) (*bundle.DependencyLayer, error) {
	if err := validateGenerationID(generationID); err != nil {
		return nil, err
	}
	for _, root := range []string{s.generationPath(generationID), s.inboxGenerationPath(generationID)} {
		data, err := readGenerationInventory(filepath.Join(root, generationInventoryName))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		inventory, err := bundle.DecodeInventory(data)
		if err != nil {
			return nil, err
		}
		generation, err := bundle.Identity(inventory)
		if err != nil || generation.ID != generationID {
			return nil, errors.New("generation dependency and inventory identity differ")
		}
		return inventory.Dependency, nil
	}
	return nil, os.ErrNotExist
}

func (s *Store) GenerationDependencyPath(generationID string) (string, error) {
	layer, err := s.GenerationDependency(generationID)
	if err != nil {
		return "", err
	}
	if layer == nil {
		return "", nil
	}
	root, err := s.resolveDependencyPath(*layer)
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "node_modules"), nil
}

func (s *Store) resolveDependencyPath(layer bundle.DependencyLayer) (string, error) {
	for _, root := range []string{s.dependencyArchivePath(layer), s.dependencyPath(layer.Hash)} {
		if err := s.verifyDependencyPath(root, layer); err == nil {
			return root, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	return "", os.ErrNotExist
}

func (s *Store) verifyDependencyPath(root string, expected bundle.DependencyLayer) error {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return err
	}
	stat, ok := rootInfo.Sys().(*syscall.Stat_t)
	if !ok || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 || rootInfo.Mode().Perm()&0o022 != 0 || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("installed dependency root is unsafe")
	}
	modules, err := os.Lstat(filepath.Join(root, "node_modules"))
	if err != nil || !modules.IsDir() || modules.Mode()&os.ModeSymlink != 0 || modules.Mode().Perm()&0o022 != 0 {
		return errors.New("installed dependency layer is unsafe")
	}
	data, err := readRegular(filepath.Join(root, dependencyMarkerName))
	if err != nil {
		return err
	}
	var marker dependencyMarker
	if err := json.Unmarshal(data, &marker); err != nil {
		return err
	}
	if marker.SchemaVersion != 1 || marker.Hash != expected.Hash || marker.Asset != expected.Asset || marker.ArchiveSHA256 != expected.ArchiveSHA256 {
		return errDependencyLayerIdentityDiffers
	}
	return nil
}

func (s *Store) dependencyPath(hash string) string {
	return filepath.Join(s.installRoot, "dependencies", hash)
}

func (s *Store) dependencyArchivePath(layer bundle.DependencyLayer) string {
	archiveDigest := strings.TrimPrefix(layer.ArchiveSHA256, "sha256:")
	return filepath.Join(s.installRoot, "dependencies", layer.Hash+"-"+archiveDigest)
}

func hashDependencyArchive(file string) (string, error) {
	input, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer input.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, input); err != nil {
		return "", err
	}
	return fmt.Sprintf("sha256:%x", hash.Sum(nil)), nil
}

func extractDependencyArchive(archive, destination string) error {
	root, err := os.OpenRoot(destination)
	if err != nil {
		return err
	}
	defer root.Close()
	input, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer input.Close()
	compressed, err := gzip.NewReader(input)
	if err != nil {
		return err
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	seen := make(map[string]struct{})
	entries := 0
	var total int64
	for {
		header, nextErr := reader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return nextErr
		}
		entries++
		total += header.Size
		if entries > maxDependencyArchiveEntries || total > maxDependencyArchiveBytes || header.Size < 0 {
			return errors.New("dependency archive exceeds its extraction budget")
		}
		name := strings.TrimSuffix(header.Name, "/")
		clean := path.Clean(name)
		if clean != name || strings.Contains(name, `\`) || (clean != "node_modules" && !strings.HasPrefix(clean, "node_modules/")) {
			return fmt.Errorf("dependency archive contains unsafe entry %q", header.Name)
		}
		if _, duplicate := seen[clean]; duplicate {
			return fmt.Errorf("dependency archive contains duplicate entry %q", clean)
		}
		seen[clean] = struct{}{}
		target := filepath.FromSlash(clean)
		if err := ensureArchiveParent(root, filepath.Dir(target)); err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := root.Mkdir(target, 0o755); err != nil {
				return err
			}
			if err := root.Chmod(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			mode := os.FileMode(0o644)
			if header.Mode&0o111 != 0 {
				mode = 0o755
			}
			output, err := root.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if err != nil {
				return err
			}
			_, copyErr := io.CopyN(output, reader, header.Size)
			chmodErr := output.Chmod(mode)
			closeErr := output.Close()
			if err := errors.Join(copyErr, chmodErr, closeErr); err != nil {
				return err
			}
		case tar.TypeSymlink:
			link := header.Linkname
			resolved := path.Clean(path.Join(path.Dir(clean), link))
			if link == "" || path.IsAbs(link) || strings.Contains(link, `\`) || (resolved != "node_modules" && !strings.HasPrefix(resolved, "node_modules/")) {
				return fmt.Errorf("dependency archive contains unsafe symlink %q", clean)
			}
			if err := root.Symlink(filepath.FromSlash(link), target); err != nil {
				return err
			}
		default:
			return fmt.Errorf("dependency archive contains unsupported entry %q", clean)
		}
	}
	if _, err := root.Stat("node_modules"); err != nil {
		return errors.New("dependency archive does not contain node_modules")
	}
	return nil
}

func syncDependencyFilesystem(root string) error {
	var trap uintptr
	switch runtime.GOARCH {
	case "amd64":
		trap = 306
	case "arm64":
		trap = 267
	default:
		return fmt.Errorf("dependency filesystem sync is unsupported on %s", runtime.GOARCH)
	}
	directory, err := os.Open(root)
	if err != nil {
		return err
	}
	defer directory.Close()
	for {
		_, _, errno := syscall.Syscall(trap, directory.Fd(), 0, 0)
		if errno == 0 {
			return nil
		}
		if errno != syscall.EINTR {
			return errno
		}
	}
}
