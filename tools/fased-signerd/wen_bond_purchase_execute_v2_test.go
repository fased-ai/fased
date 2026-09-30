package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

type bondExecutionFakeV2 struct {
	*bondRecoveryFakeV2
	store    *signerStoreV2
	artifact wenBondPurchaseReviewArtifactV2
	mode     string
	sends    int
}

func (f *bondExecutionFakeV2) SendRawTransactionWithOpts(_ context.Context, wire []byte, o rpc.TransactionOpts) (solana.Signature, error) {
	f.sends++
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		f.t.Fatal(e)
	}
	if e = tx.VerifySignatures(); e != nil {
		f.t.Fatal(e)
	}
	if o.SkipPreflight || o.MaxRetries == nil || *o.MaxRetries != 0 || o.MinContextSlot == nil || o.PreflightCommitment != rpc.CommitmentFinalized {
		f.t.Fatal("unguarded send")
	}
	if e = f.store.db.View(func(tx *bolt.Tx) error {
		var r wenBondPurchaseReservationV2
		e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("bond-purchase-request:"+f.artifact.RequestID)), &r)
		if e != nil {
			return e
		}
		if r.State != "submission-uncertain" {
			f.t.Fatal("send before journal")
		}
		return nil
	}); e != nil {
		f.t.Fatal(e)
	}
	f.signature = tx.Signatures[0]
	f.result = bondPurchaseReceiptV2(f.t, f.artifact, wire, f.mode == "failed")
	f.pageSlot = f.result.Slot
	_, _, r, _, _ := bondClaimFixtureV2(f.t, f.artifact.Pins.Bond)
	if f.artifact.Binding.Snapshot.Quote.Data[10] == 2 {
		digest := sha256.Sum256(f.artifact.Binding.Snapshot.Quote.Data)
		copy(r.Data[144:176], digest[:])
	}
	f.records[r.Key] = &rpc.Account{Owner: r.Owner, Data: rpc.DataBytesOrJSONFromBytes(r.Data)}
	if f.mode == "missing" {
		f.result = nil
	}
	if f.mode == "lost" || f.mode == "missing" {
		return f.signature, errors.New("lost response")
	}
	return f.signature, nil
}
func TestWENBondPurchaseV2JoinedOwnerExecution(t *testing.T) {
	for _, mode := range []string{"ok", "lost", "missing", "failed", "no-approval", "no-admission", "configured", "q2-ok", "q2-lost"} {
		t.Run(mode, func(t *testing.T) {
			store, keys := openTestSignerV2(t)
			record, old := createTestSignerWalletV2(t, store, keys, "miner", solana.PublicKey{1}.String(), 10000, 20000)
			store.now = time.Now
			owner := solana.MustPublicKeyFromBase58(record.PublicKey)
			var f *wenBondPurchaseRPCFakeV2
			var p wenBondPurchasePinsV2
			var policy wenBondPurchaseReadPolicyV2
			var limits wenBondPurchaseCostLimitsV2
			if mode == "q2-ok" || mode == "q2-lost" {
				f, p, policy, limits, _ = bondPurchaseQ2ReadFixtureV2(t, owner)
			} else {
				f, p, policy, limits = bondPurchaseReadFixtureV2(t, owner)
			}
			prepared, e := prepareWENBondPurchaseCostsV2(context.Background(), f, p, policy, limits, nil)
			if e != nil {
				t.Fatal(e)
			}
			a, e := newWENBondPurchaseReviewV2("review-request-001", "miner", old.Hash, prepared)
			if e != nil {
				t.Fatal(e)
			}
			native, cash := strconv.FormatUint(a.nativeDebit(), 10), strconv.FormatUint(a.cashAmount(), 10)
			updated, e := store.putPolicy(signerPolicyV2{WalletID: a.WalletID, Role: old.Role, Operations: []string{wenBondPurchaseOperationV2}, Programs: a.requiredPrograms(), Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{p.Bond.Sale.String()}, MaxPerTx: native, MaxDaily: native}, {Asset: a.cashAsset(), Destinations: []string{p.Bond.Sale.String()}, MaxPerTx: cash, MaxDaily: cash}}}, old.Version)
			if e != nil {
				t.Fatal(e)
			}
			a.PolicyHash = updated.Hash
			cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
			endpoint := "https://bond-test.invalid"
			keys.genesisHash = func(string) (string, error) { return policy.Deployment.Genesis, nil }
			if _, e = keys.PutNetworkV2(a.WalletID, signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
				t.Fatal(e)
			}
			client := &bondExecutionFakeV2{bondRecoveryFakeV2: &bondRecoveryFakeV2{wenBondPurchaseRPCFakeV2: f}, store: store, artifact: a, mode: mode}
			if mode == "q2-lost" {
				client.mode = "lost"
			}
			factory := func(url string) wenBondPurchaseExecutionRPCV2 {
				if url != endpoint {
					t.Fatal("application selected RPC")
				}
				return client
			}
			runtime := &signerServiceV2{store: store, keys: keys}
			if mode == "configured" {
				draft := wenBondPurchaseDraftV2{Version: 2, WalletID: a.WalletID, WalletPublicKey: a.WalletPublicKey, Pins: p, Policy: policy, Limits: limits}
				raw, _ := json.Marshal(draft)
				hash := wenHashV1(raw)
				if _, e = runtime.installWENBondPurchaseDraftV2(context.Background(), cfg, a.WalletID, draft, hash, false, factory); e == nil {
					t.Fatal("application installed draft")
				}
				if _, e = runtime.installWENBondPurchaseDraftV2(context.Background(), cfg, a.WalletID, draft, hash, true, factory); e != nil {
					t.Fatal(e)
				}
				review, e := runtime.prepareConfiguredWENBondPurchaseReviewV2(context.Background(), cfg, a.WalletID, wenBondPurchaseReviewRequestV2{RequestID: a.RequestID, DraftSHA256: hash}, factory)
				if e != nil {
					t.Fatal(e)
				}
				if e = json.Unmarshal(review.SemanticIntent, &a); e != nil {
					t.Fatal(e)
				}
				client.artifact = a
			} else {
				if _, e = store.storeWENBondPurchaseReviewV2(a); e != nil {
					t.Fatal(e)
				}
			}

			digest, e := a.digest()
			if e != nil {
				t.Fatal(e)
			}
			for scope, n := range wenBondPurchaseReservationScopesV2(a) {
				if e = store.configureWENBudgetV1(scope, n); e != nil {
					t.Fatal(e)
				}
			}
			root := filepath.Join(filepath.Dir(store.db.Path()), "wen-campaign", wenHashV1([]byte(a.WalletID)))
			if e = os.MkdirAll(root, 0700); e != nil {
				t.Fatal(e)
			}
			if mode == "configured" {
				if e = runtime.installWENBondPurchaseAdmissionV2(context.Background(), cfg, a.WalletID, a.RequestID, digest, false, factory); e == nil {
					t.Fatal("application installed admission")
				}
				if e = runtime.installWENBondPurchaseAdmissionV2(context.Background(), cfg, a.WalletID, a.RequestID, digest, true, factory); e != nil {
					t.Fatal(e)
				}
			} else if mode != "no-admission" {
				raw, _ := json.Marshal(wenCampaignAdmissionV1{Version: 1, WalletID: a.WalletID, ArtifactDigest: digest})
				if e = os.WriteFile(filepath.Join(root, digest+".json"), raw, 0600); e != nil {
					t.Fatal(e)
				}
			}

			auth, e := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
			if e != nil {
				t.Fatal(e)
			}
			device := newTestWebAuthnAuthenticatorV2(t)
			fixture := &testSignerWebAuthnFixtureV2{store: store, service: auth, walletID: a.WalletID}
			fixture.enroll(t, device)
			finish, e := fixture.finishReview(t, fixture.beginReview(t), device, 2)
			if e != nil {
				t.Fatal(e)
			}
			proof := &finish.Authorization.Proof
			if mode == "no-approval" {
				proof = nil
			}
			runtime.webauthn = auth
			got, state, e := runtime.executeWENBondPurchaseV2(context.Background(), client, auth, a.WalletID, a.RequestID, proof)
			if mode == "no-approval" || mode == "no-admission" {
				if e == nil || client.sends != 0 {
					t.Fatal("unapproved send", state, e)
				}
				return
			}
			if got != digest || client.sends != 1 {
				t.Fatal("wrong attempt", state, e)
			}
			want := "finalized-success"
			if mode == "failed" {
				want = "finalized-failed"
			}
			if mode == "missing" {
				want = "submission-uncertain"
			}
			if state != want || mode != "missing" && e != nil {
				t.Fatal("outcome", state, e)
			}
			if e = store.db.View(func(tx *bolt.Tx) error {
				var saved wenBondPurchaseReservationV2
				if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("bond-purchase-request:"+a.RequestID)), &saved); e != nil {
					return e
				}
				expectedNative, expectedCash := a.nativeDebit(), a.cashAmount()
				if mode != "missing" {
					expectedNative = a.Binding.Fee
					if mode != "failed" {
						expectedNative += a.Limits.RecoveryBudget
					} else {
						expectedCash = 0
					}
				}
				for scope := range wenBondPurchaseReservationScopesV2(a) {
					var balance wenBudgetBalanceV1
					if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &balance); e != nil {
						return e
					}
					expected := expectedNative
					if scope == wenBondPurchaseCashScopeV2(a) {
						expected = expectedCash
					}
					if balance.Reserved != expected {
						t.Fatal("wrong reconciled scope", scope, balance.Reserved, expected)
					}
				}
				return nil
			}); e != nil {
				t.Fatal(e)
			}
			if mode == "configured" {
				body, _ := json.Marshal(wenMiningClaimJourneyRequestV1{RequestID: a.RequestID, Action: "recover"})
				if _, e = runtime.bondPurchaseApplicationWithFactoryV2(context.Background(), request{Op: "v2.wenBondPurchase.journey", WalletID: a.WalletID, Request: body}, cfg, factory); e != nil {
					t.Fatal("configured recovery", e)
				}
			}
			for i := 0; i < 2; i++ {
				_, state, e = runtime.executeWENBondPurchaseV2(context.Background(), client, auth, a.WalletID, a.RequestID, nil)
				if e != nil || state != want || client.sends != 1 {
					t.Fatal("recovery re-executed", state, e)
				}
			}
		})
	}
}
