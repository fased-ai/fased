package admintransport

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestInspectControlAndOperatorSocket(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "signerd.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	control, err := InspectControlSocket(path)
	if err != nil {
		t.Fatalf("inspect private control socket: %v", err)
	}
	if control.Path() != path || control.OwnerUID() < 0 {
		t.Fatalf("unexpected inspected control socket: path=%q owner=%d", control.Path(), control.OwnerUID())
	}
	if err := os.Chmod(path, 0o660); err != nil {
		t.Fatal(err)
	}
	if _, err := InspectControlSocket(path); err == nil || !strings.Contains(err.Error(), "group/world") {
		t.Fatalf("expected accessible control socket rejection, got %v", err)
	}
	operator, err := InspectOperatorSocket(path)
	if err != nil {
		t.Fatalf("inspect group operator socket: %v", err)
	}
	if operator.Path() != path || operator.OwnerUID() != control.OwnerUID() {
		t.Fatalf("unexpected inspected operator socket: path=%q owner=%d", operator.Path(), operator.OwnerUID())
	}
	regular := filepath.Join(directory, "regular")
	if err := os.WriteFile(regular, []byte("not a socket"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := InspectOperatorSocket(regular); err == nil || !strings.Contains(err.Error(), "Unix socket") {
		t.Fatalf("expected regular-file operator rejection, got %v", err)
	}
}

func TestListenUnixSocketLifecycleAndStalePathSafety(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "runtime")
	path := filepath.Join(directory, "signerd.sock")
	listener, err := ListenUnixSocket(path, 0o600, "")
	if err != nil {
		t.Fatalf("create private listener: %v", err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 {
		t.Fatalf("unexpected listener mode: %v", info.Mode())
	}
	if err := listener.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("listener path survived close: %v", err)
	}
	if err := os.WriteFile(path, []byte("regular"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ListenUnixSocket(path, 0o600, ""); err == nil || !strings.Contains(err.Error(), "refusing to replace") {
		t.Fatalf("expected regular stale path rejection, got %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	stale.SetUnlinkOnClose(false)
	if err := stale.Close(); err != nil {
		t.Fatal(err)
	}
	replacement, err := ListenUnixSocket(path, 0o600, "")
	if err != nil {
		t.Fatalf("replace owned stale socket: %v", err)
	}
	defer replacement.Close()
}

func TestPrepareSocketDirectorySupportsSharedGroups(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "runtime")
	path := filepath.Join(directory, "signerd.sock")
	if err := prepareSocketDirectory(path, os.Getegid()); err != nil {
		t.Fatalf("prepare first socket directory: %v", err)
	}
	if err := prepareSocketDirectory(path, os.Getegid()+1); err != nil {
		t.Fatalf("prepare second socket directory: %v", err)
	}
	info, err := os.Lstat(directory)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o711 {
		t.Fatalf("shared socket directory mode = %04o, want 0711", info.Mode().Perm())
	}
}

func TestRequirePeerCredential(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("Unix peer credentials are intentionally fail-closed on this platform")
	}
	path := filepath.Join(t.TempDir(), "peer.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, _ := listener.Accept()
		accepted <- conn
	}()
	client, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server := <-accepted
	defer server.Close()
	credential, err := RequirePeerCredential(server, os.Geteuid())
	if err != nil || !credential.Proven || credential.UID != os.Geteuid() {
		t.Fatalf("peer credentials were not proven: credential=%#v err=%v", credential, err)
	}
	if os.Geteuid() != 0 {
		if _, err := RequirePeerCredential(server, os.Geteuid()+1); err == nil || !strings.Contains(err.Error(), "not authorized") {
			t.Fatalf("unexpected peer authorization result: %v", err)
		}
	}
}

func TestExchangeHandsOffRawResponseAndBoundsRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "admin.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			done <- acceptErr
			return
		}
		defer conn.Close()
		line, readErr := bufio.NewReader(conn).ReadBytes('\n')
		if readErr != nil {
			done <- readErr
			return
		}
		if string(line) != `{"op":"health"}`+"\n" {
			done <- errors.New("unexpected request bytes")
			return
		}
		_, writeErr := conn.Write([]byte(`{"ok":true,"result":{},"unknown":true}` + "\n"))
		done <- writeErr
	}()
	socket, err := InspectControlSocket(path)
	if err != nil {
		t.Fatal(err)
	}
	response, err := Exchange(socket, []byte(`{"op":"health"}`+"\n"))
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if got, want := string(response), `{"ok":true,"result":{},"unknown":true}`; got != want {
		t.Fatalf("raw response handoff = %q, want %q", got, want)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := ReadLine(bufio.NewReader(strings.NewReader(strings.Repeat("x", MaxResponseBytes+1)+"\n")), MaxResponseBytes); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("oversized response error = %v, want frame limit", err)
	}
}

func TestExchangePreservesReadTimeoutStage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "timeout.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, _ := listener.Accept()
		accepted <- conn
	}()
	socket, err := InspectControlSocket(path)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		conn := <-accepted
		defer conn.Close()
		_, _ = bufio.NewReader(conn).ReadBytes('\n')
		_, _ = io.Copy(io.Discard, conn)
	}()
	_, err = exchange(socket, []byte("{}\n"), 25*time.Millisecond)
	if stage, ok := StageOf(err); !ok || stage != ExchangeRead {
		t.Fatalf("timeout stage = %q ok=%t err=%v, want read", stage, ok, err)
	}
}

func TestWriteAllCompletesPartialWrites(t *testing.T) {
	writer := &chunkWriter{size: 2}
	if err := WriteAll(writer, []byte("abcdef")); err != nil {
		t.Fatalf("complete partial write: %v", err)
	}
	if got := writer.String(); got != "abcdef" {
		t.Fatalf("written bytes = %q, want complete frame", got)
	}
	if err := WriteAll(&chunkWriter{}, []byte("x")); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("zero-length write error = %v, want short write", err)
	}
}

type chunkWriter struct {
	bytes.Buffer
	size int
}

func (writer *chunkWriter) Write(data []byte) (int, error) {
	if writer.size == 0 {
		return 0, nil
	}
	if len(data) > writer.size {
		data = data[:writer.size]
	}
	return writer.Buffer.Write(data)
}
