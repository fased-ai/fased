package main

import (
	"bytes"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

func TestWENBTCPolicyBoundBudget(t *testing.T) {
	for _, name := range []string{"valid", "stale-hash", "operation", "program", "destination", "per-tx", "shared-usage", "rollback", "revoked-retry", "wrong-wallet", "rollover-restart", "legacy-record", "altered-claims", "invalid-day"} {
		t.Run(name, func(t *testing.T) {
			store, keys := openTestSignerV2(t)
			root, pins, intent, wallet, _ := wenArtifactCase(t)
			a, err := loadWENBTCAcceptanceV1(root, pins, intent, wallet, 100, 1)
			if err != nil {
				t.Fatal(err)
			}
			record, previous := createTestSignerWalletV2(t, store, keys, "buyer", a.keys[0].String(), 100, 100)
			wallet = solana.MustPublicKeyFromBase58(record.PublicKey)
			a.keys[2] = wallet
			copy(a.offer[72:104], wallet[:])
			intent.OfferSHA256 = wenHashV1(a.offer[:])
			e, err := wenBTCExposureV1(a, intent, wallet)
			if err != nil {
				t.Fatal(err)
			}
			native, cash := strconv.FormatUint(e.NativeLamports, 10), strconv.FormatUint(e.WalletCashRaw, 10)
			p := signerPolicyV2{WalletID: "buyer", Role: "agent", Operations: []string{intentWENBTCSubscriptionV1 + ".acceptance"}, Programs: []string{a.program.String(), solana.TokenProgramID.String()}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{a.keys[0].String()}, MaxPerTx: native, MaxDaily: native}, {Asset: "solana:spl:" + e.CashMint.String(), Destinations: []string{a.keys[0].String()}, MaxPerTx: cash, MaxDaily: cash}}}
			switch name {
			case "operation":
				p.Operations = []string{"unrelated"}
			case "program":
				p.Programs = []string{solana.TokenProgramID.String()}
			case "destination":
				p.Assets[0].Destinations = []string{wallet.String()}
			case "per-tx":
				p.Assets[0].MaxPerTx = "1"
			}
			p, err = store.putPolicy(p, previous.Version)
			if err != nil {
				t.Fatal(err)
			}
			scopes := wenBudgetScopesV1("buyer", intent, e)
			for scope, amount := range scopes {
				if name == "rollback" && amount == e.WalletCashRaw {
					continue
				}
				if err = store.configureWENBudgetV1(scope, amount); err != nil {
					t.Fatal(err)
				}
			}
			if name == "shared-usage" {
				err = store.db.Update(func(tx *bolt.Tx) error {
					return tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2("buyer", "solana:native", currentDayBucket(store.now())), []byte("1"))
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			hash := p.Hash
			if name == "stale-hash" {
				hash = previous.Hash
			}
			if name == "wrong-wallet" {
				wallet = solana.NewWallet().PublicKey()
			}
			_, err = store.reserveWENPolicyBudgetV1("policy-request", "buyer", hash, a, intent, wallet)
			success := name == "valid" || name == "revoked-retry" || name == "rollover-restart" || name == "legacy-record" || name == "altered-claims" || name == "invalid-day"
			if (err == nil) != success {
				t.Fatalf("unexpected reserve: %v", err)
			}
			used, err := store.dailyUsage("buyer", "solana:native", store.now())
			if err != nil {
				t.Fatal(err)
			}
			want := uint64(0)
			if success {
				want = e.NativeLamports
			}
			if name == "shared-usage" {
				want = 1
			}
			if used.Uint64() != want {
				t.Fatalf("daily usage %s want %d", used, want)
			}

			if name == "rollover-restart" || name == "legacy-record" || name == "altered-claims" || name == "invalid-day" {
				var before []byte
				if err := store.db.View(func(tx *bolt.Tx) error {
					before = append([]byte(nil), tx.Bucket(wenBudgetBucketV1).Get([]byte("request:policy-request"))...)
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				var saved struct {
					Version                        int
					WalletID, PolicyHash, UsageDay string
					WalletClaims                   map[string]uint64
				}
				if err := json.Unmarshal(before, &saved); err != nil {
					t.Fatal(err)
				}
				if saved.Version != 1 || saved.WalletID != "buyer" || saved.PolicyHash != hash || saved.UsageDay != currentDayBucket(store.now()) || saved.WalletClaims["solana:native"] != e.NativeLamports || saved.WalletClaims["solana:spl:"+e.CashMint.String()] != e.WalletCashRaw {
					t.Fatal("reservation recovery metadata missing or incorrect")
				}
				if name == "rollover-restart" {
					originalTime := store.now()
					path := store.db.Path()
					if err := store.Close(); err != nil {
						t.Fatal(err)
					}
					reopened, err := openSignerStoreV2(path)
					if err != nil {
						t.Fatal(err)
					}
					defer reopened.Close()
					reopened.now = func() time.Time { return originalTime.Add(24 * time.Hour) }
					existing, err := reopened.reserveWENPolicyBudgetV1("policy-request", "buyer", hash, a, intent, wallet)
					if err != nil || !existing {
						t.Fatal("restart retry", err)
					}
					for asset := range saved.WalletClaims {
						used, err := reopened.dailyUsage("buyer", asset, reopened.now())
						if err != nil || used.Sign() != 0 {
							t.Fatal("retry charged new day", err)
						}
					}
					var after []byte
					if err := reopened.db.View(func(tx *bolt.Tx) error {
						after = append([]byte(nil), tx.Bucket(wenBudgetBucketV1).Get([]byte("request:policy-request"))...)
						return nil
					}); err != nil {
						t.Fatal(err)
					}
					if !bytes.Equal(before, after) {
						t.Fatal("retry rewrote original reservation")
					}
					reopened.now = func() time.Time { return originalTime }
					store = reopened
				} else {
					var damaged map[string]any
					if err := json.Unmarshal(before, &damaged); err != nil {
						t.Fatal(err)
					}
					switch name {
					case "legacy-record":
						delete(damaged, "Version")
					case "altered-claims":
						damaged["WalletClaims"] = map[string]uint64{"solana:native": 1}
					case "invalid-day":
						damaged["UsageDay"] = "invalid"
					}
					raw, err := json.Marshal(damaged)
					if err != nil {
						t.Fatal(err)
					}
					if err := store.db.Update(func(tx *bolt.Tx) error {
						return tx.Bucket(wenBudgetBucketV1).Put([]byte("request:policy-request"), raw)
					}); err != nil {
						t.Fatal(err)
					}
					if _, err := store.reserveWENPolicyBudgetV1("policy-request", "buyer", hash, a, intent, wallet); err == nil {
						t.Fatal("incomplete recovery record reused")
					}
				}
			}
			if name == "valid" {
				existing, err := store.reserveWENPolicyBudgetV1("policy-request", "buyer", hash, a, intent, wallet)
				if err != nil || !existing {
					t.Fatal("idempotency", err)
				}
			}
			if name == "revoked-retry" {
				p.Operations = []string{}
				if _, err = store.putPolicy(p, p.Version); err != nil {
					t.Fatal(err)
				}
				if _, err = store.reserveWENPolicyBudgetV1("policy-request", "buyer", hash, a, intent, wallet); err == nil {
					t.Fatal("revoked policy reused")
				}
			}

			for asset, amount := range map[string]uint64{"solana:native": e.NativeLamports, "solana:spl:" + e.CashMint.String(): e.WalletCashRaw} {
				used, err := store.dailyUsage("buyer", asset, store.now())
				if err != nil {
					t.Fatal(err)
				}
				want := uint64(0)
				if success {
					want = amount
				}
				if name == "shared-usage" && asset == "solana:native" {
					want = 1
				}
				if used.Uint64() != want {
					t.Fatalf("%s usage after retry/rejection: %s want %d", asset, used, want)
				}
			}
			for scope, amount := range scopes {
				if name == "rollback" && amount == e.WalletCashRaw {
					continue
				}
				reserved, err := store.wenBudgetReservedV1(scope)
				if err != nil {
					t.Fatal(err)
				}
				want := uint64(0)
				if success {
					want = amount
				}
				if reserved != want {
					t.Fatalf("scope %s reserved %d want %d", scope, reserved, want)
				}
			}

		})
	}
}

func TestWENBTCPolicyAcquisitionBudget(t *testing.T) {
	for _, name := range []string{"valid", "missing-jupiter", "custody-exhausted"} {
		t.Run(name, func(t *testing.T) {
			store, keys := openTestSignerV2(t)
			_, _, intent, _, _ := wenArtifactCase(t)
			a, _, _, _, _ := wenAcquisitionFixture(t)
			record, previous := createTestSignerWalletV2(t, store, keys, "keeper", a.keys[0].String(), 100, 100)
			wallet := solana.MustPublicKeyFromBase58(record.PublicKey)
			intent.Operation = "acquisition"
			intent.ProgramID = a.program.String()
			intent.OfferSHA256 = wenHashV1(a.offer[:])
			intent.MaxCashRaw = strconv.FormatUint(a.numbers[10], 10)
			intent.MaxCostRaw = strconv.FormatUint(a.numbers[12], 10)
			e, err := wenBTCExposureV1(a, intent, wallet)
			if err != nil {
				t.Fatal(err)
			}
			native := strconv.FormatUint(e.NativeLamports, 10)
			p := signerPolicyV2{WalletID: "keeper", Role: "agent", Operations: []string{intentWENBTCSubscriptionV1 + ".acquisition"}, Programs: []string{a.program.String(), solana.TokenProgramID.String()}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{a.keys[0].String()}, MaxPerTx: native, MaxDaily: native}}}
			if name != "missing-jupiter" {
				p.Programs = append(p.Programs, a.keys[5].String())
			}
			p, err = store.putPolicy(p, previous.Version)
			if err != nil {
				t.Fatal(err)
			}
			scopes := wenBudgetScopesV1("keeper", intent, e)
			for scope, amount := range scopes {
				if name == "custody-exhausted" && amount == e.CustodyCashRaw {
					amount--
				}
				if err = store.configureWENBudgetV1(scope, amount); err != nil {
					t.Fatal(err)
				}
			}
			_, err = store.reserveWENPolicyBudgetV1("acquisition-request", "keeper", p.Hash, a, intent, wallet)
			if (err == nil) != (name == "valid") {
				t.Fatalf("unexpected acquisition result: %v", err)
			}
			for asset, amount := range map[string]uint64{"solana:native": e.NativeLamports, "solana:spl:" + e.CashMint.String(): 0} {
				used, err := store.dailyUsage("keeper", asset, store.now())
				if err != nil {
					t.Fatal(err)
				}
				if name != "valid" {
					amount = 0
				}
				if used.Uint64() != amount {
					t.Fatalf("wallet usage %s = %s want %d", asset, used, amount)
				}
			}
			for scope, amount := range scopes {
				reserved, err := store.wenBudgetReservedV1(scope)
				if err != nil {
					t.Fatal(err)
				}
				if name != "valid" {
					amount = 0
				}
				if reserved != amount {
					t.Fatalf("scope reserved %d want %d", reserved, amount)
				}
			}
		})
	}
}

func TestWENBTCReservationUsageRetention(t *testing.T) {
	for _, name := range []string{"current", "legacy", "malformed"} {
		t.Run(name, func(t *testing.T) {
			store, _ := openTestSignerV2(t)
			day := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
			store.now = func() time.Time { return day.Add(30 * 24 * time.Hour) }
			key := dailyUsageKeyV2("buyer", "solana:native", currentDayBucket(day))
			other := dailyUsageKeyV2("other", "solana:native", currentDayBucket(day))
			raw, err := json.Marshal(wenBudgetReservationV1{Version: 1, WalletID: "buyer", PolicyHash: "policy", UsageDay: currentDayBucket(day), WalletClaims: map[string]uint64{"solana:native": 10}})
			if err != nil {
				t.Fatal(err)
			}
			if name == "legacy" {
				raw = []byte(`{"Digest":"legacy"}`)
			}
			if name == "malformed" {
				raw = []byte(`{`)
			}
			if err := store.db.Update(func(tx *bolt.Tx) error {
				b, err := tx.CreateBucketIfNotExists(wenBudgetBucketV1)
				if err != nil {
					return err
				}
				if err := b.Put([]byte("request:retention-case"), raw); err != nil {
					return err
				}
				u := tx.Bucket(bucketSignerUsageV2)
				if err := u.Put(key, []byte("10")); err != nil {
					return err
				}
				return u.Put(other, []byte("20"))
			}); err != nil {
				t.Fatal(err)
			}
			if err := store.maintainStateV2(); err != nil {
				t.Fatal(err)
			}
			if err := store.db.View(func(tx *bolt.Tx) error {
				u := tx.Bucket(bucketSignerUsageV2)
				if string(u.Get(key)) != "10" {
					t.Fatal("outstanding reservation lost usage counter")
				}
				if (u.Get(other) != nil) != (name != "current") {
					t.Fatal("incorrect unrelated counter retention")
				}
				if !bytes.Equal(tx.Bucket(wenBudgetBucketV1).Get([]byte("request:retention-case")), raw) {
					t.Fatal("retention rewrote reservation")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWENTypedReservationUsageRetention(t *testing.T) {
	for _, prefix := range []string{"campaign-request:", "campaign-stake-request:", "market-request:", "bond-purchase-request:", "bond-claim-request:"} {
		for _, mode := range []string{"pending", "terminal-label-only", "settled", "retained-recovery", "malformed", "cancelled", "expired"} {
			t.Run(prefix+mode, func(t *testing.T) {
				store, _ := openTestSignerV2(t)
				day := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
				store.now = func() time.Time { return day.Add(30 * 24 * time.Hour) }
				version := 1
				if prefix == "bond-purchase-request:" || prefix == "bond-claim-request:" {
					version = 2
				}
				record := map[string]any{"Version": version, "State": "submission-uncertain", "UsageDay": currentDayBucket(day), "Artifact": map[string]any{"WalletID": "buyer"}}
				if mode != "pending" {
					record["State"] = "finalized-success"
				}
				if mode == "settled" || mode == "retained-recovery" {
					record["OutcomeDigest"] = "authenticated-outcome"
				}
				if mode == "retained-recovery" {
					record["RetainedRecovery"] = uint64(1)
				}
				if mode == "cancelled" || mode == "expired" {
					record["State"] = mode
				}
				raw, _ := json.Marshal(record)
				if mode == "malformed" {
					raw = []byte(`{`)
				}
				keys := [][]byte{dailyUsageKeyV2("buyer", "solana:native", currentDayBucket(day)), dailyUsageKeyV2("buyer", "solana:cash", currentDayBucket(day))}
				other := dailyUsageKeyV2("other", "solana:native", currentDayBucket(day))
				if err := store.db.Update(func(tx *bolt.Tx) error {
					b, e := tx.CreateBucketIfNotExists(wenBudgetBucketV1)
					if e != nil {
						return e
					}
					if e = b.Put([]byte(prefix+"retention-case"), raw); e != nil {
						return e
					}
					u := tx.Bucket(bucketSignerUsageV2)
					for _, k := range keys {
						if e = u.Put(k, []byte("10")); e != nil {
							return e
						}
					}
					return u.Put(other, []byte("20"))
				}); err != nil {
					t.Fatal(err)
				}
				if err := store.maintainStateV2(); err != nil {
					t.Fatal(err)
				}
				if err := store.db.View(func(tx *bolt.Tx) error {
					u := tx.Bucket(bucketSignerUsageV2)
					for _, k := range keys {
						if (string(u.Get(k)) == "10") != (mode != "settled" && mode != "cancelled" && mode != "expired") {
							t.Fatal("typed pending reservation lost usage", string(k))
						}
					}
					if (u.Get(other) != nil) != (mode == "malformed") {
						t.Fatal("unrelated wallet retained")
					}
					if !bytes.Equal(tx.Bucket(wenBudgetBucketV1).Get([]byte(prefix+"retention-case")), raw) {
						t.Fatal("reservation rewritten")
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}
