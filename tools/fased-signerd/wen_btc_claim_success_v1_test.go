package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"testing"
)

func TestWENBTCClaimSuccessEffects(t *testing.T) {
	for _, mode := range []string{"ok", "amount", "weight", "paid-owner", "paid-slot", "rent", "tokens", "owner", "failed", "state", "saved-amount", "saved-weight", "recover", "recover-missing", "recover-wrong-chain"} {
		t.Run(mode, func(t *testing.T) {
			v := btcClaimIntentFixture()
			v.MaxRentLamports = "1000"
			key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{19}, 32))
			w := solana.PublicKeyFromBytes(key.Public().(ed25519.PublicKey))
			ix, _ := buildWENBTCClaimInstructionV1(v, w)
			a := ix.Accounts()
			block := solana.Hash{8}
			tx, _ := solana.NewTransaction([]solana.Instruction{ix}, block, solana.TransactionPayer(w))
			tx.Message.SetVersion(solana.MessageVersionV0)
			msg, _ := tx.Message.MarshalBinary()
			var signature solana.Signature
			copy(signature[:], ed25519.Sign(key, msg))
			tx.Signatures = []solana.Signature{signature}
			wire, _ := tx.MarshalBinary()
			keys, _ := tx.Message.GetAllKeys()
			index := map[string]int{}
			r := wenBudgetReservationV1{WalletID: "miner", WalletPublicKey: w.String(), Genesis: v.Genesis, BTCClaimIntent: &v, WalletClaims: map[string]uint64{"solana:native": 6000}, Scopes: map[string]uint64{wenMiningNativeScopeV1("miner", v.Genesis): 6000, wenBTCClaimLaunchScopeV1("miner", v): 6000}, SignedMessage: msg, MessageSHA256: wenHashV1(msg), MinExecutionSlot: 10, BTCClaimPrepared: &wenBTCClaimMessageBindingV1{Amount: 250, Weight: 25, Message: msg, Blockhash: block, ReviewSHA: wenHashV1([]byte("review")), StateHash: wenHashV1([]byte("state")), Slot: 10, Fee: 5000, Rent: 1000, LastValidHeight: 200}}
			m := &rpc.TransactionMeta{Fee: 5000}
			for i, k := range keys {
				index[k.String()] = i
				r.AccountKeys = append(r.AccountKeys, k.String())
				m.PreBalances = append(m.PreBalances, 10)
				m.PostBalances = append(m.PostBalances, 10)
			}
			m.PreBalances[0] = 10000
			m.PostBalances[0] = 4000
			pi := index[a[8].PublicKey.String()]
			m.PreBalances[pi] = 0
			m.PostBalances[pi] = 1000
			mint := solana.MustPublicKeyFromBase58(v.Mint)
			program := solana.TokenProgramID
			owner := w
			auth := a[11].PublicKey
			row := func(i int, o *solana.PublicKey, n string) rpc.TokenBalance {
				return rpc.TokenBalance{AccountIndex: uint16(i), Mint: mint, Owner: o, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: n, Decimals: 8}}
			}
			vi := index[a[9].PublicKey.String()]
			di := index[v.Destination]
			m.PreTokenBalances = []rpc.TokenBalance{row(vi, &auth, "800"), row(di, &owner, "0")}
			m.PostTokenBalances = []rpc.TokenBalance{row(vi, &auth, "550"), row(di, &owner, "250")}
			result := &rpc.GetTransactionResult{Slot: 15, Meta: m, Transaction: &rpc.TransactionResultEnvelope{}}
			if e := result.Transaction.UnmarshalJSON([]byte(`["` + base64.StdEncoding.EncodeToString(wire) + `","base64"]`)); e != nil {
				t.Fatal(e)
			}
			funding := a[3].PublicKey
			_, b, _ := solana.FindProgramAddress([][]byte{[]byte("wen-btc-paid-v1"), funding[:], w[:]}, ix.ProgramID())
			d := make([]byte, 96)
			copy(d, "WENBTPD1")
			d[8] = 1
			d[11] = b
			copy(d[16:], funding[:])
			copy(d[48:], w[:])
			binary.LittleEndian.PutUint64(d[80:], 250)
			binary.LittleEndian.PutUint64(d[88:], 25)
			paid := &signerWENBTCAccountV1{Address: a[8].PublicKey, Owner: ix.ProgramID(), Slot: 15, Data: d}

			switch mode {
			case "amount":
				d[80] ^= 1
			case "weight":
				d[88] ^= 1
			case "paid-owner":
				paid.Owner = w
			case "paid-slot":
				paid.Slot = 14
			case "rent":
				m.PostBalances[pi] = 999
			case "tokens":
				m.PostTokenBalances[1].UiTokenAmount.Amount = "249"
			case "owner":
				owner = auth
			case "failed":
				m.Err = "error"
			case "saved-amount":
				r.BTCClaimPrepared.Amount++
			case "saved-weight":
				r.BTCClaimPrepared.Weight++
			case "state":
				r.BTCClaimPrepared.StateHash = "wrong"
			}
			hash := wenBTCClaimSuccessEffectsV1(r, result, paid)
			if (hash != "") != (mode == "ok" || mode == "recover" || mode == "recover-missing" || mode == "recover-wrong-chain") {
				t.Fatal("unexpected proof", hash)
			}
			if mode == "recover" || mode == "recover-missing" || mode == "recover-wrong-chain" {
				store, base := wenStateFixture(t)
				r.Version = base.Version
				r.Digest = base.Digest
				r.PolicyHash = base.PolicyHash
				r.UsageDay = base.UsageDay
				r.State = "submission-uncertain"
				r.MinFinalizedSlot = "1"
				r.Signature = signature.String()
				raw, _ := json.Marshal(r)
				if e := store.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(wenBudgetBucketV1).Put([]byte("request:state-request"), raw) }); e != nil {
					t.Fatal(e)
				}
				client := &claimOutcomeFake{t: t, result: result, paid: paid, mode: mode}
				status, e := store.reconcileWENTransactionV1(context.Background(), client, "state-request", r.Digest)
				if (e == nil) != (mode == "recover") {
					t.Fatal("recovery", e)
				}
				if mode == "recover" {
					saved := readWENState(t, store)
					if status != "finalized-success" || saved.BTCClaimEffectsSHA256 == "" {
						t.Fatal("missing outcome proof")
					}
					if _, e = store.reconcileWENTransactionV1(context.Background(), client, "state-request", r.Digest); e != nil {
						t.Fatal("repeat recovery", e)
					}
				} else if readWENState(t, store).State != "submission-uncertain" {
					t.Fatal("bad proof advanced outcome")
				}
			}

		})
	}
}

type claimOutcomeFake struct {
	t      *testing.T
	result *rpc.GetTransactionResult
	paid   *signerWENBTCAccountV1
	mode   string
}

func (f *claimOutcomeFake) GetGenesisHash(context.Context) (solana.Hash, error) {
	if f.mode == "recover-wrong-chain" {
		return solana.Hash{2}, nil
	}
	return solana.Hash{1}, nil
}
func (f *claimOutcomeFake) GetSlot(context.Context, rpc.CommitmentType) (uint64, error) {
	return 15, nil
}
func (f *claimOutcomeFake) GetTransaction(_ context.Context, _ solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if o.Commitment != rpc.CommitmentFinalized {
		f.t.Fatal("unfinalized")
	}
	return f.result, nil
}
func (f *claimOutcomeFake) GetMultipleAccountsWithOpts(_ context.Context, k []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if len(k) != 1 || k[0] != f.paid.Address || o.Commitment != rpc.CommitmentFinalized || o.MinContextSlot == nil || *o.MinContextSlot != 15 {
		f.t.Fatal("paid request")
	}
	var a *rpc.Account
	if f.mode != "recover-missing" {
		a = &rpc.Account{Owner: f.paid.Owner, Data: rpc.DataBytesOrJSONFromBytes(f.paid.Data)}
	}
	return &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 15}}, Value: []*rpc.Account{a}}, nil
}
