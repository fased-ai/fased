package main

import (
	"context"
	"errors"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// Read-only service preparation: no signature, reservation, endpoint or reveal
// material is returned. Dispatch exposes only this preview; execution requires separate admission.
type wenBTCClaimServicePreviewV1 struct {
	Operation        string `json:"operation"`
	DescriptorSHA256 string `json:"descriptorSha256"`
	Status           string `json:"status"`
	SigningEnabled   bool   `json:"signingEnabled"`
	Slot             uint64 `json:"slot,string"`
	NetworkFee       uint64 `json:"networkFeeLamports,string"`
	Rent             uint64 `json:"rentLamports,string"`
	NetBTC           uint64 `json:"netBtcRaw,string"`
	ComputeUnits     uint64 `json:"computeUnits,string"`
	MessageSHA256    string `json:"messageSha256"`
}

func (s *signerServiceV2) prepareConfiguredWENBTCClaimV1(ctx context.Context, cfg signerConfig, walletID string, v signerWENBTCClaimIntentV1) (wenBTCClaimServicePreviewV1, error) {
	return s.prepareConfiguredBTCClaimWithFactoryV1(ctx, cfg, walletID, v, func(endpoint string) wenStakingPrepareRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}

func (s *signerServiceV2) prepareConfiguredBTCClaimWithFactoryV1(ctx context.Context, cfg signerConfig, walletID string, v signerWENBTCClaimIntentV1, makeClient func(string) wenStakingPrepareRPCV1) (wenBTCClaimServicePreviewV1, error) {
	var out wenBTCClaimServicePreviewV1
	bad := errors.New("configured BTC claim preparation unavailable or changed")
	if s == nil || s.store == nil || s.keys == nil || cfg.stateDBPath != s.store.db.Path() || makeClient == nil {
		return out, bad
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return out, e
	}
	config, wallet, e := loadWENBTCClaimAdmissionV1(cfg.stateDBPath, walletID, v)
	if e != nil {
		return out, e
	}
	record, e := s.keys.PublicRecord(walletID)
	if e != nil || record.PublicKey != wallet.String() {
		return out, bad
	}
	policy, e := s.store.getPolicy(walletID)
	if e != nil || !containsStringV2(policy.Operations, intentWENBTCClaimV1) || !containsStringV2(policy.Programs, v.ProgramID) {
		return out, bad
	}
	active := func() error {
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
	if e = active(); e != nil {
		return out, e
	}
	network, e := s.keys.SolanaNetworkV2(walletID)
	if e != nil {
		return out, e
	}
	if network.GenesisHash != v.Genesis {
		return out, bad
	}
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "BTC claim configured RPC")
	if e != nil {
		return out, bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	prepared, e := prepareReviewedWENBTCClaimV1(ctx, makeClient(endpoint), cfg.stateDBPath, walletID, v)
	if e != nil {
		return out, e
	}
	latest, latestWallet, e := loadWENBTCClaimAdmissionV1(cfg.stateDBPath, walletID, v)
	if e != nil {
		return out, e
	}
	nextPolicy, e := s.store.getPolicy(walletID)
	if e != nil {
		return out, e
	}
	nextNetwork, e := s.keys.SolanaNetworkV2(walletID)
	if e != nil {
		return out, e
	}
	nextWallet, e := s.keys.PublicRecord(walletID)
	if e != nil {
		return out, e
	}
	if latest.reviewSHA != config.reviewSHA || latestWallet != wallet || nextWallet.PublicKey != record.PublicKey || nextPolicy.Hash != policy.Hash || !reflect.DeepEqual(nextNetwork, network) {
		return out, bad
	}
	if e = active(); e != nil {
		return out, e
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	return wenBTCClaimServicePreviewV1{Operation: "btc-claim", DescriptorSHA256: v.DescriptorSHA256, Status: "requires-signing-revalidation", Slot: prepared.slot, NetworkFee: prepared.fee, Rent: prepared.rent, NetBTC: prepared.state.Amount, ComputeUnits: prepared.units, MessageSHA256: wenHashV1(prepared.message)}, nil
}
