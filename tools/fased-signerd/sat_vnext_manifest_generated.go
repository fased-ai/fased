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
	satVNextInterfaceContractSHA256 = "ae4888cbfce71c2099e98eae88c24d90cf9a2b97a01f7cfa3c513a443ac8cd3f" // pragma: allowlist secret
	satVNextIDLContractSHA256       = "484f2488c643cd2234acf84f130fbc385d10f965ef0eff318027ec9c96e9038c" // pragma: allowlist secret
	satVNextAccountOrderSHA256      = "6a1ffc1eb889cf5770dd0a7842e9997176c52a17925c0281e3c90e8a87e15998" // pragma: allowlist secret
)

var signerSATCodecsGeneration2 = map[string]frozenSATCodecGeneration2{
	"bootstrapV2": {
		Action:             "bootstrapV2",
		Discriminator:      115,
		DataLength:         41,
		AllocationChannels: 0,
		AccountShape:       "S-,SW,--,-W,-W,-W,-W,-W,--,--,--,-W,-W",
		Active:             false,
	},
	"openCycleV2": {
		Action:             "openCycleV2",
		Discriminator:      116,
		DataLength:         9,
		AllocationChannels: 0,
		AccountShape:       "SW,--,--,-W,-W,--,-W,--",
		Active:             false,
	},
	"commitCycleV2": {
		Action:             "commitCycleV2",
		Discriminator:      117,
		DataLength:         41,
		AllocationChannels: 0,
		AccountShape:       "SW,--,--,--,-W,-W,-W,-W,-W,--",
		Active:             false,
	},
	"closeCommitPhaseV2": {
		Action:             "closeCommitPhaseV2",
		Discriminator:      118,
		DataLength:         9,
		AllocationChannels: 0,
		AccountShape:       "S-,-W",
		Active:             false,
	},
	"sealCycleEntropyV2": {
		Action:             "sealCycleEntropyV2",
		Discriminator:      119,
		DataLength:         9,
		AllocationChannels: 0,
		AccountShape:       "S-,-W,--,--",
		Active:             false,
	},
	"revealCycleV2": {
		Action:             "revealCycleV2",
		Discriminator:      114,
		DataLength:         105,
		AllocationChannels: 16,
		AccountShape:       "SW,-W,-W,-W,-W,-W,-W,-W,-W,--",
		Active:             false,
	},
	"releaseUnrevealedCommitV2": {
		Action:             "releaseUnrevealedCommitV2",
		Discriminator:      120,
		DataLength:         41,
		AllocationChannels: 0,
		AccountShape:       "S-,--,-W,-W,-W,-W,-W,-W,-W",
		Active:             false,
	},
	"abortEmptyCycleV2": {
		Action:             "abortEmptyCycleV2",
		Discriminator:      121,
		DataLength:         9,
		AllocationChannels: 0,
		AccountShape:       "S-,-W,-W",
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
		AccountShape:       "SW,-W,-W,-W,-W,-W,-W,-W,-W,-W,--,--,--,--",
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
	"claimCycleRewardsV2": {
		Action:             "claimCycleRewardsV2",
		Discriminator:      126,
		DataLength:         9,
		AllocationChannels: 0,
		AccountShape:       "SW,--,--,--,--,-W,-W,--,-W,-W,-W,-W,-W,--,--,--,--,-W",
		Active:             false,
	},
	"claimCycleRewardsBatchV2": {
		Action:             "claimCycleRewardsBatchV2",
		Discriminator:      127,
		DataLength:         -1,
		AllocationChannels: 0,
		AccountShape:       "SW,--,--,--,-W,-W,-W,--,-W,-W,-W,--,-W,--,--,--,--,-W",
		Active:             false,
	},
	"closeResolvedMinerCycleStateV2": {
		Action:             "closeResolvedMinerCycleStateV2",
		Discriminator:      128,
		DataLength:         9,
		AllocationChannels: 0,
		AccountShape:       "SW,--,-W,-W,-W,--,-W",
		Active:             false,
	},
	"closeResolvedCycleRegistryPageV2": {
		Action:             "closeResolvedCycleRegistryPageV2",
		Discriminator:      129,
		DataLength:         17,
		AllocationChannels: 0,
		AccountShape:       "SW,--,-W,-W,-W",
		Active:             false,
	},
	"closeResolvedCycleArtifactsV2": {
		Action:             "closeResolvedCycleArtifactsV2",
		Discriminator:      130,
		DataLength:         9,
		AllocationChannels: 0,
		AccountShape:       "SW,-W,-W,-W,-W,-W",
		Active:             false,
	},
	"setVnextEntryEnabled": {
		Action:             "setVnextEntryEnabled",
		Discriminator:      131,
		DataLength:         17,
		AllocationChannels: 0,
		AccountShape:       "S-,--,-W,--,--",
		Active:             false,
	},
	"migrateAgentRecordV2": {
		Action:             "migrateAgentRecordV2",
		Discriminator:      132,
		DataLength:         9,
		AllocationChannels: 0,
		AccountShape:       "S-,--,-W,--,--",
		Active:             false,
	},
	"snapshotKeeperCapabilitiesV2": {
		Action:             "snapshotKeeperCapabilitiesV2",
		Discriminator:      133,
		DataLength:         17,
		AllocationChannels: 0,
		AccountShape:       "SW,--,--,-W,-W,--",
		Active:             false,
	},
	"recordAgentCycleReceiptV2": {
		Action:             "recordAgentCycleReceiptV2",
		Discriminator:      134,
		DataLength:         25,
		AllocationChannels: 0,
		AccountShape:       "S-,--,-W,--,--,--",
		Active:             false,
	},
	"claimProtocolDistributorSatV2": {
		Action:             "claimProtocolDistributorSatV2",
		Discriminator:      135,
		DataLength:         1,
		AllocationChannels: 0,
		AccountShape:       "SW,--,--,-W,-W,-W,-W,-W,-W,--,--,--,--,--",
		Active:             false,
	},
}

func isCanonicalFrozenSATGeneration2Data(action string, data []byte) bool {
	codec, ok := signerSATCodecsGeneration2[action]
	if !ok || codec.Active || len(data) == 0 || data[0] != codec.Discriminator {
		return false
	}
	if codec.DataLength >= 0 {
		return len(data) == codec.DataLength
	}
	return action == "claimCycleRewardsBatchV2" && len(data) >= 9 && (len(data)-9)%8 == 0
}
