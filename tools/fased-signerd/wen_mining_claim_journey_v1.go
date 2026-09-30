package main

import (
	"context"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"time"
)

type wenMiningClaimJourneyRequestV1 struct {
	RequestID string                          `json:"requestId"`
	Action    string                          `json:"action"`
	Proof     *signerWebAuthnProofReferenceV2 `json:"proof,omitempty"`
}
type wenMiningClaimJourneyResultV1 struct {
	RequestID        string `json:"requestId"`
	WalletID         string `json:"walletId"`
	Digest           string `json:"digest"`
	Outcome          string `json:"outcome"`
	RecoveryRequired bool   `json:"recoveryRequired"`
}

// The application names a stored review only. Recovery never signs or resends,
// including when an earlier execute response was lost.
func (s *signerServiceV2) miningClaimJourneyWithFactoryV1(ctx context.Context, req request, cfg signerConfig, factory func(string) wenMiningClaimExecutionRPCV1) ([]byte, error) {
	var body wenMiningClaimJourneyRequestV1
	if len(req.Request) == 0 || len(req.Request) > 2048 {
		return nil, errors.New("invalid claim journey size")
	}
	if err := decodeSignerAdminStrictJSON(req.Request, &body); err != nil {
		return nil, err
	}
	if _, err := validateRequestIDV2(body.RequestID); err != nil {
		return nil, err
	}
	if body.Action != "execute" && body.Action != "recover" {
		return nil, errors.New("invalid claim journey action")
	}
	if body.Action == "execute" && (body.Proof == nil || body.Proof.ProofID == "") {
		return nil, errors.New("claim proof required")
	}
	if body.Action == "recover" && body.Proof != nil {
		return nil, errors.New("recovery takes no proof")
	}
	if s == nil || s.store == nil || s.keys == nil || cfg.readOnly || cfg.stateDBPath != s.store.db.Path() || factory == nil {
		return nil, errors.New("claim journey unavailable")
	}
	if err := cfg.ensureChainAllowed("solana"); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	var saved wenBudgetReservationV1
	found := false
	err := s.store.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return nil
		}
		raw := b.Get([]byte("request:" + body.RequestID))
		if raw == nil {
			return nil
		}
		found = true
		if json.Unmarshal(raw, &saved) != nil || saved.WalletID != req.WalletID || saved.MiningClaimIntent == nil || saved.MiningClaimPrepared == nil {
			return errors.New("claim journal identity mismatch")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	result := wenMiningClaimJourneyResultV1{RequestID: body.RequestID, WalletID: req.WalletID}
	if found && (saved.State == "reserved" || saved.State == "cancelled") {
		if err := s.store.cancelWENReservationV1(body.RequestID, saved.Digest); err != nil {
			return nil, err
		}
		result.Digest, result.Outcome = saved.Digest, "cancelled"
		return marshalSignerResultV2(result)
	}
	if found {
		// Reconcile by the journal's identity, independent of expired approval rights.
		record, e := s.keys.PublicRecord(req.WalletID)
		if e != nil || record.PublicKey != saved.WalletPublicKey {
			return nil, errors.New("claim recovery wallet changed")
		}
		network, e := s.keys.SolanaNetworkV2(req.WalletID)
		if e != nil || network.GenesisHash != saved.MiningClaimIntent.Genesis {
			return nil, errors.New("claim recovery network changed")
		}
		endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "claim recovery RPC")
		if e != nil {
			return nil, e
		}
		client := factory(endpoint)
		if client == nil {
			return nil, errors.New("claim recovery RPC unavailable")
		}
		result.Digest = saved.Digest
		result.Outcome, err = s.store.recoverWENMiningClaimExecutionV1(ctx, client, body.RequestID, saved.Digest)
	} else {
		if body.Action == "recover" {
			return nil, errors.New("claim journal not found; do not infer non-submission")
		}
		// Reject unknown/revoked proofs before allocating a reservation. Consumption
		// remains atomic with the reservation in authorizeWENMiningClaimV1.
		err = s.store.db.View(func(tx *bolt.Tx) error {
			review, _, expected, e := loadReviewAndPolicyForAuthorizationV2(tx, req.WalletID, body.RequestID, s.store.now().UTC())
			if e != nil {
				return e
			}
			if review.IntentType != intentWENMiningClaimV1 {
				return errors.New("not a mining claim approval")
			}
			var proof signerReviewProofRecordV2
			if json.Unmarshal(tx.Bucket(bucketSignerReviewProofsV2).Get([]byte(body.Proof.ProofID)), &proof) != nil || proof.ID != body.Proof.ProofID || proof.State != signerReviewProofPending || !equalSignerReviewBindingV2(proof.Binding, expected) {
				return errors.New("claim proof does not match review")
			}
			expiry, e := time.Parse(time.RFC3339Nano, proof.ExpiresAt)
			if e != nil || !expiry.After(s.store.now().UTC()) {
				return errors.New("claim proof expired")
			}
			_, id, e := normalizeSignerWebAuthnCredentialIDV2(proof.CredentialID)
			if e != nil || tx.Bucket(bucketSignerWebAuthnCredentialsV2).Get(signerWebAuthnCredentialKeyV2(id)) == nil {
				return errors.New("claim credential revoked")
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		result.Digest, result.Outcome, err = s.executeConfiguredHumanWENMiningClaimV1(ctx, cfg, req.WalletID, body.RequestID, s.webauthn, body.Proof, factory)
	}
	if err != nil && result.Digest != "" && result.Outcome == "reserved" {
		if cancelErr := s.store.cancelWENReservationV1(body.RequestID, result.Digest); cancelErr == nil {
			result.Outcome, err = "cancelled", nil
		}
	}
	if err != nil && result.Digest == "" {
		return nil, err
	}
	result.RecoveryRequired = err != nil || (result.Outcome != "finalized-success" && result.Outcome != "finalized-failed" && result.Outcome != "cancelled")
	return marshalSignerResultV2(result)
}

func (s *signerServiceV2) miningClaimJourneyServiceV1(req request, cfg signerConfig) ([]byte, error) {
	return s.miningClaimJourneyWithFactoryV1(context.Background(), req, cfg, func(endpoint string) wenMiningClaimExecutionRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}
