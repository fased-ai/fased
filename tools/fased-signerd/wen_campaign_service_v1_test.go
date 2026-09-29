package main

import (
	"context"
	"encoding/json"
	"testing"
)

func TestWENCampaignApplicationUnbound(t *testing.T) {
	for _, op := range []string{"v2.wenCampaign.review.prepare", "v2.wenCampaign.journey"} {
		for _, raw := range []string{`{}`, `{"requestId":"review-request-001","draftSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`, `{"requestId":"review-request-001","action":"execute","proof":{"proofId":"proof-1"}}`, `{"requestId":"review-request-001","action":"recover"}`, `{"requestId":"review-request-001","rpc":"https://override.invalid"}`} {
			var s *signerServiceV2
			calls := 0
			_, e := s.campaignApplicationWithFactoryV1(context.Background(), request{Op: op, WalletID: "miner", Request: json.RawMessage(raw)}, signerConfig{}, func(string) wenCampaignExecutionRPCV1 { calls++; return nil })
			if e == nil || calls != 0 {
				t.Fatal("unbound application reached RPC", op, e)
			}
		}
	}
}

func TestWENCampaignSocketAdmission(t *testing.T) {
	for _, op := range []string{"v2.wenCampaign.review.prepare", "v2.wenCampaign.journey"} {
		if err := mustValidate(request{Op: op, WalletID: "miner", Request: json.RawMessage(`{}`)}, signerConfig{}); err != nil {
			t.Fatal(op, err)
		}
		if err := mustValidate(request{Op: op, Request: json.RawMessage(`{}`)}, signerConfig{}); err == nil {
			t.Fatal("missing wallet admitted", op)
		}
	}
}
