package main

import (
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

// Internal candidate, deliberately absent from public signing capabilities.
const intentWENMiningV1 = "solana.wenMiningCommitment"

type signerWENMiningIntentV1 struct {
	Operation        string `json:"operation"`
	DescriptorSHA256 string `json:"descriptorSha256"`
	CapabilitySHA256 string `json:"capabilitySha256"`
	EntrySHA256      string `json:"entrySha256"`
	CommitmentSHA256 string `json:"commitmentSha256"`
	Genesis          string `json:"genesis"`
	ProgramID        string `json:"programId"`
	Economy          string `json:"economy"`
	Offer            string `json:"offer"`
	CapitalVault     string `json:"capitalVault"`
	Entry            string `json:"entry"`
	Nonce            string `json:"nonce"`
	Capital          string `json:"capital"`
	Open             string `json:"open"`
	MaxFeeLamports   string `json:"maxFeeLamports"`
	MinFinalizedSlot string `json:"minFinalizedSlot"`
	ExpiresSlot      string `json:"expiresSlot"`
}

func decodeWENMiningIntentV1(raw []byte) (signerWENMiningIntentV1, error) {
	var v signerWENMiningIntentV1
	if len(raw) == 0 || len(raw) > 4096 {
		return v, errors.New("invalid mining request size")
	}
	if err := decodeStrictJSONV2(raw, &v); err != nil {
		return v, errors.New("invalid mining request")
	}
	return v, validateWENMiningIntentV1(v)
}
func validateWENMiningIntentV1(v signerWENMiningIntentV1) error {
	bad := errors.New("invalid WEN mining candidate")
	if v.Operation != "commit" && v.Operation != "reveal" {
		return bad
	}
	for _, s := range []string{v.DescriptorSHA256, v.CapabilitySHA256, v.EntrySHA256, v.CommitmentSHA256} {
		if len(s) != 64 {
			return bad
		}
		for _, c := range s {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
				return bad
			}
		}
	}
	for _, s := range []string{v.Genesis, v.ProgramID, v.Economy, v.Offer, v.CapitalVault, v.Entry} {
		p, e := solana.PublicKeyFromBase58(s)
		if e != nil || p.IsZero() || p.String() != s {
			return bad
		}
	}
	values := []string{v.Nonce, v.Capital, v.Open, v.MaxFeeLamports, v.MinFinalizedSlot, v.ExpiresSlot}
	ns := make([]uint64, len(values))
	for i, s := range values {
		n, e := strconv.ParseUint(s, 10, 64)
		if e != nil || strconv.FormatUint(n, 10) != s {
			return bad
		}
		ns[i] = n
	}
	if ns[1] == 0 || ns[2] > uint64(1<<63-1)-900 || ns[3] == 0 || ns[3] > signerNativeFeeReservationV2 || ns[4] == 0 || ns[5] <= ns[4] {
		return bad
	}
	return nil
}
