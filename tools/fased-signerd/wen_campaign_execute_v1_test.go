package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
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

func TestWENCampaignExecutionV1(t *testing.T) {
	for _, op := range []string{"stop", "top-up", "withdraw", "claim"} {
		for _, mode := range []string{"ok", "lost", "missing", "failed", "unauthorized", "resume-signing", "resume-signed", "revoked-signing", "revoked-signed", "missing-admission", "wrong-admission", "symlink-admission", "route", "route-change", "route-missing", "invalid-signature"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				store, keys := openTestSignerV2(t)
				program := solana.NewWallet().PublicKey()
				issuer := solana.NewWallet().PublicKey()
				economy := campaignAccountingTestSale(program, issuer)
				record, old := createTestSignerWalletV2(t, store, keys, "miner", economy.String(), 10000, 20000)
				store.now = time.Now
				wallet := solana.MustPublicKeyFromBase58(record.PublicKey)
				policy, err := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: old.Role, Operations: []string{wenCampaignOperationV1(op)}, Programs: []string{program.String()}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{economy.String()}, MaxPerTx: "10000", MaxDaily: "20000"}}}, old.Version)
				if err != nil {
					t.Fatal(err)
				}
				mint, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), economy[:]}, program)
				window := campaignAccountingTestWindow(program, issuer, mint)
				pos, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-retail-position-v2"), wallet[:], mint[:]}, program)
				data := make([]byte, 256)
				copy(data, "WENRPOS2")
				data[8] = 1
				copy(data[16:], wallet[:])
				copy(data[48:], issuer[:])
				copy(data[80:], mint[:])
				copy(data[192:], window[:])
				snapshot := wenCampaignPositionV1{Slot: 110, ReferenceSlot: 111, Address: pos, Owner: program, Data: data, Lamports: 1100, Rent: 100}
				action := wenCampaignOwnerActionV1{Operation: op, Program: program, Economy: economy, Position: pos, Amount: 1000}
				if op == "stop" {
					action.Amount = 0
				}
				var claim *wenCampaignClaimSnapshotV1
				if op == "claim" {
					c := campaignClaimExecutionSnapshot(program, economy, wallet)
					claim = &c
					action.Claim = campaignClaimRequestFromSnapshot(c)
					action.Amount = 0
					snapshot = campaignClaimPositionV1(c)
				}
				if op != "claim" {
					accounts := campaignAccountingTestAccounts(t, program, economy, issuer, window, mint)
					reader := &campaignReadFake{wenReadRPCFake: &wenReadRPCFake{t: t}, accounting: accounts}
					hash, e := readWENCampaignAccountingV1(context.Background(), reader, program, economy, issuer, window, mint, 110, 132)
					if e != nil {
						t.Fatal(e)
					}
					snapshot.AccountingSHA256 = hex.EncodeToString(hash[:])
				}
				var ix solana.Instruction
				if claim != nil {
					ix, _, err = buildWENCampaignClaimV1(*claim)
				} else {
					ix, err = buildWENCampaignOwnerV1(action, wallet, snapshot)
				}
				if err != nil {
					t.Fatal(err)
				}
				hash := solana.Hash(solana.NewWallet().PublicKey())
				tx, err := solana.NewTransaction([]solana.Instruction{ix}, hash, solana.TransactionPayer(wallet))
				if err != nil {
					t.Fatal(err)
				}
				tx.Message.SetVersion(solana.MessageVersionV0)
				msg, err := tx.Message.MarshalBinary()
				if err != nil {
					t.Fatal(err)
				}
				testKey, _, e := keys.privateKey("miner")
				if e != nil {
					t.Fatal(e)
				}
				_, e = testKey.Sign(msg)
				zeroBytes(testKey)
				if e != nil {
					t.Fatal(e)
				}
				prepared := &wenCampaignPreparedV1{message: msg, blockhash: hash, position: snapshot, claim: claim, fee: 4500, currentHeight: 100, lastValidHeight: 200}
				pins := signerWENBTCPinsV1{ProgramID: program.String(), Genesis: hash.String(), CodeSHA256: wenHashV1([]byte("fixture")), DeploymentSlot: 50}
				artifact, err := newWENCampaignReviewV1("review-request-001", "miner", policy.Hash, pins, action, wallet, prepared, 132, 5000)
				if err != nil {
					t.Fatal(err)
				}
				review, err := store.storeWENCampaignReviewV1(artifact)
				if err != nil {
					t.Fatal(err)
				}

				ad, _ := artifact.digest()
				root := filepath.Join(filepath.Dir(store.db.Path()), "wen-campaign", wenHashV1([]byte("miner")))
				if err = os.MkdirAll(root, 0700); err != nil {
					t.Fatal(err)
				}
				entry := wenCampaignAdmissionV1{Version: 1, WalletID: "miner", ArtifactDigest: ad}
				if mode == "wrong-admission" {
					entry.ArtifactDigest = wenHashV1([]byte("wrong"))
				}
				raw, _ := json.Marshal(entry)
				if mode != "missing-admission" {
					if err = os.WriteFile(filepath.Join(root, ad+".json"), raw, 0600); err != nil {
						t.Fatal(err)
					}
				}
				if mode == "symlink-admission" {
					path := filepath.Join(root, ad+".json")
					if err = os.Rename(path, path+".target"); err != nil {
						t.Fatal(err)
					}
					if err = os.Symlink(path+".target", path); err != nil {
						t.Fatal(err)
					}
				}
				_ = review
				debit, _ := artifact.debit()
				for _, scope := range []string{wenMiningNativeScopeV1("miner", pins.Genesis), wenCampaignLaunchScopeV1(artifact)} {
					if err = store.configureWENBudgetV1(scope, debit); err != nil {
						t.Fatal(err)
					}
				}
				authService, err := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
				if err != nil {
					t.Fatal(err)
				}
				authenticator := newTestWebAuthnAuthenticatorV2(t)
				fixture := &testSignerWebAuthnFixtureV2{store: store, service: authService, walletID: "miner"}
				fixture.enroll(t, authenticator)
				service := &signerServiceV2{store: store, keys: keys, webauthn: authService}
				beginRaw, _ := json.Marshal(signerReviewAuthorizationBeginRequestV2{RequestID: artifact.RequestID})
				beginWire, err := service.handle(request{Op: "v2.review.authorization.begin", WalletID: "miner", Request: beginRaw}, signerConfig{}, false)
				if err != nil {
					t.Fatal(err)
				}
				var beginEnvelope struct {
					Result signerReviewAuthorizationBeginResultV2 `json:"result"`
				}
				if err = json.Unmarshal(beginWire, &beginEnvelope); err != nil {
					t.Fatal(err)
				}
				begin := beginEnvelope.Result
				signingAuthenticator := authenticator
				if mode == "invalid-signature" {
					signingAuthenticator = newTestWebAuthnAuthenticatorV2(t)
					signingAuthenticator.credentialID = authenticator.credentialID
				}
				assertion := signingAuthenticator.assertionResponse(t, begin.Options, testWebAuthnOrigin, testWebAuthnRPID, "", 0x05, 2)
				finishRaw, _ := json.Marshal(signerReviewAuthorizationFinishRequestV2{ChallengeID: begin.ChallengeID, Credential: assertion})
				finishWire, err := service.handle(request{Op: "v2.review.authorization.finish", WalletID: "miner", Request: finishRaw}, signerConfig{}, false)
				if mode == "invalid-signature" {
					if err == nil {
						t.Fatal("forged authenticator signature accepted")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				var finishEnvelope struct {
					Result signerReviewAuthorizationFinishResultV2 `json:"result"`
				}
				if err = json.Unmarshal(finishWire, &finishEnvelope); err != nil {
					t.Fatal(err)
				}
				finish := finishEnvelope.Result
				rpcMode := mode
				if mode == "route-missing" {
					rpcMode = "missing"
				}
				client := campaignExecutionFixture(t, artifact, store, rpcMode)
				if mode == "unauthorized" {
					finish.Authorization.Proof.ProofID = "wrong-proof"
				}
				if mode == "resume-signing" || mode == "resume-signed" || mode == "revoked-signing" || mode == "revoked-signed" {
					d, _, e := store.reserveWENCampaignReviewV1(artifact)
					if e != nil {
						t.Fatal(e)
					}
					if e = authService.authorizeWENCampaignV1("miner", artifact.RequestID, d, &finish.Authorization.Proof); e != nil {
						t.Fatal(e)
					}
					if e = store.beginWENCampaignSigningV1("miner", artifact.RequestID, d, prepared); e != nil {
						t.Fatal(e)
					}
					if mode == "resume-signed" || mode == "revoked-signed" {
						k, _, e := keys.privateKey("miner")
						if e != nil {
							t.Fatal(e)
						}
						sig, e := k.Sign(prepared.message)
						zeroBytes(k)
						if e != nil {
							t.Fatal(e)
						}
						if e = store.recordWENCampaignSignatureV1("miner", artifact.RequestID, d, prepared, sig.String()); e != nil {
							t.Fatal(e)
						}
					}
					// Entry resumes exclusively from the stored reservation.
					finish.Authorization.Proof.ProofID = "not-used-on-resume"
				}
				if mode == "revoked-signing" || mode == "revoked-signed" {
					summary, e := authService.credentialSummary()
					if e != nil {
						t.Fatal(e)
					}
					if _, e = authService.revokeCredential(signerWebAuthnCredentialRevokeRequestV2{CredentialID: finish.CredentialID, ExpectedCount: summary.Count, ExpectedVersion: summary.Version, ConfirmLastCredential: true}); e != nil {
						t.Fatal(e)
					}
				}
				if mode == "route" || mode == "route-change" || mode == "route-missing" {
					keys.genesisHash = func(string) (string, error) { return pins.Genesis, nil }
					endpoint := "https://campaign-routing.invalid"
					if _, e := keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
						t.Fatal(e)
					}
					if mode == "route" {
						draft := wenCampaignDraftV1{Version: 1, WalletID: "miner", WalletPublicKey: artifact.WalletPublicKey, Pins: pins, Action: action, MinimumSlot: 100, ExpiresSlot: 132, MaxFee: 5000}
						raw, _ := json.Marshal(draft)
						hash := wenHashV1(raw)
						path := filepath.Join(root, "draft-"+hash+".json")
						installFactory := func(url string) wenCampaignExecutionRPCV1 {
							if url != endpoint {
								t.Fatal("install RPC")
							}
							return client
						}
						installCfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
						if _, e := service.installWENCampaignDraftV1(context.Background(), installCfg, "miner", draft, hash, false, installFactory); e == nil {
							t.Fatal("non-control install")
						}
						if _, e := service.installWENCampaignDraftV1(context.Background(), installCfg, "miner", draft, wenHashV1([]byte("wrong")), true, installFactory); e == nil {
							t.Fatal("unreviewed draft install")
						}
						for i := 0; i < 2; i++ {
							got, e := service.installWENCampaignDraftV1(context.Background(), installCfg, "miner", draft, hash, true, installFactory)
							if e != nil || got != hash {
								t.Fatal("draft installation/retry", e)
							}
						}

						adminRaw, _ := json.Marshal(wenCampaignDraftInstallRequestV1{Draft: draft, ExpectedSHA256: hash})
						if _, e := service.campaignAdminWithFactoryV1(context.Background(), request{Op: "v2.wenCampaign.draft.install", WalletID: "miner", Request: adminRaw}, installCfg, true, installFactory); e != nil {
							t.Fatal("draft admin route", e)
						}
						body := wenCampaignReviewRequestV1{RequestID: "generated-review-001", DraftSHA256: hash}
						factory := func(url string) wenCampaignExecutionRPCV1 {
							if url != endpoint {
								t.Fatal("review endpoint")
							}
							return client
						}
						generated, e := service.prepareConfiguredWENCampaignReviewV1(context.Background(), signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}, "miner", body, factory)
						if e != nil || generated.ArtifactKind != wenCampaignArtifactKindV1 || generated.WalletPublicKey != record.PublicKey || client.sends != 0 {
							t.Fatal("configured review", e)
						}
						var made wenCampaignReviewArtifactV1
						if e = json.Unmarshal(generated.SemanticIntent, &made); e != nil {
							t.Fatal(e)
						}
						if loadWENCampaignAdmissionV1(store.db.Path(), made) == nil {
							t.Fatal("review auto-admitted")
						}
						madeHash, _ := made.digest()
						if e = service.installWENCampaignAdmissionV1(context.Background(), installCfg, "miner", body.RequestID, madeHash, false, factory); e == nil {
							t.Fatal("noncontrol admission")
						}
						for i := 0; i < 2; i++ {
							if e = service.installWENCampaignAdmissionV1(context.Background(), installCfg, "miner", body.RequestID, madeHash, true, factory); e != nil {
								t.Fatal("admission install/retry", e)
							}
						}
						adminRaw, _ = json.Marshal(wenCampaignAdmissionInstallRequestV1{RequestID: body.RequestID, ExpectedSHA256: madeHash})
						if _, e = service.campaignAdminWithFactoryV1(context.Background(), request{Op: "v2.wenCampaign.admission.install", WalletID: "miner", Request: adminRaw}, installCfg, true, factory); e != nil {
							t.Fatal("admission admin route", e)
						}
						if e = loadWENCampaignAdmissionV1(store.db.Path(), made); e != nil || client.sends != 0 {
							t.Fatal("admission readback", e)
						}
						if e = os.WriteFile(path, []byte("{}"), 0600); e != nil {
							t.Fatal(e)
						}
						body.RequestID = "generated-review-002"
						calls := 0
						if _, e = service.prepareConfiguredWENCampaignReviewV1(context.Background(), signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}, "miner", body, func(string) wenCampaignExecutionRPCV1 { calls++; return client }); e == nil || calls != 0 {
							t.Fatal("changed draft used", e)
						}
					}
					payload, _ := json.Marshal(wenMiningClaimJourneyRequestV1{RequestID: artifact.RequestID, Action: "execute", Proof: &finish.Authorization.Proof})
					result, e := service.campaignApplicationWithFactoryV1(context.Background(), request{Op: "v2.wenCampaign.journey", WalletID: "miner", Request: payload}, signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}, func(url string) wenCampaignExecutionRPCV1 {
						if url != endpoint {
							t.Fatal("wrong protected RPC")
						}
						if mode == "route-change" {
							if _, e := keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://changed.invalid"}); e != nil {
								t.Fatal(e)
							}
						}
						return client
					})
					if mode == "route-change" {
						if e == nil || client.sends != 0 {
							t.Fatal("changed network executed", e)
						}
						return
					}
					if e != nil {
						t.Fatal("configured route", e)
					}
					var summary struct {
						Result wenMiningClaimJourneyResultV1 `json:"result"`
					}
					expectedOutcome := "finalized-success"
					if mode == "route-missing" {
						expectedOutcome = "submission-uncertain"
					}
					if e = json.Unmarshal(result, &summary); e != nil || summary.Result.Outcome != expectedOutcome || summary.Result.RecoveryRequired != (mode == "route-missing") {
						t.Fatal("configured result", string(result), e)
					}
				}
				digest, state, err := service.executeWENCampaignV1(context.Background(), client, authService, "miner", artifact.RequestID, &finish.Authorization.Proof)
				if mode == "missing-admission" || mode == "wrong-admission" || mode == "symlink-admission" {
					if err == nil || client.sends != 0 {
						t.Fatal("unadmitted execution", state, err)
					}
					return
				}
				if mode == "revoked-signing" || mode == "revoked-signed" {
					if err == nil || client.sends != 0 {
						t.Fatal("revoked resume", state, err)
					}
					return
				}
				if mode == "unauthorized" {
					if err == nil || state != "reserved" || client.sends != 0 {
						t.Fatal("unauthorized execution", state, err, client.sends)
					}
					return
				}
				want := "finalized-success"
				if mode == "failed" {
					want = "finalized-failed"
				}
				if mode == "missing" || mode == "route-missing" {
					want = "submission-uncertain"
				}
				if state != want || (err != nil && mode != "missing" && mode != "route-missing") || client.sends != 1 {
					t.Fatal("execute", state, err, client.sends)
				}
				// Restart the database and recover without consulting a private key or resending.
				path := store.db.Path()
				store.Close()
				reopened, e := openSignerStoreV2(path)
				if e != nil {
					t.Fatal(e)
				}
				defer reopened.Close()
				state, e = reopened.recoverWENCampaignV1(context.Background(), client, artifact.RequestID, digest)
				if e != nil || state != want || client.sends != 1 {
					t.Fatal("restart recovery", state, e)
				}
			})
		}
	}
}

type campaignExecutionFake struct {
	*campaignPrepareFake
	store    *signerStoreV2
	artifact wenCampaignReviewArtifactV1
	result   *rpc.GetTransactionResult
	sends    int
	outcome  string
}

func campaignExecutionFixture(t *testing.T, a wenCampaignReviewArtifactV1, store *signerStoreV2, mode string) *campaignExecutionFake {
	p := a.Action.Program
	pd, _, _ := solana.FindProgramAddress([][]byte{p[:]}, solana.BPFLoaderUpgradeableProgramID)
	program := make([]byte, 36)
	binary.LittleEndian.PutUint32(program, 2)
	copy(program[4:], pd[:])
	body := make([]byte, 45+len("fixture"))
	binary.LittleEndian.PutUint32(body, 3)
	binary.LittleEndian.PutUint64(body[4:], 50)
	copy(body[45:], "fixture")
	clock := make([]byte, 40)
	binary.LittleEndian.PutUint64(clock, 111)
	binary.LittleEndian.PutUint64(clock[32:], 1000)
	account := func(d []byte, o solana.PublicKey, x bool) *rpc.Account {
		return &rpc.Account{Owner: o, Executable: x, Lamports: 1100, Data: rpc.DataBytesOrJSONFromBytes(d)}
	}
	page := &rpc.GetMultipleAccountsResult{Value: []*rpc.Account{account(a.Binding.Position.Data, p, false), account(program, solana.BPFLoaderUpgradeableProgramID, true), account(body, solana.BPFLoaderUpgradeableProgramID, false), account(clock, solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), false)}}
	base := &wenReadRPCFake{t: t, genesis: solana.MustHashFromBase58(a.Pins.Genesis), page: page, addresses: []solana.PublicKey{a.Action.Position, p, pd, solana.SysVarClockPubkey}}
	if s := a.Binding.Claim; s != nil {
		records := []signerWENBTCAccountV1{s.Position, s.Page, s.Mint, s.Destination}
		value := []*rpc.Account{}
		addresses := []solana.PublicKey{}
		for _, v := range records {
			value = append(value, account(v.Data, v.Owner, v.Executable))
			addresses = append(addresses, v.Address)
		}
		value = append(value, page.Value[1], page.Value[2], page.Value[3])
		addresses = append(addresses, p, pd, solana.SysVarClockPubkey)
		for _, w := range s.Windows {
			for _, v := range []signerWENBTCAccountV1{w.Window, w.Vault} {
				value = append(value, account(v.Data, v.Owner, v.Executable))
				addresses = append(addresses, v.Address)
			}
		}
		page.Value = value
		base.addresses = addresses
	}

	if w := a.Binding.Position.PolicyWindow; w != nil {
		page.Value = append(page.Value, account(w.Data, w.Owner, false))
		base.addresses = append(base.addresses, w.Address)
	}

	var issuer, window solana.PublicKey
	copy(issuer[:], a.Binding.Position.Data[48:80])
	copy(window[:], a.Binding.Position.Data[192:224])
	mint, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), a.Action.Economy[:]}, p)
	accounting := map[solana.PublicKey]*rpc.Account{}
	if a.Binding.Claim == nil {
		accounting = campaignAccountingTestAccounts(t, p, a.Action.Economy, issuer, window, mint)
	}
	return &campaignExecutionFake{campaignPrepareFake: &campaignPrepareFake{campaignReadFake: &campaignReadFake{wenReadRPCFake: base, accounting: accounting}}, store: store, artifact: a, outcome: mode}
}
func (f *campaignExecutionFake) GetMultipleAccountsWithOpts(c context.Context, k []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	f.next = 110
	if f.artifact.Binding.Claim != nil {
		return (&campaignClaimPrepareFake{f.campaignPrepareFake}).GetMultipleAccountsWithOpts(c, k, o)
	}
	return f.campaignPrepareFake.GetMultipleAccountsWithOpts(c, k, o)
}
func (f *campaignExecutionFake) GetSlot(context.Context, rpc.CommitmentType) (uint64, error) {
	if f.result != nil {
		return 120, nil
	}
	return 111, nil
}
func (f *campaignExecutionFake) GetLatestBlockhash(c context.Context, k rpc.CommitmentType) (*rpc.GetLatestBlockhashResult, error) {
	f.next = 110
	return f.campaignPrepareFake.GetLatestBlockhash(c, k)
}
func (f *campaignExecutionFake) GetFeeForMessage(c context.Context, m string, k rpc.CommitmentType) (*rpc.GetFeeForMessageResult, error) {
	f.next = 110
	r, e := f.campaignPrepareFake.GetFeeForMessage(c, m, k)
	*r.Value = 4500
	return r, e
}
func (f *campaignExecutionFake) GetBalance(c context.Context, p solana.PublicKey, k rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	f.next = 110
	return f.campaignPrepareFake.GetBalance(c, p, k)
}
func (f *campaignExecutionFake) SimulateRawTransactionWithOpts(c context.Context, w []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	f.next = 110
	return f.campaignPrepareFake.SimulateRawTransactionWithOpts(c, w, o)
}
func (f *campaignExecutionFake) SendRawTransactionWithOpts(_ context.Context, wire []byte, o rpc.TransactionOpts) (solana.Signature, error) {
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
	if e = f.store.db.View(func(t *bolt.Tx) error {
		var r wenCampaignReservationV1
		if e := json.Unmarshal(t.Bucket(wenBudgetBucketV1).Get([]byte("campaign-request:"+f.artifact.RequestID)), &r); e != nil {
			return e
		}
		if r.State != "submission-uncertain" {
			f.t.Fatal("send before journal")
		}
		return nil
	}); e != nil {
		f.t.Fatal(e)
	}
	m := &rpc.TransactionMeta{Fee: 4500}
	if f.outcome == "failed" {
		m.Err = "fixture"
	}
	if s := f.artifact.Binding.Claim; s != nil {
		campaignClaimFixtureTokenRows(*s, tx.Message.AccountKeys, m)
	}
	for _, k := range tx.Message.AccountKeys {
		pre, post := uint64(1000000), uint64(1000000)
		if k.String() == f.artifact.WalletPublicKey {
			post -= 4500
		}
		if m.Err == nil {
			n := f.artifact.Action.Amount
			if f.artifact.Action.Operation == "top-up" {
				if k.String() == f.artifact.WalletPublicKey {
					post -= n
				}
				if k == f.artifact.Action.Position {
					post += n
				}
			}
			if f.artifact.Action.Operation == "withdraw" {
				if k.String() == f.artifact.WalletPublicKey {
					post += n
				}
				if k == f.artifact.Action.Position {
					post -= n
				}
			}
		}
		m.PreBalances = append(m.PreBalances, pre)
		m.PostBalances = append(m.PostBalances, post)
	}
	envelope := &rpc.TransactionResultEnvelope{}
	raw, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	json.Unmarshal(raw, envelope)
	if f.outcome != "missing" {
		f.result = &rpc.GetTransactionResult{Slot: 120, Meta: m, Transaction: envelope}
	}
	if f.outcome == "lost" || f.outcome == "missing" {
		return tx.Signatures[0], errors.New("lost reply")
	}
	return tx.Signatures[0], nil
}
func (f *campaignExecutionFake) GetTransaction(_ context.Context, s solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if o.Commitment != rpc.CommitmentFinalized {
		f.t.Fatal("nonfinal recovery")
	}
	if f.result == nil {
		return nil, rpc.ErrNotFound
	}
	return f.result, nil
}
