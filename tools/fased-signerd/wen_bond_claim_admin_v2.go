package main

import (
	"context"
	"errors"
)

type wenBondClaimDraftInstallRequestV2 struct {
	Draft          wenBondClaimDraftV2 `json:"draft"`
	ExpectedSHA256 string              `json:"expectedSha256"`
}
type wenBondClaimAdmissionInstallRequestV2 struct {
	RequestID      string `json:"requestId"`
	ExpectedSHA256 string `json:"expectedSha256"`
}

func (s *signerServiceV2) bondClaimAdminWithFactoryV2(ctx context.Context, req request, cfg signerConfig, control bool, factory func(string) wenBondClaimExecutionRPCV2) ([]byte, error) {
	if e := requireControlSocketV2(control); e != nil {
		return nil, e
	}
	if len(req.Request) == 0 || len(req.Request) > 16384 {
		return nil, errors.New("invalid Bond admin request size")
	}
	switch req.Op {
	case "v2.wenBondClaim.draft.install":
		var body wenBondClaimDraftInstallRequestV2
		if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
			return nil, e
		}
		hash, e := s.installWENBondClaimDraftV2(ctx, cfg, req.WalletID, body.Draft, body.ExpectedSHA256, control, factory)
		if e != nil {
			return nil, e
		}
		return marshalSignerResultV2(map[string]string{"walletId": req.WalletID, "draftSha256": hash, "status": "draft-installed"})
	case "v2.wenBondClaim.admission.install":
		var body wenBondClaimAdmissionInstallRequestV2
		if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
			return nil, e
		}
		if _, e := validateRequestIDV2(body.RequestID); e != nil {
			return nil, e
		}
		if !wenReservationHashV1(body.ExpectedSHA256) {
			return nil, errors.New("invalid Bond admission digest")
		}
		if e := s.installWENBondClaimAdmissionV2(ctx, cfg, req.WalletID, body.RequestID, body.ExpectedSHA256, control, factory); e != nil {
			return nil, e
		}
		return marshalSignerResultV2(map[string]string{"walletId": req.WalletID, "requestId": body.RequestID, "artifactDigest": body.ExpectedSHA256, "status": "admission-installed"})
	default:
		return nil, errors.New("unsupported Bond admin operation")
	}
}
func (s *signerServiceV2) bondClaimAdminServiceV2(req request, cfg signerConfig, control bool) ([]byte, error) {
	return s.bondClaimAdminWithFactoryV2(context.Background(), req, cfg, control, func(endpoint string) wenBondClaimExecutionRPCV2 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}
