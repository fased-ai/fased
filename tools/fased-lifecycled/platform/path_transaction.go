package platform

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type BootstrapPathRemovalError struct {
	Path string
	Err  error
}

func (failure *BootstrapPathRemovalError) Error() string {
	return fmt.Sprintf("remove bootstrap-created path %s: %v", failure.Path, failure.Err)
}

func (failure *BootstrapPathRemovalError) Unwrap() error { return failure.Err }

type pathMetadata struct {
	path       string
	uid, gid   uint32
	mode       os.FileMode
	previously bool
}

type createdBootstrapPath struct {
	path     string
	identity os.FileInfo
}

type CreatedBootstrapRoot struct {
	createdBootstrapPath
}

func (root CreatedBootstrapRoot) Path() string { return root.path }

func (root CreatedBootstrapRoot) RemoveAllIfSame() error {
	info, err := os.Lstat(root.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || root.identity == nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !os.SameFile(root.identity, info) {
		return fmt.Errorf("bootstrap-created root identity changed before cleanup: %s", root.path)
	}
	return os.RemoveAll(root.path)
}

type BootstrapPathChanges struct {
	metadata []pathMetadata
	created  []createdBootstrapPath
	finished bool
}

func (changes *BootstrapPathChanges) CreatedRoot(path string) (CreatedBootstrapRoot, bool) {
	if changes == nil {
		return CreatedBootstrapRoot{}, false
	}
	for _, created := range changes.created {
		if created.path == path {
			return CreatedBootstrapRoot{createdBootstrapPath: created}, true
		}
	}
	return CreatedBootstrapRoot{}, false
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
			// Bootstrap runs with a restrictive root umask. Apply the intended
			// mode explicitly so newly-created traversal ancestors do not become
			// root-only and strand the unprivileged Gateway and signer services.
			if err := os.Chmod(current, createMode); err != nil {
				return err
			}
			info, err = os.Lstat(current)
			if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return errors.New("bootstrap-created directory identity is unsafe")
			}
			changes.created = append(changes.created, createdBootstrapPath{path: current, identity: info})
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
		created := changes.created[index]
		if err := os.Remove(created.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, &BootstrapPathRemovalError{Path: created.path, Err: err})
		}
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
