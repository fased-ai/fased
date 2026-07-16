import {
  SAT_BOND_INSTRUCTION_DISCRIMINATORS,
  SAT_INSTRUCTION_DISCRIMINATORS,
} from "./protocol-contract.js";

export type SatSignerAction =
  | "initializeCycle"
  | "validatorAttestation"
  | "openDispute"
  | "resolveDispute"
  | "republishEpochRoots"
  | "topUpRegistryReserve"
  | "openCycle"
  | "initMinerCapital"
  | "depositMinerCapital"
  | "withdrawMinerCapital"
  | "setActiveCommit"
  | "updateBondTierPolicy"
  | "openBondPosition"
  | "increaseBondPosition"
  | "requestBondUnlock"
  | "cancelBondUnlock"
  | "finalizeBondUnlock"
  | "syncBondStakingRewards"
  | "syncBondStakingPosition"
  | "claimBondStakingRewards"
  | "claimUnallocatedStakingRewards"
  | "commitCycle"
  | "closeCommitPhase"
  | "sealCycleEntropy"
  | "releaseUnrevealedCommit"
  | "abortEmptyCycle"
  | "revealCycle"
  | "settleCyclePage"
  | "finalizeCycleSettlement"
  | "scoreCyclePage"
  | "distributeCyclePage"
  | "claimCycleRewards"
  | "claimCycleRewardsBatch"
  | "claimProtocolTreasury"
  | "refillRegistryReserveFromTreasury"
  | "claimProtocolDistributorSat"
  | "retargetUnlock"
  | "closeResolvedMinerCycleState"
  | "closeResolvedCycleRegistryPage"
  | "closeResolvedCycleArtifacts"
  | "compactPendingCycleRange";

type SatSignerCodec = {
  action: SatSignerAction;
  discriminator: number;
  dataLength: number | "claimCycleRewardsBatch";
};

// Canonical signer codec manifest. The Go signer copy is generated from these
// action/discriminator/length contracts and adds account/PDA semantic validators.
const MAIN_CODECS: readonly SatSignerCodec[] = [
  {
    action: "initializeCycle",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.initializeCycle,
    dataLength: 105,
  },
  {
    action: "validatorAttestation",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.submitValidatorAttestation,
    dataLength: 161,
  },
  {
    action: "openDispute",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.openDispute,
    dataLength: 89,
  },
  {
    action: "resolveDispute",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.resolveDispute,
    dataLength: 57,
  },
  {
    action: "republishEpochRoots",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.republishEpochRoots,
    dataLength: 105,
  },
  {
    action: "topUpRegistryReserve",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.topUpRegistryReserve,
    dataLength: 9,
  },
  { action: "openCycle", discriminator: SAT_INSTRUCTION_DISCRIMINATORS.openCycle, dataLength: 9 },
  {
    action: "initMinerCapital",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.initMinerCapital,
    dataLength: 33,
  },
  {
    action: "depositMinerCapital",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.depositMinerCapital,
    dataLength: 9,
  },
  {
    action: "withdrawMinerCapital",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.withdrawMinerCapital,
    dataLength: 9,
  },
  {
    action: "setActiveCommit",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.setActiveCommit,
    dataLength: 9,
  },
  {
    action: "commitCycle",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.commitCycle,
    dataLength: 41,
  },
  {
    action: "closeCommitPhase",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.closeCommitPhase,
    dataLength: 9,
  },
  {
    action: "sealCycleEntropy",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.sealCycleEntropy,
    dataLength: 9,
  },
  {
    action: "releaseUnrevealedCommit",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.releaseUnrevealedCommit,
    dataLength: 41,
  },
  {
    action: "abortEmptyCycle",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.abortEmptyCycle,
    dataLength: 9,
  },
  {
    action: "revealCycle",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.revealCycle,
    dataLength: 145,
  },
  {
    action: "settleCyclePage",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.settleCyclePage,
    dataLength: 25,
  },
  {
    action: "finalizeCycleSettlement",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.finalizeCycleSettlement,
    dataLength: 9,
  },
  {
    action: "scoreCyclePage",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.scoreCyclePage,
    dataLength: 25,
  },
  {
    action: "distributeCyclePage",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.distributeCyclePage,
    dataLength: 25,
  },
  {
    action: "claimCycleRewards",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.claimCycleRewards,
    dataLength: 9,
  },
  {
    action: "claimCycleRewardsBatch",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.claimCycleRewardsBatch,
    dataLength: "claimCycleRewardsBatch",
  },
  {
    action: "claimProtocolTreasury",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.claimProtocolTreasury,
    dataLength: 1,
  },
  {
    action: "refillRegistryReserveFromTreasury",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.refillRegistryReserveFromTreasury,
    dataLength: 9,
  },
  {
    action: "claimProtocolDistributorSat",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.claimProtocolDistributorSat,
    dataLength: 1,
  },
  {
    action: "retargetUnlock",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.retargetUnlock,
    dataLength: 9,
  },
  {
    action: "closeResolvedMinerCycleState",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.closeResolvedMinerCycleState,
    dataLength: 9,
  },
  {
    action: "closeResolvedCycleRegistryPage",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.closeResolvedCycleRegistryPage,
    dataLength: 17,
  },
  {
    action: "closeResolvedCycleArtifacts",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.closeResolvedCycleArtifacts,
    dataLength: 9,
  },
  {
    action: "compactPendingCycleRange",
    discriminator: SAT_INSTRUCTION_DISCRIMINATORS.compactPendingCycleRange,
    dataLength: 25,
  },
];

const BOND_CODECS: readonly SatSignerCodec[] = [
  {
    action: "updateBondTierPolicy",
    discriminator: SAT_BOND_INSTRUCTION_DISCRIMINATORS.updateTierPolicy,
    dataLength: 65,
  },
  {
    action: "openBondPosition",
    discriminator: SAT_BOND_INSTRUCTION_DISCRIMINATORS.openBondPosition,
    dataLength: 9,
  },
  {
    action: "increaseBondPosition",
    discriminator: SAT_BOND_INSTRUCTION_DISCRIMINATORS.increaseBondPosition,
    dataLength: 9,
  },
  {
    action: "requestBondUnlock",
    discriminator: SAT_BOND_INSTRUCTION_DISCRIMINATORS.requestBondUnlock,
    dataLength: 1,
  },
  {
    action: "cancelBondUnlock",
    discriminator: SAT_BOND_INSTRUCTION_DISCRIMINATORS.cancelBondUnlock,
    dataLength: 1,
  },
  {
    action: "finalizeBondUnlock",
    discriminator: SAT_BOND_INSTRUCTION_DISCRIMINATORS.finalizeBondUnlock,
    dataLength: 1,
  },
  {
    action: "syncBondStakingRewards",
    discriminator: SAT_BOND_INSTRUCTION_DISCRIMINATORS.syncStakingRewards,
    dataLength: 1,
  },
  {
    action: "syncBondStakingPosition",
    discriminator: SAT_BOND_INSTRUCTION_DISCRIMINATORS.syncStakingPosition,
    dataLength: 1,
  },
  {
    action: "claimBondStakingRewards",
    discriminator: SAT_BOND_INSTRUCTION_DISCRIMINATORS.claimStakingRewards,
    dataLength: 1,
  },
  {
    action: "claimUnallocatedStakingRewards",
    discriminator: SAT_BOND_INSTRUCTION_DISCRIMINATORS.claimUnallocatedStakingRewards,
    dataLength: 1,
  },
];

function assertCodecData(codec: SatSignerCodec, data: Buffer): void {
  if (data[0] !== codec.discriminator) {
    throw new Error(`SAT ${codec.action} discriminator mismatch`);
  }
  if (codec.dataLength === "claimCycleRewardsBatch") {
    if (data.length < 17 || data.subarray(2, 9).some((value) => value !== 0)) {
      throw new Error("SAT claimCycleRewardsBatch has invalid canonical header");
    }
    const count = data[1] ?? 0;
    if (count === 0 || data.length !== 9 + count * 8) {
      throw new Error("SAT claimCycleRewardsBatch item count does not match its payload");
    }
    return;
  }
  if (data.length !== codec.dataLength) {
    throw new Error(
      `SAT ${codec.action} payload must contain ${codec.dataLength} bytes, got ${data.length}`,
    );
  }
}

export function resolveSatSignerCodec(params: {
  programId: string;
  mainProgramId: string;
  bondProgramId?: string;
  data: Buffer;
}): SatSignerCodec {
  const family =
    params.programId === params.mainProgramId
      ? MAIN_CODECS
      : params.bondProgramId && params.programId === params.bondProgramId
        ? BOND_CODECS
        : null;
  if (!family) {
    throw new Error(`SAT signer rejects unconfigured program ${params.programId}`);
  }
  const codec = family.find((candidate) => candidate.discriminator === params.data[0]);
  if (!codec) {
    throw new Error(
      `SAT signer has no typed action for discriminator ${params.data[0] ?? -1} on ${params.programId}`,
    );
  }
  assertCodecData(codec, params.data);
  return codec;
}

export const SAT_SIGNER_ACTIONS = [...MAIN_CODECS, ...BOND_CODECS].map(
  (codec) => codec.action,
) as readonly SatSignerAction[];
