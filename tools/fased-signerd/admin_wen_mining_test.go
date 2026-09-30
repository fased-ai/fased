package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestWENMiningAdminReceiptV1(t *testing.T) {
	for _, mode := range []string{"valid", "wallet", "base", "intent", "hash", "status", "signed"} {
		t.Run(mode, func(t *testing.T) {
			v := miningFixture(t).Intent
			v.Operation = "reveal"
			body := wenMiningReviewInstallV1{CommitRequest: "mining-commit", BaseReviewSHA256: strings.Repeat("a", 64), Intent: v}
			intent, _ := json.Marshal(v)
			receipt := wenMiningReviewReceiptV1{Status: "review-installed", WalletID: "miner", BaseReviewSHA256: body.BaseReviewSHA256, IntentSHA256: wenHashV1(intent), ReviewSHA256: strings.Repeat("b", 64)}
			switch mode {
			case "wallet":
				receipt.WalletID = "other"
			case "base":
				receipt.BaseReviewSHA256 = strings.Repeat("c", 64)
			case "intent":
				receipt.IntentSHA256 = strings.Repeat("c", 64)
			case "hash":
				receipt.ReviewSHA256 = "bad"
			case "status":
				receipt.Status = "pending"
			case "signed":
				receipt.SigningEnabled = true
			}
			raw, _ := json.Marshal(receipt)
			server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, string(raw)))
			input, _ := json.Marshal(body)
			var stdout bytes.Buffer
			e := runSignerAdminCLI([]string{"wen-mining", "install-reveal-review", "--control-socket", server.path, "--wallet-id", "miner"}, bytes.NewReader(input), &stdout, nil)
			sent := waitSignerAdminTestServer(t, server)
			if sent.Op != "v2.wenMining.review.install" || sent.WalletID != "miner" {
				t.Fatal("wrong dispatch")
			}
			var got wenMiningReviewInstallV1
			decodeSignerAdminTestBody(t, sent, &got)
			if got != body {
				t.Fatal("request changed")
			}
			if mode == "valid" {
				if e != nil || stdout.Len() == 0 {
					t.Fatal(e)
				}
			} else if e == nil || stdout.Len() != 0 {
				t.Fatal("unbound receipt accepted")
			}
		})
	}
}
