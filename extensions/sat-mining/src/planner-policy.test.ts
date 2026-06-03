import { describe, expect, it } from "vitest";
import {
  buildCounterfactualScores,
  chooseContextualBanditAction,
  classifyPlannerCapitalTier,
  deriveCommitBand,
  scorePlannerOutcome,
} from "./planner-policy.js";

describe("planner policy", () => {
  it("scores realized outcomes with validity and cost penalties", () => {
    const valid = scorePlannerOutcome({
      totalSatEarnedRaw: "300000000000",
      netLiveCostLamports: "30000",
      validParticipation: true,
    });
    const invalid = scorePlannerOutcome({
      totalSatEarnedRaw: "300000000000",
      netLiveCostLamports: "30000",
      validParticipation: false,
    });

    expect(BigInt(valid)).toBeGreaterThan(BigInt(invalid));
  });

  it("builds preset and commit-band counterfactuals", () => {
    const scores = buildCounterfactualScores({
      cycle: {
        committedLamports: "250000000",
        strategyPreset: "balanced",
        totalSatEarnedRaw: "300000000000",
        totalRebateLamports: "10000",
        txFeeLamports: "30000",
        netLiveCostLamports: "32500",
        validParticipation: true,
      },
      maxCommitLamports: "500000000",
    });

    expect(scores).toHaveLength(12);
    expect(scores.find((entry) => entry.actionKey === "conviction:push")).toBeTruthy();
  });

  it("chooses a contextual bandit action from matching planner cycles", () => {
    const action = chooseContextualBanditAction({
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
          capitalTier: "starter",
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
      cycleId: 100,
      regimeKey: "open",
      timeWindowKey: "morning",
      capitalTier: "starter",
      configuredPreset: "balanced",
      minCommitLamports: 250_000_000n,
      maxCommitLamports: 500_000_000n,
      config: {
        plannerConfig: {
          policyMode: "ucb",
          explorationRatePpm: 0,
          minContextSamples: 6,
          priorSamples: 2,
          enableCapitalTierPolicies: true,
        },
      },
    });

    expect(action?.actionKey).toBe("conviction:push");
    expect(action?.strategyPreset).toBe("conviction");
  });

  it("classifies capital tiers and commit bands", () => {
    expect(classifyPlannerCapitalTier("500000000")).toBe("starter");
    expect(classifyPlannerCapitalTier("1500000000")).toBe("standard");
    expect(classifyPlannerCapitalTier("4000000000")).toBe("deep");
    expect(deriveCommitBand("250000000", "250000000")).toBe("base");
    expect(deriveCommitBand("200000000", "250000000")).toBe("min");
    expect(deriveCommitBand("300000000", "250000000")).toBe("push");
  });
});
