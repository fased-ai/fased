package main

// Code generated from extensions/sat-mining/src/signer-codec-manifest.ts.
// DO NOT EDIT discriminator or payload contracts without regenerating both copies.

type signerSATCodecV2 struct {
	Action        string
	Discriminator byte
	DataLength    int
	Family        string
	AccountShape  string
	Variable      string
}

const (
	satFamilyMain = "main"
	satFamilyBond = "bond"
)

var signerSATCodecsV2 = map[string]signerSATCodecV2{
	"initializeCycle":                   {"initializeCycle", 38, 105, satFamilyMain, "SW,-W,-W,--", ""},
	"validatorAttestation":              {"validatorAttestation", 45, 161, satFamilyMain, "SW,-W,-W,-W,--", ""},
	"openDispute":                       {"openDispute", 46, 89, satFamilyMain, "SW,-W,-W,-W,--", ""},
	"resolveDispute":                    {"resolveDispute", 48, 57, satFamilyMain, "SW,--,-W,-W", ""},
	"republishEpochRoots":               {"republishEpochRoots", 49, 105, satFamilyMain, "SW,--,-W", ""},
	"topUpRegistryReserve":              {"topUpRegistryReserve", 84, 9, satFamilyMain, "SW,-W,--", ""},
	"openCycle":                         {"openCycle", 56, 9, satFamilyMain, "SW,-W,-W,-W,-W,-W,--,-W", ""},
	"initMinerCapital":                  {"initMinerCapital", 36, 33, satFamilyMain, "SW,-W,--", ""},
	"depositMinerCapital":               {"depositMinerCapital", 37, 9, satFamilyMain, "SW,-W,--", ""},
	"withdrawMinerCapital":              {"withdrawMinerCapital", 67, 9, satFamilyMain, "SW,-W,--", ""},
	"setActiveCommit":                   {"setActiveCommit", 68, 9, satFamilyMain, "SW,-W", ""},
	"updateBondTierPolicy":              {"updateBondTierPolicy", 1, 65, satFamilyBond, "SW,-W", ""},
	"openBondPosition":                  {"openBondPosition", 2, 9, satFamilyBond, "SW,--,-W,-W,-W,-W,--,--,--", ""},
	"increaseBondPosition":              {"increaseBondPosition", 3, 9, satFamilyBond, "SW,--,-W,-W,-W,-W,--,--,--", ""},
	"requestBondUnlock":                 {"requestBondUnlock", 4, 1, satFamilyBond, "SW,--,-W,-W,-W", ""},
	"cancelBondUnlock":                  {"cancelBondUnlock", 5, 1, satFamilyBond, "SW,--,-W,-W,-W", ""},
	"finalizeBondUnlock":                {"finalizeBondUnlock", 6, 1, satFamilyBond, "SW,--,-W,-W,-W,-W,-W,-W,--,--,--", ""},
	"syncBondStakingRewards":            {"syncBondStakingRewards", 8, 1, satFamilyBond, "-W,--,--", ""},
	"syncBondStakingPosition":           {"syncBondStakingPosition", 9, 1, satFamilyBond, "SW,--,-W,-W,--,--", ""},
	"claimBondStakingRewards":           {"claimBondStakingRewards", 10, 1, satFamilyBond, "SW,--,-W,-W,--,-W,-W,-W,--,--,--", ""},
	"claimUnallocatedStakingRewards":    {"claimUnallocatedStakingRewards", 11, 1, satFamilyBond, "SW,-W,-W,-W,--,-W,--,--,--", ""},
	"commitCycle":                       {"commitCycle", 89, 41, satFamilyMain, "SW,-W,-W,-W,--", ""},
	"closeCommitPhase":                  {"closeCommitPhase", 90, 9, satFamilyMain, "S-,-W", ""},
	"sealCycleEntropy":                  {"sealCycleEntropy", 91, 9, satFamilyMain, "S-,-W,-W,--", ""},
	"releaseUnrevealedCommit":           {"releaseUnrevealedCommit", 93, 41, satFamilyMain, "S-,-W,-W,-W,-W,-W", ""},
	"abortEmptyCycle":                   {"abortEmptyCycle", 94, 9, satFamilyMain, "S-,-W,-W", ""},
	"revealCycle":                       {"revealCycle", 92, 145, satFamilyMain, "SW,-W,-W,-W,-W,-W,-W,-W,-W,--", ""},
	"settleCyclePage":                   {"settleCyclePage", 63, 25, satFamilyMain, "SW,--,-W,--,--,-W,-W,-W,--,--,-W,-W", "minerCycles"},
	"finalizeCycleSettlement":           {"finalizeCycleSettlement", 64, 9, satFamilyMain, "SW,-W,-W,-W,-W,-W,--,-W,-W", "registryPages"},
	"scoreCyclePage":                    {"scoreCyclePage", 65, 25, satFamilyMain, "SW,--,--,--,-W,-W,--,-W,-W", "minerCycles"},
	"distributeCyclePage":               {"distributeCyclePage", 66, 25, satFamilyMain, "SW,-W,--,-W,--,-W,--,-W,-W,-W", "minerCyclePairs"},
	"claimCycleRewards":                 {"claimCycleRewards", 59, 9, satFamilyMain, "SW,-W,-W,-W,-W,-W,-W,-W,-W,-W,--,--,--,--,-W", ""},
	"claimCycleRewardsBatch":            {"claimCycleRewardsBatch", 62, -1, satFamilyMain, "SW,--,-W,-W,-W,-W,-W,-W", "claimBatch"},
	"claimProtocolTreasury":             {"claimProtocolTreasury", 77, 1, satFamilyMain, "SW,--,-W,-W,-W,-W,-W,-W,-W,-W,--,--,--,--", ""},
	"refillRegistryReserveFromTreasury": {"refillRegistryReserveFromTreasury", 88, 9, satFamilyMain, "SW,-W,-W,-W,--", ""},
	"claimProtocolDistributorSat":       {"claimProtocolDistributorSat", 85, 1, satFamilyMain, "SW,--,-W,-W,-W,-W,-W,-W,--,--,--,--,--", ""},
	"retargetUnlock":                    {"retargetUnlock", 60, 9, satFamilyMain, "SW,-W,--,-W", ""},
	"closeResolvedMinerCycleState":      {"closeResolvedMinerCycleState", 69, 9, satFamilyMain, "SW,--,-W,-W,-W,-W", ""},
	"closeResolvedCycleRegistryPage":    {"closeResolvedCycleRegistryPage", 70, 17, satFamilyMain, "SW,--,-W,-W,-W", ""},
	"closeResolvedCycleArtifacts":       {"closeResolvedCycleArtifacts", 71, 9, satFamilyMain, "SW,-W,-W,-W,-W", ""},
	"compactPendingCycleRange":          {"compactPendingCycleRange", 75, 25, satFamilyMain, "SW,-W", "compactCycles"},
}
