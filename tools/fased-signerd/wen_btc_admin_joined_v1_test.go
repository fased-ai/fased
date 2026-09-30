package main

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Actual admin client -> Unix socket -> handleConn -> signer service -> local
// HTTP RPC -> immutable artifacts/active review -> validated admin receipt.
func TestWENBTCJoinedAdminInstallation(t *testing.T) {
	for _, name := range []string{"install-replay", "simulation-failure", "read-only"} {
		t.Run(name, func(t *testing.T) {
			mutation := ""
			if name == "simulation-failure" {
				mutation = "simulation-error"
			}
			service, cfg, review, calls := wenJoinedServiceCase(t, "acquisition", mutation)
			cfg.readOnly = name == "read-only"
			root, _, route, err := loadWENBTCReviewV1(cfg.stateDBPath, "buyer", review.Intent)
			if err != nil {
				t.Fatal(err)
			}
			review.Provider = &signerWENBTCProviderReviewV1{SlippageBPS: 50, ExpiresSlot: 160}
			writeWENReviewTest(t, root, review)
			active := filepath.Join(root, "admission.json")
			original, err := os.ReadFile(active)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(route)
			if err != nil {
				t.Fatal(err)
			}
			preview := signerWENBTCRoutePreviewV1{Status: "requires-route-review", Operation: "acquisition", DescriptorSHA256: review.Intent.DescriptorSHA256, OfferSHA256: review.Intent.OfferSHA256, BaseReviewSHA256: wenHashV1(original), ProviderInstructionSHA256: strings.Repeat("2", 64), RouteSHA256: wenHashV1(raw), RouteBytes: raw, Validity: signerWENBTCRouteValidityV1{ObservedSlot: 150, ExpiresSlot: 160}}
			input, err := json.Marshal(signerWENBTCRouteInstallRequestV1{Intent: review.Intent, Preview: preview})
			if err != nil {
				t.Fatal(err)
			}
			run := func() (string, error) {
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
					handleConn(conn, cfg, newRateLimiter(time.Minute, map[string]int{"v2.wenBtc.route.install": 2}), &auditWriter{path: filepath.Join(dir, "audit.jsonl"), maxBytes: 1048576}, service, true)
					done <- nil
				}()
				var stdout bytes.Buffer
				e = runSignerAdminCLI([]string{"wen-btc", "install-route", "--control-socket", socket, "--wallet-id", "buyer"}, bytes.NewReader(input), &stdout, nil)
				select {
				case serverErr := <-done:
					if serverErr != nil {
						t.Fatal(serverErr)
					}
				case <-time.After(15 * time.Second):
					t.Fatal("control handler did not finish")
				}
				return stdout.String(), e
			}
			beforeCalls := calls.Load()
			output, err := run()
			after, readErr := os.ReadFile(active)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if name != "install-replay" {
				if err == nil || output != "" || !bytes.Equal(after, original) {
					t.Fatal("failed journey changed review or emitted success")
				}
				if name == "read-only" && calls.Load() != beforeCalls {
					t.Fatal("read-only journey called RPC")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var receipt signerWENBTCRouteInstallReceiptV1
			if json.Unmarshal([]byte(output), &receipt) != nil || receipt.Status != "route-installed" || receipt.InstalledReviewSHA256 != wenHashV1(after) || receipt.BaseReviewSHA256 != wenHashV1(original) || receipt.RouteSHA256 != preview.RouteSHA256 || receipt.SigningEnabled {
				t.Fatal("receipt not bound to installed state")
			}
			saved, e := readWENBTCObjectV1(root, preview.BaseReviewSHA256, 32768)
			if e != nil || !bytes.Equal(saved, original) {
				t.Fatal("original review lost")
			}
			if calls.Load() <= beforeCalls {
				t.Fatal("installation skipped RPC")
			}
			beforeCalls = calls.Load()
			output, err = run()
			if err == nil || output != "" || !strings.Contains(err.Error(), "review mismatch") || calls.Load() != beforeCalls {
				t.Fatal("replay was not rejected before RPC", err)
			}
			replayState, e := os.ReadFile(active)
			if e != nil || !bytes.Equal(replayState, after) {
				t.Fatal("replay changed installed state")
			}
		})
	}
}
