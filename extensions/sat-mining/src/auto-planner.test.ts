import { describe, expect, it } from "vitest";
import { computeAutoPlannerDecision } from "./auto-planner.js";

describe("computeAutoPlannerDecision", () => {
  it("leans Top-K but keeps commit capped at the configured maximum when the cycle is sparse", () => {
    const decision = computeAutoPlannerDecision({
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        strategyPreset: "balanced",
        strategyExecution: "auto",
        strategyMode: "skill",
        commitLamports: 250_000_000,
        minSolBalanceLamports: 1_000_000_000,
      },
      cycleId: 100,
      walletBalanceLamports: "3000000000",
      capitalFundedLamports: "3000000000",
      capitalFreeLamports: "3000000000",
      globalState: {
        address: "global",
        currentUnlockSolLamports: "5000000000",
        minimumEntryLamports: "250000000",
        cycleErosionPpm: 50,
      },
      currentCycle: {
        address: "cycle",
        cycleId: 100,
        openTs: 0,
        closeTs: 0,
        status: 1,
        unlockTargetLamports: "5000000000",
        totalCommittedLamports: "1200000000",
        validMinerCount: "6",
        unlockRatioFp: "240000",
        issuedCycleMinerSatRaw: "0",
        unissuedCycleMinerSatRaw: "0",
        solErosionPoolLamports: "0",
        deterministicRebatePoolLamports: "0",
        performanceRebatePoolLamports: "0",
        treasurySolLamports: "0",
      },
      currentRegistryMeta: {
        address: "meta",
        cycleId: 100,
        participantCount: 6,
        pageCount: 1,
        closeTrackingInitialized: false,
        remainingParticipantCount: 6,
        remainingPageCount: 1,
      },
    });

    expect(decision.shouldSubmit).toBe(true);
    expect(decision.strategyPreset).toBe("top_k");
    expect(decision.riskMode).toBe("aggressive");
    expect(decision.commitLamports).toBe(250_000_000);
    expect(decision.rationale).toContain("configured max");
  });

  it("de-risks and reduces size when the cycle is crowded", () => {
    const decision = computeAutoPlannerDecision({
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        strategyPreset: "balanced",
        strategyExecution: "auto",
        strategyMode: "skill",
        commitLamports: 500_000_000,
        minSolBalanceLamports: 1_000_000_000,
      },
      cycleId: 100,
      walletBalanceLamports: "3000000000",
      capitalFundedLamports: "3000000000",
      capitalFreeLamports: "3000000000",
      globalState: {
        address: "global",
        currentUnlockSolLamports: "5000000000",
        minimumEntryLamports: "250000000",
        cycleErosionPpm: 50,
      },
      currentCycle: {
        address: "cycle",
        cycleId: 100,
        openTs: 0,
        closeTs: 0,
        status: 1,
        unlockTargetLamports: "5000000000",
        totalCommittedLamports: "9000000000",
        validMinerCount: "90",
        unlockRatioFp: "1800000",
        issuedCycleMinerSatRaw: "0",
        unissuedCycleMinerSatRaw: "0",
        solErosionPoolLamports: "0",
        deterministicRebatePoolLamports: "0",
        performanceRebatePoolLamports: "0",
        treasurySolLamports: "0",
      },
      currentRegistryMeta: {
        address: "meta",
        cycleId: 100,
        participantCount: 90,
        pageCount: 2,
        closeTrackingInitialized: false,
        remainingParticipantCount: 90,
        remainingPageCount: 2,
      },
    });

    expect(decision.shouldSubmit).toBe(true);
    expect(decision.strategyPreset).toBe("crowd_aware");
    expect(decision.riskMode).toBe("conservative");
    expect(decision.commitLamports).toBeLessThan(500_000_000);
  });

  it("skips when reserve protection leaves less than minimum entry", () => {
    const decision = computeAutoPlannerDecision({
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        strategyPreset: "balanced",
        strategyExecution: "auto",
        strategyMode: "skill",
        commitLamports: 250_000_000,
        minSolBalanceLamports: 1_000_000_000,
      },
      cycleId: 100,
      walletBalanceLamports: "1000000000",
      capitalFundedLamports: "3000000000",
      capitalFreeLamports: "0",
      globalState: {
        address: "global",
        currentUnlockSolLamports: "5000000000",
        minimumEntryLamports: "250000000",
        cycleErosionPpm: 50,
      },
    });

    expect(decision.shouldSubmit).toBe(false);
    expect(decision.commitLamports).toBe(0);
    expect(decision.rationale).toContain("skipped this cycle");
  });

  it("keeps auto submit eligible when free miner capital can top up wallet reserve", () => {
    const decision = computeAutoPlannerDecision({
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        strategyPreset: "balanced",
        strategyExecution: "auto",
        strategyMode: "skill",
        commitLamports: 250_000_000,
        minSolBalanceLamports: 1_000_000_000,
      },
      cycleId: 100,
      walletBalanceLamports: "1000000000",
      capitalFundedLamports: "3000000000",
      capitalFreeLamports: "3000000000",
      globalState: {
        address: "global",
        currentUnlockSolLamports: "5000000000",
        minimumEntryLamports: "250000000",
        cycleErosionPpm: 50,
      },
    });

    expect(decision.shouldSubmit).toBe(true);
    expect(decision.commitLamports).toBeGreaterThanOrEqual(250_000_000);
    expect(decision.rationale).toContain("free miner capital can top up cycle rent");
  });

  it("de-risks after a previous invalid participation", () => {
    const decision = computeAutoPlannerDecision({
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        strategyPreset: "balanced",
        strategyExecution: "auto",
        strategyMode: "skill",
        commitLamports: 250_000_000,
        minSolBalanceLamports: 1_000_000_000,
      },
      cycleId: 100,
      walletBalanceLamports: "3000000000",
      capitalFundedLamports: "3000000000",
      capitalFreeLamports: "3000000000",
      globalState: {
        address: "global",
        currentUnlockSolLamports: "5000000000",
        minimumEntryLamports: "250000000",
        cycleErosionPpm: 50,
      },
      previousMinerCycle: {
        address: "miner",
        authority: "wallet",
        cycleId: 99,
        committedLamports: "250000000",
        claimableSatRaw: "0",
        claimableDetRebateLamports: "0",
        claimablePerfRebateLamports: "0",
        claimedSatRaw: "0",
        claimedDetRebateLamports: "0",
        claimedPerfRebateLamports: "0",
        validParticipation: false,
      },
    });

    expect(decision.strategyPreset).toBe("safe_fallback");
    expect(decision.rationale).toContain("de-risked");
  });

  it("uses realized outcome history to widen and reduce after weak validity", () => {
    const decision = computeAutoPlannerDecision({
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        strategyPreset: "balanced",
        strategyExecution: "auto",
        strategyMode: "skill",
        commitLamports: 300_000_000,
        minSolBalanceLamports: 150_000_000,
      },
      cycleId: 100,
      walletBalanceLamports: "1000000000",
      capitalFundedLamports: "1000000000",
      capitalFreeLamports: "1000000000",
      globalState: {
        address: "global",
        currentUnlockSolLamports: "5000000000",
        minimumEntryLamports: "250000000",
        cycleErosionPpm: 50,
      },
      currentCycle: {
        address: "cycle",
        cycleId: 100,
        openTs: 0,
        closeTs: 0,
        status: 1,
        unlockTargetLamports: "5000000000",
        totalCommittedLamports: "2000000000",
        validMinerCount: "18",
        unlockRatioFp: "400000",
        issuedCycleMinerSatRaw: "0",
        unissuedCycleMinerSatRaw: "0",
        solErosionPoolLamports: "0",
        deterministicRebatePoolLamports: "0",
        performanceRebatePoolLamports: "0",
        treasurySolLamports: "0",
      },
      outcomeHistory: [
        {
          cycleId: 99,
          committedLamports: "300000000",
          totalSatEarnedRaw: "0",
          totalRebateLamports: "5000",
          txFeeLamports: "10000",
          netLiveCostLamports: "25000",
          validParticipation: false,
          recordedAt: "2026-03-27T10:00:00.000Z",
        },
        {
          cycleId: 98,
          committedLamports: "300000000",
          totalSatEarnedRaw: "0",
          totalRebateLamports: "5000",
          txFeeLamports: "9000",
          netLiveCostLamports: "24000",
          validParticipation: true,
          recordedAt: "2026-03-27T09:00:00.000Z",
        },
      ],
    });

    expect(decision.strategyPreset).toBe("safe_fallback");
    expect(decision.commitLamports).toBeLessThan(300_000_000);
    expect(decision.rationale).toContain("recent realized cycles");
  });

  it("uses realized fee history to raise the reserve fee buffer and skip tight wallets", () => {
    const decision = computeAutoPlannerDecision({
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        strategyPreset: "balanced",
        strategyExecution: "auto",
        strategyMode: "skill",
        commitLamports: 250_000_000,
        minSolBalanceLamports: 150_000_000,
      },
      cycleId: 100,
      walletBalanceLamports: "190000000",
      capitalFundedLamports: "1000000000",
      capitalFreeLamports: "1000000000",
      globalState: {
        address: "global",
        currentUnlockSolLamports: "5000000000",
        minimumEntryLamports: "250000000",
        cycleErosionPpm: 50,
      },
      currentCycle: {
        address: "cycle",
        cycleId: 100,
        openTs: 0,
        closeTs: 0,
        status: 1,
        unlockTargetLamports: "5000000000",
        totalCommittedLamports: "5000000000",
        validMinerCount: "70",
        unlockRatioFp: "1000000",
        issuedCycleMinerSatRaw: "0",
        unissuedCycleMinerSatRaw: "0",
        solErosionPoolLamports: "0",
        deterministicRebatePoolLamports: "0",
        performanceRebatePoolLamports: "0",
        treasurySolLamports: "0",
      },
      outcomeHistory: [
        {
          cycleId: 99,
          committedLamports: "250000000",
          totalSatEarnedRaw: "1000",
          totalRebateLamports: "7000",
          txFeeLamports: "40000",
          netLiveCostLamports: "45500",
          validParticipation: true,
          recordedAt: "2026-03-27T10:00:00.000Z",
        },
        {
          cycleId: 98,
          committedLamports: "250000000",
          totalSatEarnedRaw: "1000",
          totalRebateLamports: "7000",
          txFeeLamports: "45000",
          netLiveCostLamports: "50500",
          validParticipation: true,
          recordedAt: "2026-03-27T09:00:00.000Z",
        },
        {
          cycleId: 97,
          committedLamports: "250000000",
          totalSatEarnedRaw: "1000",
          totalRebateLamports: "7000",
          txFeeLamports: "42000",
          netLiveCostLamports: "47500",
          validParticipation: true,
          recordedAt: "2026-03-27T08:00:00.000Z",
        },
      ],
    });

    expect(decision.shouldSubmit).toBe(false);
    expect(decision.rationale).toContain("recent realized net cost");
  });

  it("uses contextual bandit samples while respecting the configured commit cap", () => {
    const decision = computeAutoPlannerDecision({
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        strategyPreset: "balanced",
        strategyExecution: "auto",
        strategyMode: "skill",
        commitLamports: 250_000_000,
        minSolBalanceLamports: 150_000_000,
        plannerConfig: {
          policyMode: "ucb",
          explorationRatePpm: 0,
        },
      },
      cycleId: 100,
      walletBalanceLamports: "1000000000",
      capitalFundedLamports: "1000000000",
      capitalFreeLamports: "1000000000",
      globalState: {
        address: "global",
        currentUnlockSolLamports: "5000000000",
        minimumEntryLamports: "250000000",
        cycleErosionPpm: 50,
      },
      currentCycle: {
        address: "cycle",
        cycleId: 100,
        openTs: 0,
        closeTs: 0,
        status: 1,
        unlockTargetLamports: "5000000000",
        totalCommittedLamports: "1200000000",
        validMinerCount: "6",
        unlockRatioFp: "240000",
        issuedCycleMinerSatRaw: "0",
        unissuedCycleMinerSatRaw: "0",
        solErosionPoolLamports: "0",
        deterministicRebatePoolLamports: "0",
        performanceRebatePoolLamports: "0",
        treasurySolLamports: "0",
      },
      currentRegistryMeta: {
        address: "meta",
        cycleId: 100,
        participantCount: 6,
        pageCount: 1,
        closeTrackingInitialized: false,
        remainingParticipantCount: 6,
        remainingPageCount: 1,
      },
      plannerCycles: Array.from({ length: 12 }, (_unused, index) => ({
        cycleId: index + 1,
        decidedAt: "2026-03-29T10:00:00.000Z",
        recordedAt: "2026-03-29T10:05:00.000Z",
        regimeKey: "open" as const,
        timeWindowKey: "morning" as const,
        strategyPreset: "balanced" as const,
        strategyExecution: "auto" as const,
        committedLamports: "250000000",
        totalSatEarnedRaw: "300000000000",
        totalRebateLamports: "10000",
        txFeeLamports: "30000",
        netLiveCostLamports: "32500",
        score: "0",
        validParticipation: true,
        experiment: {
          schemaVersion: 1,
          policyVersion: "sat-planner-v2",
          decisionEngine: "thompson",
          explorationPolicy: "thompson",
          explorationRatePpm: "80000",
          explorationTaken: false,
          capitalTier: "standard",
          contextKey: "open/morning",
          chosenActionKey: "conviction:push",
          baselineActionKey: "balanced:base",
          chosenEstimatedScore: "325000000000",
          baselineEstimatedScore: "280000000000",
          estimatedRegret: "0",
          confidenceRadius: "12000000000",
        },
        counterfactuals: [
          {
            actionKey: "balanced:base",
            strategyPreset: "balanced",
            commitBand: "base",
            commitLamports: "250000000",
            estimatedSatRaw: "300000000000",
            estimatedRebateLamports: "10000",
            estimatedNetLiveCostLamports: "32500",
            estimatedScore: "280000000000",
          },
          {
            actionKey: "conviction:push",
            strategyPreset: "conviction",
            commitBand: "push",
            commitLamports: "300000000",
            estimatedSatRaw: "360000000000",
            estimatedRebateLamports: "12000",
            estimatedNetLiveCostLamports: "35000",
            estimatedScore: "325000000000",
          },
        ],
      })),
    });

    expect(decision.commitLamports).toBe(250_000_000);
    expect(decision.rationale).toContain("ucb policy chose conviction:push");
    expect(decision.rationale).toContain("configured max");
  });
});
