package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

// Regression for the historical deposit-only participant policy: exit admission
// adds one typed action without changing existing principal-transfer limits.
func TestLegacyParticipantExitPolicyAdmission(t *testing.T) {
	var oldPolicy, candidate signerPolicyV2
	var raw signerIntentV2
	for _, x := range []struct {
		data   string
		target any
	}{
		{`{
  "walletId": "p4_009_participant",
  "role": "vault",
  "version": 2,
  "operations": [
    "agentCapital.deposit_capital_offer_generation@FASJ6eaNMEe6K3DdXBT6ZbkfDFSjGBtxbNTVn9htXFKz"
  ],
  "programs": [
    "FASJ6eaNMEe6K3DdXBT6ZbkfDFSjGBtxbNTVn9htXFKz"
  ],
  "assets": [
    {
      "asset": "solana:native",
      "destinations": [
        "FASJ6eaNMEe6K3DdXBT6ZbkfDFSjGBtxbNTVn9htXFKz"
      ],
      "maxPerTx": "1006500000",
      "maxDaily": "1006500000"
    }
  ],
  "hash": "sha256:d7dc66dfa651359c4c1250db11aef9b5e0f3ef7dcd60e64a4cc83abd00006bc3"
}
`, &oldPolicy}, {`{
  "walletId": "p4_009_participant",
  "role": "vault",
  "operations": [
    "agentCapital.deposit_capital_offer_generation@FASJ6eaNMEe6K3DdXBT6ZbkfDFSjGBtxbNTVn9htXFKz",
    "agentCapital.request_vault_exit@FASJ6eaNMEe6K3DdXBT6ZbkfDFSjGBtxbNTVn9htXFKz"
  ],
  "programs": [
    "FASJ6eaNMEe6K3DdXBT6ZbkfDFSjGBtxbNTVn9htXFKz"
  ],
  "assets": [
    {
      "asset": "solana:native",
      "destinations": [
        "FASJ6eaNMEe6K3DdXBT6ZbkfDFSjGBtxbNTVn9htXFKz"
      ],
      "maxPerTx": "1006500000",
      "maxDaily": "1006500000"
    },
    {
      "asset": "agent-capital:action",
      "destinations": [
        "FASJ6eaNMEe6K3DdXBT6ZbkfDFSjGBtxbNTVn9htXFKz"
      ],
      "maxPerTx": "1",
      "maxDaily": "1"
    }
  ]
}
`, &candidate}, {`{"action": "request_vault_exit", "programId": "FASJ6eaNMEe6K3DdXBT6ZbkfDFSjGBtxbNTVn9htXFKz", "dataBase64": "oLZf3tZt2tE=", "keys": [{"pubkey": "FeSkvANgR6sQV3yDPnhAiekXNuTdQVcugAtXfrrnkXUJ", "isSigner": true, "isWritable": false}, {"pubkey": "CtpAVnHPct3MjrFzsAmKGbrosH77xDhpw4my9TSRrQJt", "isSigner": false, "isWritable": false}, {"pubkey": "Cj32KtRBnYNe58DpyyMo5ZUb6pRhmi4XQPofxutxxrAR", "isSigner": false, "isWritable": true}, {"pubkey": "GMDkPiHTcL47yF3nkZ9TDFCHaehxn3SGURz9kHHdKGPg", "isSigner": false, "isWritable": true}, {"pubkey": "G3rfa84iPukz99UGeW57B3PnADUC2ENYHm7haXvhXiSd", "isSigner": false, "isWritable": false}, {"pubkey": "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF", "isSigner": false, "isWritable": false}], "type": "solana.agentCapitalAction", "cluster": "devnet"}`, &raw},
	} {
		if err := json.Unmarshal([]byte(x.data), x.target); err != nil {
			t.Fatal(err)
		}
	}
	wallet := solana.MustPublicKeyFromBase58("FeSkvANgR6sQV3yDPnhAiekXNuTdQVcugAtXfrrnkXUJ")
	intent, err := normalizeAgentCapitalIntentV2(raw, wallet)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = policyReservationsForIntentV2(oldPolicy, intent); err == nil {
		t.Fatal("deposit-only policy admitted exit")
	}
	candidate, err = normalizeSignerPolicyV2(candidate)
	if err != nil {
		t.Fatal(err)
	}
	reservations, err := policyReservationsForIntentV2(candidate, intent)
	if err != nil {
		t.Fatal(err)
	}
	if len(reservations) != 2 || reservations[0].Asset != "agent-capital:action" || reservations[1].Asset != "solana:native" {
		t.Fatal("missing separate fee reservation")
	}
	if len(candidate.Operations) != 2 || len(candidate.Programs) != 1 || len(candidate.Assets) != 2 {
		t.Fatal("unexpected authority expansion")
	}
	for _, a := range candidate.Assets {
		if a.Asset == "solana:native" && (a.MaxPerTx != "1006500000" || a.MaxDaily != "1006500000") {
			t.Fatal("existing SOL caps changed")
		}
		if a.Asset == "agent-capital:action" && (a.MaxPerTx != "1" || a.MaxDaily != "1") {
			t.Fatal("unbounded action budget")
		}
	}
	denied := intent
	denied.PolicyOperation = "agentCapital.finalize_vault_exit@" + agentCapitalProgramIDV1
	if _, err = policyReservationsForIntentV2(candidate, denied); err == nil {
		t.Fatal("unrequested finalize permission")
	}
	denied = intent
	denied.RequiredRole = "agent"
	if _, err = policyReservationsForIntentV2(candidate, denied); err == nil {
		t.Fatal("wrong role admitted")
	}
}
