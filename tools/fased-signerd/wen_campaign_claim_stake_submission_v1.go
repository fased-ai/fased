package main

import (
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

// Only verified signatures over the immutable approved message are journaled.
func (s *signerStoreV2) recordWENCampaignClaimStakeSignatureV1(wallet, request, digest string, p *wenCampaignClaimStakePreparedV1, signature string) error {
	return s.transitionWENCampaignClaimStakeSigningV1(wallet, request, digest, p, "signing", "signed", signature)
}

// Fresh protected preparation is required after signing. Persist uncertainty
// before releasing wire bytes; a retry must reconcile instead of sending again.
// This internal primitive neither fetches RPC nor sends a transaction.
func (s *signerStoreV2) commitWENCampaignClaimStakeSubmissionV1(wallet, request, digest string, p *wenCampaignClaimStakePreparedV1) ([]byte, error) {
	if s == nil || s.db == nil || p == nil {
		return nil, errors.New("missing campaign submission")
	}
	var saved wenCampaignClaimStakeReservationV1
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return errors.New("missing campaign reservation")
		}
		return json.Unmarshal(b.Get([]byte("campaign-stake-request:"+request)), &saved)
	})
	if err != nil {
		return nil, err
	}
	sig, err := solana.SignatureFromBase58(saved.Signature)
	if err != nil {
		return nil, err
	}
	if len(p.message)+65 > 1232 {
		return nil, errors.New("campaign message too large")
	}
	if err = s.transitionWENCampaignClaimStakeSigningV1(wallet, request, digest, p, "signed", "submission-uncertain", saved.Signature); err != nil {
		return nil, err
	}
	wire := make([]byte, 65+len(p.message))
	wire[0] = 1
	copy(wire[1:65], sig[:])
	copy(wire[65:], p.message)
	return wire, nil
}
