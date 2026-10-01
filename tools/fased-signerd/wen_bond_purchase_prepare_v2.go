package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
)

// Private, unsigned packet preparation. Callers must authenticate deployment,
// venue, oracle, accounting and rent/cost inputs before any signing admission.
// A quote plus this packet is not proof of those prerequisites or a reservation.
type wenBondPurchasePreparedV2 struct {
	pins       wenBondPurchasePinsV2
	quote      wenBondAccountV2
	source     signerWENBTCAccountV1
	nonce, now uint64
	route      signerWENBTCRouteV1
	blockhash  solana.Hash
	units      uint32
	lookups    []signerWENBTCLookupPinV1
	life       signerWENBTCMessageLifeV1
	message    []byte
}

func prepareWENBondPurchaseMessageV2(p wenBondPurchasePinsV2, quote wenBondAccountV2, source *signerWENBTCAccountV1, nonce, now uint64, route signerWENBTCRouteV1, blockhash solana.Hash, units uint32, pins []signerWENBTCLookupPinV1, snapshots []*signerWENBTCAccountV1, life signerWENBTCMessageLifeV1) (*wenBondPurchasePreparedV2, error) {
	bad := errors.New("Bond unsigned purchase funding rejected")
	// Own all mutable inputs before validating them or retaining a preparation.
	p.PolicyBytes = append([]byte(nil), p.PolicyBytes...)
	quote.Data = append([]byte(nil), quote.Data...)
	route.Data = append([]byte(nil), route.Data...)
	route.Accounts = append([]signerTypedAccountV2(nil), route.Accounts...)
	pins = append([]signerWENBTCLookupPinV1(nil), pins...)
	q, e := inspectWENBondQuoteV2(p.Bond, quote, nonce)
	if e != nil {
		return nil, e
	}
	if source == nil || len(p.PolicyBytes) != 96 || life.minimumSlot == 0 || life.maximumSlotLag > 32 || source.Slot < life.minimumSlot || source.Slot-life.minimumSlot > life.maximumSlotLag || binary.LittleEndian.Uint64(quote.Data[232:]) > source.Slot {
		return nil, bad
	}
	ownedSource := *source
	ownedSource.Data = append([]byte(nil), source.Data...)
	usdc := solana.PublicKeyFromBytes(p.PolicyBytes[8:40])
	if _, e = wenMarketQuoteCashV1(&ownedSource, p.Source, usdc, p.Bond.Owner, source.Slot, q.Cash); e != nil {
		return nil, e
	}
	message, e := compileWENBondPurchaseV2(p, quote, nonce, now, route, blockhash, units, pins, snapshots, life, nil)
	if e != nil {
		return nil, e
	}
	return &wenBondPurchasePreparedV2{p, quote, ownedSource, nonce, now, route, blockhash, units, pins, life, append([]byte(nil), message...)}, nil
}
func (p *wenBondPurchasePreparedV2) revalidate(quote wenBondAccountV2, source *signerWENBTCAccountV1, now, height uint64, snapshots []*signerWENBTCAccountV1) ([]byte, error) {
	bad := errors.New("Bond purchase preparation changed or expired")
	if p == nil || source == nil || height < p.life.currentHeight || now < p.now || quote.Key != p.quote.Key || quote.Owner != p.quote.Owner || quote.Executable != p.quote.Executable || !bytes.Equal(quote.Data, p.quote.Data) || source.Address != p.source.Address || source.Owner != p.source.Owner || source.Executable != p.source.Executable || source.Slot < p.source.Slot || !bytes.Equal(source.Data, p.source.Data) {
		return nil, bad
	}
	life := p.life
	life.currentHeight = height
	fresh, e := prepareWENBondPurchaseMessageV2(p.pins, quote, source, p.nonce, now, p.route, p.blockhash, p.units, p.lookups, snapshots, life)
	if e != nil {
		return nil, e
	}
	if !bytes.Equal(fresh.message, p.message) {
		return nil, bad
	}
	return append([]byte(nil), p.message...), nil
}
