package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"strconv"
	"testing"
	"time"
)

func TestWENWithdrawalSuccessEffectsV1(t *testing.T) {
	for _, mode := range []string{"withdraw", "wrong-net", "wrong-gross", "minimum-net", "missing-tokens", "wrong-program", "missing-side", "wrong-owner", "wrong-mint", "wrong-decimals", "unexpected-rent", "existing-rent", "over-rent", "wrong-message", "failed", "recover-withdraw", "recover-failed", "recover-missing", "recover-bad-effects", "recover-wrong-wire"} {
		t.Run(mode, func(t *testing.T) {
			f := withdrawalReviewFixture(t)
			v := f.Intent
			v.ExpectedGross = "100"
			v.MinimumNet = "97"
			w := solana.MustPublicKeyFromBase58(f.Wallet)
			var private ed25519.PrivateKey
			recovery := len(mode) > 8 && mode[:8] == "recover-"
			if recovery {
				pub, key, e := ed25519.GenerateKey(rand.Reader)
				if e != nil {
					t.Fatal(e)
				}
				private = key
				w = solana.PublicKeyFromBytes(pub)
			}
			ix, e := buildWENWithdrawalInstructionV1(v, w)
			if e != nil {
				t.Fatal(e)
			}
			block := solana.MustHashFromBase58(v.Genesis)
			tx, e := solana.NewTransaction([]solana.Instruction{ix}, block, solana.TransactionPayer(w))
			if e != nil {
				t.Fatal(e)
			}
			tx.Message.SetVersion(solana.MessageVersionV0)
			msg, _ := tx.Message.MarshalBinary()
			tx.Signatures = []solana.Signature{{}}
			wire, e := tx.MarshalBinary()
			if e != nil {
				t.Fatal(e)
			}
			r := wenBudgetReservationV1{WalletID: "staker", WalletPublicKey: w.String(), Genesis: v.Genesis, WithdrawalIntent: &v, WalletClaims: map[string]uint64{"solana:native": 5000}, Scopes: map[string]uint64{wenMiningNativeScopeV1("staker", v.Genesis): 5000, wenWithdrawalLaunchScopeV1("staker", v): 5000}, SignedMessage: msg, MessageSHA256: wenHashV1(msg), MinExecutionSlot: 100, WithdrawalPrepared: &wenWithdrawalMessageBindingV1{Message: msg, Blockhash: block, ReviewSHA: wenHashV1([]byte("review")), Slot: 100, Fee: 5000, Rent: 0, LastValidHeight: 200}}
			m := &rpc.TransactionMeta{Fee: 4000}
			keys, _ := tx.Message.GetAllKeys()
			index := map[string]int{}
			for i, k := range keys {
				r.AccountKeys = append(r.AccountKeys, k.String())
				index[k.String()] = i
				m.PreBalances = append(m.PreBalances, 10)
				m.PostBalances = append(m.PostBalances, 10)
			}
			m.PreBalances[0] = 10000
			m.PostBalances[0] = 6000
			rent := index[ix.Accounts()[5].PublicKey.String()]
			mint := solana.MustPublicKeyFromBase58(v.Mint)
			program := solana.Token2022ProgramID
			pool := ix.Accounts()[3].PublicKey
			row := func(account string, owner *solana.PublicKey, amount string) rpc.TokenBalance {
				return rpc.TokenBalance{AccountIndex: uint16(index[account]), Mint: mint, Owner: owner, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: amount, Decimals: 11}}
			}
			m.PreTokenBalances = []rpc.TokenBalance{row(v.TokenAccount, &w, "200"), row(ix.Accounts()[5].PublicKey.String(), &pool, "110")}
			m.PostTokenBalances = []rpc.TokenBalance{row(v.TokenAccount, &w, "297"), row(ix.Accounts()[5].PublicKey.String(), &pool, "10")}
			switch mode {
			case "wrong-net":
				m.PostTokenBalances[0].UiTokenAmount.Amount = "298"
			case "wrong-gross":
				m.PostTokenBalances[1].UiTokenAmount.Amount = "11"
			case "minimum-net":
				v.MinimumNet = "98"
			case "missing-tokens":
				m.PreTokenBalances = nil
				m.PostTokenBalances = nil
			case "wrong-program":
				m.PreTokenBalances[1].ProgramId = &w
				m.PostTokenBalances[1].ProgramId = &w
			case "missing-side":
				m.PreTokenBalances = m.PreTokenBalances[:1]
			case "wrong-owner":
				m.PreTokenBalances[1].Owner = &w
				m.PostTokenBalances[1].Owner = &w
			case "wrong-mint":
				m.PreTokenBalances[1].Mint = w
				m.PostTokenBalances[1].Mint = w
			case "wrong-decimals":
				m.PreTokenBalances[1].UiTokenAmount.Decimals = 9
				m.PostTokenBalances[1].UiTokenAmount.Decimals = 9
			case "unexpected-rent":
				m.PostBalances[rent] = 0
				m.PostBalances[index[v.Sale]] += 1000
			case "existing-rent":
				m.PreBalances[rent] = 1
				m.PostBalances[rent] = 1001
			case "over-rent":
				m.PostBalances[rent] = 2001
				m.PostBalances[0] = 2999
			case "wrong-message":
				r.SignedMessage = append([]byte(nil), msg...)
				r.SignedMessage[0] ^= 1
			case "failed":
				m.Err = "failed"
			}
			if recovery {
				checkWENWithdrawalRecoveryV1(t, mode, r, private, m)
				return
			}

			encoded, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
			envelope := &rpc.TransactionResultEnvelope{}
			if e = json.Unmarshal(encoded, envelope); e != nil {
				t.Fatal(e)
			}
			proof := wenWithdrawalSuccessEffectsV1(r, &rpc.GetTransactionResult{Slot: 150, Meta: m, Transaction: envelope})
			if (proof != "") != (mode == "withdraw") {
				t.Fatalf("unexpected proof %q", proof)
			}
		})
	}
}

// Joins the durable submission boundary to finalized reconciliation and settlement.
// Review/preparation and initial accounting are fixtures, not admission evidence.
func checkWENWithdrawalRecoveryV1(t *testing.T, mode string, r wenBudgetReservationV1, private ed25519.PrivateKey, m *rpc.TransactionMeta) {
	t.Helper()
	s, base := wenStateFixture(t)
	r.Version = 1
	r.WalletID = base.WalletID
	r.PolicyHash = base.PolicyHash
	r.Digest = base.Digest
	s.now = time.Now
	r.UsageDay = currentDayBucket(s.now())
	r.MinFinalizedSlot = "100"
	r.State = "reserved"
	r.Scopes = map[string]uint64{wenMiningNativeScopeV1(r.WalletID, r.Genesis): 5000, wenWithdrawalLaunchScopeV1(r.WalletID, *r.WithdrawalIntent): 5000}
	must := func(e error) {
		t.Helper()
		if e != nil {
			t.Fatal(e)
		}
	}
	must(s.db.Update(func(tx *bolt.Tx) error {
		raw, _ := json.Marshal(r)
		if e := tx.Bucket(wenBudgetBucketV1).Put([]byte("request:state-request"), raw); e != nil {
			return e
		}
		for scope := range r.Scopes {
			raw, _ := json.Marshal(wenBudgetBalanceV1{Limit: 10000, Reserved: 5000})
			if e := tx.Bucket(wenBudgetBucketV1).Put([]byte("limit:"+scope), raw); e != nil {
				return e
			}
		}
		for asset, n := range r.WalletClaims {
			if e := tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2(r.WalletID, asset, r.UsageDay), []byte(strconv.FormatUint(n, 10))); e != nil {
				return e
			}
		}
		return nil
	}))
	// The fence starts without an existing message commitment.
	message := append([]byte(nil), r.SignedMessage...)
	must(s.changeWENReservationV1("state-request", r.Digest, func(_ *bolt.Tx, v *wenBudgetReservationV1) error {
		v.MessageSHA256 = ""
		v.SignedMessage = nil
		return nil
	}))
	must(s.beginWENSigningAccountsV1("state-request", r.Digest, wenHashV1(message), r.AccountKeys, 100))
	var sig solana.Signature
	copy(sig[:], ed25519.Sign(private, message))
	must(s.recordWENSignatureV1("state-request", r.Digest, message, sig.String()))
	saved := readWENState(t, s)
	p := &wenWithdrawalPreparedV1{message: message, wallet: solana.MustPublicKeyFromBase58(r.WalletPublicKey), review: wenWithdrawalReviewedConfigV1{reviewSHA: r.WithdrawalPrepared.ReviewSHA}}
	wire, e := s.commitWENWithdrawalSubmissionV1("state-request", r.Digest, saved, p)
	must(e)
	restart := func() {
		persisted := wenRestartRecord(t, s, "state-request")
		path := s.db.Path()
		must(s.Close())
		verifyWENFreshProcess(t, path, "state-request", persisted)
		s, e = openSignerStoreV2(path)
		must(e)
	}
	restart()
	defer func() { s.Close() }()
	if _, e = s.commitWENWithdrawalSubmissionV1("state-request", r.Digest, saved, p); e == nil {
		t.Fatal("restart allowed duplicate submission")
	}
	if mode == "recover-failed" {
		m.Err = "failed"
		m.PostBalances = append([]uint64(nil), m.PreBalances...)
		m.PostBalances[0] -= m.Fee
		m.PostTokenBalances = m.PreTokenBalances
	}
	if mode == "recover-bad-effects" {
		m.PostTokenBalances[1].UiTokenAmount.Amount = "108"
	}
	if mode == "recover-wrong-wire" {
		wire = append([]byte(nil), wire...)
		wire[len(wire)-1] ^= 1
	}
	encoded, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	envelope := &rpc.TransactionResultEnvelope{}
	must(json.Unmarshal(encoded, envelope))
	client := &wenReconcileFixtureRPC{t: t, chain: solana.MustHashFromBase58(r.Genesis), signature: sig, result: &rpc.GetTransactionResult{Slot: 150, Meta: m, Transaction: envelope}}
	if mode == "recover-missing" {
		client.failure = "missing"
	}
	state, e := s.reconcileWENTransactionV1(context.Background(), client, "state-request", r.Digest)
	if mode == "recover-wrong-wire" {
		if e == nil {
			t.Fatal("wrong wire accepted")
		}
	} else {
		must(e)
	}
	uncertain := mode == "recover-missing" || mode == "recover-wrong-wire"
	if uncertain {
		if readWENState(t, s).State != "submission-uncertain" {
			t.Fatal("uncertain receipt finalized")
		}
	} else if state != "finalized-success" && state != "finalized-failed" {
		t.Fatal(state)
	}
	restart()
	// Reconcile after reopening; finalized evidence and missing observations replay.
	if !uncertain {
		_, e = s.reconcileWENTransactionV1(context.Background(), client, "state-request", r.Digest)
		must(e)
	}
	settle := func() error {
		if mode == "recover-failed" {
			return s.settleWENFailedBudgetV1("state-request", r.Digest)
		}
		return s.settleWENWithdrawalSuccessV1("state-request", r.Digest)
	}
	e = settle()
	held := uncertain || mode == "recover-bad-effects"
	if held {
		if e == nil {
			t.Fatal("unproved settlement")
		}
	} else {
		must(e)
		restart()
		must(settle())
		_, e = s.recoverWENWithdrawalExecutionV1(context.Background(), client, "state-request", r.Digest)
		must(e)
	}
	native := uint64(4000)
	if held {
		native = 5000
	}
	if mode == "recover-failed" {
		native = 4000
	}
	for scope := range r.Scopes {
		n, e := s.wenBudgetReservedV1(scope)
		must(e)
		if n != native {
			t.Fatalf("scope usage %d != %d", n, native)
		}
	}
	day, e := time.Parse("2006-01-02", r.UsageDay)
	must(e)
	for asset, want := range map[string]uint64{"solana:native": native} {
		n, e := s.dailyUsage(r.WalletID, asset, day)
		must(e)
		if n.Uint64() != want {
			t.Fatalf("usage %s %v != %d", asset, n, want)
		}
	}
	if e = s.cancelWENReservationV1("state-request", r.Digest); e == nil {
		t.Fatal("exposed transaction cancelled")
	}
}
