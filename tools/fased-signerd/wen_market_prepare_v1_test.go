package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenMarketPrepareFakeV1 struct {
	*wenMarketReadFakeV1
	mode           string
	message        []byte
	reads, heights int
	owner          solana.PublicKey
}

func (f *wenMarketPrepareFakeV1) GetMultipleAccountsWithOpts(ctx context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	f.reads++
	min := uint64(100)
	if f.reads > 1 {
		min = 101
	}
	if o.MinContextSlot == nil || *o.MinContextSlot != min || o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || len(keys) != len(f.addresses) {
		f.t.Fatal("unbounded preparation read")
	}
	for i, k := range keys {
		if k != f.addresses[i] {
			f.t.Fatal("changed read key", i)
		}
	}
	f.page.Context.Slot = min
	clock := append([]byte(nil), f.page.Value[13].Data.GetBinary()...)
	binary.LittleEndian.PutUint64(clock, min)
	f.page.Value[13].Data = rpc.DataBytesOrJSONFromBytes(clock)
	return f.page, nil
}
func (f *wenMarketPrepareFakeV1) GetLatestBlockhash(_ context.Context, c rpc.CommitmentType) (*rpc.GetLatestBlockhashResult, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("commitment")
	}
	if f.mode == "missing hash" {
		return nil, nil
	}
	slot := uint64(101)
	if f.mode == "stale hash" {
		slot = 99
	}
	return &rpc.GetLatestBlockhashResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: slot}}, Value: &rpc.LatestBlockhashResult{Blockhash: solana.Hash{7}, LastValidBlockHeight: 200}}, nil
}
func (f *wenMarketPrepareFakeV1) GetBlockHeight(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("commitment")
	}
	f.heights++
	if f.mode == "expired" || f.mode == "expires during" && f.heights > 1 {
		return 200, nil
	}
	if f.mode == "height rollback" && f.heights > 1 {
		return 149, nil
	}
	return 150, nil
}
func (f *wenMarketPrepareFakeV1) GetFeeForMessage(_ context.Context, m string, c rpc.CommitmentType) (*rpc.GetFeeForMessageResult, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("commitment")
	}
	raw, e := base64.StdEncoding.DecodeString(m)
	if e != nil {
		f.t.Fatal(e)
	}
	f.message = raw
	n := uint64(5000)
	if f.mode == "fee cap" {
		n++
	}
	return &rpc.GetFeeForMessageResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 101}}, Value: &n}, nil
}
func (f *wenMarketPrepareFakeV1) GetBalance(_ context.Context, owner solana.PublicKey, c rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	if c != rpc.CommitmentFinalized || owner != f.owner {
		f.t.Fatal("balance owner")
	}
	n := uint64(114767240)
	if f.mode == "execution balance" {
		n += 1000
	}
	if f.mode == "protected balance" {
		n--
	}
	return &rpc.GetBalanceResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 101}}, Value: n}, nil
}
func (f *wenMarketPrepareFakeV1) SimulateRawTransactionWithOpts(_ context.Context, wire []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	if o.Commitment != rpc.CommitmentFinalized || o.SigVerify || o.ReplaceRecentBlockhash || len(wire) != 65+len(f.message) || wire[0] != 1 || !bytes.Equal(wire[1:65], make([]byte, 64)) || !bytes.Equal(wire[65:], f.message) {
		f.t.Fatal("simulation wire replaced")
	}
	if f.mode == "custody changed" {
		d := append([]byte(nil), f.page.Value[8].Data.GetBinary()...)
		d[64]--
		f.page.Value[8].Data = rpc.DataBytesOrJSONFromBytes(d)
	}
	n := uint64(90000)
	if f.mode == "compute cap" {
		n = 200001
	}
	out := &rpc.SimulateTransactionResponse{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 101}}, Value: &rpc.SimulateTransactionResult{UnitsConsumed: &n}}
	if f.mode == "simulation error" {
		out.Value.Err = "program error"
	}
	if f.mode == "expired simulation" {
		out.Context.Slot = 132
	}
	return out, nil
}
func TestWENMarketPrepareUnsignedAndImmutable(t *testing.T) {
	f, p, policy, l := marketReadFixtureV1(t)
	c := &wenMarketPrepareFakeV1{wenMarketReadFakeV1: f, owner: p.Owner}
	out, e := prepareWENMarketBuyV1(context.Background(), c, p, policy, l, 5000, 114762240, nil)
	if e != nil {
		t.Fatal(e)
	}
	if out.fee != 5000 || out.units != 90000 || out.snapshot.Quote.QuotedNet < l.RequestedNet || out.snapshot.Quote.InputCash == 0 {
		t.Fatal("incomplete cost-bound preparation")
	}
	if e = verifyWENMarketBuyMessageV1(out.message, p, out.snapshot.Quote, l, out.blockhash, out.currentHeight, out.lastValidHeight); e != nil {
		t.Fatal(e)
	}
	// A new preparation may not replace an already reviewed blockhash or message.
	g, p, policy, l := marketReadFixtureV1(t)
	next := &wenMarketPrepareFakeV1{wenMarketReadFakeV1: g, owner: p.Owner}
	again, e := prepareWENMarketBuyV1(context.Background(), next, p, policy, l, 5000, 114762240, out)
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(again.message, out.message) {
		t.Fatal("reviewed message changed")
	}
	g, p, policy, l = marketReadFixtureV1(t)
	next = &wenMarketPrepareFakeV1{wenMarketReadFakeV1: g, owner: p.Owner}
	copyReview := *out
	copyReview.message = append([]byte(nil), out.message...)
	copyReview.message[5] ^= 1
	if _, e = prepareWENMarketBuyV1(context.Background(), next, p, policy, l, 5000, 114762240, &copyReview); e == nil {
		t.Fatal("altered review reused")
	}
}
func TestWENMarketPrepareRejectsCostsAndRecoveryChanges(t *testing.T) {
	for _, mode := range []string{"missing hash", "stale hash", "fee cap", "protected balance", "expired", "expires during", "height rollback", "custody changed", "compute cap", "simulation error", "expired simulation"} {
		t.Run(mode, func(t *testing.T) {
			f, p, policy, l := marketReadFixtureV1(t)
			c := &wenMarketPrepareFakeV1{wenMarketReadFakeV1: f, mode: mode, owner: p.Owner}
			if _, e := prepareWENMarketBuyV1(context.Background(), c, p, policy, l, 5000, 114762240, nil); e == nil {
				t.Fatal("unsafe preparation accepted")
			}
		})
	}
}

func TestWENMarketPrepareRejectsChangedReviewAuthority(t *testing.T) {
	f, p, policy, l := marketReadFixtureV1(t)
	c := &wenMarketPrepareFakeV1{wenMarketReadFakeV1: f, owner: p.Owner}
	saved, e := prepareWENMarketBuyV1(context.Background(), c, p, policy, l, 5000, 114762240, nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, mode := range []string{"cash cap", "fee cap", "retained balance", "deployed bytes", "network", "owner"} {
		t.Run(mode, func(t *testing.T) {
			g, pp, pol, ll := marketReadFixtureV1(t)
			client := &wenMarketPrepareFakeV1{wenMarketReadFakeV1: g, owner: pp.Owner}
			fee, retained := uint64(5000), uint64(114762240)
			switch mode {
			case "cash cap":
				ll.MaxCash++
			case "fee cap":
				fee++
			case "retained balance":
				retained--
			case "deployed bytes":
				pol.Venue.CodeSHA256 = pol.Successor.ProgramID
			case "network":
				pol.Venue.Genesis = "different"
			case "owner":
				pp.Owner = pp.Config
			}
			if _, e = prepareWENMarketBuyV1(context.Background(), client, pp, pol, ll, fee, retained, saved); e == nil {
				t.Fatal("changed review authority accepted")
			}
			if client.reads != 0 {
				t.Fatal("changed authority reached RPC")
			}
		})
	}
}
