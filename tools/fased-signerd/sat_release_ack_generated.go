package main

// Code generated from the exact SAT generation-2 interface bundle; DO NOT EDIT.

type frozenSATComponentGenerationsV2 struct {
	Bond             string `json:"bond"`
	Cycle            string `json:"cycle"`
	Economics        string `json:"economics"`
	Keeper           string `json:"keeper"`
	Penalty          string `json:"penalty"`
	Protocol         string `json:"protocol"`
	Receipt          string `json:"receipt"`
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
	State:  "EXECUTABLE_BOUND_PUBLIC_ENTRY_DISABLED",
	ComponentGenerations: frozenSATComponentGenerationsV2{
		Bond:             "SAT-BOND-GEN-003",
		Cycle:            "SAT-CYCLE-GEN-003",
		Economics:        "SAT-ECON-GEN-003",
		Keeper:           "SAT-KEEPER-GEN-002",
		Penalty:          "SAT-PENALTY-GEN-003",
		Protocol:         "SAT-PROTO-GEN-002",
		Receipt:          "SAT-RECEIPT-GEN-002",
		Schema:           "SAT-SCHEMA-GEN-002",
		SignerCapability: "FSD-SIGNER-GEN-002",
	},
	InterfaceContractSHA256: "sha256:f3209004d5dd818c5487c2db52b7856a7650fc705c217520e6f1717d401eab80", // pragma: allowlist secret
	IDLSHA256:               "sha256:f892c3dacfb7955d8d03d1d0e971a3692dfc2017841683ebf669bdc8fae6fd54", // pragma: allowlist secret
	AccountOrderSHA256:      "sha256:9aed2fe26dc26240bddec84f7562941aca36dd51eeaf52716adf10cffc6a0259", // pragma: allowlist secret
	StateLayoutsSHA256:      "sha256:66b70c10e9522b230ba3bc15da49084215e18602b4f31524c2dd48d18fb7999d", // pragma: allowlist secret
	SignerCodecsSHA256:      "sha256:66dc7de6cdccc67bd3a07994b24f50e1b7da63f58355ea981a6093d27db12452", // pragma: allowlist secret
}
