package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"os"
	"path/filepath"
	"testing"
)

// Uses protected disk review, real policy reservation and signing journal methods.
// Chain state and the externally supplied ephemeral signature remain test inputs.
func checkWithdrawalPreparedSubmission(t *testing.T, template *withdrawalPrepareFake, v signerWENWithdrawalIntentV1, review wenWithdrawalReviewV1, descriptor []byte, private ed25519.PrivateKey) {
	t.Helper()
	for _, mode := range []string{"ok", "review-change", "descriptor-change", "account-change", "fee-change", "policy-change", "expired"} {
		t.Run("submission/"+mode, func(t *testing.T) {
			must := func(e error) {
				t.Helper()
				if e != nil {
					t.Fatal(e)
				}
			}
			s, e := openSignerStoreV2(filepath.Join(t.TempDir(), "state.db"))
			must(e)
			defer func() { s.Close() }()
			w := solana.MustPublicKeyFromBase58(review.WalletPublicKey)
			ix, e := buildWENWithdrawalInstructionV1(v, w)
			must(e)
			policy, e := s.putWalletAndPolicy(signerWalletRecordV2{WalletID: "staker", PublicKey: w.String()}, signerPolicyV2{WalletID: "staker", Role: "agent", Operations: []string{intentWENWithdrawalV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "5000", MaxDaily: "5000"}}}, 0)
			must(e)
			scopes := []string{wenMiningNativeScopeV1("staker", v.Genesis), wenWithdrawalLaunchScopeV1("staker", v)}
			for _, scope := range scopes {
				must(s.configureWENBudgetV1(scope, 5000))
			}
			root := writeWithdrawalReviewFixture(t, s.db.Path(), review)
			path := filepath.Join(root, review.Pins.DescriptorSHA256)
			must(os.WriteFile(path, descriptor, 0600))
			base := *template.wenReadRPCFake
			page := *base.page
			page.Value = append([]*rpc.Account(nil), page.Value...)
			for i, a := range page.Value {
				if a != nil {
					copy := *a
					page.Value[i] = &copy
				}
			}
			base.page = &page
			base.calls = 0
			mining := *template.miningPrepareFake
			mining.wenReadRPCFake = &base
			mining.mode = "ok"
			client := &withdrawalPrepareFake{miningPrepareFake: &mining, descriptor: path}
			prepared, e := prepareReviewedWENWithdrawalV1(context.Background(), client, s.db.Path(), "staker", v)
			must(e)
			digest, replay, e := s.reservePreparedWENWithdrawalV1("state-request", "staker", policy.Hash, v, prepared)
			must(e)
			if replay {
				t.Fatal("initial replay")
			}
			bound := readWENState(t, s)
			if bound.WithdrawalPrepared == nil || bound.WithdrawalPrepared.Evidence == nil || bound.WithdrawalPrepared.Evidence.Pins.CodeSHA256 != review.Pins.CodeSHA256 || bound.WithdrawalPrepared.Evidence.Before.Slot != prepared.state.Slot {
				t.Fatal("prepared evidence not captured")
			}

			tx, e := solana.NewTransaction([]solana.Instruction{ix}, prepared.blockhash, solana.TransactionPayer(w))
			must(e)
			tx.Message.SetVersion(solana.MessageVersionV0)
			all, e := tx.Message.GetAllKeys()
			must(e)
			keys := []string{}
			for _, key := range all {
				keys = append(keys, key.String())
			}
			must(s.beginWENSigningAccountsV1("state-request", digest, wenHashV1(prepared.message), keys, prepared.slot))
			var sig solana.Signature
			copy(sig[:], ed25519.Sign(private, prepared.message))
			must(s.recordWENSignatureV1("state-request", digest, prepared.message, sig.String()))
			before := wenRestartRecord(t, s, "state-request")
			switch mode {
			case "review-change":
				review.MaxTotalCostLamports++
				writeWithdrawalReviewFixture(t, s.db.Path(), review)
			case "descriptor-change":
				must(os.WriteFile(path, []byte("{}"), 0600))
			case "account-change":
				data := append([]byte(nil), page.Value[4].Data.GetBinary()...)
				data[64] ^= 1
				page.Value[4].Data = rpc.DataBytesOrJSONFromBytes(data)
			case "policy-change":
				policy.Assets[0].MaxPerTx = "4000"
				_, e = s.putPolicy(policy, policy.Version)
				must(e)
			case "expired":
				client.mode = "expired"
			case "fee-change":
				client.mode = "fee"
			}
			client.fixture.Blockhash = v.Genesis // A new latest blockhash must not replace the journaled message.
			wire, e := s.prepareWENWithdrawalSubmissionV1(context.Background(), client, "state-request", digest)
			if mode == "ok" {
				must(e)
				expected, e := wenSignedWireV1(readWENState(t, s), prepared.message)
				must(e)
				if !bytes.Equal(wire, expected) || readWENState(t, s).State != "submission-uncertain" {
					t.Fatal("submission identity/state")
				}
				if _, e = s.prepareWENWithdrawalSubmissionV1(context.Background(), client, "state-request", digest); e == nil {
					t.Fatal("duplicate submission")
				}
			} else {
				if e == nil || len(wire) != 0 {
					t.Fatal("changed admission exposed wire")
				}
				if !bytes.Equal(before, wenRestartRecord(t, s, "state-request")) {
					t.Fatal("rejected submission mutated journal")
				}
			}

			want := uint64(5000)
			if mode == "ok" {
				m := &rpc.TransactionMeta{Fee: 4000}
				index := map[string]int{}
				for i, k := range all {
					index[k.String()] = i
					m.PreBalances = append(m.PreBalances, 10)
					m.PostBalances = append(m.PostBalances, 10)
				}
				m.PreBalances[0] = 10000
				m.PostBalances[0] = 6000
				mint := solana.MustPublicKeyFromBase58(v.Mint)
				program := solana.Token2022ProgramID
				pool := ix.Accounts()[3].PublicKey
				row := func(account string, owner *solana.PublicKey, amount string) rpc.TokenBalance {
					return rpc.TokenBalance{AccountIndex: uint16(index[account]), Mint: mint, Owner: owner, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: amount, Decimals: 11}}
				}
				m.PreTokenBalances = []rpc.TokenBalance{row(v.TokenAccount, &w, "200"), row(ix.Accounts()[5].PublicKey.String(), &pool, "110")}
				m.PostTokenBalances = []rpc.TokenBalance{row(v.TokenAccount, &w, "297"), row(ix.Accounts()[5].PublicKey.String(), &pool, "10")}
				encoded, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
				envelope := &rpc.TransactionResultEnvelope{}
				must(json.Unmarshal(encoded, envelope))
				receipt := &wenReconcileFixtureRPC{t: t, chain: solana.MustHashFromBase58(v.Genesis), signature: sig, result: &rpc.GetTransactionResult{Slot: 150, Meta: m, Transaction: envelope}}
				outcome, err := s.recoverWENWithdrawalExecutionV1(context.Background(), receipt, "state-request", digest)
				must(err)
				if outcome != "finalized-success" {
					t.Fatal(outcome)
				}
				want = 4000
				checkWithdrawalPoststate(t, s, client.wenReadRPCFake, "state-request", digest)
			}

			persisted := wenRestartRecord(t, s, "state-request")
			db := s.db.Path()
			must(s.Close())
			verifyWENFreshProcess(t, db, "state-request", persisted)
			s, e = openSignerStoreV2(db)
			must(e)
			if mode == "ok" {
				if _, e = s.prepareWENWithdrawalSubmissionV1(context.Background(), client, "state-request", digest); e == nil {
					t.Fatal("restart duplicate submission")
				}
			}
			for _, scope := range scopes {
				n, e := s.wenBudgetReservedV1(scope)
				must(e)
				if n != want {
					t.Fatal("submission released budget")
				}
			}
		})
	}
}
