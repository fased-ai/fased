package main

import (
	"context"
	"errors"
)

// Protected typed boundary; application access requires installed owner configuration. Requests select
// only a protected draft or stored review. Preparation grants no admission;
// execution requires the independently admitted artifact and current deployment.
func (s *signerServiceV2) bondPurchaseApplicationWithFactoryV2(ctx context.Context, req request, cfg signerConfig, factory func(string) wenBondPurchaseExecutionRPCV2) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	switch req.Op {
	case "v2.wenBondPurchase.journey":
		return s.bondPurchaseJourneyWithFactoryV2(ctx, req, cfg, factory)
	case "v2.wenBondPurchase.review.prepare":
		if len(req.Request) == 0 || len(req.Request) > 2048 {
			return nil, errors.New("invalid Bond review request size")
		}
		var body wenBondPurchaseReviewRequestV2
		if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
			return nil, e
		}
		result, e := s.prepareConfiguredWENBondPurchaseReviewV2(ctx, cfg, req.WalletID, body, factory)
		if e != nil {
			return nil, e
		}
		return marshalSignerResultV2(result)
	default:
		return nil, errors.New("unsupported Bond application operation")
	}
}
func (s *signerServiceV2) bondPurchaseApplicationServiceV2(req request, cfg signerConfig) ([]byte, error) {
	return s.bondPurchaseApplicationWithFactoryV2(context.Background(), req, cfg, func(endpoint string) wenBondPurchaseExecutionRPCV2 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}
