package main

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

// Native SAT reward claim candidate. MinimumReceived is net of Token-2022 fees.
// No public operation or signing capability is installed by this type.
type signerWENNativeClaimIntentV1 struct {
	DescriptorSHA256 string `json:"descriptorSha256"`
	CapabilitySHA256 string `json:"capabilitySha256"`
	Genesis          string `json:"genesis"`
	ProgramID        string `json:"programId"`
	Sale             string `json:"sale"`
	Mint             string `json:"mint"`
	Destination      string `json:"destination"`
	Award            string `json:"award"`
	From             string `json:"from"`
	MinimumReceived  string `json:"minimumReceived"`
	MaxFeeLamports   string `json:"maxFeeLamports"`
	MaxRentLamports  string `json:"maxRentLamports"`
	MinFinalizedSlot string `json:"minFinalizedSlot"`
	ExpiresSlot      string `json:"expiresSlot"`
}

func decodeWENNativeClaimIntentV1(raw []byte) (signerWENNativeClaimIntentV1, error) {
	var v signerWENNativeClaimIntentV1
	if len(raw) == 0 || len(raw) > 4096 {
		return v, errors.New("invalid native SAT claim request size")
	}
	if err := decodeStrictJSONV2(raw, &v); err != nil {
		return v, err
	}
	return v, validateWENNativeClaimIntentV1(v)
}
func validateWENNativeClaimIntentV1(v signerWENNativeClaimIntentV1) error {
	bad := errors.New("invalid WEN native SAT reward claim")
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
	values := []string{v.Award, v.From, v.MinimumReceived, v.MaxFeeLamports, v.MaxRentLamports, v.MinFinalizedSlot, v.ExpiresSlot}
	ns := make([]uint64, len(values))
	for i, s := range values {
		n, e := strconv.ParseUint(s, 10, 64)
		if e != nil || strconv.FormatUint(n, 10) != s {
			return bad
		}
		ns[i] = n
	}
	if ns[1] > ns[0]/3 || ns[2] == 0 || ns[3] == 0 || ns[5] == 0 || ns[6] <= ns[5] || ns[4] > ^uint64(0)-ns[3] || ns[3]+ns[4] > signerNativeFeeReservationV2 {
		return bad
	}
	return nil
}

// Canonical unsigned encoding only. Claimed minimum, custody, historical rights,
// descriptor pins and costs still require independent signer-side admission.
func buildWENNativeClaimInstructionV1(v signerWENNativeClaimIntentV1, owner solana.PublicKey) (solana.Instruction, error) {
	if e := validateWENNativeClaimIntentV1(v); e != nil {
		return nil, e
	}
	if owner.IsZero() {
		return nil, errors.New("missing native SAT claim owner")
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
	domain := sha256.Sum256(append([]byte("wen-native-staking-epoch-v1"), le(v.Award)...))
	receipt := derive("wen-named-promise-v1", s[:], []byte{2}, domain[:])
	source := derive("wen-native-stake-release-v1", receipt[:])
	mint := derive("wen-sat-mint-v1", s[:])
	if mint.String() != v.Mint {
		return nil, errors.New("wrong launch SAT mint")
	}
	data := append([]byte{42}, le(v.Award)...)
	data = append(data, le(v.From)...)
	keys := []solana.PublicKey{owner, s, derive("wen-activation-v1", s[:]), receipt, source,
		derive("wen-opening-target-v1", s[:], []byte{4}, le(strconv.FormatUint(num(v.Award)/3, 10))),
		derive("wen-stake-history-v1", s[:], owner[:], le(v.From)),
		derive("wen-native-stake-claim-v1", source[:], owner[:]),
		derive("wen-native-stake-inventory-v1", receipt[:]), solana.MustPublicKeyFromBase58(v.Destination),
		mint, solana.Token2022ProgramID, solana.SystemProgramID}
	if deriveErr != nil {
		return nil, deriveErr
	}
	seen := map[solana.PublicKey]bool{p: true}
	metas := make(solana.AccountMetaSlice, len(keys))
	for i, k := range keys {
		if seen[k] {
			return nil, errors.New("aliased native SAT claim accounts")
		}
		seen[k] = true
		metas[i] = &solana.AccountMeta{PublicKey: k, IsSigner: i == 0, IsWritable: i == 0 || i == 4 || i == 7 || i == 8 || i == 9}
	}
	return solana.NewInstruction(p, metas, data), nil
}
