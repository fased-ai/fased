package hostsecurity

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

const maxSystemLogBytes = 8 << 20

type boundedSystemLog struct {
	file      *os.File
	remaining int64
}

func (log *boundedSystemLog) Write(data []byte) (int, error) {
	if log == nil || log.file == nil || log.remaining <= 0 {
		return 0, errors.New("Hosting security log exceeded its bound")
	}
	if int64(len(data)) > log.remaining {
		written, err := log.file.Write(data[:log.remaining])
		log.remaining -= int64(written)
		return written, errors.Join(err, errors.New("Hosting security log exceeded its bound"))
	}
	written, err := log.file.Write(data)
	log.remaining -= int64(written)
	return written, err
}

func (log *boundedSystemLog) Close() error {
	if log == nil || log.file == nil {
		return nil
	}
	file := log.file
	log.file = nil
	return errors.Join(file.Sync(), file.Close())
}

func OpenSystemLog() (io.WriteCloser, error) {
	const directory = "/var/log/fased"
	const path = directory + "/hosting-security.log"
	return openBoundedSystemLog(directory, path, 0, maxSystemLogBytes)
}

func openBoundedSystemLog(directory, path string, expectedUID uint32, limit int64) (io.WriteCloser, error) {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory || filepath.Dir(path) != directory || limit <= 0 {
		return nil, errors.New("Hosting security log path is unsafe")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	directoryInfo, err := os.Lstat(directory)
	if err != nil {
		return nil, err
	}
	directoryStat, statOK := directoryInfo.Sys().(*syscall.Stat_t)
	if !statOK || !directoryInfo.IsDir() || directoryInfo.Mode()&os.ModeSymlink != 0 || directoryInfo.Mode().Perm() != 0o700 || directoryStat.Uid != expectedUID {
		return nil, errors.New("Hosting security log directory is unsafe")
	}
	if info, err := os.Lstat(path); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 || stat.Uid != expectedUID || stat.Nlink != 1 {
			return nil, errors.New("Hosting security log is unsafe")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	descriptor, err := syscall.Open(path, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(descriptor), path)
	var opened syscall.Stat_t
	if err := syscall.Fstat(descriptor, &opened); err != nil || opened.Mode&syscall.S_IFMT != syscall.S_IFREG || opened.Uid != expectedUID || opened.Nlink != 1 {
		file.Close()
		return nil, errors.Join(err, errors.New("opened Hosting security log is unsafe"))
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return nil, err
	}
	if err := file.Truncate(0); err != nil {
		file.Close()
		return nil, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		file.Close()
		return nil, err
	}
	return &boundedSystemLog{file: file, remaining: limit}, nil
}
