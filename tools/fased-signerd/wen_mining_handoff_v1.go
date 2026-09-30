package main

import (
	"context"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"time"
)

// Connect a completed commit to its separately reviewed reveal. Existing reveal
// recovery takes precedence over proposing new slot bounds or demanding review.
// The caller persists request identities; the action index prevents replacement.
func (s *signerServiceV2) continueMiningRevealWithFactoryV1(ctx context.Context, cfg signerConfig, commitRequest, revealRequest, walletID string, minimum, expires uint64, interval time.Duration, maxTicks int, factory func(string) wenMiningExecutionRPCV1) (signerWENMiningIntentV1, string, string, error) {
	var proposal signerWENMiningIntentV1
	bad := errors.New("mining handoff journal mismatch")
	if s == nil || s.store == nil || s.keys == nil || cfg.stateDBPath != s.store.db.Path() || factory == nil {
		return proposal, "", "", bad
	}
	if interval < time.Second || interval > time.Minute || maxTicks < 1 || maxTicks > 1000 {
		return proposal, "", "", bad
	}
	for _, request := range []string{commitRequest, revealRequest} {
		if _, e := validateRequestIDV2(request); e != nil {
			return proposal, "", "", e
		}
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return proposal, "", "", e
	}
	var commit wenBudgetReservationV1
	var reveal *signerWENMiningIntentV1
	e := s.store.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		if json.Unmarshal(b.Get([]byte("request:"+commitRequest)), &commit) != nil || commit.WalletID != walletID || commit.MiningIntent == nil || validateWENMiningIntentV1(*commit.MiningIntent) != nil || commit.MiningIntent.Operation != "commit" {
			return bad
		}
		v := *commit.MiningIntent
		base := v.Genesis + ":" + v.ProgramID + ":" + v.Entry + ":"
		if string(b.Get([]byte("mining-action:"+wenHashV1([]byte(base+"commit"))))) != commitRequest {
			return bad
		}
		existing := string(b.Get([]byte("mining-action:" + wenHashV1([]byte(base+"reveal")))))
		if existing == "" {
			return nil
		}
		var saved wenBudgetReservationV1
		if json.Unmarshal(b.Get([]byte("request:"+existing)), &saved) != nil || saved.WalletID != walletID || saved.WalletPublicKey != commit.WalletPublicKey || saved.MiningIntent == nil || validateWENMiningIntentV1(*saved.MiningIntent) != nil {
			return bad
		}
		next := *saved.MiningIntent
		expected := v
		expected.Operation = "reveal"
		expected.EntrySHA256 = next.EntrySHA256
		expected.MinFinalizedSlot = next.MinFinalizedSlot
		expected.ExpiresSlot = next.ExpiresSlot
		if next != expected {
			return bad
		}
		reveal = &next
		return nil
	})
	if e != nil {
		return proposal, "", "", e
	}
	if reveal != nil {
		digest, status, e := s.runConfiguredMiningWithFactoryV1(ctx, cfg, revealRequest, walletID, *reveal, interval, maxTicks, factory)
		return *reveal, digest, status, e
	}
	digest, status, e := s.runConfiguredMiningWithFactoryV1(ctx, cfg, commitRequest, walletID, *commit.MiningIntent, interval, maxTicks, factory)
	if e != nil || status != "finalized-success" {
		return proposal, digest, status, e
	}
	proposal, e = s.store.proposeWENMiningRevealV1(commitRequest, walletID, minimum, expires)
	if e != nil {
		return proposal, digest, "", e
	}
	if _, _, e = loadWENMiningReviewV1(cfg.stateDBPath, walletID, proposal); e != nil {
		return proposal, "", "requires-review", nil
	}
	digest, status, e = s.runConfiguredMiningWithFactoryV1(ctx, cfg, revealRequest, walletID, proposal, interval, maxTicks, factory)
	return proposal, digest, status, e
}
func (s *signerServiceV2) continueConfiguredMiningRevealV1(ctx context.Context, cfg signerConfig, commitRequest, revealRequest, walletID string, minimum, expires uint64, interval time.Duration, maxTicks int) (signerWENMiningIntentV1, string, string, error) {
	return s.continueMiningRevealWithFactoryV1(ctx, cfg, commitRequest, revealRequest, walletID, minimum, expires, interval, maxTicks, func(endpoint string) wenMiningExecutionRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}
