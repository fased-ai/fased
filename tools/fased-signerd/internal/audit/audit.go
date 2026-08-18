// Package audit owns durable signer audit-log persistence.
package audit

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ErrPathRequired is returned when durable audit logging has no configured path.
var ErrPathRequired = errors.New("signer audit log path is required")

// Health is the signer audit health payload.
type Health struct {
	Configured bool   `json:"configured"`
	Healthy    bool   `json:"healthy"`
	LastError  string `json:"lastError,omitempty"`
}

type auditFile interface {
	Write([]byte) (int, error)
	Sync() error
	Close() error
}

// Writer appends compact JSONL records and retains the latest persistence health.
type Writer struct {
	path      string
	maxBytes  int64
	onFailure func(string)

	mu      sync.Mutex
	failed  bool
	lastErr string

	marshal  func(any) ([]byte, error)
	mkdirAll func(string, os.FileMode) error
	stat     func(string) (os.FileInfo, error)
	remove   func(string) error
	rename   func(string, string) error
	openFile func(string, int, os.FileMode) (auditFile, error)
}

// New constructs a durable audit writer. onFailure receives only safe error text.
func New(path string, maxBytes int64, onFailure func(string)) *Writer {
	return &Writer{
		path:      path,
		maxBytes:  maxBytes,
		onFailure: onFailure,
		marshal:   json.Marshal,
		mkdirAll:  os.MkdirAll,
		stat:      os.Stat,
		remove:    os.Remove,
		rename:    os.Rename,
		openFile: func(name string, flag int, perm os.FileMode) (auditFile, error) {
			return os.OpenFile(name, flag, perm)
		},
	}
}

// Health returns the current audit persistence health. A nil writer is healthy.
func (w *Writer) Health() Health {
	if w == nil {
		return Health{Healthy: true}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return Health{Configured: w.path != "", Healthy: !w.failed, LastError: w.lastErr}
}

// Write records an audit entry and intentionally leaves non-required failures non-fatal.
func (w *Writer) Write(entry map[string]any) {
	_ = w.WriteRequired(entry)
}

// WriteRequired durably appends one compact JSON object followed by one newline.
func (w *Writer) WriteRequired(entry map[string]any) error {
	if w == nil {
		return ErrPathRequired
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.path == "" {
		w.recordFailure(ErrPathRequired)
		return ErrPathRequired
	}
	data, err := w.marshal(entry)
	if err != nil {
		w.recordFailure(err)
		return err
	}
	if err := w.mkdirAll(filepath.Dir(w.path), 0o700); err != nil {
		w.recordFailure(err)
		return err
	}
	if stat, err := w.stat(w.path); err == nil && stat.Size() >= w.maxBytes && w.maxBytes > 0 {
		rotated := w.path + ".1"
		if err := w.remove(rotated); err != nil && !errors.Is(err, os.ErrNotExist) {
			w.recordFailure(err)
			return err
		}
		if err := w.rename(w.path, rotated); err != nil {
			w.recordFailure(err)
			return err
		}
	}
	file, err := w.openFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		w.recordFailure(err)
		return err
	}
	if _, err := file.Write(append(data, '\n')); err != nil {
		_ = file.Close()
		w.recordFailure(err)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		w.recordFailure(err)
		return err
	}
	if err := file.Close(); err != nil {
		w.recordFailure(err)
		return err
	}
	w.failed = false
	w.lastErr = ""
	return nil
}

func (w *Writer) recordFailure(err error) {
	w.failed = true
	w.lastErr = safeError(err)
	if w.onFailure != nil {
		w.onFailure(w.lastErr)
	}
}

func safeError(err error) string {
	if err == nil {
		return "operation failed"
	}
	message := strings.TrimSpace(err.Error())
	if len(message) > 240 {
		return message[:240]
	}
	return message
}
