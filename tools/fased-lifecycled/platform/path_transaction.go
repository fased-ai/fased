package platform

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type pathMetadata struct {
	path       string
	uid, gid   uint32
	mode       os.FileMode
	previously bool
}

type BootstrapPathChanges struct {
	metadata []pathMetadata
	created  []string
	finished bool
}

func ApplyBootstrapPathPlanTransactional(paths []BootstrapPath) (*BootstrapPathChanges, error) {
	for _, spec := range paths {
		if !filepath.IsAbs(spec.Path) || filepath.Clean(spec.Path) != spec.Path || spec.Path == "/" || spec.Mode.Perm()&0o002 != 0 {
			return nil, errors.New("bootstrap path plan contains an unsafe path or mode")
		}
	}
	changes := &BootstrapPathChanges{}
	for _, spec := range paths {
		metadata, err := capturePathMetadata(spec.Path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, errors.Join(err, changes.Rollback())
		}
		if errors.Is(err, os.ErrNotExist) {
			metadata = pathMetadata{path: spec.Path}
		}
		changes.metadata = append(changes.metadata, metadata)
		if err := ensureBootstrapDirectoryTracked(spec.Path, spec.Mode.Perm(), changes); err != nil {
			return nil, errors.Join(err, changes.Rollback())
		}
		info, err := os.Lstat(spec.Path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.Join(errors.New("bootstrap path is not a safe directory"), changes.Rollback())
		}
		if err := os.Chown(spec.Path, int(spec.UID), int(spec.GID)); err != nil {
			return nil, errors.Join(err, changes.Rollback())
		}
		if err := os.Chmod(spec.Path, spec.Mode); err != nil {
			return nil, errors.Join(err, changes.Rollback())
		}
	}
	return changes, nil
}

func capturePathMetadata(path string) (pathMetadata, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return pathMetadata{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return pathMetadata{}, errors.New("bootstrap path is not a safe directory")
	}
	return pathMetadata{path: path, uid: stat.Uid, gid: stat.Gid, mode: info.Mode(), previously: true}, nil
}

func ensureBootstrapDirectoryTracked(path string, mode os.FileMode, changes *BootstrapPathChanges) error {
	current := string(filepath.Separator)
	parts := strings.Split(strings.TrimPrefix(path, current), current)
	for index, part := range parts {
		if part == "" || part == "." || part == ".." {
			return errors.New("bootstrap directory contains an invalid component")
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			createMode := os.FileMode(0o755)
			if index == len(parts)-1 {
				createMode = mode
			}
			if err := os.Mkdir(current, createMode); err != nil {
				return err
			}
			changes.created = append(changes.created, current)
			info, err = os.Lstat(current)
		}
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("bootstrap directory ancestry is unsafe")
		}
	}
	return nil
}

func (changes *BootstrapPathChanges) Rollback() error {
	if changes == nil || changes.finished {
		return nil
	}
	var failures []error
	for index := len(changes.metadata) - 1; index >= 0; index-- {
		metadata := changes.metadata[index]
		if !metadata.previously {
			continue
		}
		failures = append(failures, os.Chown(metadata.path, int(metadata.uid), int(metadata.gid)))
		failures = append(failures, os.Chmod(metadata.path, metadata.mode))
	}
	for index := len(changes.created) - 1; index >= 0; index-- {
		failures = append(failures, os.Remove(changes.created[index]))
	}
	result := errors.Join(failures...)
	if result == nil {
		changes.finished = true
	}
	return result
}

func (changes *BootstrapPathChanges) Commit() {
	if changes != nil {
		changes.finished = true
	}
}
