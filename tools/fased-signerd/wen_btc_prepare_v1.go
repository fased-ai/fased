package main

import (
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
)

// Private preparation owns its copies. No API accepts a client-provided ticket,
// transaction, payer override or replacement instruction through this type.
// This is not a signing authorization or a durable execution receipt.
type signerWENBTCPreparedMessageV1 struct {
	accountKeys                []string
	rentLengths                []uint64
	referenceSlot, expiresSlot uint64
	message                    []byte
	intent                     signerWENBTCMessageIntentV1
	pins                       []signerWENBTCLookupPinV1
	life                       signerWENBTCMessageLifeV1
}

func prepareWENBTCMessageV1(intent signerWENBTCMessageIntentV1, pins []signerWENBTCLookupPinV1, snapshots []*signerWENBTCAccountV1, life signerWENBTCMessageLifeV1) (*signerWENBTCPreparedMessageV1, error) {
	if intent.payer.IsZero() || intent.program.IsZero() || intent.blockhash == (solana.Hash{}) || intent.units == 0 || intent.units > 1400000 || len(intent.data) == 0 || len(intent.data) > 600 || len(intent.accounts) < 1 || len(intent.accounts) > 73 || life.currentHeight >= life.lastValidHeight {
		return nil, errors.New("invalid WEN BTC preparation")
	}
	intent.data = append([]byte(nil), intent.data...)
	intent.accounts = append([]signerTypedAccountV2(nil), intent.accounts...)
	pins = append([]signerWENBTCLookupPinV1(nil), pins...)
	tables, err := verifiedWENBTCLookupTablesV1(pins, snapshots, life)
	if err != nil {
		return nil, err
	}
	metas := make(solana.AccountMetaSlice, 0, len(intent.accounts))
	for _, a := range intent.accounts {
		k, err := solana.PublicKeyFromBase58(a.Pubkey)
		if err != nil || k.String() != a.Pubkey {
			return nil, errors.New("invalid WEN BTC preparation account")
		}
		metas = append(metas, &solana.AccountMeta{PublicKey: k, IsSigner: a.IsSigner, IsWritable: a.IsWritable})
	}
	budget := make([]byte, 5)
	budget[0] = 2
	binary.LittleEndian.PutUint32(budget[1:], intent.units)
	compute := solana.MustPublicKeyFromBase58("ComputeBudget111111111111111111111111111111")
	tx, err := solana.NewTransaction([]solana.Instruction{solana.NewInstruction(compute, nil, budget), solana.NewInstruction(intent.program, metas, intent.data)}, intent.blockhash, solana.TransactionPayer(intent.payer), solana.TransactionAddressTables(tables))
	if err != nil {
		return nil, err
	}
	message, err := tx.Message.MarshalBinary()
	if err != nil {
		return nil, err
	}
	if err = verifyWENBTCMessageV1(message, intent, pins, snapshots, life); err != nil {
		return nil, err
	}
	allKeys, err := tx.Message.GetAllKeys()
	if err != nil {
		return nil, err
	}
	accountKeys := make([]string, len(allKeys))
	for i, key := range allKeys {
		accountKeys[i] = key.String()
	}
	return &signerWENBTCPreparedMessageV1{accountKeys: accountKeys, message: append([]byte(nil), message...), intent: intent, pins: pins, life: life}, nil
}

// Only the original message may advance. Refreshed lookup snapshots and height
// are supplied by signer-owned readback, never by an external signing request.
func (p *signerWENBTCPreparedMessageV1) revalidate(snapshots []*signerWENBTCAccountV1, currentHeight uint64) ([]byte, error) {
	if p == nil || len(p.message) == 0 || currentHeight < p.life.currentHeight {
		return nil, errors.New("WEN BTC preparation missing or height rolled back")
	}
	life := p.life
	life.currentHeight = currentHeight
	if err := verifyWENBTCMessageV1(p.message, p.intent, p.pins, snapshots, life); err != nil {
		return nil, err
	}
	return append([]byte(nil), p.message...), nil
}
