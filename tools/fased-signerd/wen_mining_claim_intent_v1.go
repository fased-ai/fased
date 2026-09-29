package main

import (
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

// Internal candidate only. No public dispatch, admission or signing is enabled.
// MinimumReceived excludes the separate SOL network fee. Claims create no accounts.
type signerWENMiningClaimIntentV1 struct {
	Operation          string  `json:"operation"`
	DescriptorSHA256   string  `json:"descriptorSha256"`
	CapabilitySHA256   string  `json:"capabilitySha256"`
	AccountStateSHA256 string  `json:"accountStateSha256"`
	Genesis            string  `json:"genesis"`
	ProgramID          string  `json:"programId"`
	Economy            string  `json:"economy"`
	Destination        *string `json:"destination,omitempty"`
	ID                 string  `json:"id"`
	Nonce              string  `json:"nonce"`
	Ordinal            string  `json:"ordinal"`
	ExpectedGross      string  `json:"expectedGross"`
	MinimumReceived    string  `json:"minimumReceived"`
	MaxFeeLamports     string  `json:"maxFeeLamports"`
	MinFinalizedSlot   string  `json:"minFinalizedSlot"`
	ExpiresSlot        string  `json:"expiresSlot"`
}

func decodeWENMiningClaimIntentV1(raw []byte) (signerWENMiningClaimIntentV1, error) {
	var v signerWENMiningClaimIntentV1
	if len(raw) == 0 || len(raw) > 4096 {
		return v, errors.New("invalid mining claim request size")
	}
	if err := decodeStrictJSONV2(raw, &v); err != nil {
		return v, errors.New("invalid mining claim request")
	}
	return v, validateWENMiningClaimIntentV1(v)
}
func validateWENMiningClaimIntentV1(v signerWENMiningClaimIntentV1) error {
	bad := errors.New("invalid WEN mining claim")
	for _, s := range []string{v.DescriptorSHA256, v.CapabilitySHA256, v.AccountStateSHA256} {
		if !wenReservationHashV1(s) {
			return bad
		}
	}
	keys := []string{v.Genesis, v.ProgramID, v.Economy}
	if v.Operation == "sat" && v.Destination != nil {
		keys = append(keys, *v.Destination)
	} else if v.Operation != "sol" || v.Destination != nil {
		return bad
	}
	for _, s := range keys {
		p, e := solana.PublicKeyFromBase58(s)
		if e != nil || p.IsZero() || p.String() != s {
			return bad
		}
	}
	values := []string{v.ID, v.Nonce, v.Ordinal, v.ExpectedGross, v.MinimumReceived, v.MaxFeeLamports, v.MinFinalizedSlot, v.ExpiresSlot}
	ns := make([]uint64, len(values))
	for i, s := range values {
		n, e := strconv.ParseUint(s, 10, 64)
		if e != nil || strconv.FormatUint(n, 10) != s {
			return bad
		}
		ns[i] = n
	}
	net := ns[3]
	if v.Operation == "sat" {
		fee := (net/100)*3 + ((net%100)*3+99)/100
		net -= fee
	}
	if ns[4] > net || ns[5] == 0 || ns[5] > signerNativeFeeReservationV2 || ns[6] == 0 || ns[7] <= ns[6] || ns[7]-ns[6] > 32 {
		return bad
	}
	return nil
}
func buildWENMiningClaimInstructionV1(v signerWENMiningClaimIntentV1, owner solana.PublicKey) (solana.Instruction, error) {
	if e := validateWENMiningClaimIntentV1(v); e != nil {
		return nil, e
	}
	if owner.IsZero() {
		return nil, errors.New("missing mining claim owner")
	}
	p := solana.MustPublicKeyFromBase58(v.ProgramID)
	s := solana.MustPublicKeyFromBase58(v.Economy)
	le := func(s string) []byte {
		n, _ := strconv.ParseUint(s, 10, 64)
		b := make([]byte, 8)
		binary.LittleEndian.PutUint64(b, n)
		return b
	}
	var deriveErr error
	derive := func(seed string, more ...[]byte) solana.PublicKey {
		k, _, e := solana.FindProgramAddress(append([][]byte{[]byte(seed)}, more...), p)
		if e != nil {
			deriveErr = e
		}
		return k
	}
	prep := derive("wen-mining-preparation-v1", s[:], le(v.ID))
	offer := derive("wen-mining-offer-v1", s[:], prep[:])
	entry := derive("wen-mining-entry-v1", offer[:], owner[:], le(v.Nonce))
	keys := []solana.PublicKey{owner, s, offer, derive("wen-mining-roster-v1", s[:], offer[:]), derive("wen-mining-progress-v1", s[:], offer[:]), entry, derive("wen-mining-claim-v1", s[:], entry[:])}
	data := []byte{82}
	if v.Operation == "sat" {
		data[0] = 83
		keys = append(keys, derive("wen-activation-v1", s[:]), derive("wen-mining-reserved-v1", s[:]), derive("wen-allocation-v1", s[:], []byte{3}), solana.MustPublicKeyFromBase58(*v.Destination), derive("wen-sat-mint-v1", s[:]), solana.Token2022ProgramID)
	}
	for _, n := range []string{v.ID, v.Nonce, v.Ordinal} {
		data = append(data, le(n)...)
	}
	if deriveErr != nil {
		return nil, deriveErr
	}
	seen := map[solana.PublicKey]bool{p: true}
	metas := make(solana.AccountMetaSlice, len(keys))
	for i, k := range keys {
		if seen[k] {
			return nil, errors.New("aliased mining claim accounts")
		}
		seen[k] = true
		metas[i] = &solana.AccountMeta{PublicKey: k, IsSigner: i == 0, IsWritable: i == 0 || i == 4 || i == 6 || i == 8 || i == 9 || i == 10}
	}
	return solana.NewInstruction(p, metas, data), nil
}
