package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"reflect"
)

func campaignClaimPositionV1(s wenCampaignClaimSnapshotV1) wenCampaignPositionV1 {
	return wenCampaignPositionV1{Slot: s.Slot, ReferenceSlot: s.ReferenceSlot, Address: s.Position.Address, Owner: s.Position.Owner, Executable: s.Position.Executable, Data: append([]byte(nil), s.Position.Data...)}
}
func prepareWENCampaignClaimActionV1(ctx context.Context, c wenCampaignPrepareRPCV1, pins signerWENBTCPinsV1, a wenCampaignOwnerActionV1, owner solana.PublicKey, min, expires, lag, maxFee uint64, previous *wenCampaignPreparedV1) (*wenCampaignPreparedV1, error) {
	bad := errors.New("claim action mismatch")
	if a.Claim == nil || a.Setup != nil || a.Policy != nil || a.Amount != 0 || a.Claim.Program != a.Program || a.Claim.Economy != a.Economy {
		return nil, bad
	}
	var old *wenCampaignClaimPreparedV1
	if previous != nil {
		if previous.claim == nil {
			return nil, bad
		}
		old = &wenCampaignClaimPreparedV1{message: previous.message, blockhash: previous.blockhash, snapshot: *previous.claim, fee: previous.fee, units: previous.units, currentHeight: previous.currentHeight, lastValidHeight: previous.lastValidHeight, maximumDebit: maxFee}
	}
	p, e := prepareWENCampaignClaimV1(ctx, c, pins, *a.Claim, owner, min, expires, lag, maxFee, old)
	if e != nil {
		return nil, e
	}
	if p.snapshot.Position.Address != a.Position {
		return nil, bad
	}
	return &wenCampaignPreparedV1{message: p.message, blockhash: p.blockhash, position: campaignClaimPositionV1(p.snapshot), claim: &p.snapshot, fee: p.fee, units: p.units, currentHeight: p.currentHeight, lastValidHeight: p.lastValidHeight}, nil
}
func verifyWENCampaignClaimReviewV1(a wenCampaignReviewArtifactV1, owner solana.PublicKey) error {
	bad := errors.New("campaign claim review mismatch")
	b := a.Binding
	s := b.Claim
	q := a.Action.Claim
	if s == nil || q == nil || a.Action.Setup != nil || a.Action.Policy != nil || b.Setup != nil || a.Action.Amount != 0 || s.Program != a.Action.Program || s.Economy != a.Action.Economy || s.Owner != owner || q.Program != s.Program || q.Economy != s.Economy || q.Destination != s.Destination.Address || q.Mask != s.Mask || len(s.Page.Data) != 576 || q.PageIndex != binary.LittleEndian.Uint64(s.Page.Data[80:88]) || len(q.Windows) != len(s.Windows) || s.Position.Address != a.Action.Position || !reflect.DeepEqual(campaignClaimPositionV1(*s), b.Position) {
		return bad
	}
	for i, w := range q.Windows {
		if w.Window != s.Windows[i].Window.Address || w.Vault != s.Windows[i].Vault.Address {
			return bad
		}
	}
	ix, _, e := buildWENCampaignClaimV1(*s)
	if e != nil {
		return e
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
