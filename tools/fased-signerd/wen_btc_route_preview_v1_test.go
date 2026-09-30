package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

func TestWENBTCJoinedRoutePreview(t *testing.T) {
	for _, name := range []string{"valid", "review-changed", "review-deleted"} {
		t.Run(name, func(t *testing.T) {
			service, cfg, review, _ := wenJoinedServiceCase(t, "acquisition", "")
			root, _, route, err := loadWENBTCReviewV1(cfg.stateDBPath, "buyer", review.Intent)
			if err != nil {
				t.Fatal(err)
			}
			review.Provider = &signerWENBTCProviderReviewV1{SlippageBPS: 50, ExpiresSlot: 160}
			writeWENReviewTest(t, root, review)
			path := filepath.Join(root, "admission.json")
			original, _ := os.ReadFile(path)
			urls, err := service.keys.SolanaRPCURLsV2("buyer")
			if err != nil {
				t.Fatal(err)
			}
			provider := wenRefreshProvider(func(_ context.Context, _ signerWENBTCArtifactsV1, _ solana.PublicKey, r signerWENBTCReviewV1, _, _, _ uint64) (*signerWENBTCRouteCandidateV1, error) {
				if name == "review-changed" {
					changed := review
					changed.MaxSlotLag = 4
					writeWENReviewTest(t, root, changed)
				}
				if name == "review-deleted" {
					os.Remove(path)
				}
				raw, _ := json.Marshal(route)
				return &signerWENBTCRouteCandidateV1{routeBytes: raw, routeSHA256: wenHashV1(raw), providerInstructionSHA256: strings.Repeat("1", 64), validity: *r.RouteValidity}, nil
			})
			result, err := previewWENBTCRouteV1(context.Background(), newSignerOwnedSolanaRPCClientV2(urls[0]), provider, cfg.stateDBPath, "buyer", review.Intent, solana.MustPublicKeyFromBase58(review.WalletPublicKey), uint64(time.Now().Unix()))
			if name != "valid" {
				if err == nil {
					t.Fatal("changed review returned candidate")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.Status != "requires-route-review" || result.SigningEnabled || result.Installed || result.BaseReviewSHA256 != wenHashV1(original) || result.RouteSHA256 != wenHashV1(result.RouteBytes) || result.Validity.ObservedSlot != 151 {
				t.Fatal("preview binding lost")
			}
			after, _ := os.ReadFile(path)
			if string(after) != string(original) {
				t.Fatal("preview installed route")
			}
		})
	}
}
func TestWENBTCRoutePreviewServiceRequiresPermission(t *testing.T) {
	service, cfg, review, calls := wenJoinedServiceCase(t, "acquisition", "")
	raw, _ := json.Marshal(review.Intent)
	before := calls.Load()
	_, err := service.handle(request{Op: "v2.wenBtc.route.preview", WalletID: "buyer", Request: raw}, cfg, false)
	if err == nil || !strings.Contains(err.Error(), "refresh is not admitted") {
		t.Fatalf("unexpected result: %v", err)
	}
	if calls.Load() != before {
		t.Fatal("unapproved preview called RPC")
	}
}
