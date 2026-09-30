package main

import (
	"errors"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
)

const intentWENBTCSubscriptionV1 = "solana.wenBtcSubscription"

// Candidate semantic request. The signer must load the immutable offer and
// descriptor itself; this is not a raw transaction or a signing capability.
type signerWENBTCIntentV1 struct {
	Operation        string `json:"operation"`
	DescriptorSHA256 string `json:"descriptorSha256"`
	CapabilitySHA256 string `json:"capabilitySha256"`
	OfferSHA256      string `json:"offerSha256"`
	Genesis          string `json:"genesis"`
	ProgramID        string `json:"programId"`
	SourceAccount    string `json:"sourceAccount"`
	MaxCashRaw       string `json:"maxCashRaw"`
	MaxCostRaw       string `json:"maxCostRaw"`
	MaxFeeLamports   string `json:"maxFeeLamports"`
	MaxRentLamports  string `json:"maxRentLamports"`
	MinFinalizedSlot string `json:"minFinalizedSlot"`
	ExpiresSlot      string `json:"expiresSlot"`
}

func validateWENBTCIntentV1(v signerWENBTCIntentV1) error {
	if v.Operation != "acceptance" && v.Operation != "acquisition" {
		return errors.New("unsupported WEN BTC operation")
	}
	for _, digest := range []string{v.DescriptorSHA256, v.CapabilitySHA256, v.OfferSHA256} {
		if len(digest) != 64 {
			return errors.New("invalid WEN BTC digest")
		}
		for _, c := range digest {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
				return errors.New("invalid WEN BTC digest")
			}
		}
	}
	for _, address := range []string{v.Genesis, v.ProgramID, v.SourceAccount} {
		p, err := solana.PublicKeyFromBase58(address)
		if err != nil || p.IsZero() || p.String() != address {
			return errors.New("invalid WEN BTC identity")
		}
	}
	values := []string{v.MaxCashRaw, v.MaxCostRaw, v.MaxFeeLamports, v.MaxRentLamports, v.MinFinalizedSlot, v.ExpiresSlot}
	numbers := make([]uint64, len(values))
	for i, s := range values {
		n, err := strconv.ParseUint(s, 10, 64)
		if err != nil || strconv.FormatUint(n, 10) != s {
			return errors.New("invalid WEN BTC uint64")
		}
		numbers[i] = n
	}
	if numbers[0] == 0 || numbers[2] == 0 || numbers[4] == 0 || numbers[5] <= numbers[4] || numbers[1] > ^uint64(0)-numbers[0] || numbers[3] > ^uint64(0)-numbers[2] || numbers[2]+numbers[3] > signerNativeFeeReservationV2 {
		return errors.New("invalid WEN BTC amount, lifetime or fee/rent ceiling")
	}
	return nil
}
