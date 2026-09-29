package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

type wenAdmissionHookRPC struct {
	signerWENBTCSimulationRPCV1
	afterSimulation func()
}

func (c wenAdmissionHookRPC) SimulateRawTransactionWithOpts(ctx context.Context, raw []byte, opts *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	result, err := c.signerWENBTCSimulationRPCV1.SimulateRawTransactionWithOpts(ctx, raw, opts)
	if c.afterSimulation != nil {
		c.afterSimulation()
	}
	return result, err
}
func TestWENBTCExecutionAdmission(t *testing.T) {
	for _, operation := range []string{"acceptance", "acquisition"} {
		for _, name := range []string{"valid", "simulation-error", "policy-denied", "missing-budget", "review-change", "revalidate", "revalidate-stale", "revalidate-lookup", "revalidate-expiry", "revalidate-policy", "revalidate-review", "revalidate-message", "revalidate-post", "revalidate-post-expiry", "revalidate-post-policy", "execute-success", "execute-failed", "execute-send-error", "execute-missing", "execute-wrong-signature", "execute-bad-funding", "execute-expiry", "execute-missing-recovery", "execute-missing-recovery-failed", "execute-missing-recovery-unproved"} {
			t.Run(operation+"/"+name, func(t *testing.T) {
				mutation := ""
				if name == "simulation-error" {
					mutation = name
				}
				service, cfg, review, _ := wenJoinedServiceCase(t, operation, mutation)
				s := service.store
				intent := review.Intent
				wallet := solana.MustPublicKeyFromBase58(review.WalletPublicKey)
				root, _, _, err := loadWENBTCReviewV1(cfg.stateDBPath, "buyer", intent)
				if err != nil {
					t.Fatal(err)
				}
				now := uint64(time.Now().Unix())
				min, _ := strconv.ParseUint(intent.MinFinalizedSlot, 10, 64)
				load := loadWENBTCAcceptanceV1
				if operation == "acquisition" {
					load = loadWENBTCAcquisitionV1
				}
				a, err := load(root, review.Pins, intent, wallet, min, now)
				if err != nil {
					t.Fatal(err)
				}
				e, err := wenBTCExposureV1(a, intent, wallet)
				if err != nil {
					t.Fatal(err)
				}
				previous, err := s.getPolicy("buyer")
				if err != nil {
					t.Fatal(err)
				}
				p := signerPolicyV2{WalletID: "buyer", Role: "agent", Operations: []string{intentWENBTCSubscriptionV1 + "." + operation}, Programs: []string{a.program.String(), solana.TokenProgramID.String()}}
				if operation == "acquisition" {
					p.Programs = append(p.Programs, a.keys[5].String())
				}
				claims := map[string]uint64{"solana:native": e.NativeLamports}
				if e.WalletCashRaw > 0 {
					claims["solana:spl:"+e.CashMint.String()] = e.WalletCashRaw
				}
				for asset, amount := range claims {
					n := strconv.FormatUint(amount, 10)
					p.Assets = append(p.Assets, signerPolicyAssetV2{Asset: asset, Destinations: []string{a.keys[0].String()}, MaxPerTx: n, MaxDaily: n})
				}
				if name == "policy-denied" {
					p.Operations = []string{"unrelated"}
				}
				p, err = s.putPolicy(p, previous.Version)
				if err != nil {
					t.Fatal(err)
				}
				scopes := wenBudgetScopesV1("buyer", intent, e)
				if name != "missing-budget" {
					for scope, amount := range scopes {
						if err := s.configureWENBudgetV1(scope, amount); err != nil {
							t.Fatal(err)
						}
					}
				}
				urls, err := service.keys.SolanaRPCURLsV2("buyer")
				if err != nil || len(urls) == 0 {
					t.Fatal("fixture RPC", err)
				}
				var client signerWENBTCSimulationRPCV1 = newSignerOwnedSolanaRPCClientV2(urls[0])
				if name == "review-change" {
					client = wenAdmissionHookRPC{signerWENBTCSimulationRPCV1: client, afterSimulation: func() { changed := review; changed.MaxSlotLag++; writeWENReviewTest(t, root, changed) }}
				}
				if strings.HasPrefix(name, "execute-") {
					execution := &wenExecutionFixtureRPC{signerWENBTCSimulationRPCV1: client, t: t, store: s, failure: name}
					outcome, err := service.executeWENBTCWithRPCV1(context.Background(), execution, "execute-request", "buyer", p.Hash, intent, wallet, now)
					want := "finalized-success"
					if name == "execute-failed" {
						want = "finalized-failed"
					}
					if name == "execute-missing" || strings.HasPrefix(name, "execute-missing-recovery") || name == "execute-wrong-signature" {
						want = "submission-uncertain"
					}
					if name == "execute-expiry" {
						want = ""
					}
					wantError := name == "execute-wrong-signature" || name == "execute-bad-funding" || name == "execute-expiry"
					if outcome != want || (err != nil) != wantError {
						t.Fatalf("execution outcome %s err %v", outcome, err)
					}
					state := execution.read()
					settled := name == "execute-success" || name == "execute-send-error" || name == "execute-failed"
					if (state.SuccessBudgetSettled || state.FailedBudgetSettled) != settled {
						t.Fatal("execution settlement state")
					}
					expectedSends := 1
					if name == "execute-expiry" {
						expectedSends = 0
						if state.Signature != "" {
							t.Fatal("expired path signed")
						}
					}
					if execution.sendCount != expectedSends {
						t.Fatal("wrong send count")
					}
					if _, err := service.executeWENBTCWithRPCV1(context.Background(), execution, "execute-request", "buyer", p.Hash, intent, wallet, now); err == nil {
						t.Fatal("execution replay accepted")
					}
					if execution.sendCount != expectedSends {
						t.Fatal("execution replay sent again")
					}
					for scope, amount := range scopes {
						if settled {
							if strings.HasSuffix(scope, ":sol") {
								amount = state.SuccessNativeDebit
								if name == "execute-failed" {
									amount = state.OutcomeFee
								}
							} else if name == "execute-failed" {
								amount = 0
							}
						}
						got, err := s.wenBudgetReservedV1(scope)
						if err != nil || got != amount {
							t.Fatal("execution budget", got, amount, err)
						}
					}
					if strings.HasPrefix(name, "execute-missing-recovery") {
						path := s.db.Path()
						if err := s.Close(); err != nil {
							t.Fatal(err)
						}
						reopened, err := openSignerStoreV2(path)
						if err != nil {
							t.Fatal(err)
						}
						defer reopened.Close()
						execution.store = reopened
						// First recovery still has no receipt: retain every reservation.
						recovered, err := reopened.recoverWENExecutionV1(context.Background(), execution, "execute-request", state.Digest)
						if err != nil || recovered != "submission-uncertain" {
							t.Fatal("missing recovery", recovered, err)
						}
						if execution.read().SuccessBudgetSettled || execution.read().FailedBudgetSettled {
							t.Fatal("missing receipt released budget")
						}
						execution.failure = "execute-success"
						wantRecovery := "finalized-success"
						if name == "execute-missing-recovery-failed" {
							wantRecovery = "finalized-failed"
							execution.result.Meta.Err = map[string]any{"InstructionError": []any{1, "Custom"}}
							execution.result.Meta.PostBalances = append([]uint64(nil), execution.result.Meta.PreBalances...)
							execution.result.Meta.PostBalances[0] -= execution.result.Meta.Fee
							execution.result.Meta.PostTokenBalances = execution.result.Meta.PreTokenBalances
						}
						unproved := name == "execute-missing-recovery-unproved"
						if unproved {
							execution.result.Meta.PostTokenBalances[0].UiTokenAmount.Amount = "1"
						}
						// Retry proves settlement idempotency after actual DB reopening.
						for attempt := 0; attempt < 2; attempt++ {
							recovered, err = reopened.recoverWENExecutionV1(context.Background(), execution, "execute-request", state.Digest)
							if recovered != wantRecovery || (err != nil) != unproved {
								t.Fatal("recovery outcome", recovered, err)
							}
							saved := execution.read()
							if (saved.SuccessBudgetSettled || saved.FailedBudgetSettled) == unproved || execution.sendCount != 1 || saved.Signature != state.Signature {
								t.Fatal("recovery resent or incorrect settlement")
							}
							for scope, amount := range scopes {
								if !unproved {
									if strings.HasSuffix(scope, ":sol") {
										amount = saved.SuccessNativeDebit
										if wantRecovery == "finalized-failed" {
											amount = saved.OutcomeFee
										}
									} else if wantRecovery == "finalized-failed" {
										amount = 0
									}
								}
								got, err := reopened.wenBudgetReservedV1(scope)
								if err != nil || got != amount {
									t.Fatal("recovery budget", got, amount, err)
								}
							}
						}
					}
					return
				}
				out, err := s.admitWENBTCExecutionV1(context.Background(), client, "admission-request", "buyer", p.Hash, intent, wallet, now)
				if (err == nil) != (name == "valid" || strings.HasPrefix(name, "revalidate")) {
					t.Fatalf("unexpected admission: %v", err)
				}
				var saved wenBudgetReservationV1
				var exists bool
				if err := s.db.View(func(tx *bolt.Tx) error {
					b := tx.Bucket(wenBudgetBucketV1)
					if b == nil {
						return nil
					}
					raw := b.Get([]byte("request:admission-request"))
					exists = raw != nil
					if exists {
						return json.Unmarshal(raw, &saved)
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				if name == "valid" || strings.HasPrefix(name, "revalidate") {
					if !reflect.DeepEqual(saved.AccountKeys, out.prepared.accountKeys) || len(saved.AccountKeys) == 0 {
						t.Fatal("missing admitted account order")
					}
					if !exists || saved.State != "signing" || saved.MessageSHA256 != wenHashV1(out.prepared.message) || saved.Digest != out.reservationDigest || out.simulation.units == 0 {
						t.Fatal("admission lost simulated message or reservation")
					}
					if strings.HasPrefix(name, "revalidate-post") {
						key, _, err := service.keys.privateKey("buyer")
						if err != nil {
							t.Fatal(err)
						}
						signature, err := key.Sign(out.prepared.message)
						if err != nil {
							t.Fatal(err)
						}
						if err := s.recordWENSignatureV1("admission-request", out.reservationDigest, out.prepared.message, signature.String()); err != nil {
							t.Fatal(err)
						}
						failure := ""
						if name == "revalidate-post-expiry" {
							failure = "revalidate-expiry"
						}
						if name == "revalidate-post-policy" {
							if err := s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(bucketSignerPoliciesV2).Delete([]byte("buyer")) }); err != nil {
								t.Fatal(err)
							}
						}
						freshClient := wenRevalidateFixtureRPC{signerWENBTCPrepareRPCV1: client, failure: failure, t: t}
						wire, err := s.prepareWENSubmissionV1(context.Background(), freshClient, out, now)
						if (err == nil) != (name == "revalidate-post") {
							t.Fatalf("post-sign submission: %v", err)
						}
						if name == "revalidate-post" {
							if len(wire) != 65+len(out.prepared.message) || wire[0] != 1 || !bytes.Equal(wire[1:65], signature[:]) || !bytes.Equal(wire[65:], out.prepared.message) {
								t.Fatal("submission wire differs from signature journal")
							}
							originalTime := s.now()
							path := s.db.Path()
							if err := s.Close(); err != nil {
								t.Fatal(err)
							}
							reopened, err := openSignerStoreV2(path)
							if err != nil {
								t.Fatal(err)
							}
							defer reopened.Close()
							reopened.now = func() time.Time { return originalTime }
							s = reopened
							if err := s.recordWENSignatureV1("admission-request", out.reservationDigest, out.prepared.message, signature.String()); err != nil {
								t.Fatal("uncertain signature replay after restart", err)
							}
							if _, err := s.prepareWENSubmissionV1(context.Background(), freshClient, out, now); err == nil {
								t.Fatal("submission replay admitted")
							}
						} else if wire != nil {
							t.Fatal("failed submission returned bytes")
						}
						var state wenBudgetReservationV1
						if err := s.db.View(func(tx *bolt.Tx) error {
							return json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("request:admission-request")), &state)
						}); err != nil {
							t.Fatal(err)
						}
						want := "signed"
						if name == "revalidate-post" {
							want = "submission-uncertain"
						}
						if state.State != want {
							t.Fatal("wrong submission state", state.State)
						}

					} else if strings.HasPrefix(name, "revalidate") {
						freshClient := wenRevalidateFixtureRPC{signerWENBTCPrepareRPCV1: client, failure: name, t: t}
						if name == "revalidate-policy" {
							if err := s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(bucketSignerPoliciesV2).Delete([]byte("buyer")) }); err != nil {
								t.Fatal(err)
							}
						}
						if name == "revalidate-review" {
							changed := review
							changed.MaxSlotLag++
							writeWENReviewTest(t, root, changed)
						}
						if name == "revalidate-message" {
							out.prepared.message[0] ^= 1
						}
						message, err := s.revalidateWENExecutionV1(context.Background(), freshClient, out, now)
						if (err == nil) != (name == "revalidate") {
							t.Fatalf("revalidation result: %v", err)
						}
						if name == "revalidate" && !bytes.Equal(message, out.prepared.message) {
							t.Fatal("revalidation replaced admitted message")
						}
					}
					if _, err := s.admitWENBTCExecutionV1(context.Background(), client, "admission-request", "buyer", p.Hash, intent, wallet, now); err == nil {
						t.Fatal("admission replay crossed fence")
					}
					if err := s.cancelWENReservationV1("admission-request", saved.Digest); err == nil {
						t.Fatal("admitted message reservation released")
					}
				} else if exists || out != nil {
					t.Fatal("failed admission produced reservation or ticket")
				}
				for asset, amount := range claims {
					if name != "valid" && !strings.HasPrefix(name, "revalidate") {
						amount = 0
					}
					used, err := s.dailyUsage("buyer", asset, s.now())
					if err != nil || used.Uint64() != amount {
						t.Fatalf("shared usage %v want %d: %v", used, amount, err)
					}
				}
				if name != "missing-budget" {
					for scope, amount := range scopes {
						if name != "valid" && !strings.HasPrefix(name, "revalidate") {
							amount = 0
						}
						used, err := s.wenBudgetReservedV1(scope)
						if err != nil || used != amount {
							t.Fatalf("scope %d want %d: %v", used, amount, err)
						}
					}
				}
			})
		}
	}
}

// Advance the original fixture to a later finalized observation without changing
// its accounts. Explicitly check the new lookup minimum before delegating to the
// first-read fixture, whose expected minimum is 151.
type wenRevalidateFixtureRPC struct {
	signerWENBTCPrepareRPCV1
	failure string
	t       *testing.T
}

func (c wenRevalidateFixtureRPC) GetMultipleAccountsWithOpts(ctx context.Context, keys []solana.PublicKey, opts *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	copied := *opts
	if len(keys) == 1 {
		if opts.MinContextSlot == nil || *opts.MinContextSlot != 155 {
			c.t.Fatal("revalidation lookup minimum")
		}
		n := uint64(151)
		copied.MinContextSlot = &n
	}
	result, err := c.signerWENBTCPrepareRPCV1.GetMultipleAccountsWithOpts(ctx, keys, &copied)
	if err != nil || result == nil {
		return result, err
	}
	result.Context.Slot = 155
	if len(keys) == 1 {
		result.Context.Slot = 155
		if c.failure == "revalidate-lookup" {
			raw := append([]byte(nil), result.Value[0].Data.GetBinary()...)
			raw[len(raw)-1] ^= 1
			result.Value[0].Data = rpc.DataBytesOrJSONFromBytes(raw)
		}
	}
	if c.failure == "revalidate-stale" {
		result.Context.Slot = 150
	}
	for i, key := range keys {
		if key == solana.SysVarClockPubkey && result.Value[i] != nil {
			raw := append([]byte(nil), result.Value[i].Data.GetBinary()...)
			binary.LittleEndian.PutUint64(raw, result.Context.Slot)
			result.Value[i].Data = rpc.DataBytesOrJSONFromBytes(raw)
		}
	}
	return result, nil
}
func (c wenRevalidateFixtureRPC) GetSlot(context.Context, rpc.CommitmentType) (uint64, error) {
	return 155, nil
}
func (c wenRevalidateFixtureRPC) GetBlockHeight(context.Context, rpc.CommitmentType) (uint64, error) {
	if c.failure == "revalidate-expiry" {
		return 20, nil
	}
	return 11, nil
}
