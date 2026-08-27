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
	satVNextIDLContractSHA256       = "f892c3dacfb7955d8d03d1d0e971a3692dfc2017841683ebf669bdc8fae6fd54" // pragma: allowlist secret
	satVNextAccountOrderSHA256      = "9aed2fe26dc26240bddec84f7562941aca36dd51eeaf52716adf10cffc6a0259" // pragma: allowlist secret
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
