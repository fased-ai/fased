// Wire values mirrored from token/sat/api/src/instruction.rs and consts.rs.
// Keep all TypeScript protocol consumers on this single contract and run the
// sibling-source drift test whenever the SAT protocol repository is present.
export const SAT_INSTRUCTION_DISCRIMINATORS = {
  bootstrap: 34,
  initializeCycle: 38,
  finalizeEpoch: 43,
  openRound: 44,
  submitValidatorAttestation: 45,
  openDispute: 46,
  claim: 47,
  resolveDispute: 48,
  republishEpochRoots: 49,
  submitParticipation: 52,
  initMinerCapital: 36,
  depositMinerCapital: 37,
  openCycle: 56,
  submitCycle: 57,
  claimCycleRewards: 59,
  retargetUnlock: 60,
  claimCycleRewardsBatch: 62,
  settleCyclePage: 63,
  finalizeCycleSettlement: 64,
  scoreCyclePage: 65,
  distributeCyclePage: 66,
  withdrawMinerCapital: 67,
  setActiveCommit: 68,
  closeResolvedMinerCycleState: 69,
  closeResolvedCycleRegistryPage: 70,
  closeResolvedCycleArtifacts: 71,
  compactPendingCycleRange: 75,
  setProtocolRecipients: 76,
  claimProtocolTreasury: 77,
  openBondPosition: 79,
  increaseBondPosition: 80,
  requestBondUnlock: 81,
  cancelBondUnlock: 82,
  finalizeBondUnlock: 83,
  topUpRegistryReserve: 84,
  claimProtocolDistributorSat: 85,
  refillRegistryReserveFromTreasury: 88,
  commitCycle: 89,
  closeCommitPhase: 90,
  sealCycleEntropy: 91,
  revealCycle: 92,
  releaseUnrevealedCommit: 93,
  abortEmptyCycle: 94,
  miningCrank: 33,
} as const;

export const SAT_BOND_INSTRUCTION_DISCRIMINATORS = {
  initTierPolicy: 0,
  updateTierPolicy: 1,
  openBondPosition: 2,
  increaseBondPosition: 3,
  requestBondUnlock: 4,
  cancelBondUnlock: 5,
  finalizeBondUnlock: 6,
  initStakingDistributor: 7,
  syncStakingRewards: 8,
  syncStakingPosition: 9,
  claimStakingRewards: 10,
  claimUnallocatedStakingRewards: 11,
  recordProtocolStakingRewards: 12,
} as const;

export const SAT_PROTOCOL_CONSTANTS = {
  allocationBuckets: 25,
  cycleSeconds: 300,
  cycleOpenGraceSeconds: 30,
  cycleCommitSeconds: 120,
  cycleCommitSlots: 300,
  cycleRevealSlots: 375,
  cycleSettlementBufferSeconds: 30,
  cycleEntropyDelaySlots: 8,
  cycleEntropyHashCount: 8,
  cycleRecoveryRevealSeconds: 120,
  cycleErosionPpm: 83n,
  cycleNonRevealPenaltyBps: 100,
  cycleUnlockRetargetIntervalCycles: 12,
  cycleUnlockWindowIntervals: 24,
  cycleUnlockMaxStepBps: 1_000,
  minimumEntryLamports: 250_000_000,
  entropyUnavailableSeedHex: "ff".repeat(32),
} as const;

export const SAT_GENESIS_PROFILE_CONTRACTS = {
  devnet: {
    cluster: "devnet",
    configSha256: "79c536b73d7682842c9574f6785e7a8ab5916eb0a99e29f98c00bde4b18e3500",
    registryReserveTargetLamports: 200_000_000n,
    registryReserveMaxLamports: 200_000_000n,
    keeperReserveSpendableLamports: 10_000_000n,
  },
  "mainnet-beta": {
    cluster: "mainnet-beta",
    configSha256: "f35ccf88352efc6f86e6ff18b5c6f349e7ba792916ec8a4ae5c3705fde4c963b",
    registryReserveTargetLamports: 500_000_000n,
    registryReserveMaxLamports: 1_000_000_000n,
    keeperReserveSpendableLamports: 10_000_000n,
  },
} as const;

export function resolveSatGenesisProfileContract(network: string | null | undefined) {
  return network === "mainnet-beta"
    ? SAT_GENESIS_PROFILE_CONTRACTS["mainnet-beta"]
    : SAT_GENESIS_PROFILE_CONTRACTS.devnet;
}
