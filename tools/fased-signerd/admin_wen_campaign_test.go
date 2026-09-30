package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
)

func TestWENCampaignAdminCLI(t *testing.T) {
	for _, action := range []string{"install-draft", "install-admission"} {
		for _, mode := range []string{"ok", "wallet", "hash", "status", "extra"} {
			t.Run(action+"/"+mode, func(t *testing.T) {
				var body any
				op := ""
				receipt := map[string]string{"walletId": "miner"}
				hash := wenHashV1([]byte("fixture artifact"))
				if action == "install-draft" {
					d := wenCampaignDraftV1{Version: 1, WalletID: "miner"}
					raw, _ := json.Marshal(d)
					hash = wenHashV1(raw)
					body = wenCampaignDraftInstallRequestV1{Draft: d, ExpectedSHA256: hash}
					op = "v2.wenCampaign.draft.install"
					receipt["draftSha256"] = hash
					receipt["status"] = "draft-installed"
				} else {
					body = wenCampaignAdmissionInstallRequestV1{RequestID: "review-request-001", ExpectedSHA256: hash}
					op = "v2.wenCampaign.admission.install"
					receipt["requestId"] = "review-request-001"
					receipt["artifactDigest"] = hash
					receipt["status"] = "admission-installed"
				}
				switch mode {
				case "wallet":
					receipt["walletId"] = "other"
				case "hash":
					if action == "install-draft" {
						receipt["draftSha256"] = "wrong"
					} else {
						receipt["artifactDigest"] = "wrong"
					}
				case "status":
					receipt["status"] = "pending"
				case "extra":
					receipt["signingEnabled"] = "true"
				}
				raw, _ := json.Marshal(receipt)
				server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, string(raw)))
				input, _ := json.Marshal(body)
				var output bytes.Buffer
				e := runSignerAdminCLI([]string{"wen-campaign", action, "--control-socket", server.path, "--wallet-id", "miner"}, bytes.NewReader(input), &output, nil)
				sent := waitSignerAdminTestServer(t, server)
				if sent.Op != op || sent.WalletID != "miner" {
					t.Fatal("wrong route")
				}
				var got, want any
				json.Unmarshal(sent.Request, &got)
				json.Unmarshal(input, &want)
				if !reflect.DeepEqual(got, want) {
					t.Fatal("payload changed")
				}
				if mode == "ok" {
					if e != nil || output.Len() == 0 {
						t.Fatal(e)
					}
				} else if e == nil || output.Len() != 0 {
					t.Fatal("unbound receipt accepted")
				}
			})
		}
	}
}
