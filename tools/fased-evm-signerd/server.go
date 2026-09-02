package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const maxRequestBytes = 16 << 10

type socketRequest struct {
	ID   string `json:"id"`
	Op   string `json:"op"`
	Role string `json:"role,omitempty"`
}

type socketResponse struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

func serveSocket(store *walletStore, socketPath string) error {
	socketPath = filepath.Clean(socketPath)
	if info, err := os.Lstat(socketPath); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("refusing to replace non-socket application path")
		}
		if err := requireOwnerSocket(info); err != nil {
			return err
		}
		if connection, err := net.DialTimeout("unix", socketPath, 250*time.Millisecond); err == nil {
			_ = connection.Close()
			return errors.New("an EVM signer is already listening on the application socket")
		}
		if err := os.Remove(socketPath); err != nil {
			return fmt.Errorf("remove stale EVM signer socket: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return err
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on EVM signer socket: %w", err)
	}
	defer listener.Close()
	defer os.Remove(socketPath)
	if err := os.Chmod(socketPath, 0o600); err != nil {
		return err
	}
	for {
		connection, err := listener.Accept()
		if err != nil {
			return err
		}
		go handleConnection(store, connection)
	}
}

func handleConnection(store *walletStore, connection net.Conn) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	reader := bufio.NewReader(io.LimitReader(connection, maxRequestBytes+1))
	line, err := reader.ReadBytes('\n')
	if err != nil || len(line) > maxRequestBytes {
		_ = json.NewEncoder(connection).Encode(socketResponse{OK: false, Error: "invalid or oversized request"})
		return
	}
	var request socketRequest
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || request.ID == "" || decoder.Decode(&struct{}{}) != io.EOF {
		_ = json.NewEncoder(connection).Encode(socketResponse{OK: false, Error: "invalid strict request"})
		return
	}
	response := socketResponse{ID: request.ID, OK: true}
	switch request.Op {
	case "health":
		response.Result = map[string]any{"status": "ready", "execution": "deny-all"}
	case "capabilities":
		response.Result = denyAllPolicy()
	case "wallet.list":
		wallets, err := store.list()
		if err != nil {
			response.OK, response.Error = false, err.Error()
		} else {
			response.Result = wallets
		}
	case "wallet.get":
		record, err := store.get(request.Role)
		if err != nil {
			response.OK, response.Error = false, err.Error()
		} else {
			response.Result = record.public()
		}
	default:
		response.OK, response.Error = false, "operation is not exposed by the deny-all EVM signer"
	}
	_ = json.NewEncoder(connection).Encode(response)
}

func newBoundedReader(raw []byte) io.Reader { return bytes.NewReader(raw) }

func requireOwnerSocket(info os.FileInfo) error {
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("existing EVM signer socket must not be group/world accessible")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("existing EVM signer socket must be owned by uid %d", os.Geteuid())
	}
	return nil
}
