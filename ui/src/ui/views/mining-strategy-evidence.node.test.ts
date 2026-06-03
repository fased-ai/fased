import { describe, expect, it } from "vitest";
import { buildMiningStrategyAnalytics } from "./mining.js";

describe("mining strategy analytics", () => {
  it("aggregates strategy outcomes into visual analytics rows", () => {
    const analytics = buildMiningStrategyAnalytics([
      {
        cycleId: 9864001,
        committedLamports: "800000000",
        totalSatEarnedRaw: "200000000000",
        totalRebateLamports: "120000",
        deterministicRebateLamports: "40000",
        performanceRebateLamports: "80000",
        netLiveCostLamports: "44000",
        placementReturnFp: "1120000",
        benchmarkReturnFp: "1000000",
        skillScoreFp: "120000",
        crowdingRatioFp: "750000",
        committedMinerCount: 3,
        strategyPreset: "top_k" as const,
        strategyExecution: "auto" as const,
        strategyFallbackUsed: true,
        strategySource: "skill" as const,
        strategyRationale: "fallback after low confidence",
        recordedAt: "2026-04-03T12:01:00.000Z",
      },
      {
        cycleId: 9864000,
        committedLamports: "800000000",
        totalSatEarnedRaw: "100000000000",
        totalRebateLamports: "110000",
        claimableDetRebateLamports: "50000",
        claimablePerfRebateLamports: "60000",
        netLiveCostLamports: "45000",
        placementReturnFp: "1000000",
        benchmarkReturnFp: "1000000",
        skillScoreFp: "0",
        crowdingRatioFp: "500000",
        participantCount: 2,
        strategyPreset: "balanced" as const,
        strategyExecution: "deterministic" as const,
        strategyFallbackUsed: false,
        strategySource: "base" as const,
        recordedAt: "2026-04-03T12:00:00.000Z",
      },
    ]);

    expect(analytics?.summary.totalCycles).toBe(2);
    expect(analytics?.summary.totalSatLabel).toBe("3");
    expect(analytics?.summary.totalRebateLabel).toBe("0.00023");
    expect(analytics?.summary.totalDetRebateLabel).toBe("0.00009");
    expect(analytics?.summary.totalPerfRebateLabel).toBe("0.00014");
    expect(analytics?.summary.totalNetLabel).toBe("+0.00009");
    expect(analytics?.summary.bestSkillLabel).toBe("Top-K");
    expect(analytics?.summary.bestSkillDetail).toBe("+12% edge · 12% skill");
    expect(analytics?.summary.executionDetail).toBe("Auto 1 · Deterministic 1");
    expect(analytics?.summary.sourceDetail).toBe("Task/skill 1 · Fallback 1");
    expect(analytics?.rows.map((row) => row.strategyLabel)).toContain("Top-K");
    const topK = analytics?.rows.find((row) => row.strategyLabel === "Top-K");
    expect(topK?.taskCount).toBe(1);
    expect(topK?.fallbackCount).toBe(1);
    expect(topK?.avgDetRebateLabel).toBe("0.00004");
    expect(topK?.avgPerfRebateLabel).toBe("0.00008");
    expect(topK?.avgSkillEdgeLabel).toBe("+12%");
    expect(topK?.avgSkillLabel).toBe("12%");
    expect(topK?.avgCrowdingLabel).toBe("75%");
    expect(topK?.avgPoolLabel).toBe("3 miners");
  });

  it("falls back from missing strategy preset to risk mode instead of Unknown", () => {
    const analytics = buildMiningStrategyAnalytics([
      {
        cycleId: 9864002,
        totalSatEarnedRaw: "100000000000",
        totalRebateLamports: "100000",
        netLiveCostLamports: "10000",
        riskMode: "aggressive" as const,
        strategyExecution: "deterministic" as const,
      },
      {
        cycleId: 9864003,
        totalSatEarnedRaw: "100000000000",
        totalRebateLamports: "100000",
        netLiveCostLamports: "10000",
        strategyExecution: "deterministic" as const,
      },
    ]);

    expect(analytics?.rows.map((row) => row.strategyLabel)).toEqual(["Conviction", "Unrecorded"]);
  });
});
