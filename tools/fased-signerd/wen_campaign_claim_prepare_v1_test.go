package main

import (
	"context"
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

type campaignClaimPrepareFake struct{ *campaignPrepareFake }

func (f *campaignClaimPrepareFake) GetMultipleAccountsWithOpts(_ context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if o.Commitment != rpc.CommitmentFinalized || o.MinContextSlot == nil || o.Encoding != solana.EncodingBase64 || len(keys) != len(f.addresses) {
		f.t.Fatal("unbounded claim read")
	}
	for i, k := range keys {
		if k != f.addresses[i] {
			f.t.Fatal("wrong claim key")
		}
	}
	slot := f.bump()
	if slot < *o.MinContextSlot {
		f.t.Fatal("stale fixture")
	}
	f.reads++
	out := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: slot}}}
	for i, a := range f.page.Value {
		cp := *a
		data := append([]byte(nil), a.Data.GetBinary()...)
		if i == 6 {
			binary.LittleEndian.PutUint64(data, slot)
		}
		if f.mode == "claim-changed" && f.reads > 1 && i == 1 {
			data[168]++
		}
		cp.Data = rpc.DataBytesOrJSONFromBytes(data)
		out.Value = append(out.Value, &cp)
	}
	return out, nil
}
func (f *campaignClaimPrepareFake) GetBalance(ctx context.Context, k solana.PublicKey, c rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	b, e := f.campaignPrepareFake.GetBalance(ctx, k, c)
	if f.mode == "balance" {
		b.Value = 4999
	}
	return b, e
}
func checkCampaignClaimPreparation(t *testing.T, base *campaignReadFake, pins signerWENBTCPinsV1, q wenCampaignClaimRequestV1, owner solana.PublicKey) {
	for _, mode := range []string{"ok", "fee", "balance", "expired", "expires-during", "claim-changed", "units", "simulation"} {
		t.Run("prepare-"+mode, func(t *testing.T) {
			f := &campaignClaimPrepareFake{&campaignPrepareFake{campaignReadFake: base, next: 109, mode: mode}}
			p, e := prepareWENCampaignClaimV1(context.Background(), f, pins, q, owner, 100, 132, 32, 5000, nil)
			if (e == nil) != (mode == "ok") {
				t.Fatal(mode, e)
			}
			if e == nil {
				if p.maximumDebit != 5000 {
					t.Fatal("claim should reserve only network fee")
				}
				fresh := func() *campaignClaimPrepareFake {
					return &campaignClaimPrepareFake{&campaignPrepareFake{campaignReadFake: base, next: 119}}
				}
				if _, e = prepareWENCampaignClaimV1(context.Background(), fresh(), pins, q, owner, 100, 132, 32, 5000, p); e != nil {
					t.Fatal("claim revalidation", e)
				}
				altered := *p
				altered.message = append([]byte(nil), p.message...)
				altered.message[len(altered.message)-1] ^= 1
				if _, e = prepareWENCampaignClaimV1(context.Background(), fresh(), pins, q, owner, 100, 132, 32, 5000, &altered); e == nil {
					t.Fatal("altered message accepted")
				}
				if sameWENCampaignClaimStateV1(p.snapshot, wenCampaignClaimSnapshotV1{}) {
					t.Fatal("different state equal")
				}
			}
		})
	}
}
