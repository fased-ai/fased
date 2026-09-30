package main

import (
	"context"
	"encoding/json"
	"testing"
)

func TestWENCampaignAdminRejectsUnboundRequests(t *testing.T) {
	for _, op := range []string{"v2.wenCampaign.draft.install", "v2.wenCampaign.admission.install"} {
		for _, body := range []string{`{}`, `{"rpc":"https://replacement.invalid"}`, `{"requestId":"x","expectedSha256":"wrong"}`, `{"draft":{},"expectedSha256":"wrong","extra":true}`} {
			for _, control := range []bool{false, true} {
				var s *signerServiceV2
				calls := 0
				_, e := s.campaignAdminWithFactoryV1(context.Background(), request{Op: op, WalletID: "miner", Request: json.RawMessage(body)}, signerConfig{}, control, func(string) wenCampaignExecutionRPCV1 { calls++; return nil })
				if e == nil || calls != 0 {
					t.Fatal("invalid admin reached RPC", op, control, e)
				}
			}
		}
	}
}
