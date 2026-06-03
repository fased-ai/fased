import type { ModelCapabilityConfig, ModelDefinitionConfig } from "../config/types.models.js";

export const SYNTHETIC_BASE_URL = "https://api.synthetic.new/anthropic";
export const SYNTHETIC_DEFAULT_MODEL_ID = "hf:MiniMaxAI/MiniMax-M2.5";
export const SYNTHETIC_DEFAULT_MODEL_REF = `synthetic/${SYNTHETIC_DEFAULT_MODEL_ID}`;
export const SYNTHETIC_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY: ModelCapabilityConfig = {
  tools: true,
  json: true,
};

type SyntheticModelCatalogEntryConfig = Omit<ModelDefinitionConfig, "cost"> & {
  cost?: ModelDefinitionConfig["cost"];
};

export const SYNTHETIC_MODEL_CATALOG = [
  {
    id: "hf:zai-org/GLM-5.1",
    name: "GLM-5.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 196608,
    maxTokens: 65536,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:moonshotai/Kimi-K2.6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: SYNTHETIC_DEFAULT_MODEL_ID,
    name: "MiniMax M2.5",
    reasoning: false,
    input: ["text"],
    contextWindow: 191488,
    maxTokens: 65536,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:zai-org/GLM-4.7-Flash",
    name: "GLM-4.7 Flash",
    reasoning: false,
    input: ["text"],
    contextWindow: 196608,
    maxTokens: 65536,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:zai-org/GLM-5",
    name: "GLM-5",
    reasoning: true,
    input: ["text"],
    contextWindow: 196608,
    maxTokens: 65536,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
    name: "NVIDIA Nemotron 3 Super 120B",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 65536,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:zai-org/GLM-4.7",
    name: "GLM-4.7",
    reasoning: false,
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 65536,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-V3.2",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text"],
    contextWindow: 159000,
    maxTokens: 8192,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:openai/gpt-oss-120b",
    name: "GPT OSS 120B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-R1-0528",
    name: "DeepSeek R1 0528",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-V3",
    name: "DeepSeek V3",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:meta-llama/Llama-3.3-70B-Instruct",
    name: "Llama 3.3 70B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 8192,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:nvidia/Kimi-K2.5-NVFP4",
    name: "Kimi K2.5 NVFP4",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 8192,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:Qwen/Qwen3-235B-A22B-Thinking-2507",
    name: "Qwen3 235B A22B Thinking 2507",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 8192,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:Qwen/Qwen3-Coder-480B-A35B-Instruct",
    name: "Qwen3 Coder 480B A35B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 8192,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
  {
    id: "hf:Qwen/Qwen3.5-397B-A17B",
    name: "Qwen3.5 397B A17B",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 8192,
    capabilities: SYNTHETIC_ANTHROPIC_COMPAT_CAPABILITY,
  },
] satisfies SyntheticModelCatalogEntryConfig[];

export type SyntheticCatalogEntry = (typeof SYNTHETIC_MODEL_CATALOG)[number];

export const SYNTHETIC_MODEL_IDS = SYNTHETIC_MODEL_CATALOG.map((model) => model.id);

export function buildSyntheticModelDefinition(entry: SyntheticCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: { ...SYNTHETIC_DEFAULT_COST },
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    capabilities: entry.capabilities ? { ...entry.capabilities } : undefined,
  };
}

export function buildSyntheticModelCapabilityOverrides(
  routeId = "synthetic",
): Record<string, ModelCapabilityConfig> {
  return Object.fromEntries(
    SYNTHETIC_MODEL_CATALOG.map((model) => [
      `${routeId}/${model.id}`,
      model.capabilities ? { ...model.capabilities } : {},
    ]),
  );
}
