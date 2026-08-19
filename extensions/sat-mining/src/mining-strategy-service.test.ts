import { describe, expect, it, vi } from "vitest";

vi.mock("./strategy-skill.js", () => ({
  computeSkillStrategy: vi.fn(async () => {
    throw new Error("skill unavailable");
  }),
}));

import { createSatMiningStrategyService } from "./mining-strategy-service.js";
import { classifyPlannerRegime, classifyPlannerTimeWindow } from "./planner-analytics.js";
import {
  buildCounterfactualScores,
  classifyPlannerCapitalTier,
  plannerPolicyVersion,
  scorePlannerOutcome,
} from "./planner-policy.js";
import { computeMiningStrategy } from "./strategy-engine.js";

describe("Mining strategy service", () => {
  const round = {
    epochId: 1,
    microRoundId: 1,
    bucketVersion: 1,
    roundOpenTs: 1,
    roundCloseTs: 61,
    roundSeed: "0".repeat(64),
    bucketHash: "1".repeat(64),
  };

  it("preserves the strategy engine's base and fallback decisions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00.000Z"));
    const service = createSatMiningStrategyService();
    const baseParams = {
      config: {
        enabled: true,
        network: "devnet" as const,
        riskMode: "balanced" as const,
        strategyMode: "base" as const,
      },
      round,
    };
    const fallbackParams = {
      config: {
        enabled: true,
        network: "devnet" as const,
        riskMode: "balanced" as const,
        strategyMode: "skill" as const,
        skillConfig: {
          enabled: true,
          useAgentDefaultModel: true,
          fallbackToBaseOnFailure: true,
          maxDecisionLatencyMs: 8_000,
        },
      },
      round,
    };

    await expect(service.computeRoundStrategy(baseParams)).resolves.toEqual(
      await computeMiningStrategy(baseParams),
    );
    await expect(service.computeRoundStrategy(fallbackParams)).resolves.toMatchObject({
      source: "base",
      fallbackUsed: true,
    });
    vi.useRealTimers();
  });

  it("preserves the complete deterministic planner policy record", () => {
    const service = createSatMiningStrategyService();
    const outcome = {
      cycleId: 7,
      committedLamports: "250000000",
      totalSatEarnedRaw: "300000000000",
      totalRebateLamports: "10000",
      txFeeLamports: "30000",
      netLiveCostLamports: "32500",
      validParticipation: true,
      recordedAt: "2026-08-19T12:00:00.000Z",
    };
    const pendingPlannerCycle = {
      cycleId: 7,
      strategyPreset: "balanced" as const,
      strategyExecution: "auto" as const,
      participantCount: 6,
      pageCount: 1,
      crowdingRatioFp: "400000",
      capitalFundedLamports: "500000000",
      capitalFreeLamports: "250000000",
    };
    const record = service.buildPlannerCycleRecord({
      outcome,
      pendingPlannerCycle,
      committedMinerCount: 6,
    });

    const counterfactuals = buildCounterfactualScores({
      cycle: {
        ...outcome,
        strategyPreset: pendingPlannerCycle.strategyPreset,
      },
      maxCommitLamports: "500000000",
    });
    const chosenCounterfactual = counterfactuals.find(
      (entry) => entry.actionKey === "balanced:base",
    )!;
    const bestCounterfactual = counterfactuals.reduce(
      (best, entry) => (BigInt(entry.estimatedScore) > BigInt(best.estimatedScore) ? entry : best),
      counterfactuals[0]!,
    );
    const regimeKey = classifyPlannerRegime({
      participantCount: pendingPlannerCycle.participantCount,
      pageCount: pendingPlannerCycle.pageCount,
      crowdingRatioFp: pendingPlannerCycle.crowdingRatioFp,
    });

    expect(record).toEqual({
      ...outcome,
      decidedAt: outcome.recordedAt,
      regimeKey,
      timeWindowKey: classifyPlannerTimeWindow(outcome.recordedAt),
      committedMinerCount: 6,
      score: scorePlannerOutcome(outcome),
      counterfactuals,
      experiment: {
        schemaVersion: 1,
        policyVersion: plannerPolicyVersion(),
        decisionEngine: "rule",
        explorationPolicy: "none",
        explorationRatePpm: "0",
        explorationTaken: false,
        capitalTier: classifyPlannerCapitalTier(pendingPlannerCycle.capitalFundedLamports),
        contextKey: `${regimeKey}/${classifyPlannerTimeWindow(outcome.recordedAt)}`,
        chosenActionKey: "balanced:base",
        baselineActionKey: "balanced:base",
        chosenEstimatedScore: chosenCounterfactual.estimatedScore,
        baselineEstimatedScore: chosenCounterfactual.estimatedScore,
        estimatedRegret: (
          BigInt(bestCounterfactual.estimatedScore) - BigInt(chosenCounterfactual.estimatedScore)
        ).toString(),
        confidenceRadius: null,
      },
    });
  });
});
