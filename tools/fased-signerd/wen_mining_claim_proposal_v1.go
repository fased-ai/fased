package main

import (
	"context"
	"errors"
	"reflect"
	"strconv"
)

type wenMiningClaimProposalV1 struct {
	Intent           signerWENMiningClaimIntentV1 `json:"intent"`
	BaseReviewSHA256 string                       `json:"baseReviewSha256"`
	ObservedSlot     uint64                       `json:"observedSlot"`
	SigningEnabled   bool                         `json:"signingEnabled"`
}

// Refresh a known protected claim, never infer deployment authority from RPC.
// No directory creation, review publication, reservation, key access or send.
func (s *signerServiceV2) proposeConfiguredWENMiningClaimV1(ctx context.Context, cfg signerConfig, walletID string, base signerWENMiningClaimIntentV1, reviewSHA string, minimum, expires uint64, factory func(string) signerWENBTCReadRPCV1) (wenMiningClaimProposalV1, error) {
	var out wenMiningClaimProposalV1
	bad := errors.New("mining claim proposal rejected")
	if s == nil || s.store == nil || s.keys == nil || cfg.stateDBPath != s.store.db.Path() || factory == nil || !wenReservationHashV1(reviewSHA) {
		return out, bad
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return out, e
	}
	c, w, e := loadWENMiningClaimAdmissionV1(cfg.stateDBPath, walletID, base)
	if e != nil || c.reviewSHA != reviewSHA {
		return out, bad
	}
	v := base
	v.MinFinalizedSlot = strconv.FormatUint(minimum, 10)
	v.ExpiresSlot = strconv.FormatUint(expires, 10)
	oldMinimum, _ := strconv.ParseUint(base.MinFinalizedSlot, 10, 64)
	if minimum < oldMinimum || validateWENMiningClaimIntentV1(v) != nil {
		return out, bad
	}
	record, e := s.keys.PublicRecord(walletID)
	if e != nil || record.PublicKey != w.String() {
		return out, bad
	}
	network, e := s.keys.SolanaNetworkV2(walletID)
	if e != nil || network.GenesisHash != v.Genesis {
		return out, bad
	}
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "claim proposal RPC")
	if e != nil {
		return out, e
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	client := factory(endpoint)
	if client == nil {
		return out, bad
	}
	observed, e := readWENMiningClaimRPCV1(ctx, client, c.pins, v, w, c.maxSlotLag)
	if e != nil {
		return out, e
	}
	if e = recheckWENMiningClaimReviewV1(cfg.stateDBPath, walletID, base, c, w); e != nil {
		return out, e
	}
	latest, e := s.keys.SolanaNetworkV2(walletID)
	if e != nil || !reflect.DeepEqual(latest, network) {
		return out, bad
	}
	public, e := s.keys.PublicRecord(walletID)
	if e != nil || public.PublicKey != record.PublicKey {
		return out, bad
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	v.AccountStateSHA256 = observed.StateHash
	return wenMiningClaimProposalV1{Intent: v, BaseReviewSHA256: reviewSHA, ObservedSlot: observed.Slot}, nil
}

// Read-only service; exact admission remains a separate owner-control action.
func (s *signerServiceV2) proposeWENMiningClaimServiceV1(req request, cfg signerConfig) ([]byte, error) {
	var body struct {
		Base             signerWENMiningClaimIntentV1 `json:"base"`
		ReviewSHA256     string                       `json:"reviewSha256"`
		MinFinalizedSlot string                       `json:"minFinalizedSlot"`
		ExpiresSlot      string                       `json:"expiresSlot"`
	}
	if len(req.Request) > 8192 {
		return nil, errors.New("claim proposal too large")
	}
	if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
		return nil, e
	}
	minimum, e := strconv.ParseUint(body.MinFinalizedSlot, 10, 64)
	if e != nil || strconv.FormatUint(minimum, 10) != body.MinFinalizedSlot {
		return nil, errors.New("invalid proposal minimum")
	}
	expires, e := strconv.ParseUint(body.ExpiresSlot, 10, 64)
	if e != nil || strconv.FormatUint(expires, 10) != body.ExpiresSlot {
		return nil, errors.New("invalid proposal expiry")
	}
	out, e := s.proposeConfiguredWENMiningClaimV1(context.Background(), cfg, req.WalletID, body.Base, body.ReviewSHA256, minimum, expires, func(endpoint string) signerWENBTCReadRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
	if e != nil {
		return nil, e
	}
	return marshalSignerResultV2(out)
}
