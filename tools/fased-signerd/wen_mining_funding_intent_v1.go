package main

import (
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"math"
	"strconv"
)

// Candidate request only. Owner is supplied independently by the configured
// wallet. Amount/deadline are review expectations, not opcode 120 arguments.
// No dispatcher or signing permission is installed by this codec.
type signerWENMiningFundingIntentV1 struct {
	DescriptorSHA256 string `json:"descriptorSha256"`
	CapabilitySHA256 string `json:"capabilitySha256"`
	Genesis          string `json:"genesis"`
	ProgramID        string `json:"programId"`
	Sale             string `json:"sale"`
	VaultID          string `json:"vaultId"`
	Nonce            string `json:"nonce"`
	Amount           string `json:"amount"`
	Deadline         string `json:"deadline"`
	MaxFeeLamports   string `json:"maxFeeLamports"`
	MinFinalizedSlot string `json:"minFinalizedSlot"`
	ExpiresSlot      string `json:"expiresSlot"`
}

func decodeWENMiningFundingIntentV1(raw []byte) (signerWENMiningFundingIntentV1, error) {
	var v signerWENMiningFundingIntentV1
	if len(raw) == 0 || len(raw) > 4096 {
		return v, errors.New("invalid mining funding request size")
	}
	if e := decodeStrictJSONV2(raw, &v); e != nil {
		return v, e
	}
	return v, validateWENMiningFundingIntentV1(v)
}
func validateWENMiningFundingIntentV1(v signerWENMiningFundingIntentV1) error {
	bad := errors.New("invalid WEN mining funding intent")
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
	for _, s := range []string{v.Genesis, v.ProgramID, v.Sale, v.VaultID} {
		p, e := solana.PublicKeyFromBase58(s)
		if e != nil || p.IsZero() || p.String() != s {
			return bad
		}
	}
	values := []string{v.Nonce, v.Amount, v.Deadline, v.MaxFeeLamports, v.MinFinalizedSlot, v.ExpiresSlot}
	n := make([]uint64, len(values))
	for i, s := range values {
		x, e := strconv.ParseUint(s, 10, 64)
		if e != nil || strconv.FormatUint(x, 10) != s {
			return bad
		}
		n[i] = x
	}
	if n[1] == 0 || n[2] == 0 || n[2] > math.MaxInt64 || n[3] == 0 || n[3] > signerNativeFeeReservationV2 || n[4] == 0 || n[5] <= n[4] {
		return bad
	}
	return nil
}
func buildWENMiningFundingInstructionV1(v signerWENMiningFundingIntentV1, owner solana.PublicKey) (solana.Instruction, error) {
	if e := validateWENMiningFundingIntentV1(v); e != nil {
		return nil, e
	}
	if owner.IsZero() {
		return nil, errors.New("missing mining funding owner")
	}
	p := solana.MustPublicKeyFromBase58(v.ProgramID)
	sale := solana.MustPublicKeyFromBase58(v.Sale)
	id := solana.MustPublicKeyFromBase58(v.VaultID)
	nonce, _ := strconv.ParseUint(v.Nonce, 10, 64)
	le := make([]byte, 8)
	binary.LittleEndian.PutUint64(le, nonce)
	vault, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-portfolio-sol-v1"), owner[:], id[:]}, p)
	if e != nil {
		return nil, e
	}
	action, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-portfolio-action-v1"), vault[:], le}, p)
	if e != nil {
		return nil, e
	}
	budget, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-mining-budget-v1"), sale[:], owner[:]}, p)
	if e != nil {
		return nil, e
	}
	capital, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-mining-capital-v1"), sale[:], owner[:]}, p)
	if e != nil {
		return nil, e
	}
	keys := []solana.PublicKey{vault, action, owner, sale, budget, capital}
	seen := map[solana.PublicKey]bool{p: true}
	metas := make(solana.AccountMetaSlice, len(keys))
	for i, k := range keys {
		if seen[k] {
			return nil, errors.New("aliased mining funding accounts")
		}
		seen[k] = true
		metas[i] = &solana.AccountMeta{PublicKey: k, IsSigner: false, IsWritable: i == 0 || i == 1 || i == 5}
	}
	return solana.NewInstruction(p, metas, []byte{120}), nil
}
