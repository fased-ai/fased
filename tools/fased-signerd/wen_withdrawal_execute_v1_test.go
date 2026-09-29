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

type withdrawalExecuteFake struct {
	*withdrawalPrepareFake
	store   *signerStoreV2
	sends   int
	result  *rpc.GetTransactionResult
	sig     solana.Signature
	failure string
}

func (f *withdrawalExecuteFake) SendRawTransactionWithOpts(_ context.Context, wire []byte, o rpc.TransactionOpts) (solana.Signature, error) {
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
	if f.failure == "wrong-signature" {
		return solana.Signature{1}, nil
	}
	if f.failure == "missing" {
		return f.sig, errors.New("uncertain transport")
	}
	meta := &rpc.TransactionMeta{Fee: 4000}
	for range tx.Message.AccountKeys {
		meta.PreBalances = append(meta.PreBalances, 10)
		meta.PostBalances = append(meta.PostBalances, 10)
	}
	meta.PreBalances[0] = 10000
	meta.PostBalances[0] = 6000
	// A reverted instruction has no token/rent effects and retains only its fee.
	meta.Err = "synthetic instruction failure"
	if f.failure == "success" || f.failure == "error-confirmed" {
		meta.Err = nil
		meta.PostBalances[0] = 6000
		w := tx.Message.AccountKeys[0]
		ix, e := buildWENWithdrawalInstructionV1(*r.WithdrawalIntent, w)
		if e != nil {
			f.t.Fatal(e)
		}
		indices := map[string]uint16{}
		for i, key := range tx.Message.AccountKeys {
			indices[key.String()] = uint16(i)
		}
		mint := solana.MustPublicKeyFromBase58(r.WithdrawalIntent.Mint)
		pool := ix.Accounts()[3].PublicKey
		program := solana.Token2022ProgramID
		row := func(account string, owner *solana.PublicKey, amount string) rpc.TokenBalance {
			return rpc.TokenBalance{AccountIndex: indices[account], Mint: mint, Owner: owner, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: amount, Decimals: 11}}
		}
		meta.PreTokenBalances = []rpc.TokenBalance{row(r.WithdrawalIntent.TokenAccount, &w, "200"), row(ix.Accounts()[5].PublicKey.String(), &pool, "110")}
		meta.PostTokenBalances = []rpc.TokenBalance{row(r.WithdrawalIntent.TokenAccount, &w, "297"), row(ix.Accounts()[5].PublicKey.String(), &pool, "10")}

	}

	encoded, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	envelope := &rpc.TransactionResultEnvelope{}
	if e = json.Unmarshal(encoded, envelope); e != nil {
		f.t.Fatal(e)
	}
	f.result = &rpc.GetTransactionResult{Slot: 150, Meta: meta, Transaction: envelope}
	if f.failure == "error-confirmed" {
		return f.sig, errors.New("lost response after acceptance")
	}
	return f.sig, nil
}
func (f *withdrawalExecuteFake) GetTransaction(_ context.Context, sig solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if sig != f.sig || o.Commitment != rpc.CommitmentFinalized {
		f.t.Fatal("unbound recovery")
	}
	if f.result == nil {
		return nil, rpc.ErrNotFound
	}
	return f.result, nil
}
func checkWithdrawalExecutor(t *testing.T, template *withdrawalPrepareFake, v signerWENWithdrawalIntentV1, review wenWithdrawalReviewV1, descriptor []byte, private ed25519.PrivateKey) {
	t.Helper()
	{
		for _, mode := range []string{"success", "failed", "missing", "wrong-signature", "error-confirmed"} {
			t.Run("executor/"+mode, func(t *testing.T) {
				v, review := v, review
				review.Intent = v
				must := func(e error) {
					t.Helper()
					if e != nil {
						t.Fatal(e)
					}
				}
				s, k := openTestSignerV2(t)
				w := solana.MustPublicKeyFromBase58(review.WalletPublicKey)
				ix, e := buildWENWithdrawalInstructionV1(v, w)
				must(e)
				input := signerPolicyV2{WalletID: "staker", Role: "agent", Operations: []string{intentWENWithdrawalV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "5000", MaxDaily: "5000"}}}
				_, policy, e := k.storeNewKeyWithPolicy("staker", solana.PrivateKey(private), input, 0)
				must(e)
				scopes := []string{wenMiningNativeScopeV1("staker", v.Genesis), wenWithdrawalLaunchScopeV1("staker", v)}
				for _, scope := range scopes {
					must(s.configureWENBudgetV1(scope, 5000))
				}
				root := writeWithdrawalReviewFixture(t, s.db.Path(), review)
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

				c := &withdrawalExecuteFake{withdrawalPrepareFake: &withdrawalPrepareFake{miningPrepareFake: &mining, descriptor: path}, store: s, failure: mode}
				service := &signerServiceV2{store: s, keys: k}
				if mode == "success" {
					k.genesisHash = func(string) (string, error) { return v.Genesis, nil }
					_, err := k.PutNetworkV2("staker", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: "https://fixture.invalid/withdrawal"})
					must(err)
					cfg := signerConfig{stateDBPath: s.db.Path(), chains: []string{"solana"}}
					wrongConfig := cfg
					wrongConfig.stateDBPath += ".wrong"
					if _, err := service.prepareConfiguredWithdrawalWithFactoryV1(context.Background(), wrongConfig, "staker", v, func(string) wenMiningPrepareRPCV1 {
						t.Fatal("mismatched store must fail before RPC")
						return c
					}); err == nil {
						t.Fatal("mismatched store accepted")
					}
					preview, err := service.prepareConfiguredWithdrawalWithFactoryV1(context.Background(), cfg, "staker", v, func(endpoint string) wenMiningPrepareRPCV1 {
						if endpoint != "https://fixture.invalid/withdrawal" {
							t.Fatal("unconfigured endpoint")
						}
						return c
					})
					must(err)
					if preview.SigningEnabled || preview.Operation != "withdraw" || preview.DescriptorSHA256 != v.DescriptorSHA256 || preview.NetworkFee != 5000 || c.sends != 0 {
						t.Fatal("configured unsigned withdrawal preview", preview)
					}
				}

				digest, state, e := service.executeWENWithdrawalWithRPCV1(context.Background(), c, "state-request", "staker", policy.Hash, v)
				if digest == "" || c.sends != 1 {
					t.Fatal("execution did not journal/send", state, e)
				}
				want := uint64(5000)
				if mode == "success" || mode == "error-confirmed" {
					must(e)
					if state != "finalized-success" {
						t.Fatal(state)
					}
					want = 4000
				} else if mode == "failed" {
					must(e)
					if state != "finalized-failed" {
						t.Fatal(state)
					}
					want = 4000
				} else {
					if e == nil || state != "submission-uncertain" {
						t.Fatal("transport uncertainty", state, e)
					}
				}
				// Existing identity cannot cause a second signature/send; use recovery only.
				if _, _, e = service.executeWENWithdrawalWithRPCV1(context.Background(), c, "state-request", "staker", policy.Hash, v); e == nil {
					t.Fatal("reexecuted")
				}
				if state == "finalized-success" {
					checkWithdrawalPoststate(t, s, c.wenReadRPCFake, "state-request", digest)
				}
				persisted := wenRestartRecord(t, s, "state-request")
				db := s.db.Path()
				must(s.Close())
				verifyWENFreshProcess(t, db, "state-request", persisted)
				s, e = openSignerStoreV2(db)
				must(e)
				defer s.Close()
				c.store = s
				for i := 0; i < 2; i++ {
					got, e := s.recoverWENWithdrawalExecutionV1(context.Background(), c, "state-request", digest)
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
				expected := uint64(0)
				if n.Uint64() != expected {
					t.Fatal("principal usage", n)
				}

			})
		}
	}
}
