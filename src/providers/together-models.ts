import type { ModelCapabilityConfig, ModelDefinitionConfig } from "../config/types.models.js";

export const TOGETHER_BASE_URL = "https://api.together.xyz/v1";
export const TOGETHER_DEFAULT_MODEL_ID = "moonshotai/Kimi-K2.6";
export const TOGETHER_DEFAULT_MODEL_REF = `together/${TOGETHER_DEFAULT_MODEL_ID}`;

const TOGETHER_TOOL_JSON_CAPABILITY: ModelCapabilityConfig = {
  tools: true,
  json: true,
};

const TOGETHER_NO_TOOL_JSON_CAPABILITY: ModelCapabilityConfig = {
  tools: false,
  json: false,
};

const TOGETHER_KIMI_K2_6_CAPABILITY: ModelCapabilityConfig = {
  ...TOGETHER_TOOL_JSON_CAPABILITY,
  video: true,
};

export const TOGETHER_MODEL_CATALOG = [
  {
    id: TOGETHER_DEFAULT_MODEL_ID,
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 16_384,
    cost: {
      input: 1.2,
      output: 4.5,
      cacheRead: 0.2,
      cacheWrite: 1.2,
    },
    capabilities: TOGETHER_KIMI_K2_6_CAPABILITY,
  },
  {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 32_768,
    cost: {
      input: 0.5,
      output: 2.8,
      cacheRead: 0.5,
      cacheWrite: 2.8,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "MiniMaxAI/MiniMax-M2.7",
    name: "MiniMax M2.7",
    reasoning: true,
    input: ["text"],
    contextWindow: 202_752,
    maxTokens: 32_768,
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.06,
      cacheWrite: 0.3,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "zai-org/GLM-5.1",
    name: "GLM-5.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 202_752,
    maxTokens: 128_000,
    cost: {
      input: 1.4,
      output: 4.4,
      cacheRead: 1.4,
      cacheWrite: 1.4,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "zai-org/GLM-5",
    name: "GLM-5",
    reasoning: true,
    input: ["text"],
    contextWindow: 202_752,
    maxTokens: 128_000,
    cost: {
      input: 1,
      output: 3.2,
      cacheRead: 1,
      cacheWrite: 1,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "Qwen/Qwen3.6-Plus",
    name: "Qwen3.6 Plus",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    cost: {
      input: 0.5,
      output: 3,
      cacheRead: 0.5,
      cacheWrite: 0.5,
    },
    capabilities: TOGETHER_NO_TOOL_JSON_CAPABILITY,
  },
  {
    id: "Qwen/Qwen3.5-397B-A17B",
    name: "Qwen3.5 397B A17B",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 32_768,
    cost: {
      input: 0.6,
      output: 3.6,
      cacheRead: 0.6,
      cacheWrite: 0.6,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "Qwen/Qwen3.5-9B",
    name: "Qwen3.5 9B",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 32_768,
    cost: {
      input: 0.1,
      output: 0.15,
      cacheRead: 0.1,
      cacheWrite: 0.1,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B",
    reasoning: true,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 32_768,
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.15,
      cacheWrite: 0.15,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "openai/gpt-oss-20b",
    name: "GPT-OSS 20B",
    reasoning: true,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 32_768,
    cost: {
      input: 0.05,
      output: 0.2,
      cacheRead: 0.05,
      cacheWrite: 0.05,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    input: ["text"],
    contextWindow: 512_000,
    maxTokens: 32_768,
    cost: {
      input: 2.1,
      output: 4.4,
      cacheRead: 0.2,
      cacheWrite: 2.1,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "deepseek-ai/DeepSeek-R1",
    name: "DeepSeek R1 0528",
    reasoning: true,
    input: ["text"],
    contextWindow: 163_840,
    maxTokens: 32_768,
    cost: {
      input: 3,
      output: 7,
      cacheRead: 3,
      cacheWrite: 3,
    },
    capabilities: TOGETHER_NO_TOOL_JSON_CAPABILITY,
  },
  {
    id: "deepseek-ai/DeepSeek-V3.1",
    name: "DeepSeek V3.1",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_072,
    maxTokens: 32_768,
    cost: {
      input: 0.6,
      output: 1.7,
      cacheRead: 0.6,
      cacheWrite: 0.6,
    },
    capabilities: TOGETHER_NO_TOOL_JSON_CAPABILITY,
  },
  {
    id: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
    name: "Qwen3 Coder 480B A35B Instruct FP8",
    reasoning: false,
    input: ["text"],
    contextWindow: 256_000,
    maxTokens: 32_768,
    cost: {
      input: 2,
      output: 2,
      cacheRead: 2,
      cacheWrite: 2,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "Qwen/Qwen3-235B-A22B-Instruct-2507-tput",
    name: "Qwen3 235B A22B Instruct 2507",
    reasoning: true,
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 32_768,
    cost: {
      input: 0.2,
      output: 0.6,
      cacheRead: 0.2,
      cacheWrite: 0.2,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "Qwen/Qwen3-Coder-Next-FP8",
    name: "Qwen3 Coder Next FP8",
    reasoning: false,
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 32_768,
    cost: {
      input: 0.5,
      output: 1.2,
      cacheRead: 0.5,
      cacheWrite: 0.5,
    },
    capabilities: TOGETHER_NO_TOOL_JSON_CAPABILITY,
  },
  {
    id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    name: "Llama 3.3 70B Instruct Turbo",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_072,
    maxTokens: 8_192,
    cost: {
      input: 0.88,
      output: 0.88,
      cacheRead: 0.88,
      cacheWrite: 0.88,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "essentialai/rnj-1-instruct",
    name: "Rnj-1 Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 32_768,
    maxTokens: 8_192,
    cost: {
      input: 0.15,
      output: 0.15,
      cacheRead: 0.15,
      cacheWrite: 0.15,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "google/gemma-4-31B-it",
    name: "Gemma 4 31B Instruct",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 32_768,
    cost: {
      input: 0.2,
      output: 0.5,
      cacheRead: 0.2,
      cacheWrite: 0.2,
    },
    capabilities: TOGETHER_TOOL_JSON_CAPABILITY,
  },
  {
    id: "google/gemma-3n-E4B-it",
    name: "Gemma 3N E4B Instruct",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 32_768,
    maxTokens: 8_192,
    cost: {
      input: 0.06,
      output: 0.12,
      cacheRead: 0.06,
      cacheWrite: 0.06,
    },
    capabilities: {
      tools: false,
      json: true,
    },
  },
] satisfies ModelDefinitionConfig[];

export type TogetherCatalogEntry = (typeof TOGETHER_MODEL_CATALOG)[number];

export const TOGETHER_MODEL_IDS = TOGETHER_MODEL_CATALOG.map((model) => model.id);
export const TOGETHER_MODEL_REFS = TOGETHER_MODEL_IDS.map((id) => `together/${id}`);

export function buildTogetherModelDefinition(model: TogetherCatalogEntry): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    capabilities: model.capabilities ? { ...model.capabilities } : undefined,
  };
}

export function buildTogetherModelCapabilityOverrides(
  routeId = "together",
): Record<string, ModelCapabilityConfig> {
  return Object.fromEntries(
    TOGETHER_MODEL_CATALOG.map((model) => [
      `${routeId}/${model.id}`,
      model.capabilities ? { ...model.capabilities } : {},
    ]),
  );
}
