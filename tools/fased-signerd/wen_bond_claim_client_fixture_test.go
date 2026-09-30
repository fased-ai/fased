package main

import (
	"context"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestWENBondClaimV2ExportPublicReview(t *testing.T) {
	path := os.Getenv("FASED_WEN_BOND_CLAIM_PUBLIC_REVIEW")
	if path == "" {
		t.Skip("explicit public fixture export only")
	}
	if !filepath.IsAbs(path) {
		t.Fatal("absolute public output required")
	}
	store, keys := openTestSignerV2(t)
	record, old := createTestSignerWalletV2(t, store, keys, "miner", solana.PublicKey{1}.String(), 10000, 20000)
	store.now = time.Now
	f, p, policy := bondReadFixtureV2(t, solana.MustPublicKeyFromBase58(record.PublicKey))
	prepared, e := prepareWENBondClaimV2(context.Background(), f, p, policy, 10000, 1000, nil)
	if e != nil {
		t.Fatal(e)
	}
	a, e := newWENBondClaimReviewV2("review-request-001", "miner", old.Hash, prepared)
	if e != nil {
		t.Fatal(e)
	}
	n := strconv.FormatUint(a.MaxFee, 10)
	updated, e := store.putPolicy(signerPolicyV2{WalletID: a.WalletID, Role: old.Role, Operations: []string{wenBondClaimOperationV2}, Programs: a.requiredPrograms(), Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{p.Destination.String()}, MaxPerTx: n, MaxDaily: n}}}, old.Version)
	if e != nil {
		t.Fatal(e)
	}
	a.PolicyHash = updated.Hash
	review, e := store.storeWENBondClaimReviewV2(a)
	if e != nil {
		t.Fatal(e)
	}
	expected := map[string]any{"requestId": a.RequestID, "walletId": a.WalletID, "walletPublicKey": a.WalletPublicKey, "policyHash": a.PolicyHash, "artifactDigest": review.ArtifactDigest, "pins": a.Pins, "policy": a.Policy, "maxFee": a.MaxFee, "retainedLamports": a.RetainedLamports}
	raw, e := json.MarshalIndent(map[string]any{"review": review, "expected": expected}, "", "  ")
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
}
