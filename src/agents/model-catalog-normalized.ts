import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import { normalizeProviderId } from "./provider-id.js";

export type ModelCatalogSource =
  | "configured"
  | "runtime"
  | "provider-api"
  | "current-preview"
  | "provider-index"
  | "manifest";

export type ModelCatalogStatus = "stable" | "preview" | "deprecated";

export type NormalizedModelCatalogRow = {
  id: string;
  name: string;
  provider: string;
  mergeKey: string;
  source: ModelCatalogSource;
  status: ModelCatalogStatus;
  input: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  baseUrl?: string;
  api?: ModelDefinitionConfig["api"];
};

const SOURCE_AUTHORITY: Record<ModelCatalogSource, number> = {
  configured: 500,
  "provider-api": 450,
  runtime: 400,
  manifest: 300,
  "provider-index": 200,
  "current-preview": 100,
};

export function normalizeModelCatalogProviderId(value: string): string {
  return normalizeProviderId(value);
}

export function normalizeModelCatalogModelId(value: string): string {
  return value.trim();
}

export function buildModelCatalogMergeKey(provider: string, modelId: string): string {
  return `${normalizeModelCatalogProviderId(provider)}::${normalizeModelCatalogModelId(
    modelId,
  ).toLowerCase()}`;
}

function normalizeModelInput(
  input: ModelDefinitionConfig["input"] | undefined,
): Array<"text" | "image"> {
  if (!Array.isArray(input)) {
    return ["text"];
  }
  const normalized = input.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return normalized.length > 0 ? normalized : ["text"];
}

function positiveNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function normalizeProviderCatalogRows(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  source: ModelCatalogSource;
  status?: ModelCatalogStatus;
}): NormalizedModelCatalogRow[] {
  const provider = normalizeModelCatalogProviderId(params.provider);
  if (!provider) {
    return [];
  }

  return (params.providerConfig.models ?? [])
    .map((model): NormalizedModelCatalogRow | undefined => {
      const id = normalizeModelCatalogModelId(model.id);
      if (!id) {
        return undefined;
      }
      return {
        id,
        name: model.name?.trim() || id,
        provider,
        mergeKey: buildModelCatalogMergeKey(provider, id),
        source: params.source,
        status: params.status ?? "stable",
        input: normalizeModelInput(model.input),
        contextWindow: positiveNumber(model.contextWindow),
        maxTokens: positiveNumber(model.maxTokens),
        reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
        baseUrl: model.baseUrl ?? params.providerConfig.baseUrl,
        api: model.api ?? params.providerConfig.api,
      };
    })
    .filter((row): row is NormalizedModelCatalogRow => Boolean(row));
}

export function mergeModelCatalogRowsByAuthority(
  rows: readonly NormalizedModelCatalogRow[],
): NormalizedModelCatalogRow[] {
  const merged = new Map<string, NormalizedModelCatalogRow>();
  for (const row of rows) {
    const existing = merged.get(row.mergeKey);
    if (!existing || SOURCE_AUTHORITY[row.source] > SOURCE_AUTHORITY[existing.source]) {
      merged.set(row.mergeKey, row);
    }
  }
  return [...merged.values()].toSorted(
    (left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
  );
}
