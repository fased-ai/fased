package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"

	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
)

// Internal compilation boundary, not an application operation. Pins must come
// from protected admission and the quote from an authenticated custody reader.
// No raw instruction, route, recipient or transaction is accepted here.
// This compiler alone does not establish quote authenticity or permit signing.
type wenMarketBuyPinsV1 struct {
	Profile                                                          string
	Program, Economy, Owner, AssetAccount, CashAccount, Pool, Config solana.PublicKey
}
type wenMarketBuyQuoteV1 struct {
	Pool                                                    solana.PublicKey
	RequestedNet, InputCash, QuotedNet, Slot, ReferenceSlot uint64
}
type wenMarketBuyLimitsV1 struct {
	RequestedNet, MaxCash, MinimumNet, MinimumSlot, ExpiresSlot uint64
	SlippageBPS                                                 uint16
}

func buildWENMarketBuyV1(p wenMarketBuyPinsV1, q wenMarketBuyQuoteV1, l wenMarketBuyLimitsV1) (solana.Instruction, error) {
	bad := errors.New("WEN Buy instruction rejected")
	if l.RequestedNet == 0 || q.RequestedNet != l.RequestedNet || q.InputCash == 0 || q.InputCash > l.MaxCash || q.QuotedNet < l.RequestedNet || l.MinimumNet < l.RequestedNet || l.SlippageBPS > 50 || l.ExpiresSlot <= l.MinimumSlot || l.ExpiresSlot-l.MinimumSlot > 32 || q.Slot < l.MinimumSlot || q.ReferenceSlot < q.Slot || q.ReferenceSlot >= l.ExpiresSlot {
		return nil, bad
	}
	var venue, cashMint solana.PublicKey
	switch p.Profile {
	case "mainnet":
		venue = solana.MustPublicKeyFromBase58("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C")
		cashMint = solana.MustPublicKeyFromBase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
	case "devnet-synthetic-fixture":
		venue = solana.MustPublicKeyFromBase58("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb")
		cashMint = solana.MustPublicKeyFromBase58("DE8BhmX7qJGzjUSHnYYEXjAcnr86aVUCNquoyEqYsENc")
	default:
		return nil, bad
	}
	for _, k := range []solana.PublicKey{p.Program, p.Economy, p.Owner, p.AssetAccount, p.CashAccount, p.Pool, p.Config} {
		if k.IsZero() {
			return nil, bad
		}
	}
	derive := func(program solana.PublicKey, seed string, rest ...[]byte) (solana.PublicKey, error) {
		seeds := append([][]byte{[]byte(seed)}, rest...)
		key, _, err := solana.FindProgramAddress(seeds, program)
		return key, err
	}
	mint, err := derive(p.Program, "wen-sat-mint-v1", p.Economy[:])
	if err != nil || mint == cashMint {
		return nil, bad
	}
	first, second := mint, cashMint
	if bytes.Compare(first[:], second[:]) > 0 {
		first, second = second, first
	}
	pool, err := derive(venue, "pool", p.Config[:], first[:], second[:])
	if err != nil || pool != p.Pool || q.Pool != pool {
		return nil, bad
	}
	authority, err := derive(venue, "vault_and_lp_mint_auth_seed")
	if err != nil {
		return nil, err
	}
	cashVault, err := derive(venue, "pool_vault", pool[:], cashMint[:])
	if err != nil {
		return nil, err
	}
	assetVault, err := derive(venue, "pool_vault", pool[:], mint[:])
	if err != nil {
		return nil, err
	}
	observation, err := derive(venue, "observation", pool[:])
	if err != nil {
		return nil, err
	}
	// Quotient/remainder multiplication avoids uint64 overflow and matches the
	// shared client's floor(quotedNet * (10000 - slippage) / 10000).
	factor := uint64(10000 - l.SlippageBPS)
	minimum := q.QuotedNet/10000*factor + q.QuotedNet%10000*factor/10000
	if minimum == 0 || minimum < l.MinimumNet {
		return nil, bad
	}
	keys := []solana.PublicKey{p.Owner, authority, p.Config, pool, p.CashAccount, p.AssetAccount, cashVault, assetVault, solana.TokenProgramID, solana.Token2022ProgramID, cashMint, mint, observation}
	seen := map[solana.PublicKey]bool{}
	metas := make([]*solana.AccountMeta, len(keys))
	for i, k := range keys {
		if seen[k] || k == venue {
			return nil, bad
		}
		seen[k] = true
		metas[i] = &solana.AccountMeta{PublicKey: k, IsSigner: i == 0, IsWritable: i == 3 || i == 4 || i == 5 || i == 6 || i == 7 || i == 12}
	}
	hash := sha256.Sum256([]byte("global:swap_base_input"))
	data := make([]byte, 24)
	copy(data, hash[:8])
	binary.LittleEndian.PutUint64(data[8:], q.InputCash)
	binary.LittleEndian.PutUint64(data[16:], minimum)
	return solana.NewInstruction(venue, metas, data), nil
}

// Revalidation keeps the approved blockhash/message unchanged. It cannot mint
// a replacement signed attempt or extend a reviewed lifetime.
func compileWENMarketBuyV1(p wenMarketBuyPinsV1, q wenMarketBuyQuoteV1, l wenMarketBuyLimitsV1, blockhash solana.Hash, height, lastValid uint64, previous []byte) ([]byte, error) {
	if blockhash == (solana.Hash{}) || height >= lastValid {
		return nil, errors.New("WEN Buy lifetime rejected")
	}
	ix, err := buildWENMarketBuyV1(p, q, l)
	if err != nil {
		return nil, err
	}
	tx, err := solana.NewTransaction([]solana.Instruction{ix}, blockhash, solana.TransactionPayer(p.Owner))
	if err != nil {
		return nil, err
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	message, err := tx.Message.MarshalBinary()
	if err != nil {
		return nil, err
	}
	if len(message)+65 > 1232 || tx.Message.Header.NumRequiredSignatures != 1 || len(tx.Message.AddressTableLookups) != 0 || previous != nil && !bytes.Equal(message, previous) {
		return nil, errors.New("WEN Buy message changed")
	}
	return message, nil
}

// Independently binds resolved accounts, privileges, amounts and lifetime.
// Equal-role key ordering may differ across SDKs; no extra instruction, lookup,
// account or privilege is allowed. A protected review still binds exact bytes.
func verifyWENMarketBuyMessageV1(raw []byte, p wenMarketBuyPinsV1, q wenMarketBuyQuoteV1, l wenMarketBuyLimitsV1, blockhash solana.Hash, height, lastValid uint64) error {
	bad := errors.New("WEN Buy message rejected")
	if len(raw) == 0 || len(raw)+65 > 1232 || raw[0] != 128 || blockhash == (solana.Hash{}) || height >= lastValid {
		return bad
	}
	ix, err := buildWENMarketBuyV1(p, q, l)
	if err != nil {
		return err
	}
	var message solana.Message
	if message.UnmarshalWithDecoder(bin.NewBinDecoder(raw)) != nil {
		return bad
	}
	encoded, err := message.MarshalBinary()
	if err != nil || !bytes.Equal(raw, encoded) {
		return bad
	}
	metas := ix.Accounts()
	if message.GetVersion() != solana.MessageVersionV0 || message.Header.NumRequiredSignatures != 1 || message.Header.NumReadonlySignedAccounts != 0 || len(message.GetAddressTableLookups()) != 0 || len(message.AccountKeys) != len(metas)+1 || message.AccountKeys[0] != p.Owner || message.RecentBlockhash != blockhash || len(message.Instructions) != 1 {
		return bad
	}
	compiled := message.Instructions[0]
	data, err := ix.Data()
	if err != nil || int(compiled.ProgramIDIndex) >= len(message.AccountKeys) || message.AccountKeys[compiled.ProgramIDIndex] != ix.ProgramID() || !bytes.Equal(compiled.Data, data) || len(compiled.Accounts) != len(metas) {
		return bad
	}
	seen := map[solana.PublicKey]bool{}
	for _, key := range message.AccountKeys {
		if seen[key] {
			return bad
		}
		seen[key] = true
	}
	writable, err := message.IsWritable(ix.ProgramID())
	if err != nil || writable || message.IsSigner(ix.ProgramID()) {
		return bad
	}
	for i, meta := range metas {
		at := compiled.Accounts[i]
		if int(at) >= len(message.AccountKeys) || message.AccountKeys[at] != meta.PublicKey {
			return bad
		}
		writable, err = message.IsWritable(meta.PublicKey)
		expectedWritable := meta.IsWritable || meta.PublicKey == p.Owner
		if err != nil || writable != expectedWritable || message.IsSigner(meta.PublicKey) != meta.IsSigner {
			return bad
		}
	}
	return nil
}
