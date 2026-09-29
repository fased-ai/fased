package main

import (
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

// Reward claim candidate, separate from BTC subscription acceptance/acquisition.
// No public operation or signing capability is installed by this type.
type signerWENBTCClaimIntentV1 struct {
	DescriptorSHA256 string  `json:"descriptorSha256"`
	CapabilitySHA256 string  `json:"capabilitySha256"`
	Genesis          string  `json:"genesis"`
	ProgramID        string  `json:"programId"`
	Sale             string  `json:"sale"`
	Mint             string  `json:"mint"`
	Destination      string  `json:"destination"`
	Source           string  `json:"source"`
	Offer            *string `json:"offer,omitempty"`
	Day              string  `json:"day"`
	From             string  `json:"from"`
	MinimumReceived  string  `json:"minimumReceived"`
	MaxFeeLamports   string  `json:"maxFeeLamports"`
	MaxRentLamports  string  `json:"maxRentLamports"`
	MinFinalizedSlot string  `json:"minFinalizedSlot"`
	ExpiresSlot      string  `json:"expiresSlot"`
}

const wenBTCClaimMintV1 = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij"

func decodeWENBTCClaimIntentV1(raw []byte) (signerWENBTCClaimIntentV1, error) {
	var v signerWENBTCClaimIntentV1
	if len(raw) == 0 || len(raw) > 4096 {
		return v, errors.New("invalid BTC claim request size")
	}
	if err := decodeStrictJSONV2(raw, &v); err != nil {
		return v, err
	}
	return v, validateWENBTCClaimIntentV1(v)
}
func validateWENBTCClaimIntentV1(v signerWENBTCClaimIntentV1) error {
	bad := errors.New("invalid WEN BTC reward claim")
	for _, d := range []string{v.DescriptorSHA256, v.CapabilitySHA256} {
		if len(d) != 64 {
			return bad
		}
		for _, c := range d {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
				return bad
			}
		}
	}
	for _, s := range []string{v.Genesis, v.ProgramID, v.Sale, v.Mint, v.Destination} {
		p, e := solana.PublicKeyFromBase58(s)
		if e != nil || p.IsZero() || p.String() != s {
			return bad
		}
	}
	if v.Mint != wenBTCClaimMintV1 {
		return bad
	}
	values := []string{v.Day, v.From, v.MinimumReceived, v.MaxFeeLamports, v.MaxRentLamports, v.MinFinalizedSlot, v.ExpiresSlot}
	if v.Source == "mining" && v.Offer != nil {
		values = append(values, *v.Offer)
	} else if v.Source != "fee" || v.Offer != nil {
		return bad
	}
	ns := make([]uint64, len(values))
	for i, s := range values {
		n, e := strconv.ParseUint(s, 10, 64)
		if e != nil || strconv.FormatUint(n, 10) != s {
			return bad
		}
		ns[i] = n
	}
	if ns[1] > ns[0] || ns[2] == 0 || ns[3] == 0 || ns[5] == 0 || ns[6] <= ns[5] || ns[4] > ^uint64(0)-ns[3] || ns[3]+ns[4] > signerNativeFeeReservationV2 {
		return bad
	}
	return nil
}

// Canonical unsigned encoding only. Claimed minimum, custody, historical rights,
// descriptor pins and costs still require independent signer-side admission.
func buildWENBTCClaimInstructionV1(v signerWENBTCClaimIntentV1, owner solana.PublicKey) (solana.Instruction, error) {
	if e := validateWENBTCClaimIntentV1(v); e != nil {
		return nil, e
	}
	if owner.IsZero() {
		return nil, errors.New("missing BTC claim owner")
	}
	p := solana.MustPublicKeyFromBase58(v.ProgramID)
	s := solana.MustPublicKeyFromBase58(v.Sale)
	num := func(s string) uint64 { n, _ := strconv.ParseUint(s, 10, 64); return n }
	le := func(s string) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, num(s)); return b }
	var deriveErr error
	derive := func(seed string, more ...[]byte) solana.PublicKey {
		seeds := append([][]byte{[]byte(seed)}, more...)
		k, _, e := solana.FindProgramAddress(seeds, p)
		if e != nil {
			deriveErr = e
		}
		return k
	}
	var batch solana.PublicKey
	data := []byte{53}
	if v.Source == "fee" {
		batch = derive("wen-fee-batch-v1", s[:], le(v.Day))
	} else {
		prep := derive("wen-mining-preparation-v1", s[:], le(*v.Offer))
		offer := derive("wen-mining-offer-v1", s[:], prep[:])
		receipt := derive("wen-mining-progress-v1", s[:], offer[:])
		batch = derive("wen-mining-income-v1", receipt[:])
		data = []byte{101}
		data = append(data, le(*v.Offer)...)
	}
	funding := derive("wen-btc-funded-v1", batch[:])
	data = append(data, le(v.Day)...)
	data = append(data, le(v.From)...)
	keys := []solana.PublicKey{owner, s, derive("wen-activation-v1", s[:]), funding, derive("wen-opening-target-v1", s[:], []byte{4}, le(v.Day)), derive("wen-stake-history-v1", s[:], owner[:], le(v.From)), derive("wen-btc-settled-v1", funding[:]), derive("wen-btc-fallback-v1", funding[:], owner[:]), derive("wen-btc-paid-v1", funding[:], owner[:]), derive("wen-btc-reward-v1", funding[:]), solana.MustPublicKeyFromBase58(v.Destination), derive("wen-btc-swap-v1", funding[:]), solana.MustPublicKeyFromBase58(v.Mint), solana.SystemProgramID, solana.TokenProgramID}
	if deriveErr != nil {
		return nil, deriveErr
	}
	seen := map[solana.PublicKey]bool{p: true}
	metas := make(solana.AccountMetaSlice, len(keys))
	for i, k := range keys {
		if seen[k] {
			return nil, errors.New("aliased BTC claim accounts")
		}
		seen[k] = true
		metas[i] = &solana.AccountMeta{PublicKey: k, IsSigner: i == 0, IsWritable: i == 0 || i == 6 || i == 8 || i == 9 || i == 10}
	}
	return solana.NewInstruction(p, metas, data), nil
}
