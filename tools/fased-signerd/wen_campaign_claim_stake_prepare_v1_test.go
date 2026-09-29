package main

import (
	"context"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

type directStakePrepareFake struct {
	*campaignPrepareFake
	rents int
}

func (f *directStakePrepareFake) GetMultipleAccountsWithOpts(_ context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MinContextSlot == nil || len(keys) != len(f.addresses) {
		f.t.Fatal("unbounded direct read")
	}
	slot := f.bump()
	if slot < *o.MinContextSlot {
		f.t.Fatal("rollback fixture")
	}
	f.reads++
	out := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: slot}}, Value: make([]*rpc.Account, len(keys))}
	for i, a := range f.page.Value {
		if keys[i] != f.addresses[i] {
			f.t.Fatal("wrong address")
		}
		if a == nil {
			continue
		}
		cp := *a
		d := append([]byte(nil), a.Data.GetBinary()...)
		if keys[i] == solana.SysVarClockPubkey {
			binary.LittleEndian.PutUint64(d, slot)
		}
		if f.reads > 1 && f.mode == "claim-changed" && i == 1 {
			d[168]++
		}
		cp.Data = rpc.DataBytesOrJSONFromBytes(d)
		out.Value[i] = &cp
	}
	return out, nil
}
func (f *directStakePrepareFake) GetMinimumBalanceForRentExemption(_ context.Context, n uint64, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized || (n != 104 && n != 112) {
		f.t.Fatal("unexpected rent request")
	}
	f.rents++
	switch f.mode {
	case "rent-zero":
		return 0, nil
	case "rent-overflow":
		return ^uint64(0), nil
	case "rent-error":
		return 0, errors.New("rent unavailable")
	case "rent-change":
		return 101, nil
	}
	return 100, nil
}
func (f *directStakePrepareFake) GetBalance(ctx context.Context, k solana.PublicKey, c rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	b, e := f.campaignPrepareFake.GetBalance(ctx, k, c)
	if f.mode == "balance" {
		b.Value = 4999
	}
	return b, e
}
func (f *directStakePrepareFake) SimulateRawTransactionWithOpts(ctx context.Context, w []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	s, e := f.campaignPrepareFake.SimulateRawTransactionWithOpts(ctx, w, o)
	if f.mode == "units" {
		*s.Value.UnitsConsumed = 400001
	}
	return s, e
}
func checkDirectStakePreparation(t *testing.T, base *wenReadRPCFake, pins wenStakingPinsV1, v signerWENStakingIntentV1, q wenCampaignClaimRequestV1, w solana.PublicKey, wantRent uint64) {
	v.MinFinalizedSlot = "140"
	v.ExpiresSlot = "172"
	v.MaxFeeLamports = "5000"
	fresh := func(mode string, next uint64) *directStakePrepareFake {
		return &directStakePrepareFake{campaignPrepareFake: &campaignPrepareFake{campaignReadFake: &campaignReadFake{wenReadRPCFake: base}, mode: mode, next: next}}
	}
	modes := []string{"ok", "fee", "balance", "expired", "expires-during", "claim-changed", "units", "simulation", "total-budget"}
	if wantRent > 0 {
		modes = append(modes, "rent-zero", "rent-overflow", "rent-error")
	}
	for _, mode := range modes {
		t.Run("prepare-"+mode, func(t *testing.T) {
			maxTotal := uint64(6000)
			if mode == "total-budget" {
				maxTotal = 4999
			}
			p, e := prepareWENCampaignClaimStakeV1(context.Background(), fresh(mode, 149), pins, v, q, w, 970, 32, maxTotal, nil)
			if (e == nil) != (mode == "ok") {
				t.Fatal(mode, e)
			}
			if e != nil {
				return
			}
			checkDirectStakeReview(t, pins, v, q, w, p)
			review, err := newWENCampaignClaimStakeReviewV1("direct-stake-review-001", "miner", "sha256:"+wenHashV1([]byte("policy")), pins, v, q, w, 970, 6000, p)
			if err != nil {
				t.Fatal(err)
			}
			digest, _ := review.digest()
			if _, err = revalidateWENCampaignClaimStakeReviewV1(context.Background(), fresh("", 159), review, digest, w, 32); err != nil {
				t.Fatal("approved recheck", err)
			}
			if _, err = revalidateWENCampaignClaimStakeReviewV1(context.Background(), fresh("", 159), review, wenHashV1([]byte("wrong")), w, 32); err == nil {
				t.Fatal("wrong approval accepted")
			}

			if p.rent != wantRent || p.maximumDebit != 5000+wantRent {
				t.Fatal("wrong reservation", p.rent, p.maximumDebit)
			}
			if _, e = prepareWENCampaignClaimStakeV1(context.Background(), fresh("", 159), pins, v, q, w, 970, 32, 6000, p); e != nil {
				t.Fatal("recheck", e)
			}
			changed := *p
			changed.message = append([]byte(nil), p.message...)
			changed.message[len(changed.message)-1] ^= 1
			if _, e = prepareWENCampaignClaimStakeV1(context.Background(), fresh("", 159), pins, v, q, w, 970, 32, 6000, &changed); e == nil {
				t.Fatal("changed message accepted")
			}
			if wantRent > 0 {
				if _, e = prepareWENCampaignClaimStakeV1(context.Background(), fresh("rent-change", 159), pins, v, q, w, 970, 32, 6000, p); e == nil {
					t.Fatal("changed rent accepted")
				}
			}
		})
	}
}
