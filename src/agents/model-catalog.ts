import { type FasedAgentConfig, loadConfig } from "../config/config.js";
import type { ModelCapabilityConfig, ModelProviderConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.runtime.js";
import { resolveFasedAgentAgentDir } from "./agent-paths.js";
import {
  normalizeModelCatalogProviderId,
  type ModelCatalogSource,
} from "./model-catalog-normalized.js";
import {
  buildFasedModelCatalogEntries,
  type FasedRuntimeModelCatalogSource,
} from "./model-catalog-source.js";
import { deriveModelMetadata, type ModelMetadata } from "./model-metadata.js";
import { ensureFasedAgentModelsJson } from "./models-config.js";
import {
  __setProviderExtensionCatalogEntriesForTest,
  loadProviderExtensionCatalogIndex,
} from "./provider-extension-catalog-index.js";

const log = createSubsystemLogger("model-catalog");

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  capabilities?: ModelCapabilityConfig;
  baseUrl?: string;
  api?: string;
  catalogSource?: ModelCatalogSource;
  metadata?: ModelMetadata;
};

type DiscoveredModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  capabilities?: ModelCapabilityConfig;
  baseUrl?: string;
  api?: string;
};

type PiSdkModule = typeof import("./pi-model-discovery.js");

let modelCatalogPromise: Promise<ModelCatalogEntry[]> | null = null;
let hasLoggedModelCatalogError = false;
let hasLoggedProviderCatalogError = false;
const defaultImportPiSdk = () => import("./pi-model-discovery.js");
let importPiSdk = defaultImportPiSdk;

const CODEX_PROVIDER = "openai-codex";
const OPENAI_PROVIDER = "openai";
const OPENAI_GPT55_MODEL_ID = "gpt-5.5";
const OPENAI_GPT55_PRO_MODEL_ID = "gpt-5.5-pro";
const OPENAI_GPT54_MODEL_ID = "gpt-5.4";
const OPENAI_GPT54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_GPT54_MINI_MODEL_ID = "gpt-5.4-mini";
const OPENAI_GPT54_NANO_MODEL_ID = "gpt-5.4-nano";
const OPENAI_CODEX_GPT55_MODEL_ID = "gpt-5.5";
const OPENAI_CODEX_GPT54_MODEL_ID = "gpt-5.4";
const OPENAI_CODEX_GPT54_MINI_MODEL_ID = "gpt-5.4-mini";
const OPENAI_CODEX_GPT53_MODEL_ID = "gpt-5.3-codex";

type SyntheticCatalogFallback = {
  provider: string;
  id: string;
  templateIds: readonly string[];
};

const SYNTHETIC_CATALOG_FALLBACKS: readonly SyntheticCatalogFallback[] = [
  {
    provider: OPENAI_PROVIDER,
    id: OPENAI_GPT55_MODEL_ID,
    templateIds: [OPENAI_GPT54_MODEL_ID, "gpt-5.2"],
  },
  {
    provider: OPENAI_PROVIDER,
    id: OPENAI_GPT55_PRO_MODEL_ID,
    templateIds: [OPENAI_GPT54_PRO_MODEL_ID, OPENAI_GPT54_MODEL_ID, "gpt-5.2-pro", "gpt-5.2"],
  },
  {
    provider: OPENAI_PROVIDER,
    id: OPENAI_GPT54_MODEL_ID,
    templateIds: ["gpt-5.2"],
  },
  {
    provider: OPENAI_PROVIDER,
    id: OPENAI_GPT54_PRO_MODEL_ID,
    templateIds: ["gpt-5.2-pro", "gpt-5.2"],
  },
  {
    provider: OPENAI_PROVIDER,
    id: OPENAI_GPT54_MINI_MODEL_ID,
    templateIds: ["gpt-5-mini"],
  },
  {
    provider: OPENAI_PROVIDER,
    id: OPENAI_GPT54_NANO_MODEL_ID,
    templateIds: ["gpt-5-nano", "gpt-5-mini"],
  },
  {
    provider: CODEX_PROVIDER,
    id: OPENAI_CODEX_GPT55_MODEL_ID,
    templateIds: [OPENAI_CODEX_GPT54_MODEL_ID, OPENAI_CODEX_GPT53_MODEL_ID],
  },
  {
    provider: CODEX_PROVIDER,
    id: OPENAI_CODEX_GPT54_MODEL_ID,
    templateIds: [OPENAI_CODEX_GPT53_MODEL_ID],
  },
  {
    provider: CODEX_PROVIDER,
    id: OPENAI_CODEX_GPT54_MINI_MODEL_ID,
    templateIds: [OPENAI_CODEX_GPT54_MODEL_ID, OPENAI_CODEX_GPT53_MODEL_ID],
  },
] as const;

function applySyntheticCatalogFallbacks(models: ModelCatalogEntry[]): void {
  const findCatalogEntry = (provider: string, id: string) =>
    models.find(
      (entry) =>
        entry.provider.toLowerCase() === provider.toLowerCase() &&
        entry.id.toLowerCase() === id.toLowerCase(),
    );

  for (const fallback of SYNTHETIC_CATALOG_FALLBACKS) {
    if (findCatalogEntry(fallback.provider, fallback.id)) {
      continue;
    }
    const template = fallback.templateIds
      .map((templateId) => findCatalogEntry(fallback.provider, templateId))
      .find((entry) => entry !== undefined);
    if (!template) {
      continue;
    }

    const { metadata: _ignoredMetadata, ...templateWithoutMetadata } = template;
    models.push({
      ...templateWithoutMetadata,
      id: fallback.id,
      name: fallback.id,
      ...(template.metadata
        ? {
            metadata: deriveModelMetadata({
              model: {
                ...templateWithoutMetadata,
                id: fallback.id,
                name: fallback.id,
              },
            }),
          }
        : {}),
    });
  }
}

export function resetModelCatalogCacheForTest() {
  modelCatalogPromise = null;
  hasLoggedModelCatalogError = false;
  hasLoggedProviderCatalogError = false;
  importPiSdk = defaultImportPiSdk;
  __setProviderExtensionCatalogEntriesForTest();
}

// Test-only escape hatch: allow mocking the dynamic import to simulate transient failures.
export function __setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>) {
  importPiSdk = loader ?? defaultImportPiSdk;
}

async function loadProviderPluginCatalogProviders(params: {
  config: FasedAgentConfig;
  agentDir: string;
}): Promise<Record<string, ModelProviderConfig>> {
  try {
    return await augmentModelCatalogWithProviderPlugins({
      config: params.config,
      agentDir: params.agentDir,
      env: process.env,
    });
  } catch (error) {
    if (!hasLoggedProviderCatalogError) {
      hasLoggedProviderCatalogError = true;
      log.warn(`Failed to load provider plugin model catalog: ${String(error)}`);
    }
    return {};
  }
}

async function loadProviderExtensionCatalogProviders(): Promise<
  Record<string, ModelProviderConfig>
> {
  try {
    return (await loadProviderExtensionCatalogIndex()).providers;
  } catch (error) {
    if (!hasLoggedProviderCatalogError) {
      hasLoggedProviderCatalogError = true;
      log.warn(`Failed to load provider extension model catalog: ${String(error)}`);
    }
    return {};
  }
}

export async function loadModelCatalog(params?: {
  config?: FasedAgentConfig;
  useCache?: boolean;
  includeMetadata?: boolean;
}): Promise<ModelCatalogEntry[]> {
  if (params?.useCache === false) {
    modelCatalogPromise = null;
  }
  if (modelCatalogPromise) {
    return modelCatalogPromise;
  }

  modelCatalogPromise = (async () => {
    const models: ModelCatalogEntry[] = [];
    const sortModels = (entries: ModelCatalogEntry[]) =>
      entries.sort((a, b) => {
        const p = a.provider.localeCompare(b.provider);
        if (p !== 0) {
          return p;
        }
        return a.name.localeCompare(b.name);
      });
    try {
      const cfg = params?.config ?? loadConfig();
      await ensureFasedAgentModelsJson(cfg);
      // IMPORTANT: keep the dynamic import *inside* the try/catch.
      // If this fails once (e.g. during a pnpm install that temporarily swaps node_modules),
      // we must not poison the cache with a rejected promise (otherwise all channel handlers
      // will keep failing until restart).
      const piSdk = await importPiSdk();
      const agentDir = resolveFasedAgentAgentDir();
      const { join } = await import("node:path");
      const authStorage = piSdk.discoverAuthStorage(agentDir);
      const registry = new (piSdk.ModelRegistry as unknown as {
        new (
          authStorage: unknown,
          modelsFile: string,
        ):
          | Array<DiscoveredModel>
          | {
              getAll: () => Array<DiscoveredModel>;
            };
      })(authStorage, join(agentDir, "models.json"));
      const entries = Array.isArray(registry) ? registry : registry.getAll();
      const runtimeModels: FasedRuntimeModelCatalogSource[] = [];
      for (const entry of entries) {
        runtimeModels.push(entry);
      }
      const providerPluginProviders = await loadProviderPluginCatalogProviders({
        config: cfg,
        agentDir,
      });
      const providerExtensionCatalogProviders = await loadProviderExtensionCatalogProviders();
      models.push(
        ...(buildFasedModelCatalogEntries({
          config: cfg,
          runtimeModels,
          providerPluginProviders: {
            ...providerExtensionCatalogProviders,
            ...providerPluginProviders,
          },
          includeMetadata: params?.includeMetadata,
          onRuntimeEntryError: (error) => {
            if (!hasLoggedModelCatalogError) {
              hasLoggedModelCatalogError = true;
              log.warn(`Failed to read model catalog entry: ${String(error)}`);
            }
          },
        }) as ModelCatalogEntry[]),
      );
      applySyntheticCatalogFallbacks(models);

      if (models.length === 0) {
        // If we found nothing, don't cache this result so we can try again.
        modelCatalogPromise = null;
      }

      return sortModels(models);
    } catch (error) {
      if (!hasLoggedModelCatalogError) {
        hasLoggedModelCatalogError = true;
        log.warn(`Failed to load model catalog: ${String(error)}`);
      }
      // Don't poison the cache on transient dependency/filesystem issues.
      modelCatalogPromise = null;
      if (models.length > 0) {
        return sortModels(models);
      }
      return [];
    }
  })();

  return modelCatalogPromise;
}

/**
 * Check if a model supports image input based on its catalog entry.
 */
export function modelSupportsVision(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("image") ?? false;
}

/**
 * Find a model in the catalog by provider and model ID.
 */
export function findModelInCatalog(
  catalog: ModelCatalogEntry[],
  provider: string,
  modelId: string,
): ModelCatalogEntry | undefined {
  const normalizedProvider = normalizeModelCatalogProviderId(provider);
  const normalizedModelId = modelId.toLowerCase().trim();
  return catalog.find(
    (entry) =>
      normalizeModelCatalogProviderId(entry.provider) === normalizedProvider &&
      entry.id.toLowerCase() === normalizedModelId,
  );
}
