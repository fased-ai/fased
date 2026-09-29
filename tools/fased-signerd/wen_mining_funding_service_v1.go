package main

import (
	"context"
	"errors"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// Read-only service preparation: no signature, reservation, endpoint or reveal
// material is returned. Dispatch exposes only this preview; execution requires separate admission.
type wenMiningFundingServicePreviewV1 struct {
	CapitalLamports  string `json:"capitalLamports"`
	Operation        string `json:"operation"`
	DescriptorSHA256 string `json:"descriptorSha256"`
	Status           string `json:"status"`
	SigningEnabled   bool   `json:"signingEnabled"`
	Slot             uint64 `json:"slot,string"`
	NetworkFee       uint64 `json:"networkFeeLamports,string"`
	Rent             uint64 `json:"rentLamports,string"`
	ComputeUnits     uint64 `json:"computeUnits,string"`
	MessageSHA256    string `json:"messageSha256"`
}

func (s *signerServiceV2) prepareConfiguredWENMiningFundingV1(ctx context.Context, cfg signerConfig, walletID string, v signerWENMiningFundingIntentV1) (wenMiningFundingServicePreviewV1, error) {
	return s.prepareConfiguredMiningFundingWithFactoryV1(ctx, cfg, walletID, v, func(endpoint string) wenMiningPrepareRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}

func (s *signerServiceV2) prepareConfiguredMiningFundingWithFactoryV1(ctx context.Context, cfg signerConfig, walletID string, v signerWENMiningFundingIntentV1, makeClient func(string) wenMiningPrepareRPCV1) (wenMiningFundingServicePreviewV1, error) {
	var out wenMiningFundingServicePreviewV1
	bad := errors.New("configured mining funding preparation unavailable or changed")
	if s == nil || s.store == nil || s.keys == nil || cfg.stateDBPath != s.store.db.Path() || makeClient == nil {
		return out, bad
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return out, e
	}
	config, wallet, e := loadWENMiningFundingAdmissionV1(cfg.stateDBPath, walletID, v)
	if e != nil {
		return out, e
	}
	record, e := s.keys.PublicRecord(walletID)
	if e != nil || record.PublicKey != wallet.String() {
		return out, bad
	}
	policy, e := s.store.getPolicy(walletID)
	if e != nil || !containsStringV2(policy.Operations, intentWENMiningFundingV1) || !containsStringV2(policy.Programs, v.ProgramID) {
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
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "mining funding configured RPC")
	if e != nil {
		return out, bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	client := makeClient(endpoint)
	if client == nil {
		return out, bad
	}
	prepared, e := prepareReviewedWENMiningFundingV1(ctx, client, cfg.stateDBPath, walletID, v)
	if e != nil {
		return out, e
	}
	latest, latestWallet, e := loadWENMiningFundingAdmissionV1(cfg.stateDBPath, walletID, v)
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
	return wenMiningFundingServicePreviewV1{Operation: "portfolio-mining-funding", CapitalLamports: v.Amount, DescriptorSHA256: v.DescriptorSHA256, Status: "requires-signing-revalidation", Slot: prepared.slot, NetworkFee: prepared.fee, Rent: prepared.rent, ComputeUnits: prepared.units, MessageSHA256: wenHashV1(prepared.message)}, nil
}
