package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

func TestWENBTCJoinedRouteInstall(t *testing.T) {
	for _, name := range []string{"valid", "stale-review", "bad-hash", "expired", "locked", "artifact-conflict", "simulation-fails", "slippage"} {
		t.Run(name, func(t *testing.T) {
			mutation := ""
			if name == "simulation-fails" {
				mutation = "simulation-error"
			}
			service, cfg, review, _ := wenJoinedServiceCase(t, "acquisition", mutation)
			root, _, route, err := loadWENBTCReviewV1(cfg.stateDBPath, "buyer", review.Intent)
			if err != nil {
				t.Fatal(err)
			}
			review.Provider = &signerWENBTCProviderReviewV1{ExpiresSlot: 160, SlippageBPS: 50}
			if name == "slippage" {
				review.Provider.SlippageBPS = 0
			}
			writeWENReviewTest(t, root, review)
			path := filepath.Join(root, "admission.json")
			original, _ := os.ReadFile(path)
			raw, _ := json.Marshal(route)
			preview := signerWENBTCRoutePreviewV1{Status: "requires-route-review", Operation: "acquisition", DescriptorSHA256: review.Intent.DescriptorSHA256, OfferSHA256: review.Intent.OfferSHA256, BaseReviewSHA256: wenHashV1(original), RouteSHA256: wenHashV1(raw), RouteBytes: raw, Validity: signerWENBTCRouteValidityV1{ObservedSlot: 150, ExpiresSlot: 160}}
			switch name {
			case "stale-review":
				preview.BaseReviewSHA256 = strings.Repeat("0", 64)
			case "bad-hash":
				preview.RouteSHA256 = strings.Repeat("0", 64)
			case "expired":
				preview.Validity.ExpiresSlot = 155
			case "locked":
				lock, e := acquireSignerEnrollmentLock(filepath.Join(root, ".route-install.lock"))
				if e != nil {
					t.Fatal(e)
				}
				defer func() { syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); lock.Close() }()
			case "artifact-conflict":
				os.WriteFile(filepath.Join(root, preview.BaseReviewSHA256), []byte("unrelated"), 0600)
			}
			urls, err := service.keys.SolanaRPCURLsV2("buyer")
			if err != nil {
				t.Fatal(err)
			}
			hash, err := installWENBTCRouteV1(context.Background(), newSignerOwnedSolanaRPCClientV2(urls[0]), cfg.stateDBPath, "buyer", review.Intent, solana.MustPublicKeyFromBase58(review.WalletPublicKey), preview, uint64(time.Now().Unix()))
			after, _ := os.ReadFile(path)
			if name != "valid" {
				if err == nil || hash != "" {
					t.Fatal("invalid install accepted")
				}
				if string(after) != string(original) {
					t.Fatal("failed install changed review")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if hash != wenHashV1(after) || hash == preview.BaseReviewSHA256 {
				t.Fatal("installed version binding lost")
			}
			_, updated, _, err := loadWENBTCReviewV1(cfg.stateDBPath, "buyer", review.Intent)
			if err != nil {
				t.Fatal(err)
			}
			if updated.RouteSHA256 != preview.RouteSHA256 || updated.RouteValidity.ExpiresSlot != 160 {
				t.Fatal("wrong route installed")
			}
			saved, err := readWENBTCObjectV1(root, preview.BaseReviewSHA256, 32768)
			if err != nil || string(saved) != string(original) {
				t.Fatal("prior review not preserved")
			}
			// Replay must fail before network calls or a second installation.
			if _, err = installWENBTCRouteV1(context.Background(), nil, cfg.stateDBPath, "buyer", review.Intent, solana.MustPublicKeyFromBase58(review.WalletPublicKey), preview, uint64(time.Now().Unix())); err == nil {
				t.Fatal("stale candidate replay accepted")
			}
		})
	}
}
