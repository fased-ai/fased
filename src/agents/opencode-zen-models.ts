/**
 * OpenCode Zen model catalog with dynamic fetching, caching, and static fallback.
 *
 * OpenCode Zen is a pay-as-you-go token-based API that provides access to curated
 * models optimized for coding agents. It uses per-request billing with auto top-up.
 *
 * Note: OpenCode Black ($20/$100/$200/month subscriptions) is a separate product
 * with flat-rate usage tiers. This module handles Zen, not Black.
 *
 * API endpoint: https://opencode.ai/zen/v1
 * Auth URL: https://opencode.ai/auth
 */

import type { ModelApi, ModelDefinitionConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildOpencodeZenModelCapability,
  OPENCODE_ZEN_DEFAULT_MODEL,
  OPENCODE_ZEN_DEFAULT_MODEL_REF,
  OPENCODE_ZEN_MODEL_IDS,
} from "../providers/opencode-zen-shared.js";

const log = createSubsystemLogger("opencode-zen-models");

export const OPENCODE_ZEN_API_BASE_URL = "https://opencode.ai/zen/v1";
export { OPENCODE_ZEN_DEFAULT_MODEL, OPENCODE_ZEN_DEFAULT_MODEL_REF, OPENCODE_ZEN_MODEL_IDS };

// Cache for fetched models (1 hour TTL)
let cachedModels: ModelDefinitionConfig[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Model aliases for convenient shortcuts.
 * Users can use "opus" instead of the current Claude Opus model id, etc.
 */
export const OPENCODE_ZEN_MODEL_ALIASES: Record<string, string> = {
  // Claude
  opus: "claude-opus-4-7",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "opus-4.5": "claude-opus-4-5",
  "opus-4": "claude-opus-4-7",

  // Legacy Claude aliases (OpenCode Zen rotates model catalogs; keep old keys working).
  sonnet: "claude-sonnet-4-6",
  "sonnet-4": "claude-sonnet-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4.5": "claude-sonnet-4-5",
  haiku: "claude-haiku-4-5",
  "haiku-3.5": "claude-haiku-4-5",

  // GPT-5.x family
  gpt5: "gpt-5.5",
  "gpt-5": "gpt-5.5",
  "gpt-5.4": "gpt-5.4",
  "gpt-5.1": "gpt-5.4",

  // Legacy GPT aliases (keep old config/docs stable; map to closest current equivalents).
  gpt4: "gpt-5.4-mini",
  "gpt-4": "gpt-5.4-mini",
  "gpt-mini": "gpt-5.4-mini",

  // Legacy O-series aliases (no longer in the Zen catalog; map to a strong default).
  o1: "gpt-5.5",
  o3: "gpt-5.5",
  "o3-mini": "gpt-5.4-mini",

  // Codex family
  codex: "gpt-5.3-codex",
  "codex-spark": "gpt-5.3-codex-spark",
  "gpt-5.2": "gpt-5.2",
  "gpt-5.2-codex": "gpt-5.2-codex",

  // Gemini
  gemini: "gemini-3.1-pro",
  "gemini-pro": "gemini-3.1-pro",
  "gemini-3": "gemini-3.1-pro",
  flash: "gemini-3-flash",
  "gemini-flash": "gemini-3-flash",

  // Legacy Gemini 2.5 aliases (map to the nearest current Gemini tier).
  "gemini-2.5": "gemini-3.1-pro",
  "gemini-2.5-pro": "gemini-3.1-pro",
  "gemini-2.5-flash": "gemini-3-flash",

  // Other Zen models
  qwen: "qwen3.6-plus",
  minimax: "minimax-m2.7",
  glm: "glm-5.1",
  kimi: "kimi-k2.6",
};

/**
 * Resolve a model alias to its full model ID.
 * Returns the input if no alias exists.
 */
export function resolveOpencodeZenAlias(modelIdOrAlias: string): string {
  const normalized = modelIdOrAlias.toLowerCase().trim();
  return OPENCODE_ZEN_MODEL_ALIASES[normalized] ?? modelIdOrAlias;
}

/**
 * OpenCode Zen routes models to specific API shapes by family.
 */
export function resolveOpencodeZenModelApi(modelId: string): ModelApi {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("gpt-")) {
    return "openai-responses";
  }
  if (lower.startsWith("claude-")) {
    return "anthropic-messages";
  }
  if (lower.startsWith("gemini-")) {
    return "google-generative-ai";
  }
  return "openai-completions";
}

/**
 * Check if a model supports image input.
 */
function supportsImageInput(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (lower.includes("glm") || lower.includes("minimax")) {
    return false;
  }
  return true;
}

const MODEL_COSTS: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.5-pro": { input: 30, output: 180, cacheRead: 30, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.4-pro": { input: 30, output: 180, cacheRead: 30, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex-spark": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "gemini-3.1-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  "qwen3.6-plus": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
  "minimax-m2.7": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
  "glm-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  "kimi-k2.6": { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
  "gpt-5.1-codex": {
    input: 1.07,
    output: 8.5,
    cacheRead: 0.107,
    cacheWrite: 0,
  },
  "gemini-3-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gpt-5.1-codex-mini": {
    input: 0.25,
    output: 2,
    cacheRead: 0.025,
    cacheWrite: 0,
  },
  "gpt-5.1": { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  "glm-4.7": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.1-codex-max": {
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: 0,
  },
};

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.5": 400000,
  "gpt-5.5-pro": 400000,
  "gpt-5.4": 400000,
  "gpt-5.4-pro": 400000,
  "gpt-5.4-mini": 400000,
  "gpt-5.4-nano": 400000,
  "gpt-5.3-codex": 400000,
  "gpt-5.3-codex-spark": 400000,
  "gpt-5.2": 400000,
  "gpt-5.2-codex": 400000,
  "claude-opus-4-7": 1000000,
  "claude-opus-4-6": 1000000,
  "claude-opus-4-5": 200000,
  "claude-sonnet-4-6": 1000000,
  "claude-sonnet-4-5": 1000000,
  "claude-haiku-4-5": 200000,
  "gemini-3.1-pro": 1048576,
  "qwen3.6-plus": 262144,
  "minimax-m2.7": 262144,
  "glm-5.1": 204800,
  "kimi-k2.6": 262144,
  "gpt-5.1-codex": 400000,
  "gemini-3-pro": 1048576,
  "gpt-5.1-codex-mini": 400000,
  "gpt-5.1": 400000,
  "glm-4.7": 204800,
  "gemini-3-flash": 1048576,
  "gpt-5.1-codex-max": 400000,
};

function getDefaultContextWindow(modelId: string): number {
  return MODEL_CONTEXT_WINDOWS[modelId] ?? 128000;
}

const MODEL_MAX_TOKENS: Record<string, number> = {
  "gpt-5.5": 128000,
  "gpt-5.5-pro": 128000,
  "gpt-5.4": 128000,
  "gpt-5.4-pro": 128000,
  "gpt-5.4-mini": 128000,
  "gpt-5.4-nano": 128000,
  "gpt-5.3-codex": 128000,
  "gpt-5.3-codex-spark": 128000,
  "gpt-5.2": 128000,
  "gpt-5.2-codex": 128000,
  "claude-opus-4-7": 128000,
  "claude-opus-4-6": 128000,
  "claude-opus-4-5": 64000,
  "claude-sonnet-4-6": 128000,
  "claude-sonnet-4-5": 64000,
  "claude-haiku-4-5": 64000,
  "gemini-3.1-pro": 65536,
  "qwen3.6-plus": 65536,
  "minimax-m2.7": 65536,
  "glm-5.1": 131072,
  "kimi-k2.6": 65536,
  "gpt-5.1-codex": 128000,
  "gemini-3-pro": 65536,
  "gpt-5.1-codex-mini": 128000,
  "gpt-5.1": 128000,
  "glm-4.7": 131072,
  "gemini-3-flash": 65536,
  "gpt-5.1-codex-max": 128000,
};

function getDefaultMaxTokens(modelId: string): number {
  return MODEL_MAX_TOKENS[modelId] ?? 8192;
}

/**
 * Build a ModelDefinitionConfig from a model ID.
 */
function buildModelDefinition(modelId: string): ModelDefinitionConfig {
  return {
    id: modelId,
    name: formatModelName(modelId),
    api: resolveOpencodeZenModelApi(modelId),
    // Treat Zen models as reasoning-capable so defaults pick thinkLevel="low" unless users opt out.
    reasoning: true,
    input: supportsImageInput(modelId) ? ["text", "image"] : ["text"],
    cost: MODEL_COSTS[modelId] ?? DEFAULT_COST,
    contextWindow: getDefaultContextWindow(modelId),
    maxTokens: getDefaultMaxTokens(modelId),
    capabilities: buildOpencodeZenModelCapability(modelId),
  };
}

/**
 * Format a model ID into a human-readable name.
 */
const MODEL_NAMES: Record<string, string> = {
  "gpt-5.5": "GPT-5.5",
  "gpt-5.5-pro": "GPT-5.5 Pro",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-pro": "GPT-5.4 Pro",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.4-nano": "GPT-5.4 Nano",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "qwen3.6-plus": "Qwen3.6 Plus",
  "minimax-m2.7": "MiniMax M2.7",
  "glm-5.1": "GLM 5.1",
  "kimi-k2.6": "Kimi K2.6",
  "gpt-5.1-codex": "GPT-5.1 Codex",
  "gemini-3-pro": "Gemini 3 Pro",
  "gpt-5.1-codex-mini": "GPT-5.1 Codex Mini",
  "gpt-5.1": "GPT-5.1",
  "glm-4.7": "GLM-4.7",
  "gemini-3-flash": "Gemini 3 Flash",
  "gpt-5.1-codex-max": "GPT-5.1 Codex Max",
};

function formatModelName(modelId: string): string {
  if (MODEL_NAMES[modelId]) {
    return MODEL_NAMES[modelId];
  }

  return modelId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Static fallback models when API is unreachable.
 */
export function getOpencodeZenStaticFallbackModels(): ModelDefinitionConfig[] {
  return OPENCODE_ZEN_MODEL_IDS.map(buildModelDefinition);
}

/**
 * Response shape from OpenCode Zen /models endpoint.
 * Returns OpenAI-compatible format.
 */
interface ZenModelsResponse {
  data: Array<{
    id: string;
    object: "model";
    created?: number;
    owned_by?: string;
  }>;
}

/**
 * Fetch models from the OpenCode Zen API.
 * Uses caching with 1-hour TTL.
 *
 * @param apiKey - OpenCode Zen API key for authentication
 * @returns Array of model definitions, or static fallback on failure
 */
export async function fetchOpencodeZenModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  // Return cached models if still valid
  const now = Date.now();
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${OPENCODE_ZEN_API_BASE_URL}/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as ZenModelsResponse;

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid response format from /models endpoint");
    }

    const models = data.data.map((model) => buildModelDefinition(model.id));

    cachedModels = models;
    cacheTimestamp = now;

    return models;
  } catch (error) {
    log.warn(`Failed to fetch models, using static fallback: ${String(error)}`);
    return getOpencodeZenStaticFallbackModels();
  }
}

/**
 * Clear the model cache (useful for testing or forcing refresh).
 */
export function clearOpencodeZenModelCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
}
