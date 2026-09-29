package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

type claimExecutorFake struct {
	*claimJoinedFake
	store   *signerStoreV2
	mode    string
	sends   int
	result  *rpc.GetTransactionResult
	sig     solana.Signature
	paid    *rpc.Account
	paidKey solana.PublicKey
}

func (f *claimExecutorFake) SendRawTransactionWithOpts(_ context.Context, wire []byte, o rpc.TransactionOpts) (solana.Signature, error) {
	f.sends++
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		return solana.Signature{}, e
	}
	if e = tx.VerifySignatures(); e != nil {
		f.t.Fatal(e)
	}
	var r wenBudgetReservationV1
	f.store.db.View(func(tx *bolt.Tx) error {
		return json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("request:execution-claim")), &r)
	})
	if r.State != "submission-uncertain" || o.SkipPreflight || o.MaxRetries == nil || *o.MaxRetries != 0 {
		f.t.Fatal("unfenced send")
	}
	f.sig = tx.Signatures[0]
	if f.mode == "execute-uncertain" {
		return f.sig, errors.New("lost transport response")
	}
	meta := &rpc.TransactionMeta{Fee: 5000, Err: "fixture failure"}
	for range tx.Message.AccountKeys {
		meta.PreBalances = append(meta.PreBalances, 10)
		meta.PostBalances = append(meta.PostBalances, 10)
	}
	meta.PreBalances[0] = 10000
	meta.PostBalances[0] = 5000
	if f.mode == "execute-success" || f.mode == "execute-lost-success" {
		meta.Err = nil
		meta.Fee = 4500
		meta.PostBalances[0] = 4500
		v := *r.BTCClaimIntent
		w := tx.Message.AccountKeys[0]
		ix, _ := buildWENBTCClaimInstructionV1(v, w)
		a := ix.Accounts()
		indices := map[string]uint16{}
		for i, k := range tx.Message.AccountKeys {
			indices[k.String()] = uint16(i)
		}
		pi := indices[a[8].PublicKey.String()]
		meta.PreBalances[pi] = 0
		meta.PostBalances[pi] = 1000
		mint := solana.MustPublicKeyFromBase58(v.Mint)
		program := solana.TokenProgramID
		authority := a[11].PublicKey
		row := func(k solana.PublicKey, o *solana.PublicKey, n string) rpc.TokenBalance {
			return rpc.TokenBalance{AccountIndex: indices[k.String()], Mint: mint, Owner: o, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: n, Decimals: 8}}
		}
		meta.PreTokenBalances = []rpc.TokenBalance{row(a[9].PublicKey, &authority, "800"), row(a[10].PublicKey, &w, "800")}
		meta.PostTokenBalances = []rpc.TokenBalance{row(a[9].PublicKey, &authority, "550"), row(a[10].PublicKey, &w, "1050")}
		funding := a[3].PublicKey
		_, bump, _ := solana.FindProgramAddress([][]byte{[]byte("wen-btc-paid-v1"), funding[:], w[:]}, ix.ProgramID())
		d := make([]byte, 96)
		copy(d, "WENBTPD1")
		d[8] = 1
		d[11] = bump
		copy(d[16:], funding[:])
		copy(d[48:], w[:])
		binary.LittleEndian.PutUint64(d[80:], 250)
		binary.LittleEndian.PutUint64(d[88:], 25)
		f.paid = &rpc.Account{Owner: ix.ProgramID(), Data: rpc.DataBytesOrJSONFromBytes(d)}
		f.paidKey = a[8].PublicKey
	}
	envelope := &rpc.TransactionResultEnvelope{}
	b, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	json.Unmarshal(b, envelope)
	f.result = &rpc.GetTransactionResult{Slot: 150, Meta: meta, Transaction: envelope}
	if f.mode == "execute-lost-success" {
		return f.sig, errors.New("accepted but response lost")
	}
	return f.sig, nil
}
func (f *claimExecutorFake) GetTransaction(_ context.Context, s solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if s != f.sig || o.Commitment != rpc.CommitmentFinalized {
		f.t.Fatal("unbound receipt")
	}
	return f.result, nil
}

func (f *claimExecutorFake) GetMultipleAccountsWithOpts(c context.Context, k []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if len(k) == 1 {
		if f.paid == nil || k[0] != f.paidKey || o.Commitment != rpc.CommitmentFinalized || o.MinContextSlot == nil || *o.MinContextSlot != 150 {
			f.t.Fatal("paid readback")
		}
		return &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: []*rpc.Account{f.paid}}, nil
	}
	return f.claimJoinedFake.GetMultipleAccountsWithOpts(c, k, o)
}
