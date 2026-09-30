package main

import (
	"context"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
)

// Internal single-step execution owner, not a timer or public Auto capability.
// An indexed action always wins over a new request ID. Recovery does not require
// current signing policy, review files or a wallet signature, and never resends.
// The master key is still needed to read the encrypted saved RPC configuration.
func (s *signerServiceV2) stepConfiguredMiningWithFactoryV1(ctx context.Context, cfg signerConfig, request, walletID string, v signerWENMiningIntentV1, factory func(string) wenMiningExecutionRPCV1) (string, string, error) {
	bad := errors.New("mining step identity or journal unavailable")
	if s == nil || s.store == nil || s.keys == nil || cfg.stateDBPath != s.store.db.Path() || factory == nil {
		return "", "", bad
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return "", "", e
	}
	if e := validateWENMiningIntentV1(v); e != nil {
		return "", "", e
	}
	if _, e := validateRequestIDV2(request); e != nil {
		return "", "", e
	}
	var saved wenBudgetReservationV1
	var existing string
	e := s.store.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		existing = string(b.Get([]byte("mining-action:" + wenHashV1([]byte(v.Genesis+":"+v.ProgramID+":"+v.Entry+":"+v.Operation)))))
		if existing == "" {
			return nil
		}
		if _, e := validateRequestIDV2(existing); e != nil {
			return bad
		}
		if json.Unmarshal(b.Get([]byte("request:"+existing)), &saved) != nil || saved.MiningIntent == nil || *saved.MiningIntent != v || saved.WalletID != walletID || saved.Genesis != v.Genesis || !wenReservationHashV1(saved.Digest) {
			return bad
		}
		return nil
	})
	if e != nil {
		return "", "", e
	}
	if existing == "" {
		return s.executePhaseReadyMiningV1(ctx, cfg, request, walletID, v, factory)
	}
	// A reservation may be resumed only through all configured execution checks.
	if saved.State == "reserved" && saved.MessageSHA256 == "" && saved.Signature == "" {
		return s.executePhaseReadyMiningV1(ctx, cfg, existing, walletID, v, factory)
	}
	switch saved.State {
	case "cancelled":
		return saved.Digest, "cancelled", nil
	case "signing":
		return saved.Digest, "recovery-required", nil
	case "signed", "submission-uncertain", "finalized-success", "finalized-failed":
	default:
		return saved.Digest, "", bad
	}
	record, e := s.keys.PublicRecord(walletID)
	if e != nil || record.PublicKey != saved.WalletPublicKey {
		return saved.Digest, "", bad
	}
	network, e := s.keys.SolanaNetworkV2(walletID)
	if e != nil || network.GenesisHash != saved.Genesis {
		return saved.Digest, "", bad
	}
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "mining recovery RPC")
	if e != nil {
		return saved.Digest, "", e
	}
	client := factory(endpoint)
	if client == nil {
		return saved.Digest, "", bad
	}
	status, e := s.store.recoverWENMiningExecutionV1(ctx, client, existing, saved.Digest)
	return saved.Digest, status, e
}
func (s *signerServiceV2) stepConfiguredWENMiningV1(ctx context.Context, cfg signerConfig, request, walletID string, v signerWENMiningIntentV1) (string, string, error) {
	return s.stepConfiguredMiningWithFactoryV1(ctx, cfg, request, walletID, v, func(endpoint string) wenMiningExecutionRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}
