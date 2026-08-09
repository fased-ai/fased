package platform

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

type FileReplacement struct {
	Path       string
	Previous   []byte
	Mode       os.FileMode
	UID, GID   uint32
	Previously bool
	finished   bool
}

func InstallFileTransactional(path string, data []byte, mode os.FileMode, uid, gid uint32) (*FileReplacement, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" || len(data) == 0 || mode.Perm()&0o022 != 0 {
		return nil, errors.New("transactional file installation is invalid")
	}
	replacement := &FileReplacement{Path: path}
	if info, err := os.Lstat(path); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 {
			return nil, errors.New("existing transactional file is unsafe")
		}
		previous, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		replacement.Previous, replacement.Mode = previous, info.Mode()
		replacement.UID, replacement.GID, replacement.Previously = stat.Uid, stat.Gid, true
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := writeAtomicFile(path, data, mode); err != nil {
		return nil, err
	}
	if err := os.Chown(path, int(uid), int(gid)); err != nil {
		return nil, errors.Join(err, replacement.Rollback())
	}
	if err := os.Chmod(path, mode); err != nil {
		return nil, errors.Join(err, replacement.Rollback())
	}
	return replacement, nil
}

func (replacement *FileReplacement) Rollback() error {
	if replacement == nil || replacement.finished {
		return nil
	}
	if !replacement.Previously {
		if err := os.Remove(replacement.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		replacement.finished = true
		return nil
	}
	if err := writeAtomicFile(replacement.Path, replacement.Previous, replacement.Mode); err != nil {
		return err
	}
	if err := os.Chown(replacement.Path, int(replacement.UID), int(replacement.GID)); err != nil {
		return err
	}
	if err := os.Chmod(replacement.Path, replacement.Mode); err != nil {
		return err
	}
	replacement.finished = true
	return nil
}

func (replacement *FileReplacement) Commit() {
	if replacement != nil {
		replacement.finished = true
	}
}
