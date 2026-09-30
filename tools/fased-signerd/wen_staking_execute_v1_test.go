package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"os"
	"path/filepath"
	"testing"
)

type stakingExecuteFake struct {
	*stakingPrepareFake
	store   *signerStoreV2
	sends   int
	result  *rpc.GetTransactionResult
	sig     solana.Signature
	failure string
}

func (f *stakingExecuteFake) SendRawTransactionWithOpts(_ context.Context, wire []byte, o rpc.TransactionOpts) (solana.Signature, error) {
	f.sends++
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		return solana.Signature{}, e
	}
	if e = tx.VerifySignatures(); e != nil {
		f.t.Fatal(e)
	}
	r := readWENState(f.t, f.store)
	if r.State != "submission-uncertain" || o.SkipPreflight || o.PreflightCommitment != rpc.CommitmentFinalized || o.MaxRetries == nil || *o.MaxRetries != 0 || o.MinContextSlot == nil || *o.MinContextSlot != 150 {
		f.t.Fatal("unfenced send")
	}
	f.sig = tx.Signatures[0]
	if f.failure == "missing" || f.failure == "send-error" {
		return f.sig, errors.New("uncertain transport")
	}
	meta := &rpc.TransactionMeta{Fee: 5000}
	for range tx.Message.AccountKeys {
		meta.PreBalances = append(meta.PreBalances, 10)
		meta.PostBalances = append(meta.PostBalances, 10)
	}
	meta.PreBalances[0] = 10000
	meta.PostBalances[0] = 5000
	// A reverted instruction has no token/rent effects and retains only its fee.
	meta.Err = "synthetic instruction failure"
	if f.failure == "success" {
		meta.Err = nil
		meta.PostBalances[0] = 4000
		w := tx.Message.AccountKeys[0]
		ix, e := buildWENStakingInstructionV1(*r.StakingIntent, w)
		if e != nil {
			f.t.Fatal(e)
		}
		indices := map[string]uint16{}
		for i, key := range tx.Message.AccountKeys {
			indices[key.String()] = uint16(i)
		}
		rent := indices[ix.Accounts()[6].PublicKey.String()]
		meta.PreBalances[rent] = 0
		meta.PostBalances[rent] = 1000
		mint := solana.MustPublicKeyFromBase58(r.StakingIntent.Mint)
		pool := ix.Accounts()[3].PublicKey
		program := solana.Token2022ProgramID
		row := func(account string, owner *solana.PublicKey, amount string) rpc.TokenBalance {
			return rpc.TokenBalance{AccountIndex: indices[account], Mint: mint, Owner: owner, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: amount, Decimals: 11}}
		}
		meta.PreTokenBalances = []rpc.TokenBalance{row(r.StakingIntent.TokenAccount, &w, "200"), row(ix.Accounts()[7].PublicKey.String(), &pool, "10")}
		meta.PostTokenBalances = []rpc.TokenBalance{row(r.StakingIntent.TokenAccount, &w, "100"), row(ix.Accounts()[7].PublicKey.String(), &pool, "107")}
		if r.StakingIntent.Operation == "requestExit" {
			meta.PostTokenBalances = meta.PreTokenBalances
		}
	}

	encoded, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	envelope := &rpc.TransactionResultEnvelope{}
	if e = json.Unmarshal(encoded, envelope); e != nil {
		f.t.Fatal(e)
	}
	f.result = &rpc.GetTransactionResult{Slot: 150, Meta: meta, Transaction: envelope}
	return f.sig, nil
}
func (f *stakingExecuteFake) GetTransaction(_ context.Context, sig solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if sig != f.sig || o.Commitment != rpc.CommitmentFinalized {
		f.t.Fatal("unbound recovery")
	}
	if f.result == nil {
		return nil, rpc.ErrNotFound
	}
	return f.result, nil
}
func checkStakingExecutor(t *testing.T, template *stakingPrepareFake, v signerWENStakingIntentV1, review wenStakingReviewV1, descriptor []byte, private ed25519.PrivateKey) {
	t.Helper()
	for _, operation := range []string{"deposit", "requestExit"} {
		for _, mode := range []string{"success", "failed", "missing"} {
			t.Run("executor/"+operation+"/"+mode, func(t *testing.T) {
				v, review := v, review
				v.Operation = operation
				if operation == "requestExit" {
					v.Amount = "0"
				}
				review.Intent = v
				must := func(e error) {
					t.Helper()
					if e != nil {
						t.Fatal(e)
					}
				}
				s, k := openTestSignerV2(t)
				w := solana.MustPublicKeyFromBase58(review.WalletPublicKey)
				ix, e := buildWENStakingInstructionV1(v, w)
				must(e)
				input := signerPolicyV2{WalletID: "staker", Role: "agent", Operations: []string{intentWENStakingV1 + "." + operation}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "7000", MaxDaily: "7000"}, {Asset: "solana:spl:" + v.Mint, Destinations: []string{ix.Accounts()[7].PublicKey.String()}, MaxPerTx: "100", MaxDaily: "100"}}}
				if operation == "requestExit" {
					input.Assets = input.Assets[:1]
				}
				_, policy, e := k.storeNewKeyWithPolicy("staker", solana.PrivateKey(private), input, 0)
				must(e)
				scopes := []string{wenMiningNativeScopeV1("staker", v.Genesis), wenStakingLaunchScopeV1("staker", v)}
				for _, scope := range scopes {
					must(s.configureWENBudgetV1(scope, 7000))
				}
				root := writeStakingReviewFixture(t, s.db.Path(), review)
				path := filepath.Join(root, review.Pins.DescriptorSHA256)
				must(os.WriteFile(path, descriptor, 0600))
				base := *template.wenReadRPCFake
				base.calls = 0
				mining := *template.miningPrepareFake
				mining.wenReadRPCFake = &base
				mining.mode = "ok"
				transaction, e := solana.NewTransaction([]solana.Instruction{ix}, solana.MustHashFromBase58(mining.fixture.Blockhash), solana.TransactionPayer(w))
				must(e)
				transaction.Message.SetVersion(solana.MessageVersionV0)
				message, e := transaction.Message.MarshalBinary()
				must(e)
				mining.fixture.Messages = [][]byte{message}

				c := &stakingExecuteFake{stakingPrepareFake: &stakingPrepareFake{miningPrepareFake: &mining, descriptor: path}, store: s, failure: mode}
				service := &signerServiceV2{store: s, keys: k}
				digest, state, e := service.executeWENStakingWithRPCV1(context.Background(), c, "state-request", "staker", policy.Hash, v)
				if digest == "" || c.sends != 1 {
					t.Fatal("execution did not journal/send", state, e)
				}
				if operation == "requestExit" {
					r := readWENState(t, s)
					if len(r.WalletClaims) != 1 || r.WalletClaims["solana:native"] != 7000 {
						t.Fatal("exit reserved principal")
					}
				}
				want := uint64(7000)
				if mode == "success" {
					must(e)
					if state != "finalized-success" {
						t.Fatal(state)
					}
					want = 6000
				} else if mode == "failed" {
					must(e)
					if state != "finalized-failed" {
						t.Fatal(state)
					}
					want = 5000
				} else {
					if e == nil || state != "submission-uncertain" {
						t.Fatal("transport uncertainty", state, e)
					}
				}
				// Existing identity cannot cause a second signature/send; use recovery only.
				if _, _, e = service.executeWENStakingWithRPCV1(context.Background(), c, "state-request", "staker", policy.Hash, v); e == nil {
					t.Fatal("reexecuted")
				}
				for i := 0; i < 2; i++ {
					got, e := s.recoverWENStakingExecutionV1(context.Background(), c, "state-request", digest)
					must(e)
					if got != state {
						t.Fatal(got)
					}
				}
				if c.sends != 1 {
					t.Fatal("recovery resent")
				}
				for _, scope := range scopes {
					n, e := s.wenBudgetReservedV1(scope)
					must(e)
					if n != want {
						t.Fatal("wrong capacity", n, want)
					}
				}
				n, e := s.dailyUsage("staker", "solana:spl:"+v.Mint, s.now())
				must(e)
				expected := uint64(100)
				if mode == "failed" || operation == "requestExit" {
					expected = 0
				}
				if n.Uint64() != expected {
					t.Fatal("principal usage", n)
				}
				checkStakingExecutionObservation(t, s, c, digest, state)
			})
		}
	}
}
