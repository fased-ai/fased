package main

import (
	"context"
	"errors"
)

type wenMiningClaimReviewPrepareRequestV1 struct {
	RequestID    string                       `json:"requestId"`
	Intent       signerWENMiningClaimIntentV1 `json:"intent"`
	ReviewSHA256 string                       `json:"reviewSha256"`
}

// Preparation creates an unsigned stored review only. It cannot admit new claim
// rights, reserve funds, consume a proof, sign or submit a transaction.
func (s *signerServiceV2) prepareConfiguredWENMiningClaimReviewV1(ctx context.Context, cfg signerConfig, walletID string, body wenMiningClaimReviewPrepareRequestV1, factory func(string) wenMiningClaimExecutionRPCV1) (signerReviewV2, error) {
	var out signerReviewV2
	if _, err := validateRequestIDV2(body.RequestID); err != nil {
		return out, err
	}
	if !wenReservationHashV1(body.ReviewSHA256) {
		return out, errors.New("claim admission hash required")
	}
	_, _, err := s.withConfiguredMiningClaimV1(ctx, cfg, walletID, body.Intent, factory, func(client wenMiningClaimExecutionRPCV1, policyHash string, guard func() error) (string, string, error) {
		if err := guard(); err != nil {
			return "", "", err
		}
		p, err := prepareReviewedWENMiningClaimV1(ctx, client, cfg.stateDBPath, walletID, body.Intent)
		if err != nil {
			return "", "", err
		}
		if p.review.reviewSHA != body.ReviewSHA256 {
			return "", "", errors.New("claim admission hash changed")
		}
		if err := guard(); err != nil {
			return "", "", err
		}
		artifact, _, err := newWENMiningClaimReviewArtifactV1(body.RequestID, walletID, policyHash, body.Intent, p)
		if err != nil {
			return "", "", err
		}
		out, err = s.store.storeWENMiningClaimReviewV1(artifact)
		return "", "", err
	})
	if err != nil {
		return signerReviewV2{}, err
	}
	return out, nil
}

func (s *signerServiceV2) prepareWENMiningClaimReviewServiceV1(req request, cfg signerConfig) ([]byte, error) {
	var body wenMiningClaimReviewPrepareRequestV1
	if len(req.Request) == 0 || len(req.Request) > 8192 {
		return nil, errors.New("invalid claim review preparation size")
	}
	if err := decodeSignerAdminStrictJSON(req.Request, &body); err != nil {
		return nil, err
	}
	out, err := s.prepareConfiguredWENMiningClaimReviewV1(context.Background(), cfg, req.WalletID, body, func(endpoint string) wenMiningClaimExecutionRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
	if err != nil {
		return nil, err
	}
	return marshalSignerResultV2(out)
}
