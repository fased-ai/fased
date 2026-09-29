package main

import (
	"context"
	"errors"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// Internal configured owner. No caller-supplied endpoint or public dispatch.
func (s *signerServiceV2) executeConfiguredMiningFundingWithFactoryV1(ctx context.Context, cfg signerConfig, request, walletID string, v signerWENMiningFundingIntentV1, factory func(string) wenMiningFundingExecutionRPCV1) (string, string, error) {
	bad := errors.New("configured mining funding execution changed or unavailable")
	if s == nil || s.store == nil || s.keys == nil || cfg.stateDBPath != s.store.db.Path() || factory == nil {
		return "", "", bad
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return "", "", e
	}
	review, w, e := loadWENMiningFundingAdmissionV1(cfg.stateDBPath, walletID, v)
	if e != nil {
		return "", "", e
	}
	record, e := s.keys.PublicRecord(walletID)
	if e != nil || record.PublicKey != w.String() {
		return "", "", bad
	}
	policy, e := s.store.getPolicy(walletID)
	if e != nil || !containsStringV2(policy.Operations, intentWENMiningFundingV1) || !containsStringV2(policy.Programs, v.ProgramID) {
		return "", "", bad
	}
	network, e := s.keys.SolanaNetworkV2(walletID)
	if e != nil || network.GenesisHash != v.Genesis {
		return "", "", bad
	}
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "mining funding configured RPC")
	if e != nil {
		return "", "", e
	}
	guard := func() error {
		if e := ctx.Err(); e != nil {
			return e
		}
		if e := recheckWENMiningFundingReviewV1(cfg.stateDBPath, walletID, v, review, w); e != nil {
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
	return s.executeGuardedWENMiningFundingV1(ctx, client, request, walletID, policy.Hash, v, guard)
}
func (s *signerServiceV2) executeConfiguredWENMiningFundingV1(ctx context.Context, cfg signerConfig, request, walletID string, v signerWENMiningFundingIntentV1) (string, string, error) {
	return s.executeConfiguredMiningFundingWithFactoryV1(ctx, cfg, request, walletID, v, func(endpoint string) wenMiningFundingExecutionRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}
