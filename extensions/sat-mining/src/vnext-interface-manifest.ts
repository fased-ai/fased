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
      accountShape: "SW,-W,-W,-W,-W,-W,-W,-W,-W,-W,--,--,--",
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
  contractSha256: "f3209004d5dd818c5487c2db52b7856a7650fc705c217520e6f1717d401eab80", // pragma: allowlist secret
  idlSha256: "f892c3dacfb7955d8d03d1d0e971a3692dfc2017841683ebf669bdc8fae6fd54", // pragma: allowlist secret
  accountOrderSha256: "9aed2fe26dc26240bddec84f7562941aca36dd51eeaf52716adf10cffc6a0259", // pragma: allowlist secret
  stateLayoutsSha256: "66b70c10e9522b230ba3bc15da49084215e18602b4f31524c2dd48d18fb7999d", // pragma: allowlist secret
  signerCodecsSha256: "66dc7de6cdccc67bd3a07994b24f50e1b7da63f58355ea981a6093d27db12452", // pragma: allowlist secret
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
