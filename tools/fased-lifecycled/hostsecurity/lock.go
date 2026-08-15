package hostsecurity

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

type MutationLock struct{ file *os.File }

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
	return errors.Join(syscall.Flock(int(file.Fd()), syscall.LOCK_UN), file.Close())
}
