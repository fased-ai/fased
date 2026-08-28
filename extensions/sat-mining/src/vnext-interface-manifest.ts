// Generated from the exact SAT generation-2 interface bundle; do not edit.

export const SAT_VNEXT_INTERFACE = {
  freezeId: "SAT-VNEXT-GATE-P3-008",
  state: "EXECUTABLE_BOUND_PUBLIC_ENTRY_DISABLED",
  active: false,
  executableDispatchBound: true,
  publicEntryEnabled: false,
  schemaGeneration: 2,
  signerCapabilityGeneration: 2,
  strategyChannels: 16,
  legacyStrategyChannels: 25,
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
  contractSha256: "dd562e2f98671d737e9698ad0faec5d2d1154d43d1e3354607f782133a668586", // pragma: allowlist secret
  idlSha256: "27ee632e51a711fd431e5fbb3fc93541dd75bf74a7fa68eccd614bcda983c7d0", // pragma: allowlist secret
  accountOrderSha256: "aedb10657f921a2ea26ce7912c6e8aa4f3905201070f1dd2c3faa2aa59156bd3", // pragma: allowlist secret
  stateLayoutsSha256: "77717f1e06fcd37944c81a44f75e1b36490c369386090b5eb10d58f2fc63e14f", // pragma: allowlist secret
  signerCodecsSha256: "b3d2098f7b8b3d9d7e0738e281c23deb7947666c078506929bd124d400096c5e", // pragma: allowlist secret
} as const;

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
