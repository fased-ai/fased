// Generated from the exact SAT generation-2 interface bundle; do not edit.

export const SAT_VNEXT_INTERFACE = {
  freezeId: "SAT-VNEXT-GATE-P3-008",
  state: "FROZEN_NOT_ACTIVE",
  active: false,
  executableDispatchBound: true,
  publicEntryEnabled: false,
  schemaGeneration: 2,
  signerCapabilityGeneration: 2,
  strategyChannels: 16,
  legacyStrategyChannels: 25,
  economics: {
    cycle: {
      cycleSeconds: 300,
      strategyChannels: 16,
      directEligibilityLamports: 1000000000,
      currentCycleCapitalReferenceLamports: 250000000000,
      capitalQualification: "VALID_REVEALED_CURRENT_CYCLE",
      postResolutionExitAllowed: true,
      trailingCapitalQualification: false,
      launchMiningCommitmentRequired: false,
      automaticReferenceRetarget: false,
    },
    economics: {
      hardCapSat: 21000000,
      satDecimals: 11,
      erosionPpm: 14,
      satRouteBps: {
        baseMiner: 7500,
        performanceMiner: 1500,
        bond: 500,
        treasury: 500,
      },
      solRouteBps: {
        deterministic: 3000,
        performance: 5000,
        treasury: 2000,
      },
      issuance: {
        nominalYears: 25,
        annualBpsOfHardCap: [
          1000, 900, 800, 700, 600, 550, 500, 450, 400, 350, 350, 350, 350, 350, 350, 250, 250, 250,
          250, 250, 150, 150, 150, 150, 150,
        ],
        tailAnnualBpsMaximum: 150,
        participationUnlockApplied: true,
        acceleratedCatchUpAllowed: false,
        existingMintSupplyCountsAgainstCap: true,
        stopAtHardCap: true,
      },
      performance: {
        launchMultiplierBps: 10000,
        launchMonetaryState: "NEUTRAL_ONLY",
        deferredMinimumMultiplierBps: 7500,
        deferredMaximumMultiplierBps: 12500,
        deferredMonetaryPerformanceActive: false,
        newTimelockedGenerationRequired: true,
        capitalTimeWeighted: true,
        priorCompletedDataOnly: true,
      },
    },
    penalty: {
      strikeWindowDays: 30,
      cleanActiveDaysPerTierDecay: 30,
      ladderBps: [10, 25, 100],
      appliesToMissedCommitmentOnly: true,
      pauseOnAttributableMiss: true,
      resumePolicy: "EXPLICIT_AUTHORIZED_REVIEW",
      persistentAgentRecordMemory: true,
      nonAttributablePenaltyBps: 0,
    },
    bond: {
      basicThresholdSat: 25,
      rewardThresholdSat: 500,
      weightPolicy: "LINEAR_UNCAPPED_MINIMUM_ACTIVE",
      epochDays: 7,
      entryAndIncreaseActivation: "NEXT_COMPLETE_EPOCH",
      withdrawalStopsEligibilityImmediately: true,
      withdrawalCooldownDays: 7,
      cancelRequalification: "NEXT_COMPLETE_EPOCH",
      completedClaimsPreserved: true,
      emptyLaneDisposition: "UNISSUED",
      serviceGatingRequired: false,
      stalePositionsEligible: false,
    },
  } as const,
  keeperExclusiveWindowSlots: 20,
  keeperFallbackJitterSlots: 8,
  keeperAccounting: {
    commonWorkSource: "BOOTSTRAP_THEN_TREASURY",
    duplicatePaid: false,
    feeAllowanceLamports: 36000,
    identityWorkSource: "OPERATING_RESERVE",
    identityWorkUnitsPerCycle: 3,
    maximumChargePerWorkLamports: 40000,
    publicRescuePaid: false,
    serviceMarginLamports: 4000,
  } as const,
  revealDiscriminator: 114,
  revealDataLength: 105,
  revealAccountShape: "SW,-W,-W,-W,-W,-W,-W,-W,-W,--",
  actionCodecs: {
    bootstrapV2: {
      discriminator: 115,
      dataLength: 41,
      accountShape: "S-,SW,--,-W,-W,-W,-W,-W,--,--,--,-W,-W",
      repeatedAccountGroup: null,
    },
    openCycleV2: {
      discriminator: 116,
      dataLength: 9,
      accountShape: "SW,--,--,-W,-W,--,-W,--",
      repeatedAccountGroup: null,
    },
    commitCycleV2: {
      discriminator: 117,
      dataLength: 41,
      accountShape: "SW,--,--,--,-W,-W,-W,-W,-W,--",
      repeatedAccountGroup: null,
    },
    closeCommitPhaseV2: {
      discriminator: 118,
      dataLength: 9,
      accountShape: "S-,-W",
      repeatedAccountGroup: null,
    },
    sealCycleEntropyV2: {
      discriminator: 119,
      dataLength: 9,
      accountShape: "S-,-W,--,--",
      repeatedAccountGroup: null,
    },
    revealCycleV2: {
      discriminator: 114,
      dataLength: 105,
      accountShape: "SW,-W,-W,-W,-W,-W,-W,-W,-W,--",
      repeatedAccountGroup: null,
    },
    releaseUnrevealedCommitV2: {
      discriminator: 120,
      dataLength: 41,
      accountShape: "S-,--,-W,-W,-W,-W,-W,-W,-W",
      repeatedAccountGroup: null,
    },
    abortEmptyCycleV2: {
      discriminator: 121,
      dataLength: 9,
      accountShape: "S-,-W,-W",
      repeatedAccountGroup: null,
    },
    settleCyclePageV2: {
      discriminator: 122,
      dataLength: 25,
      accountShape: "SW,-W,--,--,--,-W,--,--,-W,-W",
      repeatedAccountGroup: [
        "sat_miner_cycle_state_v2:writable",
        "sat_keeper_operating_reserve:writable",
      ],
    },
    finalizeCycleSettlementV2: {
      discriminator: 123,
      dataLength: 9,
      accountShape: "SW,-W,-W,-W,-W,-W,-W,-W,-W,-W,--,--,--,--",
      repeatedAccountGroup: null,
    },
    scoreCyclePageV2: {
      discriminator: 124,
      dataLength: 25,
      accountShape: "SW,-W,--,--,-W,--,--,-W,-W",
      repeatedAccountGroup: [
        "sat_miner_cycle_state_v2:writable",
        "sat_keeper_operating_reserve:writable",
      ],
    },
    distributeCyclePageV2: {
      discriminator: 125,
      dataLength: 25,
      accountShape: "SW,-W,-W,--,-W,-W,-W,-W,--,--,-W,-W,--,-W,-W",
      repeatedAccountGroup: [
        "sat_miner_cycle_state_v2:writable",
        "sat_miner_capital_state:writable",
        "sat_agent_record:readonly",
        "sat_agent_reward_remainder_v2:writable",
        "sat_keeper_operating_reserve:writable",
      ],
    },
    claimCycleRewardsV2: {
      discriminator: 126,
      dataLength: 9,
      accountShape: "SW,--,--,--,--,-W,-W,--,-W,-W,-W,-W,-W,--,--,--,--,-W",
      repeatedAccountGroup: null,
    },
    claimCycleRewardsBatchV2: {
      discriminator: 127,
      dataLength: "9+8*n",
      accountShape: "SW,--,--,--,-W,-W,-W,--,-W,-W,-W,--,-W,--,--,--,--,-W",
      repeatedAccountGroup: null,
    },
    closeResolvedMinerCycleStateV2: {
      discriminator: 128,
      dataLength: 9,
      accountShape: "S-,--,-W,-W,-W,--,-W",
      repeatedAccountGroup: null,
    },
    closeResolvedCycleRegistryPageV2: {
      discriminator: 129,
      dataLength: 17,
      accountShape: "S-,--,-W,-W,-W",
      repeatedAccountGroup: null,
    },
    closeResolvedCycleArtifactsV2: {
      discriminator: 130,
      dataLength: 9,
      accountShape: "S-,-W,-W,-W,-W",
      repeatedAccountGroup: null,
    },
    setVnextEntryEnabled: {
      discriminator: 131,
      dataLength: 17,
      accountShape: "S-,--,-W,--,--",
      repeatedAccountGroup: null,
    },
    migrateAgentRecordV2: {
      discriminator: 132,
      dataLength: 9,
      accountShape: "S-,--,-W,--,--",
      repeatedAccountGroup: null,
    },
    snapshotKeeperCapabilitiesV2: {
      discriminator: 133,
      dataLength: 17,
      accountShape: "SW,--,--,-W,--",
      repeatedAccountGroup: null,
    },
    recordAgentCycleReceiptV2: {
      discriminator: 134,
      dataLength: 25,
      accountShape: "S-,--,-W,--,--,--",
      repeatedAccountGroup: null,
    },
    claimProtocolDistributorSatV2: {
      discriminator: 135,
      dataLength: 1,
      accountShape: "SW,--,--,-W,-W,-W,-W,-W,-W,--,--,--,--,--",
      repeatedAccountGroup: null,
    },
  } as const,
  keeperCodecs: {
    settleCyclePageV2: {
      discriminator: 122,
      dataLength: 25,
      accountShape: "SW,-W,--,--,--,-W,--,--,-W,-W",
      repeatedAccountGroup: [
        "sat_miner_cycle_state_v2:writable",
        "sat_keeper_operating_reserve:writable",
      ],
    },
    finalizeCycleSettlementV2: {
      discriminator: 123,
      dataLength: 9,
      accountShape: "SW,-W,-W,-W,-W,-W,-W,-W,-W,-W,--,--,--,--",
      repeatedAccountGroup: null,
    },
    scoreCyclePageV2: {
      discriminator: 124,
      dataLength: 25,
      accountShape: "SW,-W,--,--,-W,--,--,-W,-W",
      repeatedAccountGroup: [
        "sat_miner_cycle_state_v2:writable",
        "sat_keeper_operating_reserve:writable",
      ],
    },
    distributeCyclePageV2: {
      discriminator: 125,
      dataLength: 25,
      accountShape: "SW,-W,-W,--,-W,-W,-W,-W,--,--,-W,-W,--,-W,-W",
      repeatedAccountGroup: [
        "sat_miner_cycle_state_v2:writable",
        "sat_miner_capital_state:writable",
        "sat_agent_record:readonly",
        "sat_agent_reward_remainder_v2:writable",
        "sat_keeper_operating_reserve:writable",
      ],
    },
  } as const,
  contractSha256: "5810f9f9b6171dd4ee37190dea513363f99bb915feb46ac207a0a7d14f312fff", // pragma: allowlist secret
  economicsSha256: "36ae4658a8f8d7355c4afe2d75483f03e4ae26d94864af6ce12fb6220f9a6956", // pragma: allowlist secret
  idlSha256: "27ee632e51a711fd431e5fbb3fc93541dd75bf74a7fa68eccd614bcda983c7d0", // pragma: allowlist secret
  accountOrderSha256: "36b7594215cf5de44e645c0dc70240459d49bfe5a4b72cdb4fa82289e44ee7ea", // pragma: allowlist secret
  stateLayoutsSha256: "77717f1e06fcd37944c81a44f75e1b36490c369386090b5eb10d58f2fc63e14f", // pragma: allowlist secret
  signerCodecsSha256: "b3d2098f7b8b3d9d7e0738e281c23deb7947666c078506929bd124d400096c5e", // pragma: allowlist secret
} as const;

export type SatVNextAction = keyof typeof SAT_VNEXT_INTERFACE.actionCodecs;

export function encodeSatVNextRevealData(params: {
  cycleId: bigint;
  nonce: Buffer;
  allocationFp: readonly number[];
}): Buffer {
  if (params.nonce.length !== 32) throw new Error("SAT vNext reveal nonce must contain 32 bytes");
  if (params.allocationFp.length !== SAT_VNEXT_INTERFACE.strategyChannels) {
    throw new Error("SAT vNext reveal must contain exactly 16 strategy channels");
  }
  const data = Buffer.alloc(SAT_VNEXT_INTERFACE.revealDataLength);
  data[0] = SAT_VNEXT_INTERFACE.revealDiscriminator;
  data.writeBigUInt64LE(params.cycleId, 1);
  params.nonce.copy(data, 9);
  params.allocationFp.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error(`SAT vNext allocation[${index}] is not a u32`);
    }
    data.writeUInt32LE(value, 41 + index * 4);
  });
  return data;
}
