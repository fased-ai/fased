package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func wenReviewFixture(t *testing.T) (string, string, signerWENBTCReviewV1, *wenReadRPCFake) {
	t.Helper()
	artifacts, pins, intent, wallet, f := wenRPCFixture(t)
	state := filepath.Join(t.TempDir(), "signer.db")
	root := filepath.Join(filepath.Dir(state), "wen-btc", wenHashV1([]byte("buyer")))
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(artifacts)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		b, err := os.ReadFile(filepath.Join(artifacts, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(root, entry.Name()), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	review := signerWENBTCReviewV1{Version: 1, WalletID: "buyer", WalletPublicKey: wallet.String(), Pins: pins, Intent: intent, MaxSlotLag: 5}
	writeWENReviewTest(t, root, review)
	return state, root, review, f
}
func writeWENReviewTest(t *testing.T, root string, review signerWENBTCReviewV1) {
	t.Helper()
	b, err := json.Marshal(review)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "admission.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestWENBTCReviewedServiceInspection(t *testing.T) {
	state, _, review, f := wenReviewFixture(t)
	root, loaded, route, err := loadWENBTCReviewV1(state, "buyer", review.Intent)
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, wallet, _ := wenArtifactCase(t)
	out, err := inspectReviewedWENBTCV1(context.Background(), f, root, loaded, wallet, 180000, route)
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != "requires-transaction-verification" || out.SigningEnabled || out.Readback.Slot != 150 || out.Readback.Data[0] != 111 {
		t.Fatal("incorrect read-only result")
	}
	if _, err = normalizeSignerIntentForWalletV2(signerIntentV2{Type: intentWENBTCSubscriptionV1, WENBTC: &review.Intent}, &wallet); err == nil {
		t.Fatal("inspection enabled signing")
	}
}

func TestWENBTCReviewedConfigRejectsDrift(t *testing.T) {
	for _, name := range []string{"intent", "wallet-id", "version", "wallet-key", "unknown", "trailing", "missing", "symlink", "parent-symlink", "writable", "parent-writable", "route-on-acceptance", "request-path"} {
		t.Run(name, func(t *testing.T) {
			state, root, review, _ := wenReviewFixture(t)
			intent := review.Intent
			walletID := "buyer"
			path := filepath.Join(root, "admission.json")
			switch name {
			case "intent":
				intent.MaxCashRaw = "999"
			case "wallet-id":
				review.WalletID = "another"
				writeWENReviewTest(t, root, review)
			case "version":
				review.Version = 2
				writeWENReviewTest(t, root, review)
			case "wallet-key":
				review.WalletPublicKey = "invalid"
				writeWENReviewTest(t, root, review)
			case "unknown":
				b, _ := os.ReadFile(path)
				b = append([]byte(`{"rpcUrl":"https://example.invalid",`), b[1:]...)
				os.WriteFile(path, b, 0600)
			case "trailing":
				b, _ := os.ReadFile(path)
				os.WriteFile(path, append(b, []byte(" {}")...), 0600)
			case "missing":
				os.Remove(path)
			case "symlink":
				os.Rename(path, path+".saved")
				os.Symlink(path+".saved", path)
			case "parent-symlink":
				os.Rename(root, root+".saved")
				os.Symlink(root+".saved", root)
			case "writable":
				os.Chmod(path, 0666)
			case "parent-writable":
				os.Chmod(filepath.Dir(root), 0777)
			case "route-on-acceptance":
				review.RouteSHA256 = strings.Repeat("1", 64)
				writeWENReviewTest(t, root, review)
			case "request-path":
				walletID = "../buyer"
			}
			if _, _, _, err := loadWENBTCReviewV1(state, walletID, intent); err == nil {
				t.Fatal("unreviewed input accepted")
			}
		})
	}
}

func TestWENBTCReviewedAcquisitionRoute(t *testing.T) {
	for _, name := range []string{"valid", "tampered", "missing", "unknown", "absent-hash", "absent-validity"} {
		t.Run(name, func(t *testing.T) {
			state, root, review, _ := wenReviewFixture(t)
			_, _, r, _, _ := wenAcquisitionFixture(t)
			raw, err := json.Marshal(r)
			if err != nil {
				t.Fatal(err)
			}
			if name == "unknown" {
				raw = append([]byte(`{"transaction":"supplied",`), raw[1:]...)
			}
			review.Intent.Operation = "acquisition"
			review.RouteValidity = &signerWENBTCRouteValidityV1{ObservedSlot: 150, ExpiresSlot: 156}
			review.RouteSHA256 = wenHashV1(raw)
			if err = os.WriteFile(filepath.Join(root, review.RouteSHA256), raw, 0600); err != nil {
				t.Fatal(err)
			}
			switch name {
			case "tampered":
				os.WriteFile(filepath.Join(root, review.RouteSHA256), []byte("{}"), 0600)
			case "missing":
				os.Remove(filepath.Join(root, review.RouteSHA256))
			case "absent-validity":
				review.RouteValidity = nil
			case "absent-hash":
				review.RouteSHA256 = ""
			}
			writeWENReviewTest(t, root, review)
			_, _, route, err := loadWENBTCReviewV1(state, "buyer", review.Intent)
			if (err == nil) != (name == "valid") {
				t.Fatalf("unexpected result %v", err)
			}
			if name == "valid" && (route == nil || route.Program != r.Program) {
				t.Fatal("route missing")
			}
		})
	}
}

func TestWENBTCInspectionRequestBoundary(t *testing.T) {
	_, _, review, _ := wenReviewFixture(t)
	body, _ := json.Marshal(review.Intent)
	req := request{Op: "v2.wenBtc.inspect", WalletID: "buyer", Request: body}
	if err := mustValidate(req, signerConfig{}); err != nil {
		t.Fatal(err)
	}
	if !applicationUpdateGateReadOperations[req.Op] {
		t.Fatal("inspection must be read-only")
	}
	for _, bad := range []request{{Op: req.Op, Request: body}, {Op: req.Op, WalletID: "buyer"}, {Op: req.Op, WalletID: "buyer", Request: body, Chain: "solana"}} {
		if err := mustValidate(bad, signerConfig{}); err == nil {
			t.Fatal("invalid request admitted")
		}
	}
	service := &signerServiceV2{}
	_, err := service.handle(req, signerConfig{chains: []string{"solana"}, stateDBPath: filepath.Join(t.TempDir(), "signer.db"), readOnly: true}, false)
	if err == nil || !strings.Contains(err.Error(), "configuration unavailable") {
		t.Fatalf("dispatch did not require reviewed config: %v", err)
	}
}

func TestWENBTCReviewedInspectionRejectsWalletAndOperation(t *testing.T) {
	for _, name := range []string{"wallet", "route-on-acceptance", "missing-acquisition-route"} {
		t.Run(name, func(t *testing.T) {
			_, root, review, f := wenReviewFixture(t)
			_, _, _, wallet, _ := wenArtifactCase(t)
			var route *signerWENBTCRouteV1
			switch name {
			case "wallet":
				review.WalletPublicKey = review.Pins.ProgramID
			case "route-on-acceptance":
				route = &signerWENBTCRouteV1{}
			case "missing-acquisition-route":
				review.Intent.Operation = "acquisition"
				review.RouteValidity = &signerWENBTCRouteValidityV1{ObservedSlot: 150, ExpiresSlot: 156}
			}
			if _, err := inspectReviewedWENBTCV1(context.Background(), f, root, review, wallet, 180000, route); err == nil {
				t.Fatal("unbound inspection accepted")
			}
			if f.calls != 0 {
				t.Fatal("RPC contacted before wallet/operation binding")
			}
		})
	}
}
