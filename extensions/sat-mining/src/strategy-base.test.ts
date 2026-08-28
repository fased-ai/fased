import { describe, expect, it } from "vitest";
import {
  SAT_BASE_ALLOCATIONS,
  computeBaseStrategy,
  type SatBaseStrategyPreset,
} from "./strategy-base.js";

describe("strategy-base", () => {
  it("returns exact normalized arrays for all risk modes", () => {
    for (const [riskMode, allocation] of Object.entries(SAT_BASE_ALLOCATIONS)) {
      expect(allocation).toHaveLength(25);
      expect(allocation.reduce((acc, item) => acc + item, 0)).toBe(1_000_000);
      const result = computeBaseStrategy({
        riskMode: riskMode as keyof typeof SAT_BASE_ALLOCATIONS,
        epochId: 1,
        microRoundId: 1,
        roundOpenTs: 1,
        roundCloseTs: 61,
      });
      expect(result.allocationFp).toEqual(allocation);
      expect(result.rationale.length).toBeGreaterThan(0);
    }
  });

  it("compiles every strategy preset to a valid 25-bucket allocation", () => {
    const presets: SatBaseStrategyPreset[] = [
      "spread",
      "balanced",
      "conviction",
      "swarm",
      "top_k",
      "ranked",
      "adaptive",
      "crowd_aware",
      "safe_fallback",
    ];

    for (const strategyPreset of presets) {
      const result = computeBaseStrategy({
        riskMode: "balanced",
        strategyPreset,
        epochId: 5933261,
        microRoundId: 0,
        roundOpenTs: 1_779_999_000,
        roundCloseTs: 1_779_999_300,
      });
      expect(result.allocationFp).toHaveLength(25);
      expect(result.allocationFp.reduce((acc, item) => acc + item, 0)).toBe(1_000_000);
      expect(result.rationale.length).toBeGreaterThan(0);
    }
  });

  it("compiles every strategy preset to the generation-2 16-channel contract", () => {
    const presets: SatBaseStrategyPreset[] = [
      "spread",
      "balanced",
      "conviction",
      "swarm",
      "top_k",
      "ranked",
      "adaptive",
      "crowd_aware",
      "safe_fallback",
    ];
    for (const strategyPreset of presets) {
      const result = computeBaseStrategy({
        riskMode: "balanced",
        strategyPreset,
        epochId: 1,
        microRoundId: 2,
        roundOpenTs: 3,
        roundCloseTs: 303,
        channelCount: 16,
      });
      expect(result.allocationFp).toHaveLength(16);
      expect(result.allocationFp.reduce((sum, value) => sum + value, 0)).toBe(1_000_000);
    }
  });

  it("makes advanced compiler presets materially different from safe fallback", () => {
    const base = computeBaseStrategy({
      riskMode: "balanced",
      strategyPreset: "safe_fallback",
      epochId: 5933261,
      microRoundId: 0,
      roundOpenTs: 1_779_999_000,
      roundCloseTs: 1_779_999_300,
    });
    const topK = computeBaseStrategy({
      riskMode: "aggressive",
      strategyPreset: "top_k",
      epochId: 5933261,
      microRoundId: 0,
      roundOpenTs: 1_779_999_000,
      roundCloseTs: 1_779_999_300,
    });

    expect(topK.allocationFp).not.toEqual(base.allocationFp);
    expect(topK.allocationFp.filter((value) => value > 0)).toHaveLength(3);
  });
});
