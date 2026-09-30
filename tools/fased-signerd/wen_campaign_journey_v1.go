package main

import (
	"context"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// Guarded service used by the public application dispatch.
// Requests name a stored review; endpoint and identities come from signer state.
func (s *signerServiceV2) campaignJourneyWithFactoryV1(ctx context.Context, req request, cfg signerConfig, factory func(string) wenCampaignExecutionRPCV1) ([]byte, error) {
	var body wenMiningClaimJourneyRequestV1
	bad := errors.New("campaign journey unavailable or changed")
	if len(req.Request) == 0 || len(req.Request) > 2048 {
		return nil, bad
	}
	if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
		return nil, e
	}
	if _, e := validateRequestIDV2(body.RequestID); e != nil {
		return nil, e
	}
	if body.Action != "execute" && body.Action != "recover" && body.Action != "expire" && body.Action != "cancel" {
		return nil, bad
	}
	if (body.Action == "execute" && (body.Proof == nil || body.Proof.ProofID == "")) || (body.Action != "execute" && body.Proof != nil) {
		return nil, bad
	}
	if s == nil || s.store == nil || s.keys == nil || cfg.readOnly || cfg.stateDBPath != s.store.db.Path() || factory == nil {
		return nil, bad
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return nil, e
	}
	var a wenCampaignReviewArtifactV1
	var direct wenCampaignClaimStakeReviewV1
	isDirect := false
	e := s.store.db.View(func(tx *bolt.Tx) error {
		var r signerReviewV2
		if e := json.Unmarshal(tx.Bucket(bucketSignerReviewsV2).Get([]byte(body.RequestID)), &r); e != nil {
			return e
		}
		if r.WalletID != req.WalletID {
			return bad
		}
		if r.ArtifactKind == wenCampaignClaimStakeArtifactKindV1 {
			isDirect = true
			return decodeSignerAdminStrictJSON(r.SemanticIntent, &direct)
		}
		if r.ArtifactKind != wenCampaignArtifactKindV1 {
			return bad
		}
		return decodeSignerAdminStrictJSON(r.SemanticIntent, &a)
	})
	if e != nil {
		return nil, e
	}
	digest, e := a.digest()
	wallet, requestID, publicKey, genesis := a.WalletID, a.RequestID, a.WalletPublicKey, a.Pins.Genesis
	if isDirect {
		digest, e = direct.digest()
		wallet, requestID, publicKey, genesis = direct.WalletID, direct.RequestID, direct.WalletPublicKey, direct.Pins.Genesis
	}
	if e != nil {
		return nil, e
	}
	if requestID != body.RequestID || wallet != req.WalletID {
		return nil, bad
	}
	record, e := s.keys.PublicRecord(req.WalletID)
	if e != nil || record.PublicKey != publicKey {
		return nil, bad
	}
	network, e := s.keys.SolanaNetworkV2(req.WalletID)
	if e != nil || network.GenesisHash != genesis {
		return nil, bad
	}
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "campaign RPC")
	if e != nil {
		return nil, e
	}
	guard := func() error {
		if e := ctx.Err(); e != nil {
			return e
		}
		n, e := s.keys.SolanaNetworkV2(req.WalletID)
		if e != nil || !reflect.DeepEqual(n, network) {
			return bad
		}
		r, e := s.keys.PublicRecord(req.WalletID)
		if e != nil || r.PublicKey != record.PublicKey {
			return bad
		}
		return nil
	}
	if e = guard(); e != nil {
		return nil, e
	}
	client := factory(endpoint)
	if client == nil {
		return nil, bad
	}
	if e = guard(); e != nil {
		return nil, e
	}
	state := ""
	if isDirect {
		switch body.Action {
		case "execute":
			digest, state, e = s.executeGuardedWENCampaignClaimStakeV1(ctx, client, s.webauthn, req.WalletID, body.RequestID, body.Proof, guard)
		case "recover":
			state, e = s.store.recoverWENCampaignClaimStakeV1(ctx, client, body.RequestID, digest)
		case "expire":
			e = s.store.expireWENCampaignClaimStakeSigningV1(ctx, client, req.WalletID, body.RequestID, digest)
			if e == nil {
				state = "expired"
			}
		case "cancel":
			e = s.store.releaseWENCampaignClaimStakeReviewV1(req.WalletID, body.RequestID, digest, "cancelled")
			if e == nil {
				state = "cancelled"
			}
		}
	} else {
		switch body.Action {
		case "execute":
			digest, state, e = s.executeGuardedWENCampaignV1(ctx, client, s.webauthn, req.WalletID, body.RequestID, body.Proof, guard)
		case "recover":
			state, e = s.store.recoverWENCampaignV1(ctx, client, body.RequestID, digest)
		case "expire":
			e = s.store.expireWENCampaignSigningV1(ctx, client, req.WalletID, body.RequestID, digest)
			if e == nil {
				state = "expired"
			}
		case "cancel":
			e = s.store.releaseWENCampaignReviewV1(req.WalletID, body.RequestID, digest, "cancelled")
			if e == nil {
				state = "cancelled"
			}
		}
	}
	if e != nil && state == "" {
		return nil, e
	}
	return marshalSignerResultV2(wenMiningClaimJourneyResultV1{RequestID: body.RequestID, WalletID: req.WalletID, Digest: digest, Outcome: state, RecoveryRequired: e != nil || (state != "finalized-success" && state != "finalized-failed" && state != "cancelled" && state != "expired")})
}
