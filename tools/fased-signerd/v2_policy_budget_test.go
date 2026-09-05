package main

import (
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

func TestPolicyBudgetSnapshotReadOnly(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet, policy := createTestSignerWalletV2(t, store, keys, "agent", solana.NewWallet().PublicKey().String(), 100, 500)
	now := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	key := dailyUsageKeyV2(wallet.WalletID, "solana:native", currentDayBucket(now))
	if err := store.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(bucketSignerUsageV2).Put(key, []byte("125")) }); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		got, err := store.policyBudgetV2(wallet.WalletID)
		if err != nil {
			t.Fatal(err)
		}
		if got.PolicyHash != policy.Hash || got.Assets[0].Used != "125" || got.Assets[0].Remaining != "6500375" {
			t.Fatalf("unexpected snapshot: %#v", got)
		}
	}
	usage, err := store.dailyUsage(wallet.WalletID, "solana:native", now)
	if err != nil || usage.String() != "125" {
		t.Fatalf("budget read changed usage: %v %v", usage, err)
	}
	now = now.Add(24 * time.Hour)
	got, err := store.policyBudgetV2(wallet.WalletID)
	if err != nil || got.Assets[0].Used != "0" || got.Assets[0].Remaining != "6500500" {
		t.Fatalf("new UTC day: %#v %v", got, err)
	}
	if _, err := store.policyBudgetV2("missing"); err == nil {
		t.Fatal("missing policy accepted")
	}
	service := &signerServiceV2{store: store, keys: keys}
	req := request{Op: "v2.policy.budget", WalletID: wallet.WalletID}
	if _, err := service.handle(req, signerConfig{}, false); err == nil {
		t.Fatal("application socket read allowed")
	}
	if _, err := service.handle(req, signerConfig{readOnly: true}, true); err != nil {
		t.Fatalf("read-only control denied: %v", err)
	}
	for _, invalid := range []string{"-1", "broken"} {
		if err := store.db.Update(func(tx *bolt.Tx) error {
			return tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2(wallet.WalletID, "solana:native", currentDayBucket(now)), []byte(invalid))
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.policyBudgetV2(wallet.WalletID); err == nil {
			t.Fatalf("accepted corrupt counter %s", invalid)
		}
	}
}
