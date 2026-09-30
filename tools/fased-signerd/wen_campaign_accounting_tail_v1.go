package main

import (
	"errors"

	solana "github.com/gagliardetto/solana-go"
)

// These are only the deterministic account addresses required by the current
// campaign ABI. They do not authenticate the corresponding on-chain records;
// live preparation must read and validate those records before approval.
func wenCampaignAccountingTailV1(program, sale, issuer, window solana.PublicKey) (solana.AccountMetaSlice, error) {
	if program.IsZero() || sale.IsZero() {
		return nil, errors.New("missing campaign accounting identity")
	}
	derive := func(seeds ...[]byte) (solana.PublicKey, error) {
		key, _, err := solana.FindProgramAddress(seeds, program)
		return key, err
	}
	mint, err := derive([]byte("wen-sat-mint-v1"), sale[:])
	if err != nil {
		return nil, err
	}
	catalogue, err := derive([]byte("wen-retail-members-v2"), issuer[:], mint[:])
	if err != nil {
		return nil, err
	}
	funding, err := derive([]byte("wen-retail-funding-v2"), window[:])
	if err != nil {
		return nil, err
	}
	root, err := derive([]byte("wen-accounting-domain-v1"), sale[:], []byte{3})
	if err != nil {
		return nil, err
	}
	entry, err := derive([]byte("wen-accounting-source-v1"), root[:], catalogue[:])
	if err != nil {
		return nil, err
	}
	return solana.AccountMetaSlice{
		solana.Meta(sale), solana.Meta(window), solana.Meta(funding),
		solana.Meta(root).WRITE(), solana.Meta(entry).WRITE(),
	}, nil
}
