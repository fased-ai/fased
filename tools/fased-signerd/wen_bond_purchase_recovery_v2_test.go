package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
	"testing"
)

type bondRecoveryFakeV2 struct {
	*wenBondPurchaseRPCFakeV2
	result    *rpc.GetTransactionResult
	signature solana.Signature
}

func (f *bondRecoveryFakeV2) GetTransaction(_ context.Context, sig solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if sig != f.signature || o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MaxSupportedTransactionVersion == nil || *o.MaxSupportedTransactionVersion != 0 {
		f.t.Fatal("unbound recovery")
	}
	if f.result == nil {
		return nil, rpc.ErrNotFound
	}
	return f.result, nil
}
func bondPurchaseReceiptV2(t *testing.T, a wenBondPurchaseReviewArtifactV2, wire []byte, failed bool) *rpc.GetTransactionResult {
	t.Helper()
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		t.Fatal(e)
	}
	static := len(tx.Message.AccountKeys)
	tables, e := verifiedWENBTCLookupTablesV1(a.Policy.internalLookups(), a.Binding.Snapshot.Lookups, signerWENBTCMessageLifeV1{minimumSlot: a.Binding.Snapshot.Slot, maximumSlotLag: a.Policy.MaxSlotLag})
	if e != nil {
		t.Fatal(e)
	}
	if e = tx.Message.SetAddressTables(tables); e != nil {
		t.Fatal(e)
	}
	if e = tx.Message.ResolveLookups(); e != nil {
		t.Fatal(e)
	}
	m := &rpc.TransactionMeta{Fee: a.Binding.Fee}
	if failed {
		m.Err = "fixture failure"
	}
	wc := 0
	for _, l := range tx.Message.GetAddressTableLookups() {
		wc += len(l.WritableIndexes)
	}
	m.LoadedAddresses.Writable = append([]solana.PublicKey(nil), tx.Message.AccountKeys[static:static+wc]...)
	m.LoadedAddresses.ReadOnly = append([]solana.PublicKey(nil), tx.Message.AccountKeys[static+wc:]...)
	ix, e := buildWENBondPurchaseV2(a.Binding.Snapshot.Pins, a.Binding.Snapshot.Quote, a.Policy.Nonce, a.Binding.Snapshot.Now, a.Policy.Route)
	if e != nil {
		t.Fatal(e)
	}
	roles := ix[0].Accounts()
	q, e := inspectWENBondQuoteV2(a.Pins.Bond, a.Binding.Snapshot.Quote, a.Policy.Nonce)
	if e != nil {
		t.Fatal(e)
	}
	usdc := solana.PublicKeyFromBytes(a.Pins.PolicyBytes[8:40])
	for i, k := range tx.Message.AccountKeys {
		pre, post := uint64(1000000000), uint64(1000000000)
		if i == 0 {
			post -= m.Fee
		}
		m.PreBalances = append(m.PreBalances, pre)
		m.PostBalances = append(m.PostBalances, post)
		owner, mint, program, decimals := a.Pins.Bond.Owner, usdc, solana.TokenProgramID, uint8(6)
		before, after := uint64(1000000000), uint64(1000000000)
		switch k {
		case a.Pins.Source:
			if !failed {
				after -= q.Cash
			}
		case roles[23].PublicKey:
			if failed {
				continue
			}
			owner, mint, program, decimals = roles[19].PublicKey, roles[9].PublicKey, solana.Token2022ProgramID, 11
			before, after = 0, q.Gross
		case roles[17].PublicKey:
			owner, mint, decimals = roles[2].PublicKey, roles[25].PublicKey, 8
			if !failed {
				after += q.RequiredBTC
			}
		default:
			continue
		}
		row := rpc.TokenBalance{AccountIndex: uint16(i), Owner: &owner, Mint: mint, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: strconv.FormatUint(before, 10), Decimals: decimals}}
		if k != roles[23].PublicKey {
			m.PreTokenBalances = append(m.PreTokenBalances, row)
		}
		row.UiTokenAmount = &rpc.UiTokenAmount{Amount: strconv.FormatUint(after, 10), Decimals: decimals}
		m.PostTokenBalances = append(m.PostTokenBalances, row)
	}
	env := &rpc.TransactionResultEnvelope{}
	raw, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	if e = json.Unmarshal(raw, env); e != nil {
		t.Fatal(e)
	}
	return &rpc.GetTransactionResult{Slot: a.Binding.Snapshot.ReferenceSlot + 1, Meta: m, Transaction: env}
}
func TestWENBondClaimV2RightsBeforeVestingAndAfterClaim(t *testing.T) {
	p, q, r, n, now := bondClaimFixtureV2(t)
	start := binary.LittleEndian.Uint64(r.Data[184:])
	for _, at := range []uint64{start} {
		rights, e := inspectWENBondRightsV2(p, q, r, n, at)
		if e != nil || rights.AvailableGross != 0 {
			t.Fatal("accepted unvested rights missing", e)
		}
		if _, e = inspectWENBondClaimV2(p, q, r, n, at, 1); e == nil {
			t.Fatal("unvested claim admitted")
		}
	}
	binary.LittleEndian.PutUint64(r.Data[256:], 10000000000000)
	binary.LittleEndian.PutUint64(r.Data[264:], 9700000000000)
	binary.LittleEndian.PutUint64(r.Data[272:], 300000000000)
	rights, e := inspectWENBondRightsV2(p, q, r, n, now+604800)
	if e != nil || rights.AvailableGross != 0 {
		t.Fatal("settled rights missing", e)
	}
	if _, e = inspectWENBondClaimV2(p, q, r, n, now+604800, 1); e == nil {
		t.Fatal("duplicate claim admitted")
	}
}

func (f *bondRecoveryFakeV2) SendRawTransactionWithOpts(context.Context, []byte, rpc.TransactionOpts) (solana.Signature, error) {
	f.t.Fatal("recovery attempted another send")
	return solana.Signature{}, nil
}
