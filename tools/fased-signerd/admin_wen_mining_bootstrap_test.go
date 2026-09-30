package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestWENMiningBootstrapAdminReceiptV1(t *testing.T) {
	for _, mode := range []string{"valid", "wallet", "base", "intent", "hash", "status", "signed"} {
		t.Run(mode, func(t *testing.T) {
			f := miningFixture(t)
			v := f.Intent
			descriptor, pins := miningDescriptorFixture(t, wenMiningPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, CodeSHA256: wenHashV1([]byte("bootstrap")), DeploymentSlot: 5})
			v.DescriptorSHA256 = pins.DescriptorSHA256
			v.CapabilitySHA256 = pins.CapabilitySHA256
			body := wenMiningBootstrapV1{Review: wenMiningReviewV1{Version: 2, WalletID: "miner", WalletPublicKey: f.Wallet, Intent: v, Pins: pins, MaxSlotLag: 2}, Descriptor: descriptor}
			intent, _ := json.Marshal(v)
			review, _ := json.Marshal(body.Review)
			receipt := wenMiningReviewReceiptV1{Status: "review-installed", WalletID: "miner", IntentSHA256: wenHashV1(intent), ReviewSHA256: wenHashV1(review)}
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
			e := runSignerAdminCLI([]string{"wen-mining", "install-commit-review", "--control-socket", server.path, "--wallet-id", "miner"}, bytes.NewReader(input), &stdout, nil)
			sent := waitSignerAdminTestServer(t, server)
			if sent.Op != "v2.wenMining.bootstrap.install" || sent.WalletID != "miner" {
				t.Fatal("wrong dispatch")
			}
			var got wenMiningBootstrapV1
			decodeSignerAdminTestBody(t, sent, &got)
			if !reflect.DeepEqual(got, body) {
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
