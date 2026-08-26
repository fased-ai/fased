package main

// Code generated from the exact SAT generation-2 interface bundle; DO NOT EDIT.

type frozenSATComponentGenerationsV2 struct {
	Bond             string `json:"bond"`
	Cycle            string `json:"cycle"`
	Economics        string `json:"economics"`
	Penalty          string `json:"penalty"`
	Schema           string `json:"schema"`
	SignerCapability string `json:"signerCapability"`
}

type frozenSATReleaseAcknowledgementV2 struct {
	Schema                  string                          `json:"schema"`
	State                   string                          `json:"state"`
	ComponentGenerations    frozenSATComponentGenerationsV2 `json:"componentGenerations"`
	InterfaceContractSHA256 string                          `json:"interfaceContractSha256"`
	IDLSHA256               string                          `json:"idlSha256"`
	AccountOrderSHA256      string                          `json:"accountOrderSha256"`
	StateLayoutsSHA256      string                          `json:"stateLayoutsSha256"`
	SignerCodecsSHA256      string                          `json:"signerCodecsSha256"`
}

var signerSATReleaseAcknowledgementGeneration2 = frozenSATReleaseAcknowledgementV2{
	Schema: "fased.sat-release-acknowledgement.v1",
	State:  "FROZEN_NOT_ACTIVE",
	ComponentGenerations: frozenSATComponentGenerationsV2{
		Bond:             "SAT-BOND-GEN-002",
		Cycle:            "SAT-CYCLE-GEN-002",
		Economics:        "SAT-ECON-GEN-002",
		Penalty:          "SAT-PENALTY-GEN-002",
		Schema:           "SAT-SCHEMA-GEN-002",
		SignerCapability: "FSD-SIGNER-GEN-002",
	},
	InterfaceContractSHA256: "sha256:35b5026b4e907686fb32e1847870d2907686169f6c95dc5ea782fe398fbc445c", // pragma: allowlist secret
	IDLSHA256:               "sha256:2016465b305dd15fb01a42299e20ebc7dc08d5d3005c8a50524593e7b464892b", // pragma: allowlist secret
	AccountOrderSHA256:      "sha256:a158dc63b30dc6f5c0ae1057a3f33d9f71c5fd18914a777ff1dd1d16fa94858c", // pragma: allowlist secret
	StateLayoutsSHA256:      "sha256:bcf2fab02b64eeba1be9b67d0e4747153923e5750235878cad2dfbfe63d53b28", // pragma: allowlist secret
	SignerCodecsSHA256:      "sha256:4deadf1f1173803f94787f906398c8dec437be854874e26982aaa9a957319148", // pragma: allowlist secret
}
