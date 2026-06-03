import { describe, expect, it } from "vitest";
import { mergeSatPlannerOutcome } from "./planner-outcomes.js";

describe("mergeSatPlannerOutcome", () => {
  it("keeps the richer values and recomputes net live cost", () => {
    const merged = mergeSatPlannerOutcome(
      {
        cycleId: 10,
        committedLamports: "300000000",
        totalSatEarnedRaw: "0",
        totalRebateLamports: "0",
        txFeeLamports: "0",
        netLiveCostLamports: "15000",
        validParticipation: true,
        strategyExecution: "auto",
        strategyPreset: "conviction",
        participantCount: 6,
        pageCount: 1,
        crowdingRatioFp: "240000",
        recordedAt: "2026-03-28T15:00:00.000Z",
      },
      {
        cycleId: 10,
        committedLamports: "300000000",
        totalSatEarnedRaw: "357366800890",
        totalRebateLamports: "10000",
        txFeeLamports: "30000",
        netLiveCostLamports: "0",
        validParticipation: true,
        strategySource: "skill",
        modelId: "openai/gpt-5.4",
        recordedAt: "2026-03-28T15:02:00.000Z",
      },
      50n,
    );

    expect(merged.totalSatEarnedRaw).toBe("357366800890");
    expect(merged.totalRebateLamports).toBe("10000");
    expect(merged.txFeeLamports).toBe("30000");
    expect(merged.netLiveCostLamports).toBe("35000");
    expect(merged.validParticipation).toBe(true);
    expect(merged.strategyExecution).toBe("auto");
    expect(merged.strategyPreset).toBe("conviction");
    expect(merged.participantCount).toBe(6);
    expect(merged.modelId).toBe("openai/gpt-5.4");
    expect(merged.recordedAt).toBe("2026-03-28T15:02:00.000Z");
  });

  it("does not let a partial later sample erase earlier non-zero values", () => {
    const merged = mergeSatPlannerOutcome(
      {
        cycleId: 11,
        committedLamports: "250000000",
        totalSatEarnedRaw: "297219005874",
        totalRebateLamports: "10000",
        txFeeLamports: "35000",
        netLiveCostLamports: "37500",
        validParticipation: true,
        recordedAt: "2026-03-28T15:03:00.000Z",
      },
      {
        cycleId: 11,
        committedLamports: "250000000",
        totalSatEarnedRaw: "0",
        totalRebateLamports: "0",
        txFeeLamports: "5000",
        netLiveCostLamports: "0",
        validParticipation: true,
        recordedAt: "2026-03-28T15:04:00.000Z",
      },
      50n,
    );

    expect(merged.totalSatEarnedRaw).toBe("297219005874");
    expect(merged.totalRebateLamports).toBe("10000");
    expect(merged.txFeeLamports).toBe("35000");
    expect(merged.netLiveCostLamports).toBe("37500");
  });

  it("recomputes net live cost with the configured live erosion rate", () => {
    const merged = mergeSatPlannerOutcome(
      {
        cycleId: 12,
        committedLamports: "6400000000",
        totalSatEarnedRaw: "5073457139708",
        totalRebateLamports: "424960",
        txFeeLamports: "30000",
        netLiveCostLamports: "136240",
        validParticipation: true,
        recordedAt: "2026-04-05T19:40:00.000Z",
      },
      {
        cycleId: 12,
        committedLamports: "6400000000",
        totalSatEarnedRaw: "5073457139708",
        totalRebateLamports: "424960",
        txFeeLamports: "30000",
        netLiveCostLamports: "0",
        validParticipation: true,
        recordedAt: "2026-04-05T19:45:00.000Z",
      },
      83n,
    );

    expect(merged.netLiveCostLamports).toBe("136240");
  });

  it("subtracts keeper bounty from net live cost when cycle proof recorded it", () => {
    const merged = mergeSatPlannerOutcome(
      {
        cycleId: 13,
        committedLamports: "3825000000",
        totalSatEarnedRaw: "1987000000000",
        totalRebateLamports: "480000",
        txFeeLamports: "40000",
        netLiveCostLamports: "0",
        validParticipation: true,
        recordedAt: "2026-04-13T00:00:00.000Z",
      },
      {
        cycleId: 13,
        committedLamports: "3825000000",
        totalSatEarnedRaw: "1987000000000",
        totalRebateLamports: "480000",
        txFeeLamports: "40000",
        netLiveCostLamports: "0",
        erosionLamports: "317475",
        keeperBountyLamports: "7500",
        validParticipation: true,
        recordedAt: "2026-04-13T00:05:00.000Z",
      },
      83n,
    );

    expect(merged.keeperBountyLamports).toBe("7500");
    expect(merged.netLiveCostLamports).toBe("-130025");
  });
});
