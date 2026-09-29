package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"strconv"
	"strings"
	"testing"
)

func TestWENMiningClaimSuccessEffects(t *testing.T) {
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "amount", "paid-owner", "paid-slot", "native", "tokens", "failed", "state", "saved-amount", "recover", "recover-missing", "recover-wrong-chain", "recover-failed", "recover-unknown", "other-leg", "zero-leg", "unpaid", "paid-short", "paid-bump", "paid-domain", "missing-balances", "fee", "wire"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				v := miningClaimIntentFixture()
				v.Operation = op
				if op == "sat" {
					d := solana.PublicKey{4}.String()
					v.Destination = &d
				}
				key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{19}, 32))
				w := solana.PublicKeyFromBytes(key.Public().(ed25519.PublicKey))
				ix, _ := buildWENMiningClaimInstructionV1(v, w)
				a := ix.Accounts()
				block := solana.Hash{8}
				tx, _ := solana.NewTransaction([]solana.Instruction{ix}, block, solana.TransactionPayer(w))
				tx.Message.SetVersion(solana.MessageVersionV0)
				msg, _ := tx.Message.MarshalBinary()
				var signature solana.Signature
				copy(signature[:], ed25519.Sign(key, msg))
				tx.Signatures = []solana.Signature{signature}
				wire, _ := tx.MarshalBinary()
				keys, _ := tx.Message.GetAllKeys()
				r := wenBudgetReservationV1{WalletID: "miner", WalletPublicKey: w.String(), Genesis: v.Genesis, MiningClaimIntent: &v, WalletClaims: map[string]uint64{"solana:native": 5000}, Scopes: map[string]uint64{wenMiningNativeScopeV1("miner", v.Genesis): 5000, wenMiningClaimLaunchScopeV1("miner", v): 5000}, SignedMessage: msg, MessageSHA256: wenHashV1(msg), Signature: signature.String(), MinExecutionSlot: 2, MiningClaimPrepared: &wenMiningClaimMessageBindingV1{Message: msg, Blockhash: block, ReviewSHA: wenHashV1([]byte("review")), StateHash: v.AccountStateSHA256, Slot: 2, Fee: 5000, LastValidHeight: 200}}
				m := &rpc.TransactionMeta{Fee: 4000}
				index := map[string]int{}
				for i, k := range keys {
					index[k.String()] = i
					r.AccountKeys = append(r.AccountKeys, k.String())
					m.PreBalances = append(m.PreBalances, 10000)
					m.PostBalances = append(m.PostBalances, 10000)
				}
				m.PostBalances[0] -= 4000
				if op == "sol" {
					m.PostBalances[0] += 100
					m.PostBalances[index[a[6].PublicKey.String()]] -= 100
				} else {
					mint, program, auth := a[11].PublicKey, solana.Token2022ProgramID, a[7].PublicKey
					row := func(k solana.PublicKey, o *solana.PublicKey, n string) rpc.TokenBalance {
						return rpc.TokenBalance{AccountIndex: uint16(index[k.String()]), Mint: mint, Owner: o, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: n, Decimals: 11}}
					}
					m.PreTokenBalances = []rpc.TokenBalance{row(a[9].PublicKey, &auth, "800"), row(a[10].PublicKey, &w, "0")}
					m.PostTokenBalances = []rpc.TokenBalance{row(a[9].PublicKey, &auth, "700"), row(a[10].PublicKey, &w, "97")}
				}
				result := &rpc.GetTransactionResult{Slot: 15, Meta: m, Transaction: &rpc.TransactionResultEnvelope{}}
				encoded, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
				if e := result.Transaction.UnmarshalJSON(encoded); e != nil {
					t.Fatal(e)
				}
				p := ix.ProgramID()
				_, b, _ := solana.FindProgramAddress([][]byte{[]byte("wen-mining-claim-v1"), a[1].PublicKey[:], a[5].PublicKey[:]}, p)
				d := make([]byte, 192)
				copy(d, "WENMCLM1")
				d[8] = 1
				d[10] = 1
				if op == "sat" {
					d[10] = 2
				}
				d[11] = b
				for i, k := range []solana.PublicKey{p, a[1].PublicKey, a[2].PublicKey, a[5].PublicKey, w} {
					copy(d[16+i*32:], k[:])
				}
				binary.LittleEndian.PutUint64(d[176:], 100)
				binary.LittleEndian.PutUint64(d[184:], 100)
				paid := &signerWENBTCAccountV1{Address: a[6].PublicKey, Owner: p, Slot: 15, Data: d}
				switch mode {
				case "zero-leg":
					v.ExpectedGross = "0"
					v.MinimumReceived = "0"
					offset := 176
					if op == "sat" {
						offset = 184
					}
					binary.LittleEndian.PutUint64(d[offset:], 0)
					m.PostBalances = append([]uint64(nil), m.PreBalances...)
					m.PostBalances[0] -= m.Fee
					m.PostTokenBalances = m.PreTokenBalances
				case "unpaid":
					d[10] = 0
				case "paid-short":
					paid.Data = d[:1]
				case "paid-bump":
					d[11] ^= 1
				case "paid-domain":
					d[16] ^= 1
				case "missing-balances":
					m.PostBalances = nil
				case "amount":
					if op == "sol" {
						d[176] ^= 1
					} else {
						d[184] ^= 1
					}
				case "paid-owner":
					paid.Owner = w
				case "paid-slot":
					paid.Slot = 14
				case "native":
					m.PostBalances[1]++
				case "tokens":
					if op == "sol" {
						m.PostTokenBalances = []rpc.TokenBalance{{AccountIndex: 1}}
					} else {
						m.PostTokenBalances[1].UiTokenAmount.Amount = "98"
					}
				case "failed":
					m.Err = "failed"
				case "state":
					r.MiningClaimPrepared.StateHash = "wrong"
				case "saved-amount":
					v.ExpectedGross = "101"
				case "other-leg":
					d[10] = 3
				case "fee":
					m.Fee = 5001
				case "wire":
					result.Transaction = &rpc.TransactionResultEnvelope{}
				}
				if mode == "recover-failed" {
					m.Err = "fixture failure"
					m.PostBalances = append([]uint64(nil), m.PreBalances...)
					m.PostBalances[0] -= m.Fee
					m.PostTokenBalances = m.PreTokenBalances
				}
				hash := wenMiningClaimSuccessEffectsV1(r, result, paid)
				if (hash != "") != (mode == "ok" || mode == "other-leg" || mode == "zero-leg" || mode == "recover" || mode == "recover-missing" || mode == "recover-wrong-chain" || mode == "recover-unknown") {
					t.Fatal("unexpected proof", hash)
				}
				if strings.HasPrefix(mode, "recover") {
					store, base := wenStateFixture(t)
					r.Version = base.Version
					r.Digest = base.Digest
					r.PolicyHash = base.PolicyHash
					r.UsageDay = base.UsageDay
					r.State = "submission-uncertain"
					r.MinFinalizedSlot = "1"
					r.Signature = signature.String()
					raw, _ := json.Marshal(r)
					if e := store.db.Update(func(tx *bolt.Tx) error {
						for scope := range r.Scopes {
							b, _ := json.Marshal(wenBudgetBalanceV1{Limit: 12000, Reserved: 5000})
							if e := tx.Bucket(wenBudgetBucketV1).Put([]byte("limit:"+scope), b); e != nil {
								return e
							}
						}
						if e := tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2(r.WalletID, "solana:native", r.UsageDay), []byte("5000")); e != nil {
							return e
						}
						return tx.Bucket(wenBudgetBucketV1).Put([]byte("request:state-request"), raw)
					}); e != nil {
						t.Fatal(e)
					}
					client := &claimOutcomeFake{t: t, result: result, paid: paid, mode: mode}
					if mode == "recover-unknown" {
						client.result = nil
					}
					status, e := store.recoverWENMiningClaimExecutionV1(context.Background(), client, "state-request", r.Digest)
					if (e == nil) != (mode == "recover" || mode == "recover-failed" || mode == "recover-unknown") {
						t.Fatal("recovery", e)
					}
					if mode == "recover" {
						saved := readWENState(t, store)
						if status != "finalized-success" || saved.MiningClaimEffectsSHA256 == "" {
							t.Fatal("missing outcome proof")
						}
						paid.Data[10] = 3 // The other leg may be paid after this transaction.
						if _, e = store.recoverWENMiningClaimExecutionV1(context.Background(), client, "state-request", r.Digest); e != nil {
							t.Fatal("repeat recovery", e)
						}
					} else if mode != "recover-failed" && readWENState(t, store).State != "submission-uncertain" {
						t.Fatal("bad proof advanced outcome")
					}
					want := uint64(5000)
					if mode == "recover" {
						want = 4000
					}
					if mode == "recover-failed" {
						want = 4000
						if status != "finalized-failed" {
							t.Fatal(status)
						}
						if _, e = store.recoverWENMiningClaimExecutionV1(context.Background(), client, "state-request", r.Digest); e != nil {
							t.Fatal(e)
						}
					}
					if e = store.db.View(func(tx *bolt.Tx) error {
						used := string(tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2(r.WalletID, "solana:native", r.UsageDay)))
						if used != strconv.FormatUint(want, 10) {
							t.Fatal("daily retained", used, want)
						}
						for scope := range r.Scopes {
							var b wenBudgetBalanceV1
							if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &b); e != nil {
								return e
							}
							if b.Reserved != want {
								t.Fatalf("retained %d want %d", b.Reserved, want)
							}
						}
						return nil
					}); e != nil {
						t.Fatal(e)
					}

				}

			})
		}
	}
}
