package main

import (
	"encoding/hex"
	"errors"
	solana "github.com/gagliardetto/solana-go"
)

type signerWENBTCPreparationReviewV1 struct {
	ComputeUnits uint32 `json:"computeUnits"`
	Lookups      []struct {
		Address string `json:"address"`
		SHA256  string `json:"sha256"`
	} `json:"lookups"`
}
type signerWENBTCPreparationResultV1 struct {
	SimulationSlot   uint64 `json:"simulationSlot,string"`
	ComputeUnits     uint64 `json:"computeUnits,string"`
	NetworkFee       uint64 `json:"networkFeeLamports,string"`
	Rent             uint64 `json:"rentLamports,string"`
	RefundableRent   uint64 `json:"refundableRentLamports,string"`
	TotalCost        uint64 `json:"totalCostLamports,string"`
	Status           string `json:"status"`
	Operation        string `json:"operation"`
	DescriptorSHA256 string `json:"descriptorSha256"`
	OfferSHA256      string `json:"offerSha256"`
	SigningEnabled   bool   `json:"signingEnabled"`
	Message          []byte `json:"messageBase64"`
	Blockhash        string `json:"blockhash"`
	MinimumSlot      uint64 `json:"minimumSlot,string"`
	CurrentHeight    uint64 `json:"currentHeight,string"`
	LastValidHeight  uint64 `json:"lastValidHeight,string"`
}

func (r signerWENBTCReviewV1) preparationPins() ([]signerWENBTCLookupPinV1, error) {
	bad := errors.New("WEN BTC preparation requires reviewed compute and lookup limits")
	p := r.Preparation
	if p == nil || p.ComputeUnits == 0 || p.ComputeUnits > 1400000 || len(p.Lookups) < 1 || len(p.Lookups) > 4 {
		return nil, bad
	}
	out := make([]signerWENBTCLookupPinV1, len(p.Lookups))
	seen := map[solana.PublicKey]bool{}
	for i, a := range p.Lookups {
		key, err := solana.PublicKeyFromBase58(a.Address)
		if err != nil || key.IsZero() || key.String() != a.Address || seen[key] {
			return nil, bad
		}
		seen[key] = true
		hash, err := hex.DecodeString(a.SHA256)
		if err != nil || len(hash) != 32 || hex.EncodeToString(hash) != a.SHA256 {
			return nil, bad
		}
		out[i] = signerWENBTCLookupPinV1{key: key, digest: a.SHA256}
	}
	return out, nil
}
