package main

import (
	"encoding/json"
	"strconv"
	"sync"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

func wenStateFixture(t *testing.T) (*signerStoreV2, wenBudgetReservationV1) {
	t.Helper()
	s, keys := openTestSignerV2(t)
	root, pins, intent, wallet, _ := wenArtifactCase(t)
	a, err := loadWENBTCAcceptanceV1(root, pins, intent, wallet, 100, 1)
	if err != nil {
		t.Fatal(err)
	}
	record, previous := createTestSignerWalletV2(t, s, keys, "buyer", a.keys[0].String(), 100, 100)
	wallet = solana.MustPublicKeyFromBase58(record.PublicKey)
	a.keys[2] = wallet
	copy(a.offer[72:104], wallet[:])
	intent.OfferSHA256 = wenHashV1(a.offer[:])
	e, err := wenBTCExposureV1(a, intent, wallet)
	if err != nil {
		t.Fatal(err)
	}
	p := signerPolicyV2{WalletID: "buyer", Role: "agent", Operations: []string{intentWENBTCSubscriptionV1 + ".acceptance"}, Programs: []string{a.program.String(), solana.TokenProgramID.String()}}
	for asset, amount := range map[string]uint64{"solana:native": e.NativeLamports, "solana:spl:" + e.CashMint.String(): e.WalletCashRaw} {
		n := strconv.FormatUint(amount, 10)
		p.Assets = append(p.Assets, signerPolicyAssetV2{Asset: asset, Destinations: []string{a.keys[0].String()}, MaxPerTx: n, MaxDaily: n})
	}
	p, err = s.putPolicy(p, previous.Version)
	if err != nil {
		t.Fatal(err)
	}
	for scope, amount := range wenBudgetScopesV1("buyer", intent, e) {
		if err := s.configureWENBudgetV1(scope, amount); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.reserveWENPolicyBudgetV1("state-request", "buyer", p.Hash, a, intent, wallet); err != nil {
		t.Fatal(err)
	}
	return s, readWENState(t, s)
}
func readWENState(t *testing.T, s *signerStoreV2) wenBudgetReservationV1 {
	t.Helper()
	var r wenBudgetReservationV1
	if err := s.db.View(func(tx *bolt.Tx) error {
		return json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("request:state-request")), &r)
	}); err != nil {
		t.Fatal(err)
	}
	return r
}
func TestWENBTCReservationState(t *testing.T) {
	for _, name := range []string{"cancel", "cancel-next-day-restart", "signing", "signing-restart", "stale-day", "wrong-digest", "legacy", "underflow", "revoked", "race"} {
		t.Run(name, func(t *testing.T) {
			s, r := wenStateFixture(t)
			original := s.now()
			message := wenHashV1([]byte("exact prepared message"))
			cancelled := false
			switch name {
			case "cancel-next-day-restart":
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
				s.now = func() time.Time { return original.Add(24 * time.Hour) }
				if err := s.db.Update(func(tx *bolt.Tx) error {
					for asset := range r.WalletClaims {
						if err := tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2(r.WalletID, asset, currentDayBucket(s.now())), []byte("7")); err != nil {
							return err
						}
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				fallthrough
			case "cancel":
				if err := s.cancelWENReservationV1("state-request", r.Digest); err != nil {
					t.Fatal(err)
				}
				if err := s.cancelWENReservationV1("state-request", r.Digest); err != nil {
					t.Fatal("repeat cancel", err)
				}
				if err := s.beginWENSigningV1("state-request", r.Digest, message); err == nil {
					t.Fatal("cancelled request signed")
				}
				cancelled = true
			case "signing", "signing-restart":
				if err := s.beginWENSigningV1("state-request", r.Digest, message); err != nil {
					t.Fatal(err)
				}
				if name == "signing-restart" {
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
					s.now = func() time.Time { return original }
				}
				if err := s.beginWENSigningV1("state-request", r.Digest, message); err == nil {
					t.Fatal("signing fence reused")
				}
				if err := s.cancelWENReservationV1("state-request", r.Digest); err == nil {
					t.Fatal("uncertain signature released")
				}
				if got := readWENState(t, s); got.State != "signing" || got.MessageSHA256 != message {
					t.Fatal("lost message fence")
				}
			case "stale-day":
				s.now = func() time.Time { return original.Add(24 * time.Hour) }
				if err := s.beginWENSigningV1("state-request", r.Digest, message); err == nil {
					t.Fatal("old daily allowance used for signing")
				}
			case "wrong-digest":
				if err := s.cancelWENReservationV1("state-request", wenHashV1([]byte("wrong"))); err == nil {
					t.Fatal("wrong request binding released")
				}
			case "legacy":
				legacy := r
				legacy.State = ""
				raw, _ := json.Marshal(legacy)
				if err := s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(wenBudgetBucketV1).Put([]byte("request:state-request"), raw) }); err != nil {
					t.Fatal(err)
				}
				if err := s.cancelWENReservationV1("state-request", r.Digest); err == nil {
					t.Fatal("legacy released")
				}
				if err := s.beginWENSigningV1("state-request", r.Digest, message); err == nil {
					t.Fatal("legacy signed")
				}
			case "underflow":
				if err := s.db.Update(func(tx *bolt.Tx) error {
					return tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2(r.WalletID, "solana:native", r.UsageDay), []byte("0"))
				}); err != nil {
					t.Fatal(err)
				}
				if err := s.cancelWENReservationV1("state-request", r.Digest); err == nil {
					t.Fatal("underflow released")
				}
				if readWENState(t, s).State != "reserved" {
					t.Fatal("partial transition")
				}
			case "revoked":
				if err := s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(bucketSignerPoliciesV2).Delete([]byte(r.WalletID)) }); err != nil {
					t.Fatal(err)
				}
				if err := s.beginWENSigningV1("state-request", r.Digest, message); err == nil {
					t.Fatal("revoked policy signed")
				}
				if err := s.cancelWENReservationV1("state-request", r.Digest); err != nil {
					t.Fatal("revocation prevented safe release", err)
				}
				cancelled = true
			case "race":
				var wg sync.WaitGroup
				var signErr, cancelErr error
				wg.Add(2)
				go func() { defer wg.Done(); signErr = s.beginWENSigningV1("state-request", r.Digest, message) }()
				go func() { defer wg.Done(); cancelErr = s.cancelWENReservationV1("state-request", r.Digest) }()
				wg.Wait()
				if (signErr == nil) == (cancelErr == nil) {
					t.Fatal("expected exactly one transition winner")
				}
				cancelled = cancelErr == nil
			}
			for scope, amount := range r.Scopes {
				got, err := s.wenBudgetReservedV1(scope)
				if cancelled {
					amount = 0
				}
				if err != nil || got != amount {
					t.Fatalf("scope %d want %d: %v", got, amount, err)
				}
			}
			for asset, amount := range r.WalletClaims {
				got, err := s.dailyUsage(r.WalletID, asset, original)
				if cancelled || name == "underflow" && asset == "solana:native" {
					amount = 0
				}
				if err != nil || got.Uint64() != amount {
					t.Fatalf("usage %v want %d: %v", got, amount, err)
				}
				if name == "cancel-next-day-restart" {
					got, err := s.dailyUsage(r.WalletID, asset, s.now())
					if err != nil || got.Uint64() != 7 {
						t.Fatal("released wrong day", got, err)
					}
				}
			}
			if cancelled && readWENState(t, s).State != "cancelled" {
				t.Fatal("missing cancellation tombstone")
			}
		})
	}
}
