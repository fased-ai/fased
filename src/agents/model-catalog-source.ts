import type { FasedAgentConfig } from "../config/config.js";
import {
  MODEL_APIS,
  type ModelDefinitionConfig,
  type ModelProviderConfig,
} from "../config/types.models.js";
import {
  isOpenAISignInRuntimeModelSupported,
  isStandardProviderCatalogEntry,
  listProviderBrandManifests,
} from "../providers/registry.js";
import {
  CURRENT_MODEL_PROVIDER_CATALOG,
  listCurrentModelCatalogRows,
} from "./current-model-catalog.js";
import {
  buildModelCatalogMergeKey,
  mergeModelCatalogRowsByAuthority,
  normalizeModelCatalogModelId,
  normalizeModelCatalogProviderId,
  normalizeProviderCatalogRows,
  type ModelCatalogSource,
  type NormalizedModelCatalogRow,
} from "./model-catalog-normalized.js";
import { deriveModelMetadata } from "./model-metadata.js";

export type FasedRuntimeModelCatalogSource = {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
  reasoning?: unknown;
  input?: unknown;
  baseUrl?: unknown;
  api?: unknown;
};

export type FasedModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  baseUrl?: string;
  api?: string;
  catalogSource?: ModelCatalogSource;
  metadata?: ReturnType<typeof deriveModelMetadata>;
};

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeInput(value: unknown): Array<"text" | "image"> {
  if (!Array.isArray(value)) {
    return ["text"];
  }
  const out = value.filter((item): item is "text" | "image" => item === "text" || item === "image");
  return out.length > 0 ? out : ["text"];
}

function normalizeApi(value: unknown): ModelDefinitionConfig["api"] | undefined {
  return MODEL_APIS.includes(value as (typeof MODEL_APIS)[number])
    ? (value as (typeof MODEL_APIS)[number])
    : undefined;
}

function isSupportedRuntimeCatalogModel(provider: string, id: string): boolean {
  if (provider !== "openai-codex") {
    return true;
  }
  return isOpenAISignInRuntimeModelSupported(id);
}

function configuredProviderCatalogRows(cfg: FasedAgentConfig): NormalizedModelCatalogRow[] {
  return Object.entries(cfg.models?.providers ?? {}).flatMap(([provider, providerConfig]) =>
    normalizeProviderCatalogRows({
      provider,
      providerConfig,
      source: "configured",
      status: "stable",
    }),
  );
}

function providerPluginCatalogRows(
  providers: Record<string, ModelProviderConfig> | undefined,
): NormalizedModelCatalogRow[] {
  return Object.entries(providers ?? {}).flatMap(([provider, providerConfig]) =>
    normalizeProviderCatalogRows({
      provider,
      providerConfig,
      source: "provider-index",
      status: "stable",
    }),
  );
}

function runtimeCatalogRows(params: {
  models: readonly FasedRuntimeModelCatalogSource[];
  onEntryError?: (error: unknown) => void;
}): NormalizedModelCatalogRow[] {
  const rows: NormalizedModelCatalogRow[] = [];
  for (const model of params.models) {
    try {
      const idRaw = normalizeString(model.id);
      const providerRaw = normalizeString(model.provider);
      if (!idRaw || !providerRaw) {
        continue;
      }
      const id = normalizeModelCatalogModelId(idRaw);
      const provider = normalizeModelCatalogProviderId(providerRaw);
      if (!id || !provider) {
        continue;
      }
      if (!isSupportedRuntimeCatalogModel(provider, id)) {
        continue;
      }
      if (
        id.toLowerCase() === "gpt-5.3-codex-spark" &&
        (provider === "openai" || provider === "azure-openai-responses")
      ) {
        continue;
      }
      rows.push({
        id,
        name: normalizeString(model.name) ?? id,
        provider,
        mergeKey: buildModelCatalogMergeKey(provider, id),
        source: "runtime",
        status: "stable",
        input: normalizeInput(model.input),
        contextWindow: normalizePositiveNumber(model.contextWindow),
        maxTokens: normalizePositiveNumber(model.maxTokens),
        reasoning: normalizeBoolean(model.reasoning),
        baseUrl: normalizeString(model.baseUrl),
        api: normalizeApi(model.api),
      });
    } catch (error) {
      params.onEntryError?.(error);
    }
  }
  return rows;
}

function manifestCatalogRows(): NormalizedModelCatalogRow[] {
  return listProviderBrandManifests().flatMap((manifest) =>
    manifest.models.recommended.flatMap((ref) => {
      const slash = ref.indexOf("/");
      if (slash <= 0 || slash === ref.length - 1) {
        return [];
      }
      const provider = normalizeModelCatalogProviderId(ref.slice(0, slash));
      const id = normalizeModelCatalogModelId(ref.slice(slash + 1));
      if (!provider || !id) {
        return [];
      }
      return [
        {
          id,
          name: id,
          provider,
          mergeKey: buildModelCatalogMergeKey(provider, id),
          source: "manifest" as const,
          status: "stable" as const,
          input: ["text" as const],
        },
      ];
    }),
  );
}

function providerConfigForRow(
  cfg: FasedAgentConfig,
  row: NormalizedModelCatalogRow,
): ModelProviderConfig | undefined {
  return cfg.models?.providers?.[row.provider] ?? CURRENT_MODEL_PROVIDER_CATALOG[row.provider];
}

export function buildFasedModelCatalogRows(params: {
  config: FasedAgentConfig;
  runtimeModels?: readonly FasedRuntimeModelCatalogSource[];
  providerPluginProviders?: Record<string, ModelProviderConfig>;
  onRuntimeEntryError?: (error: unknown) => void;
}): NormalizedModelCatalogRow[] {
  const discoveredRows = mergeModelCatalogRowsByAuthority([
    ...listCurrentModelCatalogRows(),
    ...providerPluginCatalogRows(params.providerPluginProviders),
    ...runtimeCatalogRows({
      models: params.runtimeModels ?? [],
      onEntryError: params.onRuntimeEntryError,
    }),
    ...configuredProviderCatalogRows(params.config),
  ]);
  const discoveredKeys = new Set(discoveredRows.map((row) => row.mergeKey));
  const missingManifestRows = manifestCatalogRows().filter(
    (row) => !discoveredKeys.has(row.mergeKey),
  );
  return mergeModelCatalogRowsByAuthority([...discoveredRows, ...missingManifestRows]);
}

export function buildFasedModelCatalogEntries(params: {
  config: FasedAgentConfig;
  runtimeModels?: readonly FasedRuntimeModelCatalogSource[];
  providerPluginProviders?: Record<string, ModelProviderConfig>;
  includeMetadata?: boolean;
  onRuntimeEntryError?: (error: unknown) => void;
}): FasedModelCatalogEntry[] {
  return buildFasedModelCatalogRows({
    config: params.config,
    runtimeModels: params.runtimeModels,
    providerPluginProviders: params.providerPluginProviders,
    onRuntimeEntryError: params.onRuntimeEntryError,
  }).map((row) => {
    const providerConfig = providerConfigForRow(params.config, row);
    const model = {
      id: row.id,
      name: row.name,
      provider: row.provider,
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
      reasoning: row.reasoning,
      input: row.input,
      baseUrl: row.baseUrl,
      api: row.api,
      catalogSource: row.source,
    };
    return {
      ...model,
      ...(params.includeMetadata
        ? {
            metadata: deriveModelMetadata({
              model,
              cfg: params.config,
              providerConfig,
              recommended: isStandardProviderCatalogEntry(row),
            }),
          }
        : {}),
    };
  });
}
