import { describe, expect, it } from "vitest";
import { computePlannerPolicyEvaluation } from "./planner-policy-eval.js";

describe("planner policy evaluation", () => {
  it("builds policy summaries, context leaders, capital tiers, and live validation windows", () => {
    const recordedAt = new Date().toISOString();
    const evaluation = computePlannerPolicyEvaluation(
      Array.from({ length: 6 }, (_unused, index) => ({
        cycleId: index + 1,
        decidedAt: recordedAt,
        recordedAt,
        regimeKey: "open" as const,
        timeWindowKey: "morning" as const,
        strategyExecution: index % 2 === 0 ? ("auto" as const) : ("deterministic" as const),
        strategyPreset: index % 2 === 0 ? ("conviction" as const) : ("balanced" as const),
        committedLamports: "250000000",
        totalSatEarnedRaw: "300000000000",
        totalRebateLamports: "10000",
        txFeeLamports: "30000",
        netLiveCostLamports: "32500",
        score: "280000000000",
        validParticipation: true,
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
        experiment: {
          schemaVersion: 1,
          policyVersion: "sat-planner-v2",
          decisionEngine: "thompson",
          explorationPolicy: "epsilon-greedy",
          explorationRatePpm: "80000",
          explorationTaken: index === 0,
          capitalTier: "starter" as const,
          contextKey: "open/morning",
          chosenActionKey: "conviction:push",
          baselineActionKey: "balanced:base",
          chosenEstimatedScore: "325000000000",
          baselineEstimatedScore: "280000000000",
          estimatedRegret: "0",
          confidenceRadius: "12000000000",
        },
      })),
    );

    expect(evaluation.summary.policyVersion).toBe("sat-planner-v2");
    expect(evaluation.topContexts[0]?.bestActionKey).toBe("conviction:push");
    expect(evaluation.capitalTierStats[0]?.key).toBe("starter");
    expect(evaluation.liveValidation).toHaveLength(3);
  });
});
