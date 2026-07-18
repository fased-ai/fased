package main

import (
	"encoding/json"
	"testing"
)

func TestSignerEnvelopeRejectsUnknownDuplicateAndTrailingJSON(t *testing.T) {
	tests := map[string]string{
		"unknown top-level field": `{"op":"health","unexpected":true}`,
		"non-canonical operation": `{"Op":"health"}`,
		"duplicate operation":     `{"op":"health","op":"v2.capabilities"}`,
		"case-folded duplicate":   `{"op":"health","Op":"v2.capabilities"}`,
		"duplicate nested field":  `{"op":"v2.execute","walletId":"agent","request":{"requestId":"one","requestId":"two"}}`,
		"trailing object":         `{"op":"health"}{"op":"health"}`,
		"non-object":              `["health"]`,
	}
	for name, input := range tests {
		t.Run(name, func(t *testing.T) {
			if _, _, err := decodeSignerEnvelopeV2([]byte(input)); err == nil {
				t.Fatalf("unsafe signer envelope was accepted: %s", input)
			}
		})
	}

	req, fingerprintInput, err := decodeSignerEnvelopeV2([]byte(`{"op":"v2.policy.get","walletId":"agent","request":{"expectedVersion":1}}`))
	if err != nil {
		t.Fatalf("valid signer envelope was rejected: %v", err)
	}
	if req.Op != "v2.policy.get" || req.WalletID != "agent" || len(req.Request) == 0 || fingerprintInput["op"] != "v2.policy.get" {
		t.Fatalf("valid signer envelope decoded incorrectly: req=%#v fingerprint=%#v", req, fingerprintInput)
	}
}

func TestSignerV2BodyRejectsUnknownDuplicateAndTrailingJSON(t *testing.T) {
	type body struct {
		RequestID string `json:"requestId"`
		Metadata  struct {
			Nonce string `json:"nonce"`
		} `json:"metadata"`
	}
	tests := map[string]json.RawMessage{
		"unknown field":          json.RawMessage(`{"requestId":"one","unknown":true}`),
		"non-canonical field":    json.RawMessage(`{"RequestId":"one"}`),
		"duplicate field":        json.RawMessage(`{"requestId":"one","requestId":"two"}`),
		"case-folded duplicate":  json.RawMessage(`{"requestId":"one","RequestId":"two"}`),
		"nested duplicate field": json.RawMessage(`{"requestId":"one","metadata":{"nonce":"a","nonce":"b"}}`),
		"trailing object":        json.RawMessage(`{"requestId":"one"}{"requestId":"two"}`),
	}
	for name, input := range tests {
		t.Run(name, func(t *testing.T) {
			var decoded body
			if err := decodeSignerRequestV2(input, &decoded); err == nil {
				t.Fatalf("unsafe signer-v2 body was accepted: %s", input)
			}
		})
	}

	var decoded body
	if err := decodeSignerRequestV2(json.RawMessage(`{"requestId":"one","metadata":{"nonce":"a"}}`), &decoded); err != nil {
		t.Fatalf("valid signer-v2 body was rejected: %v", err)
	}
	if decoded.RequestID != "one" || decoded.Metadata.Nonce != "a" {
		t.Fatalf("valid signer-v2 body decoded incorrectly: %#v", decoded)
	}
}
