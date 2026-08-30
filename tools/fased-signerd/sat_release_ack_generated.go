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
	InterfaceContractSHA256: "sha256:ae4888cbfce71c2099e98eae88c24d90cf9a2b97a01f7cfa3c513a443ac8cd3f", // pragma: allowlist secret
	IDLSHA256:               "sha256:484f2488c643cd2234acf84f130fbc385d10f965ef0eff318027ec9c96e9038c", // pragma: allowlist secret
	AccountOrderSHA256:      "sha256:6a1ffc1eb889cf5770dd0a7842e9997176c52a17925c0281e3c90e8a87e15998", // pragma: allowlist secret
	StateLayoutsSHA256:      "sha256:77717f1e06fcd37944c81a44f75e1b36490c369386090b5eb10d58f2fc63e14f", // pragma: allowlist secret
	SignerCodecsSHA256:      "sha256:b3d2098f7b8b3d9d7e0738e281c23deb7947666c078506929bd124d400096c5e", // pragma: allowlist secret
}
