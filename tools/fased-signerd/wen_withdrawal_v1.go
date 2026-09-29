package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

// Internal withdrawal candidate; intentionally absent from public capabilities.
// ExpectedGross and MinimumNet constrain admission, not opcode-12 wire data.
type signerWENWithdrawalIntentV1 struct {
	DescriptorSHA256 string `json:"descriptorSha256"`
	CapabilitySHA256 string `json:"capabilitySha256"`
	Genesis          string `json:"genesis"`
	ProgramID        string `json:"programId"`
	Sale             string `json:"sale"`
	Mint             string `json:"mint"`
	TokenAccount     string `json:"tokenAccount"`
	Day              string `json:"day"`
	ExpectedGross    string `json:"expectedGross"`
	MinimumNet       string `json:"minimumNet"`
	MaxFeeLamports   string `json:"maxFeeLamports"`
	MinFinalizedSlot string `json:"minFinalizedSlot"`
	ExpiresSlot      string `json:"expiresSlot"`
}

// Reuse identity syntax checks and PDA derivation only, never change-operation admission.
func (v signerWENWithdrawalIntentV1) identity() signerWENStakingIntentV1 {
	return signerWENStakingIntentV1{Operation: "requestExit", Amount: "0", Last: "0", AggregateFrom: "0", DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, Genesis: v.Genesis, ProgramID: v.ProgramID, Sale: v.Sale, Mint: v.Mint, TokenAccount: v.TokenAccount, Day: v.Day, MaxFeeLamports: v.MaxFeeLamports, MinFinalizedSlot: v.MinFinalizedSlot, ExpiresSlot: v.ExpiresSlot}
}
func validateWENWithdrawalIntentV1(v signerWENWithdrawalIntentV1) error {
	if e := validateWENStakingIntentV1(v.identity()); e != nil {
		return e
	}
	ns := []uint64{}
	for _, s := range []string{v.ExpectedGross, v.MinimumNet} {
		n, e := strconv.ParseUint(s, 10, 64)
		if e != nil || n == 0 || strconv.FormatUint(n, 10) != s {
			return errors.New("invalid withdrawal amount bound")
		}
		ns = append(ns, n)
	}
	if ns[1] > ns[0] {
		return errors.New("invalid withdrawal minimum")
	}
	return nil
}
func decodeWENWithdrawalIntentV1(raw []byte) (signerWENWithdrawalIntentV1, error) {
	var v signerWENWithdrawalIntentV1
	if len(raw) == 0 || len(raw) > 4096 {
		return v, errors.New("invalid withdrawal request size")
	}
	if e := decodeStrictJSONV2(raw, &v); e != nil {
		return v, e
	}
	return v, validateWENWithdrawalIntentV1(v)
}
func buildWENWithdrawalInstructionV1(v signerWENWithdrawalIntentV1, w solana.PublicKey) (solana.Instruction, error) {
	if e := validateWENWithdrawalIntentV1(v); e != nil {
		return nil, e
	}
	ix, e := buildWENStakingInstructionV1(v.identity(), w)
	if e != nil {
		return nil, e
	}
	a := ix.Accounts()
	metas := solana.AccountMetaSlice{}
	for _, i := range []int{0, 1, 2, 3, 4, 7, 8, 9, 11} {
		metas = append(metas, a[i])
	}
	return solana.NewInstruction(ix.ProgramID(), metas, []byte{12}), nil
}

type wenWithdrawalPreviewV1 struct{ Gross, Fee, Net, RemainingCustodied, Eligible, Next, Last uint64 }

// Coherent account preview only. Sale activation, deployment and finalized RPC
// authentication must be established separately before execution is admitted.
func previewWENWithdrawalV1(v signerWENWithdrawalIntentV1, w solana.PublicKey, slot, now uint64, pool, position, mint, custody, destination *signerWENBTCAccountV1) (wenWithdrawalPreviewV1, error) {
	var out wenWithdrawalPreviewV1
	bad := errors.New("withdrawal state or net receipt rejected")
	ix, e := buildWENWithdrawalInstructionV1(v, w)
	if e != nil {
		return out, e
	}
	a := ix.Accounts()
	num := func(s string) uint64 { n, _ := strconv.ParseUint(s, 10, 64); return n }
	day := num(v.Day)
	if now > uint64(1<<63-1) || now/86400 != day || slot < num(v.MinFinalizedSlot) || slot >= num(v.ExpiresSlot) {
		return out, bad
	}
	p, sale := ix.ProgramID(), a[1].PublicKey
	check := func(record *signerWENBTCAccountV1, key solana.PublicKey, seed, magic string, n int, second solana.PublicKey, version byte, extra ...[]byte) bool {
		seeds := [][]byte{[]byte(seed), sale[:]}
		address, bump, e := solana.FindProgramAddress(append(seeds, extra...), p)
		if e != nil || record == nil || record.Address != key || key != address || record.Owner != p || record.Executable || record.Slot != slot || len(record.Data) != n {
			return false
		}
		d := record.Data
		return string(d[:8]) == magic && d[8] == version && d[9] == 0 && d[10] == 0 && d[11] == bump && bytes.Equal(d[12:16], make([]byte, 4)) && bytes.Equal(d[16:48], sale[:]) && bytes.Equal(d[48:80], second[:])
	}
	if !check(pool, a[3].PublicKey, "wen-stake-pool-v1", "WENSTK01", 112, a[6].PublicKey, 2) || !check(position, a[4].PublicKey, "wen-stake-position-v1", "WENSTP01", 104, w, 1, w[:]) {
		return out, bad
	}
	read := func(d []byte, o int) uint64 { return binary.LittleEndian.Uint64(d[o:]) }
	pd, eligible, next, total := read(pool.Data, 80), read(pool.Data, 88), read(pool.Data, 96), read(pool.Data, 104)
	gross, exit, last := read(position.Data, 80), read(position.Data, 88), read(position.Data, 96)
	if pd > day || gross == 0 || gross != num(v.ExpectedGross) || exit == 0 || day < exit || last != exit || gross > total {
		return out, bad
	}
	if pd < day {
		eligible = next
	}
	remaining := total - gross
	if eligible > remaining || next > remaining {
		return out, bad
	}
	collector, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-sat-collector-v1"), sale[:]}, p)
	if e != nil {
		return out, e
	}
	if e = validateWENSatMintV1(mint, a[6].PublicKey, sale, collector, slot); e != nil {
		return out, e
	}
	if _, _, e = validateWENSatCustodyV1(custody, a[5].PublicKey, a[6].PublicKey, a[3].PublicKey, slot, total); e != nil {
		return out, e
	}
	balance, withheld, e := validateWENSatCustodyV1(destination, a[7].PublicKey, a[6].PublicKey, w, slot, 0)
	if e != nil {
		return out, e
	}
	fee, net := wenSatTransferV1(gross)
	if net < num(v.MinimumNet) || net > ^uint64(0)-balance || fee > ^uint64(0)-withheld {
		return out, bad
	}
	return wenWithdrawalPreviewV1{gross, fee, net, remaining, eligible, next, last}, nil
}
