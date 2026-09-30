package main

import (
	"context"
	"errors"
	"strconv"
)

// Caller pins are selection inputs only. Each candidate must match protected
// local admission/deployment records; RPC comes from the configured wallet.
type wenMiningClaimRecoveryRequestV1 struct {
	Cursor           string           `json:"cursor"`
	Limit            int              `json:"limit"`
	Operation        string           `json:"operation"`
	Pins             wenStakingPinsV1 `json:"pins"`
	Descriptor       []byte           `json:"descriptor"`
	MinFinalizedSlot string           `json:"minFinalizedSlot"`
	ExpiresSlot      string           `json:"expiresSlot"`
	MaxFeeLamports   string           `json:"maxFeeLamports"`
	MaxSlotLag       string           `json:"maxSlotLag"`
}

func (s *signerServiceV2) recoverWENMiningClaimsWithFactoryV1(ctx context.Context, req request, cfg signerConfig, factory func(string) signerWENBTCReadRPCV1) ([]byte, error) {
	bad := errors.New("invalid mining claim recovery request")
	if len(req.Request) > 65536 {
		return nil, bad
	}
	var body wenMiningClaimRecoveryRequestV1
	if err := decodeSignerAdminStrictJSON(req.Request, &body); err != nil {
		return nil, err
	}
	values := make([]uint64, 4)
	for i, value := range []string{body.MinFinalizedSlot, body.ExpiresSlot, body.MaxFeeLamports, body.MaxSlotLag} {
		n, err := strconv.ParseUint(value, 10, 64)
		if err != nil || strconv.FormatUint(n, 10) != value {
			return nil, bad
		}
		values[i] = n
	}
	minimum, expires, fee, lag := values[0], values[1], values[2], values[3]
	if body.Limit < 1 || body.Limit > 10 || (body.Operation != "sol" && body.Operation != "sat") || minimum == 0 || expires <= minimum || expires-minimum > 32 || fee == 0 || fee > signerNativeFeeReservationV2 || lag == 0 || lag > 32 || body.Cursor != "" && !wenMiningAdmissionFilenameV1(body.Cursor) {
		return nil, bad
	}
	if err := validateWENMiningClaimDescriptorV1(body.Descriptor, body.Pins); err != nil {
		return nil, err
	}
	out, err := s.pollWENMiningAdmissionClaimsV1(ctx, cfg, req.WalletID, body.Cursor, body.Limit, body.Operation, body.Pins, body.Descriptor, minimum, expires, fee, lag, factory)
	if err != nil {
		return nil, err
	}
	return marshalSignerResultV2(out)
}
func (s *signerServiceV2) recoverWENMiningClaimsServiceV1(req request, cfg signerConfig) ([]byte, error) {
	return s.recoverWENMiningClaimsWithFactoryV1(context.Background(), req, cfg, func(endpoint string) signerWENBTCReadRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}
