package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSignerSocketListenerCompatibilityDelegate(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "signer", "app.sock")
	listener, err := listenUnixSocketV2(socketPath, 0o600, "")
	if err != nil {
		t.Fatalf("listen on signer application socket: %v", err)
	}
	info, err := os.Lstat(socketPath)
	if err != nil {
		t.Fatalf("inspect signer application socket: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("signer application socket mode = %04o, want 0600", info.Mode().Perm())
	}
	if err := listener.Close(); err != nil {
		t.Fatalf("close signer application socket: %v", err)
	}
	if _, err := os.Lstat(socketPath); !os.IsNotExist(err) {
		t.Fatalf("signer application socket remained after close: %v", err)
	}
}
