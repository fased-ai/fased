package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"math"
	"reflect"

	solana "github.com/gagliardetto/solana-go"
)

func campaignSetupPositionV1(s wenCampaignSetupSnapshotV1) wenCampaignPositionV1 {
	p := s.Setup.Position
	rent := uint64(0)
	if len(s.RentByAllocation) > 0 {
		rent = s.RentByAllocation[0]
	}
	return wenCampaignPositionV1{Slot: s.Slot, ReferenceSlot: s.ReferenceSlot, Address: p.Address, Owner: p.Owner, Executable: p.Executable, Data: append([]byte{}, p.Data...), Lamports: p.Lamports, Rent: rent}
}

func prepareWENCampaignSetupActionV1(ctx context.Context, c wenCampaignPrepareRPCV1, pins signerWENBTCPinsV1, a wenCampaignOwnerActionV1, owner solana.PublicKey, min, expires, lag, maxFee uint64, previous *wenCampaignPreparedV1) (*wenCampaignPreparedV1, error) {
	bad := errors.New("campaign setup action mismatch")
	if a.Setup == nil || a.Setup.Program != a.Program || a.Setup.Economy != a.Economy || a.Amount != a.Setup.Terms.Deposit {
		return nil, bad
	}
	var old *wenCampaignSetupPreparedV1
	if previous != nil {
		if previous.setup == nil {
			return nil, bad
		}
		if a.Amount > math.MaxUint64-previous.setup.Rent || maxFee > math.MaxUint64-a.Amount-previous.setup.Rent {
			return nil, bad
		}
		old = &wenCampaignSetupPreparedV1{message: previous.message, blockhash: previous.blockhash, snapshot: *previous.setup, fee: previous.fee, units: previous.units, currentHeight: previous.currentHeight, lastValidHeight: previous.lastValidHeight, maximumDebit: a.Amount + previous.setup.Rent + maxFee}
	}
	p, e := prepareWENCampaignSetupV1(ctx, c, pins, *a.Setup, owner, min, expires, lag, maxFee, old)
	if e != nil {
		return nil, e
	}
	if p.snapshot.Setup.Position.Address != a.Position {
		return nil, bad
	}
	return &wenCampaignPreparedV1{message: p.message, blockhash: p.blockhash, position: campaignSetupPositionV1(p.snapshot), setup: &p.snapshot, fee: p.fee, units: p.units, currentHeight: p.currentHeight, lastValidHeight: p.lastValidHeight}, nil
}

func verifyWENCampaignReviewMessageV1(a wenCampaignReviewArtifactV1, owner solana.PublicKey) error {
	b := a.Binding
	if a.Action.Operation == "claim" {
		return verifyWENCampaignClaimReviewV1(a, owner)
	}
	if a.Action.Claim != nil || b.Claim != nil {
		return errors.New("unexpected claim binding")
	}
	if a.Action.Operation != "setup" {
		if a.Action.Setup != nil || b.Setup != nil {
			return errors.New("unexpected campaign setup")
		}
		return verifyWENCampaignOwnerMessageV1(a.Action, owner, b.Position, b.Blockhash, b.CurrentHeight, b.LastValidHeight, b.Message)
	}
	bad := errors.New("campaign setup review mismatch")
	if a.Action.Setup == nil || b.Setup == nil || a.Action.Policy != nil || b.Position.PolicyWindow != nil || b.Position.Now != 0 {
		return bad
	}
	q := a.Action.Setup
	s := b.Setup
	v := s.Setup
	if q.Program != a.Action.Program || q.Economy != a.Action.Economy || q.Issuer != v.Issuer || q.Terms != v.Terms || a.Action.Amount != q.Terms.Deposit || v.Program != q.Program || v.Economy != q.Economy || v.Owner != owner || v.Position.Address != a.Action.Position || len(v.Window.Data) != 256 || binary.LittleEndian.Uint64(v.Window.Data[112:120]) != q.Nonce || !reflect.DeepEqual(campaignSetupPositionV1(*s), b.Position) {
		return bad
	}
	ix, allocations, e := buildWENCampaignAtomicSetupV1(v)
	if e != nil {
		return e
	}
	if len(allocations) != len(s.RentByAllocation) {
		return bad
	}
	var rent uint64
	for _, n := range s.RentByAllocation {
		if n > math.MaxUint64-rent {
			return bad
		}
		rent += n
	}
	if rent != s.Rent {
		return bad
	}
	if b.Blockhash == (solana.Hash{}) || b.CurrentHeight >= b.LastValidHeight || len(b.Message)+65 > 1232 {
		return bad
	}
	tx, e := solana.NewTransaction([]solana.Instruction{ix}, b.Blockhash, solana.TransactionPayer(owner))
	if e != nil {
		return e
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	message, e := tx.Message.MarshalBinary()
	if e != nil {
		return e
	}
	if !bytes.Equal(message, b.Message) {
		return bad
	}
	return nil
}
