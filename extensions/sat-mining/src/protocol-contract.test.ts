import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SAT_INSTRUCTION_DISCRIMINATORS, SAT_PROTOCOL_CONSTANTS } from "./protocol-contract.js";

const RUST_NAMES: Record<keyof typeof SAT_INSTRUCTION_DISCRIMINATORS, string | undefined> = {
  bootstrap: "SatBootstrap",
  initializeCycle: undefined,
  finalizeEpoch: undefined,
  openRound: undefined,
  submitValidatorAttestation: undefined,
  openDispute: undefined,
  claim: undefined,
  resolveDispute: undefined,
  republishEpochRoots: undefined,
  submitParticipation: undefined,
  initMinerCapital: "SatInitMinerCapital",
  depositMinerCapital: "SatDepositMinerCapital",
  openCycle: "SatOpenCycle",
  submitCycle: "SatSubmitCycle",
  claimCycleRewards: "SatClaimCycleRewards",
  retargetUnlock: "SatRetargetUnlock",
  claimCycleRewardsBatch: "SatClaimCycleRewardsBatch",
  settleCyclePage: "SatSettleCyclePage",
  finalizeCycleSettlement: "SatFinalizeCycleSettlement",
  scoreCyclePage: "SatScoreCyclePage",
  distributeCyclePage: "SatDistributeCyclePage",
  withdrawMinerCapital: "SatWithdrawMinerCapital",
  setActiveCommit: "SatSetActiveCommit",
  closeResolvedMinerCycleState: "SatCloseResolvedMinerCycleState",
  closeResolvedCycleRegistryPage: "SatCloseResolvedCycleRegistryPage",
  closeResolvedCycleArtifacts: "SatCloseResolvedCycleArtifacts",
  compactPendingCycleRange: "SatCompactPendingCycleRange",
  setProtocolRecipients: "SatSetProtocolRecipients",
  claimProtocolTreasury: "SatClaimProtocolTreasury",
  openBondPosition: "SatLegacyOpenBondPosition",
  increaseBondPosition: "SatLegacyIncreaseBondPosition",
  requestBondUnlock: "SatLegacyRequestBondUnlock",
  cancelBondUnlock: "SatLegacyCancelBondUnlock",
  finalizeBondUnlock: "SatLegacyFinalizeBondUnlock",
  claimProtocolDistributorSat: "SatClaimProtocolDistributorSat",
  refillRegistryReserveFromTreasury: "SatRefillRegistryReserveFromTreasury",
  miningCrank: undefined,
};

describe("SAT protocol contract", () => {
  it("keeps core economics fixed", () => {
    expect(SAT_PROTOCOL_CONSTANTS).toEqual({
      allocationBuckets: 25,
      cycleSeconds: 300,
      cycleErosionPpm: 83n,
      minimumEntryLamports: 250_000_000,
      registryReserveTargetLamports: 200_000_000n,
    });
  });

  it("matches the canonical sibling Rust instruction enum when available", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rustPath = path.resolve(here, "../../../../token/sat/api/src/instruction.rs");
    if (!fs.existsSync(rustPath)) {
      return;
    }
    const source = fs.readFileSync(rustPath, "utf8");
    for (const [key, rustName] of Object.entries(RUST_NAMES)) {
      if (!rustName) {
        continue;
      }
      expect(source, rustName).toMatch(
        new RegExp(
          `\\b${rustName}\\s*=\\s*${SAT_INSTRUCTION_DISCRIMINATORS[key as keyof typeof SAT_INSTRUCTION_DISCRIMINATORS]}\\b`,
        ),
      );
    }
  });
});
