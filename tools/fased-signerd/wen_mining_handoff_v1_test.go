package main

import (
	"context"
	"encoding/json"
	bolt "go.etcd.io/bbolt"
	"testing"
	"time"
)

func testMiningHandoff(t *testing.T, s *signerServiceV2, cfg signerConfig, c *miningConfiguredHook, v signerWENMiningIntentV1) {
	t.Helper()
	for _, mode := range []string{"requires-review", "wallet", "missing-request", "bounds", "window", "cancelled", "signing", "wrong-reveal-index"} {
		t.Run("handoff-"+mode, func(t *testing.T) {
			wallet, request := "miner", c.request
			minimum, expires := uint64(150), uint64(182)
			ticks := 2
			if mode == "wallet" {
				wallet = "other"
			}
			if mode == "missing-request" {
				request = "missing-request"
			}
			if mode == "bounds" {
				ticks = 0
			}
			if mode == "window" {
				expires = minimum
			}
			key := []byte("request:" + c.request)
			revealIndex := []byte("mining-action:" + wenHashV1([]byte(v.Genesis+":"+v.ProgramID+":"+v.Entry+":reveal")))
			var original []byte
			if e := s.store.db.Update(func(tx *bolt.Tx) error {
				b := tx.Bucket(wenBudgetBucketV1)
				original = append([]byte(nil), b.Get(key)...)
				if mode == "wrong-reveal-index" {
					return b.Put(revealIndex, []byte(c.request))
				}
				if mode == "cancelled" || mode == "signing" {
					var saved wenBudgetReservationV1
					_ = json.Unmarshal(original, &saved)
					saved.State = mode
					raw, _ := json.Marshal(saved)
					return b.Put(key, raw)
				}
				return nil
			}); e != nil {
				t.Fatal(e)
			}
			defer func() {
				if e := s.store.db.Update(func(tx *bolt.Tx) error {
					b := tx.Bucket(wenBudgetBucketV1)
					if e := b.Put(key, original); e != nil {
						return e
					}
					return b.Delete(revealIndex)
				}); e != nil {
					t.Fatal(e)
				}
			}()
			beforeSends, beforeSim := c.sends, c.simulations
			proposal, _, status, e := s.continueMiningRevealWithFactoryV1(context.Background(), cfg, request, "new-reveal-request", wallet, minimum, expires, time.Second, ticks, func(string) wenMiningExecutionRPCV1 { return c })
			switch mode {
			case "requires-review":
				if e != nil || status != "requires-review" || proposal.Operation != "reveal" {
					t.Fatal(status, e)
				}
			case "cancelled":
				if e != nil || status != "cancelled" {
					t.Fatal(status, e)
				}
			case "signing":
				if e != nil || status != "recovery-required" {
					t.Fatal(status, e)
				}
			default:
				if e == nil {
					t.Fatal("invalid handoff accepted", status)
				}
			}
			if c.sends != beforeSends || c.simulations != beforeSim {
				t.Fatal("unreviewed handoff executed")
			}
		})
	}
}
