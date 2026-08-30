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
	InterfaceContractSHA256: "sha256:09047a1f194bcb85cbf8ff34519a3be563a7cea487c48f009fa314c6254f8cba", // pragma: allowlist secret
	IDLSHA256:               "sha256:484f2488c643cd2234acf84f130fbc385d10f965ef0eff318027ec9c96e9038c", // pragma: allowlist secret
	AccountOrderSHA256:      "sha256:5724ac507fe5984490191c81968a1d891a6b5df373b953a321e36af608976626", // pragma: allowlist secret
	StateLayoutsSHA256:      "sha256:77717f1e06fcd37944c81a44f75e1b36490c369386090b5eb10d58f2fc63e14f", // pragma: allowlist secret
	SignerCodecsSHA256:      "sha256:b3d2098f7b8b3d9d7e0738e281c23deb7947666c078506929bd124d400096c5e", // pragma: allowlist secret
}
