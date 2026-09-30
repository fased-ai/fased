package main

import (
	"context"
	"strings"
	"testing"
)

func TestWENMarketApplicationRejectsUncheckedInput(t *testing.T) {
	cases := []struct{ op, body string }{
		{"v2.wenMarket.review.prepare", `{"requestId":"review-request-001","draftSha256":"x","rpc":"https://caller.invalid"}`},
		{"v2.wenMarket.review.prepare", `{"requestId":"review-request-001","draftSha256":"x","message":"caller bytes"}`},
		{"v2.wenMarket.journey", `{"requestId":"review-request-001","action":"recover","proof":{"proofId":"reused"}}`},
		{"v2.wenMarket.journey", `{"requestId":"review-request-001","action":"execute"}`},
		{"v2.wenMarket.journey", `{"requestId":"review-request-001","action":"cancel"}`},
		{"v2.wenMarket.journey", `{"requestId":"review-request-001","action":"execute","proof":{"proofId":"x"},"blockhash":"replacement"}`},
		{"v2.wenMarket.review.prepare", strings.Repeat("x", 2049)},
	}
	service := &signerServiceV2{}
	calls := 0
	for _, c := range cases {
		if _, e := service.marketApplicationWithFactoryV1(context.Background(), request{Op: c.op, WalletID: "miner", Request: []byte(c.body)}, signerConfig{}, func(string) wenMarketExecutionRPCV1 { calls++; return nil }); e == nil {
			t.Fatal("unchecked application input accepted", c.op)
		}
	}
	if calls != 0 {
		t.Fatal("rejected input selected RPC")
	}
	// Source dispatch is registered, but malformed/missing protected configuration fails closed.
	for _, op := range []string{"v2.wenMarket.review.prepare", "v2.wenMarket.journey"} {
		if _, e := service.handle(request{Op: op, WalletID: "miner", Request: []byte(`{}`)}, signerConfig{}, false); e == nil {
			t.Fatal("unconfigured Buy dispatch admitted")
		}
	}
}

func TestWENMarketRuntimeAndControlBoundaries(t *testing.T) {
	service := &signerServiceV2{}
	for _, op := range []string{"v2.wenMarket.review.prepare", "v2.wenMarket.journey", "v2.wenMarket.draft.install", "v2.wenMarket.admission.install"} {
		req := request{Op: op, WalletID: "miner", Request: []byte(`{}`)}
		if e := mustValidate(req, signerConfig{}); e != nil {
			t.Fatal("runtime envelope rejected", op, e)
		}
		missing := req
		missing.WalletID = ""
		if mustValidate(missing, signerConfig{}) == nil {
			t.Fatal("missing owner admitted", op)
		}
		if _, e := service.handle(req, signerConfig{}, false); e == nil || e.Error() == "unsupported signer-v2 op" {
			t.Fatal("runtime did not reach guarded route", op, e)
		}
		if strings.HasSuffix(op, "install") {
			calls := 0
			if _, e := service.marketAdminWithFactoryV1(context.Background(), req, signerConfig{}, false, func(string) wenMarketExecutionRPCV1 { calls++; return nil }); e == nil || calls != 0 {
				t.Fatal("application reached administrative RPC")
			}
		}
	}
}
