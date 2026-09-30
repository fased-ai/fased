package main

import (
	"context"
	"encoding/json"
	"testing"
)

func TestWENCampaignJourneyRejectsUnboundInput(t *testing.T) {
	for _, body := range []string{`{}`, `{"requestId":"review-request-001","action":"sign"}`, `{"requestId":"review-request-001","action":"execute"}`, `{"requestId":"review-request-001","action":"recover","proof":{"proofId":"x"}}`, `{"requestId":"review-request-001","action":"execute","proof":{"proofId":"x"},"rpc":"https://replacement.invalid"}`, `{"requestId":"review-request-001","action":"cancel","walletId":"other"}`} {
		var s *signerServiceV2
		calls := 0
		_, e := s.campaignJourneyWithFactoryV1(context.Background(), request{WalletID: "miner", Request: json.RawMessage(body)}, signerConfig{}, func(string) wenCampaignExecutionRPCV1 { calls++; return nil })
		if e == nil || calls != 0 {
			t.Fatal("unbound input", body, e)
		}
	}
}
