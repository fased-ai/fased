package main

import (
	"context"
	"errors"
)

// Protected typed boundary; application access requires installed owner configuration. Requests select
// only a protected draft or stored review. Preparation grants no admission;
// execution requires the independently admitted artifact and current deployment.
func (s *signerServiceV2) marketApplicationWithFactoryV1(ctx context.Context, req request, cfg signerConfig, factory func(string) wenMarketExecutionRPCV1) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	switch req.Op {
	case "v2.wenMarket.journey":
		return s.marketJourneyWithFactoryV1(ctx, req, cfg, factory)
	case "v2.wenMarket.review.prepare":
		if len(req.Request) == 0 || len(req.Request) > 2048 {
			return nil, errors.New("invalid Buy review request size")
		}
		var body wenMarketReviewRequestV1
		if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
			return nil, e
		}
		result, e := s.prepareConfiguredWENMarketReviewV1(ctx, cfg, req.WalletID, body, factory)
		if e != nil {
			return nil, e
		}
		return marshalSignerResultV2(result)
	default:
		return nil, errors.New("unsupported Buy application operation")
	}
}
func (s *signerServiceV2) marketApplicationServiceV1(req request, cfg signerConfig) ([]byte, error) {
	return s.marketApplicationWithFactoryV1(context.Background(), req, cfg, func(endpoint string) wenMarketExecutionRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}
