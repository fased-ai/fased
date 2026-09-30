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
	"strconv"
	"testing"
	"time"
)

// Uses protected disk review, real policy reservation and signing journal methods.
// Chain state and the externally supplied ephemeral signature remain test inputs.
func checkStakingPreparedSubmission(t *testing.T, template *stakingPrepareFake, v signerWENStakingIntentV1, review wenStakingReviewV1, descriptor []byte, private ed25519.PrivateKey) {
	t.Helper()
	for _, mode := range []string{"ok", "review-change", "descriptor-change", "history-change", "fee-change"} {
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
			ix, e := buildWENStakingInstructionV1(v, w)
			must(e)
			policy, e := s.putWalletAndPolicy(signerWalletRecordV2{WalletID: "staker", PublicKey: w.String()}, signerPolicyV2{WalletID: "staker", Role: "agent", Operations: []string{intentWENStakingV1 + ".deposit"}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "7000", MaxDaily: "7000"}, {Asset: "solana:spl:" + v.Mint, Destinations: []string{ix.Accounts()[7].PublicKey.String()}, MaxPerTx: "100", MaxDaily: "100"}}}, 0)
			must(e)
			scopes := []string{wenMiningNativeScopeV1("staker", v.Genesis), wenStakingLaunchScopeV1("staker", v)}
			for _, scope := range scopes {
				must(s.configureWENBudgetV1(scope, 7000))
			}
			root := writeStakingReviewFixture(t, s.db.Path(), review)
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
			client := &stakingPrepareFake{miningPrepareFake: &mining, descriptor: path}
			prepared, e := prepareReviewedWENStakingV1(context.Background(), client, s.db.Path(), "staker", v)
			must(e)
			digest, replay, e := s.reservePreparedWENStakingV1("state-request", "staker", policy.Hash, v, prepared)
			must(e)
			if replay {
				t.Fatal("initial replay")
			}
			bound := readWENState(t, s)
			if bound.StakingPrepared == nil || bound.StakingPrepared.Evidence == nil || bound.StakingPrepared.Evidence.Pins.CodeSHA256 != review.Pins.CodeSHA256 || bound.StakingPrepared.Evidence.Before.Slot != prepared.state.History.Slot {
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
				writeStakingReviewFixture(t, s.db.Path(), review)
			case "descriptor-change":
				must(os.WriteFile(path, []byte("{}"), 0600))
			case "history-change":
				data := append([]byte(nil), page.Value[2].Data.GetBinary()...)
				data[96] ^= 1
				page.Value[2].Data = rpc.DataBytesOrJSONFromBytes(data)
			case "fee-change":
				client.mode = "fee"
			}
			client.fixture.Blockhash = v.Genesis // A new latest blockhash must not replace the journaled message.
			wire, e := s.prepareWENStakingSubmissionV1(context.Background(), client, "state-request", digest)
			if mode == "ok" {
				must(e)
				expected, e := wenSignedWireV1(readWENState(t, s), prepared.message)
				must(e)
				if !bytes.Equal(wire, expected) || readWENState(t, s).State != "submission-uncertain" {
					t.Fatal("submission identity/state")
				}
				if _, e = s.prepareWENStakingSubmissionV1(context.Background(), client, "state-request", digest); e == nil {
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

			want := uint64(7000)
			if mode == "ok" {
				// Synthetic successful receipt for the actual prepared and signed wire.
				meta := &rpc.TransactionMeta{Fee: 5000}
				index := map[string]int{}
				for i, key := range all {
					index[key.String()] = i
					meta.PreBalances = append(meta.PreBalances, 10)
					meta.PostBalances = append(meta.PostBalances, 10)
				}
				meta.PreBalances[0] = 10000
				meta.PostBalances[0] = 4000
				rentIndex := index[ix.Accounts()[6].PublicKey.String()]
				meta.PreBalances[rentIndex] = 0
				meta.PostBalances[rentIndex] = 1000
				program := solana.Token2022ProgramID
				mint := solana.MustPublicKeyFromBase58(v.Mint)
				pool := ix.Accounts()[3].PublicKey
				row := func(account string, owner *solana.PublicKey, amount uint64) rpc.TokenBalance {
					return rpc.TokenBalance{AccountIndex: uint16(index[account]), Mint: mint, Owner: owner, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: strconv.FormatUint(amount, 10), Decimals: 11}}
				}
				meta.PreTokenBalances = []rpc.TokenBalance{row(v.TokenAccount, &w, 200), row(ix.Accounts()[7].PublicKey.String(), &pool, 10)}
				meta.PostTokenBalances = []rpc.TokenBalance{row(v.TokenAccount, &w, 100), row(ix.Accounts()[7].PublicKey.String(), &pool, 107)}
				encoded, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
				envelope := &rpc.TransactionResultEnvelope{}
				must(json.Unmarshal(encoded, envelope))
				receipt := &wenReconcileFixtureRPC{t: t, chain: solana.MustHashFromBase58(v.Genesis), signature: sig, result: &rpc.GetTransactionResult{Slot: 150, Meta: meta, Transaction: envelope}}
				restart := func() {
					raw := wenRestartRecord(t, s, "state-request")
					db := s.db.Path()
					must(s.Close())
					verifyWENFreshProcess(t, db, "state-request", raw)
					s, e = openSignerStoreV2(db)
					must(e)
				}
				restart()
				for i := 0; i < 2; i++ {
					state, e := s.reconcileWENTransactionV1(context.Background(), receipt, "state-request", digest)
					must(e)
					if state != "finalized-success" {
						t.Fatal(state)
					}
					must(s.settleWENStakingSuccessV1("state-request", digest))
					if i == 0 {
						restart()
					}
				}
				want = 6000
				day, e := time.Parse("2006-01-02", readWENState(t, s).UsageDay)
				must(e)
				for asset, amount := range map[string]uint64{"solana:native": 6000, "solana:spl:" + v.Mint: 100} {
					n, e := s.dailyUsage("staker", asset, day)
					must(e)
					if n.Uint64() != amount {
						t.Fatal("settled usage", asset, n)
					}
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
