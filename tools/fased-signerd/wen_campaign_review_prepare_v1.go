package main

import (
	"context"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"path/filepath"
	"reflect"
)

type wenCampaignDraftV1 struct {
	ClaimStake                       *wenCampaignClaimStakeDraftV1 `json:",omitempty"`
	Version                          int
	WalletID, WalletPublicKey        string
	Pins                             signerWENBTCPinsV1
	Action                           wenCampaignOwnerActionV1
	MinimumSlot, ExpiresSlot, MaxFee uint64
}
type wenCampaignReviewRequestV1 struct {
	RequestID   string `json:"requestId"`
	DraftSHA256 string `json:"draftSha256"`
}

func loadWENCampaignDraftV1(db, wallet, hash string) (wenCampaignDraftV1, error) {
	var d wenCampaignDraftV1
	if !wenReservationHashV1(hash) {
		return d, errors.New("invalid campaign draft digest")
	}
	root, e := wenCampaignProtectedRootV1(db, wallet)
	if e != nil {
		return d, e
	}
	raw, e := readSignerAdminJSONFile(filepath.Join(root, "draft-"+hash+".json"), 8192)
	if e != nil {
		return d, e
	}
	if wenHashV1(raw) != hash {
		return d, errors.New("campaign draft changed")
	}
	if e = decodeStrictJSONV2(raw, &d); e != nil {
		return d, e
	}
	if d.validate(wallet) != nil {
		return d, errors.New("invalid campaign draft")
	}
	return d, nil
}

// Creates only an unsigned protected review. Operator artifact admission and
// owner approval remain separate; draft creation is not an application privilege.
func (s *signerServiceV2) prepareConfiguredWENCampaignReviewV1(ctx context.Context, cfg signerConfig, wallet string, body wenCampaignReviewRequestV1, factory func(string) wenCampaignExecutionRPCV1) (signerReviewV2, error) {
	var zero signerReviewV2
	bad := errors.New("campaign review configuration changed")
	if s == nil || s.store == nil || s.keys == nil || cfg.readOnly || cfg.stateDBPath != s.store.db.Path() || factory == nil {
		return zero, bad
	}
	if _, e := validateRequestIDV2(body.RequestID); e != nil {
		return zero, e
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return zero, e
	}
	d, e := loadWENCampaignDraftV1(cfg.stateDBPath, wallet, body.DraftSHA256)
	if e != nil {
		return zero, e
	}
	record, e := s.keys.PublicRecord(wallet)
	if e != nil || record.PublicKey != d.WalletPublicKey {
		return zero, bad
	}
	owner, e := solana.PublicKeyFromBase58(record.PublicKey)
	if e != nil {
		return zero, e
	}
	operation, program, genesis := d.identity()
	network, e := s.keys.SolanaNetworkV2(wallet)
	if e != nil || network.GenesisHash != genesis {
		return zero, bad
	}
	policy, e := s.store.getPolicy(wallet)
	if e != nil {
		return zero, e
	}
	if !containsStringV2(policy.Operations, operation) || !containsStringV2(policy.Programs, program) {
		return zero, bad
	}
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "campaign review RPC")
	if e != nil {
		return zero, e
	}
	client := factory(endpoint)
	if client == nil {
		return zero, bad
	}
	p, direct, e := d.prepare(ctx, client, owner)
	if e != nil {
		return zero, e
	}
	latest, e := loadWENCampaignDraftV1(cfg.stateDBPath, wallet, body.DraftSHA256)
	if e != nil || !reflect.DeepEqual(latest, d) {
		return zero, bad
	}
	current, e := s.keys.SolanaNetworkV2(wallet)
	if e != nil || !reflect.DeepEqual(current, network) {
		return zero, bad
	}
	who, e := s.keys.PublicRecord(wallet)
	if e != nil || who.PublicKey != record.PublicKey {
		return zero, bad
	}
	if e = ctx.Err(); e != nil {
		return zero, e
	}
	if d.ClaimStake != nil {
		v := d.ClaimStake
		a, e := newWENCampaignClaimStakeReviewV1(body.RequestID, wallet, policy.Hash, v.Pins, v.Intent, v.Claim, owner, v.MinimumNet, v.MaxTotal, direct)
		if e != nil {
			return zero, e
		}
		return s.store.storeWENCampaignClaimStakeReviewV1(a)
	}
	a, e := newWENCampaignReviewV1(body.RequestID, wallet, policy.Hash, d.Pins, d.Action, owner, p, d.ExpiresSlot, d.MaxFee)
	if e != nil {
		return zero, e
	}
	return s.store.storeWENCampaignReviewV1(a)
}
