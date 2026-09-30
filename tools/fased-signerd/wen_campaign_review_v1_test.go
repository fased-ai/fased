package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWENCampaignStoredReviewV1(t *testing.T) {
	for _, op := range []string{"stop", "top-up", "withdraw"} {
		t.Run(op, func(t *testing.T) {
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
			state := wenCampaignPositionV1{Slot: 110, ReferenceSlot: 111, Address: pos, Owner: program, Data: data, Lamports: 1100, Rent: 100}
			reader := &campaignReadFake{wenReadRPCFake: &wenReadRPCFake{t: t}, accounting: campaignAccountingTestAccounts(t, program, economy, issuer, window, mint)}
			accounting, err := readWENCampaignAccountingV1(context.Background(), reader, program, economy, issuer, window, mint, 110, 132)
			if err != nil {
				t.Fatal(err)
			}
			state.AccountingSHA256 = hex.EncodeToString(accounting[:])
			action := wenCampaignOwnerActionV1{Operation: op, Program: program, Economy: economy, Position: pos, Amount: 1000}
			if op == "stop" {
				action.Amount = 0
			}
			ix, err := buildWENCampaignOwnerV1(action, wallet, state)
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
			testSignature, e := testKey.Sign(msg)
			zeroBytes(testKey)
			if e != nil {
				t.Fatal(e)
			}
			prepared := &wenCampaignPreparedV1{message: msg, blockhash: hash, position: state, fee: 4500, currentHeight: 100, lastValidHeight: 200}
			pins := signerWENBTCPinsV1{ProgramID: program.String(), Genesis: hash.String(), CodeSHA256: wenHashV1([]byte("fixture")), DeploymentSlot: 50}
			artifact, err := newWENCampaignReviewV1("review-request-001", "miner", policy.Hash, pins, action, wallet, prepared, 132, 5000)
			if err != nil {
				t.Fatal(err)
			}
			withoutAccounting := artifact
			withoutAccounting.Binding.Position.AccountingSHA256 = ""
			if _, err := withoutAccounting.digest(); err == nil {
				t.Fatal("review without authenticated campaign accounting accepted")
			}
			review, err := store.storeWENCampaignReviewV1(artifact)
			if err != nil {
				t.Fatal(err)
			}
			if output := os.Getenv("WEN_CAMPAIGN_REVIEW_FIXTURE_DIR"); output != "" {
				raw, err := json.MarshalIndent(review, "", "  ")
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(output, op+".json"), append(raw, '\n'), 0600); err != nil {
					t.Fatal(err)
				}
			}
			want := "5000"
			if op == "top-up" {
				want = "6000"
			}
			if review.Amount != want {
				t.Fatal("principal/fee debit", review.Amount)
			}
			if _, err = store.storeWENCampaignReviewV1(artifact); err == nil {
				t.Fatal("duplicate overwrite")
			}
			for _, change := range []func(*signerReviewV2){func(r *signerReviewV2) { r.Amount = "0" }, func(r *signerReviewV2) { r.PolicyHash = "wrong" }, func(r *signerReviewV2) { r.StateSlot++ }, func(r *signerReviewV2) { r.TransactionDigest = "wrong" }, func(r *signerReviewV2) { r.PolicyOperation = "wen.campaign.other.v1" }, func(r *signerReviewV2) {
				r.SemanticIntent = append(json.RawMessage(nil), r.SemanticIntent...)
				r.SemanticIntent[0] = '['
			}} {
				bad := review
				change(&bad)
				if _, err = reviewBindingFromStoredReviewV2(bad, policy); err == nil {
					t.Fatal("modified review accepted")
				}
			}
			for _, change := range []func(*signerPolicyV2){func(p *signerPolicyV2) { p.Operations = nil }, func(p *signerPolicyV2) { p.Programs = nil }, func(p *signerPolicyV2) { p.Hash = "wrong" }} {
				bad := policy
				change(&bad)
				if _, err = reviewBindingFromStoredReviewV2(review, bad); err == nil {
					t.Fatal("policy change accepted")
				}
			}
			// Missing launch limit must roll back shared policy usage entirely.
			debit, _ := artifact.debit()
			scope := wenMiningNativeScopeV1("miner", pins.Genesis)
			if err = store.configureWENBudgetV1(scope, debit); err != nil {
				t.Fatal(err)
			}
			if _, _, err = store.reserveWENCampaignReviewV1(artifact); err == nil {
				t.Fatal("missing launch limit accepted")
			}
			if err = store.configureWENBudgetV1(wenCampaignLaunchScopeV1(artifact), debit); err != nil {
				t.Fatal(err)
			}
			digest, existed, err := store.reserveWENCampaignReviewV1(artifact)
			if err != nil || existed || digest == "" {
				t.Fatal("reserve", err)
			}
			if _, existed, err = store.reserveWENCampaignReviewV1(artifact); err != nil || !existed {
				t.Fatal("idempotent reservation", err)
			}
			second := artifact
			second.RequestID = "review-request-002"
			if _, err = store.storeWENCampaignReviewV1(second); err != nil {
				t.Fatal(err)
			}
			if _, _, err = store.reserveWENCampaignReviewV1(second); err == nil {
				t.Fatal("same transaction reserved twice")
			}
			second.RequestID = "review-request-003"
			second.Binding.Position.ReferenceSlot++
			if _, err = store.storeWENCampaignReviewV1(second); err != nil {
				t.Fatal(err)
			}
			if _, _, err = store.reserveWENCampaignReviewV1(second); err == nil {
				t.Fatal("changed observation bypassed message reservation")
			}
			// A genuinely different transaction also cannot exceed the shared cap.
			second.RequestID = "review-request-004"
			second.Binding.Blockhash = solana.Hash(solana.NewWallet().PublicKey())
			nextTx, e := solana.NewTransaction([]solana.Instruction{ix}, second.Binding.Blockhash, solana.TransactionPayer(wallet))
			if e != nil {
				t.Fatal(e)
			}
			nextTx.Message.SetVersion(solana.MessageVersionV0)
			second.Binding.Message, e = nextTx.Message.MarshalBinary()
			if e != nil {
				t.Fatal(e)
			}
			if _, err = store.storeWENCampaignReviewV1(second); err != nil {
				t.Fatal(err)
			}
			if _, _, err = store.reserveWENCampaignReviewV1(second); err == nil {
				t.Fatal("shared cap exceeded")
			}
			if err = store.db.View(func(tx *bolt.Tx) error {
				var balance wenBudgetBalanceV1
				if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &balance); e != nil {
					return e
				}
				if balance.Reserved != debit {
					t.Fatal("duplicate reservation consumed budget")
				}
				used := string(tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2("miner", "solana:native", currentDayBucket(store.now()))))
				if used != want {
					t.Fatal("failed reservation leaked usage", used)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			service, err := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
			if err != nil {
				t.Fatal(err)
			}
			auth := newTestWebAuthnAuthenticatorV2(t)
			fixture := &testSignerWebAuthnFixtureV2{store: store, service: service, walletID: "miner"}
			fixture.enroll(t, auth)
			begin := fixture.beginReview(t)
			finish, err := fixture.finishReview(t, begin, auth, 2)
			if err != nil {
				t.Fatal(err)
			}
			if finish.Binding.ArtifactDigest != review.ArtifactDigest || finish.Binding.Amount != want {
				t.Fatal("approval binding")
			}
			wrong := finish.Binding
			wrong.Amount = "0"
			if err = service.verifyAndConsumeReviewProofV2(wrong, &finish.Authorization.Proof); err == nil {
				t.Fatal("altered approval accepted")
			}
			if err = service.authorizeWENCampaignV1("miner", artifact.RequestID, "wrong", &finish.Authorization.Proof); err == nil {
				t.Fatal("wrong reservation authorized")
			}
			if err = service.authorizeWENCampaignV1("miner", artifact.RequestID, digest, &finish.Authorization.Proof); err != nil {
				t.Fatal("atomic authorization", err)
			}
			path := store.db.Path()
			if err = store.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := openSignerStoreV2(path)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			err = reopened.db.View(func(tx *bolt.Tx) error {
				var saved signerReviewV2
				if e := json.Unmarshal(tx.Bucket(bucketSignerReviewsV2).Get([]byte(artifact.RequestID)), &saved); e != nil {
					return e
				}
				_, e := reviewBindingFromStoredReviewV2(saved, policy)
				return e
			})
			if err != nil {
				t.Fatal("persisted review", err)
			}
			recovered, err := newSignerWebAuthnServiceV2(reopened, testWebAuthnRPID, testWebAuthnOrigin)
			if err != nil {
				t.Fatal(err)
			}
			if err = recovered.authorizeWENCampaignV1("miner", artifact.RequestID, digest, &finish.Authorization.Proof); err != nil {
				t.Fatal("persisted approval", err)
			}
			if err = recovered.verifyAndConsumeReviewProofV2(finish.Binding, &finish.Authorization.Proof); err == nil {
				t.Fatal("approval replay")
			}
			changed := *prepared
			changed.fee++
			if e := reopened.beginWENCampaignSigningV1("miner", artifact.RequestID, digest, &changed); e == nil {
				t.Fatal("changed fee signed")
			}
			changed = *prepared
			changed.position.ReferenceSlot--
			if e := reopened.beginWENCampaignSigningV1("miner", artifact.RequestID, digest, &changed); e == nil {
				t.Fatal("observation rollback signed")
			}
			changed = *prepared
			changed.currentHeight = changed.lastValidHeight
			if e := reopened.beginWENCampaignSigningV1("miner", artifact.RequestID, digest, &changed); e == nil {
				t.Fatal("expired transaction signed")
			}
			if e := reopened.beginWENCampaignSigningV1("miner", artifact.RequestID, digest, prepared); e != nil {
				t.Fatal("signing guard", e)
			}
			if e := reopened.beginWENCampaignSigningV1("miner", artifact.RequestID, digest, prepared); e == nil {
				t.Fatal("signing replay")
			}
			if e := reopened.releaseWENCampaignReviewV1("miner", artifact.RequestID, digest, "cancelled"); e == nil {
				t.Fatal("signing released")
			}
			wrongSig := testSignature
			wrongSig[0] ^= 1
			if e := reopened.recordWENCampaignSignatureV1("miner", artifact.RequestID, digest, prepared, wrongSig.String()); e == nil {
				t.Fatal("invalid signature persisted")
			}
			if e := reopened.recordWENCampaignSignatureV1("miner", artifact.RequestID, digest, prepared, testSignature.String()); e != nil {
				t.Fatal("record signature", e)
			}
			changed = *prepared
			changed.message = append([]byte(nil), prepared.message...)
			changed.message[0] ^= 1
			if _, e := reopened.commitWENCampaignSubmissionV1("miner", artifact.RequestID, digest, &changed); e == nil {
				t.Fatal("altered message submitted")
			}
			wire, e := reopened.commitWENCampaignSubmissionV1("miner", artifact.RequestID, digest, prepared)
			if e != nil {
				t.Fatal("commit submission", e)
			}
			parsed, e := solana.TransactionFromBytes(wire)
			if e != nil {
				t.Fatal(e)
			}
			if e = parsed.VerifySignatures(); e != nil {
				t.Fatal(e)
			}
			testCampaignOutcomeV1(t, artifact, digest, testSignature, wire)
			if e = reopened.Close(); e != nil {
				t.Fatal(e)
			}
			reopened, e = openSignerStoreV2(path)
			if e != nil {
				t.Fatal(e)
			}
			defer reopened.Close()
			recovered, e = newSignerWebAuthnServiceV2(reopened, testWebAuthnRPID, testWebAuthnOrigin)
			if e != nil {
				t.Fatal(e)
			}
			if _, e = reopened.commitWENCampaignSubmissionV1("miner", artifact.RequestID, digest, prepared); e == nil {
				t.Fatal("submission replay")
			}
			if e = reopened.releaseWENCampaignReviewV1("miner", artifact.RequestID, digest, "cancelled"); e == nil {
				t.Fatal("uncertain transaction released")
			}
			// Real producer reservation after signature/restart must preserve
			// its original usage bucket beyond ordinary retention.
			retentionPath := filepath.Join(t.TempDir(), "retention.db")
			if e := reopened.db.View(func(tx *bolt.Tx) error { return tx.CopyFile(retentionPath, 0600) }); e != nil {
				t.Fatal(e)
			}
			retentionStore, e := openSignerStoreV2(retentionPath)
			if e != nil {
				t.Fatal(e)
			}
			defer retentionStore.Close()
			usageDay := currentDayBucket(reopened.now())
			future := reopened.now().Add(30 * 24 * time.Hour)
			retentionStore.now = func() time.Time { return future }
			if e := retentionStore.maintainStateV2(); e != nil {
				t.Fatal(e)
			}
			if e := retentionStore.db.View(func(tx *bolt.Tx) error {
				if string(tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2("miner", "solana:native", usageDay))) != want {
					t.Fatal("real pending campaign lost original usage")
				}
				return nil
			}); e != nil {
				t.Fatal(e)
			}
			// Restore only the fixture to exercise the independent revocation/release paths.
			if e := reopened.db.Update(func(tx *bolt.Tx) error {
				b := tx.Bucket(wenBudgetBucketV1)
				key := []byte("campaign-request:" + artifact.RequestID)
				var r wenCampaignReservationV1
				if e := json.Unmarshal(b.Get(key), &r); e != nil {
					return e
				}
				r.State = "reserved"
				r.Signature = ""
				raw, e := json.Marshal(r)
				if e != nil {
					return e
				}
				return b.Put(key, raw)
			}); e != nil {
				t.Fatal(e)
			}
			summary, e := recovered.credentialSummary()
			if e != nil {
				t.Fatal(e)
			}
			if _, e = recovered.revokeCredential(signerWebAuthnCredentialRevokeRequestV2{CredentialID: finish.CredentialID, ExpectedCount: summary.Count, ExpectedVersion: summary.Version, ConfirmLastCredential: true}); e != nil {
				t.Fatal(e)
			}
			if e = recovered.authorizeWENCampaignV1("miner", artifact.RequestID, digest, &finish.Authorization.Proof); e == nil {
				t.Fatal("revoked credential authorized reservation")
			}

			if e := reopened.beginWENCampaignSigningV1("miner", artifact.RequestID, digest, prepared); e == nil {
				t.Fatal("revoked signing authority")
			}

			testCampaignReleaseV1(t, reopened, artifact, digest, recovered, &finish.Authorization.Proof)

		})
	}
}
