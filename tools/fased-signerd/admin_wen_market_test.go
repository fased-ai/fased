package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
)

func TestWENMarketAdminCLI(t *testing.T) {
	for _, action := range []string{"install-draft", "install-budget", "install-admission"} {
		for _, mode := range []string{"ok", "wallet", "hash", "status", "extra"} {
			t.Run(action+"/"+mode, func(t *testing.T) {
				var body any
				op := ""
				receipt := map[string]string{"walletId": "miner"}
				hash := wenHashV1([]byte("fixture artifact"))
				if action == "install-draft" {
					d := wenMarketDraftV1{Version: 1, WalletID: "miner"}
					raw, _ := json.Marshal(d)
					hash = wenHashV1(raw)
					body = wenMarketDraftInstallRequestV1{Draft: d, ExpectedSHA256: hash}
					op = "v2.wenMarket.draft.install"
					receipt["draftSha256"] = hash
					receipt["status"] = "draft-installed"
				} else {
					body = wenMarketAdmissionInstallRequestV1{RequestID: "review-request-001", ExpectedSHA256: hash}
					op = "v2.wenMarket.admission.install"
					receipt["requestId"] = "review-request-001"
					receipt["artifactDigest"] = hash
					receipt["status"] = "admission-installed"
					if action == "install-budget" {
						op = "v2.wenMarket.budget.install"
						receipt["status"] = "budget-installed"
					}
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
				e := runSignerAdminCLI([]string{"wen-market", action, "--control-socket", server.path, "--wallet-id", "miner"}, bytes.NewReader(input), &output, nil)
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

func TestWENMarketAdminCLIRejectsBeforeContact(t *testing.T) {
	for _, tc := range []struct {
		name, action, body string
		args               []string
	}{
		{name: "operator", action: "install-admission", body: `{}`, args: []string{"--operator-socket", "/tmp/operator.sock"}},
		{name: "extra-field", action: "install-admission", body: `{"requestId":"request-123","expectedSha256":"` + wenHashV1([]byte("fixture")) + `","sign":true}`},
		{name: "bad-digest", action: "install-admission", body: `{"requestId":"request-123","expectedSha256":"wrong"}`},
		{name: "oversize", action: "install-admission", body: string(bytes.Repeat([]byte("x"), 16385))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, `{}`))
			var output bytes.Buffer
			args := append([]string{"wen-market", tc.action, "--control-socket", server.path, "--wallet-id", "miner"}, tc.args...)
			if err := runSignerAdminCLI(args, bytes.NewBufferString(tc.body), &output, nil); err == nil || output.Len() != 0 {
				t.Fatal("unsafe input accepted")
			}
			select {
			case <-server.requests:
				t.Fatal("invalid input contacted signer")
			default:
			}
		})
	}
}
