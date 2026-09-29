package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWENBTCRouteInstallService(t *testing.T) {
	for _, name := range []string{"valid", "application", "readonly", "operator", "unknown-field", "replay"} {
		t.Run(name, func(t *testing.T) {
			service, cfg, review, calls := wenJoinedServiceCase(t, "acquisition", "")
			cfg.readOnly = false
			root, _, route, err := loadWENBTCReviewV1(cfg.stateDBPath, "buyer", review.Intent)
			if err != nil {
				t.Fatal(err)
			}
			review.Provider = &signerWENBTCProviderReviewV1{SlippageBPS: 50, ExpiresSlot: 160}
			writeWENReviewTest(t, root, review)
			original, _ := os.ReadFile(filepath.Join(root, "admission.json"))
			raw, _ := json.Marshal(route)
			preview := signerWENBTCRoutePreviewV1{Status: "requires-route-review", Operation: "acquisition", DescriptorSHA256: review.Intent.DescriptorSHA256, OfferSHA256: review.Intent.OfferSHA256, BaseReviewSHA256: wenHashV1(original), RouteSHA256: wenHashV1(raw), RouteBytes: raw, Validity: signerWENBTCRouteValidityV1{ObservedSlot: 150, ExpiresSlot: 160}}
			body, _ := json.Marshal(signerWENBTCRouteInstallRequestV1{Intent: review.Intent, Preview: preview})
			if name == "unknown-field" {
				body = append([]byte(`{"rpcUrl":"https://example.invalid",`), body[1:]...)
			}
			req := request{Op: "v2.wenBtc.route.install", WalletID: "buyer", Request: body}
			control := name != "application"
			if name == "readonly" {
				cfg.readOnly = true
			}
			if name == "operator" {
				req.operatorSocket = true
			}
			before := calls.Load()
			response, err := service.handle(req, cfg, control)
			if name != "valid" && name != "replay" {
				if err == nil {
					t.Fatal("unauthorized install")
				}
				if calls.Load() != before {
					t.Fatal("denial performed RPC")
				}
				after, _ := os.ReadFile(filepath.Join(root, "admission.json"))
				if string(after) != string(original) {
					t.Fatal("denial mutated review")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var envelope struct {
				OK     bool                              `json:"ok"`
				Result signerWENBTCRouteInstallReceiptV1 `json:"result"`
			}
			if json.Unmarshal(response, &envelope) != nil || !envelope.OK {
				t.Fatal("missing receipt")
			}
			after, _ := os.ReadFile(filepath.Join(root, "admission.json"))
			r := envelope.Result
			if r.Status != "route-installed" || r.WalletID != "buyer" || r.SigningEnabled || r.BaseReviewSHA256 != wenHashV1(original) || r.InstalledReviewSHA256 != wenHashV1(after) || r.RouteSHA256 != preview.RouteSHA256 {
				t.Fatal("receipt did not identify installed bytes")
			}
			if name == "replay" {
				before = calls.Load()
				_, err = service.handle(req, cfg, control)
				if err == nil || !strings.Contains(err.Error(), "review mismatch") {
					t.Fatalf("replay: %v", err)
				}
				if calls.Load() != before {
					t.Fatal("replay called RPC")
				}
			}
		})
	}
}

func TestWENBTCRouteInstallUpdateGate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "active")
	if err := os.WriteFile(path, []byte("paired-update\n"), 0640); err != nil {
		t.Fatal(err)
	}
	for _, control := range []bool{false, true} {
		if err := enforceApplicationUpdateGate(path, "v2.wenBtc.route.install", control, os.Geteuid(), os.Getegid()); err == nil {
			t.Fatal("installation bypassed update gate")
		}
	}
}
