package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestWENBTCIntentCandidateV1(t *testing.T) {
	raw, err := os.ReadFile("testdata/wen-btc-intent-candidate.json")
	if err != nil {
		t.Fatal(err)
	}
	var v signerWENBTCIntentV1
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for _, op := range []string{"acceptance", "acquisition"} {
		c := v
		c.Operation = op
		if err := validateWENBTCIntentV1(c); err != nil {
			t.Fatal(err)
		}
	}
	mutations := []func(*signerWENBTCIntentV1){
		func(c *signerWENBTCIntentV1) { c.Operation = "claim" }, func(c *signerWENBTCIntentV1) { c.DescriptorSHA256 = "" },
		func(c *signerWENBTCIntentV1) { c.OfferSHA256 = "ZZ" }, func(c *signerWENBTCIntentV1) { c.ProgramID = "invalid" },
		func(c *signerWENBTCIntentV1) { c.MaxCashRaw = "0" }, func(c *signerWENBTCIntentV1) { c.MaxCostRaw = "-1" },
		func(c *signerWENBTCIntentV1) { c.MaxFeeLamports = "05000" }, func(c *signerWENBTCIntentV1) { c.MaxRentLamports = "6500000" },
		func(c *signerWENBTCIntentV1) { c.MinFinalizedSlot = "0" }, func(c *signerWENBTCIntentV1) { c.ExpiresSlot = "100" },
		func(c *signerWENBTCIntentV1) { c.MaxCashRaw = "18446744073709551615" }, func(c *signerWENBTCIntentV1) { c.MaxCostRaw = "18446744073709551616" },
	}
	for i, mutate := range mutations {
		c := v
		mutate(&c)
		if validateWENBTCIntentV1(c) == nil {
			t.Fatalf("mutation %d accepted", i)
		}
	}
	for _, kind := range []string{intentWENBTCSubscriptionV1, intentSolanaNativeTransfer, "solana.satAction", "solana.vaultBondAction"} {
		if _, err := normalizeSignerIntentV2(signerIntentV2{Type: kind, WENBTC: &v, Destination: v.SourceAccount, Lamports: "1"}); err == nil {
			t.Fatalf("WEN metadata allowed on %s", kind)
		}
	}
	for _, kind := range signerV2Capabilities.IntentTypes {
		if kind == intentWENBTCSubscriptionV1 {
			t.Fatal("candidate advertised before execution implementation")
		}
	}
	t.Log("PASS 2 valid operations, 12 invalid semantic requests, 4 dispatch rejections; capability disabled")
}
