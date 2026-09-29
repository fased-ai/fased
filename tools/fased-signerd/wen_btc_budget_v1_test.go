package main

import (
	"encoding/binary"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
)

func TestWENBTCDurableBudget(t *testing.T) {
	for _, name := range []string{"idempotent", "new-request-same-offer", "exhausted", "missing-scope", "changed-request", "restart", "concurrent"} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "budget.db")
			store, err := openSignerStoreV2(path)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { store.Close() }()
			root, pins, intent, wallet, _ := wenArtifactCase(t)
			a, err := loadWENBTCAcceptanceV1(root, pins, intent, wallet, 100, 1)
			if err != nil {
				t.Fatal(err)
			}
			exposure, err := wenBTCExposureV1(a, intent, wallet)
			if err != nil {
				t.Fatal(err)
			}
			scopes := wenBudgetScopesV1("buyer", intent, exposure)
			omitted := ""
			for scope, amount := range scopes {
				if name == "missing-scope" && omitted == "" {
					omitted = scope
					continue
				}
				if err = store.configureWENBudgetV1(scope, amount); err != nil {
					t.Fatal(err)
				}
			}
			if name == "concurrent" {
				var wg sync.WaitGroup
				results := make(chan error, 2)
				for _, id := range []string{"request-one", "request-two"} {
					wg.Add(1)
					go func(id string) {
						defer wg.Done()
						_, e := store.reserveWENBudgetV1(id, "buyer", a, intent, wallet)
						results <- e
					}(id)
				}
				wg.Wait()
				close(results)
				success := 0
				for e := range results {
					if e == nil {
						success++
					}
				}
				if success != 1 {
					t.Fatalf("concurrent successes: %d", success)
				}
			} else {
				existing, e := store.reserveWENBudgetV1("request-one", "buyer", a, intent, wallet)
				if name == "missing-scope" {
					if e == nil {
						t.Fatal("missing budget accepted")
					}
					for scope := range scopes {
						if scope == omitted {
							continue
						}
						n, e := store.wenBudgetReservedV1(scope)
						if e != nil || n != 0 {
							t.Fatal("partial reservation leaked")
						}
					}
					return
				}
				if e != nil || existing {
					t.Fatal("first reservation", e)
				}
				if name == "restart" {
					if e = store.Close(); e != nil {
						t.Fatal(e)
					}
					store, e = openSignerStoreV2(path)
					if e != nil {
						t.Fatal(e)
					}
				}
				request := "request-one"
				if name == "new-request-same-offer" {
					request = "request-two"
				}
				if name == "changed-request" {
					intent.MaxCashRaw = "999999999"
				}
				if name == "exhausted" {
					request = "request-two"
					a.numbers[0]++
					binary.LittleEndian.PutUint64(a.offer[328:], a.numbers[0])
					intent.OfferSHA256 = wenHashV1(a.offer[:])
				}
				existing, e = store.reserveWENBudgetV1(request, "buyer", a, intent, wallet)
				if name == "idempotent" || name == "restart" {
					if e != nil || !existing {
						t.Fatal("retry/restart lost reservation", e)
					}
				} else if e == nil {
					t.Fatal("duplicate or exhausted request accepted")
				}
			}
			for scope, want := range scopes {
				got, e := store.wenBudgetReservedV1(scope)
				if e != nil || got != want {
					t.Fatalf("wrong durable usage %d want %d: %v", got, want, e)
				}
			}
		})
	}
}

func TestWENBTCCustodyBudgetSharedAcrossPayers(t *testing.T) {
	store, err := openSignerStoreV2(filepath.Join(t.TempDir(), "budget.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, _, intent, _, _ := wenArtifactCase(t)
	a, wallet, _, _, _ := wenAcquisitionFixture(t)
	intent.Operation = "acquisition"
	intent.ProgramID = a.program.String()
	intent.OfferSHA256 = wenHashV1(a.offer[:])
	intent.MaxCashRaw = strconv.FormatUint(a.numbers[10], 10)
	intent.MaxCostRaw = strconv.FormatUint(a.numbers[12], 10)
	e, err := wenBTCExposureV1(a, intent, wallet)
	if err != nil {
		t.Fatal(err)
	}
	one, two := wenBudgetScopesV1("keeper_one", intent, e), wenBudgetScopesV1("keeper_two", intent, e)
	shared := 0
	for scope, amount := range one {
		if _, ok := two[scope]; ok {
			shared++
			if amount != e.CustodyCashRaw {
				t.Fatal("shared wallet debit")
			}
		}
		if err = store.configureWENBudgetV1(scope, amount); err != nil {
			t.Fatal(err)
		}
	}
	for scope, amount := range two {
		if err = store.configureWENBudgetV1(scope, amount); err != nil {
			t.Fatal(err)
		}
	}
	if shared != 1 || len(one) != 2 || len(two) != 2 {
		t.Fatal("custody not shared independently of payer")
	}
	if _, err = store.reserveWENBudgetV1("request-first", "keeper_one", a, intent, wallet); err != nil {
		t.Fatal(err)
	}
	if _, err = store.reserveWENBudgetV1("request-second", "keeper_two", a, intent, wallet); err == nil {
		t.Fatal("same funded offer reserved twice")
	}
	for scope := range two {
		if _, ok := one[scope]; ok {
			continue
		}
		n, err := store.wenBudgetReservedV1(scope)
		if err != nil || n != 0 {
			t.Fatal("failed second payer leaked fees")
		}
	}
}
