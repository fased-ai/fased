package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testStore(t *testing.T) (*walletStore, string, string) {
	t.Helper()
	directory := t.TempDir()
	state := filepath.Join(directory, "state", "evm.db")
	master := filepath.Join(directory, "keys", "evm.master")
	if err := initializeStore(state, master); err != nil {
		t.Fatal(err)
	}
	store, err := openStore(state, master)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.close() })
	return store, state, master
}

func TestKnownEthereumAddressAndRoleIsolation(t *testing.T) {
	knownSecret := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" // pragma: allowlist secret
	secret, _ := hex.DecodeString(knownSecret)
	defer zeroBytes(secret)
	address, err := addressFromPrivateKey(secret)
	if err != nil {
		t.Fatal(err)
	}
	if address != "0xFCAd0B19bB29D4674531d6f115237E16AfCE377c" {
		t.Fatalf("address = %s", address)
	}
	store, state, _ := testStore(t)
	agent, err := store.create(roleAgentService, secret)
	if err != nil {
		t.Fatal(err)
	}
	if agent.Policy.Mode != "deny-all" || agent.Policy.CanSignTransactions || agent.Policy.CanApproveTokens || agent.Policy.CanTrade {
		t.Fatalf("wallet did not start deny-all: %#v", agent.Policy)
	}
	if _, err := store.create(roleAgentService, secret); err == nil {
		t.Fatal("duplicate active role was accepted")
	}
	strategySecret, _ := generatePrivateKey()
	defer zeroBytes(strategySecret)
	strategy, err := store.create(roleStrategy, strategySecret)
	if err != nil {
		t.Fatal(err)
	}
	if strategy.Address == agent.Address {
		t.Fatal("agent-service and strategy namespaces reused one key")
	}
	raw, err := os.ReadFile(state)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), hex.EncodeToString(secret)) || strings.Contains(string(raw), hex.EncodeToString(strategySecret)) {
		t.Fatal("state database exposed a plaintext EVM private key")
	}
}

func TestRecoveryRoundTripTamperAndWrongPassword(t *testing.T) {
	store, _, _ := testStore(t)
	secret, _ := generatePrivateKey()
	defer zeroBytes(secret)
	wallet, err := store.create(roleAgentService, secret)
	if err != nil {
		t.Fatal(err)
	}
	record, _ := store.get(roleAgentService)
	password := []byte("correct horse battery staple")
	pkg, err := makeRecoveryPackage(record, secret, password)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := openRecoveryPackage(pkg, password)
	if err != nil {
		t.Fatal(err)
	}
	defer zeroBytes(restored)
	address, _ := addressFromPrivateKey(restored)
	if address != wallet.Address {
		t.Fatalf("restored address = %s", address)
	}
	if _, err := openRecoveryPackage(pkg, []byte("wrong password long enough")); err == nil {
		t.Fatal("wrong password was accepted")
	}
	pkg.Address = "0x0000000000000000000000000000000000000000"
	if _, err := openRecoveryPackage(pkg, password); err == nil {
		t.Fatal("modified package was accepted")
	}

	cleanPackage, _ := makeRecoveryPackage(record, secret, password)
	newDirectory := t.TempDir()
	newState := filepath.Join(newDirectory, "state", "evm.db")
	newMaster := filepath.Join(newDirectory, "keys", "evm.master")
	if err := initializeStore(newState, newMaster); err != nil {
		t.Fatal(err)
	}
	newStore, err := openStore(newState, newMaster)
	if err != nil {
		t.Fatal(err)
	}
	defer newStore.close()
	restoredWallet, err := newStore.restore(cleanPackage, secret)
	if err != nil || restoredWallet.Address != wallet.Address || restoredWallet.Generation != wallet.Generation {
		t.Fatalf("restored wallet = %#v, %v", restoredWallet, err)
	}
}

func TestRevocationIsGenerationChecked(t *testing.T) {
	store, _, _ := testStore(t)
	secret, _ := generatePrivateKey()
	defer zeroBytes(secret)
	wallet, _ := store.create(roleStrategy, secret)
	if _, err := store.revoke(roleStrategy, wallet.Generation+1); err == nil {
		t.Fatal("stale generation revocation was accepted")
	}
	revoked, err := store.revoke(roleStrategy, wallet.Generation)
	if err != nil || revoked.Active {
		t.Fatalf("revoke = %#v, %v", revoked, err)
	}
	nextSecret, _ := generatePrivateKey()
	defer zeroBytes(nextSecret)
	next, err := store.create(roleStrategy, nextSecret)
	if err != nil || next.Generation != wallet.Generation+1 {
		t.Fatalf("replacement = %#v, %v", next, err)
	}
}

func TestSocketExposesReadOnlyDenyAllSurface(t *testing.T) {
	store, _, _ := testStore(t)
	secret, _ := generatePrivateKey()
	defer zeroBytes(secret)
	_, _ = store.create(roleStrategy, secret)
	socket := filepath.Join(t.TempDir(), "runtime", "evm.sock")
	done := make(chan error, 1)
	go func() { done <- serveSocket(store, socket) }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Lstat(socket); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("socket server stopped before readiness: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("socket did not appear")
		}
		time.Sleep(5 * time.Millisecond)
	}
	info, _ := os.Stat(socket)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode = %o", info.Mode().Perm())
	}
	if err := serveSocket(store, socket); err == nil || !strings.Contains(err.Error(), "already listening") {
		t.Fatalf("second server did not preserve the active socket: %v", err)
	}
	response := socketCall(t, socket, `{"id":"1","op":"wallet.get","role":"strategy"}`)
	if !response.OK {
		t.Fatalf("read-only wallet readback failed: %#v", response)
	}
	for _, operation := range []string{"sign", "transaction.sign", "erc20.approve", "transfer", "swap", "venue.open"} {
		response = socketCall(t, socket, `{"id":"2","op":"`+operation+`"}`)
		if response.OK || !strings.Contains(response.Error, "deny-all") {
			t.Fatalf("operation %s was not denied: %#v", operation, response)
		}
	}
}

func socketCall(t *testing.T, socket, request string) socketResponse {
	t.Helper()
	connection, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_, _ = connection.Write([]byte(request + "\n"))
	var response socketResponse
	if err := json.NewDecoder(bufio.NewReader(connection)).Decode(&response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestRawExportRequiresAcknowledgementAndOwnerOnlyOutput(t *testing.T) {
	directory := t.TempDir()
	state := filepath.Join(directory, "state", "evm.db")
	master := filepath.Join(directory, "keys", "evm.master")
	if err := initializeStore(state, master); err != nil {
		t.Fatal(err)
	}
	store, err := openStore(state, master)
	if err != nil {
		t.Fatal(err)
	}
	secret, _ := generatePrivateKey()
	_, _ = store.create(roleAgentService, secret)
	zeroBytes(secret)
	_ = store.close()
	output := filepath.Join(t.TempDir(), "raw.key")
	base := []string{"raw-export", "--state", state, "--master-key", master, "--role", roleAgentService, "--expected-generation", "1", "--output", output}
	if err := run(base); err == nil {
		t.Fatal("raw export without acknowledgement was accepted")
	}
	if err := run(append(base, "--acknowledge-custody-reduction")); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(output)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("raw export mode = %o", info.Mode().Perm())
	}
	if raw, _ := os.ReadFile(output); !strings.HasPrefix(string(raw), "0x") || len(strings.TrimSpace(string(raw))) != 66 {
		t.Fatal("raw export is not Solana-independent EVM hex")
	}
}

func TestPrivateKeyImportRequiresOwnerOnlyExactHex(t *testing.T) {
	path := filepath.Join(t.TempDir(), "import.key")
	generated, err := generatePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	defer zeroBytes(generated)
	raw := make([]byte, 2+hex.EncodedLen(len(generated))+1)
	copy(raw, "0x")
	hex.Encode(raw[2:len(raw)-1], generated)
	raw[len(raw)-1] = '\n'
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	zeroBytes(raw)
	secret, err := readHexPrivateKey(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zeroBytes(secret)
	if len(secret) != privateKeyBytes {
		t.Fatalf("secret length = %d", len(secret))
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readHexPrivateKey(path); err == nil {
		t.Fatal("group/world-readable private-key import was accepted")
	}
}
