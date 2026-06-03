import type { ModelCapabilityConfig, ModelDefinitionConfig } from "../config/types.models.js";

export const LITELLM_BASE_URL = "http://localhost:4000/v1";
export const LITELLM_DEFAULT_MODEL_ID = "default";
export const LITELLM_DEFAULT_MODEL_REF = `litellm/${LITELLM_DEFAULT_MODEL_ID}`;

export const LITELLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const LITELLM_MODEL_CATALOG = [
  {
    id: LITELLM_DEFAULT_MODEL_ID,
    name: "LiteLLM proxy default",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: LITELLM_DEFAULT_COST,
    capabilities: {},
  },
] satisfies ModelDefinitionConfig[];

export type LitellmCatalogEntry = (typeof LITELLM_MODEL_CATALOG)[number];

export const LITELLM_MODEL_IDS = LITELLM_MODEL_CATALOG.map((model) => model.id);
export const LITELLM_MODEL_REFS = LITELLM_MODEL_IDS.map((id) => `litellm/${id}`);

export function buildLitellmModelDefinition(model: LitellmCatalogEntry): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: {
      supportsUsageInStreaming: false,
      supportsReasoningEffort: false,
    },
    capabilities: model.capabilities ? { ...model.capabilities } : undefined,
  };
}

export function buildLitellmModelCapabilityOverrides(
  routeId = "litellm",
): Record<string, ModelCapabilityConfig> {
  return Object.fromEntries(
    LITELLM_MODEL_CATALOG.map((model) => [
      `${routeId}/${model.id}`.toLowerCase(),
      model.capabilities ? { ...model.capabilities } : {},
    ]),
  );
}
