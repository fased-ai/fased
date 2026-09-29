package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type miningClaimExecutorFake struct {
	*miningClaimCostFake
	store       *signerStoreV2
	outcomeMode string
	sends       int
	result      *rpc.GetTransactionResult
	sig         solana.Signature
}

func (f *miningClaimExecutorFake) SendRawTransactionWithOpts(_ context.Context, wire []byte, o rpc.TransactionOpts) (solana.Signature, error) {
	f.sends++
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		return solana.Signature{}, e
	}
	if e = tx.VerifySignatures(); e != nil {
		f.t.Fatal(e)
	}
	r := readWENState(f.t, f.store)
	if r.State != "submission-uncertain" || o.SkipPreflight || o.MaxRetries == nil || *o.MaxRetries != 0 || o.MinContextSlot == nil || *o.MinContextSlot != 101 || o.PreflightCommitment != rpc.CommitmentFinalized {
		f.t.Fatal("send not durably fenced")
	}
	f.sig = tx.Signatures[0]
	v := *r.MiningClaimIntent
	ix, e := buildWENMiningClaimInstructionV1(v, tx.Message.AccountKeys[0])
	if e != nil {
		f.t.Fatal(e)
	}
	a := ix.Accounts()
	m := &rpc.TransactionMeta{Fee: 4500}
	index := map[string]int{}
	for i, k := range tx.Message.AccountKeys {
		index[k.String()] = i
		m.PreBalances = append(m.PreBalances, 10000000)
		m.PostBalances = append(m.PostBalances, 10000000)
	}
	m.PostBalances[0] -= 4500
	gross := uint64(100)
	if v.Operation == "sat" {
		gross = 20
	}
	if f.outcomeMode == "failed" {
		m.Err = "fixture failure"
	}
	if m.Err == nil && v.Operation == "sol" && f.outcomeMode != "wrong-movement" {
		m.PostBalances[0] += gross
		m.PostBalances[index[a[6].PublicKey.String()]] -= gross
	}
	if v.Operation == "sat" {
		mint, program, auth, owner := a[11].PublicKey, solana.Token2022ProgramID, a[7].PublicKey, tx.Message.AccountKeys[0]
		row := func(k solana.PublicKey, o *solana.PublicKey, n string) rpc.TokenBalance {
			return rpc.TokenBalance{AccountIndex: uint16(index[k.String()]), Mint: mint, Owner: o, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: n, Decimals: 11}}
		}
		m.PreTokenBalances = []rpc.TokenBalance{row(a[9].PublicKey, &auth, "800"), row(a[10].PublicKey, &owner, "0")}
		m.PostTokenBalances = []rpc.TokenBalance{row(a[9].PublicKey, &auth, "780"), row(a[10].PublicKey, &owner, "19")}
		if m.Err != nil || f.outcomeMode == "wrong-movement" {
			m.PostTokenBalances = m.PreTokenBalances
		}
	}
	if m.Err == nil {
		d := append([]byte(nil), f.page.Value[4].Data.GetBinary()...)
		d[10] = 1
		if v.Operation == "sat" {
			d[10] = 2
		}
		if f.outcomeMode == "wrong-paid" {
			d[10] = 0
		}
		f.page.Value[4].Data = rpc.DataBytesOrJSONFromBytes(d)
	}
	envelope := &rpc.TransactionResultEnvelope{}
	raw, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	if e = json.Unmarshal(raw, envelope); e != nil {
		f.t.Fatal(e)
	}
	f.result = &rpc.GetTransactionResult{Slot: 101, Meta: m, Transaction: envelope}
	if f.outcomeMode == "lost-success" || f.outcomeMode == "unknown" {
		return f.sig, errors.New("lost response")
	}
	return f.sig, nil
}
func (f *miningClaimExecutorFake) GetTransaction(_ context.Context, s solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if s != f.sig || o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 {
		f.t.Fatal("unbound recovery")
	}
	if f.outcomeMode == "unknown" {
		return nil, nil
	}
	return f.result, nil
}
func (f *miningClaimExecutorFake) GetMultipleAccountsWithOpts(ctx context.Context, k []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if len(k) == 1 {
		if k[0] != f.addresses[4] || o.Commitment != rpc.CommitmentFinalized || o.MinContextSlot == nil || *o.MinContextSlot != 101 {
			f.t.Fatal("unbound paid claim")
		}
		return &rpc.GetMultipleAccountsResult{RPCContext: f.page.RPCContext, Value: []*rpc.Account{f.page.Value[4]}}, nil
	}
	return f.miningClaimRPCFake.GetMultipleAccountsWithOpts(ctx, k, o)
}
func TestWENMiningClaimExecutionAndRecovery(t *testing.T) {
	_, _, pins, _ := miningClaimRPCFixture(t, "sol")
	raw, pins := miningClaimReviewDescriptor(t, pins)
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"success", "lost-success", "unknown", "failed", "wrong-movement", "wrong-paid"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				store, keys, v, policy, client := miningClaimExecutionFixture(t, raw, pins, op, mode)
				service := &signerServiceV2{store: store, keys: keys}
				digest, outcome, e := service.executeWENMiningClaimWithRPCV1(context.Background(), client, "state-request", "miner", policy.Hash, v)
				good := mode == "success" || mode == "lost-success" || mode == "failed"
				if (e == nil) != good || digest == "" || client.sends != 1 {
					t.Fatalf("execution %s %s %v sends %d", digest, outcome, e, client.sends)
				}
				expected := "finalized-success"
				if mode == "failed" {
					expected = "finalized-failed"
				}
				if !good {
					expected = "submission-uncertain"
				}
				if outcome != expected || readWENState(t, store).State != expected {
					t.Fatal("outcome", outcome, expected)
				}
				// Reopen the actual disk journal and recover without obtaining a key or sending.
				path, now := store.db.Path(), store.now
				if e = store.Close(); e != nil {
					t.Fatal(e)
				}
				store, e = openSignerStoreV2(path)
				if e != nil {
					t.Fatal(e)
				}
				defer store.Close()
				store.now = now
				client.store = store
				if mode == "unknown" {
					client.outcomeMode = "success"
					good = true
					expected = "finalized-success"
				}
				status, e := store.recoverWENMiningClaimExecutionV1(context.Background(), client, "state-request", digest)
				if (e == nil) != good || good && status != expected || client.sends != 1 {
					t.Fatal("recovery", status, e)
				}
				if good {
					if _, e = store.recoverWENMiningClaimExecutionV1(context.Background(), client, "state-request", digest); e != nil {
						t.Fatal("idempotent recovery", e)
					}
				}
				retained := "5000"
				if good {
					retained = "4500"
				}
				if e = store.db.View(func(tx *bolt.Tx) error {
					var r wenBudgetReservationV1
					if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("request:state-request")), &r); e != nil {
						return e
					}
					used := string(tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2("miner", "solana:native", r.UsageDay)))
					if used != retained {
						t.Fatal("capital charged as fee or reservation wrongly released", used, retained)
					}
					return nil
				}); e != nil {
					t.Fatal(e)
				}
				if _, e = store.prepareWENMiningClaimSubmissionV1(context.Background(), client, "state-request", digest); e == nil {
					t.Fatal("duplicate submission after restart")
				}

			})
		}
	}

}
func miningClaimExecutionFixture(t *testing.T, raw []byte, pins wenStakingPinsV1, op, mode string) (*signerStoreV2, *signerKeyManagerV2, signerWENMiningClaimIntentV1, signerPolicyV2, *miningClaimExecutorFake) {
	t.Helper()
	store, keys := openTestSignerV2(t)
	base, _, _, _ := miningClaimRPCFixture(t, op)
	record, old := createTestSignerWalletV2(t, store, keys, "miner", base.Economy, 100, 100)
	store.now = time.Now
	owner := solana.MustPublicKeyFromBase58(record.PublicKey)
	v, _, _, read := miningClaimRPCFixture(t, op, owner)
	v.DescriptorSHA256 = pins.DescriptorSHA256
	v.CapabilitySHA256 = pins.CapabilitySHA256
	state, e := readWENMiningClaimRPCV1(context.Background(), read, pins, v, owner, 2)
	if e != nil {
		t.Fatal(e)
	}
	v.AccountStateSHA256 = state.StateHash
	policy, e := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: "agent", Operations: []string{intentWENMiningClaimV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Economy}, MaxPerTx: "5000", MaxDaily: "10000"}}}, old.Version)
	if e != nil {
		t.Fatal(e)
	}
	for _, scope := range []string{wenMiningNativeScopeV1("miner", v.Genesis), wenMiningClaimLaunchScopeV1("miner", v)} {
		if e = store.configureWENBudgetV1(scope, 10000); e != nil {
			t.Fatal(e)
		}
	}
	root := filepath.Join(filepath.Dir(store.db.Path()), "wen-mining-claim", wenHashV1([]byte("miner")))
	if e = os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	review := wenMiningClaimReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: owner.String(), Intent: v, Pins: pins, MaxSlotLag: 2, MaxTotalCostLamports: 5000}
	data, _ := json.Marshal(review)
	if e = os.WriteFile(filepath.Join(root, wenMiningClaimAdmissionNameV1(v)), data, 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(root, pins.DescriptorSHA256), raw, 0600); e != nil {
		t.Fatal(e)
	}
	client := &miningClaimExecutorFake{miningClaimCostFake: &miningClaimCostFake{miningClaimRPCFake: read, expectedOwner: owner}, store: store, outcomeMode: mode}
	return store, keys, v, policy, client
}
