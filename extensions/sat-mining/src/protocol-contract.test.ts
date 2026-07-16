import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SAT_BOND_INSTRUCTION_DISCRIMINATORS,
  SAT_GENESIS_PROFILE_CONTRACTS,
  SAT_INSTRUCTION_DISCRIMINATORS,
  SAT_PROTOCOL_CONSTANTS,
} from "./protocol-contract.js";

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
  topUpRegistryReserve: "SatTopUpRegistryReserve",
  claimProtocolDistributorSat: "SatClaimProtocolDistributorSat",
  refillRegistryReserveFromTreasury: "SatRefillRegistryReserveFromTreasury",
  commitCycle: "SatCommitCycle",
  closeCommitPhase: "SatCloseCommitPhase",
  sealCycleEntropy: "SatSealCycleEntropy",
  revealCycle: "SatRevealCycle",
  releaseUnrevealedCommit: "SatReleaseUnrevealedCommit",
  abortEmptyCycle: "SatAbortEmptyCycle",
  miningCrank: undefined,
};

const BOND_RUST_NAMES: Record<keyof typeof SAT_BOND_INSTRUCTION_DISCRIMINATORS, string> = {
  initTierPolicy: "InitBondTierPolicy",
  updateTierPolicy: "UpdateBondTierPolicy",
  openBondPosition: "OpenBondPosition",
  increaseBondPosition: "IncreaseBondPosition",
  requestBondUnlock: "RequestBondUnlock",
  cancelBondUnlock: "CancelBondUnlock",
  finalizeBondUnlock: "FinalizeBondUnlock",
  initStakingDistributor: "InitBondStakingDistributor",
  syncStakingRewards: "SyncBondStakingRewards",
  syncStakingPosition: "SyncBondStakingPosition",
  claimStakingRewards: "ClaimBondStakingRewards",
  claimUnallocatedStakingRewards: "ClaimUnallocatedStakingRewards",
  recordProtocolStakingRewards: "RecordProtocolStakingRewards",
};

describe("SAT protocol contract", () => {
  it("keeps core economics fixed", () => {
    expect(SAT_PROTOCOL_CONSTANTS).toEqual({
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
    });
  });

  it("matches the canonical entropy-unavailable marker when sibling source is available", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rustPath = path.resolve(here, "../../../../token/sat/api/src/consts.rs");
    if (!fs.existsSync(rustPath)) {
      return;
    }
    expect(fs.readFileSync(rustPath, "utf8")).toContain(
      "SAT_CYCLE_ENTROPY_UNAVAILABLE_SEED: [u8; 32] = [0xff; 32]",
    );
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

  it("matches the canonical sibling bond instruction enum when available", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rustPath = path.resolve(here, "../../../../token/sat/bond-api/src/instruction.rs");
    if (!fs.existsSync(rustPath)) {
      return;
    }
    const source = fs.readFileSync(rustPath, "utf8");
    for (const [key, rustName] of Object.entries(BOND_RUST_NAMES)) {
      expect(source, rustName).toMatch(
        new RegExp(
          `\\b${rustName}\\s*=\\s*${SAT_BOND_INSTRUCTION_DISCRIMINATORS[key as keyof typeof SAT_BOND_INSTRUCTION_DISCRIMINATORS]}\\b`,
        ),
      );
    }
  });

  it("matches the generated sibling genesis profiles when available", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const generatedRoot = path.resolve(here, "../../../../token/sat/genesis/generated");
    for (const [profile, filename] of [
      ["devnet", "sat-genesis.devnet.json"],
      ["mainnet-beta", "sat-genesis.mainnet.json"],
    ] as const) {
      const generatedPath = path.join(generatedRoot, filename);
      if (!fs.existsSync(generatedPath)) {
        continue;
      }
      const generated = JSON.parse(fs.readFileSync(generatedPath, "utf8")) as {
        configSha256: string;
        config: {
          cluster: string;
          registryReserve: { targetLamports: number; maxLamports: number };
          keeperReserve: { spendableLamports: number };
        };
      };
      const contract = SAT_GENESIS_PROFILE_CONTRACTS[profile];
      expect(contract.configSha256).toBe(generated.configSha256);
      expect(contract.cluster).toBe(generated.config.cluster);
      expect(contract.registryReserveTargetLamports).toBe(
        BigInt(generated.config.registryReserve.targetLamports),
      );
      expect(contract.registryReserveMaxLamports).toBe(
        BigInt(generated.config.registryReserve.maxLamports),
      );
      expect(contract.keeperReserveSpendableLamports).toBe(
        BigInt(generated.config.keeperReserve.spendableLamports),
      );
    }
  });

  it("keeps the packaged bond distributor layout identical to the Rust contract", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const packagedPath = path.resolve(
      here,
      "../../../token/sat/bond-api/bond-staking-distributor-layout.json",
    );
    const canonicalPath = path.resolve(
      here,
      "../../../../token/sat/bond-api/bond-staking-distributor-layout.json",
    );
    if (!fs.existsSync(canonicalPath)) {
      return;
    }

    const packaged = JSON.parse(fs.readFileSync(packagedPath, "utf8")) as unknown;
    const canonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8")) as unknown;
    expect(packaged).toEqual(canonical);
  });
});
