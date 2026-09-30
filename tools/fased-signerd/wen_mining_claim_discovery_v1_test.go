package main

import (
	"context"
	"encoding/json"
	bolt "go.etcd.io/bbolt"
	"testing"
)

func testMiningClaimDiscovery(t *testing.T, store *signerStoreV2, request string, saved wenBudgetReservationV1) {
	t.Helper()
	ctx := context.Background()
	page, e := store.discoverWENMiningClaimsV1(ctx, saved.WalletID, saved.WalletPublicKey, "", 100)
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, item := range page.Candidates {
		if item.CommitRequest == request {
			found = true
			if item.Status != "requires-settlement-readback" || item.Intent != *saved.MiningIntent {
				t.Fatal("candidate changed")
			}
		}
	}
	if !found || page.SigningEnabled {
		t.Fatal("missing unsigned candidate")
	}
	cursor := ""
	seen := map[string]bool{}
	complete := false
	for i := 0; i < 100; i++ {
		p, e := store.discoverWENMiningClaimsV1(ctx, saved.WalletID, saved.WalletPublicKey, cursor, 1)
		if e != nil || p.Scanned > 1 {
			t.Fatal("bounded page", e)
		}
		for _, item := range p.Candidates {
			if seen[item.CommitRequest] {
				t.Fatal("duplicate page item")
			}
			seen[item.CommitRequest] = true
		}
		if p.Complete {
			complete = true
			break
		}
		if p.Cursor == cursor {
			t.Fatal("cursor stalled")
		}
		cursor = p.Cursor
	}
	if !complete || !seen[request] {
		t.Fatal("incomplete pagination")
	}
	key := []byte("request:" + request)
	original, _ := json.Marshal(saved)
	for _, mode := range []string{"pending", "failed", "missing-entry", "changed-entry", "unsettled", "signature", "index", "owner", "cancelled", "limit"} {
		t.Run("discovery-"+mode, func(t *testing.T) {
			var copy wenBudgetReservationV1
			json.Unmarshal(original, &copy)
			limit := 100
			owner := saved.WalletPublicKey
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			index := []byte("mining-action:" + wenHashV1([]byte(saved.MiningIntent.Genesis+":"+saved.MiningIntent.ProgramID+":"+saved.MiningIntent.Entry+":commit")))
			if e := store.db.Update(func(tx *bolt.Tx) error {
				b := tx.Bucket(wenBudgetBucketV1)
				switch mode {
				case "failed":
					copy.State = "finalized-failed"
				case "missing-entry":
					copy.State = "reserved"
					copy.MiningEntry = nil
				case "changed-entry":
					copy.State = "signing"
					copy.MiningEntry.Data[80] ^= 1
				case "pending":
					copy.State = "submission-uncertain"
				case "unsettled":
					copy.SuccessBudgetSettled = false
				case "signature":
					copy.Signature = "bad"
				case "index":
					if e := b.Put(index, []byte("wrong-request")); e != nil {
						return e
					}
				case "owner":
					owner = "other"
				case "cancelled":
					cancel()
				case "limit":
					limit = 101
				}
				raw, _ := json.Marshal(copy)
				return b.Put(key, raw)
			}); e != nil {
				t.Fatal(e)
			}
			defer func() {
				if e := store.db.Update(func(tx *bolt.Tx) error {
					b := tx.Bucket(wenBudgetBucketV1)
					if e := b.Put(index, []byte(request)); e != nil {
						return e
					}
					return b.Put(key, original)
				}); e != nil {
					t.Fatal(e)
				}
			}()
			p, e := store.discoverWENMiningClaimsV1(ctx, saved.WalletID, owner, "", limit)
			if mode == "pending" || mode == "unsettled" || mode == "failed" {
				if e != nil {
					t.Fatal(e)
				}
				found := false
				for _, v := range p.Candidates {
					if v.CommitRequest == request {
						found = true
						if v.Source != "accepted-entry-snapshot" || v.Status != "requires-settlement-readback" {
							t.Fatal("accepted snapshot promoted")
						}
					}
				}
				if !found {
					t.Fatal("accepted entry lost")
				}
			} else if mode == "missing-entry" {
				if e != nil {
					t.Fatal(e)
				}
				for _, v := range p.Candidates {
					if v.CommitRequest == request {
						t.Fatal("unprepared candidate")
					}
				}
			} else if e == nil {
				t.Fatal("invalid discovery accepted", mode)
			}
		})
	}
}
