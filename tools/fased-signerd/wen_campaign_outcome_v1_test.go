package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func testCampaignOutcomeV1(t *testing.T, a wenCampaignReviewArtifactV1, digest string, sig solana.Signature, wire []byte) {
	t.Helper()
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		t.Fatal(e)
	}
	for _, failed := range []bool{false, true} {
		m := &rpc.TransactionMeta{Fee: a.Binding.Fee}
		for range tx.Message.AccountKeys {
			m.PreBalances = append(m.PreBalances, 1000000)
			m.PostBalances = append(m.PostBalances, 1000000)
		}
		if failed {
			m.Err = "fixture failure"
		}
		for i, k := range tx.Message.AccountKeys {
			if k.String() == a.WalletPublicKey {
				m.PostBalances[i] -= m.Fee
				if !failed {
					if a.Action.Operation == "top-up" {
						m.PostBalances[i] -= a.Action.Amount
					}
					if a.Action.Operation == "withdraw" {
						m.PostBalances[i] += a.Action.Amount
					}
				}
			}
			if k == a.Action.Position && !failed {
				if a.Action.Operation == "top-up" {
					m.PostBalances[i] += a.Action.Amount
				}
				if a.Action.Operation == "withdraw" {
					m.PostBalances[i] -= a.Action.Amount
				}
			}
		}
		envelope := &rpc.TransactionResultEnvelope{}
		raw, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
		if e = json.Unmarshal(raw, envelope); e != nil {
			t.Fatal(e)
		}
		result := &rpc.GetTransactionResult{Slot: 120, Meta: m, Transaction: envelope}
		r := wenCampaignReservationV1{Version: 1, Digest: digest, State: "submission-uncertain", Artifact: a, Signature: sig.String()}
		debit, hash, e := wenCampaignOutcomeV1(r, result)
		want := m.Fee
		if !failed && a.Action.Operation == "top-up" {
			want += a.Action.Amount
		}
		if e != nil || debit != want || hash == "" {
			t.Fatal("outcome", failed, debit, e)
		}
		testCampaignRecoveryV1(t, r, result, want)
		m.PostBalances[0]++
		if _, _, e = wenCampaignOutcomeV1(r, result); e == nil {
			t.Fatal("wrong balance accepted")
		}
		m.PostBalances[0]--
		m.Fee++
		if _, _, e = wenCampaignOutcomeV1(r, result); e == nil {
			t.Fatal("wrong fee accepted")
		}
		m.Fee--
		result.Slot = 100
		if _, _, e = wenCampaignOutcomeV1(r, result); e == nil {
			t.Fatal("stale receipt accepted")
		}
		result.Slot = 120
		r.Signature = solana.Signature{}.String()
		if _, _, e = wenCampaignOutcomeV1(r, result); e == nil {
			t.Fatal("wrong signature accepted")
		}
	}
}

type campaignRecoveryFake struct {
	t      *testing.T
	r      wenCampaignReservationV1
	result *rpc.GetTransactionResult
	mode   string
	reads  int
}

func (f *campaignRecoveryFake) GetGenesisHash(context.Context) (solana.Hash, error) {
	f.reads++
	g := solana.MustHashFromBase58(f.r.Artifact.Pins.Genesis)
	if f.mode == "chain" || f.mode == "chain-change" && f.reads > 1 {
		g[0] ^= 1
	}
	return g, nil
}
func (f *campaignRecoveryFake) GetSlot(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("nonfinal slot")
	}
	if f.mode == "unfinalized" {
		return 119, nil
	}
	return 121, nil
}
func (f *campaignRecoveryFake) GetTransaction(_ context.Context, s solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if s.String() != f.r.Signature || o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MaxSupportedTransactionVersion == nil || *o.MaxSupportedTransactionVersion != 0 {
		f.t.Fatal("unbound receipt request")
	}
	if f.mode == "missing" {
		return nil, rpc.ErrNotFound
	}
	return f.result, nil
}
func testCampaignRecoveryV1(t *testing.T, r wenCampaignReservationV1, result *rpc.GetTransactionResult, want uint64) {
	t.Helper()
	for _, mode := range []string{"ok", "missing", "chain", "chain-change", "unfinalized", "underflow"} {
		s, e := openSignerStoreV2(filepath.Join(t.TempDir(), "state.db"))
		if e != nil {
			t.Fatal(e)
		}
		n, _ := r.Artifact.debit()
		r.UsageDay = currentDayBucket(time.Now().Add(-24 * time.Hour))
		r.Scopes = map[string]uint64{wenMiningNativeScopeV1(r.Artifact.WalletID, r.Artifact.Pins.Genesis): n, wenCampaignLaunchScopeV1(r.Artifact): n}
		e = s.db.Update(func(tx *bolt.Tx) error {
			b, e := tx.CreateBucketIfNotExists(wenBudgetBucketV1)
			if e != nil {
				return e
			}
			for scope := range r.Scopes {
				raw, _ := json.Marshal(wenBudgetBalanceV1{Limit: n, Reserved: n})
				if e = b.Put([]byte("limit:"+scope), raw); e != nil {
					return e
				}
			}
			raw, _ := json.Marshal(r)
			if e = b.Put([]byte("campaign-request:"+r.Artifact.RequestID), raw); e != nil {
				return e
			}
			usage := n
			if mode == "underflow" {
				usage = 0
			}
			return tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2(r.Artifact.WalletID, "solana:native", r.UsageDay), []byte(strconv.FormatUint(usage, 10)))
		})
		if e != nil {
			t.Fatal(e)
		}
		f := &campaignRecoveryFake{t: t, r: r, result: result, mode: mode}
		state, e := s.recoverWENCampaignV1(context.Background(), f, r.Artifact.RequestID, r.Digest)
		if (e == nil) != (mode == "ok" || mode == "missing") {
			t.Fatal(mode, e)
		}
		expected := n
		if mode == "ok" {
			expected = want
			if state != "finalized-success" && state != "finalized-failed" {
				t.Fatal(state)
			}
			path := s.db.Path()
			s.Close()
			s, e = openSignerStoreV2(path)
			if e != nil {
				t.Fatal(e)
			}
			if _, e = s.recoverWENCampaignV1(context.Background(), f, r.Artifact.RequestID, r.Digest); e != nil {
				t.Fatal("retry", e)
			}
		} else if mode == "missing" && state != "submission-uncertain" {
			t.Fatal("missing released")
		}
		e = s.db.View(func(tx *bolt.Tx) error {
			for scope := range r.Scopes {
				var b wenBudgetBalanceV1
				if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &b); e != nil {
					return e
				}
				if b.Reserved != expected {
					t.Fatal("bad settlement", mode, b.Reserved, expected)
				}
			}
			return nil
		})
		if e != nil {
			t.Fatal(e)
		}
		s.Close()
	}
}
