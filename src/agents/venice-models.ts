import type { ModelDefinitionConfig } from "../config/types.models.js";
import { retryAsync } from "../infra/retry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildVeniceModelDefinition,
  VENICE_BASE_URL,
  VENICE_DEFAULT_COST,
  VENICE_MODEL_CATALOG,
  type VeniceCatalogEntry,
} from "../providers/venice-models.js";

export {
  buildVeniceModelDefinition,
  VENICE_BASE_URL,
  VENICE_DEFAULT_COST,
  VENICE_DEFAULT_MODEL_ID,
  VENICE_DEFAULT_MODEL_REF,
  VENICE_MODEL_CATALOG,
  VENICE_MODEL_IDS,
  VENICE_MODEL_REFS,
  type VeniceCatalogEntry,
} from "../providers/venice-models.js";

const log = createSubsystemLogger("venice-models");

const VENICE_DEFAULT_CONTEXT_WINDOW = 128_000;
const VENICE_DEFAULT_MAX_TOKENS = 4096;
const VENICE_DISCOVERY_HARD_MAX_TOKENS = 131_072;
const VENICE_DISCOVERY_TIMEOUT_MS = 10_000;
const VENICE_DISCOVERY_RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const VENICE_DISCOVERY_RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CONNECT_ERROR",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// Venice API response types
interface VeniceModelSpec {
  name: string;
  privacy: "private" | "anonymized";
  availableContextTokens?: number;
  maxCompletionTokens?: number;
  capabilities?: {
    supportsReasoning?: boolean;
    supportsReasoningEffort?: boolean;
    supportsResponseSchema?: boolean;
    supportsVision?: boolean;
    supportsFunctionCalling?: boolean;
  };
}

interface VeniceModel {
  id: string;
  model_spec?: VeniceModelSpec;
}

interface VeniceModelsResponse {
  data: VeniceModel[];
}

class VeniceDiscoveryHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "VeniceDiscoveryHttpError";
    this.status = status;
  }
}

function staticVeniceModelDefinitions(): ModelDefinitionConfig[] {
  return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
}

function hasRetryableNetworkCode(err: unknown): boolean {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      errors?: unknown;
      code?: unknown;
      errno?: unknown;
    };
    const code =
      typeof candidate.code === "string"
        ? candidate.code
        : typeof candidate.errno === "string"
          ? candidate.errno
          : undefined;
    if (code && VENICE_DISCOVERY_RETRYABLE_NETWORK_CODES.has(code)) {
      return true;
    }
    if (candidate.cause) {
      queue.push(candidate.cause);
    }
    if (Array.isArray(candidate.errors)) {
      queue.push(...candidate.errors);
    }
  }
  return false;
}

function isRetryableVeniceDiscoveryError(err: unknown): boolean {
  if (err instanceof VeniceDiscoveryHttpError) {
    return true;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  if (err instanceof TypeError && err.message.toLowerCase() === "fetch failed") {
    return true;
  }
  return hasRetryableNetworkCode(err);
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveApiMaxCompletionTokens(params: {
  apiModel: VeniceModel;
  knownMaxTokens?: number;
}): number | undefined {
  const raw = normalizePositiveInt(params.apiModel.model_spec?.maxCompletionTokens);
  if (!raw) {
    return undefined;
  }
  const contextWindow = normalizePositiveInt(params.apiModel.model_spec?.availableContextTokens);
  const knownMaxTokens =
    typeof params.knownMaxTokens === "number" && Number.isFinite(params.knownMaxTokens)
      ? Math.floor(params.knownMaxTokens)
      : undefined;
  const hardCap = knownMaxTokens ?? VENICE_DISCOVERY_HARD_MAX_TOKENS;
  const fallbackContextWindow = knownMaxTokens ?? VENICE_DEFAULT_CONTEXT_WINDOW;
  return Math.min(raw, contextWindow ?? fallbackContextWindow, hardCap);
}

function resolveApiSupportsTools(apiModel: VeniceModel): boolean | undefined {
  const supportsFunctionCalling = apiModel.model_spec?.capabilities?.supportsFunctionCalling;
  return typeof supportsFunctionCalling === "boolean" ? supportsFunctionCalling : undefined;
}

function resolveApiSupportsJson(apiModel: VeniceModel): boolean | undefined {
  const supportsResponseSchema = apiModel.model_spec?.capabilities?.supportsResponseSchema;
  return typeof supportsResponseSchema === "boolean" ? supportsResponseSchema : undefined;
}

function resolveApiSupportsReasoningEffort(apiModel: VeniceModel): boolean | undefined {
  const supportsReasoningEffort = apiModel.model_spec?.capabilities?.supportsReasoningEffort;
  return typeof supportsReasoningEffort === "boolean" ? supportsReasoningEffort : undefined;
}

/**
 * Discover models from Venice API with fallback to static catalog.
 * The /models endpoint is public and doesn't require authentication.
 */
export async function discoverVeniceModels(): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return staticVeniceModelDefinitions();
  }

  try {
    const response = await retryAsync(
      async () => {
        const currentResponse = await fetch(`${VENICE_BASE_URL}/models`, {
          signal: AbortSignal.timeout(VENICE_DISCOVERY_TIMEOUT_MS),
          headers: {
            Accept: "application/json",
          },
        });
        if (
          !currentResponse.ok &&
          VENICE_DISCOVERY_RETRYABLE_HTTP_STATUS.has(currentResponse.status)
        ) {
          throw new VeniceDiscoveryHttpError(currentResponse.status);
        }
        return currentResponse;
      },
      {
        attempts: 3,
        minDelayMs: 300,
        maxDelayMs: 2000,
        jitter: 0.2,
        label: "venice-model-discovery",
        shouldRetry: isRetryableVeniceDiscoveryError,
      },
    );

    if (!response.ok) {
      log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
      return staticVeniceModelDefinitions();
    }

    const data = (await response.json()) as VeniceModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      log.warn("No models found from API, using static catalog");
      return staticVeniceModelDefinitions();
    }

    // Merge discovered models with catalog metadata
    const catalogById = new Map<string, VeniceCatalogEntry>(
      VENICE_MODEL_CATALOG.map((m) => [m.id, m]),
    );
    const models: ModelDefinitionConfig[] = [];

    for (const apiModel of data.data) {
      const catalogEntry = catalogById.get(apiModel.id);
      const apiMaxTokens = resolveApiMaxCompletionTokens({
        apiModel,
        knownMaxTokens: catalogEntry?.maxTokens,
      });
      const apiSupportsTools = resolveApiSupportsTools(apiModel);
      const apiSupportsJson = resolveApiSupportsJson(apiModel);
      const apiSupportsReasoningEffort = resolveApiSupportsReasoningEffort(apiModel);
      if (catalogEntry) {
        const definition = buildVeniceModelDefinition(catalogEntry);
        if (apiMaxTokens !== undefined) {
          definition.maxTokens = apiMaxTokens;
        }
        if (apiSupportsTools !== undefined || apiSupportsJson !== undefined) {
          definition.capabilities = {
            ...definition.capabilities,
            ...(apiSupportsTools !== undefined ? { tools: apiSupportsTools } : {}),
            ...(apiSupportsJson !== undefined ? { json: apiSupportsJson } : {}),
          };
        }
        if (apiSupportsReasoningEffort !== undefined) {
          definition.compat = {
            ...definition.compat,
            supportsReasoningEffort: apiSupportsReasoningEffort,
          };
        }
        models.push(definition);
      } else {
        // Create definition for newly discovered models not in catalog
        const apiSpec = apiModel.model_spec;
        const isReasoning =
          apiSpec?.capabilities?.supportsReasoning ||
          apiModel.id.toLowerCase().includes("thinking") ||
          apiModel.id.toLowerCase().includes("reason") ||
          apiModel.id.toLowerCase().includes("r1");

        const hasVision = apiSpec?.capabilities?.supportsVision === true;

        models.push({
          id: apiModel.id,
          name: apiSpec?.name || apiModel.id,
          reasoning: isReasoning,
          input: hasVision ? ["text", "image"] : ["text"],
          cost: VENICE_DEFAULT_COST,
          contextWindow:
            normalizePositiveInt(apiSpec?.availableContextTokens) ?? VENICE_DEFAULT_CONTEXT_WINDOW,
          maxTokens: apiMaxTokens ?? VENICE_DEFAULT_MAX_TOKENS,
          // Avoid usage-only streaming chunks that can break OpenAI-compatible parsers.
          compat: {
            supportsUsageInStreaming: false,
            ...(apiSupportsReasoningEffort !== undefined
              ? { supportsReasoningEffort: apiSupportsReasoningEffort }
              : {}),
          },
          capabilities: {
            ...(apiSupportsTools !== undefined ? { tools: apiSupportsTools } : {}),
            ...(apiSupportsJson !== undefined ? { json: apiSupportsJson } : {}),
          },
        });
      }
    }

    return models.length > 0 ? models : staticVeniceModelDefinitions();
  } catch (error) {
    if (error instanceof VeniceDiscoveryHttpError) {
      log.warn(`Failed to discover models: HTTP ${error.status}, using static catalog`);
      return staticVeniceModelDefinitions();
    }
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return staticVeniceModelDefinitions();
  }
}
