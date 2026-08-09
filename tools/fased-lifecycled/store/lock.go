package store

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"syscall"
)

var lockTransactionPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// UpdateLock is the process-scoped exclusive mutation lease for one
// installation. The kernel releases it if the owner crashes; durable journals
// determine recovery on the next request.
type UpdateLock struct {
	file *os.File
}

type MutationLock interface {
	Release() error
}

func (s *Store) AcquireUpdateLock(transactionID string) (MutationLock, error) {
	if !lockTransactionPattern.MatchString(transactionID) {
		return nil, errors.New("update lock transaction id is invalid")
	}
	path := s.stateRoot + string(os.PathSeparator) + "update.lock"
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		file.Close()
		return nil, errors.New("update lock is not a secure regular file")
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, errors.New("another lifecycle transaction is active")
		}
		return nil, fmt.Errorf("acquire lifecycle update lock: %w", err)
	}
	if err := file.Truncate(0); err != nil {
		file.Close()
		return nil, err
	}
	if _, err := file.WriteString(transactionID + "\n"); err != nil {
		file.Close()
		return nil, err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return nil, err
	}
	return &UpdateLock{file: file}, nil
}

func (lock *UpdateLock) Release() error {
	if lock == nil || lock.file == nil {
		return nil
	}
	file := lock.file
	lock.file = nil
	unlockErr := syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	return errors.Join(unlockErr, file.Close())
}
