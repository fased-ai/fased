package main

import (
	"context"
	"errors"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// Internal configured owner. No caller-supplied endpoint or public dispatch.
func (s *signerServiceV2) executeConfiguredMiningClaimWithFactoryV1(ctx context.Context, cfg signerConfig, request, walletID string, v signerWENMiningClaimIntentV1, factory func(string) wenMiningClaimExecutionRPCV1) (string, string, error) {
	return s.withConfiguredMiningClaimV1(ctx, cfg, walletID, v, factory, func(client wenMiningClaimExecutionRPCV1, policyHash string, guard func() error) (string, string, error) {
		return s.executeGuardedWENMiningClaimV1(ctx, client, request, walletID, policyHash, v, guard)
	})
}
func (s *signerServiceV2) withConfiguredMiningClaimV1(ctx context.Context, cfg signerConfig, walletID string, v signerWENMiningClaimIntentV1, factory func(string) wenMiningClaimExecutionRPCV1, execute func(wenMiningClaimExecutionRPCV1, string, func() error) (string, string, error)) (string, string, error) {
	bad := errors.New("configured mining claim execution changed or unavailable")
	if s == nil || s.store == nil || s.keys == nil || cfg.readOnly || cfg.stateDBPath != s.store.db.Path() || (factory == nil || execute == nil) {
		return "", "", bad
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return "", "", e
	}
	review, w, e := loadWENMiningClaimAdmissionV1(cfg.stateDBPath, walletID, v)
	if e != nil {
		return "", "", e
	}
	record, e := s.keys.PublicRecord(walletID)
	if e != nil || record.PublicKey != w.String() {
		return "", "", bad
	}
	policy, e := s.store.getPolicy(walletID)
	if e != nil || !containsStringV2(policy.Operations, intentWENMiningClaimV1) || !containsStringV2(policy.Programs, v.ProgramID) {
		return "", "", bad
	}
	network, e := s.keys.SolanaNetworkV2(walletID)
	if e != nil || network.GenesisHash != v.Genesis {
		return "", "", bad
	}
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "mining claim configured RPC")
	if e != nil {
		return "", "", e
	}
	guard := func() error {
		if e := ctx.Err(); e != nil {
			return e
		}
		if e := recheckWENMiningClaimReviewV1(cfg.stateDBPath, walletID, v, review, w); e != nil {
			return e
		}
		p, e := s.store.getPolicy(walletID)
		if e != nil {
			return e
		}
		n, e := s.keys.SolanaNetworkV2(walletID)
		if e != nil {
			return e
		}
		r, e := s.keys.PublicRecord(walletID)
		if e != nil {
			return e
		}
		if p.Hash != policy.Hash || r.PublicKey != record.PublicKey || !reflect.DeepEqual(n, network) {
			return bad
		}
		return s.store.db.View(func(tx *bolt.Tx) error {
			retired, e := signerWalletIsRetiredInTxV2(tx, walletID)
			if e != nil {
				return e
			}
			if retired {
				return bad
			}
			return nil
		})
	}
	if e = guard(); e != nil {
		return "", "", e
	}
	client := factory(endpoint)
	if client == nil {
		return "", "", bad
	}
	return execute(client, policy.Hash, guard)
}
func (s *signerServiceV2) executeConfiguredWENMiningClaimV1(ctx context.Context, cfg signerConfig, request, walletID string, v signerWENMiningClaimIntentV1) (string, string, error) {
	return s.executeConfiguredMiningClaimWithFactoryV1(ctx, cfg, request, walletID, v, func(endpoint string) wenMiningClaimExecutionRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}
