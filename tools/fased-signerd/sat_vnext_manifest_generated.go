package main

// Code generated from the exact SAT generation-2 interface bundle; DO NOT EDIT.

type frozenSATCodecGeneration2 struct {
	Action             string
	Discriminator      byte
	DataLength         int
	AllocationChannels int
	AccountShape       string
	Active             bool
}

const (
	satVNextInterfaceContractSHA256 = "35b5026b4e907686fb32e1847870d2907686169f6c95dc5ea782fe398fbc445c" // pragma: allowlist secret
	satVNextIDLContractSHA256       = "2016465b305dd15fb01a42299e20ebc7dc08d5d3005c8a50524593e7b464892b" // pragma: allowlist secret
	satVNextAccountOrderSHA256      = "a158dc63b30dc6f5c0ae1057a3f33d9f71c5fd18914a777ff1dd1d16fa94858c" // pragma: allowlist secret
)

var signerSATCodecsGeneration2 = map[string]frozenSATCodecGeneration2{
	"revealCycleV2": {
		Action:             "revealCycleV2",
		Discriminator:      114,
		DataLength:         105,
		AllocationChannels: 16,
		AccountShape:       "SW,-W,-W,-W,-W,-W,-W,-W,-W,--",
		Active:             false,
	},
}

func isCanonicalFrozenSATGeneration2Data(action string, data []byte) bool {
	codec, ok := signerSATCodecsGeneration2[action]
	return ok && !codec.Active && len(data) == codec.DataLength && data[0] == codec.Discriminator
}
