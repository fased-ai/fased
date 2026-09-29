package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestWENBTCPreparationReviewLimits(t *testing.T) {
	for _, name := range []string{"valid", "missing", "zero-units", "high-units", "no-tables", "duplicate", "bad-key", "bad-hash", "uppercase-hash"} {
		t.Run(name, func(t *testing.T) {
			_, _, review, _ := wenReviewFixture(t)
			_, _, pins, _, _ := wenMessageFixture(t, "acceptance")
			raw, _ := json.Marshal(map[string]any{"computeUnits": 200000, "lookups": []map[string]string{{"address": pins[0].key.String(), "sha256": pins[0].digest}}})
			review.Preparation = &signerWENBTCPreparationReviewV1{}
			json.Unmarshal(raw, review.Preparation)
			switch name {
			case "missing":
				review.Preparation = nil
			case "zero-units":
				review.Preparation.ComputeUnits = 0
			case "high-units":
				review.Preparation.ComputeUnits = 1400001
			case "no-tables":
				review.Preparation.Lookups = nil
			case "duplicate":
				review.Preparation.Lookups = append(review.Preparation.Lookups, review.Preparation.Lookups[0])
			case "bad-key":
				review.Preparation.Lookups[0].Address = "bad"
			case "bad-hash":
				review.Preparation.Lookups[0].SHA256 = "ab"
			case "uppercase-hash":
				review.Preparation.Lookups[0].SHA256 = strings.ToUpper(review.Preparation.Lookups[0].SHA256)
			}
			got, err := review.preparationPins()
			if (err == nil) != (name == "valid") {
				t.Fatalf("unexpected review result %v", err)
			}
			if name == "valid" && got[0] != pins[0] {
				t.Fatal("pin binding changed")
			}
		})
	}
}

func TestWENBTCJoinedPreparationService(t *testing.T) {
	for _, operation := range []string{"acceptance", "acquisition"} {
		t.Run(operation, func(t *testing.T) {
			service, cfg, review, calls := wenJoinedServiceCase(t, operation, "")
			body, _ := json.Marshal(review.Intent)
			req := request{Op: "v2.wenBtc.prepare", WalletID: "buyer", Request: body}
			if err := mustValidate(req, cfg); err != nil {
				t.Fatal(err)
			}
			if !applicationUpdateGateReadOperations[req.Op] {
				t.Fatal("preparation must remain read-only")
			}
			before := calls.Load()
			raw, err := service.handle(req, cfg, false)
			if err != nil {
				t.Fatal(err)
			}
			var response struct {
				OK     bool                            `json:"ok"`
				Result signerWENBTCPreparationResultV1 `json:"result"`
			}
			if err = json.Unmarshal(raw, &response); err != nil {
				t.Fatal(err)
			}
			result := response.Result
			if !response.OK || result.Status != "requires-signing-revalidation" || result.SigningEnabled || result.Operation != operation || result.OfferSHA256 != review.Pins.OfferSHA256 || result.MinimumSlot != 150 || result.CurrentHeight != 10 || result.LastValidHeight != 20 || len(result.Message) == 0 || result.Message[0] != 128 {
				t.Fatal("invalid prepared service result")
			}
			if calls.Load()-before < 10 {
				t.Fatal("service skipped required fresh observations")
			}
			var wire map[string]any
			json.Unmarshal(raw, &wire)
			encoded := wire["result"].(map[string]any)
			if encoded["messageBase64"] != base64.StdEncoding.EncodeToString(result.Message) || encoded["lastValidHeight"] != "20" {
				t.Fatal("unsafe wire encoding")
			}
		})
	}
}

func TestWENBTCPreparationServiceRequiresReviewBeforeRPC(t *testing.T) {
	service, cfg, review, calls := wenJoinedServiceCase(t, "acceptance", "")
	root, err := wenBTCReviewDirectoryV1(cfg.stateDBPath, "buyer")
	if err != nil {
		t.Fatal(err)
	}
	review.Preparation = nil
	writeWENReviewTest(t, root, review)
	raw, _ := json.Marshal(review.Intent)
	before := calls.Load()
	_, err = service.handle(request{Op: "v2.wenBtc.prepare", WalletID: "buyer", Request: raw}, cfg, false)
	if err == nil || !strings.Contains(err.Error(), "reviewed compute") || calls.Load() != before {
		t.Fatalf("unreviewed preparation reached RPC: %v", err)
	}
}
