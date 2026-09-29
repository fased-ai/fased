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
	"strconv"
	"testing"
	"time"
)

type marketExecutionFakeV1 struct {
	*wenMarketPrepareFakeV1
	store     *signerStoreV2
	artifact  wenMarketReviewArtifactV1
	outcome   string
	sends     int
	batches   int
	result    *rpc.GetTransactionResult
	signature solana.Signature
}

func (f *marketExecutionFakeV1) GetMultipleAccountsWithOpts(ctx context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	f.batches++
	if f.outcome == "late-custody" && f.batches == 3 {
		data := append([]byte(nil), f.page.Value[8].Data.GetBinary()...)
		data[64]++
		f.page.Value[8].Data = rpc.DataBytesOrJSONFromBytes(data)
	}
	if o.MinContextSlot != nil && *o.MinContextSlot == 100 {
		f.reads = 0
	} else {
		f.reads = 1
	}
	return f.wenMarketPrepareFakeV1.GetMultipleAccountsWithOpts(ctx, keys, o)
}
func (f *marketExecutionFakeV1) GetSlot(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("commitment")
	}
	if f.sends == 0 {
		return 101, nil
	}
	return 120, nil
}
func (f *marketExecutionFakeV1) GetTransaction(_ context.Context, sig solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MaxSupportedTransactionVersion == nil || *o.MaxSupportedTransactionVersion != 0 || sig != f.signature {
		f.t.Fatal("unbound receipt read")
	}
	if f.result == nil {
		return nil, rpc.ErrNotFound
	}
	return f.result, nil
}
func (f *marketExecutionFakeV1) SendRawTransactionWithOpts(_ context.Context, wire []byte, o rpc.TransactionOpts) (solana.Signature, error) {
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
		var r wenMarketReservationV1
		if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("market-request:"+f.artifact.RequestID)), &r); e != nil {
			return e
		}
		if r.State != "submission-uncertain" {
			f.t.Fatal("send preceded journal")
		}
		return nil
	}); e != nil {
		f.t.Fatal(e)
	}
	f.signature = tx.Signatures[0]
	f.result = marketReceiptFixtureV1(f.t, f.artifact, wire, f.outcome == "failed")
	switch f.outcome {
	case "bad-cash":
		f.result.Meta.PostTokenBalances[0].UiTokenAmount.Amount = "1"
	case "bad-owner":
		x := solana.NewWallet().PublicKey()
		f.result.Meta.PostTokenBalances[0].Owner = &x
	case "bad-fee":
		f.result.Meta.Fee++
	case "stale-receipt":
		f.result.Slot = 99
	}

	if f.outcome == "missing" {
		f.result = nil
	}
	if f.outcome == "lost" || f.outcome == "missing" {
		return f.signature, errors.New("lost response")
	}
	return f.signature, nil
}
func marketReceiptFixtureV1(t *testing.T, a wenMarketReviewArtifactV1, wire []byte, failed bool) *rpc.GetTransactionResult {
	t.Helper()
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		t.Fatal(e)
	}
	m := &rpc.TransactionMeta{Fee: a.Binding.Fee}
	if failed {
		m.Err = "fixture failure"
	}
	ix, e := buildWENMarketBuyV1(a.Pins, a.Binding.Snapshot.Quote, a.Limits)
	if e != nil {
		t.Fatal(e)
	}
	roles := ix.Accounts()
	for i, key := range tx.Message.AccountKeys {
		pre, post := uint64(1000000000), uint64(1000000000)
		if key == a.Pins.Owner {
			post -= m.Fee
		}
		m.PreBalances = append(m.PreBalances, pre)
		m.PostBalances = append(m.PostBalances, post)
		var role int = -1
		for _, n := range []int{4, 5, 6, 7} {
			if key == roles[n].PublicKey {
				role = n
			}
		}
		if role < 0 {
			continue
		}
		owner := roles[1].PublicKey
		if role == 4 || role == 5 {
			owner = a.Pins.Owner
		}
		mint, program, decimals := roles[10].PublicKey, solana.TokenProgramID, uint8(6)
		if role == 5 || role == 7 {
			mint, program, decimals = roles[11].PublicKey, solana.Token2022ProgramID, 11
		}
		pre, post = 1000000000000000, 1000000000000000
		if !failed {
			cash := a.Binding.Snapshot.Quote.InputCash
			net := a.Binding.Snapshot.Quote.QuotedNet
			gross := net / 97 * 100
			for {
				_, n := wenSatTransferV1(gross)
				if n >= net {
					break
				}
				gross++
			}
			_, net = wenSatTransferV1(gross)
			switch role {
			case 4:
				post -= cash
			case 6:
				post += cash
			case 5:
				post += net
			case 7:
				post -= gross
			}
		}
		row := rpc.TokenBalance{AccountIndex: uint16(i), Owner: &owner, Mint: mint, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: strconv.FormatUint(pre, 10), Decimals: decimals}}
		m.PreTokenBalances = append(m.PreTokenBalances, row)
		row.UiTokenAmount = &rpc.UiTokenAmount{Amount: strconv.FormatUint(post, 10), Decimals: decimals}
		m.PostTokenBalances = append(m.PostTokenBalances, row)
	}
	envelope := &rpc.TransactionResultEnvelope{}
	raw, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	if e = json.Unmarshal(raw, envelope); e != nil {
		t.Fatal(e)
	}
	return &rpc.GetTransactionResult{Slot: 120, Meta: m, Transaction: envelope}
}
func TestWENMarketExecutionAndRestartRecovery(t *testing.T) {
	for _, mode := range []string{"ok", "lost", "missing", "failed", "unauthorized", "changed-custody", "missing-admission", "resume-signing", "resume-signed", "bad-cash", "bad-owner", "bad-fee", "stale-receipt", "late-custody", "revoked-signing", "revoked-signed", "configured-route", "configured-cancel", "configured-expire", "draft-tamper", "network-change"} {
		t.Run(mode, func(t *testing.T) {
			store, keys := openTestSignerV2(t)
			f, p, policy, l := marketReadFixtureV1(t)
			record, old := createTestSignerWalletV2(t, store, keys, "miner", p.Pool.String(), 10000, 20000)
			store.now = time.Now
			p.Owner = solana.MustPublicKeyFromBase58(record.PublicKey)
			for _, i := range []int{7, 8} {
				data := append([]byte(nil), f.page.Value[i].Data.GetBinary()...)
				copy(data[32:64], p.Owner[:])
				f.page.Value[i].Data = rpc.DataBytesOrJSONFromBytes(data)
			}
			prepare := &wenMarketPrepareFakeV1{wenMarketReadFakeV1: f, owner: p.Owner, mode: "execution balance"}
			prepared, e := prepareWENMarketBuyV1(context.Background(), prepare, p, policy, l, 6000, 114762240, nil)
			if e != nil {
				t.Fatal(e)
			}
			a, e := newWENMarketReviewV1("review-request-001", "miner", old.Hash, prepared)
			if e != nil {
				t.Fatal(e)
			}
			cash := strconv.FormatUint(a.Binding.Snapshot.Quote.InputCash, 10)
			updated, e := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: old.Role, Operations: []string{wenMarketOperationV1}, Programs: a.requiredPrograms(), Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{p.Pool.String()}, MaxPerTx: "6000", MaxDaily: "6000"}, {Asset: a.cashAsset(), Destinations: []string{p.Pool.String()}, MaxPerTx: cash, MaxDaily: cash}}}, old.Version)
			if e != nil {
				t.Fatal(e)
			}
			a.PolicyHash = updated.Hash
			cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
			routeClient := &marketExecutionFakeV1{wenMarketPrepareFakeV1: prepare, store: store, artifact: a, outcome: mode}
			endpoint := "https://market-test.invalid"
			factory := func(url string) wenMarketExecutionRPCV1 {
				if url != endpoint {
					t.Fatal("application selected RPC")
				}
				return routeClient
			}
			configured := mode == "configured-route" || mode == "configured-cancel" || mode == "configured-expire"
			routed := configured || mode == "draft-tamper" || mode == "network-change"
			if routed {
				keys.genesisHash = func(string) (string, error) { return a.Policy.Successor.Genesis, nil }
				if _, e = keys.PutNetworkV2(a.WalletID, signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
					t.Fatal(e)
				}
			}
			if configured || mode == "draft-tamper" {
				draft := wenMarketDraftV1{Version: 1, WalletID: a.WalletID, WalletPublicKey: a.WalletPublicKey, Pins: p, Policy: policy, Limits: l, MaxFee: 6000, RetainedLamports: 114762240}
				raw, _ := json.Marshal(draft)
				hash := wenHashV1(raw)
				calls := 0
				installFactory := func(url string) wenMarketExecutionRPCV1 { calls++; return factory(url) }
				if _, e = (&signerServiceV2{store: store, keys: keys}).installWENMarketDraftV1(context.Background(), cfg, a.WalletID, draft, hash, false, installFactory); e == nil || calls != 0 {
					t.Fatal("application installed protected draft")
				}
				draftService := &signerServiceV2{store: store, keys: keys}
				for i := 0; i < 2; i++ {
					if got, e := draftService.installWENMarketDraftV1(context.Background(), cfg, a.WalletID, draft, hash, true, factory); e != nil || got != hash {
						t.Fatal("draft install/retry", e)
					}
				}
				if mode == "draft-tamper" {
					path := filepath.Join(filepath.Dir(store.db.Path()), "wen-campaign", wenHashV1([]byte(a.WalletID)), "market-draft-"+hash+".json")
					if e = os.WriteFile(path, []byte("{}"), 0600); e != nil {
						t.Fatal(e)
					}
				}
				body, _ := json.Marshal(wenMarketReviewRequestV1{RequestID: a.RequestID, DraftSHA256: hash})
				req := request{Op: "v2.wenMarket.review.prepare", WalletID: a.WalletID, Request: body}
				calls = 0
				wire, e := draftService.marketApplicationWithFactoryV1(context.Background(), req, cfg, installFactory)
				if mode == "draft-tamper" {
					if e == nil || calls != 0 {
						t.Fatal("changed draft reached RPC", e)
					}
					return
				}
				if e != nil {
					t.Fatal("configured review", e)
				}
				var response struct {
					Result signerReviewV2 `json:"result"`
				}
				if e = json.Unmarshal(wire, &response); e != nil {
					t.Fatal(e)
				}
				if e = json.Unmarshal(response.Result.SemanticIntent, &a); e != nil {
					t.Fatal(e)
				}
				routeClient.artifact = a
				if loadWENCampaignDigestAdmissionV1(store.db.Path(), a.WalletID, mustMarketDigestV1(t, a)) == nil {
					t.Fatal("preparation granted admission")
				}
			} else {
				if _, e = store.storeWENMarketReviewV1(a); e != nil {
					t.Fatal(e)
				}
			}
			digest, _ := a.digest()
			root := filepath.Join(filepath.Dir(store.db.Path()), "wen-campaign", wenHashV1([]byte(a.WalletID)))
			if e = os.MkdirAll(root, 0700); e != nil {
				t.Fatal(e)
			}
			if configured {
				admissionService := &signerServiceV2{store: store, keys: keys}
				calls := 0
				admitFactory := func(url string) wenMarketExecutionRPCV1 { calls++; return factory(url) }
				if e = admissionService.installWENMarketAdmissionV1(context.Background(), cfg, a.WalletID, a.RequestID, digest, false, admitFactory); e == nil || calls != 0 {
					t.Fatal("application installed admission")
				}
				if e = admissionService.installWENMarketAdmissionV1(context.Background(), cfg, a.WalletID, a.RequestID, wenHashV1([]byte("wrong")), true, admitFactory); e == nil || calls != 0 {
					t.Fatal("wrong admission digest reached RPC")
				}
				for i := 0; i < 2; i++ {
					if e = admissionService.installWENMarketAdmissionV1(context.Background(), cfg, a.WalletID, a.RequestID, digest, true, factory); e != nil {
						t.Fatal("admission install/retry", e)
					}
				}
			} else if mode != "missing-admission" {
				raw, _ := json.Marshal(wenCampaignAdmissionV1{Version: 1, WalletID: a.WalletID, ArtifactDigest: digest})
				if e = os.WriteFile(filepath.Join(root, digest+".json"), raw, 0600); e != nil {
					t.Fatal(e)
				}
			}
			for scope, n := range wenMarketReservationScopesV1(a) {
				if e = store.configureWENBudgetV1(scope, n); e != nil {
					t.Fatal(e)
				}
			}
			if mode == "configured-cancel" || mode == "configured-expire" {
				if _, _, e = store.reserveWENMarketReviewV1(a); e != nil {
					t.Fatal(e)
				}
				action, outcome := "cancel", "cancelled"
				if mode == "configured-expire" {
					action, outcome = "expire", "expired"
					var review signerReviewV2
					e = store.db.View(func(tx *bolt.Tx) error {
						return json.Unmarshal(tx.Bucket(bucketSignerReviewsV2).Get([]byte(a.RequestID)), &review)
					})
					if e != nil {
						t.Fatal(e)
					}
					expires, e := time.Parse(time.RFC3339Nano, review.ExpiresAt)
					if e != nil {
						t.Fatal(e)
					}
					store.now = func() time.Time { return expires.Add(time.Second) }
				}
				for i := 0; i < 2; i++ {
					body, _ := json.Marshal(wenMiningClaimJourneyRequestV1{RequestID: a.RequestID, Action: action})
					wire, e := (&signerServiceV2{store: store, keys: keys}).marketApplicationWithFactoryV1(context.Background(), request{Op: "v2.wenMarket.journey", WalletID: a.WalletID, Request: body}, cfg, factory)
					if e != nil {
						t.Fatal("configured close/retry", e)
					}
					var response struct {
						Result wenMiningClaimJourneyResultV1 `json:"result"`
					}
					if e = json.Unmarshal(wire, &response); e != nil || response.Result.Outcome != outcome || response.Result.RecoveryRequired {
						t.Fatal("close result", e, string(wire))
					}
				}
				assertMarketHoldV1(t, store, a, false)
				if routeClient.sends != 0 {
					t.Fatal("closure sent transaction")
				}
				if _, _, e = store.reserveWENMarketReviewV1(a); e == nil {
					t.Fatal("closed review revived")
				}
				return
			}
			auth, e := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
			if e != nil {
				t.Fatal(e)
			}
			fixture := &testSignerWebAuthnFixtureV2{store: store, service: auth, walletID: a.WalletID}
			authenticator := newTestWebAuthnAuthenticatorV2(t)
			fixture.enroll(t, authenticator)
			finish, e := fixture.finishReview(t, fixture.beginReview(t), authenticator, 2)
			if e != nil {
				t.Fatal(e)
			}
			proof := &finish.Authorization.Proof
			if mode == "unauthorized" {
				proof = nil
			}
			client := &marketExecutionFakeV1{wenMarketPrepareFakeV1: prepare, store: store, artifact: a, outcome: mode}
			if mode == "changed-custody" {
				data := append([]byte(nil), f.page.Value[8].Data.GetBinary()...)
				data[64]++
				f.page.Value[8].Data = rpc.DataBytesOrJSONFromBytes(data)
			}
			if mode == "resume-signing" || mode == "resume-signed" || mode == "revoked-signing" || mode == "revoked-signed" {
				if _, _, e = store.reserveWENMarketReviewV1(a); e != nil {
					t.Fatal(e)
				}
				if e = auth.authorizeWENMarketV1(a.WalletID, a.RequestID, digest, proof); e != nil {
					t.Fatal(e)
				}
				if e = store.beginWENMarketSigningV1(a.WalletID, a.RequestID, digest, prepared); e != nil {
					t.Fatal(e)
				}
				if mode == "resume-signed" || mode == "revoked-signed" {
					key, _, e := keys.privateKey(a.WalletID)
					if e != nil {
						t.Fatal(e)
					}
					sig, e := key.Sign(prepared.message)
					zeroBytes(key)
					if e != nil {
						t.Fatal(e)
					}
					if e = store.recordWENMarketSignatureV1(a.WalletID, a.RequestID, digest, prepared, sig.String()); e != nil {
						t.Fatal(e)
					}
				}
			}
			if mode == "revoked-signing" || mode == "revoked-signed" {
				if e = store.db.Update(func(tx *bolt.Tx) error {
					var record signerReviewProofRecordV2
					if e := json.Unmarshal(tx.Bucket(bucketSignerReviewProofsV2).Get([]byte(proof.ProofID)), &record); e != nil {
						return e
					}
					_, id, e := normalizeSignerWebAuthnCredentialIDV2(record.CredentialID)
					if e != nil {
						return e
					}
					return tx.Bucket(bucketSignerWebAuthnCredentialsV2).Delete(signerWebAuthnCredentialKeyV2(id))
				}); e != nil {
					t.Fatal(e)
				}
			}
			service := &signerServiceV2{store: store, keys: keys, webauthn: auth}
			var state string
			if routed {
				routeClient.artifact = a
				routeClient.outcome = mode
				client = routeClient
				guardedFactory := func(url string) wenMarketExecutionRPCV1 {
					got := factory(url)
					if mode == "network-change" {
						if _, e := keys.PutNetworkV2(a.WalletID, signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://changed-test.invalid"}); e != nil {
							t.Fatal(e)
						}
					}
					return got
				}
				body, _ := json.Marshal(wenMiningClaimJourneyRequestV1{RequestID: a.RequestID, Action: "execute", Proof: proof})
				wire, err := service.marketApplicationWithFactoryV1(context.Background(), request{Op: "v2.wenMarket.journey", WalletID: a.WalletID, Request: body}, cfg, guardedFactory)
				e = err
				if e == nil {
					var response struct {
						Result wenMiningClaimJourneyResultV1 `json:"result"`
					}
					if e = json.Unmarshal(wire, &response); e != nil {
						t.Fatal(e)
					}
					state = response.Result.Outcome
				}
			} else {
				_, state, e = service.executeWENMarketV1(context.Background(), client, auth, a.WalletID, a.RequestID, proof)
			}
			if mode == "unauthorized" || mode == "changed-custody" || mode == "missing-admission" || mode == "late-custody" || mode == "revoked-signing" || mode == "revoked-signed" || mode == "network-change" {
				if e == nil || client.sends != 0 {
					t.Fatal("unadmitted send", state, e)
				}
				return
			}

			malformed := mode == "bad-cash" || mode == "bad-owner" || mode == "bad-fee" || mode == "stale-receipt"
			if malformed {
				if e == nil || state != "submission-uncertain" || client.sends != 1 {
					t.Fatal("malformed receipt accepted", state, e)
				}
				if e = store.db.View(func(tx *bolt.Tx) error {
					var r wenMarketReservationV1
					if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("market-request:"+a.RequestID)), &r); e != nil {
						return e
					}
					if r.OutcomeDigest != "" {
						t.Fatal("invalid receipt settled")
					}
					for scope, n := range r.Scopes {
						var balance wenBudgetBalanceV1
						if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &balance); e != nil {
							return e
						}
						if balance.Reserved != n {
							t.Fatal("invalid receipt released hold")
						}
					}
					return nil
				}); e != nil {
					t.Fatal(e)
				}
			}
			want := "finalized-success"
			if mode == "failed" {
				want = "finalized-failed"
			}
			if mode == "missing" || malformed {
				want = "submission-uncertain"
			}
			if state != want || client.sends != 1 || (e != nil && mode != "missing" && !malformed) {
				t.Fatal("execution", state, e, client.sends)
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
			client.store = reopened
			if mode == "missing" || malformed {
				sig := client.signature
				wire := make([]byte, 65+len(a.Binding.Message))
				wire[0] = 1
				copy(wire[1:65], sig[:])
				copy(wire[65:], a.Binding.Message)
				client.result = marketReceiptFixtureV1(t, a, wire, false)
				want = "finalized-success"
			}
			for i := 0; i < 2; i++ {
				if mode == "configured-route" {
					resumedKeys := *keys
					resumedKeys.store = reopened
					resumedService := &signerServiceV2{store: reopened, keys: &resumedKeys}
					body, _ := json.Marshal(wenMiningClaimJourneyRequestV1{RequestID: a.RequestID, Action: "recover"})
					wire, err := resumedService.marketApplicationWithFactoryV1(context.Background(), request{Op: "v2.wenMarket.journey", WalletID: a.WalletID, Request: body}, cfg, factory)
					e = err
					if e == nil {
						var response struct {
							Result wenMiningClaimJourneyResultV1 `json:"result"`
						}
						if e = json.Unmarshal(wire, &response); e != nil {
							t.Fatal(e)
						}
						if response.Result.Digest != digest || response.Result.RecoveryRequired {
							t.Fatal("typed recovery binding")
						}
						state = response.Result.Outcome
					}
				} else {
					state, e = reopened.recoverWENMarketV1(context.Background(), client, a.RequestID, digest)
				}

				if e != nil || state != want || client.sends != 1 {
					t.Fatal("restart recovery", state, e, client.sends)
				}
			}
			if e = reopened.db.View(func(tx *bolt.Tx) error {
				var r wenMarketReservationV1
				if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("market-request:"+a.RequestID)), &r); e != nil {
					return e
				}
				var native wenBudgetBalanceV1
				if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+wenMiningNativeScopeV1(a.WalletID, a.Policy.Successor.Genesis))), &native); e != nil {
					return e
				}
				if native.Reserved != 5000 {
					t.Fatal("unused native fee allowance not released")
				}
				if r.OutcomeDebit != 5000 {
					t.Fatal("actual fee not recorded")
				}
				n := a.Binding.Snapshot.Quote.InputCash
				if mode == "failed" {
					n = 0
				}
				if r.OutcomeCash != n {
					t.Fatal("cash outcome")
				}
				var balance wenBudgetBalanceV1
				if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+wenMarketCashScopeV1(a))), &balance); e != nil {
					return e
				}
				if balance.Reserved != n {
					t.Fatal("unused cash not released")
				}
				return nil
			}); e != nil {
				t.Fatal(e)
			}
		})
	}
}

func mustMarketDigestV1(t *testing.T, a wenMarketReviewArtifactV1) string {
	t.Helper()
	d, e := a.digest()
	if e != nil {
		t.Fatal(e)
	}
	return d
}
