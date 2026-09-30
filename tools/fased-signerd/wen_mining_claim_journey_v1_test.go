package main

import (
	"context"
	"encoding/json"
	"testing"
)

func TestWENMiningClaimJourneyRejectsUnboundInput(t *testing.T) {
	for _, body := range []string{
		`{}`, `{"requestId":"state-request","action":"sign"}`,
		`{"requestId":"state-request","action":"execute"}`,
		`{"requestId":"state-request","action":"execute","proof":{"proofId":"x"},"rpc":"https://replacement.invalid"}`,
		`{"requestId":"state-request","action":"recover","proof":{"proofId":"x"}}`,
		`{"requestId":"state-request","action":"execute","proof":{"proofId":"x","extra":true}}`,
	} {
		var service *signerServiceV2
		calls := 0
		_, err := service.miningClaimJourneyWithFactoryV1(context.Background(), request{WalletID: "miner", Request: json.RawMessage(body)}, signerConfig{}, func(string) wenMiningClaimExecutionRPCV1 { calls++; return nil })
		if err == nil || calls != 0 {
			t.Fatal("invalid journey reached RPC", body, err)
		}
	}
}
