package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWENMiningPreimageAdminReceiptV1(t *testing.T) {
	for _, mode := range []string{"valid", "wallet", "key", "digest", "status", "signed", "secret-field"} {
		t.Run(mode, func(t *testing.T) {
			f := miningFixture(t)
			prep, _, v := miningPrepareSetup(t, f, "commit", "ok")
			raw, e := os.ReadFile(filepath.Join(prep.root, f.PreimageKey+".json"))
			if e != nil {
				t.Fatal(e)
			}
			defer zeroBytes(raw)
			var preimage wenMiningPreimageV1
			if e = json.Unmarshal(raw, &preimage); e != nil {
				t.Fatal(e)
			}
			body := wenMiningPreimageInstallV1{Intent: v, Preimage: preimage}
			receipt := wenMiningPreimageReceiptV1{Status: "preimage-installed", WalletID: "miner", PreimageKey: f.PreimageKey, CommitmentSHA256: v.CommitmentSHA256}
			switch mode {
			case "wallet":
				receipt.WalletID = "other"
			case "key":
				receipt.PreimageKey = strings.Repeat("0", 64)
			case "digest":
				receipt.CommitmentSHA256 = strings.Repeat("0", 64)
			case "status":
				receipt.Status = "pending"
			case "signed":
				receipt.SigningEnabled = true
			}
			response, _ := json.Marshal(receipt)
			if mode == "secret-field" {
				response = append([]byte(`{"salt":"must-not-echo",`), response[1:]...)
			}
			server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, string(response)))
			input, _ := json.Marshal(body)
			defer zeroBytes(input)
			var stdout bytes.Buffer
			e = runSignerAdminCLI([]string{"wen-mining", "install-preimage", "--control-socket", server.path, "--wallet-id", "miner"}, bytes.NewReader(input), &stdout, nil)
			sent := waitSignerAdminTestServer(t, server)
			if sent.Op != "v2.wenMining.preimage.install" || sent.WalletID != "miner" {
				t.Fatal("dispatch")
			}
			if (e == nil) != (mode == "valid") {
				t.Fatal("receipt result", e)
			}
			if mode != "valid" && stdout.Len() != 0 {
				t.Fatal("rejected receipt printed")
			}
			if strings.Contains(stdout.String(), preimage.Salt) || strings.Contains(stdout.String(), "allocation") {
				t.Fatal("secret in receipt")
			}
		})
	}
}
