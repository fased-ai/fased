package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"os"
	"path/filepath"
	"testing"
)

type withdrawalPrepareFake struct {
	*miningPrepareFake
	descriptor string
}

func (f *withdrawalPrepareFake) SimulateRawTransactionWithOpts(ctx context.Context, b []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	result, e := f.miningPrepareFake.SimulateRawTransactionWithOpts(ctx, b, o)
	if f.mode == "descriptor-change" {
		if err := os.WriteFile(f.descriptor, []byte("{}"), 0600); err != nil {
			f.t.Fatal(err)
		}
	}
	if f.mode == "account-change" {
		d := append([]byte(nil), f.page.Value[4].Data.GetBinary()...)
		d[64] ^= 1
		f.page.Value[4].Data = rpc.DataBytesOrJSONFromBytes(d)
	}
	return result, e
}
func checkWithdrawalPreparation(t *testing.T, base *wenReadRPCFake, v signerWENWithdrawalIntentV1, w solana.PublicKey, pins wenStakingPinsV1, private ed25519.PrivateKey) {
	t.Helper()
	for _, mode := range []string{"ok", "missing-hash", "stale-hash", "expired", "expires-during", "height-rollback", "missing-fee", "fee", "balance", "units", "stale-sim", "simulation-error", "budget", "descriptor-change", "account-change"} {
		t.Run("prepare/"+mode, func(t *testing.T) {
			raw, _ := withdrawalDescriptorFixture(t)
			var d map[string]any
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.UseNumber()
			if e := dec.Decode(&d); e != nil {
				t.Fatal(e)
			}
			d["deployment"].(map[string]any)["withdrawal"].(map[string]any)["deployedBytesHash"] = pins.CodeSHA256
			raw, p := repinWithdrawalDescriptor(t, d, pins)
			intent := v
			intent.DescriptorSHA256 = p.DescriptorSHA256
			intent.CapabilitySHA256 = p.CapabilitySHA256
			db := filepath.Join(t.TempDir(), "state.db")
			limit := uint64(5000)
			if mode == "budget" {
				limit = 4999
			}
			review := wenWithdrawalReviewV1{Version: 1, WalletID: "staker", WalletPublicKey: w.String(), Intent: intent, Pins: p, MaxSlotLag: 2, MaxTotalCostLamports: limit}
			root := writeWithdrawalReviewFixture(t, db, review)
			path := filepath.Join(root, p.DescriptorSHA256)
			if e := os.WriteFile(path, raw, 0600); e != nil {
				t.Fatal(e)
			}
			fixture := miningFixture(t)
			fixture.Wallet = w.String()
			ix, e := buildWENWithdrawalInstructionV1(intent, w)
			if e != nil {
				t.Fatal(e)
			}
			tx, e := solana.NewTransaction([]solana.Instruction{ix}, solana.MustHashFromBase58(fixture.Blockhash), solana.TransactionPayer(w))
			if e != nil {
				t.Fatal(e)
			}
			tx.Message.SetVersion(solana.MessageVersionV0)
			msg, e := tx.Message.MarshalBinary()
			if e != nil {
				t.Fatal(e)
			}
			fixture.Messages = [][]byte{msg}
			clone := *base
			clone.calls = 0
			clone.change = "ok"
			page := *base.page
			page.Value = append([]*rpc.Account(nil), base.page.Value...)
			for i, a := range page.Value {
				if a != nil {
					copy := *a
					page.Value[i] = &copy
				}
			}
			clone.page = &page
			client := &withdrawalPrepareFake{miningPrepareFake: &miningPrepareFake{wenReadRPCFake: &clone, fixture: fixture, mode: mode}, descriptor: path}
			out, e := prepareReviewedWENWithdrawalV1(context.Background(), client, db, "staker", intent)
			if (e == nil) != (mode == "ok") {
				t.Fatal("unexpected prepared withdrawal", e)
			}
			if e == nil {
				checkWithdrawalPreparedReservation(t, client, review, raw)
				checkWithdrawalPreparedSubmission(t, client, intent, review, raw, private)
				checkWithdrawalExecutor(t, client, intent, review, raw, private)
				binding := wenWithdrawalMessageBindingV1{Message: out.message, Blockhash: out.blockhash, ReviewSHA: out.review.reviewSHA, Slot: out.slot, Fee: out.fee, LastValidHeight: out.lastValidHeight, Evidence: &wenWithdrawalPreparedEvidenceV1{Pins: p, Before: out.state}}
				if err := validateWENWithdrawalMessageBindingV1(intent, w, out.total, binding); err != nil {
					t.Fatal("prepared evidence", err)
				}
				client.fixture.Blockhash = intent.Genesis
				pinned, err := preparePinnedWENWithdrawalV1(context.Background(), client, db, "staker", intent, &binding)
				if err != nil || !bytes.Equal(pinned.message, out.message) {
					t.Fatal("pinned withdrawal", err)
				}
				changed := binding
				ev := *binding.Evidence
				before := ev.Before
				account := *before.Destination
				account.Data = append([]byte(nil), account.Data...)
				account.Data[64] ^= 1
				before.Destination = &account
				ev.Before = before
				changed.Evidence = &ev
				if _, err = preparePinnedWENWithdrawalV1(context.Background(), client, db, "staker", intent, &changed); err == nil {
					t.Fatal("different valid reserved snapshot accepted")
				}
				binding.Fee--
				if _, err = preparePinnedWENWithdrawalV1(context.Background(), client, db, "staker", intent, &binding); err == nil {
					t.Fatal("changed fee accepted")
				}
			}
			if e == nil && (!bytes.Equal(out.message, msg) || out.fee != 5000 || out.rent != 0 || out.total != 5000 || out.state.Preview.Net != 97) {
				t.Fatal("wrong prepared costs/state")
			}
		})
	}
}

func checkWithdrawalPreparedReservation(t *testing.T, client *withdrawalPrepareFake, review wenWithdrawalReviewV1, raw []byte) {
	t.Helper()
	s, _ := openTestSignerV2(t)
	root := writeWithdrawalReviewFixture(t, s.db.Path(), review)
	if e := os.WriteFile(filepath.Join(root, review.Pins.DescriptorSHA256), raw, 0600); e != nil {
		t.Fatal(e)
	}
	policy, e := s.putWalletAndPolicy(signerWalletRecordV2{WalletID: review.WalletID, PublicKey: review.WalletPublicKey}, signerPolicyV2{WalletID: review.WalletID, Role: "agent", Operations: []string{intentWENWithdrawalV1}, Programs: []string{review.Intent.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{review.Intent.Sale}, MaxPerTx: "5000", MaxDaily: "5000"}}}, 0)
	if e != nil {
		t.Fatal(e)
	}
	for _, scope := range []string{wenMiningNativeScopeV1(review.WalletID, review.Intent.Genesis), wenWithdrawalLaunchScopeV1(review.WalletID, review.Intent)} {
		if e = s.configureWENBudgetV1(scope, 5000); e != nil {
			t.Fatal(e)
		}
	}
	prepared, e := prepareReviewedWENWithdrawalV1(context.Background(), client, s.db.Path(), review.WalletID, review.Intent)
	if e != nil {
		t.Fatal(e)
	}
	digest, replay, e := s.reservePreparedWENWithdrawalV1("prepared-withdrawal", review.WalletID, policy.Hash, review.Intent, prepared)
	if e != nil || replay || digest == "" {
		t.Fatal("joined reservation", e)
	}
	_, replay, e = s.reservePreparedWENWithdrawalV1("prepared-withdrawal", review.WalletID, policy.Hash, review.Intent, prepared)
	if e != nil || !replay {
		t.Fatal("joined replay", e)
	}
	if e = os.WriteFile(filepath.Join(root, review.Pins.DescriptorSHA256), []byte("{}"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.reservePreparedWENWithdrawalV1("prepared-withdrawal", review.WalletID, policy.Hash, review.Intent, prepared); e == nil {
		t.Fatal("changed admission reserved")
	}
}
