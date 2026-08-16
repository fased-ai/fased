package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"fased-lifecycled/model"
)

// PruneGenerations removes executable generations that are no longer part of
// the committed rollback window. The caller must hold the lifecycle mutation
// lock. Candidate inboxes and dependency layers are intentionally outside this
// operation: acquisition owns its inbox, while dependency garbage collection
// requires a separate reference inventory.
func (s *Store) PruneGenerations() ([]string, error) {
	manifest, _, err := s.ReadManifest()
	if err != nil {
		return nil, err
	}
	if err := manifest.ValidateInstalled(); err != nil || manifest.ActiveGeneration == nil {
		return nil, errors.Join(err, errors.New("generation pruning requires a valid installed manifest"))
	}
	retained := map[string]struct{}{manifest.ActiveGeneration.ID: {}}
	if manifest.PreviousGeneration != nil {
		retained[manifest.PreviousGeneration.ID] = struct{}{}
	}
	if err := s.verifyRetainedGenerationPointers(manifest.ActiveGeneration.ID, generationID(manifest.PreviousGeneration)); err != nil {
		return nil, err
	}
	root := filepath.Join(s.installRoot, "generations")
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("committed generation root is unavailable")
	}
	if err != nil {
		return nil, err
	}
	removed := make([]string, 0)
	removalPaths := make([]string, 0)
	found := make(map[string]bool, len(retained))
	for _, entry := range entries {
		id := "sha256:" + entry.Name()
		if err := validateGenerationID(id); err != nil {
			return nil, fmt.Errorf("generation root contains an unexpected entry %q", entry.Name())
		}
		path := filepath.Join(root, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return nil, err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || stat.Uid != uint32(os.Geteuid()) {
			return nil, fmt.Errorf("generation %s is unsafe to prune", id)
		}
		if _, keep := retained[id]; keep {
			found[id] = true
			continue
		}
		removed = append(removed, id)
		removalPaths = append(removalPaths, path)
	}
	for id := range retained {
		if !found[id] {
			return nil, fmt.Errorf("retained generation %s is unavailable", id)
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

func (s *Store) verifyRetainedGenerationPointers(activeID, previousID string) error {
	for name, id := range map[string]string{"current": activeID, "previous": previousID} {
		path := filepath.Join(s.installRoot, name)
		if id == "" {
			if _, err := os.Lstat(path); err == nil {
				return fmt.Errorf("%s generation pointer exists without a manifest binding", name)
			} else if !errors.Is(err, os.ErrNotExist) {
				return err
			}
			continue
		}
		info, err := os.Lstat(path)
		if err != nil || info.Mode()&os.ModeSymlink == 0 {
			return errors.Join(err, fmt.Errorf("%s generation pointer is unavailable or unsafe", name))
		}
		target, err := os.Readlink(path)
		if err != nil {
			return err
		}
		expected := filepath.ToSlash(filepath.Join("generations", strings.TrimPrefix(id, "sha256:")))
		if target != expected {
			return fmt.Errorf("%s generation pointer differs from the committed manifest", name)
		}
	}
	return nil
}

func generationID(generation *model.Generation) string {
	if generation == nil {
		return ""
	}
	return generation.ID
}
