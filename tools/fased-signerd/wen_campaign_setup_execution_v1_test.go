package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

type campaignSetupExecutionFake struct {
	*campaignSetupRPCFake
	store    *signerStoreV2
	artifact wenCampaignReviewArtifactV1
	result   *rpc.GetTransactionResult
	sends    int
	outcome  string
}

func (f *campaignSetupExecutionFake) SendRawTransactionWithOpts(_ context.Context, wire []byte, o rpc.TransactionOpts) (solana.Signature, error) {
	f.sends++
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		f.t.Fatal(e)
	}
	if e = tx.VerifySignatures(); e != nil {
		f.t.Fatal(e)
	}
	if o.SkipPreflight || o.MaxRetries == nil || *o.MaxRetries != 0 || o.MinContextSlot == nil || o.PreflightCommitment != rpc.CommitmentFinalized {
		f.t.Fatal("unguarded setup send")
	}
	e = f.store.db.View(func(tx *bolt.Tx) error {
		var r wenCampaignReservationV1
		if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("campaign-request:"+f.artifact.RequestID)), &r); e != nil {
			return e
		}
		if r.State != "submission-uncertain" {
			f.t.Fatal("setup not journaled before send")
		}
		return nil
	})
	if e != nil {
		f.t.Fatal(e)
	}
	m := &rpc.TransactionMeta{Fee: 5000}
	if f.outcome == "failed" {
		m.Err = "fixture failure"
	}
	s := f.artifact.Binding.Setup
	_, allocations, e := buildWENCampaignAtomicSetupV1(s.Setup)
	if e != nil {
		f.t.Fatal(e)
	}
	for _, k := range tx.Message.AccountKeys {
		pre, post := uint64(1000000), uint64(1000000)
		if k == s.Setup.Owner {
			post -= 5000
			if m.Err == nil {
				post -= s.Rent + s.Setup.Terms.Deposit
			}
		}
		for i, a := range allocations {
			if k == a.Address {
				pre = 0
				post = 0
				if m.Err == nil {
					post = s.RentByAllocation[i]
					if i == 0 {
						post += s.Setup.Terms.Deposit
					}
				}
			}
		}
		m.PreBalances = append(m.PreBalances, pre)
		m.PostBalances = append(m.PostBalances, post)
	}
	envelope := &rpc.TransactionResultEnvelope{}
	raw, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	if e = json.Unmarshal(raw, envelope); e != nil {
		f.t.Fatal(e)
	}
	if f.outcome != "missing" {
		f.result = &rpc.GetTransactionResult{Slot: 130, Meta: m, Transaction: envelope}
	}
	if f.outcome == "lost" || f.outcome == "missing" {
		return tx.Signatures[0], errors.New("lost setup reply")
	}
	return tx.Signatures[0], nil
}
func (f *campaignSetupExecutionFake) GetTransaction(_ context.Context, _ solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if o.Commitment != rpc.CommitmentFinalized {
		f.t.Fatal("unfinalized recovery")
	}
	if f.result == nil {
		return nil, rpc.ErrNotFound
	}
	return f.result, nil
}

func TestWENCampaignSetupExecutionV1(t *testing.T) {
	for _, mode := range []string{"ok", "lost", "missing", "failed", "no-admission", "no-proof"} {
		t.Run(mode, func(t *testing.T) {
			store, keys := openTestSignerV2(t)
			store.now = time.Now
			client, pins, q, _ := campaignSetupRPCFixture(t, "ok")
			record, old := createTestSignerWalletV2(t, store, keys, "miner", q.Economy.String(), 20000, 40000)
			owner := solana.MustPublicKeyFromBase58(record.PublicKey)
			policy, e := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: old.Role, Operations: []string{"wen.campaign.setup.v1"}, Programs: []string{q.Program.String()}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{q.Economy.String()}, MaxPerTx: "20000", MaxDaily: "40000"}}}, old.Version)
			if e != nil {
				t.Fatal(e)
			}
			mint, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), q.Economy[:]}, q.Program)
			position, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-retail-position-v2"), owner[:], mint[:]}, q.Program)
			action := wenCampaignOwnerActionV1{Operation: "setup", Program: q.Program, Economy: q.Economy, Position: position, Amount: q.Terms.Deposit, Setup: &q}
			p, e := prepareWENCampaignOwnerV1(context.Background(), client, pins, action, owner, 100, 132, 32, 5000, nil)
			if e != nil {
				t.Fatal(e)
			}
			a, e := newWENCampaignReviewV1("review-request-setup", "miner", policy.Hash, pins, action, owner, p, 132, 5000)
			if e != nil {
				t.Fatal(e)
			}
			review, e := store.storeWENCampaignReviewV1(a)
			if e != nil {
				t.Fatal(e)
			}
			if dir := os.Getenv("WEN_SETUP_REVIEW_FIXTURE_DIR"); dir != "" && mode == "ok" {
				raw, _ := json.MarshalIndent(review, "", "  ")
				if e = os.WriteFile(filepath.Join(dir, "setup.json"), raw, 0600); e != nil {
					t.Fatal(e)
				}
			}
			digest, e := a.digest()
			if e != nil {
				t.Fatal(e)
			}
			debit, e := a.debit()
			if e != nil || debit != 9360 {
				t.Fatal("setup debit", debit, e)
			}
			for _, scope := range []string{wenMiningNativeScopeV1("miner", pins.Genesis), wenCampaignLaunchScopeV1(a)} {
				if e = store.configureWENBudgetV1(scope, debit); e != nil {
					t.Fatal(e)
				}
			}
			if mode != "no-admission" {
				root := filepath.Join(filepath.Dir(store.db.Path()), "wen-campaign", wenHashV1([]byte("miner")))
				if e = os.MkdirAll(root, 0700); e != nil {
					t.Fatal(e)
				}
				raw, _ := json.Marshal(wenCampaignAdmissionV1{Version: 1, WalletID: "miner", ArtifactDigest: digest})
				if e = os.WriteFile(filepath.Join(root, digest+".json"), raw, 0600); e != nil {
					t.Fatal(e)
				}
			}
			auth, e := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
			if e != nil {
				t.Fatal(e)
			}
			authenticator := newTestWebAuthnAuthenticatorV2(t)
			fixture := &testSignerWebAuthnFixtureV2{store: store, service: auth, walletID: "miner"}
			fixture.enroll(t, authenticator)
			service := &signerServiceV2{store: store, keys: keys, webauthn: auth}
			beginRaw, _ := json.Marshal(signerReviewAuthorizationBeginRequestV2{RequestID: a.RequestID})
			wire, e := service.handle(request{Op: "v2.review.authorization.begin", WalletID: "miner", Request: beginRaw}, signerConfig{}, false)
			if e != nil {
				t.Fatal(e)
			}
			var begin struct {
				Result signerReviewAuthorizationBeginResultV2 `json:"result"`
			}
			if e = json.Unmarshal(wire, &begin); e != nil {
				t.Fatal(e)
			}
			assertion := authenticator.assertionResponse(t, begin.Result.Options, testWebAuthnOrigin, testWebAuthnRPID, "", 0x05, 2)
			finishRaw, _ := json.Marshal(signerReviewAuthorizationFinishRequestV2{ChallengeID: begin.Result.ChallengeID, Credential: assertion})
			wire, e = service.handle(request{Op: "v2.review.authorization.finish", WalletID: "miner", Request: finishRaw}, signerConfig{}, false)
			if e != nil {
				t.Fatal(e)
			}
			var finish struct {
				Result signerReviewAuthorizationFinishResultV2 `json:"result"`
			}
			if e = json.Unmarshal(wire, &finish); e != nil {
				t.Fatal(e)
			}
			proof := &finish.Result.Authorization.Proof
			if mode == "no-proof" {
				proof = nil
			}
			c := &campaignSetupExecutionFake{campaignSetupRPCFake: client, store: store, artifact: a, outcome: mode}
			keys.genesisHash = func(string) (string, error) { return pins.Genesis, nil }
			endpoint := "https://campaign-setup.invalid"
			if _, e = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
				t.Fatal(e)
			}
			payload, _ := json.Marshal(wenMiningClaimJourneyRequestV1{RequestID: a.RequestID, Action: "execute", Proof: proof})
			result, e := service.campaignApplicationWithFactoryV1(context.Background(), request{Op: "v2.wenCampaign.journey", WalletID: "miner", Request: payload}, signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}, func(url string) wenCampaignExecutionRPCV1 {
				if url != endpoint {
					t.Fatal("unbound setup endpoint")
				}
				return c
			})
			var summary struct {
				Result wenMiningClaimJourneyResultV1 `json:"result"`
			}
			if e == nil {
				if e = json.Unmarshal(result, &summary); e != nil {
					t.Fatal(e)
				}
			}
			state := summary.Result.Outcome
			if mode == "no-admission" || mode == "no-proof" {
				if e == nil || c.sends != 0 {
					t.Fatal("unapproved setup sent")
				}
				return
			}
			if mode == "missing" {
				if state != "submission-uncertain" || c.sends != 1 {
					t.Fatal(state, e)
				}
			} else {
				want := "finalized-success"
				if mode == "failed" {
					want = "finalized-failed"
				}
				if e != nil || state != want || c.sends != 1 {
					t.Fatal("setup execution", state, e, c.sends)
				}
			}
			_, again, _ := service.executeWENCampaignV1(context.Background(), c, auth, "miner", a.RequestID, proof)
			if c.sends != 1 || again != state {
				t.Fatal("setup replay sent twice")
			}
			if c.result != nil && mode != "failed" {
				var saved wenCampaignReservationV1
				e = store.db.View(func(tx *bolt.Tx) error {
					return json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("campaign-request:"+a.RequestID)), &saved)
				})
				if e != nil {
					t.Fatal(e)
				}
				c.result.Meta.PostBalances[1]++
				if _, _, e = wenCampaignOutcomeV1(saved, c.result); e == nil {
					t.Fatal("wrong setup effects accepted")
				}
			}
		})
	}
}

func TestWENCampaignSetupConfiguredReviewV1(t *testing.T) {
	store, keys := openTestSignerV2(t)
	store.now = time.Now
	_, pins, q, _ := campaignSetupRPCFixture(t, "ok")
	record, old := createTestSignerWalletV2(t, store, keys, "miner", q.Economy.String(), 20000, 40000)
	owner := solana.MustPublicKeyFromBase58(record.PublicKey)
	_, err := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: old.Role, Operations: []string{"wen.campaign.setup.v1"}, Programs: []string{q.Program.String()}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{q.Economy.String()}, MaxPerTx: "20000", MaxDaily: "40000"}}}, old.Version)
	if err != nil {
		t.Fatal(err)
	}
	keys.genesisHash = func(string) (string, error) { return pins.Genesis, nil }
	endpoint := "https://campaign-setup.invalid"
	if _, err = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); err != nil {
		t.Fatal(err)
	}
	mint, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), q.Economy[:]}, q.Program)
	position, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-retail-position-v2"), owner[:], mint[:]}, q.Program)
	draft := wenCampaignDraftV1{Version: 1, WalletID: "miner", WalletPublicKey: record.PublicKey, Pins: pins, Action: wenCampaignOwnerActionV1{Operation: "setup", Program: q.Program, Economy: q.Economy, Position: position, Amount: q.Terms.Deposit, Setup: &q}, MinimumSlot: 100, ExpiresSlot: 132, MaxFee: 5000}
	raw, _ := json.Marshal(draft)
	digest := wenHashV1(raw)
	service := &signerServiceV2{store: store, keys: keys}
	cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
	start := uint64(100)
	factory := func(url string) wenCampaignExecutionRPCV1 {
		if url != endpoint {
			t.Fatal("unbound review endpoint")
		}
		c, _, _, _ := campaignSetupRPCFixture(t, "ok")
		c.next = start
		return &campaignSetupExecutionFake{campaignSetupRPCFake: c, store: store}
	}
	if _, err = service.installWENCampaignDraftV1(context.Background(), cfg, "miner", draft, digest, false, factory); err == nil {
		t.Fatal("application installed setup draft")
	}
	if _, err = service.installWENCampaignDraftV1(context.Background(), cfg, "miner", draft, digest, true, factory); err != nil {
		t.Fatal(err)
	}
	requestBody, _ := json.Marshal(wenCampaignReviewRequestV1{RequestID: "configured-setup-review", DraftSHA256: digest})
	response, err := service.campaignApplicationWithFactoryV1(context.Background(), request{Op: "v2.wenCampaign.review.prepare", WalletID: "miner", Request: requestBody}, cfg, factory)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Result signerReviewV2 `json:"result"`
	}
	if err = json.Unmarshal(response, &result); err != nil {
		t.Fatal(err)
	}
	var a wenCampaignReviewArtifactV1
	if err = json.Unmarshal(result.Result.SemanticIntent, &a); err != nil {
		t.Fatal(err)
	}
	if a.Action.Operation != "setup" || result.Result.Amount != "9360" {
		t.Fatal("wrong setup review")
	}
	admission, err := a.digest()
	if err != nil {
		t.Fatal(err)
	}
	start = a.Binding.Position.ReferenceSlot
	if err = service.installWENCampaignAdmissionV1(context.Background(), cfg, "miner", a.RequestID, admission, false, factory); err == nil {
		t.Fatal("application installed admission")
	}
	if err = service.installWENCampaignAdmissionV1(context.Background(), cfg, "miner", a.RequestID, admission, true, factory); err != nil {
		t.Fatal(err)
	}
	if err = loadWENCampaignAdmissionV1(store.db.Path(), a); err != nil {
		t.Fatal(err)
	}
}
