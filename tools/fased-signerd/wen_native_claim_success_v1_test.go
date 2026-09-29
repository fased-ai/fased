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

func TestWENNativeClaimSuccessEffects(t *testing.T) {
	for _, mode := range []string{"ok", "amount", "weight", "paid-owner", "paid-slot", "rent", "tokens", "owner", "failed", "state", "saved-amount", "saved-weight", "recover", "recover-missing", "recover-wrong-chain", "recover-failed", "paid-net", "paid-day", "token-program", "recover-unknown"} {
		t.Run(mode, func(t *testing.T) {
			v := nativeClaimIntentFixture()
			v.MaxRentLamports = "1000"
			key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{19}, 32))
			w := solana.PublicKeyFromBytes(key.Public().(ed25519.PublicKey))
			ix, _ := buildWENNativeClaimInstructionV1(v, w)
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
			index := map[string]int{}
			r := wenBudgetReservationV1{WalletID: "miner", WalletPublicKey: w.String(), Genesis: v.Genesis, NativeClaimIntent: &v, WalletClaims: map[string]uint64{"solana:native": 6000}, Scopes: map[string]uint64{wenMiningNativeScopeV1("miner", v.Genesis): 6000, wenNativeClaimLaunchScopeV1("miner", v): 6000}, SignedMessage: msg, MessageSHA256: wenHashV1(msg), MinExecutionSlot: 10, NativeClaimPrepared: &wenNativeClaimMessageBindingV1{Gross: 250, TransferFee: 8, Net: 242, Weight: 25, Message: msg, Blockhash: block, ReviewSHA: wenHashV1([]byte("review")), StateHash: wenHashV1([]byte("state")), Slot: 10, Fee: 5000, Rent: 1000, LastValidHeight: 200}}
			m := &rpc.TransactionMeta{Fee: 5000}
			for i, k := range keys {
				index[k.String()] = i
				r.AccountKeys = append(r.AccountKeys, k.String())
				m.PreBalances = append(m.PreBalances, 10)
				m.PostBalances = append(m.PostBalances, 10)
			}
			m.PreBalances[0] = 10000
			m.PostBalances[0] = 4500
			pi := index[a[7].PublicKey.String()]
			m.PreBalances[pi] = 0
			m.PostBalances[pi] = 500
			mint := solana.MustPublicKeyFromBase58(v.Mint)
			program := solana.Token2022ProgramID
			owner := w
			auth := a[3].PublicKey
			row := func(i int, o *solana.PublicKey, n string) rpc.TokenBalance {
				return rpc.TokenBalance{AccountIndex: uint16(i), Mint: mint, Owner: o, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: n, Decimals: 11}}
			}
			vi := index[a[8].PublicKey.String()]
			di := index[v.Destination]
			m.PreTokenBalances = []rpc.TokenBalance{row(vi, &auth, "800"), row(di, &owner, "0")}
			m.PostTokenBalances = []rpc.TokenBalance{row(vi, &auth, "550"), row(di, &owner, "242")}
			result := &rpc.GetTransactionResult{Slot: 15, Meta: m, Transaction: &rpc.TransactionResultEnvelope{}}
			if e := result.Transaction.UnmarshalJSON([]byte(`["` + base64.StdEncoding.EncodeToString(wire) + `","base64"]`)); e != nil {
				t.Fatal(e)
			}
			funding := a[4].PublicKey
			_, b, _ := solana.FindProgramAddress([][]byte{[]byte("wen-native-stake-claim-v1"), funding[:], w[:]}, ix.ProgramID())
			d := make([]byte, 112)
			copy(d, "WENNSCL1")
			d[8] = 1
			d[11] = b
			copy(d[16:], funding[:])
			copy(d[48:], w[:])
			binary.LittleEndian.PutUint64(d[80:], 250)
			binary.LittleEndian.PutUint64(d[88:], 242)
			binary.LittleEndian.PutUint64(d[96:], 25)
			binary.LittleEndian.PutUint64(d[104:], 42)
			paid := &signerWENBTCAccountV1{Address: a[7].PublicKey, Owner: ix.ProgramID(), Slot: 15, Data: d}

			switch mode {
			case "amount":
				d[80] ^= 1
			case "weight":
				d[96] ^= 1
			case "paid-net":
				d[88] ^= 1
			case "paid-day":
				d[104] ^= 1
			case "token-program":
				program = solana.TokenProgramID
			case "paid-owner":
				paid.Owner = w
			case "paid-slot":
				paid.Slot = 14
			case "rent":
				m.PostBalances[pi] = 999
			case "tokens":
				m.PostTokenBalances[1].UiTokenAmount.Amount = "249"
			case "owner":
				owner = auth
			case "failed":
				m.Err = "error"
			case "saved-amount":
				r.NativeClaimPrepared.Net++
			case "saved-weight":
				r.NativeClaimPrepared.Weight++
			case "state":
				r.NativeClaimPrepared.StateHash = "wrong"
			}
			if mode == "recover-failed" {
				m.Err = "fixture failure"
				m.PostBalances = append([]uint64(nil), m.PreBalances...)
				m.PostBalances[0] -= m.Fee
				m.PostTokenBalances = m.PreTokenBalances
			}
			hash := wenNativeClaimSuccessEffectsV1(r, result, paid)
			if (hash != "") != (mode == "ok" || mode == "recover" || mode == "recover-missing" || mode == "recover-wrong-chain" || mode == "recover-unknown") {
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
						b, _ := json.Marshal(wenBudgetBalanceV1{Limit: 12000, Reserved: 6000})
						if e := tx.Bucket(wenBudgetBucketV1).Put([]byte("limit:"+scope), b); e != nil {
							return e
						}
					}
					if e := tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2(r.WalletID, "solana:native", r.UsageDay), []byte("6000")); e != nil {
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
				status, e := store.recoverWENNativeClaimExecutionV1(context.Background(), client, "state-request", r.Digest)
				if (e == nil) != (mode == "recover" || mode == "recover-failed" || mode == "recover-unknown") {
					t.Fatal("recovery", e)
				}
				if mode == "recover" {
					saved := readWENState(t, store)
					if status != "finalized-success" || saved.NativeClaimEffectsSHA256 == "" {
						t.Fatal("missing outcome proof")
					}
					if _, e = store.recoverWENNativeClaimExecutionV1(context.Background(), client, "state-request", r.Digest); e != nil {
						t.Fatal("repeat recovery", e)
					}
				} else if mode != "recover-failed" && readWENState(t, store).State != "submission-uncertain" {
					t.Fatal("bad proof advanced outcome")
				}
				want := uint64(6000)
				if mode == "recover" {
					want = 5500
				}
				if mode == "recover-failed" {
					want = 5000
					if status != "finalized-failed" {
						t.Fatal(status)
					}
					if _, e = store.recoverWENNativeClaimExecutionV1(context.Background(), client, "state-request", r.Digest); e != nil {
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
