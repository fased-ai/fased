package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWENBondPurchaseV2ExportPublicReview(t *testing.T) {
	path := os.Getenv("FASED_WEN_BOND_PUBLIC_REVIEW")
	if path == "" {
		t.Skip("explicit public fixture export only")
	}
	if !filepath.IsAbs(path) {
		t.Fatal("absolute public output required")
	}
	store, a, _ := bondPurchaseReviewFixtureV2(t)
	review, e := store.storeWENBondPurchaseReviewV2(a)
	if e != nil {
		t.Fatal(e)
	}
	expected := map[string]any{"requestId": a.RequestID, "walletId": a.WalletID, "walletPublicKey": a.WalletPublicKey, "policyHash": a.PolicyHash, "artifactDigest": review.ArtifactDigest, "pins": a.Pins, "policy": a.Policy, "limits": a.Limits}
	raw, e := json.MarshalIndent(map[string]any{"review": review, "expected": expected}, "", "  ")
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
}
