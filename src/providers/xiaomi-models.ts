import type { ModelCapabilityConfig, ModelDefinitionConfig } from "../config/types.models.js";
import { BASE_THINKING_LEVELS } from "../shared/model-thinking.js";

export const XIAOMI_BASE_URL = "https://api.xiaomimimo.com/v1";
export const XIAOMI_DEFAULT_MODEL_ID = "mimo-v2.5-pro";

const XIAOMI_DEFAULT_THINKING: ModelCapabilityConfig = {
  thinkingLevels: [...BASE_THINKING_LEVELS],
  defaultThinkingLevel: "low",
  thinkingMode: "generic-reasoning",
  reasoningBudgetSupported: false,
};

const XIAOMI_TEXT_REASONING_CAPABILITY: ModelCapabilityConfig = {
  tools: true,
  json: true,
  ...XIAOMI_DEFAULT_THINKING,
};

const XIAOMI_MULTIMODAL_REASONING_CAPABILITY: ModelCapabilityConfig = {
  ...XIAOMI_TEXT_REASONING_CAPABILITY,
  audio: true,
  video: true,
};

export const XIAOMI_MODEL_CATALOG = [
  {
    id: "mimo-v2.5-pro",
    name: "Xiaomi MiMo V2.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    capabilities: XIAOMI_TEXT_REASONING_CAPABILITY,
  },
  {
    id: "mimo-v2.5",
    name: "Xiaomi MiMo V2.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.4, output: 2, cacheRead: 0.08, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    capabilities: XIAOMI_MULTIMODAL_REASONING_CAPABILITY,
  },
  {
    id: "mimo-v2-pro",
    name: "Xiaomi MiMo V2 Pro",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    capabilities: XIAOMI_TEXT_REASONING_CAPABILITY,
  },
  {
    id: "mimo-v2-omni",
    name: "Xiaomi MiMo V2 Omni",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.4, output: 2, cacheRead: 0.08, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 128_000,
    capabilities: XIAOMI_MULTIMODAL_REASONING_CAPABILITY,
  },
  {
    id: "mimo-v2-flash",
    name: "Xiaomi MiMo V2 Flash",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.11, output: 0.32, cacheRead: 0.01, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 64_000,
    capabilities: XIAOMI_TEXT_REASONING_CAPABILITY,
  },
] satisfies ModelDefinitionConfig[];

export const XIAOMI_MODEL_IDS = XIAOMI_MODEL_CATALOG.map((model) => model.id);

export function buildXiaomiModelDefinition(modelId: string): ModelDefinitionConfig {
  const model = XIAOMI_MODEL_CATALOG.find((entry) => entry.id === modelId);
  if (!model) {
    throw new Error(`Unknown Xiaomi model: ${modelId}`);
  }
  return {
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
    capabilities: model.capabilities ? { ...model.capabilities } : undefined,
  };
}

export function buildXiaomiModelCapabilityOverrides(
  routeId = "xiaomi",
): Record<string, ModelCapabilityConfig> {
  return Object.fromEntries(
    XIAOMI_MODEL_CATALOG.map((model) => [
      `${routeId}/${model.id}`,
      model.capabilities ? { ...model.capabilities } : {},
    ]),
  );
}
