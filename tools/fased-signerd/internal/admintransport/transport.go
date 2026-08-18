// Package admintransport owns the signer daemon's Unix administrative transport
// boundary. It deliberately accepts and returns protocol bytes without knowing
// the signer request or response schema.
package admintransport

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// MaxResponseBytes bounds one newline-framed daemon response.
	MaxResponseBytes = 1 << 20
	// ClientTimeout bounds connect, write, and response read for an admin call.
	ClientTimeout = 15 * time.Second
)

// ErrFrameTooLarge reports a bounded newline frame that exceeded its limit.
var ErrFrameTooLarge = errors.New("signer transport frame exceeds maximum size")

// InspectedSocket is an opaque result of trusted socket inspection.
type InspectedSocket struct {
	path     string
	ownerUID int
}

// Path returns the inspected Unix socket path.
func (s InspectedSocket) Path() string { return s.path }

// OwnerUID returns the inspected socket owner, or -1 where it is unavailable.
func (s InspectedSocket) OwnerUID() int { return s.ownerUID }

// InspectControlSocket validates the owner-only control socket boundary.
func InspectControlSocket(raw string) (InspectedSocket, error) {
	path := strings.TrimSpace(raw)
	if path == "" {
		return InspectedSocket{}, errors.New("--control-socket is required")
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return InspectedSocket{}, errors.New("signer admin control socket path must be absolute and clean")
	}
	parent := filepath.Dir(path)
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return InspectedSocket{}, fmt.Errorf("inspect signer control socket directory: %w", err)
	}
	if parentInfo.Mode()&os.ModeSymlink != 0 || !parentInfo.IsDir() {
		return InspectedSocket{}, errors.New("signer control socket directory must be a non-symlink directory")
	}
	if parentInfo.Mode().Perm()&0o022 != 0 {
		return InspectedSocket{}, errors.New("signer control socket directory must not be group/world writable")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return InspectedSocket{}, fmt.Errorf("inspect signer control socket: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || info.Mode()&os.ModeSocket == 0 {
		return InspectedSocket{}, errors.New("signer admin control socket must be a non-symlink Unix socket")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return InspectedSocket{}, errors.New("signer admin control socket must not be group/world accessible")
	}
	ownerUID := socketOwnerUID(info)
	if os.Geteuid() != 0 && ownerUID >= 0 && ownerUID != os.Geteuid() {
		return InspectedSocket{}, errors.New("signer admin control socket must be owned by the current user")
	}
	return InspectedSocket{path: path, ownerUID: ownerUID}, nil
}

// InspectOperatorSocket validates the restricted operator socket boundary.
func InspectOperatorSocket(raw string) (InspectedSocket, error) {
	path := strings.TrimSpace(raw)
	if path == "" {
		return InspectedSocket{}, errors.New("--operator-socket is required")
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return InspectedSocket{}, errors.New("signer operator socket path must be absolute and clean")
	}
	parentInfo, err := os.Lstat(filepath.Dir(path))
	if err != nil || parentInfo.Mode()&os.ModeSymlink != 0 || !parentInfo.IsDir() || parentInfo.Mode().Perm()&0o002 != 0 {
		return InspectedSocket{}, errors.New("signer operator socket directory must be a non-symlink directory not writable by others")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return InspectedSocket{}, fmt.Errorf("inspect signer operator socket: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || info.Mode()&os.ModeSocket == 0 {
		return InspectedSocket{}, errors.New("signer operator socket must be a non-symlink Unix socket")
	}
	if mode := info.Mode().Perm(); mode != 0o660 && mode != 0o600 {
		return InspectedSocket{}, errors.New("signer operator socket must have mode 0660 or 0600")
	}
	return InspectedSocket{path: path, ownerUID: socketOwnerUID(info)}, nil
}

func socketOwnerUID(info os.FileInfo) int {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return int(stat.Uid)
	}
	return -1
}

func resolveSocketGroup(name string) (int, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return -1, nil
	}
	group, err := user.LookupGroup(name)
	if err != nil {
		return -1, fmt.Errorf("resolve signer socket group %q: %w", name, err)
	}
	gid, err := strconv.Atoi(group.Gid)
	if err != nil || gid < 0 {
		return -1, fmt.Errorf("resolve signer socket group %q: invalid gid", name)
	}
	return gid, nil
}

func prepareSocketDirectory(socketPath string, gid int) error {
	directory := filepath.Dir(socketPath)
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		mode := os.FileMode(0o700)
		if gid >= 0 {
			mode = 0o711
		}
		if err := os.MkdirAll(directory, mode); err != nil {
			return fmt.Errorf("create signer socket directory: %w", err)
		}
		info, err = os.Lstat(directory)
	}
	if err != nil {
		return fmt.Errorf("inspect signer socket directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("signer socket directory must be a non-symlink directory")
	}
	if ownerUID := socketOwnerUID(info); ownerUID >= 0 && ownerUID != os.Geteuid() {
		return fmt.Errorf("signer socket directory must be owned by uid %d", os.Geteuid())
	}
	if gid >= 0 {
		// Sockets that intentionally use distinct groups can share this search-only
		// runtime directory; each socket mode and peer credential remains enforced.
		if err := os.Chmod(directory, 0o711); err != nil {
			return fmt.Errorf("set signer socket directory mode: %w", err)
		}
	}
	return nil
}

func removeStaleSocket(socketPath string) error {
	info, err := os.Lstat(socketPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect signer socket: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || info.Mode()&os.ModeSocket == 0 {
		return errors.New("refusing to replace a non-socket signer path")
	}
	if ownerUID := socketOwnerUID(info); ownerUID >= 0 && ownerUID != os.Geteuid() {
		return fmt.Errorf("stale signer socket must be owned by uid %d", os.Geteuid())
	}
	if err := os.Remove(socketPath); err != nil {
		return fmt.Errorf("remove stale signer socket: %w", err)
	}
	return nil
}

// ListenUnixSocket prepares a trusted Unix socket path and removes the socket
// when the returned listener closes.
func ListenUnixSocket(socketPath string, mode uint32, groupName string) (net.Listener, error) {
	if strings.TrimSpace(socketPath) == "" || !filepath.IsAbs(socketPath) {
		return nil, errors.New("signer socket path must be absolute")
	}
	gid, err := resolveSocketGroup(groupName)
	if err != nil {
		return nil, err
	}
	if gid < 0 && mode&0o070 != 0 {
		return nil, errors.New("group-accessible signer socket mode requires --socket-group")
	}
	if gid >= 0 && mode&0o060 != 0o060 {
		return nil, errors.New("--socket-group requires group read/write socket permissions")
	}
	if err := prepareSocketDirectory(socketPath, gid); err != nil {
		return nil, err
	}
	if err := removeStaleSocket(socketPath); err != nil {
		return nil, err
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, err
	}
	closeOnError := func(cause error) (net.Listener, error) {
		_ = listener.Close()
		_ = os.Remove(socketPath)
		return nil, cause
	}
	if gid >= 0 {
		if err := os.Chown(socketPath, -1, gid); err != nil {
			return closeOnError(fmt.Errorf("set signer socket group: %w", err))
		}
	}
	if err := os.Chmod(socketPath, os.FileMode(mode)); err != nil {
		return closeOnError(fmt.Errorf("set signer socket mode: %w", err))
	}
	return &socketListener{Listener: listener, path: socketPath}, nil
}

type socketListener struct {
	net.Listener
	path string
	once sync.Once
}

func (listener *socketListener) Close() error {
	var closeErr error
	listener.once.Do(func() {
		closeErr = listener.Listener.Close()
		if err := os.Remove(listener.path); err != nil && !errors.Is(err, os.ErrNotExist) && closeErr == nil {
			closeErr = err
		}
	})
	return closeErr
}

// Exchange sends one already newline-framed request and returns exactly one
// bounded newline-framed response. It deliberately leaves response semantics to
// the caller.
func Exchange(socket InspectedSocket, request []byte) ([]byte, error) {
	return exchange(socket, request, ClientTimeout)
}

type ExchangeStage string

const (
	ExchangeConnect ExchangeStage = "connect"
	ExchangeWrite   ExchangeStage = "write"
	ExchangeRead    ExchangeStage = "read"
)

// ExchangeError identifies the transport phase while preserving the source error.
type ExchangeError struct {
	Stage ExchangeStage
	Err   error
}

func (e *ExchangeError) Error() string { return e.Err.Error() }
func (e *ExchangeError) Unwrap() error { return e.Err }

// StageOf returns the stage that produced a transport error.
func StageOf(err error) (ExchangeStage, bool) {
	var transportErr *ExchangeError
	if errors.As(err, &transportErr) {
		return transportErr.Stage, true
	}
	return "", false
}

func exchange(socket InspectedSocket, request []byte, timeout time.Duration) ([]byte, error) {
	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.Dial("unix", socket.path)
	if err != nil {
		return nil, &ExchangeError{Stage: ExchangeConnect, Err: err}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if err := WriteAll(conn, request); err != nil {
		return nil, &ExchangeError{Stage: ExchangeWrite, Err: err}
	}
	response, err := ReadLine(bufio.NewReader(conn), MaxResponseBytes)
	if err != nil {
		return nil, &ExchangeError{Stage: ExchangeRead, Err: err}
	}
	return response, nil
}

// WriteAll completes a bounded transport frame or returns its write failure.
func WriteAll(writer io.Writer, data []byte) error {
	written := 0
	for written < len(data) {
		n, err := writer.Write(data[written:])
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		written += n
	}
	return nil
}

// ReadLine reads one bounded newline-framed transport message.
func ReadLine(reader *bufio.Reader, maxBytes int) ([]byte, error) {
	var result []byte
	for {
		fragment, prefix, err := reader.ReadLine()
		if err != nil {
			return nil, err
		}
		if len(result)+len(fragment) > maxBytes {
			return nil, ErrFrameTooLarge
		}
		result = append(result, fragment...)
		if !prefix {
			return result, nil
		}
	}
}

// SetReadDeadline applies a bounded server read deadline.
func SetReadDeadline(conn net.Conn, timeout time.Duration) error {
	return conn.SetReadDeadline(time.Now().Add(timeout))
}

// ClearReadDeadline restores the connection's default read deadline.
func ClearReadDeadline(conn net.Conn) error {
	return conn.SetReadDeadline(time.Time{})
}
