package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/binary"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type directStakeExecutionFake struct {
	*directStakePrepareFake
	result    *rpc.GetTransactionResult
	artifact  wenCampaignClaimStakeReviewV1
	after     map[solana.PublicKey]*rpc.Account
	mode      string
	sends     int
	available bool
}

func (f *directStakeExecutionFake) GetMultipleAccountsWithOpts(ctx context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if f.sends == 0 {
		if f.reads%2 == 0 {
			f.next = 159
		}
		return f.directStakePrepareFake.GetMultipleAccountsWithOpts(ctx, keys, o)
	}
	if o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MinContextSlot == nil || *o.MinContextSlot < f.result.Slot {
		f.t.Fatal("unauthenticated recovery read")
	}
	out := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 175}}}
	for _, k := range keys {
		out.Value = append(out.Value, f.after[k])
	}
	if f.mode == "wrong-history" && len(keys) > 1 {
		out.Value[0] = nil
	}
	if f.mode == "unconsumed-claim" && len(keys) == 1 {
		out.Value[0] = &rpc.Account{Owner: f.artifact.Claim.Program, Data: rpc.DataBytesOrJSONFromBytes(f.artifact.Snapshot.Claim.Page.Data)}
	}
	return out, nil
}
func (f *directStakeExecutionFake) GetSlot(ctx context.Context, c rpc.CommitmentType) (uint64, error) {
	if f.sends > 0 {
		if f.mode == "nonfinal" {
			return 169, nil
		}
		return 175, nil
	}
	return f.directStakePrepareFake.GetSlot(ctx, c)
}
func (f *directStakeExecutionFake) GetBlockHeight(ctx context.Context, c rpc.CommitmentType) (uint64, error) {
	if f.mode == "expiry-final" {
		return 201, nil
	}
	return f.directStakePrepareFake.GetBlockHeight(ctx, c)
}
func (f *directStakeExecutionFake) GetTransaction(_ context.Context, sig solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MaxSupportedTransactionVersion == nil {
		f.t.Fatal("unbounded receipt")
	}
	if !f.available {
		return nil, rpc.ErrNotFound
	}
	wire := f.result.Transaction.GetBinary()
	if !bytes.Equal(wire[1:65], sig[:]) {
		f.t.Fatal("wrong journal signature")
	}
	return f.result, nil
}
func (f *directStakeExecutionFake) SendRawTransactionWithOpts(_ context.Context, wire []byte, o rpc.TransactionOpts) (solana.Signature, error) {
	f.sends++
	if f.sends != 1 || !bytes.Equal(wire, f.result.Transaction.GetBinary()) || o.SkipPreflight || o.PreflightCommitment != rpc.CommitmentFinalized || o.MaxRetries == nil || *o.MaxRetries != 0 || o.MinContextSlot == nil {
		f.t.Fatal("wrong or repeated send")
	}
	var sig solana.Signature
	copy(sig[:], wire[1:65])
	if f.mode == "timeout" || f.mode == "route-timeout" {
		return solana.Signature{}, errors.New("lost reply")
	}
	return sig, nil
}

func checkDirectStakeExecution(t *testing.T, base *wenReadRPCFake, artifact wenCampaignClaimStakeReviewV1, key ed25519.PrivateKey, result *rpc.GetTransactionResult) {
	modes := []string{"ok", "timeout", "wrong-history", "unconsumed-claim", "nonfinal", "unauthorized", "wrong-wallet", "revoked-signing", "revoked-signed", "resume-signing", "resume-signed", "changed-message", "missing-admission", "cancelled", "proof-signed", "wallet-signed", "signature-signed", "concurrent-signed", "expiry-signing", "expiry-signed", "route", "route-change", "route-timeout"}
	for _, mode := range modes {
		t.Run("execute-"+mode, func(t *testing.T) {
			store, keys := openTestSignerV2(t)
			record, old := createTestSignerWalletV2(t, store, keys, "miner", artifact.Claim.Economy.String(), 10000, 20000)
			store.now = time.Now
			record.PublicKey = artifact.WalletPublicKey
			if e := keys.encryptRecord(&record, key); e != nil {
				t.Fatal(e)
			}
			if e := store.db.Update(func(tx *bolt.Tx) error {
				raw, e := json.Marshal(record)
				if e != nil {
					return e
				}
				return tx.Bucket(bucketSignerWalletsV2).Put([]byte("miner"), raw)
			}); e != nil {
				t.Fatal(e)
			}
			policy, e := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: old.Role, Operations: []string{wenCampaignClaimStakeOperationV1}, Programs: []string{artifact.Claim.Program.String()}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{artifact.Claim.Economy.String()}, MaxPerTx: "10000", MaxDaily: "20000"}}}, old.Version)
			if e != nil {
				t.Fatal(e)
			}
			a := artifact
			a.PolicyHash = policy.Hash
			if _, e = store.storeWENCampaignClaimStakeReviewV1(a); e != nil {
				t.Fatal(e)
			}
			digest, _ := a.digest()
			for _, scope := range []string{wenMiningNativeScopeV1(a.WalletID, a.Pins.Genesis), wenCampaignClaimStakeLaunchScopeV1(a)} {
				if e = store.configureWENBudgetV1(scope, a.MaximumDebit); e != nil {
					t.Fatal(e)
				}
			}
			root := filepath.Join(filepath.Dir(store.db.Path()), "wen-campaign", wenHashV1([]byte(a.WalletID)))
			if e = os.MkdirAll(root, 0700); e != nil {
				t.Fatal(e)
			}
			raw, _ := json.Marshal(wenCampaignAdmissionV1{Version: 1, WalletID: a.WalletID, ArtifactDigest: digest})
			if mode != "missing-admission" {
				if e = os.WriteFile(filepath.Join(root, digest+".json"), raw, 0600); e != nil {
					t.Fatal(e)
				}
			}
			auth, e := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
			if e != nil {
				t.Fatal(e)
			}
			authenticator := newTestWebAuthnAuthenticatorV2(t)
			fixture := &testSignerWebAuthnFixtureV2{store: store, service: auth, walletID: a.WalletID}
			fixture.enroll(t, authenticator)
			begin, e := auth.beginReviewAuthorization(a.WalletID, signerReviewAuthorizationBeginRequestV2{RequestID: a.RequestID})
			if e != nil {
				t.Fatal(e)
			}
			finish, e := fixture.finishReview(t, begin, authenticator, 2)
			if e != nil {
				t.Fatal(e)
			}
			proof := &finish.Authorization.Proof
			f := &directStakeExecutionFake{directStakePrepareFake: &directStakePrepareFake{campaignPrepareFake: &campaignPrepareFake{campaignReadFake: &campaignReadFake{wenReadRPCFake: base}, next: 159}}, artifact: a, result: result, mode: mode, available: mode != "timeout" && mode != "route-timeout"}
			f.after = directStakePostAccounts(t, base, a)
			service := &signerServiceV2{store: store, keys: keys, webauthn: auth}
			if strings.Contains(mode, "signing") || strings.Contains(mode, "signed") || mode == "changed-message" {
				if _, _, e = store.reserveWENCampaignClaimStakeReviewV1(a); e != nil {
					t.Fatal(e)
				}
				if e = auth.authorizeWENCampaignClaimStakeV1(a.WalletID, a.RequestID, digest, proof); e != nil {
					t.Fatal(e)
				}
				p, e := revalidateWENCampaignClaimStakeReviewV1(context.Background(), f, a, digest, solana.MustPublicKeyFromBase58(a.WalletPublicKey), 32)
				if e != nil {
					t.Fatal(e)
				}
				if mode == "changed-message" {
					p.message = append([]byte(nil), p.message...)
					p.message[0] ^= 1
					if store.beginWENCampaignClaimStakeSigningV1(a.WalletID, a.RequestID, digest, p) == nil {
						t.Fatal("changed message accepted")
					}
					return
				}
				if e = store.beginWENCampaignClaimStakeSigningV1(a.WalletID, a.RequestID, digest, p); e != nil {
					t.Fatal(e)
				}
				if strings.Contains(mode, "signed") {
					var sig solana.Signature
					copy(sig[:], ed25519.Sign(key, a.Message))
					if e = store.recordWENCampaignClaimStakeSignatureV1(a.WalletID, a.RequestID, digest, p, sig.String()); e != nil {
						t.Fatal(e)
					}
				}
				if mode == "concurrent-signed" {
					outcomes := make(chan error, 2)
					for i := 0; i < 2; i++ {
						go func() {
							wire, e := store.commitWENCampaignClaimStakeSubmissionV1(a.WalletID, a.RequestID, digest, p)
							if e == nil && !bytes.Equal(wire, result.Transaction.GetBinary()) {
								e = errors.New("wrong wire")
							}
							outcomes <- e
						}()
					}
					accepted := 0
					for i := 0; i < 2; i++ {
						if <-outcomes == nil {
							accepted++
						}
					}
					if accepted != 1 {
						t.Fatalf("submission gate released wire %d times", accepted)
					}
					return
				}

				if strings.HasPrefix(mode, "expiry-") {
					if store.releaseWENCampaignClaimStakeReviewV1(a.WalletID, a.RequestID, digest, "cancelled") == nil {
						t.Fatal("cancelled after signing")
					}
					store.now = func() time.Time { return time.Now().Add(24 * time.Hour) }
					if store.expireWENCampaignClaimStakeSigningV1(context.Background(), f, a.WalletID, a.RequestID, digest) == nil {
						t.Fatal("live blockhash expired")
					}
					f.mode = "expiry-final"
					if e = store.expireWENCampaignClaimStakeSigningV1(context.Background(), f, a.WalletID, a.RequestID, digest); e != nil {
						t.Fatal("expired signing", e)
					}
					if _, _, e = service.executeWENCampaignClaimStakeV1(context.Background(), f, auth, a.WalletID, a.RequestID, proof); e == nil || f.sends != 0 {
						t.Fatal("expired approval revived", e)
					}
					return
				}

				if strings.HasPrefix(mode, "revoked") {
					if e = store.db.Update(func(tx *bolt.Tx) error { return tx.DeleteBucket(bucketSignerWebAuthnCredentialsV2) }); e != nil {
						t.Fatal(e)
					}
					if e = store.db.Update(func(tx *bolt.Tx) error { _, e := tx.CreateBucket(bucketSignerWebAuthnCredentialsV2); return e }); e != nil {
						t.Fatal(e)
					}
				}
			}
			if mode == "cancelled" {
				if _, _, e = store.reserveWENCampaignClaimStakeReviewV1(a); e != nil {
					t.Fatal(e)
				}
				if e = auth.authorizeWENCampaignClaimStakeV1(a.WalletID, a.RequestID, digest, proof); e != nil {
					t.Fatal(e)
				}
				if e = store.releaseWENCampaignClaimStakeReviewV1(a.WalletID, a.RequestID, digest, "cancelled"); e != nil {
					t.Fatal(e)
				}
			}
			if mode == "proof-signed" || mode == "wallet-signed" || mode == "signature-signed" {
				if e = store.db.Update(func(tx *bolt.Tx) error {
					switch mode {
					case "proof-signed":
						b := tx.Bucket(bucketSignerReviewProofsV2)
						var p signerReviewProofRecordV2
						if e := json.Unmarshal(b.Get([]byte(proof.ProofID)), &p); e != nil {
							return e
						}
						p.ConsumedAt = "changed"
						raw, _ := json.Marshal(p)
						return b.Put([]byte(proof.ProofID), raw)
					case "wallet-signed":
						b := tx.Bucket(bucketSignerWalletsV2)
						var w signerWalletRecordV2
						if e := json.Unmarshal(b.Get([]byte(a.WalletID)), &w); e != nil {
							return e
						}
						w.PublicKey = a.Claim.Program.String()
						raw, _ := json.Marshal(w)
						return b.Put([]byte(a.WalletID), raw)
					default:
						b := tx.Bucket(wenBudgetBucketV1)
						k := []byte("campaign-stake-request:" + a.RequestID)
						var r wenCampaignClaimStakeReservationV1
						if e := json.Unmarshal(b.Get(k), &r); e != nil {
							return e
						}
						sig, _ := solana.SignatureFromBase58(r.Signature)
						sig[0] ^= 1
						r.Signature = sig.String()
						raw, _ := json.Marshal(r)
						return b.Put(k, raw)
					}
				}); e != nil {
					t.Fatal(e)
				}
			}

			wallet := a.WalletID
			if mode == "wrong-wallet" {
				wallet = "other"
			}
			if mode == "unauthorized" {
				proof = nil
			}
			state := ""
			if strings.HasPrefix(mode, "route") {
				keys.genesisHash = func(string) (string, error) { return a.Pins.Genesis, nil }
				endpoint := "https://direct-stake.invalid"
				if _, e = keys.PutNetworkV2(a.WalletID, signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
					t.Fatal(e)
				}
				raw, _ := json.Marshal(wenMiningClaimJourneyRequestV1{Action: "execute", RequestID: a.RequestID, Proof: proof})
				wire, err := service.campaignApplicationWithFactoryV1(context.Background(), request{Op: "v2.wenCampaign.journey", WalletID: a.WalletID, Request: raw}, signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}, func(url string) wenCampaignExecutionRPCV1 {
					if url != endpoint {
						t.Fatal("wrong configured endpoint")
					}
					if mode == "route-change" {
						if _, e := keys.PutNetworkV2(a.WalletID, signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://changed.invalid"}); e != nil {
							t.Fatal(e)
						}
					}
					return f
				})
				e = err
				if err == nil {
					var envelope struct {
						Result wenMiningClaimJourneyResultV1 `json:"result"`
					}
					if err = json.Unmarshal(wire, &envelope); err != nil {
						t.Fatal(err)
					}
					state = envelope.Result.Outcome
					if envelope.Result.Digest != digest || envelope.Result.RecoveryRequired != (mode == "route-timeout") {
						t.Fatal("wrong journey envelope", string(wire))
					}
				}
			} else {
				_, state, e = service.executeWENCampaignClaimStakeV1(context.Background(), f, auth, wallet, a.RequestID, proof)
			}

			blocked := mode == "route-change" || mode == "cancelled" || mode == "proof-signed" || mode == "wallet-signed" || mode == "signature-signed" || mode == "unauthorized" || mode == "wrong-wallet" || strings.HasPrefix(mode, "revoked") || mode == "missing-admission"
			if blocked {
				if e == nil || f.sends != 0 {
					t.Fatal("guard failed", state, e, f.sends)
				}
				return
			}
			want := "finalized-success"
			if result.Meta.Err != nil {
				want = "finalized-failed"
			}
			unresolved := mode == "route-timeout" || mode == "timeout" || mode == "nonfinal" || result.Meta.Err == nil && (mode == "wrong-history" || mode == "unconsumed-claim")
			if unresolved {
				if state != "submission-uncertain" {
					t.Fatal("lost uncertainty", state, e)
				}
			} else if e != nil || state != want {
				t.Fatal("execute", state, e)
			}
			if f.sends != 1 {
				t.Fatal("send count", f.sends)
			}
			if store.releaseWENCampaignClaimStakeReviewV1(a.WalletID, a.RequestID, digest, "cancelled") == nil {
				t.Fatal("released submitted record")
			}
			if store.expireWENCampaignClaimStakeSigningV1(context.Background(), f, a.WalletID, a.RequestID, digest) == nil {
				t.Fatal("expired submitted record")
			}
			path := store.db.Path()
			store.Close()
			reopened, e := openSignerStoreV2(path)
			if e != nil {
				t.Fatal(e)
			}
			defer reopened.Close()
			reopened.now = time.Now
			service.store = reopened
			keys.store = reopened
			auth.store = reopened
			// Review can expire after submission: recovery uses the journal, never proof.
			reopened.now = func() time.Time { return time.Now().Add(24 * time.Hour) }
			f.available = true
			f.mode = "ok"
			_, state, e = service.executeWENCampaignClaimStakeV1(context.Background(), f, auth, a.WalletID, a.RequestID, nil)
			if e != nil || state != want || f.sends != 1 {
				t.Fatal("restart recovery", state, e, f.sends)
			}
			if _, e = reopened.recoverWENCampaignClaimStakeV1(context.Background(), f, a.RequestID, "wrong"); e == nil {
				t.Fatal("wrong digest recovered")
			}
			if e = reopened.db.View(func(tx *bolt.Tx) error {
				var r wenCampaignClaimStakeReservationV1
				if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("campaign-stake-request:"+a.RequestID)), &r); e != nil {
					return e
				}
				if r.OutcomeDigest == "" || r.State != want {
					t.Fatal("missing terminal journal")
				}
				for scope := range r.Scopes {
					var b wenBudgetBalanceV1
					if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &b); e != nil {
						return e
					}
					if b.Reserved != r.OutcomeDebit {
						t.Fatal("wrong budget settlement", b.Reserved, r.OutcomeDebit)
					}
				}
				return nil
			}); e != nil {
				t.Fatal(e)
			}
		})
	}
}

func directStakePostAccounts(t *testing.T, base *wenReadRPCFake, a wenCampaignClaimStakeReviewV1) map[solana.PublicKey]*rpc.Account {
	out := map[solana.PublicKey]*rpc.Account{}
	for i, k := range base.addresses {
		if base.page.Value[i] != nil {
			cp := *base.page.Value[i]
			cp.Data = rpc.DataBytesOrJSONFromBytes(append([]byte(nil), cp.Data.GetBinary()...))
			out[k] = &cp
		}
	}
	_, _, after := stakingHistoryFixture(t, true, a.Claim.Economy, solana.MustPublicKeyFromBase58(a.WalletPublicKey))
	clone := func(x *signerWENBTCAccountV1) *signerWENBTCAccountV1 {
		if x == nil {
			return nil
		}
		c := *x
		c.Data = append([]byte(nil), x.Data...)
		return &c
	}
	put := func(x *signerWENBTCAccountV1, o int, n uint64) { binary.LittleEndian.PutUint64(x.Data[o:], n) }
	h := a.Snapshot.History
	r := a.Snapshot.Result
	if mustStakeUint(a.Intent.Last) != r.EffectiveDay {
		after.History = clone(h.History)
		if after.History != nil {
			put(after.History, 88, r.EffectiveDay)
		}
	}
	if mustStakeUint(a.Intent.AggregateFrom) != r.EffectiveDay {
		after.Point = clone(h.Point)
		put(after.Point, 88, r.EffectiveDay)
	}
	put(after.Position, 80, r.NextPosition)
	put(after.NextHistory, 96, r.NextPosition)
	put(after.Pool, 96, r.NextTotal)
	put(after.Pool, 104, r.NextCustodied)
	put(after.NextPoint, 96, r.NextTotal)
	for _, x := range []*signerWENBTCAccountV1{after.Pool, after.Position, after.History, after.NextHistory, after.Index, after.Point, after.NextPoint} {
		if x != nil {
			out[x.Address] = &rpc.Account{Owner: x.Owner, Data: rpc.DataBytesOrJSONFromBytes(x.Data)}
		}
	}
	clock := out[solana.SysVarClockPubkey].Data.GetBinary()
	binary.LittleEndian.PutUint64(clock, 175)
	out[solana.SysVarClockPubkey].Data = rpc.DataBytesOrJSONFromBytes(clock)
	page := append([]byte(nil), a.Snapshot.Claim.Page.Data...)
	for i := 0; i < 8; i++ {
		if a.Claim.Mask&(1<<i) != 0 {
			clear(page[128+i*56 : 128+(i+1)*56])
		}
	}
	out[a.Snapshot.Claim.Page.Address] = &rpc.Account{Owner: a.Claim.Program, Data: rpc.DataBytesOrJSONFromBytes(page)}
	return out
}
