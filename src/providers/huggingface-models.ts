import type { ModelCapabilityConfig, ModelDefinitionConfig } from "../config/types.models.js";

/** Hugging Face Inference Providers router: OpenAI-compatible chat completions only. */
export const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";
export const HUGGINGFACE_DEFAULT_MODEL_ID = "openai/gpt-oss-120b";
export const HUGGINGFACE_DEFAULT_MODEL_REF = `huggingface/${HUGGINGFACE_DEFAULT_MODEL_ID}`;

export const HUGGINGFACE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const HUGGINGFACE_DEFAULT_CONTEXT_WINDOW = 131_072;
export const HUGGINGFACE_DEFAULT_MAX_TOKENS = 8_192;

const HUGGINGFACE_TOOL_JSON_CAPABILITY: ModelCapabilityConfig = {
  tools: true,
  json: true,
};

const HUGGINGFACE_TOOL_ONLY_CAPABILITY: ModelCapabilityConfig = {
  tools: true,
  json: false,
};

const HUGGINGFACE_JSON_ONLY_CAPABILITY: ModelCapabilityConfig = {
  tools: false,
  json: true,
};

export const HUGGINGFACE_MODEL_CATALOG = [
  {
    id: HUGGINGFACE_DEFAULT_MODEL_ID,
    name: "GPT-OSS 120B",
    reasoning: true,
    input: ["text"],
    contextWindow: 131_072,
    maxTokens: 8_192,
    cost: {
      input: 0.15,
      output: 0.75,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 8_192,
    cost: {
      input: 1.69,
      output: 3.38,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Flash",
    name: "DeepSeek V4 Flash",
    reasoning: false,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 8_192,
    cost: {
      input: 0.14,
      output: 0.28,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "moonshotai/Kimi-K2.6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 8_192,
    cost: {
      input: 0.95,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "MiniMaxAI/MiniMax-M2.7",
    name: "MiniMax M2.7",
    reasoning: true,
    input: ["text"],
    contextWindow: 204_800,
    maxTokens: 8_192,
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "zai-org/GLM-5.1",
    name: "GLM-5.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 202_752,
    maxTokens: 8_192,
    cost: {
      input: 1.4,
      output: 4.4,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "Qwen/Qwen3.6-35B-A3B",
    name: "Qwen3.6 35B A3B",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 8_192,
    cost: {
      input: 0.15,
      output: 0.95,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "Qwen/Qwen3.5-397B-A17B",
    name: "Qwen3.5 397B A17B",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 8_192,
    cost: {
      input: 0.6,
      output: 3.6,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "Qwen/Qwen3-Coder-Next",
    name: "Qwen3 Coder Next",
    reasoning: false,
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 8_192,
    cost: {
      input: 0.2,
      output: 1.5,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_ONLY_CAPABILITY,
  },
  {
    id: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    name: "Qwen3 Coder 480B A35B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 8_192,
    cost: {
      input: 0.3,
      output: 1.3,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "google/gemma-4-31B-it",
    name: "Gemma 4 31B Instruct",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 8_192,
    cost: {
      input: 0.14,
      output: 0.4,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "google/gemma-4-26B-A4B-it",
    name: "Gemma 4 26B A4B Instruct",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 8_192,
    cost: {
      input: 0.13,
      output: 0.4,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "openai/gpt-oss-20b",
    name: "GPT-OSS 20B",
    reasoning: true,
    input: ["text"],
    contextWindow: 131_072,
    maxTokens: 8_192,
    cost: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "deepseek-ai/DeepSeek-R1",
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text"],
    contextWindow: 163_840,
    maxTokens: 8_192,
    cost: {
      input: 0.7,
      output: 2.5,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "deepseek-ai/DeepSeek-V3.2",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text"],
    contextWindow: 163_840,
    maxTokens: 8_192,
    cost: {
      input: 0.269,
      output: 0.4,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "meta-llama/Llama-3.3-70B-Instruct",
    name: "Llama 3.3 70B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_072,
    maxTokens: 8_192,
    cost: {
      input: 0.59,
      output: 0.79,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "Qwen/Qwen3-VL-235B-A22B-Instruct",
    name: "Qwen3 VL 235B A22B Instruct",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 131_072,
    maxTokens: 8_192,
    cost: {
      input: 0.3,
      output: 1.5,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "Qwen/Qwen3-235B-A22B-Instruct-2507",
    name: "Qwen3 235B A22B Instruct 2507",
    reasoning: true,
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 8_192,
    cost: {
      input: 0.09,
      output: 0.58,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
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
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_JSON_ONLY_CAPABILITY,
  },
  {
    id: "inclusionAI/Ling-2.6-1T",
    name: "Ling 2.6 1T",
    reasoning: false,
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 8_192,
    cost: {
      input: 0.3,
      output: 2.5,
      cacheRead: 0,
      cacheWrite: 0,
    },
    capabilities: HUGGINGFACE_TOOL_JSON_CAPABILITY,
  },
] satisfies ModelDefinitionConfig[];

export type HuggingfaceCatalogEntry = (typeof HUGGINGFACE_MODEL_CATALOG)[number];

export const HUGGINGFACE_MODEL_IDS = HUGGINGFACE_MODEL_CATALOG.map((model) => model.id);
export const HUGGINGFACE_MODEL_REFS = HUGGINGFACE_MODEL_IDS.map((id) => `huggingface/${id}`);

function capabilityForModel(model: HuggingfaceCatalogEntry): ModelCapabilityConfig {
  return {
    ...(model.capabilities ? { ...model.capabilities } : {}),
    ...(model.reasoning ? { fixedReasoning: true } : {}),
  };
}

export function buildHuggingfaceModelDefinition(
  model: HuggingfaceCatalogEntry,
): ModelDefinitionConfig {
  const capabilities = capabilityForModel(model);
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    capabilities,
  };
}

export function buildHuggingfaceModelCapabilityOverrides(
  routeId = "huggingface",
): Record<string, ModelCapabilityConfig> {
  return Object.fromEntries(
    HUGGINGFACE_MODEL_CATALOG.map((model) => [
      `${routeId}/${model.id}`.toLowerCase(),
      capabilityForModel(model),
    ]),
  );
}
