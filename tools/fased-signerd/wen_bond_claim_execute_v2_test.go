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
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

type bondClaimExecutionFakeV2 struct {
	*wenBondRPCFakeV2
	store     *signerStoreV2
	artifact  wenBondClaimReviewArtifactV2
	result    *rpc.GetTransactionResult
	signature solana.Signature
	mode      string
	sends     int
}

func (f *bondClaimExecutionFakeV2) GetTransaction(_ context.Context, sig solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if sig != f.signature || o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MaxSupportedTransactionVersion == nil || *o.MaxSupportedTransactionVersion != 0 {
		f.t.Fatal("unbound recovery")
	}
	if f.result == nil {
		return nil, rpc.ErrNotFound
	}
	return f.result, nil
}
func (f *bondClaimExecutionFakeV2) GetMultipleAccountsWithOpts(ctx context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if len(keys) != 3 {
		return f.wenBondRPCFakeV2.GetMultipleAccountsWithOpts(ctx, keys, o)
	}
	if o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MinContextSlot == nil || keys[0] != f.keys[0] || keys[1] != f.keys[1] || keys[2] != solana.SysVarClockPubkey {
		f.t.Fatal("unbound receipt read")
	}
	slot := *o.MinContextSlot
	f.pageSlot = slot
	clock := append([]byte(nil), f.rows[13].Data.GetBinary()...)
	binary.LittleEndian.PutUint64(clock, slot)
	binary.LittleEndian.PutUint64(clock[32:], f.now)
	return &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: slot}}, Value: []*rpc.Account{f.rows[0], f.rows[1], {Owner: solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), Data: rpc.DataBytesOrJSONFromBytes(clock)}}}, nil
}
func bondClaimReceiptV2(t *testing.T, a wenBondClaimReviewArtifactV2, wire []byte, failed bool) *rpc.GetTransactionResult {
	t.Helper()
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		t.Fatal(e)
	}
	roles, e := buildWENBondClaimV2(a.Pins, a.Binding.Snapshot.Claim)
	if e != nil {
		t.Fatal(e)
	}
	accounts := roles.Accounts()
	m := &rpc.TransactionMeta{Fee: a.Binding.Fee}
	if failed {
		m.Err = "fixture failure"
	}
	c := a.Binding.Snapshot.Claim
	for i, k := range tx.Message.AccountKeys {
		pre, post := uint64(1000000000), uint64(1000000000)
		if i == 0 {
			post -= m.Fee
		}
		m.PreBalances = append(m.PreBalances, pre)
		m.PostBalances = append(m.PostBalances, post)
		owner := a.Pins.Owner
		before, after := uint64(50), uint64(50)
		switch k {
		case accounts[6].PublicKey:
			owner = c.Receipt
			before = c.Gross - c.ClaimedGross
			after = before
			if !failed {
				after -= c.AvailableGross
			}
		case a.Pins.Destination:
			if !failed {
				after += c.AvailableNet
			}
		default:
			continue
		}
		program := solana.Token2022ProgramID
		row := rpc.TokenBalance{AccountIndex: uint16(i), Owner: &owner, Mint: accounts[5].PublicKey, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: strconv.FormatUint(before, 10), Decimals: 11}}
		m.PreTokenBalances = append(m.PreTokenBalances, row)
		row.UiTokenAmount = &rpc.UiTokenAmount{Amount: strconv.FormatUint(after, 10), Decimals: 11}
		m.PostTokenBalances = append(m.PostTokenBalances, row)
	}
	env := &rpc.TransactionResultEnvelope{}
	raw, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	if e = json.Unmarshal(raw, env); e != nil {
		t.Fatal(e)
	}
	return &rpc.GetTransactionResult{Slot: a.Binding.Snapshot.ReferenceSlot + 1, Meta: m, Transaction: env}
}
func (f *bondClaimExecutionFakeV2) SendRawTransactionWithOpts(_ context.Context, wire []byte, o rpc.TransactionOpts) (solana.Signature, error) {
	f.sends++
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil || tx.VerifySignatures() != nil {
		f.t.Fatal("bad signature", e)
	}
	if o.SkipPreflight || o.MaxRetries == nil || *o.MaxRetries != 0 || o.MinContextSlot == nil || o.PreflightCommitment != rpc.CommitmentFinalized {
		f.t.Fatal("unguarded send")
	}
	if e = f.store.db.View(func(tx *bolt.Tx) error {
		var r wenBondClaimReservationV2
		e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("bond-claim-request:"+f.artifact.RequestID)), &r)
		if e == nil && r.State != "submission-uncertain" {
			f.t.Fatal("send before journal")
		}
		return e
	}); e != nil {
		f.t.Fatal(e)
	}
	f.signature = tx.Signatures[0]
	f.result = bondClaimReceiptV2(f.t, f.artifact, wire, f.mode == "failed")
	f.pageSlot = f.result.Slot
	if f.mode != "failed" {
		c := f.artifact.Binding.Snapshot.Claim
		d := append([]byte(nil), f.rows[1].Data.GetBinary()...)
		binary.LittleEndian.PutUint64(d[256:], c.ClaimedGross+c.AvailableGross)
		binary.LittleEndian.PutUint64(d[264:], c.ClaimedNet+c.AvailableNet)
		binary.LittleEndian.PutUint64(d[272:], c.ClaimedFee+c.TransferFee)
		if f.mode == "receipt" {
			d[264] ^= 1
		}
		f.rows[1].Data = rpc.DataBytesOrJSONFromBytes(d)
	}
	if f.mode == "effects" {
		f.result.Meta.PostTokenBalances[0].UiTokenAmount.Amount = "0"
	}
	if f.mode == "missing" {
		f.result = nil
	}
	if f.mode == "lost" || f.mode == "missing" {
		return f.signature, errors.New("lost response")
	}
	return f.signature, nil
}
func TestWENBondClaimV2JoinedOwnerExecution(t *testing.T) {
	for _, mode := range []string{"ok", "lost", "missing", "failed", "receipt", "effects", "no-approval", "no-admission", "no-budget", "configured"} {
		t.Run(mode, func(t *testing.T) {
			store, keys := openTestSignerV2(t)
			record, old := createTestSignerWalletV2(t, store, keys, "miner", solana.PublicKey{1}.String(), 10000, 20000)
			store.now = time.Now
			f, p, policy := bondReadFixtureV2(t, solana.MustPublicKeyFromBase58(record.PublicKey))
			prepared, e := prepareWENBondClaimV2(context.Background(), f, p, policy, 10000, 1000, nil)
			if e != nil {
				t.Fatal(e)
			}
			a, e := newWENBondClaimReviewV2("review-request-001", "miner", old.Hash, prepared)
			if e != nil {
				t.Fatal(e)
			}
			native := strconv.FormatUint(a.nativeDebit(), 10)
			updated, e := store.putPolicy(signerPolicyV2{WalletID: a.WalletID, Role: old.Role, Operations: []string{wenBondClaimOperationV2}, Programs: a.requiredPrograms(), Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{p.Destination.String()}, MaxPerTx: native, MaxDaily: native}}}, old.Version)
			if e != nil {
				t.Fatal(e)
			}
			a.PolicyHash = updated.Hash
			cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
			endpoint := "https://bond-claim-test.invalid"
			keys.genesisHash = func(string) (string, error) { return policy.Deployment.Genesis, nil }
			if _, e = keys.PutNetworkV2(a.WalletID, signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
				t.Fatal(e)
			}
			client := &bondClaimExecutionFakeV2{wenBondRPCFakeV2: f, store: store, artifact: a, mode: mode}
			runtime := &signerServiceV2{store: store, keys: keys}
			factory := func(url string) wenBondClaimExecutionRPCV2 {
				if url != endpoint {
					t.Fatal("caller selected RPC")
				}
				return client
			}
			var review signerReviewV2
			if mode == "configured" {
				d := wenBondClaimDraftV2{Version: 2, WalletID: a.WalletID, WalletPublicKey: a.WalletPublicKey, Pins: p, Policy: policy, MaxFee: a.MaxFee, RetainedLamports: a.RetainedLamports}
				raw, _ := json.Marshal(d)
				h := wenHashV1(raw)
				if _, e = runtime.installWENBondClaimDraftV2(context.Background(), cfg, a.WalletID, d, h, false, factory); e == nil {
					t.Fatal("caller installed draft")
				}
				if _, e = runtime.installWENBondClaimDraftV2(context.Background(), cfg, a.WalletID, d, h, true, factory); e != nil {
					t.Fatal(e)
				}
				if _, e = runtime.installWENBondClaimDraftV2(context.Background(), cfg, a.WalletID, d, wenHashV1([]byte("wrong")), true, factory); e == nil {
					t.Fatal("wrong draft hash")
				}
				review, e = runtime.prepareConfiguredWENBondClaimReviewV2(context.Background(), cfg, a.WalletID, wenBondClaimReviewRequestV2{RequestID: a.RequestID, DraftSHA256: h}, factory)
				if e == nil {
					e = json.Unmarshal(review.SemanticIntent, &a)
				}
				client.artifact = a
			} else {
				review, e = store.storeWENBondClaimReviewV2(a)
			}
			if e != nil {
				t.Fatal(e)
			}
			if _, e = store.storeWENBondClaimReviewV2(a); e == nil {
				t.Fatal("review overwritten")
			}
			for _, change := range []func(*signerReviewV2){func(r *signerReviewV2) { r.Amount = "0" }, func(r *signerReviewV2) { r.StateSlot++ }, func(r *signerReviewV2) { r.TransactionDigest = "wrong" }} {
				r := review
				change(&r)
				if _, e = reviewBindingFromStoredReviewV2(r, updated); e == nil {
					t.Fatal("tampered review bound")
				}
			}
			digest, e := a.digest()
			if e != nil {
				t.Fatal(e)
			}
			for scope, n := range wenBondClaimReservationScopesV2(a) {
				if mode == "no-budget" && scope == wenBondClaimLaunchScopeV2(a) {
					continue
				}
				if e = store.configureWENBudgetV1(scope, n); e != nil {
					t.Fatal(e)
				}
			}
			root := filepath.Join(filepath.Dir(store.db.Path()), "wen-campaign", wenHashV1([]byte(a.WalletID)))
			if e = os.MkdirAll(root, 0700); e != nil {
				t.Fatal(e)
			}
			if mode == "configured" {
				if e = runtime.installWENBondClaimAdmissionV2(context.Background(), cfg, a.WalletID, a.RequestID, digest, false, factory); e == nil {
					t.Fatal("caller installed admission")
				}
				if e = runtime.installWENBondClaimAdmissionV2(context.Background(), cfg, a.WalletID, a.RequestID, digest, true, factory); e != nil {
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
			got, state, e := runtime.executeWENBondClaimV2(context.Background(), client, auth, a.WalletID, a.RequestID, proof)
			if mode == "no-approval" || mode == "no-admission" || mode == "no-budget" {
				if e == nil || client.sends != 0 {
					t.Fatal("unapproved send", state, e)
				}
				if mode == "no-budget" {
					if e = store.db.View(func(tx *bolt.Tx) error {
						if tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2(a.WalletID, "solana:native", currentDayBucket(store.now()))) != nil {
							t.Fatal("failed reservation charged usage")
						}
						return nil
					}); e != nil {
						t.Fatal(e)
					}
				}
				return
			}
			if wenBondClaimLaunchScopeV2(a) != wenBondPurchaseLaunchScopeV2(wenBondPurchaseReviewArtifactV2{WalletID: a.WalletID, Policy: wenBondPurchaseReadPolicyV2{Deployment: a.Policy.Deployment}, Pins: wenBondPurchasePinsV2{Bond: a.Pins}}) {
				t.Fatal("shared launch scope diverged")
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
			if mode == "receipt" || mode == "effects" {
				if e == nil {
					t.Fatal("tampered outcome accepted")
				}
			} else if state != want || mode != "missing" && e != nil {
				t.Fatal("outcome", state, e)
			}
			if mode == "configured" {
				body, _ := json.Marshal(wenMiningClaimJourneyRequestV1{RequestID: a.RequestID, Action: "recover"})
				if _, e = runtime.bondClaimApplicationWithFactoryV2(context.Background(), request{Op: "v2.wenBondClaim.journey", WalletID: a.WalletID, Request: body}, cfg, factory); e != nil {
					t.Fatal("configured recovery", e)
				}
				bad := json.RawMessage(`{"requestId":"review-request-001","action":"recover","rpc":"https://evil.invalid"}`)
				if _, e = runtime.bondClaimApplicationWithFactoryV2(context.Background(), request{Op: "v2.wenBondClaim.journey", WalletID: a.WalletID, Request: bad}, cfg, factory); e == nil {
					t.Fatal("caller RPC accepted")
				}
			}
			if mode == "missing" || mode == "receipt" || mode == "effects" {
				if e = store.releaseWENBondClaimReviewV2(a.WalletID, a.RequestID, digest, "cancelled"); e == nil {
					t.Fatal("uncertain released")
				}
			}

			if mode == "configured" {
				c := a.Binding.Snapshot.Claim
				d := append([]byte(nil), client.rows[1].Data.GetBinary()...)
				binary.LittleEndian.PutUint64(d[256:], c.Gross)
				binary.LittleEndian.PutUint64(d[264:], c.Gross*97/100)
				binary.LittleEndian.PutUint64(d[272:], c.Gross*3/100)
				client.rows[1].Data = rpc.DataBytesOrJSONFromBytes(d)
			}

			path := store.db.Path()
			if e = store.Close(); e != nil {
				t.Fatal(e)
			}
			reopened, e := openSignerStoreV2(path)
			if e != nil {
				t.Fatal(e)
			}
			defer reopened.Close()
			runtime.store = reopened
			auth.store = reopened
			reopened.now = func() time.Time { return time.Now().Add(10 * time.Minute) }
			_, again, err := runtime.executeWENBondClaimV2(context.Background(), client, auth, a.WalletID, a.RequestID, nil)
			if client.sends != 1 {
				t.Fatal("restart resent")
			}
			if mode != "receipt" && mode != "effects" && (again != want || err != nil) {
				t.Fatal("restart outcome", again, err)
			}
			if e = reopened.db.View(func(tx *bolt.Tx) error {
				var saved wenBondClaimReservationV2
				if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("bond-claim-request:"+a.RequestID)), &saved); e != nil {
					return e
				}
				expected := a.MaxFee
				if mode == "ok" || mode == "lost" || mode == "failed" || mode == "configured" {
					expected = a.Binding.Fee
				}
				for scope := range wenBondClaimReservationScopesV2(a) {
					var b wenBudgetBalanceV1
					if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &b); e != nil {
						return e
					}
					if b.Reserved != expected {
						t.Fatal("hold changed", b.Reserved, expected)
					}
				}
				if saved.Authorization == nil || saved.Signature == "" {
					t.Fatal("attempt lost")
				}
				return nil
			}); e != nil {
				t.Fatal(e)
			}
		})
	}
}
