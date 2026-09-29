package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestWENMiningClaimBootstrapAdminReceiptV1(t *testing.T) {
	for _, mode := range []string{"valid", "wallet", "base", "intent", "hash", "status", "signed"} {
		t.Run(mode, func(t *testing.T) {

			v, owner, pins, _ := miningClaimRPCFixture(t, "sat")
			descriptor, pins := miningClaimReviewDescriptor(t, pins)
			v.DescriptorSHA256 = pins.DescriptorSHA256
			v.CapabilitySHA256 = pins.CapabilitySHA256
			body := wenMiningClaimBootstrapV1{Review: wenMiningClaimReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: owner.String(), Intent: v, Pins: pins, MaxSlotLag: 2, MaxTotalCostLamports: 5000}, Descriptor: descriptor}
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
			e := runSignerAdminCLI([]string{"wen-mining", "install-claim-review", "--control-socket", server.path, "--wallet-id", "miner"}, bytes.NewReader(input), &stdout, nil)
			sent := waitSignerAdminTestServer(t, server)
			if sent.Op != "v2.wenMining.claimReview.install" || sent.WalletID != "miner" {
				t.Fatal("wrong dispatch")
			}
			var got wenMiningClaimBootstrapV1
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
