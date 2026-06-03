import { describe, expect, it, vi } from "vitest";
import { computeMiningStrategy } from "./strategy-engine.js";
import { computeSkillStrategy } from "./strategy-skill.js";

vi.mock("./strategy-skill.js", () => ({
  computeSkillStrategy: vi.fn(async () => ({
    allocationFp: [1000000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rationale: "mock skill result",
    modelId: "openai/gpt-5",
    skillId: "sat-mining-skill",
  })),
}));

describe("strategy-engine", () => {
  const round = {
    epochId: 1,
    microRoundId: 1,
    bucketVersion: 1,
    roundOpenTs: 1,
    roundCloseTs: 61,
    roundSeed: "0".repeat(64),
    bucketHash: "1".repeat(64),
  };

  it("returns base strategy deterministically", async () => {
    const result = await computeMiningStrategy({
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        strategyMode: "base",
      },
      round,
    });
    expect(result.source).toBe("base");
    expect(result.allocationFp).toHaveLength(25);
  });

  it("returns skill strategy with fallback metadata disabled on success", async () => {
    const liveContext = {
      currentCycleId: 123,
      participantCount: 2,
      totalCommittedLamports: "6400000000",
    };
    const result = await computeMiningStrategy({
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        strategyPreset: "ranked",
        strategyMode: "skill",
        skillConfig: {
          enabled: true,
          useAgentDefaultModel: false,
          preferredModelId: "openai/gpt-5",
          fallbackToBaseOnFailure: true,
          maxDecisionLatencyMs: 8000,
        },
      },
      round,
      liveContext,
    });
    expect(result.allocationFp).toHaveLength(25);
    expect(result.source).toBe("skill");
    expect(result.fallbackUsed).toBe(false);
    expect(computeSkillStrategy).toHaveBeenCalledWith(
      expect.objectContaining({
        strategyPreset: "ranked",
        liveContext,
      }),
    );
  });

  it("propagates fallback metadata from the skill wrapper", async () => {
    vi.mocked(computeSkillStrategy).mockResolvedValueOnce({
      allocationFp: [
        1000000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ],
      rationale: "skill wrapper fallback",
      modelId: "openrouter/openrouter/auto",
      skillId: "sat-mining-skill",
      fallbackUsed: true,
    });

    const result = await computeMiningStrategy({
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        strategyMode: "skill",
        skillConfig: {
          enabled: true,
          useAgentDefaultModel: true,
          fallbackToBaseOnFailure: true,
          maxDecisionLatencyMs: 8000,
        },
      },
      round,
    });

    expect(result.source).toBe("skill");
    expect(result.fallbackUsed).toBe(true);
  });
});
