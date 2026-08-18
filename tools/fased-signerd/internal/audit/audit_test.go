package audit

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriterAppendsCompactJSONL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	writer := New(path, 0, nil)
	if err := writer.WriteRequired(map[string]any{"event": "first"}); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteRequired(map[string]any{"event": "second"}); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(contents), "\n")
	if len(lines) != 3 || lines[2] != "" {
		t.Fatalf("expected two JSONL records and trailing newline, got %q", contents)
	}
	for index, line := range lines[:2] {
		if strings.ContainsAny(line, " \t\r") {
			t.Fatalf("record %d is not compact JSON: %q", index, line)
		}
		var entry map[string]string
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("record %d is not JSON: %v", index, err)
		}
		if entry["event"] != []string{"first", "second"}[index] {
			t.Fatalf("record %d changed: %#v", index, entry)
		}
	}
}

func TestWriterHealthTransitionsAndSafeError(t *testing.T) {
	var nilWriter *Writer
	if health := nilWriter.Health(); health != (Health{Healthy: true}) {
		t.Fatalf("nil writer health changed: %#v", health)
	}

	var logged string
	writer := New("", 0, func(message string) { logged = message })
	if err := writer.WriteRequired(map[string]any{"event": "missing-path"}); !errors.Is(err, ErrPathRequired) || err.Error() != "signer audit log path is required" {
		t.Fatalf("unexpected empty-path error: %v", err)
	}
	if health := writer.Health(); health != (Health{Healthy: false, LastError: "signer audit log path is required"}) {
		t.Fatalf("empty-path health changed: %#v", health)
	}
	if logged != "signer audit log path is required" {
		t.Fatalf("failure callback changed: %q", logged)
	}

	path := filepath.Join(t.TempDir(), "audit.jsonl")
	writer = New(path, 0, func(message string) { logged = message })
	message := " \n" + strings.Repeat("x", 300) + "\t "
	writer.marshal = func(any) ([]byte, error) { return nil, errors.New(message) }
	if err := writer.WriteRequired(map[string]any{"event": "encode-failure"}); err == nil {
		t.Fatal("expected encode failure")
	}
	expected := strings.Repeat("x", 240)
	if health := writer.Health(); !health.Configured || health.Healthy || health.LastError != expected {
		t.Fatalf("unsafe failure health: %#v", health)
	}
	if logged != expected {
		t.Fatalf("unsafe failure callback: %q", logged)
	}

	writer.marshal = json.Marshal
	if err := writer.WriteRequired(map[string]any{"event": "recovered"}); err != nil {
		t.Fatal(err)
	}
	if health := writer.Health(); health != (Health{Configured: true, Healthy: true}) {
		t.Fatalf("successful writer health changed: %#v", health)
	}
}

func TestWriterCreatesRestrictedDirectoryAndFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "nested", "audit.jsonl")
	writer := New(path, 0, nil)
	if err := writer.WriteRequired(map[string]any{"event": "mode"}); err != nil {
		t.Fatal(err)
	}
	directory, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if directory.Mode().Perm() != 0o700 {
		t.Fatalf("directory mode = %o, want 0700", directory.Mode().Perm())
	}
	file, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if file.Mode().Perm() != 0o600 {
		t.Fatalf("file mode = %o, want 0600", file.Mode().Perm())
	}
}

func TestWriterRotatesAtThreshold(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	first, err := json.Marshal(map[string]any{"event": "first"})
	if err != nil {
		t.Fatal(err)
	}
	first = append(first, '\n')
	writer := New(path, int64(len(first)), nil)
	if err := writer.WriteRequired(map[string]any{"event": "first"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".1", []byte("stale\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteRequired(map[string]any{"event": "second"}); err != nil {
		t.Fatal(err)
	}
	rotated, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatal(err)
	}
	if string(rotated) != string(first) {
		t.Fatalf("rotated contents = %q, want %q", rotated, first)
	}
	active, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(active) != "{\"event\":\"second\"}\n" {
		t.Fatalf("active contents = %q", active)
	}
}

func TestWriterPropagatesPersistenceFailures(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	for name, configure := range map[string]func(*Writer, error){
		"encode": func(writer *Writer, want error) {
			writer.marshal = func(any) ([]byte, error) { return nil, want }
		},
		"open": func(writer *Writer, want error) {
			writer.openFile = func(string, int, os.FileMode) (auditFile, error) { return nil, want }
		},
		"write": func(writer *Writer, want error) {
			writer.openFile = func(string, int, os.FileMode) (auditFile, error) { return failingFile{writeErr: want}, nil }
		},
		"sync": func(writer *Writer, want error) {
			writer.openFile = func(string, int, os.FileMode) (auditFile, error) { return failingFile{syncErr: want}, nil }
		},
		"close": func(writer *Writer, want error) {
			writer.openFile = func(string, int, os.FileMode) (auditFile, error) { return failingFile{closeErr: want}, nil }
		},
	} {
		t.Run(name, func(t *testing.T) {
			want := errors.New(name + " failure")
			writer := New(path, 0, nil)
			configure(writer, want)
			if err := writer.WriteRequired(map[string]any{"event": name}); !errors.Is(err, want) {
				t.Fatalf("error = %v, want %v", err, want)
			}
			if health := writer.Health(); !health.Configured || health.Healthy || health.LastError != want.Error() {
				t.Fatalf("failure did not mark writer unhealthy: %#v", health)
			}
		})
	}
}

func TestWriterPropagatesRotationFailures(t *testing.T) {
	for name, configure := range map[string]func(*Writer, error){
		"remove": func(writer *Writer, want error) {
			writer.remove = func(string) error { return want }
		},
		"rename": func(writer *Writer, want error) {
			writer.remove = func(string) error { return nil }
			writer.rename = func(string, string) error { return want }
		},
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "audit.jsonl")
			if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
			want := errors.New(name + " failure")
			writer := New(path, 1, nil)
			configure(writer, want)
			if err := writer.WriteRequired(map[string]any{"event": name}); !errors.Is(err, want) {
				t.Fatalf("error = %v, want %v", err, want)
			}
			if health := writer.Health(); !health.Configured || health.Healthy || health.LastError != want.Error() {
				t.Fatalf("rotation failure did not mark writer unhealthy: %#v", health)
			}
		})
	}
}

type failingFile struct {
	writeErr error
	syncErr  error
	closeErr error
}

func (f failingFile) Write(data []byte) (int, error) {
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	return len(data), nil
}

func (f failingFile) Sync() error {
	return f.syncErr
}

func (f failingFile) Close() error {
	return f.closeErr
}
