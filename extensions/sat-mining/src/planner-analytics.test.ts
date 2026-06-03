import { describe, expect, it } from "vitest";
import {
  classifyPlannerRegime,
  classifyPlannerTimeWindow,
  computePlannerAnalytics,
} from "./planner-analytics.js";

describe("planner analytics", () => {
  it("classifies regimes from participant and crowding data", () => {
    expect(
      classifyPlannerRegime({ participantCount: 8, pageCount: 1, crowdingRatioFp: "400000" }),
    ).toBe("open");
    expect(
      classifyPlannerRegime({ participantCount: 72, pageCount: 2, crowdingRatioFp: "1400000" }),
    ).toBe("crowded");
    expect(
      classifyPlannerRegime({ participantCount: 36, pageCount: 1, crowdingRatioFp: "950000" }),
    ).toBe("balanced");
  });

  it("classifies local time windows", () => {
    expect(classifyPlannerTimeWindow("2026-03-29T02:00:00.000Z")).toMatch(
      /overnight|morning|afternoon|evening/,
    );
  });

  it("builds regime, time-window, and deterministic-baseline summaries", () => {
    const analytics = computePlannerAnalytics([
      {
        cycleId: 1,
        committedLamports: "250000000",
        totalSatEarnedRaw: "3000",
        totalRebateLamports: "10000",
        txFeeLamports: "30000",
        netLiveCostLamports: "32500",
        validParticipation: true,
        strategyExecution: "auto",
        strategyPreset: "conviction",
        participantCount: 8,
        pageCount: 1,
        crowdingRatioFp: "400000",
        recordedAt: "2026-03-29T09:00:00.000Z",
      },
      {
        cycleId: 2,
        committedLamports: "250000000",
        totalSatEarnedRaw: "2500",
        totalRebateLamports: "9000",
        txFeeLamports: "30000",
        netLiveCostLamports: "35000",
        validParticipation: true,
        strategyExecution: "deterministic",
        strategyPreset: "balanced",
        participantCount: 10,
        pageCount: 1,
        crowdingRatioFp: "450000",
        recordedAt: "2026-03-29T10:00:00.000Z",
      },
      {
        cycleId: 3,
        committedLamports: "300000000",
        totalSatEarnedRaw: "1800",
        totalRebateLamports: "5000",
        txFeeLamports: "35000",
        netLiveCostLamports: "45000",
        validParticipation: false,
        strategyExecution: "auto",
        strategyPreset: "spread",
        participantCount: 70,
        pageCount: 2,
        crowdingRatioFp: "1400000",
        recordedAt: "2026-03-29T20:00:00.000Z",
      },
    ]);

    expect(analytics.regimeBuckets.find((entry) => entry.key === "open")?.samples).toBe(2);
    expect(analytics.regimeBuckets.find((entry) => entry.key === "crowded")?.samples).toBe(1);
    expect(analytics.timeWindowStats.length).toBeGreaterThan(0);
    expect(analytics.deterministicBaseline.autoSamples).toBe(2);
    expect(analytics.deterministicBaseline.deterministicSamples).toBe(1);
    expect(analytics.deterministicBaseline.deltaAverageNetLiveCostLamports).not.toBeNull();
  });
});
