package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestWENMiningReviewInstallAuthorityV1(t *testing.T) {
	for _, mode := range []string{"application", "readonly", "wrong-db", "wrong-chain", "nil-factory"} {
		t.Run(mode, func(t *testing.T) {
			store, keys := openTestSignerV2(t)
			s := &signerServiceV2{store: store, keys: keys}
			cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
			if mode == "readonly" {
				cfg.readOnly = true
			}
			if mode == "wrong-db" {
				cfg.stateDBPath += "other"
			}
			if mode == "wrong-chain" {
				cfg.chains = []string{"ethereum"}
			}
			called := false
			factory := func(string) wenMiningExecutionRPCV1 { called = true; return nil }
			if mode == "nil-factory" {
				factory = nil
			}
			if _, e := s.installMiningRevealReviewV1(context.Background(), cfg, "miner", wenMiningReviewInstallV1{}, mode != "application", factory); e == nil {
				t.Fatal("invalid authority/config accepted")
			}
			if called {
				t.Fatal("denial reached network")
			}
		})
	}
}
func TestWENMiningReviewInstallUpdateGateV1(t *testing.T) {
	path := filepath.Join(t.TempDir(), "update.lock")
	if e := os.WriteFile(path, []byte("paired-update\n"), 0640); e != nil {
		t.Fatal(e)
	}
	for _, operation := range []string{"v2.wenMining.claimReview.install", "v2.wenMining.review.install", "v2.wenMining.bootstrap.install", "v2.wenMining.preimage.install"} {
		for _, control := range []bool{false, true} {
			if e := enforceApplicationUpdateGate(path, operation, control, os.Geteuid(), os.Getegid()); e == nil {
				t.Fatal("installation during update")
			}
		}
	}

}
