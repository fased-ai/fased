package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

type wenRefreshProvider func(context.Context, signerWENBTCArtifactsV1, solana.PublicKey, signerWENBTCReviewV1, uint64, uint64, uint64) (*signerWENBTCRouteCandidateV1, error)

func (f wenRefreshProvider) candidate(c context.Context, a signerWENBTCArtifactsV1, w solana.PublicKey, r signerWENBTCReviewV1, s, n, b uint64) (*signerWENBTCRouteCandidateV1, error) {
	return f(c, a, w, r, s, n, b)
}
func TestWENBTCJoinedRouteRefresh(t *testing.T) {
	for _, name := range []string{"valid", "old-expired", "no-permission", "provider-error", "bad-hash", "bad-route", "stale-quote", "expires-during"} {
		t.Run(name, func(t *testing.T) {
			service, cfg, review, _ := wenJoinedServiceCase(t, "acquisition", "")
			root, _, route, err := loadWENBTCReviewV1(cfg.stateDBPath, "buyer", review.Intent)
			if err != nil {
				t.Fatal(err)
			}
			review.Provider = &signerWENBTCProviderReviewV1{SlippageBPS: 50, ExpiresSlot: 160}
			if name == "old-expired" {
				review.RouteValidity.ExpiresSlot = 151
			}
			if name == "no-permission" {
				review.Provider = nil
			}
			if name == "expires-during" {
				review.Provider.ExpiresSlot = 154
			}
			writeWENReviewTest(t, root, review)
			_, review, _, err = loadWENBTCReviewV1(cfg.stateDBPath, "buyer", review.Intent)
			if err != nil {
				t.Fatal(err)
			}
			urls, err := service.keys.SolanaRPCURLsV2("buyer")
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			provider := wenRefreshProvider(func(_ context.Context, a signerWENBTCArtifactsV1, w solana.PublicKey, r signerWENBTCReviewV1, slot, now, slip uint64) (*signerWENBTCRouteCandidateV1, error) {
				calls++
				if slot != 151 || slip != 50 || now == 0 || w.String() != review.WalletPublicKey {
					t.Fatal("refresh not bound to verified state")
				}
				if name == "provider-error" {
					return nil, errors.New("provider unavailable")
				}
				copied := *route
				copied.Data = append([]byte(nil), route.Data...)
				if name == "bad-route" {
					copied.Data[0] = 0
				}
				raw, _ := json.Marshal(copied)
				candidate := &signerWENBTCRouteCandidateV1{routeBytes: raw, routeSHA256: wenHashV1(raw), validity: *r.RouteValidity}
				if name == "bad-hash" {
					candidate.routeSHA256 = "bad"
				}
				if name == "stale-quote" {
					candidate.validity.ObservedSlot = 148
				}
				return candidate, nil
			})
			before, _ := os.ReadFile(filepath.Join(root, "admission.json"))
			candidate, err := refreshWENBTCRouteRPCV1(context.Background(), newSignerOwnedSolanaRPCClientV2(urls[0]), provider, root, review, solana.MustPublicKeyFromBase58(review.WalletPublicKey), uint64(time.Now().Unix()), *route)
			if name == "valid" || name == "old-expired" {
				if err != nil || candidate == nil {
					t.Fatal(err)
				}
			} else if err == nil || candidate != nil {
				t.Fatal("invalid refresh admitted")
			}
			if name == "no-permission" && calls != 0 {
				t.Fatal("unapproved provider called")
			}
			after, _ := os.ReadFile(filepath.Join(root, "admission.json"))
			if string(before) != string(after) {
				t.Fatal("refresh mutated active review")
			}
		})
	}
}
func TestWENBTCProviderRefreshWindow(t *testing.T) {
	for _, name := range []string{"valid", "missing", "expired", "intent-expiry", "slippage", "acceptance"} {
		t.Run(name, func(t *testing.T) {
			r := signerWENBTCReviewV1{Intent: signerWENBTCIntentV1{Operation: "acquisition", MinFinalizedSlot: "100", ExpiresSlot: "200"}, MaxSlotLag: 5, Provider: &signerWENBTCProviderReviewV1{ExpiresSlot: 160}}
			switch name {
			case "missing":
				r.Provider = nil
			case "expired":
				r.Provider.ExpiresSlot = 150
			case "intent-expiry":
				r.Provider.ExpiresSlot = 201
			case "slippage":
				r.Provider.SlippageBPS = 51
			case "acceptance":
				r.Intent.Operation = "acceptance"
			}
			_, err := r.providerRefreshWindow(150)
			if (err == nil) != (name == "valid") {
				t.Fatal("unexpected admission", err)
			}
		})
	}
}
func TestWENBTCProviderProtectedCredential(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "provider-api.key")
	if _, err := loadWENBTCProviderV1(root); err == nil {
		t.Fatal("missing key admitted")
	}
	if err := os.WriteFile(path, []byte("test-key"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadWENBTCProviderV1(root); err != nil {
		t.Fatal(err)
	}
	os.Chmod(path, 0666)
	if _, err := loadWENBTCProviderV1(root); err == nil {
		t.Fatal("writable key admitted")
	}
}
