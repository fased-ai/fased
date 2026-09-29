package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

type wenReconcileFixtureRPC struct {
	t          *testing.T
	chain      solana.Hash
	signature  solana.Signature
	result     *rpc.GetTransactionResult
	failure    string
	chainCalls int
}

func (m *wenReconcileFixtureRPC) GetGenesisHash(context.Context) (solana.Hash, error) {
	m.chainCalls++
	if m.failure == "chain" || m.failure == "chain-change" && m.chainCalls > 1 {
		return solana.Hash{99}, nil
	}
	return m.chain, nil
}
func (m *wenReconcileFixtureRPC) GetTransaction(_ context.Context, sig solana.Signature, opts *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if sig != m.signature || opts == nil || opts.Encoding != solana.EncodingBase64 || opts.Commitment != rpc.CommitmentFinalized || opts.MaxSupportedTransactionVersion == nil || *opts.MaxSupportedTransactionVersion != 0 {
		m.t.Fatal("unbound transaction query")
	}
	if m.failure == "missing" {
		return nil, rpc.ErrNotFound
	}
	if m.failure == "rpc-error" {
		return nil, errors.New("offline")
	}
	return m.result, nil
}
func (m *wenReconcileFixtureRPC) GetSlot(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		m.t.Fatal("unfinalized slot")
	}
	if m.failure == "future-slot" {
		return 149, nil
	}
	return 160, nil
}
func TestWENBTCFinalizedReconciliation(t *testing.T) {
	for _, name := range []string{"success", "failed", "missing", "rpc-error", "wrong-wire", "chain", "chain-change", "old-slot", "future-slot", "missing-meta", "conflict", "restart", "settle", "settle-missing-balances", "settle-token-change", "settle-underflow", "settle-custody", "settle-fee-excess", "token-effects", "pre-execution-slot"} {
		t.Run(name, func(t *testing.T) {
			s, r := wenStateFixture(t)
			pub, key, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			r.WalletPublicKey = solana.PublicKeyFromBytes(pub).String()
			if name == "pre-execution-slot" {
				r.MinExecutionSlot = 151
			}
			payer := solana.PublicKeyFromBytes(pub)
			transaction, err := solana.NewTransaction([]solana.Instruction{solana.NewInstruction(solana.SystemProgramID, nil, []byte{0})}, solana.Hash{1}, solana.TransactionPayer(payer))
			if err != nil {
				t.Fatal(err)
			}
			message, err := transaction.Message.MarshalBinary()
			if err != nil {
				t.Fatal(err)
			}
			if name == "token-effects" {
				for _, key := range transaction.Message.AccountKeys {
					r.AccountKeys = append(r.AccountKeys, key.String())
				}
			}
			r.MessageSHA256 = wenHashV1(message)
			r.State = "signing"
			if name == "settle-custody" {
				scope := "custody:" + r.Genesis + ":test-account:test-mint"
				r.Scopes[scope] = 100
				if err := s.configureWENBudgetV1(scope, 100); err != nil {
					t.Fatal(err)
				}
				if err := s.db.Update(func(tx *bolt.Tx) error {
					raw, _ := json.Marshal(wenBudgetBalanceV1{Limit: 100, Reserved: 100})
					return tx.Bucket(wenBudgetBucketV1).Put([]byte("limit:"+scope), raw)
				}); err != nil {
					t.Fatal(err)
				}
			}
			raw, err := json.Marshal(r)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(wenBudgetBucketV1).Put([]byte("request:state-request"), raw) }); err != nil {
				t.Fatal(err)
			}
			var sig solana.Signature
			copy(sig[:], ed25519.Sign(key, message))
			if err := s.recordWENSignatureV1("state-request", r.Digest, message, sig.String()); err != nil {
				t.Fatal(err)
			}
			wire, err := wenSignedWireV1(readWENState(t, s), message)
			if err != nil {
				t.Fatal(err)
			}
			if name == "wrong-wire" {
				wire[len(wire)-1] ^= 1
			}
			encoded, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
			envelope := &rpc.TransactionResultEnvelope{}
			if err := json.Unmarshal(encoded, envelope); err != nil {
				t.Fatal(err)
			}
			result := &rpc.GetTransactionResult{Slot: 150, Meta: &rpc.TransactionMeta{Fee: 5000}, Transaction: envelope}
			if name == "failed" || strings.HasPrefix(name, "settle") {
				result.Meta.Err = map[string]any{"InstructionError": []any{1, "Custom"}}
			}
			if strings.HasPrefix(name, "settle") {
				n := len(transaction.Message.AccountKeys)
				result.Meta.PreBalances = make([]uint64, n)
				result.Meta.PostBalances = make([]uint64, n)
				result.Meta.PreBalances[0] = 10000
				result.Meta.PostBalances[0] = 5000
				if name == "settle-fee-excess" {
					result.Meta.Fee = r.WalletClaims["solana:native"] + 1
					result.Meta.PreBalances[0] = result.Meta.Fee + 5000
				}
				if name == "settle-missing-balances" {
					result.Meta.PostBalances = nil
				}
				if name == "settle-token-change" {
					result.Meta.PostTokenBalances = []rpc.TokenBalance{{AccountIndex: 0}}
				}
			}
			if name == "token-effects" {
				n := len(transaction.Message.AccountKeys)
				result.Meta.PreBalances = make([]uint64, n)
				result.Meta.PostBalances = make([]uint64, n)
				result.Meta.PreBalances[0] = 10000
				result.Meta.PostBalances[0] = 5000
				owner, program := payer, solana.TokenProgramID
				result.Meta.PreTokenBalances = []rpc.TokenBalance{{AccountIndex: 1, Mint: solana.PublicKey{19}, Owner: &owner, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: "100", Decimals: 6}}}
				result.Meta.PostTokenBalances = []rpc.TokenBalance{{AccountIndex: 1, Mint: solana.PublicKey{19}, Owner: &owner, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: "60", Decimals: 6}}}
			}
			if name == "old-slot" {
				result.Slot = 99
			}
			if name == "missing-meta" {
				result.Meta = nil
			}
			chain, err := solana.HashFromBase58(r.Genesis)
			if err != nil {
				t.Fatal(err)
			}
			client := &wenReconcileFixtureRPC{t: t, chain: chain, signature: sig, result: result, failure: name}
			outcome, err := s.reconcileWENTransactionV1(context.Background(), client, "state-request", r.Digest)
			success := name == "token-effects" || name == "success" || name == "failed" || name == "conflict" || name == "restart" || strings.HasPrefix(name, "settle")
			if (err == nil) != (success || name == "missing") {
				t.Fatalf("reconcile error: %v", err)
			}
			want := "signed"
			if success {
				want = "finalized-success"
				if name == "failed" || strings.HasPrefix(name, "settle") {
					want = "finalized-failed"
				}
			}
			if err == nil && outcome != want {
				t.Fatal("wrong outcome", outcome, want)
			}
			if success {
				if name == "restart" {
					path := s.db.Path()
					if err := s.Close(); err != nil {
						t.Fatal(err)
					}
					reopened, err := openSignerStoreV2(path)
					if err != nil {
						t.Fatal(err)
					}
					defer reopened.Close()
					s = reopened
				}
				if name == "conflict" {
					result.Meta.Fee++
				}
				_, err := s.reconcileWENTransactionV1(context.Background(), client, "state-request", r.Digest)
				if (err == nil) != (name != "conflict") {
					t.Fatal("outcome replay", err)
				}
				if err := s.recordWENSignatureV1("state-request", r.Digest, message, sig.String()); err != nil {
					t.Fatal("signature replay after outcome", err)
				}
			}
			settled := false
			if strings.HasPrefix(name, "settle") {
				if name == "settle-underflow" {
					if err := s.db.Update(func(tx *bolt.Tx) error {
						return tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2(r.WalletID, "solana:native", r.UsageDay), []byte("0"))
					}); err != nil {
						t.Fatal(err)
					}
				}
				err := s.settleWENFailedBudgetV1("state-request", r.Digest)
				if (err == nil) != (name == "settle" || name == "settle-custody") {
					t.Fatalf("failure settlement: %v", err)
				}
				settled = err == nil
				if settled {
					if err := s.settleWENFailedBudgetV1("state-request", r.Digest); err != nil {
						t.Fatal("settlement retry", err)
					}
				}
			}
			saved := readWENState(t, s)
			if name == "token-effects" {
				if !wenReservationHashV1(saved.SuccessTokenEffectsSHA256) || len(saved.SuccessTokenEffects) != 1 || saved.SuccessTokenEffects[0].DeltaRaw != "-40" {
					t.Fatal("token evidence not persisted")
				}
			}
			if saved.State != want {
				t.Fatal("rejected observation changed state", saved.State)
			}
			if success && (saved.OutcomeSlot != 150 || saved.OutcomeFee != func() uint64 {
				if name == "settle-fee-excess" {
					return r.WalletClaims["solana:native"] + 1
				}
				return 5000
			}()) {
				t.Fatal("lost outcome receipt")
			}
			if !success && saved.OutcomeSlot != 0 {
				t.Fatal("uncertain result recorded as finalized")
			}
			for scope, amount := range r.Scopes {
				if settled {
					amount = 0
					if strings.HasSuffix(scope, ":sol") {
						amount = 5000
					}
				}
				got, err := s.wenBudgetReservedV1(scope)
				if err != nil || got != amount {
					t.Fatal("reconciliation released budget", got, err)
				}
			}
			if saved.FailedBudgetSettled != settled {
				t.Fatal("incorrect settlement marker")
			}
			if strings.HasPrefix(name, "settle") {
				day, err := time.Parse("2006-01-02", r.UsageDay)
				if err != nil {
					t.Fatal(err)
				}
				for asset, amount := range r.WalletClaims {
					if settled {
						amount = 0
						if asset == "solana:native" {
							amount = 5000
						}
					}
					if name == "settle-underflow" && asset == "solana:native" {
						amount = 0
					}
					used, err := s.dailyUsage(r.WalletID, asset, day)
					if err != nil || used.Uint64() != amount {
						t.Fatal("wrong settled daily usage", used, amount, err)
					}
				}
			}
			if err := s.cancelWENReservationV1("state-request", r.Digest); err == nil {
				t.Fatal("outcome incorrectly permits cancellation")
			}
		})
	}
}
