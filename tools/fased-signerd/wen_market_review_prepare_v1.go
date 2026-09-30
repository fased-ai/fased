package main

import (
	"context"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"path/filepath"
	"reflect"
)

type wenMarketDraftV1 struct {
	Version                   int
	WalletID, WalletPublicKey string
	Pins                      wenMarketBuyPinsV1
	Policy                    wenMarketReadPolicyV1
	Limits                    wenMarketBuyLimitsV1
	MaxFee, RetainedLamports  uint64
}

func (d wenMarketDraftV1) validate(wallet string) error {
	if d.Version != 1 || d.WalletID != wallet || wallet == "" || normalizeWalletID(wallet) != wallet || d.WalletPublicKey != d.Pins.Owner.String() || d.Pins.Owner.IsZero() || d.MaxFee == 0 || d.RetainedLamports > ^uint64(0)-d.MaxFee || d.Limits.RequestedNet == 0 || d.Limits.MaxCash == 0 || d.Policy.Successor.ProgramID != d.Pins.Program.String() || d.Policy.Successor.Genesis != d.Policy.Venue.Genesis || d.Limits.ExpiresSlot <= d.Limits.MinimumSlot || d.Limits.ExpiresSlot-d.Limits.MinimumSlot > 32 {
		return errors.New("invalid Buy draft")
	}
	return nil
}
func (d wenMarketDraftV1) identity() (string, string, string) {
	return wenMarketOperationV1, d.Pins.Program.String(), d.Policy.Successor.Genesis
}
func (d wenMarketDraftV1) prepare(ctx context.Context, c wenMarketExecutionRPCV1, owner solana.PublicKey) (*wenMarketPreparedBuyV1, error) {
	if d.validate(d.WalletID) != nil || owner != d.Pins.Owner {
		return nil, errors.New("Buy draft owner mismatch")
	}
	return prepareWENMarketBuyV1(ctx, c, d.Pins, d.Policy, d.Limits, d.MaxFee, d.RetainedLamports, nil)
}

type wenMarketReviewRequestV1 struct {
	RequestID   string `json:"requestId"`
	DraftSHA256 string `json:"draftSha256"`
}

func loadWENMarketDraftV1(db, wallet, hash string) (wenMarketDraftV1, error) {
	var d wenMarketDraftV1
	if !wenReservationHashV1(hash) {
		return d, errors.New("invalid Buy draft digest")
	}
	root, e := wenCampaignProtectedRootV1(db, wallet)
	if e != nil {
		return d, e
	}
	raw, e := readSignerAdminJSONFile(filepath.Join(root, "market-draft-"+hash+".json"), 8192)
	if e != nil {
		return d, e
	}
	if wenHashV1(raw) != hash {
		return d, errors.New("Buy draft changed")
	}
	if e = decodeStrictJSONV2(raw, &d); e != nil {
		return d, e
	}
	if d.validate(wallet) != nil {
		return d, errors.New("invalid Buy draft")
	}
	return d, nil
}

// Creates only an unsigned protected review. Operator artifact admission and
// owner approval remain separate; draft creation is not an application privilege.
func (s *signerServiceV2) prepareConfiguredWENMarketReviewV1(ctx context.Context, cfg signerConfig, wallet string, body wenMarketReviewRequestV1, factory func(string) wenMarketExecutionRPCV1) (signerReviewV2, error) {
	var zero signerReviewV2
	bad := errors.New("Buy review configuration changed")
	if s == nil || s.store == nil || s.keys == nil || cfg.readOnly || cfg.stateDBPath != s.store.db.Path() || factory == nil {
		return zero, bad
	}
	if _, e := validateRequestIDV2(body.RequestID); e != nil {
		return zero, e
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return zero, e
	}
	d, e := loadWENMarketDraftV1(cfg.stateDBPath, wallet, body.DraftSHA256)
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
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "Buy review RPC")
	if e != nil {
		return zero, e
	}
	client := factory(endpoint)
	if client == nil {
		return zero, bad
	}
	p, e := d.prepare(ctx, client, owner)
	if e != nil {
		return zero, e
	}
	latest, e := loadWENMarketDraftV1(cfg.stateDBPath, wallet, body.DraftSHA256)
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
	currentPolicy, e := s.store.getPolicy(wallet)
	if e != nil || currentPolicy.Hash != policy.Hash {
		return zero, bad
	}
	if e = ctx.Err(); e != nil {
		return zero, e
	}
	a, e := newWENMarketReviewV1(body.RequestID, wallet, policy.Hash, p)
	if e != nil {
		return zero, e
	}
	return s.store.storeWENMarketReviewV1(a)
}
