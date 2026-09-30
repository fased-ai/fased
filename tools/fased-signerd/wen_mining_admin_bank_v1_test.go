package main

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func runMiningAdminBankSocket(t *testing.T, s *signerServiceV2, cfg signerConfig, body wenMiningReviewInstallV1, control bool) (wenMiningReviewReceiptV1, error) {
	return runMiningAdminBankSocketOperation(t, s, cfg, body, control, "install-reveal-review", "v2.wenMining.review.install")
}
func runMiningAdminBankSocketOperation(t *testing.T, s *signerServiceV2, cfg signerConfig, body any, control bool, command, operation string) (wenMiningReviewReceiptV1, error) {
	t.Helper()
	var out wenMiningReviewReceiptV1
	dir := signerAdminShortTempDir(t)
	socket := filepath.Join(dir, "control.sock")
	listener, e := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	if e = os.Chmod(socket, 0600); e != nil {
		t.Fatal(e)
	}
	listener.SetDeadline(time.Now().Add(10 * time.Second))
	done := make(chan error, 1)
	go func() {
		conn, e := listener.Accept()
		if e != nil {
			done <- e
			return
		}
		handleConn(conn, cfg, newRateLimiter(time.Minute, map[string]int{operation: 2}), &auditWriter{path: filepath.Join(dir, "audit.jsonl"), maxBytes: 1048576}, s, control)
		done <- nil
	}()
	raw, _ := json.Marshal(body)
	var stdout bytes.Buffer
	e = runSignerAdminCLI([]string{"wen-mining", command, "--control-socket", socket, "--wallet-id", "bank_test"}, bytes.NewReader(raw), &stdout, nil)
	select {
	case serverErr := <-done:
		if serverErr != nil {
			t.Fatal(serverErr)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("mining control socket stalled")
	}
	if e != nil {
		if stdout.Len() != 0 {
			t.Fatal("failure emitted receipt")
		}
		return out, e
	}
	if e = json.Unmarshal(stdout.Bytes(), &out); e != nil {
		t.Fatal(e)
	}
	t.Log("PASS: actual owner CLI -> Unix socket -> handleConn -> mining installer -> compiled-bank RPC -> bound receipt")
	return out, nil
}

func runMiningPreimageBankSocket(t *testing.T, s *signerServiceV2, cfg signerConfig, body any, control bool, command, operation string) (wenMiningPreimageReceiptV1, error) {
	t.Helper()
	var out wenMiningPreimageReceiptV1
	dir := signerAdminShortTempDir(t)
	socket := filepath.Join(dir, "control.sock")
	listener, e := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	if e = os.Chmod(socket, 0600); e != nil {
		t.Fatal(e)
	}
	listener.SetDeadline(time.Now().Add(10 * time.Second))
	done := make(chan error, 1)
	go func() {
		conn, e := listener.Accept()
		if e != nil {
			done <- e
			return
		}
		handleConn(conn, cfg, newRateLimiter(time.Minute, map[string]int{operation: 2}), &auditWriter{path: filepath.Join(dir, "audit.jsonl"), maxBytes: 1048576}, s, control)
		done <- nil
	}()
	raw, _ := json.Marshal(body)
	var stdout bytes.Buffer
	e = runSignerAdminCLI([]string{"wen-mining", command, "--control-socket", socket, "--wallet-id", "bank_test"}, bytes.NewReader(raw), &stdout, nil)
	select {
	case serverErr := <-done:
		if serverErr != nil {
			t.Fatal(serverErr)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("mining control socket stalled")
	}
	if e != nil {
		if stdout.Len() != 0 {
			t.Fatal("failure emitted receipt")
		}
		return out, e
	}
	if e = json.Unmarshal(stdout.Bytes(), &out); e != nil {
		t.Fatal(e)
	}
	t.Log("PASS: actual owner CLI -> Unix socket -> handleConn -> mining installer -> compiled-bank RPC -> bound receipt")
	return out, nil
}
