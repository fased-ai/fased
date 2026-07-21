package main

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

type signerAdminTestServer struct {
	path     string
	requests <-chan request
	done     <-chan error
}

func signerAdminShortTempDir(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "fsadm-")
	if err != nil {
		t.Fatalf("create short signer admin test directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return directory
}

func startSignerAdminTestServer(
	t *testing.T,
	respond func(request) ([]byte, error),
) signerAdminTestServer {
	return startSignerAdminTestServerMode(t, 0o600, respond)
}

func startSignerAdminTestServerMode(
	t *testing.T,
	mode os.FileMode,
	respond func(request) ([]byte, error),
) signerAdminTestServer {
	t.Helper()
	directory := signerAdminShortTempDir(t)
	path := filepath.Join(directory, "control.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen on signer admin test socket: %v", err)
	}
	if err := os.Chmod(path, mode); err != nil {
		_ = listener.Close()
		t.Fatalf("secure signer admin test socket: %v", err)
	}
	requests := make(chan request, 1)
	done := make(chan error, 1)
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			done <- err
			return
		}
		var req request
		if err := decodeSignerAdminStrictJSON(bytes.TrimSpace(line), &req); err != nil {
			done <- err
			return
		}
		requests <- req
		response, err := respond(req)
		if err != nil {
			done <- err
			return
		}
		if _, err := conn.Write(append(response, '\n')); err != nil {
			done <- err
			return
		}
		done <- nil
	}()
	t.Cleanup(func() {
		_ = listener.Close()
	})
	return signerAdminTestServer{path: path, requests: requests, done: done}
}

func signerAdminTestSuccess(t *testing.T, result string) func(request) ([]byte, error) {
	t.Helper()
	return func(request) ([]byte, error) {
		encoded, err := json.Marshal(signerAdminResponse{OK: true, Result: json.RawMessage(result)})
		return encoded, err
	}
}

func waitSignerAdminTestServer(t *testing.T, server signerAdminTestServer) request {
	t.Helper()
	select {
	case err := <-server.done:
		if err != nil {
			t.Fatalf("signer admin test server: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("signer admin test server timed out")
	}
	select {
	case req := <-server.requests:
		return req
	default:
		t.Fatal("signer admin test server received no request")
	}
	return request{}
}

func writeSignerAdminTestJSON(t *testing.T, name string, value any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encode test JSON: %v", err)
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatalf("write test JSON: %v", err)
	}
	return path
}

func decodeSignerAdminTestBody(t *testing.T, req request, out any) {
	t.Helper()
	if err := decodeSignerAdminStrictJSON(req.Request, out); err != nil {
		t.Fatalf("decode signer admin request body: %v", err)
	}
}

func TestSignerAdminWalletCreateLockedPolicy(t *testing.T) {
	server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, `{"wallet":{"walletId":"mining","publicKey":"public"},"policy":{"walletId":"mining","role":"mining","version":1,"operations":[],"programs":[],"assets":[],"hash":"sha256:test"}}`))
	var stdout bytes.Buffer
	err := runSignerAdminCLI([]string{
		"wallet", "create",
		"--control-socket", server.path,
		"--wallet-id", "mining",
		"--locked-role", "mining",
	}, strings.NewReader("unused"), &stdout, nil)
	if err != nil {
		t.Fatalf("run signer admin wallet create: %v", err)
	}
	req := waitSignerAdminTestServer(t, server)
	if req.Op != "v2.wallet.create" || req.WalletID != "mining" {
		t.Fatalf("unexpected wallet create envelope: %#v", req)
	}
	var body signerWalletCreateRequestV2
	decodeSignerAdminTestBody(t, req, &body)
	if body.ExpectedVersion != 0 || body.Policy.Role != "mining" || body.Policy.WalletID != "mining" {
		t.Fatalf("unexpected locked create body: %#v", body)
	}
	if len(body.Policy.Operations) != 0 || len(body.Policy.Programs) != 0 || len(body.Policy.Assets) != 0 {
		t.Fatalf("locked create policy is not deny-all: %#v", body.Policy)
	}
	if !strings.Contains(stdout.String(), `"publicKey": "public"`) {
		t.Fatalf("expected public result JSON, got %q", stdout.String())
	}
}

func TestSignerAdminWalletCreateWithStrictPolicyFile(t *testing.T) {
	destination := "11111111111111111111111111111111"
	policyPath := writeSignerAdminTestJSON(t, "policy.json", signerPolicyV2{
		Role:       "agent",
		Operations: []string{intentSolanaNativeTransfer},
		Programs:   []string{destination},
		Assets: []signerPolicyAssetV2{{
			Asset:        "solana:native",
			Destinations: []string{destination},
			MaxPerTx:     "100",
			MaxDaily:     "1000",
		}},
	})
	server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, `{"wallet":{"walletId":"agent"},"policy":{"walletId":"agent"}}`))
	err := runSignerAdminCLI([]string{
		"wallet", "create", "--control-socket", server.path, "--wallet-id", "agent", "--policy-file", policyPath,
	}, strings.NewReader(""), io.Discard, nil)
	if err != nil {
		t.Fatalf("create wallet with policy file: %v", err)
	}
	req := waitSignerAdminTestServer(t, server)
	var body signerWalletCreateRequestV2
	decodeSignerAdminTestBody(t, req, &body)
	if body.Policy.Hash == "" || body.Policy.WalletID != "agent" || len(body.Policy.Operations) != 1 {
		t.Fatalf("policy was not normalized before submission: %#v", body.Policy)
	}

	unknownPath := filepath.Join(t.TempDir(), "unknown.json")
	if err := os.WriteFile(unknownPath, []byte(`{"role":"agent","unknown":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadSignerAdminPolicy(unknownPath, "agent"); err == nil || !strings.Contains(err.Error(), "strict policy") {
		t.Fatalf("expected strict policy-file rejection, got %v", err)
	}
}

func TestSignerAdminWalletImportStagesOnlyStdinInExclusiveSignerFile(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	values := make([]int, len(privateKey))
	for i, value := range privateKey {
		values[i] = int(value)
	}
	input, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	type observedImport struct {
		path   string
		mode   os.FileMode
		secret []byte
	}
	observed := make(chan observedImport, 1)
	server := startSignerAdminTestServer(t, func(req request) ([]byte, error) {
		if req.Op != "v2.wallet.import" || req.WalletID != "agent" {
			return nil, errors.New("unexpected import request")
		}
		var body signerWalletImportRequestV2
		if err := decodeSignerAdminStrictJSON(req.Request, &body); err != nil {
			return nil, err
		}
		info, err := os.Lstat(body.Path)
		if err != nil {
			return nil, err
		}
		secret, err := readSignerImportFileV2(body.Path)
		if err != nil {
			return nil, err
		}
		observed <- observedImport{path: body.Path, mode: info.Mode().Perm(), secret: append([]byte(nil), secret...)}
		zeroBytes(secret)
		if err := removeSignerImportFileV2(body.Path); err != nil {
			return nil, err
		}
		return json.Marshal(signerAdminResponse{OK: true, Result: json.RawMessage(`{"wallet":{"walletId":"agent","publicKey":"public"},"policy":{"walletId":"agent","role":"agent"}}`)})
	})
	var stdout bytes.Buffer
	err = runSignerAdminCLI([]string{
		"wallet", "import", "--control-socket", server.path, "--wallet-id", "agent", "--locked-role", "agent",
	}, bytes.NewReader(input), &stdout, nil)
	if err != nil {
		t.Fatalf("run signer admin wallet import: %v", err)
	}
	waitSignerAdminTestServer(t, server)
	got := <-observed
	defer zeroBytes(got.secret)
	if got.mode != 0o600 {
		t.Fatalf("staged import mode = %o, want 600", got.mode)
	}
	if !bytes.Equal(got.secret, privateKey) {
		t.Fatal("staged signer import did not match stdin keypair")
	}
	if _, err := os.Lstat(got.path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staged signer import was not removed: %v", err)
	}
	for _, forbidden := range []string{string(input), "secret", "nonce"} {
		if strings.Contains(stdout.String(), forbidden) {
			t.Fatalf("signer admin output exposed import material: %q", stdout.String())
		}
	}
	zeroBytes(input)
	zeroBytes(privateKey)
}

func TestSignerAdminOperatorImportTransfersTypedSecretWithoutStagingPath(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	expectedKey := append([]byte(nil), privateKey...)
	defer zeroBytes(expectedKey)
	values := make([]int, len(privateKey))
	for index, value := range privateKey {
		values[index] = int(value)
	}
	input, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	server := startSignerAdminTestServerMode(t, 0o660, signerAdminTestSuccess(t,
		`{"wallet":{"walletId":"agent","publicKey":"public"},"policy":{"walletId":"agent","role":"agent","version":1,"baselineVersion":1}}`,
	))
	var stdout bytes.Buffer
	if err := runSignerAdminCLI([]string{
		"wallet", "import", "--operator-socket", server.path, "--wallet-id", "agent", "--baseline-role", "agent",
	}, bytes.NewReader(input), &stdout, nil); err != nil {
		t.Fatalf("run operator wallet import: %v", err)
	}
	req := waitSignerAdminTestServer(t, server)
	if req.Op != "v2.wallet.import" || req.WalletID != "agent" || req.Operator == nil || len(req.Operator.Nonce) != 64 || req.Operator.ExpiresAt == "" {
		t.Fatalf("operator import omitted its typed authority context: %#v", req)
	}
	var body signerOperatorWalletImportRequestV1
	decodeSignerAdminTestBody(t, req, &body)
	secret, err := base64.RawStdEncoding.DecodeString(body.KeypairBase64)
	if err != nil || !bytes.Equal(secret, expectedKey) {
		t.Fatalf("operator import did not transfer the canonical stdin keypair: gotBytes=%d wantBytes=%d err=%v", len(secret), len(expectedKey), err)
	}
	defer zeroBytes(secret)
	if body.Baseline.Role != "agent" || body.Baseline.Version != 1 || bytes.Contains(req.Request, []byte(`"path"`)) {
		t.Fatalf("operator import escaped its fixed baseline schema: %s", req.Request)
	}
	if strings.Contains(stdout.String(), body.KeypairBase64) {
		t.Fatal("operator import output exposed the keypair")
	}
	zeroBytes(input)
	zeroBytes(privateKey)
}

func TestSignerAdminOperatorImportRejectsArbitraryPolicyAndAmbiguousAuthority(t *testing.T) {
	server := startSignerAdminTestServerMode(t, 0o660, signerAdminTestSuccess(t, `{}`))
	if err := runSignerAdminCLI([]string{
		"wallet", "import", "--operator-socket", server.path, "--wallet-id", "agent", "--locked-role", "agent",
	}, strings.NewReader("[]"), io.Discard, nil); err == nil || !strings.Contains(err.Error(), "requires --baseline-role") {
		t.Fatalf("operator import accepted a caller-defined policy lane: %v", err)
	}
	if err := runSignerAdminCLI([]string{
		"wallet", "import", "--operator-socket", server.path, "--control-socket", server.path,
		"--wallet-id", "agent", "--baseline-role", "agent",
	}, strings.NewReader("[]"), io.Discard, nil); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("operator import accepted ambiguous socket authority: %v", err)
	}
}

func TestSignerAdminOperatorCreateAndPrimaryRPCUseFixedSchemas(t *testing.T) {
	createServer := startSignerAdminTestServerMode(t, 0o660, signerAdminTestSuccess(t,
		`{"wallet":{"walletId":"vault","publicKey":"public"},"policy":{"walletId":"vault","role":"vault","version":1,"baselineVersion":1}}`,
	))
	if err := runSignerAdminCLI([]string{
		"wallet", "create", "--operator-socket", createServer.path, "--wallet-id", "vault", "--baseline-role", "vault", "--allow-existing",
	}, strings.NewReader(""), io.Discard, nil); err != nil {
		t.Fatalf("operator wallet create failed: %v", err)
	}
	createReq := waitSignerAdminTestServer(t, createServer)
	var createBody signerOperatorWalletCreateRequestV1
	decodeSignerAdminTestBody(t, createReq, &createBody)
	if createReq.Operator == nil || createReq.Op != "v2.wallet.create" || createBody.Baseline.Role != "vault" || !createBody.AllowExisting {
		t.Fatalf("operator create escaped its fixed role-baseline schema: req=%#v body=%#v", createReq, createBody)
	}

	networkServer := startSignerAdminTestServerMode(t, 0o660, signerAdminTestSuccess(t,
		`{"walletId":"vault","configured":true,"version":2,"hash":"hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ready":true}`,
	))
	primaryRPC := "https://rpc.example/solana?api-key=operator-secret"
	if err := runSignerAdminCLI([]string{
		"network", "set-primary", "--operator-socket", networkServer.path, "--wallet-id", "vault", "--expected-version", "1",
	}, strings.NewReader(`{"primaryRpcUrl":"`+primaryRPC+`"}`), io.Discard, nil); err != nil {
		t.Fatalf("operator primary RPC update failed: %v", err)
	}
	networkReq := waitSignerAdminTestServer(t, networkServer)
	var networkBody signerOperatorNetworkSetPrimaryRequestV1
	decodeSignerAdminTestBody(t, networkReq, &networkBody)
	if networkReq.Operator == nil || networkReq.Op != "v2.network.setPrimary" || networkBody.ExpectedVersion != 1 || networkBody.PrimaryRPCURL != primaryRPC {
		t.Fatalf("operator primary RPC escaped its fixed schema: req=%#v body=%#v", networkReq, networkBody)
	}
	for _, value := range []string{networkReq.Operator.Nonce, networkReq.Operator.ExpiresAt} {
		if strings.Contains(value, "operator-secret") {
			t.Fatal("operator RPC credential leaked into authority metadata")
		}
	}

	rejectServer := startSignerAdminTestServerMode(t, 0o660, signerAdminTestSuccess(t, `{}`))
	if err := runSignerAdminCLI([]string{
		"network", "set-primary", "--operator-socket", rejectServer.path, "--wallet-id", "vault", "--expected-version", "1",
	}, strings.NewReader(`{"primaryRpcUrl":"https://rpc.example","verificationRpcUrl":"https://other.example"}`), io.Discard, nil); err == nil || !strings.Contains(err.Error(), "exactly one primaryRpcUrl") {
		t.Fatalf("operator RPC accepted an arbitrary network document: %v", err)
	}
}

func TestSignerAdminWalletImportCleansStagedFileOnRejection(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	values := make([]int, len(privateKey))
	for i, value := range privateKey {
		values[i] = int(value)
	}
	input, _ := json.Marshal(values)
	stagedPath := make(chan string, 1)
	server := startSignerAdminTestServer(t, func(req request) ([]byte, error) {
		var body signerWalletImportRequestV2
		if err := decodeSignerAdminStrictJSON(req.Request, &body); err != nil {
			return nil, err
		}
		stagedPath <- body.Path
		return json.Marshal(signerAdminResponse{OK: false, Error: "signer wallet already exists"})
	})
	err = runSignerAdminCLI([]string{
		"wallet", "import", "--control-socket", server.path, "--wallet-id", "agent", "--locked-role", "agent",
	}, bytes.NewReader(input), io.Discard, nil)
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected signer rejection, got %v", err)
	}
	waitSignerAdminTestServer(t, server)
	path := <-stagedPath
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected signer import was not cleaned up: %v", err)
	}
	zeroBytes(input)
	zeroBytes(privateKey)
}

func TestSignerAdminWalletImportLegacySendsOnlyOwnerFilePaths(t *testing.T) {
	root := t.TempDir()
	keystorePath := filepath.Join(root, "legacy-wallet.enc")
	passphrasePath := filepath.Join(root, "legacy-passphrase")
	server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, `{"wallet":{"walletId":"agent","publicKey":"public"},"policy":{"walletId":"agent","role":"agent"}}`))
	var stdout bytes.Buffer
	err := runSignerAdminCLI([]string{
		"wallet", "import-legacy",
		"--control-socket", server.path,
		"--wallet-id", "agent",
		"--locked-role", "agent",
		"--keystore-path", keystorePath,
		"--passphrase-path", passphrasePath,
	}, strings.NewReader("stdin-must-not-be-read"), &stdout, nil)
	if err != nil {
		t.Fatalf("run signer admin legacy import: %v", err)
	}
	req := waitSignerAdminTestServer(t, server)
	if req.Op != "v2.wallet.importLegacy" || req.WalletID != "agent" {
		t.Fatalf("unexpected legacy import request: %#v", req)
	}
	var body signerWalletLegacyImportRequestV2
	decodeSignerAdminTestBody(t, req, &body)
	if body.Path != keystorePath || body.PassphrasePath != passphrasePath {
		t.Fatalf("legacy import paths changed: %#v", body)
	}
	if body.Policy.Role != "agent" || len(body.Policy.Operations) != 0 || len(body.Policy.Programs) != 0 || len(body.Policy.Assets) != 0 {
		t.Fatalf("legacy import policy must remain explicit deny-all: %#v", body.Policy)
	}
	if strings.Contains(stdout.String(), keystorePath) || strings.Contains(stdout.String(), passphrasePath) {
		t.Fatalf("legacy import output exposed source paths: %q", stdout.String())
	}
}

func TestSignerAdminWalletImportLegacySupportsRoleBaseline(t *testing.T) {
	root := t.TempDir()
	keystorePath := filepath.Join(root, "legacy-wallet.enc")
	passphrasePath := filepath.Join(root, "legacy-passphrase")
	server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, `{"wallet":{"walletId":"agent","publicKey":"public"},"policy":{"walletId":"agent","role":"agent","baselineVersion":1}}`))
	err := runSignerAdminCLI([]string{
		"wallet", "import-legacy",
		"--control-socket", server.path,
		"--wallet-id", "agent",
		"--baseline-role", "agent",
		"--keystore-path", keystorePath,
		"--passphrase-path", passphrasePath,
	}, strings.NewReader("stdin-must-not-be-read"), io.Discard, nil)
	if err != nil {
		t.Fatalf("run signer admin legacy baseline import: %v", err)
	}
	req := waitSignerAdminTestServer(t, server)
	var body signerWalletLegacyImportRequestV2
	decodeSignerAdminTestBody(t, req, &body)
	if body.Baseline == nil || body.Baseline.Version != 1 || body.Baseline.Role != "agent" {
		t.Fatalf("legacy baseline import omitted exact role baseline: %#v", body)
	}
	if body.Policy.Role != "" || len(body.Policy.Operations) != 0 {
		t.Fatalf("legacy baseline import also sent an arbitrary policy: %#v", body.Policy)
	}
}

func TestSignerAdminPolicyGetPutAndWalletReencrypt(t *testing.T) {
	policyPath := writeSignerAdminTestJSON(t, "policy.json", signerPolicyV2{
		WalletID:   "agent",
		Role:       "agent",
		Operations: []string{},
		Programs:   []string{},
		Assets:     []signerPolicyAssetV2{},
	})
	tests := []struct {
		name       string
		args       func(string) []string
		wantOp     string
		wantBody   bool
		checkBody  func(*testing.T, request)
		resultJSON string
	}{
		{
			name: "policy get",
			args: func(socket string) []string {
				return []string{"policy", "get", "--control-socket", socket, "--wallet-id", "agent"}
			},
			wantOp: "v2.policy.get", resultJSON: `{"walletId":"agent","version":4}`,
		},
		{
			name: "policy put",
			args: func(socket string) []string {
				return []string{"policy", "put", "--control-socket", socket, "--wallet-id", "agent", "--expected-version", "4", "--policy-file", policyPath}
			},
			wantOp: "v2.policy.put", wantBody: true, resultJSON: `{"walletId":"agent","version":5}`,
			checkBody: func(t *testing.T, req request) {
				var body signerPolicyPutRequestV2
				decodeSignerAdminTestBody(t, req, &body)
				if body.ExpectedVersion != 4 || body.Policy.WalletID != "agent" {
					t.Fatalf("unexpected policy put body: %#v", body)
				}
			},
		},
		{
			name: "wallet reencrypt",
			args: func(socket string) []string {
				return []string{"wallet", "reencrypt", "--control-socket", socket, "--wallet-id", "agent"}
			},
			wantOp: "v2.wallet.reencrypt", resultJSON: `{"walletId":"agent","version":2}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, test.resultJSON))
			if err := runSignerAdminCLI(test.args(server.path), strings.NewReader(""), io.Discard, nil); err != nil {
				t.Fatalf("run command: %v", err)
			}
			req := waitSignerAdminTestServer(t, server)
			if req.Op != test.wantOp || req.WalletID != "agent" {
				t.Fatalf("unexpected request: %#v", req)
			}
			if test.wantBody != (len(req.Request) > 0) {
				t.Fatalf("request body presence = %v, want %v", len(req.Request) > 0, test.wantBody)
			}
			if test.checkBody != nil {
				test.checkBody(t, req)
			}
		})
	}
}

func TestSignerAdminNetworkPutReadsStrictStdinAndReturnsMetadataOnly(t *testing.T) {
	secret := "admin-network-secret-token"
	hash := "hmac-sha256:" + strings.Repeat("a", 64)
	input := []byte(`{"expectedVersion":0,"primaryRpcUrl":"https://rpc.example.com/solana?api-key=` + secret + `","executionFallbackRpcUrl":"https://fallback.example.com/rpc"}`)
	server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, `{"walletId":"agent","configured":true,"version":1,"hash":"`+hash+`","ready":true}`))
	var stdout bytes.Buffer
	err := runSignerAdminCLI([]string{
		"network", "put", "--control-socket", server.path, "--wallet-id", "agent",
	}, bytes.NewReader(input), &stdout, nil)
	if err != nil {
		t.Fatalf("run signer admin network put: %v", err)
	}
	req := waitSignerAdminTestServer(t, server)
	if req.Op != "v2.network.put" || req.WalletID != "agent" {
		t.Fatalf("unexpected signer network put envelope: %#v", req)
	}
	var body signerNetworkPutRequestV2
	decodeSignerAdminTestBody(t, req, &body)
	if body.ExpectedVersion == nil || *body.ExpectedVersion != 0 || !strings.Contains(body.PrimaryRPCURL, secret) || body.ExecutionFallbackRPCURL == "" {
		t.Fatalf("network put did not forward strict stdin configuration: %#v", body)
	}
	if strings.Contains(stdout.String(), secret) || strings.Contains(stdout.String(), "rpc.example.com") || strings.Contains(stdout.String(), "fallback.example.com") {
		t.Fatalf("network put output exposed RPC material: %q", stdout.String())
	}
	if !strings.Contains(stdout.String(), `"hash": "`+hash+`"`) {
		t.Fatalf("network put did not return metadata summary: %q", stdout.String())
	}
	zeroBytes(input)
}

func TestSignerAdminNetworkGetHasNoBodyAndRejectsURLResponses(t *testing.T) {
	hash := "hmac-sha256:" + strings.Repeat("b", 64)
	server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, `{"walletId":"agent","configured":true,"version":2,"hash":"`+hash+`","ready":true}`))
	var stdout bytes.Buffer
	if err := runSignerAdminCLI([]string{
		"network", "get", "--control-socket", server.path, "--wallet-id", "agent",
	}, strings.NewReader("ignored"), &stdout, nil); err != nil {
		t.Fatalf("run signer admin network get: %v", err)
	}
	req := waitSignerAdminTestServer(t, server)
	if req.Op != "v2.network.get" || req.WalletID != "agent" || len(req.Request) != 0 {
		t.Fatalf("unexpected signer network get envelope: %#v", req)
	}
	if strings.Contains(stdout.String(), "http") || !strings.Contains(stdout.String(), `"version": 2`) {
		t.Fatalf("unexpected signer network metadata output: %q", stdout.String())
	}

	leaking := startSignerAdminTestServer(t, signerAdminTestSuccess(t, `{"walletId":"agent","configured":true,"version":2,"hash":"`+hash+`","ready":true,"primaryRpcUrl":"https://do-not-print.example/?token=secret"}`))
	stdout.Reset()
	err := runSignerAdminCLI([]string{
		"network", "get", "--control-socket", leaking.path, "--wallet-id", "agent",
	}, strings.NewReader(""), &stdout, nil)
	if err == nil || !strings.Contains(err.Error(), "invalid network summary") || stdout.Len() != 0 {
		t.Fatalf("network get accepted a URL-bearing response: stdout=%q err=%v", stdout.String(), err)
	}
	waitSignerAdminTestServer(t, leaking)

	unsafeHash := startSignerAdminTestServer(t, signerAdminTestSuccess(t, `{"walletId":"agent","configured":true,"version":2,"hash":"https://do-not-print.example/?token=secret","ready":true}`))
	err = runSignerAdminCLI([]string{
		"network", "get", "--control-socket", unsafeHash.path, "--wallet-id", "agent",
	}, strings.NewReader(""), &stdout, nil)
	if err == nil || !strings.Contains(err.Error(), "invalid network summary") || stdout.Len() != 0 || strings.Contains(err.Error(), "do-not-print") {
		t.Fatalf("network get accepted unsafe hash metadata: stdout=%q err=%v", stdout.String(), err)
	}
	waitSignerAdminTestServer(t, unsafeHash)
}

func TestSignerAdminNetworkPutRejectsRPCArgsEnvironmentAndInvalidStdin(t *testing.T) {
	err := runSignerAdminCLI([]string{
		"network", "put", "--primary-rpc-url=https://do-not-print.example/?token=secret",
	}, strings.NewReader(`{}`), io.Discard, nil)
	if err == nil || !strings.Contains(err.Error(), "invalid or unknown") || strings.Contains(err.Error(), "do-not-print") {
		t.Fatalf("network put did not safely reject URL command argument: %v", err)
	}
	err = runSignerAdminCLI([]string{"network", "put"}, strings.NewReader(`{}`), io.Discard, []string{
		"FASED_WALLET_SOLANA_RPC_URL=https://do-not-print.example/?token=secret",
	})
	if err == nil || !strings.Contains(err.Error(), "not accepted") || strings.Contains(err.Error(), "do-not-print") {
		t.Fatalf("network put did not safely reject RPC environment: %v", err)
	}

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "missing expected version", input: `{"primaryRpcUrl":"https://rpc.example.com"}`, want: "expectedVersion"},
		{name: "unknown field", input: `{"expectedVersion":0,"primaryRpcUrl":"https://rpc.example.com","unknown":true}`, want: "strict"},
		{name: "duplicate field", input: `{"expectedVersion":0,"expectedVersion":1,"primaryRpcUrl":"https://rpc.example.com"}`, want: "strict"},
		{name: "trailing json", input: `{"expectedVersion":0,"primaryRpcUrl":"https://rpc.example.com"} {}`, want: "strict"},
		{name: "external http", input: `{"expectedVersion":0,"primaryRpcUrl":"http://rpc.example.com/?token=do-not-print"}`, want: "HTTPS"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, `{}`))
			err := runSignerAdminCLI([]string{
				"network", "put", "--control-socket", server.path, "--wallet-id", "agent",
			}, strings.NewReader(test.input), io.Discard, nil)
			if err == nil || !strings.Contains(err.Error(), test.want) || strings.Contains(err.Error(), "do-not-print") {
				t.Fatalf("expected safe %q rejection, got %v", test.want, err)
			}
		})
	}

	server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, `{}`))
	oversized := strings.Repeat("x", maxSignerNetworkInputBytesV2+1)
	if err := runSignerAdminCLI([]string{
		"network", "put", "--control-socket", server.path, "--wallet-id", "agent",
	}, strings.NewReader(oversized), io.Discard, nil); err == nil || !strings.Contains(err.Error(), "size limit") {
		t.Fatalf("network put accepted oversized stdin: %v", err)
	}
}

func TestSignerAdminWebAuthnTypedPassthrough(t *testing.T) {
	finishPath := writeSignerAdminTestJSON(t, "finish.json", signerWebAuthnRegistrationFinishRequestV2{
		ChallengeID: "challenge-1",
		Credential:  json.RawMessage(`{"id":"credential-1","response":{}}`),
	})
	tests := []struct {
		name     string
		args     func(string) []string
		wantOp   string
		wantBody bool
		check    func(*testing.T, request)
	}{
		{
			name: "registration begin",
			args: func(socket string) []string {
				return []string{"webauthn", "registration", "begin", "--control-socket", socket, "--label", "YubiKey"}
			},
			wantOp: "v2.webauthn.registration.begin", wantBody: true,
			check: func(t *testing.T, req request) {
				var body signerWebAuthnRegistrationBeginRequestV2
				decodeSignerAdminTestBody(t, req, &body)
				if body.Label != "YubiKey" {
					t.Fatalf("unexpected WebAuthn label: %#v", body)
				}
			},
		},
		{
			name: "registration finish",
			args: func(socket string) []string {
				return []string{"webauthn", "registration", "finish", "--control-socket", socket, "--request-file", finishPath}
			},
			wantOp: "v2.webauthn.registration.finish", wantBody: true,
			check: func(t *testing.T, req request) {
				var body signerWebAuthnRegistrationFinishRequestV2
				decodeSignerAdminTestBody(t, req, &body)
				if body.ChallengeID != "challenge-1" || !json.Valid(body.Credential) {
					t.Fatalf("unexpected WebAuthn finish body: %#v", body)
				}
			},
		},
		{
			name: "credentials list",
			args: func(socket string) []string {
				return []string{"webauthn", "credentials", "list", "--control-socket", socket}
			},
			wantOp: "v2.webauthn.credentials.list",
		},
		{
			name: "credentials revoke",
			args: func(socket string) []string {
				return []string{
					"webauthn", "credentials", "revoke", "--control-socket", socket,
					"--credential-id", "Y3JlZGVudGlhbC0x", "--expected-count", "1", "--expected-version", "7",
					"--confirm-last-credential",
				}
			},
			wantOp: "v2.webauthn.credentials.revoke", wantBody: true,
			check: func(t *testing.T, req request) {
				var body signerWebAuthnCredentialRevokeRequestV2
				decodeSignerAdminTestBody(t, req, &body)
				if body.CredentialID != "Y3JlZGVudGlhbC0x" || body.ExpectedCount != 1 || body.ExpectedVersion != 7 || !body.ConfirmLastCredential {
					t.Fatalf("unexpected WebAuthn revoke body: %#v", body)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, `{"ok":"typed"}`))
			if err := runSignerAdminCLI(test.args(server.path), strings.NewReader(""), io.Discard, nil); err != nil {
				t.Fatalf("run WebAuthn admin command: %v", err)
			}
			req := waitSignerAdminTestServer(t, server)
			if req.Op != test.wantOp || req.WalletID != "" {
				t.Fatalf("unexpected WebAuthn request: %#v", req)
			}
			if test.wantBody != (len(req.Request) > 0) {
				t.Fatalf("request body presence = %v, want %v", len(req.Request) > 0, test.wantBody)
			}
			if test.check != nil {
				test.check(t, req)
			}
		})
	}
}

func TestSignerAdminWalletSuccessorRotationTypedCommands(t *testing.T) {
	sourcePublicKey := solana.NewWallet().PublicKey().String()
	successorPublicKey := solana.NewWallet().PublicKey().String()
	rotationID := "sha256:" + strings.Repeat("a", 64)
	tests := []struct {
		name  string
		args  func(string) []string
		op    string
		body  bool
		stdin string
		check func(*testing.T, request)
	}{
		{
			name: "prepare successor",
			args: func(socket string) []string {
				return []string{
					"wallet", "rotate-successor", "--control-socket", socket,
					"--wallet-id", "agent", "--successor-wallet-id", "agent_2026",
					"--expected-source-public-key", sourcePublicKey,
					"--expected-source-wallet-version", "3", "--expected-source-policy-version", "8",
				}
			},
			op: "v2.wallet.rotation.create", body: true,
			check: func(t *testing.T, req request) {
				var body signerWalletRotationCreateRequestV2
				decodeSignerAdminTestBody(t, req, &body)
				if body.SuccessorWalletID != "agent_2026" || body.ExpectedSourcePublicKey != sourcePublicKey ||
					body.ExpectedSourceWalletVersion != 3 || body.ExpectedSourcePolicyVersion != 8 {
					t.Fatalf("unexpected rotation prepare body: %#v", body)
				}
			},
		},
		{
			name: "status",
			args: func(socket string) []string {
				return []string{"wallet", "rotation-status", "--control-socket", socket, "--wallet-id", "agent"}
			},
			op: "v2.wallet.rotation.status",
		},
		{
			name: "commit",
			args: func(socket string) []string {
				return []string{
					"wallet", "rotation-commit", "--control-socket", socket,
					"--wallet-id", "agent", "--successor-wallet-id", "agent_2026", "--rotation-id", rotationID,
					"--expected-source-public-key", sourcePublicKey, "--expected-successor-public-key", successorPublicKey,
					"--expected-source-wallet-version", "3", "--expected-source-policy-version", "8",
					"--expected-successor-wallet-version", "1", "--expected-successor-policy-version", "1",
					"--expected-rotation-version", "1",
					"--expected-successor-network-version", "2",
					"--expected-successor-network-hash", "hmac-sha256:" + strings.Repeat("b", 64),
				}
			},
			op: "v2.wallet.rotation.commit", body: true,
			stdin: `{"recoveryPackageHash":"sha256:` + strings.Repeat("c", 64) + `","safetyEvidence":{"version":1,"walletId":"agent","publicKey":"` + sourcePublicKey + `","observedAt":"2026-07-20T12:00:00Z","newJobsStopped":true,"workersDrained":true,"clearingDrained":true,"submissionsReconciled":true,"pendingCommits":0,"pendingReveals":0,"pendingSettlements":0,"pendingClaims":0,"pendingCleanup":0,"pendingAltMutations":0,"solBalanceLamports":"1","satBalanceRaw":"2","runtimeStateHash":"sha256:` + strings.Repeat("d", 64) + `","submissionLedgerHash":"sha256:` + strings.Repeat("e", 64) + `"}}`,
			check: func(t *testing.T, req request) {
				var body signerWalletRotationCommitRequestV2
				decodeSignerAdminTestBody(t, req, &body)
				if body.RotationID != rotationID || body.SuccessorWalletID != "agent_2026" ||
					body.ExpectedSourcePublicKey != sourcePublicKey || body.ExpectedSuccessorPublicKey != successorPublicKey ||
					body.ExpectedSourceWalletVersion != 3 || body.ExpectedSourcePolicyVersion != 8 ||
					body.ExpectedSuccessorWalletVersion != 1 || body.ExpectedSuccessorPolicyVersion != 1 || body.ExpectedRotationVersion != 1 ||
					body.ExpectedSuccessorNetworkVersion != 2 || body.RecoveryPackageHash == "" || body.SafetyEvidence == nil {
					t.Fatalf("unexpected rotation commit body: %#v", body)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, `{"state":"typed"}`))
			if err := runSignerAdminCLI(test.args(server.path), strings.NewReader(test.stdin), io.Discard, nil); err != nil {
				t.Fatalf("run rotation admin command: %v", err)
			}
			req := waitSignerAdminTestServer(t, server)
			if req.Op != test.op || req.WalletID != "agent" || test.body != (len(req.Request) > 0) {
				t.Fatalf("unexpected rotation admin request: %#v", req)
			}
			if test.check != nil {
				test.check(t, req)
			}
		})
	}
}

func TestSignerAdminRejectsUnknownSecretAndUnsafeInputs(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		environ []string
		want    string
	}{
		{name: "unknown flag", args: []string{"wallet", "create", "--unknown", "value"}, want: "invalid or unknown"},
		{name: "secret flag", args: []string{"wallet", "import", "--private-key=do-not-print"}, want: "not accepted"},
		{name: "secret environment", args: []string{"policy", "get"}, environ: []string{"FASED_WALLET_PASSPHRASE=do-not-print"}, want: "environment"},
		{name: "unknown command", args: []string{"socket", "proxy"}, want: "unknown signer admin"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := runSignerAdminCLI(test.args, strings.NewReader(""), io.Discard, test.environ)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected %q error, got %v", test.want, err)
			}
			if strings.Contains(err.Error(), "do-not-print") {
				t.Fatalf("error reflected secret material: %v", err)
			}
		})
	}

	if _, err := requireSignerAdminControlSocket("relative.sock"); err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("expected relative control socket rejection, got %v", err)
	}
	regular := filepath.Join(t.TempDir(), "control.sock")
	if err := os.WriteFile(regular, []byte("not a socket"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := requireSignerAdminControlSocket(regular); err == nil || !strings.Contains(err.Error(), "Unix socket") {
		t.Fatalf("expected regular-file control socket rejection, got %v", err)
	}
	listenerPath := filepath.Join(signerAdminShortTempDir(t), "insecure-control.sock")
	listener, err := net.Listen("unix", listenerPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(listenerPath, 0o660); err != nil {
		t.Fatal(err)
	}
	if _, err := requireSignerAdminControlSocket(listenerPath); err == nil || !strings.Contains(err.Error(), "group/world") {
		t.Fatalf("expected accessible control socket rejection, got %v", err)
	}

	if _, err := resolveSignerAdminCreationPolicy("agent", "", ""); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("expected missing create policy choice rejection, got %v", err)
	}
	if _, err := resolveSignerAdminCreationPolicy("agent", regular, "agent"); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("expected conflicting create policy choice rejection, got %v", err)
	}
}

func TestSignerAdminRejectsInvalidKeypairAndStrictResponse(t *testing.T) {
	if _, err := readSignerAdminSolanaKeypair(strings.NewReader(`[1,2,3]`)); err == nil || !strings.Contains(err.Error(), "64-byte") {
		t.Fatalf("expected short keypair rejection, got %v", err)
	}
	if _, err := readSignerAdminSolanaKeypair(strings.NewReader(`[1,2,3] {}`)); err == nil || !strings.Contains(err.Error(), "64-byte") {
		t.Fatalf("expected trailing keypair JSON rejection, got %v", err)
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		t.Fatal(err)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	privateKey[len(privateKey)-1] ^= 0xff
	values := make([]int, len(privateKey))
	for i, value := range privateKey {
		values[i] = int(value)
	}
	encoded, _ := json.Marshal(values)
	if _, err := readSignerAdminSolanaKeypair(bytes.NewReader(encoded)); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("expected mismatched keypair rejection, got %v", err)
	}
	invalidImportPath := filepath.Join(t.TempDir(), "invalid-keypair.json")
	if err := os.WriteFile(invalidImportPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readSignerImportFileV2(invalidImportPath); err == nil || !strings.Contains(err.Error(), "public key mismatch") {
		t.Fatalf("expected signer-side mismatched keypair rejection, got %v", err)
	}
	zeroBytes(seed)
	zeroBytes(privateKey)
	zeroBytes(encoded)

	server := startSignerAdminTestServer(t, func(request) ([]byte, error) {
		return []byte(`{"ok":true,"result":{},"unknown":true}`), nil
	})
	err := runSignerAdminCLI([]string{
		"policy", "get", "--control-socket", server.path, "--wallet-id", "agent",
	}, strings.NewReader(""), io.Discard, nil)
	if err == nil || !strings.Contains(err.Error(), "strict protocol envelope") {
		t.Fatalf("expected strict response rejection, got %v", err)
	}
	waitSignerAdminTestServer(t, server)
}
