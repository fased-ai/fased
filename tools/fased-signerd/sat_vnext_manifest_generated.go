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
	satVNextInterfaceContractSHA256 = "f3209004d5dd818c5487c2db52b7856a7650fc705c217520e6f1717d401eab80" // pragma: allowlist secret
	satVNextIDLContractSHA256       = "295bb24983fefae951c9ae2576d0805f54190a0048e8a3af24e1598f2e880ea5" // pragma: allowlist secret
	satVNextAccountOrderSHA256      = "717c979224d7f08c3fff76946a9cda0a1d797d359fee28987790bfde12a65737" // pragma: allowlist secret
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
	"settleCyclePageV2": {
		Action:             "settleCyclePageV2",
		Discriminator:      122,
		DataLength:         25,
		AllocationChannels: 0,
		AccountShape:       "SW,-W,--,--,--,-W,--,--,-W,-W",
		Active:             false,
	},
	"finalizeCycleSettlementV2": {
		Action:             "finalizeCycleSettlementV2",
		Discriminator:      123,
		DataLength:         9,
		AllocationChannels: 0,
		AccountShape:       "SW,-W,-W,-W,-W,-W,-W,-W,-W,-W,--,--,--",
		Active:             false,
	},
	"scoreCyclePageV2": {
		Action:             "scoreCyclePageV2",
		Discriminator:      124,
		DataLength:         25,
		AllocationChannels: 0,
		AccountShape:       "SW,-W,--,--,-W,--,--,-W,-W",
		Active:             false,
	},
	"distributeCyclePageV2": {
		Action:             "distributeCyclePageV2",
		Discriminator:      125,
		DataLength:         25,
		AllocationChannels: 0,
		AccountShape:       "SW,-W,-W,--,-W,-W,-W,-W,--,--,-W,-W,--,-W,-W",
		Active:             false,
	},
}

func isCanonicalFrozenSATGeneration2Data(action string, data []byte) bool {
	codec, ok := signerSATCodecsGeneration2[action]
	return ok && !codec.Active && len(data) == codec.DataLength && data[0] == codec.Discriminator
}
