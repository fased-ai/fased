import type { ModelCapabilityConfig, ModelDefinitionConfig } from "../config/types.models.js";

export const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
export const VENICE_DEFAULT_MODEL_ID = "zai-org-glm-5-1";
export const VENICE_DEFAULT_MODEL_REF = `venice/${VENICE_DEFAULT_MODEL_ID}`;

export const VENICE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const VENICE_ADJUSTABLE_THINKING: Pick<
  ModelCapabilityConfig,
  "thinkingMode" | "reasoningBudgetSupported"
> = {
  thinkingMode: "generic-reasoning",
  reasoningBudgetSupported: false,
};

const VENICE_TOOL_JSON_CAPABILITY: Pick<ModelCapabilityConfig, "tools" | "json"> = {
  tools: true,
  json: true,
};

const VENICE_TOOL_ONLY_CAPABILITY: Pick<ModelCapabilityConfig, "tools" | "json"> = {
  tools: true,
  json: false,
};

export const VENICE_MODEL_CATALOG = [
  {
    id: VENICE_DEFAULT_MODEL_ID,
    name: "GLM 5.1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1.75, output: 5.5, cacheRead: 0.325, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 24_000,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      thinkingLevels: ["off", "low", "medium", "high"],
      defaultThinkingLevel: "low",
      ...VENICE_ADJUSTABLE_THINKING,
    },
  },
  {
    id: "venice-uncensored-1-2",
    name: "Venice Uncensored 1.2",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.2, output: 0.9, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    capabilities: VENICE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "qwen-3-6-plus",
    name: "Qwen 3.6 Plus Uncensored",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.625, output: 3.75, cacheRead: 0.0625, cacheWrite: 0.78 },
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      video: true,
      fixedReasoning: true,
    },
  },
  {
    id: "qwen3-5-397b-a17b",
    name: "Qwen 3.5 397B",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.75, output: 4.5, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_768,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      video: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      defaultThinkingLevel: "low",
      ...VENICE_ADJUSTABLE_THINKING,
    },
  },
  {
    id: "qwen3-235b-a22b-thinking-2507",
    name: "Qwen 3 235B A22B Thinking",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.45, output: 3.5, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      thinkingLevels: ["low", "medium", "high"],
      defaultThinkingLevel: "low",
      ...VENICE_ADJUSTABLE_THINKING,
    },
  },
  {
    id: "qwen3-coder-480b-a35b-instruct-turbo",
    name: "Qwen 3 Coder 480B Turbo",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.35, output: 1.5, cacheRead: 0.04, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 65_536,
    capabilities: VENICE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "qwen3-vl-235b-a22b",
    name: "Qwen3 VL 235B",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.25, output: 1.5, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 16_384,
    capabilities: VENICE_TOOL_JSON_CAPABILITY,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    input: ["text"],
    cost: { input: 1.73, output: 3.796, cacheRead: 0.33, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      fixedReasoning: true,
    },
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.17, output: 0.35, cacheRead: 0.028, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      fixedReasoning: true,
    },
  },
  {
    id: "kimi-k2-6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.85, output: 4.655, cacheRead: 0.22, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 65_536,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      thinkingLevels: ["off", "low", "medium", "high"],
      defaultThinkingLevel: "high",
      ...VENICE_ADJUSTABLE_THINKING,
    },
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      fixedReasoning: true,
    },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3.6, output: 18, cacheRead: 0.36, cacheWrite: 4.5 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      fixedReasoning: true,
    },
  },
  {
    id: "openai-gpt-55",
    name: "GPT-5.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 6.25, output: 37.5, cacheRead: 0.625, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      defaultThinkingLevel: "high",
      ...VENICE_ADJUSTABLE_THINKING,
    },
  },
  {
    id: "openai-gpt-55-pro",
    name: "GPT-5.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 37.5, output: 225, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      defaultThinkingLevel: "medium",
      ...VENICE_ADJUSTABLE_THINKING,
    },
  },
  {
    id: "openai-gpt-54",
    name: "GPT-5.4",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3.13, output: 18.8, cacheRead: 0.313, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      defaultThinkingLevel: "high",
      ...VENICE_ADJUSTABLE_THINKING,
    },
  },
  {
    id: "openai-gpt-54-mini",
    name: "GPT-5.4 Mini",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.9375, output: 5.625, cacheRead: 0.09375, cacheWrite: 0 },
    contextWindow: 400_000,
    maxTokens: 128_000,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      defaultThinkingLevel: "high",
      ...VENICE_ADJUSTABLE_THINKING,
    },
  },
  {
    id: "gemini-3-1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2.5, output: 15, cacheRead: 0.5, cacheWrite: 0.5 },
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      audio: true,
      video: true,
      thinkingLevels: ["low", "medium", "high"],
      defaultThinkingLevel: "low",
      ...VENICE_ADJUSTABLE_THINKING,
    },
  },
  {
    id: "grok-4-20",
    name: "Grok 4.20",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.42, output: 2.83, cacheRead: 0.23, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 128_000,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      fixedReasoning: true,
    },
  },
  {
    id: "minimax-m27",
    name: "MiniMax M2.7",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.375, output: 1.5, cacheRead: 0.075, cacheWrite: 0 },
    contextWindow: 198_000,
    maxTokens: 32_768,
    capabilities: {
      ...VENICE_TOOL_ONLY_CAPABILITY,
      thinkingLevels: ["low", "medium", "high"],
      defaultThinkingLevel: "low",
      ...VENICE_ADJUSTABLE_THINKING,
    },
  },
  {
    id: "openai-gpt-oss-120b",
    name: "OpenAI GPT OSS 120B",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.07, output: 0.3, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    capabilities: {
      ...VENICE_TOOL_ONLY_CAPABILITY,
      thinkingLevels: ["off", "low", "medium", "high"],
      defaultThinkingLevel: "low",
      ...VENICE_ADJUSTABLE_THINKING,
    },
  },
  {
    id: "google-gemma-4-31b-it",
    name: "Google Gemma 4 31B Instruct",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.175, output: 0.5, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 8_192,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      video: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      defaultThinkingLevel: "low",
      ...VENICE_ADJUSTABLE_THINKING,
    },
  },
  {
    id: "mistral-small-2603",
    name: "Mistral Small 4",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.1875, output: 0.75, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 65_536,
    capabilities: {
      ...VENICE_TOOL_JSON_CAPABILITY,
      thinkingLevels: ["off", "high"],
      defaultThinkingLevel: "high",
      ...VENICE_ADJUSTABLE_THINKING,
    },
  },
] satisfies ModelDefinitionConfig[];

export type VeniceCatalogEntry = (typeof VENICE_MODEL_CATALOG)[number];

export const VENICE_MODEL_IDS = VENICE_MODEL_CATALOG.map((model) => model.id);
export const VENICE_MODEL_REFS = VENICE_MODEL_IDS.map((id) => `venice/${id}`);

export function buildVeniceModelDefinition(model: VeniceCatalogEntry): ModelDefinitionConfig {
  const capabilityConfig = model.capabilities as ModelCapabilityConfig | undefined;
  const supportsReasoningEffort = Boolean(capabilityConfig?.thinkingLevels?.length);
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
      supportsReasoningEffort,
    },
    capabilities: capabilityConfig ? { ...capabilityConfig } : undefined,
  };
}

export function buildVeniceModelCapabilityOverrides(
  routeId = "venice",
): Record<string, ModelCapabilityConfig> {
  return Object.fromEntries(
    VENICE_MODEL_CATALOG.map((model) => [
      `${routeId}/${model.id}`.toLowerCase(),
      model.capabilities ? { ...model.capabilities } : {},
    ]),
  );
}
