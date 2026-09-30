package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Explicit export contains public review data only, never key material.
func TestWENMarketExportClientReview(t *testing.T) {
	dir := os.Getenv("WEN_MARKET_CLIENT_FIXTURE_DIR")
	if dir == "" {
		t.Skip("explicit client fixture export only")
	}
	store, a, _ := marketReviewFixtureV1(t)
	store.now = func() time.Time { return time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC) }
	review, e := store.storeWENMarketReviewV1(a)
	if e != nil {
		t.Fatal(e)
	}
	raw, e := json.MarshalIndent(review, "", "  ")
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, "buy.json"), append(raw, '\n'), 0600); e != nil {
		t.Fatal(e)
	}
}
