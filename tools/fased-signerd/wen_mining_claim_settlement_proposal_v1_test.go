package main

import (
	"context"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

type miningClaimLocatorFake struct {
	*miningClaimRPCFake
	mode string
}

func (f *miningClaimLocatorFake) GetMultipleAccountsWithOpts(ctx context.Context, k []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if len(k) != 3 {
		if o.MinContextSlot == nil || *o.MinContextSlot != 101 || o.Commitment != rpc.CommitmentFinalized || len(k) != len(f.addresses) {
			f.t.Fatal("full pinned read")
		}
		for i, key := range k {
			if key != f.addresses[i] {
				f.t.Fatal("full read key")
			}
		}
		return f.page, nil
	}
	indices := []int{4, 3, 2}
	out := &rpc.GetMultipleAccountsResult{RPCContext: f.page.RPCContext}
	for i, n := range indices {
		if k[i] != f.addresses[n] || o.Commitment != rpc.CommitmentFinalized || o.MinContextSlot == nil {
			f.t.Fatal("locator keys")
		}
		a := *f.page.Value[n]
		d := append([]byte(nil), a.Data.GetBinary()...)
		if f.mode == "amount" && i == 0 {
			d[176]++
			d[184]++
		}
		if f.mode == "id" && i == 1 {
			d[208]++
		}
		if f.mode == "ordinal" && i == 2 {
			d[160] ^= 1
		}
		a.Data = rpc.DataBytesOrJSONFromBytes(d)
		out.Value = append(out.Value, &a)
	}
	if f.mode == "stale" {
		out.Context.Slot = 99
	}
	if f.mode == "missing" {
		out.Value[0] = nil
	}
	return out, nil
}
func TestWENMiningClaimSettlementProposal(t *testing.T) {
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "amount", "id", "ordinal", "stale", "missing", "paid", "custody", "descriptor", "owner"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				v, w, pins, f := miningClaimRPCFixture(t, op)
				raw, pins := miningClaimReviewDescriptor(t, pins)
				if op == "sat" {
					program := solana.MustPublicKeyFromBase58(v.ProgramID)
					sale := solana.MustPublicKeyFromBase58(v.Economy)
					mint, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), sale[:]}, program)
					dest, _, _ := solana.FindProgramAddress([][]byte{w[:], solana.Token2022ProgramID[:], mint[:]}, solana.SPLAssociatedTokenAccountProgramID)
					text := dest.String()
					v.Destination = &text
					f.addresses[13] = dest
				}
				ix, _ := buildWENMiningClaimInstructionV1(v, w)
				a := ix.Accounts()
				candidate := wenMiningClaimCandidateV1{Intent: signerWENMiningIntentV1{Genesis: v.Genesis, ProgramID: v.ProgramID, Economy: v.Economy, Offer: a[2].PublicKey.String(), Entry: a[5].PublicKey.String(), Nonce: v.Nonce}}
				if mode == "paid" {
					d := f.page.Value[4].Data.GetBinary()
					d[10] = 3
				}
				if mode == "custody" {
					f.page.Value[4].Lamports = 0
					if op == "sat" {
						f.page.Value[11].Lamports = 0
						f.page.Value[11].Data = rpc.DataBytesOrJSONFromBytes([]byte{})
					}
				}
				if mode == "descriptor" {
					raw[0] ^= 1
				}
				if mode == "owner" {
					w = solana.PublicKey{9}
				}
				out, e := proposeDiscoveredWENMiningClaimV1(context.Background(), &miningClaimLocatorFake{f, mode}, pins, raw, candidate, w, op, 100, 132, 5000, 2)
				if (e == nil) != (mode == "ok") {
					t.Fatal(mode, e)
				}
				if mode == "ok" {
					if out.SigningEnabled || out.Status != "requires-review" || out.Intent.ExpectedGross != v.ExpectedGross || out.Intent.ID != v.ID || out.Intent.Ordinal != v.Ordinal || out.Intent.AccountStateSHA256 == "" {
						t.Fatal("unverified proposal")
					}
				}
			})
		}
	}
}
