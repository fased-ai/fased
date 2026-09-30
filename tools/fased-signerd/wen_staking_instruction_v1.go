package main

import (
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

// Serialization only: no state authentication, fee preview, permission or signing.
// Historical tracked instructions are mandatory. SAT v1 seeds remain unchanged.
func buildWENStakingInstructionV1(v signerWENStakingIntentV1, wallet solana.PublicKey) (solana.Instruction, error) {
	if err := validateWENStakingIntentV1(v); err != nil {
		return nil, err
	}
	if wallet.IsZero() {
		return nil, errors.New("missing staking owner")
	}
	program := solana.MustPublicKeyFromBase58(v.ProgramID)
	sale := solana.MustPublicKeyFromBase58(v.Sale)
	num := func(s string) uint64 { n, _ := strconv.ParseUint(s, 10, 64); return n }
	le := func(n uint64) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, n); return b }
	pda := func(seed string, extra ...[]byte) (solana.PublicKey, error) {
		seeds := [][]byte{[]byte(seed), sale[:]}
		seeds = append(seeds, extra...)
		p, _, err := solana.FindProgramAddress(seeds, program)
		return p, err
	}
	mint, err := pda("wen-sat-mint-v1")
	if err != nil || mint.String() != v.Mint {
		return nil, errors.New("staking launch mint mismatch")
	}
	accounts := solana.AccountMetaSlice{solana.Meta(wallet).WRITE().SIGNER(), solana.Meta(sale)}
	specs := []struct {
		seed  string
		extra [][]byte
		write bool
	}{
		{"wen-activation-v1", nil, false}, {"wen-stake-pool-v1", nil, true},
		{"wen-stake-position-v1", [][]byte{wallet[:]}, true},
		{"wen-stake-history-v1", [][]byte{wallet[:], le(num(v.Last))}, true},
		{"wen-stake-history-v1", [][]byte{wallet[:], le(num(v.Day) + 1)}, true},
		{"wen-stake-custody-v1", nil, true},
	}
	for _, s := range specs {
		p, e := pda(s.seed, s.extra...)
		if e != nil {
			return nil, e
		}
		m := solana.Meta(p)
		if s.write {
			m.WRITE()
		}
		accounts = append(accounts, m)
	}
	accounts = append(accounts, solana.Meta(mint), solana.Meta(solana.MustPublicKeyFromBase58(v.TokenAccount)).WRITE(), solana.Meta(solana.SystemProgramID), solana.Meta(solana.Token2022ProgramID))
	for _, s := range []struct {
		seed  string
		extra [][]byte
	}{
		{"wen-stake-history-index-v1", nil},
		{"wen-stake-total-v1", [][]byte{le(num(v.AggregateFrom))}},
		{"wen-stake-total-v1", [][]byte{le(num(v.Day) + 1)}},
	} {
		p, e := pda(s.seed, s.extra...)
		if e != nil {
			return nil, e
		}
		accounts = append(accounts, solana.Meta(p).WRITE())
	}
	opcode := byte(34)
	if v.Operation == "requestExit" {
		opcode = 35
	}
	data := []byte{opcode}
	for _, s := range []string{v.Amount, v.Day, v.Last, v.AggregateFrom} {
		data = append(data, le(num(s))...)
	}
	return solana.NewInstruction(program, accounts, data), nil
}
