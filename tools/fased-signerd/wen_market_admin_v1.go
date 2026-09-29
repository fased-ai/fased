package main

import (
	"context"
	"errors"
)

type wenMarketDraftInstallRequestV1 struct {
	Draft          wenMarketDraftV1 `json:"draft"`
	ExpectedSHA256 string           `json:"expectedSha256"`
}
type wenMarketAdmissionInstallRequestV1 struct {
	RequestID      string `json:"requestId"`
	ExpectedSHA256 string `json:"expectedSha256"`
}

func (s *signerServiceV2) marketAdminWithFactoryV1(ctx context.Context, req request, cfg signerConfig, control bool, factory func(string) wenMarketExecutionRPCV1) ([]byte, error) {
	if e := requireControlSocketV2(control); e != nil {
		return nil, e
	}
	if len(req.Request) == 0 || len(req.Request) > 16384 {
		return nil, errors.New("invalid market admin request size")
	}
	switch req.Op {
	case "v2.wenMarket.draft.install":
		var body wenMarketDraftInstallRequestV1
		if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
			return nil, e
		}
		hash, e := s.installWENMarketDraftV1(ctx, cfg, req.WalletID, body.Draft, body.ExpectedSHA256, control, factory)
		if e != nil {
			return nil, e
		}
		return marshalSignerResultV2(map[string]string{"walletId": req.WalletID, "draftSha256": hash, "status": "draft-installed"})
	case "v2.wenMarket.admission.install":
		var body wenMarketAdmissionInstallRequestV1
		if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
			return nil, e
		}
		if _, e := validateRequestIDV2(body.RequestID); e != nil {
			return nil, e
		}
		if !wenReservationHashV1(body.ExpectedSHA256) {
			return nil, errors.New("invalid market admission digest")
		}
		if e := s.installWENMarketAdmissionV1(ctx, cfg, req.WalletID, body.RequestID, body.ExpectedSHA256, control, factory); e != nil {
			return nil, e
		}
		return marshalSignerResultV2(map[string]string{"walletId": req.WalletID, "requestId": body.RequestID, "artifactDigest": body.ExpectedSHA256, "status": "admission-installed"})
	default:
		return nil, errors.New("unsupported market admin operation")
	}
}
func (s *signerServiceV2) marketAdminServiceV1(req request, cfg signerConfig, control bool) ([]byte, error) {
	return s.marketAdminWithFactoryV1(context.Background(), req, cfg, control, func(endpoint string) wenMarketExecutionRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}
