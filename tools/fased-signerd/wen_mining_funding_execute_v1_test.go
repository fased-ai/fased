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

type fundingExecutorFake struct {
	*fundingCostFake
	store       *signerStoreV2
	outcomeMode string
	sends       int
	result      *rpc.GetTransactionResult
	sig         solana.Signature
}

func (f *fundingExecutorFake) SendRawTransactionWithOpts(_ context.Context, wire []byte, o rpc.TransactionOpts) (solana.Signature, error) {
	f.sends++
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		return solana.Signature{}, e
	}
	if e = tx.VerifySignatures(); e != nil {
		f.t.Fatal(e)
	}
	r := readWENState(f.t, f.store)
	if r.State != "submission-uncertain" || o.SkipPreflight || o.MaxRetries == nil || *o.MaxRetries != 0 || o.MinContextSlot == nil || *o.MinContextSlot != 10 || o.PreflightCommitment != rpc.CommitmentFinalized {
		f.t.Fatal("send not durably fenced")
	}
	f.sig = tx.Signatures[0]
	m := &rpc.TransactionMeta{Fee: 4500}
	ix, e := buildWENMiningFundingInstructionV1(*r.MiningFundingIntent, tx.Message.AccountKeys[0])
	if e != nil {
		f.t.Fatal(e)
	}
	for _, k := range tx.Message.AccountKeys {
		var pre uint64
		for i, key := range f.keys {
			if key == k {
				pre = f.page.Value[i].Lamports
			}
		}
		post := pre
		if k == tx.Message.AccountKeys[0] {
			post -= 4500
		}
		if f.outcomeMode != "failed" && f.outcomeMode != "wrong-movement" {
			if k == ix.Accounts()[0].PublicKey {
				post -= 6000
			}
			if k == ix.Accounts()[5].PublicKey {
				post += 6000
			}
		}
		m.PreBalances = append(m.PreBalances, pre)
		m.PostBalances = append(m.PostBalances, post)
	}
	if f.outcomeMode == "failed" {
		m.Err = "fixture failure"
	} else {
		f.page.Value[1].Data.GetBinary()[10] = 1
	}
	if f.outcomeMode == "wrong-paid" {
		f.page.Value[1].Data.GetBinary()[56] ^= 1
	}
	envelope := &rpc.TransactionResultEnvelope{}
	raw, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	if e = json.Unmarshal(raw, envelope); e != nil {
		f.t.Fatal(e)
	}
	f.result = &rpc.GetTransactionResult{Slot: 10, Meta: m, Transaction: envelope}
	if f.outcomeMode == "lost-success" || f.outcomeMode == "unknown" {
		return f.sig, errors.New("lost response")
	}
	return f.sig, nil
}
func (f *fundingExecutorFake) GetTransaction(_ context.Context, s solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if s != f.sig || o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 {
		f.t.Fatal("unbound recovery")
	}
	if f.outcomeMode == "unknown" {
		return nil, nil
	}
	return f.result, nil
}
func (f *fundingExecutorFake) GetMultipleAccountsWithOpts(ctx context.Context, k []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if len(k) == 1 {
		if k[0] != f.keys[1] || o.Commitment != rpc.CommitmentFinalized || o.MinContextSlot == nil || *o.MinContextSlot != 10 {
			f.t.Fatal("unbound paid action")
		}
		return &rpc.GetMultipleAccountsResult{RPCContext: f.page.RPCContext, Value: []*rpc.Account{f.page.Value[1]}}, nil
	}
	return f.fundingReadFake.GetMultipleAccountsWithOpts(ctx, k, o)
}
func TestWENMiningFundingExecutionAndRecovery(t *testing.T) {
	raw, pins := fundingDescriptorFixture(t)
	for _, mode := range []string{"success", "lost-success", "unknown", "failed", "wrong-movement", "wrong-paid"} {
		t.Run(mode, func(t *testing.T) {
			store, keys, v, policy, client := fundingExecutionFixture(t, raw, pins, mode)
			service := &signerServiceV2{store: store, keys: keys}
			digest, outcome, e := service.executeWENMiningFundingWithRPCV1(context.Background(), client, "state-request", "miner", policy.Hash, v)
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
			status, e := store.recoverWENMiningFundingExecutionV1(context.Background(), client, "state-request", digest)
			if (e == nil) != good || good && status != expected || client.sends != 1 {
				t.Fatal("recovery", status, e)
			}
			if good {
				if _, e = store.recoverWENMiningFundingExecutionV1(context.Background(), client, "state-request", digest); e != nil {
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
			if _, e = store.prepareWENMiningFundingSubmissionV1(context.Background(), client, "state-request", digest); e == nil {
				t.Fatal("duplicate submission after restart")
			}

		})
	}
}

func fundingExecutionFixture(t *testing.T, raw []byte, pins wenStakingPinsV1, mode string) (*signerStoreV2, *signerKeyManagerV2, signerWENMiningFundingIntentV1, signerPolicyV2, *fundingExecutorFake) {
	t.Helper()
	store, keys := openTestSignerV2(t)
	v, _, _ := miningFundingFixture(t)
	record, old := createTestSignerWalletV2(t, store, keys, "miner", v.Sale, 100, 100)
	store.now = time.Now
	owner := solana.MustPublicKeyFromBase58(record.PublicKey)
	v, _, _, read := fundingRPCFixture(t, owner)
	v.DescriptorSHA256 = pins.DescriptorSHA256
	v.CapabilitySHA256 = pins.CapabilitySHA256
	pd := read.page.Value[7].Data.GetBinary()
	pd = append(append([]byte{}, pd[:45]...), []byte("funding code")...)
	read.page.Value[7].Data = rpc.DataBytesOrJSONFromBytes(pd)
	policy, e := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: "agent", Operations: []string{intentWENMiningFundingV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "5000", MaxDaily: "10000"}}}, old.Version)
	if e != nil {
		t.Fatal(e)
	}
	for _, scope := range []string{wenMiningNativeScopeV1("miner", v.Genesis), wenMiningFundingLaunchScopeV1("miner", v)} {
		if e = store.configureWENBudgetV1(scope, 10000); e != nil {
			t.Fatal(e)
		}
	}
	root := filepath.Join(filepath.Dir(store.db.Path()), "wen-mining-funding", wenHashV1([]byte("miner")))
	if e = os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	review := wenMiningFundingReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: owner.String(), Intent: v, Pins: pins, MaxSlotLag: 2, MaxTotalCostLamports: 5000}
	data, _ := json.Marshal(review)
	if e = os.WriteFile(filepath.Join(root, wenMiningFundingAdmissionNameV1(v)), data, 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(root, pins.DescriptorSHA256), raw, 0600); e != nil {
		t.Fatal(e)
	}
	client := &fundingExecutorFake{fundingCostFake: &fundingCostFake{fundingReadFake: read}, store: store, outcomeMode: mode}
	return store, keys, v, policy, client
}
