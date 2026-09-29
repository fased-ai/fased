package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// A shared wire fixture prevents client and signer envelopes drifting independently.
func TestWENCampaignServiceWireContract(t *testing.T) {
	raw, err := os.ReadFile("../../src/wallet/fixtures/wen-campaign-service-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Requests  []json.RawMessage `json:"requests"`
		Responses []json.RawMessage `json:"responses"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Requests) != 4 || len(fixture.Responses) != 8 {
		t.Fatal("incomplete wire fixture")
	}
	equalJSON := func(want, got []byte) {
		t.Helper()
		var a, b any
		if err := json.Unmarshal(want, &a); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(got, &b); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(a, b) {
			t.Fatalf("wire mismatch: %s != %s", want, got)
		}
	}
	for _, wire := range fixture.Requests {
		var request wenMiningClaimJourneyRequestV1
		if err := decodeSignerAdminStrictJSON(wire, &request); err != nil {
			t.Fatal(err)
		}
		got, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		equalJSON(wire, got)
	}
	for _, wire := range fixture.Responses {
		var envelope struct {
			OK     bool                          `json:"ok"`
			Result wenMiningClaimJourneyResultV1 `json:"result"`
		}
		if err := decodeSignerAdminStrictJSON(wire, &envelope); err != nil {
			t.Fatal(err)
		}
		got, err := marshalSignerResultV2(envelope.Result)
		if err != nil {
			t.Fatal(err)
		}
		equalJSON(wire, got)
	}
}
