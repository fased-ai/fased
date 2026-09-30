package main

import (
	"encoding/json"
	bolt "go.etcd.io/bbolt"
	"testing"
)

func testMiningRevealProposal(t *testing.T, store *signerStoreV2, request string) {
	t.Helper()
	var saved wenBudgetReservationV1
	if e := store.db.View(func(tx *bolt.Tx) error {
		return json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("request:"+request)), &saved)
	}); e != nil {
		t.Fatal(e)
	}
	testMiningClaimDiscovery(t, store, request, saved)
	for _, mode := range []string{"valid", "pending", "failed", "unsettled", "unobserved", "later-reveal", "earlier-slot", "bad-window", "entry", "signature", "digest", "operation"} {
		t.Run("proposal-"+mode, func(t *testing.T) {
			raw, _ := json.Marshal(saved)
			var copy wenBudgetReservationV1
			_ = json.Unmarshal(raw, &copy)
			minimum := copy.MiningObservedSlot
			expires := minimum + 32
			switch mode {
			case "pending":
				copy.State = "submission-uncertain"
			case "failed":
				copy.State = "finalized-failed"
			case "unsettled":
				copy.SuccessBudgetSettled = false
			case "unobserved":
				copy.MiningObservedSlot = 0
			case "later-reveal":
				copy.MiningObservedSHA256 = wenHashV1([]byte("already revealed"))
			case "earlier-slot":
				minimum--
			case "bad-window":
				expires = minimum
			case "entry":
				copy.MiningEntry.Data[80] ^= 1
			case "signature":
				copy.Signature = "bad"
			case "digest":
				copy.MiningIntent.CommitmentSHA256 = wenHashV1([]byte("other"))
			case "operation":
				copy.MiningIntent.Operation = "reveal"
			}
			result, e := proposeWENMiningRevealV1(copy, minimum, expires)
			if mode != "valid" {
				if e == nil {
					t.Fatal("unproven commit became reveal")
				}
				return
			}
			if e != nil || result.Operation != "reveal" || result.Capital != saved.MiningIntent.Capital || result.CommitmentSHA256 != saved.MiningIntent.CommitmentSHA256 || result.EntrySHA256 != saved.MiningObservedSHA256 {
				t.Fatal("proposal", e)
			}
			if _, _, e = loadWENMiningReviewV1(store.db.Path(), saved.WalletID, result); e == nil {
				t.Fatal("proposal granted review authority")
			}
			actual, e := store.proposeWENMiningRevealV1(request, saved.WalletID, minimum, expires)
			if e != nil || actual != result {
				t.Fatal("journal proposal", e)
			}
			if _, e = store.proposeWENMiningRevealV1(request, "other", minimum, expires); e == nil {
				t.Fatal("wrong wallet proposal")
			}
		})
	}
}
