package main

import (
	"context"
	"errors"
)

// Public requests select only a protected draft or stored review. This does not
// install operator admission or accept a deployment; execution still checks both
// artifact admission and current on-chain deployment through the guarded service.
func (s *signerServiceV2) campaignApplicationWithFactoryV1(ctx context.Context, req request, cfg signerConfig, factory func(string) wenCampaignExecutionRPCV1) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	switch req.Op {
	case "v2.wenCampaign.journey":
		return s.campaignJourneyWithFactoryV1(ctx, req, cfg, factory)
	case "v2.wenCampaign.review.prepare":
		if len(req.Request) == 0 || len(req.Request) > 2048 {
			return nil, errors.New("invalid campaign review request size")
		}
		var body wenCampaignReviewRequestV1
		if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
			return nil, e
		}
		result, e := s.prepareConfiguredWENCampaignReviewV1(ctx, cfg, req.WalletID, body, factory)
		if e != nil {
			return nil, e
		}
		return marshalSignerResultV2(result)
	default:
		return nil, errors.New("unsupported campaign application operation")
	}
}
func (s *signerServiceV2) campaignApplicationServiceV1(req request, cfg signerConfig) ([]byte, error) {
	return s.campaignApplicationWithFactoryV1(context.Background(), req, cfg, func(endpoint string) wenCampaignExecutionRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}
