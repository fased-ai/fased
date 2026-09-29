package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestWENMiningClaimRecoveryRequest(t *testing.T) {
	_, _, pins, _ := miningClaimRPCFixture(t, "sol")
	raw, pins := miningClaimReviewDescriptor(t, pins)
	for _, mode := range []string{"unknown", "duplicate", "large", "leading-zero", "negative", "overflow", "expiry", "fee", "lag", "limit", "cursor", "descriptor"} {
		t.Run(mode, func(t *testing.T) {
			body := wenMiningClaimRecoveryRequestV1{Limit: 1, Operation: "sol", Pins: pins, Descriptor: raw, MinFinalizedSlot: "100", ExpiresSlot: "132", MaxFeeLamports: "5000", MaxSlotLag: "2"}
			switch mode {
			case "leading-zero":
				body.MinFinalizedSlot = "0100"
			case "negative":
				body.MinFinalizedSlot = "-1"
			case "overflow":
				body.MinFinalizedSlot = "18446744073709551616"
			case "expiry":
				body.ExpiresSlot = "133"
			case "fee":
				body.MaxFeeLamports = "0"
			case "lag":
				body.MaxSlotLag = "33"
			case "limit":
				body.Limit = 11
			case "cursor":
				body.Cursor = "../admission.json"
			case "descriptor":
				body.Descriptor = []byte("{}")
			}
			encoded, _ := json.Marshal(body)
			if mode == "unknown" {
				encoded = append([]byte(`{"rpc":"https://untrusted.invalid",`), encoded[1:]...)
			}
			if mode == "duplicate" {
				encoded = append([]byte(`{"limit":1,`), encoded[1:]...)
			}
			if mode == "large" {
				encoded = []byte(strings.Repeat(" ", 65537))
			}
			var svc *signerServiceV2
			calls := 0
			out, err := svc.recoverWENMiningClaimsWithFactoryV1(context.Background(), request{WalletID: "miner", Request: encoded}, signerConfig{}, func(string) signerWENBTCReadRPCV1 { calls++; return nil })
			if err == nil || out != nil || calls != 0 {
				t.Fatal("invalid recovery admitted", err)
			}
		})
	}
	// Reaches the service parser through the application's actual dispatcher.
	svc := &signerServiceV2{}
	_, err := svc.handle(request{Op: "v2.wenMining.claim.recover", WalletID: "miner", Request: json.RawMessage(`{}`)}, signerConfig{readOnly: true}, false)
	if err == nil || !strings.Contains(err.Error(), "invalid mining claim recovery request") {
		t.Fatal("dispatch", err)
	}
	if !applicationUpdateGateReadOperations["v2.wenMining.claim.recover"] {
		t.Fatal("read classification")
	}
}
