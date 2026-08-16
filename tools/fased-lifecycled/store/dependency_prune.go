package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"fased-lifecycled/bundle"
)

var (
	dependencyDirectoryPattern = regexp.MustCompile(`^[0-9a-f]{64}(?:-[0-9a-f]{64})?$`)
	dependencyAssetPattern     = regexp.MustCompile(`^[0-9A-Za-z._+-]{1,256}$`)
	temporaryDependencyPattern = regexp.MustCompile(`^\.dependency-[0-9A-Za-z]+$`)
)

// PruneDependencies removes dependency layers outside the committed
// active/previous rollback window. It validates every directory before the
// first removal so an unexpected entry cannot turn cleanup into an unbounded
// recursive delete.
func (s *Store) PruneDependencies() ([]string, error) {
	manifest, _, err := s.ReadManifest()
	if err != nil {
		return nil, err
	}
	if err := manifest.ValidateInstalled(); err != nil || manifest.ActiveGeneration == nil {
		return nil, errors.Join(err, errors.New("dependency pruning requires a valid installed manifest"))
	}
	retained := make(map[string]struct{})
	generationIDs := []string{manifest.ActiveGeneration.ID}
	if manifest.PreviousGeneration != nil {
		generationIDs = append(generationIDs, manifest.PreviousGeneration.ID)
	}
	for _, generationID := range generationIDs {
		if generationID == "" {
			continue
		}
		layer, err := s.GenerationDependency(generationID)
		if err != nil {
			return nil, err
		}
		if layer == nil {
			continue
		}
		root, err := s.resolveDependencyPath(*layer)
		if err != nil {
			return nil, fmt.Errorf("retained generation %s dependency is unavailable: %w", generationID, err)
		}
		retained[filepath.Base(root)] = struct{}{}
	}

	root := filepath.Join(s.installRoot, "dependencies")
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) && len(retained) == 0 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	removed := make([]string, 0)
	removalPaths := make([]string, 0)
	found := make(map[string]bool, len(retained))
	for _, entry := range entries {
		name := entry.Name()
		path := filepath.Join(root, name)
		if err := validateDependencyPruneRoot(path); err != nil {
			return nil, fmt.Errorf("dependency root contains unsafe entry %q: %w", name, err)
		}
		if _, keep := retained[name]; keep {
			found[name] = true
			continue
		}
		if temporaryDependencyPattern.MatchString(name) {
			removed = append(removed, name)
			removalPaths = append(removalPaths, path)
			continue
		}
		if !dependencyDirectoryPattern.MatchString(name) {
			return nil, fmt.Errorf("dependency root contains unexpected entry %q", name)
		}
		marker, err := readPrunableDependencyMarker(path)
		if err != nil {
			return nil, fmt.Errorf("dependency %q identity is unsafe: %w", name, err)
		}
		if name != marker.Hash && name != dependencyDirectoryName(marker) {
			return nil, fmt.Errorf("dependency %q differs from its identity marker", name)
		}
		layer := bundle.DependencyLayer{Hash: marker.Hash, Asset: marker.Asset, ArchiveSHA256: marker.ArchiveSHA256}
		if err := s.verifyDependencyPath(path, layer); err != nil {
			return nil, fmt.Errorf("dependency %q failed verification: %w", name, err)
		}
		removed = append(removed, name)
		removalPaths = append(removalPaths, path)
	}
	for name := range retained {
		if !found[name] {
			return nil, fmt.Errorf("retained dependency %s is unavailable", name)
		}
	}
	for _, path := range removalPaths {
		if err := os.RemoveAll(path); err != nil {
			return nil, err
		}
	}
	if len(removed) != 0 {
		if err := syncDirectory(root); err != nil {
			return nil, err
		}
	}
	return removed, nil
}

func validateDependencyPruneRoot(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("entry is not a root-owned non-writable directory")
	}
	return nil
}

func readPrunableDependencyMarker(root string) (dependencyMarker, error) {
	path := filepath.Join(root, dependencyMarkerName)
	info, err := os.Lstat(path)
	if err != nil {
		return dependencyMarker{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0o022 != 0 || info.Size() <= 0 || info.Size() > 4096 {
		return dependencyMarker{}, errors.New("marker is not one safe bounded file")
	}
	data, err := readRegular(path)
	if err != nil {
		return dependencyMarker{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var marker dependencyMarker
	if err := decoder.Decode(&marker); err != nil {
		return dependencyMarker{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return dependencyMarker{}, errors.New("marker contains trailing data")
	}
	if marker.SchemaVersion != 1 || len(marker.Hash) != 64 || strings.TrimPrefix(marker.ArchiveSHA256, "sha256:") == marker.ArchiveSHA256 || len(strings.TrimPrefix(marker.ArchiveSHA256, "sha256:")) != 64 || !dependencyDirectoryPattern.MatchString(marker.Hash) || !dependencyAssetPattern.MatchString(marker.Asset) {
		return dependencyMarker{}, errors.New("marker identity is invalid")
	}
	for _, value := range []string{marker.Hash, strings.TrimPrefix(marker.ArchiveSHA256, "sha256:")} {
		if strings.Trim(value, "0123456789abcdef") != "" {
			return dependencyMarker{}, errors.New("marker digest is invalid")
		}
	}
	return marker, nil
}

func dependencyDirectoryName(marker dependencyMarker) string {
	archive := strings.TrimPrefix(marker.ArchiveSHA256, "sha256:")
	return marker.Hash + "-" + archive
}
