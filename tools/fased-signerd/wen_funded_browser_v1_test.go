package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gagliardetto/solana-go/rpc"
)

// Disposable compiled-bank fixture only. Never exports an owner credential.
type fundedBrowserConnV1 struct {
	net.Conn
	t *testing.T
}

func (c fundedBrowserConnV1) Write(b []byte) (int, error) {
	var reply struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(b, &reply) == nil && reply.Error != "" {
		c.t.Log("funded socket rejected:", reply.Error)
	}
	return c.Conn.Write(b)
}

func runWENFundedBrowserV1(t *testing.T, s *signerServiceV2, cfg signerConfig, endpoint string, pins wenStakingPinsV1, intent signerWENMiningClaimIntentV1, descriptor []byte, reviewHash string, auth *testWebAuthnAuthenticatorV2) {
	t.Helper()
	var sends atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, "body", 400)
			return
		}
		var request struct {
			Method string `json:"method"`
		}
		_ = json.Unmarshal(body, &request)
		if request.Method == "sendTransaction" {
			sends.Add(1)
		}
		response, err := http.Post(endpoint, "application/json", bytes.NewReader(body))
		if err != nil {
			http.Error(w, "bank unavailable", 502)
			return
		}
		defer response.Body.Close()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(response.StatusCode)
		_, _ = io.Copy(w, response.Body)
	}))
	defer proxy.Close()
	// Exercise production socket dispatch and its configured RPC construction.
	if _, err := s.keys.PutNetworkV2("bank_test", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: proxy.URL}); err != nil {
		t.Fatal(err)
	}
	dir := signerAdminShortTempDir(t)
	socket := filepath.Join(dir, "app.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err = os.Chmod(socket, 0600); err != nil {
		t.Fatal(err)
	}
	limiter := newRateLimiter(time.Minute, map[string]int{
		"v2.wenMining.claim.recover": 10, "v2.wenMining.claim.review.prepare": 10,
		"v2.review.authorization.begin": 10, "v2.review.authorization.finish": 10, "v2.wenMining.claim.journey": 10,
	})
	go func() {
		for {
			conn, e := listener.Accept()
			if e != nil {
				return
			}
			go handleConn(fundedBrowserConnV1{conn, t}, cfg, limiter, &auditWriter{path: filepath.Join(dir, "audit.jsonl"), maxBytes: 1048576}, s, false)
		}
	}()
	authority := any(nil)
	if pins.UpgradeAuthority != nil {
		authority = pins.UpgradeAuthority.String()
	}
	recovery := map[string]any{"cursor": "", "limit": 1, "operation": intent.Operation, "pins": map[string]any{"ProgramID": pins.ProgramID, "Genesis": pins.Genesis, "DescriptorSHA256": pins.DescriptorSHA256, "CapabilitySHA256": pins.CapabilitySHA256, "CodeSHA256": pins.CodeSHA256, "DeploymentSlot": pins.DeploymentSlot, "UpgradeAuthority": authority}, "descriptor": base64.StdEncoding.EncodeToString(descriptor), "minFinalizedSlot": intent.MinFinalizedSlot, "expiresSlot": intent.ExpiresSlot, "maxFeeLamports": "5000", "maxSlotLag": "32"}
	profile := map[string]any{"version": 1, "mode": "local-candidate-only", "walletId": "bank_test", "socketPath": socket, "request": recovery, "ticks": 1, "intervalMs": 5000}
	raw, _ := json.Marshal(profile)
	profilePath := filepath.Join(dir, "profile.json")
	if err = os.WriteFile(profilePath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	private, err := x509.MarshalPKCS8PrivateKey(auth.privateKey)
	if err != nil {
		t.Fatal(err)
	}
	defer zeroBytes(private)
	input := map[string]any{"profilePath": profilePath, "walletId": "bank_test", "origin": testWebAuthnOrigin, "rpId": testWebAuthnRPID, "privateKey": base64.StdEncoding.EncodeToString(private), "credentialId": base64.StdEncoding.EncodeToString(auth.credentialID), "request": map[string]any{"requestId": "state-request", "intent": intent, "reviewSha256": reviewHash}}
	raw, _ = json.Marshal(input)
	inputPath := filepath.Join(dir, "browser.json")
	if err = os.WriteFile(inputPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	zeroBytes(raw)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "pnpm", "exec", "vitest", "run", "--config", "vitest.wen-review-local.config.ts", "src/gateway/server.wen-funded.e2e.test.ts")
	command.Dir = os.Getenv("WEN_FASED_SOURCE_ROOT")
	if command.Dir == "" {
		t.Fatal("explicit Fased source root required")
	}
	command.Env = append(os.Environ(), "WEN_FUNDED_BROWSER_INPUT="+inputPath)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("funded browser: %v\n%s", err, output)
	}
	t.Log(string(output))
	saved := readWENState(t, s.store)
	if sends.Load() != 1 || !saved.SuccessBudgetSettled || saved.OutcomeFee != 5000 || saved.ClaimAuthorization == nil || saved.ClaimAuthorization.ProofID == "" {
		t.Fatal("browser settlement not reconciled", sends.Load())
	}
	if status, err := s.store.recoverWENMiningClaimExecutionV1(context.Background(), rpc.New(proxy.URL), "state-request", saved.Digest); err != nil || status != "finalized-success" {
		t.Fatal("browser recovery", status, err)
	}
	if sends.Load() != 1 {
		t.Fatal("browser recovery resent")
	}
	if root := os.Getenv("WEN_CLAIM_JOURNEY_RECEIPTS"); root != "" {
		proof, _ := json.Marshal(map[string]any{"operation": intent.Operation, "outcome": "finalized-success", "digest": saved.Digest, "sends": sends.Load(), "feeLamports": saved.OutcomeFee, "humanApproval": true, "budgetSettled": true, "browserWebAuthn": true, "realProfileSocket": true})
		if err = os.WriteFile(filepath.Join(root, intent.Operation+".json"), proof, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Log("PASS: Chromium WebAuthn -> gateway -> protected profile/socket -> funded bank; one send and recovery")
}
