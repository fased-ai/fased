import type { ModelCatalogEntry } from "./model-catalog.js";
import type { ModelMetadata } from "./model-metadata.js";

export type ModelRecommendationTier = "fast" | "balanced" | "deep";

/** Selection aids from available metadata, never entitlements or moving task aliases. */
export function recommendAvailableModels<T extends ModelCatalogEntry & { metadata: ModelMetadata }>(
  models: T[],
): T[] {
  const tiers = new Map<T, ModelRecommendationTier[]>();
  const byRoute = new Map<string, T[]>();
  for (const model of models) {
    const group = byRoute.get(model.provider) ?? [];
    group.push(model);
    byRoute.set(model.provider, group);
  }
  const rank = (model: T) => model.metadata.recommendationRank ?? Number.MAX_SAFE_INTEGER;
  const price = (model: T) =>
    model.metadata.price && model.metadata.price.output > 0
      ? model.metadata.price.output
      : Number.MAX_SAFE_INTEGER;
  const add = (model: T | undefined, tier: ModelRecommendationTier) => {
    if (model) {
      tiers.set(model, [...(tiers.get(model) ?? []), tier]);
    }
  };
  for (const group of byRoute.values()) {
    // Prefer documented/curated rankings; unknown prices never count as free.
    add(group.toSorted((a, b) => rank(a) - rank(b))[0], "balanced");
    add(
      group.toSorted(
        (a, b) =>
          Number(a.metadata.features.includes("reasoning")) -
            Number(b.metadata.features.includes("reasoning")) ||
          price(a) - price(b) ||
          rank(a) - rank(b),
      )[0],
      "fast",
    );
    add(
      group
        .filter((model) => model.metadata.features.includes("reasoning"))
        .toSorted(
          (a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0) || rank(a) - rank(b),
        )[0],
      "deep",
    );
  }
  return models.map((model) => ({
    ...model,
    metadata: { ...model.metadata, recommendationTiers: tiers.get(model) ?? [] },
  }));
}
