import { describe, expect, it } from "vitest";
import { deriveModelMetadata } from "./model-metadata.js";
import { recommendAvailableModels } from "./model-recommendations.js";

function model(provider: string, id: string, reasoning: boolean, price?: number) {
  const entry = { provider, id, name: id, reasoning, contextWindow: reasoning ? 200_000 : 32_000 };
  const metadata = deriveModelMetadata({ model: entry, cfg: {} });
  return {
    ...entry,
    metadata: {
      ...metadata,
      ...(price !== undefined
        ? {
            price: {
              input: price,
              output: price,
              cacheRead: 0,
              cacheWrite: 0,
              unit: "usd-per-million-tokens" as const,
            },
          }
        : {}),
    },
  };
}

describe("available account model recommendations", () => {
  it("recommends only available IDs separately for each access route", () => {
    const available = [
      model("openai", "fast-model", false, 1),
      model("openai", "deep-model", true, 5),
      model("openai-codex", "account-model", true),
    ];
    const result = recommendAvailableModels(available);
    expect(result.map((entry) => entry.id)).toEqual(available.map((entry) => entry.id));
    expect(result[0].metadata.recommendationTiers).toContain("fast");
    expect(result[1].metadata.recommendationTiers).toContain("deep");
    expect(result[2].metadata.recommendationTiers).toEqual(
      expect.arrayContaining(["balanced", "deep"]),
    );
    expect(available[0].metadata.recommendationTiers).toBeUndefined();
  });
  it("does not treat an unknown price as free or invent a deep model", () => {
    const result = recommendAvailableModels([
      model("test", "unknown", false),
      model("test", "priced", false, 2),
    ]);
    expect(result[1].metadata.recommendationTiers).toContain("fast");
    expect(result.every((entry) => !entry.metadata.recommendationTiers?.includes("deep"))).toBe(
      true,
    );
    expect(recommendAvailableModels([])).toEqual([]);
  });
});
