import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { resolveFasedAgentAgentDir } from "../../agents/agent-paths.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { loadModelCatalog, type ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  deriveModelMetadata,
  formatModelFeatureList,
  type ModelMetadata,
} from "../../agents/model-metadata.js";
import { ensureFasedAgentModelsJson } from "../../agents/models-config.js";
import { discoverAuthStorage, discoverModels } from "../../agents/pi-model-discovery.js";
import type { FasedAgentConfig } from "../../config/config.js";
import { createModelListAuthIndex, type ModelListAuthIndex } from "./list.auth-index.js";
import {
  formatErrorWithStack,
  MODEL_AVAILABILITY_UNAVAILABLE_CODE,
  shouldFallbackToAuthHeuristics,
} from "./list.errors.js";
import type { ModelRow } from "./list.types.js";
import { isLocalBaseUrl, modelKey } from "./shared.js";

export type ModelListSource = {
  id: string;
  name?: string;
  provider: string;
  input?: Array<"text" | "image">;
  baseUrl?: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  metadata?: ModelMetadata;
};

function createAvailabilityUnavailableError(message: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = MODEL_AVAILABILITY_UNAVAILABLE_CODE;
  return err;
}

function normalizeAvailabilityError(err: unknown): Error {
  if (shouldFallbackToAuthHeuristics(err) && err instanceof Error) {
    return err;
  }
  return createAvailabilityUnavailableError(
    `Model availability unavailable: getAvailable() failed.\n${formatErrorWithStack(err)}`,
  );
}

function validateAvailableModels(availableModels: unknown): Model<Api>[] {
  if (!Array.isArray(availableModels)) {
    throw createAvailabilityUnavailableError(
      "Model availability unavailable: getAvailable() returned a non-array value.",
    );
  }

  for (const model of availableModels) {
    if (
      !model ||
      typeof model !== "object" ||
      typeof (model as { provider?: unknown }).provider !== "string" ||
      typeof (model as { id?: unknown }).id !== "string"
    ) {
      throw createAvailabilityUnavailableError(
        "Model availability unavailable: getAvailable() returned invalid model entries.",
      );
    }
  }

  return availableModels as Model<Api>[];
}

function loadAvailableModels(registry: ModelRegistry): Model<Api>[] {
  let availableModels: unknown;
  try {
    availableModels = registry.getAvailable();
  } catch (err) {
    throw normalizeAvailabilityError(err);
  }
  try {
    return validateAvailableModels(availableModels);
  } catch (err) {
    throw normalizeAvailabilityError(err);
  }
}

function normalizeModelListSource(model: Model<Api> | ModelCatalogEntry): ModelListSource {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    input: model.input,
    baseUrl: model.baseUrl,
    api: model.api,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    metadata: "metadata" in model ? model.metadata : undefined,
  };
}

function mergeModelCatalogEntries(params: {
  registryModels: Model<Api>[];
  catalog: ModelCatalogEntry[];
}): ModelListSource[] {
  const models = params.registryModels.map((model) => normalizeModelListSource(model));
  const seen = new Set(models.map((model) => modelKey(model.provider, model.id)));
  for (const entry of params.catalog) {
    const key = modelKey(entry.provider, entry.id);
    if (seen.has(key)) {
      continue;
    }
    models.push(normalizeModelListSource(entry));
    seen.add(key);
  }
  return models;
}

export async function loadModelRegistry(cfg: FasedAgentConfig) {
  await ensureFasedAgentModelsJson(cfg);
  const agentDir = resolveFasedAgentAgentDir();
  const authStorage = discoverAuthStorage(agentDir);
  const registry = discoverModels(authStorage, agentDir);
  const registryModels = registry.getAll();
  const catalog = await loadModelCatalog({
    config: cfg,
    useCache: false,
    includeMetadata: true,
  });
  const models = mergeModelCatalogEntries({ registryModels, catalog });
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;

  try {
    const availableModels = loadAvailableModels(registry);
    availableKeys = new Set(availableModels.map((model) => modelKey(model.provider, model.id)));
  } catch (err) {
    if (!shouldFallbackToAuthHeuristics(err)) {
      throw err;
    }

    // Some providers can report model-level availability as unavailable.
    // Fall back to provider-level auth heuristics when availability is undefined.
    availableKeys = undefined;
    if (!availabilityErrorMessage) {
      availabilityErrorMessage = formatErrorWithStack(err);
    }
  }
  return { registry, models, availableKeys, availabilityErrorMessage };
}

export function toModelRow(params: {
  model?: ModelListSource;
  key: string;
  tags: string[];
  aliases?: string[];
  availableKeys?: Set<string>;
  cfg?: FasedAgentConfig;
  authStore?: AuthProfileStore;
  authIndex?: ModelListAuthIndex;
}): ModelRow {
  const { model, key, tags, aliases = [], availableKeys, cfg, authStore } = params;
  if (!model) {
    return {
      key,
      name: key,
      input: "-",
      contextWindow: null,
      features: [],
      local: null,
      available: null,
      tags: [...tags, "missing"],
      missing: true,
    };
  }

  const input = (model.input ?? ["text"]).join("+") || "text";
  const metadata = model.metadata ?? deriveModelMetadata({ model, cfg });
  const features = formatModelFeatureList(metadata);
  const local = model.baseUrl ? isLocalBaseUrl(model.baseUrl) : null;
  const authIndex =
    params.authIndex ??
    (cfg && authStore ? createModelListAuthIndex({ cfg, authStore }) : undefined);
  // Prefer model-level registry availability when present.
  // Fall back to provider-level auth heuristics only if registry availability isn't available.
  const available =
    availableKeys !== undefined
      ? availableKeys.has(modelKey(model.provider, model.id))
      : (authIndex?.hasProviderAuth(model.provider) ?? false);
  const aliasTags = aliases.length > 0 ? [`alias:${aliases.join(",")}`] : [];
  const mergedTags = new Set(tags);
  if (aliasTags.length > 0) {
    for (const tag of mergedTags) {
      if (tag === "alias" || tag.startsWith("alias:")) {
        mergedTags.delete(tag);
      }
    }
    for (const tag of aliasTags) {
      mergedTags.add(tag);
    }
  }

  return {
    key,
    name: model.name || model.id,
    input,
    contextWindow: model.contextWindow ?? null,
    features,
    local,
    available,
    tags: Array.from(mergedTags),
    missing: false,
    metadata,
  };
}
