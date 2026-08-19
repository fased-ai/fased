package hostsecurity

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
)

type MutationLock struct {
	file      *os.File
	inherited bool
}

func AcquireMutationLock(path string, expectedUID uint32) (*MutationLock, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
		return nil, errors.New("Hosting security lock path is unsafe")
	}
	descriptor, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(descriptor), path)
	fail := func(err error) (*MutationLock, error) {
		_ = file.Close()
		return nil, err
	}
	var stat syscall.Stat_t
	if err := syscall.Fstat(descriptor, &stat); err != nil {
		return fail(err)
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Mode&0o777 != 0o600 || stat.Uid != expectedUID || stat.Nlink != 1 {
		return fail(errors.New("Hosting security lock file is unsafe"))
	}
	if err := syscall.Flock(descriptor, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return fail(errors.New("another Hosting security transaction is active"))
		}
		return fail(err)
	}
	return &MutationLock{file: file}, nil
}

func (lock *MutationLock) Release() error {
	if lock == nil || lock.file == nil {
		return nil
	}
	file := lock.file
	lock.file = nil
	if lock.inherited {
		return file.Close()
	}
	return errors.Join(syscall.Flock(int(file.Fd()), syscall.LOCK_UN), file.Close())
}

// DupForChild duplicates the locked open-file description for a trusted child
// process. The caller retains its lease; closing the duplicate cannot unlock
// it. It is a capability handoff, not a second acquisition attempt.
func (lock *MutationLock) DupForChild() (*os.File, error) {
	if lock == nil || lock.file == nil {
		return nil, errors.New("mutation lock is unavailable for child handoff")
	}
	descriptor, err := syscall.Dup(int(lock.file.Fd()))
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(descriptor), lock.file.Name()), nil
}

// AdoptMutationLock accepts only the fixed inherited descriptor used by the
// bootstrap-to-lifecycle-host handoff. The descriptor is the already-locked
// open-file description duplicated by DupForChild; it is not a path-based
// unlock/relock attempt.
func AdoptMutationLock(descriptor int, path string, expectedUID uint32) (*MutationLock, error) {
	if descriptor != 3 || !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
		return nil, errors.New("mutation lock handoff is invalid")
	}
	if runtime.GOOS == "linux" {
		linkedPath, err := os.Readlink(filepath.Join("/proc/self/fd", strconv.Itoa(descriptor)))
		if err != nil || linkedPath != path {
			return nil, errors.New("mutation lock handoff differs from the expected lock")
		}
	} else if runtime.GOOS != "darwin" {
		return nil, errors.New("mutation lock handoff is unsupported")
	}
	var stat syscall.Stat_t
	if err := syscall.Fstat(descriptor, &stat); err != nil || stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Mode&0o777 != 0o600 || stat.Uid != expectedUID || stat.Nlink != 1 {
		return nil, errors.New("mutation lock handoff is unsafe")
	}
	if err := syscall.Flock(descriptor, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, errors.New("mutation lock handoff is not locked")
	}
	return &MutationLock{file: os.NewFile(uintptr(descriptor), path), inherited: true}, nil
}
