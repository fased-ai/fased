package main

import (
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

// Internal candidate, deliberately absent from public signing capabilities.
const intentWENStakingV1 = "solana.wenStakingChange"

type signerWENStakingIntentV1 struct {
	Operation        string `json:"operation"`
	DescriptorSHA256 string `json:"descriptorSha256"`
	CapabilitySHA256 string `json:"capabilitySha256"`
	Genesis          string `json:"genesis"`
	ProgramID        string `json:"programId"`
	Sale             string `json:"sale"`
	Mint             string `json:"mint"`
	TokenAccount     string `json:"tokenAccount"`
	Amount           string `json:"amount"`
	Day              string `json:"day"`
	Last             string `json:"last"`
	AggregateFrom    string `json:"aggregateFrom"`
	MaxFeeLamports   string `json:"maxFeeLamports"`
	MinFinalizedSlot string `json:"minFinalizedSlot"`
	ExpiresSlot      string `json:"expiresSlot"`
}

func decodeWENStakingIntentV1(raw []byte) (signerWENStakingIntentV1, error) {
	var v signerWENStakingIntentV1
	if len(raw) == 0 || len(raw) > 4096 {
		return v, errors.New("invalid staking request size")
	}
	if err := decodeStrictJSONV2(raw, &v); err != nil {
		return v, errors.New("invalid staking request")
	}
	return v, validateWENStakingIntentV1(v)
}
func validateWENStakingIntentV1(v signerWENStakingIntentV1) error {
	bad := errors.New("invalid WEN staking candidate")
	if v.Operation != "deposit" && v.Operation != "requestExit" {
		return bad
	}
	for _, s := range []string{v.DescriptorSHA256, v.CapabilitySHA256} {
		if len(s) != 64 {
			return bad
		}
		for _, c := range s {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
				return bad
			}
		}
	}
	for _, s := range []string{v.Genesis, v.ProgramID, v.Sale, v.Mint, v.TokenAccount} {
		p, e := solana.PublicKeyFromBase58(s)
		if e != nil || p.IsZero() || p.String() != s {
			return bad
		}
	}
	values := []string{v.Amount, v.Day, v.Last, v.AggregateFrom, v.MaxFeeLamports, v.MinFinalizedSlot, v.ExpiresSlot}
	ns := make([]uint64, len(values))
	for i, s := range values {
		n, e := strconv.ParseUint(s, 10, 64)
		if e != nil || strconv.FormatUint(n, 10) != s {
			return bad
		}
		ns[i] = n
	}
	// Exit requests cover the whole position and encode zero, not a withdrawal amount.
	if (v.Operation == "deposit" && ns[0] == 0) || (v.Operation == "requestExit" && ns[0] != 0) || ns[1] == ^uint64(0) || ns[2] > ns[1]+1 || ns[3] > ns[1]+1 || ns[4] == 0 || ns[4] > signerNativeFeeReservationV2 || ns[5] == 0 || ns[6] <= ns[5] {
		return bad
	}
	return nil
}
