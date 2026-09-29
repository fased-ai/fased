package main

import (
	"context"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// Typed application boundary with local browser acceptance; installed binding remains separate.
// Requests name a stored review; endpoint and identities come from signer state.
func (s *signerServiceV2) marketJourneyWithFactoryV1(ctx context.Context, req request, cfg signerConfig, factory func(string) wenMarketExecutionRPCV1) ([]byte, error) {
	var body wenMiningClaimJourneyRequestV1
	bad := errors.New("Buy journey unavailable or changed")
	if len(req.Request) == 0 || len(req.Request) > 2048 {
		return nil, bad
	}
	if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
		return nil, e
	}
	if _, e := validateRequestIDV2(body.RequestID); e != nil {
		return nil, e
	}
	if body.Action != "execute" && body.Action != "recover" && body.Action != "cancel" && body.Action != "expire" {
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
	var a wenMarketReviewArtifactV1

	e := s.store.db.View(func(tx *bolt.Tx) error {
		var r signerReviewV2
		if e := json.Unmarshal(tx.Bucket(bucketSignerReviewsV2).Get([]byte(body.RequestID)), &r); e != nil {
			return e
		}
		if r.WalletID != req.WalletID {
			return bad
		}

		if r.ArtifactKind != wenMarketArtifactKindV1 {
			return bad
		}
		return decodeSignerAdminStrictJSON(r.SemanticIntent, &a)
	})
	if e != nil {
		return nil, e
	}
	digest, e := a.digest()
	wallet, requestID, publicKey, genesis := a.WalletID, a.RequestID, a.WalletPublicKey, a.Policy.Successor.Genesis

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
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "Buy RPC")
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
	switch body.Action {
	case "execute":
		digest, state, e = s.executeGuardedWENMarketV1(ctx, client, s.webauthn, req.WalletID, body.RequestID, body.Proof, guard)
	case "recover":
		state, e = s.store.recoverWENMarketV1(ctx, client, body.RequestID, digest)
	case "cancel":
		e = s.store.releaseWENMarketReviewV1(req.WalletID, body.RequestID, digest, "cancelled")
		if e == nil {
			state = "cancelled"
		}
	case "expire":
		e = s.store.expireWENMarketReviewV1(ctx, client, req.WalletID, body.RequestID, digest)
		if e == nil {
			state = "expired"
		}
	}

	if e != nil && state == "" {
		return nil, e
	}
	return marshalSignerResultV2(wenMiningClaimJourneyResultV1{RequestID: body.RequestID, WalletID: req.WalletID, Digest: digest, Outcome: state, RecoveryRequired: e != nil || (state != "finalized-success" && state != "finalized-failed" && state != "cancelled" && state != "expired")})
}
