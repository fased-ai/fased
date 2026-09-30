package main

import (
	"context"
	"strings"
	"testing"
)

func TestWENBondPurchaseV2ApplicationRejectsUncheckedInput(t *testing.T) {
	cases := []struct{ op, body string }{
		{"v2.wenBondPurchase.review.prepare", `{"requestId":"review-request-001","draftSha256":"x","rpc":"https://caller.invalid"}`},
		{"v2.wenBondPurchase.review.prepare", `{"requestId":"review-request-001","draftSha256":"x","message":"caller bytes"}`},
		{"v2.wenBondPurchase.journey", `{"requestId":"review-request-001","action":"recover","proof":{"proofId":"reused"}}`},
		{"v2.wenBondPurchase.journey", `{"requestId":"review-request-001","action":"execute"}`},
		{"v2.wenBondPurchase.journey", `{"requestId":"review-request-001","action":"cancel"}`},
		{"v2.wenBondPurchase.journey", `{"requestId":"review-request-001","action":"execute","proof":{"proofId":"x"},"blockhash":"replacement"}`},
		{"v2.wenBondPurchase.review.prepare", strings.Repeat("x", 2049)},
	}
	service := &signerServiceV2{}
	calls := 0
	for _, c := range cases {
		if _, e := service.bondPurchaseApplicationWithFactoryV2(context.Background(), request{Op: c.op, WalletID: "miner", Request: []byte(c.body)}, signerConfig{}, func(string) wenBondPurchaseExecutionRPCV2 { calls++; return nil }); e == nil {
			t.Fatal("unchecked application input accepted", c.op)
		}
	}
	if calls != 0 {
		t.Fatal("rejected input selected RPC")
	}
	// Source dispatch is registered, but malformed/missing protected configuration fails closed.
	for _, op := range []string{"v2.wenBondPurchase.review.prepare", "v2.wenBondPurchase.journey"} {
		if _, e := service.handle(request{Op: op, WalletID: "miner", Request: []byte(`{}`)}, signerConfig{}, false); e == nil {
			t.Fatal("unconfigured Bond dispatch admitted")
		}
	}
}

func TestWENBondPurchaseV2RuntimeAndControlBoundaries(t *testing.T) {
	service := &signerServiceV2{}
	for _, op := range []string{"v2.wenBondPurchase.review.prepare", "v2.wenBondPurchase.journey", "v2.wenBondPurchase.draft.install", "v2.wenBondPurchase.admission.install"} {
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
			if _, e := service.bondPurchaseAdminWithFactoryV2(context.Background(), req, signerConfig{}, false, func(string) wenBondPurchaseExecutionRPCV2 { calls++; return nil }); e == nil || calls != 0 {
				t.Fatal("application reached administrative RPC")
			}
		}
	}
}
