import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import {
  buildCopilotModelDefinition,
  buildCopilotProxyModelDefinition,
  getDefaultCopilotModelIds,
  getDefaultCopilotProxyModelIds,
} from "../providers/github-copilot-models.js";
import {
  buildVercelAiGatewayModelDefinition,
  VERCEL_AI_GATEWAY_MODEL_IDS,
} from "../providers/vercel-ai-gateway-models.js";
import { XIAOMI_BASE_URL, XIAOMI_MODEL_CATALOG } from "../providers/xiaomi-models.js";
import {
  buildBytePlusModelDefinition,
  BYTEPLUS_BASE_URL,
  BYTEPLUS_CODING_BASE_URL,
  BYTEPLUS_CODING_MODEL_CATALOG,
  BYTEPLUS_MODEL_CATALOG,
} from "./byteplus-models.js";
import {
  buildChutesModelDefinition,
  CHUTES_BASE_URL,
  CHUTES_MODEL_CATALOG,
} from "./chutes-models.js";
import {
  buildCloudflareAiGatewayModelDefinition,
  CLOUDFLARE_AI_GATEWAY_MODEL_CATALOG,
} from "./cloudflare-ai-gateway.js";
import {
  buildDoubaoModelDefinition,
  DOUBAO_BASE_URL,
  DOUBAO_CODING_BASE_URL,
  DOUBAO_CODING_MODEL_CATALOG,
  DOUBAO_MODEL_CATALOG,
} from "./doubao-models.js";
import {
  buildHuggingfaceModelDefinition,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_MODEL_CATALOG,
} from "./huggingface-models.js";
import {
  normalizeProviderCatalogRows,
  type NormalizedModelCatalogRow,
} from "./model-catalog-normalized.js";
import { getOpencodeZenStaticFallbackModels } from "./opencode-zen-models.js";
import {
  buildSyntheticModelDefinition,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_MODEL_CATALOG,
} from "./synthetic-models.js";
import {
  buildTogetherModelDefinition,
  TOGETHER_BASE_URL,
  TOGETHER_MODEL_CATALOG,
} from "./together-models.js";
import {
  buildVeniceModelDefinition,
  VENICE_BASE_URL,
  VENICE_MODEL_CATALOG,
} from "./venice-models.js";

const ZERO_COST: ModelDefinitionConfig["cost"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function model(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ModelDefinitionConfig["input"];
  contextWindow?: number;
  maxTokens?: number;
  api?: ModelDefinitionConfig["api"];
  cost?: ModelDefinitionConfig["cost"];
  compat?: ModelDefinitionConfig["compat"];
  capabilities?: ModelDefinitionConfig["capabilities"];
}): ModelDefinitionConfig {
  return {
    id: params.id,
    name: params.name ?? params.id,
    reasoning: params.reasoning ?? false,
    input: params.input ?? ["text"],
    cost: params.cost ?? ZERO_COST,
    contextWindow: params.contextWindow ?? 200_000,
    maxTokens: params.maxTokens ?? 8192,
    ...(params.api ? { api: params.api } : {}),
    ...(params.compat ? { compat: params.compat } : {}),
    ...(params.capabilities ? { capabilities: params.capabilities } : {}),
  };
}

const OPENAI_MODELS: ModelDefinitionConfig[] = [
  model({
    id: "gpt-5.6",
    name: "GPT-5.6 Sol",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    api: "openai-responses",
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  }),
  model({
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    api: "openai-responses",
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
  }),
  model({
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    api: "openai-responses",
    cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
  }),
  model({
    id: "gpt-5.5",
    name: "GPT-5.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    api: "openai-responses",
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  }),
  model({
    id: "gpt-5.4",
    name: "GPT-5.4",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    api: "openai-responses",
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  }),
  model({
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400_000,
    maxTokens: 128_000,
    api: "openai-responses",
    cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  }),
  model({
    id: "gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400_000,
    maxTokens: 128_000,
    api: "openai-responses",
    cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  }),
];

const OPENAI_CODEX_MODELS: ModelDefinitionConfig[] = [
  model({
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    api: "openai-codex-responses",
    compat: { responsesLite: true },
  }),
  model({
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    api: "openai-codex-responses",
    compat: { responsesLite: true },
  }),
  model({
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    api: "openai-codex-responses",
    compat: { responsesLite: true },
  }),
  model({
    id: "gpt-5.5",
    name: "GPT-5.5 Codex",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    api: "openai-codex-responses",
  }),
  model({
    id: "gpt-5.4",
    name: "GPT-5.4 Codex",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    api: "openai-codex-responses",
  }),
  model({
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini Codex",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400_000,
    maxTokens: 128_000,
    api: "openai-codex-responses",
    cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  }),
  model({
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    reasoning: true,
    input: ["text"],
    contextWindow: 400_000,
    maxTokens: 128_000,
    api: "openai-codex-responses",
  }),
];

const ANTHROPIC_MODELS: ModelDefinitionConfig[] = [
  model({
    id: "claude-fable-5",
    name: "Claude Fable 5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  }),
  model({
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  }),
  model({
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    // Introductory API pricing through 2026-08-31; review after that date.
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  }),
  model({
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 64_000,
  }),
];

const GOOGLE_MODELS: ModelDefinitionConfig[] = [
  model({
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  }),
  model({
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  }),
  model({
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  }),
  model({
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash-Lite",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  }),
];

const XAI_MODELS: ModelDefinitionConfig[] = [
  model({
    id: "grok-4.3",
    name: "Grok 4.3",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    api: "openai-responses",
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    capabilities: {
      tools: true,
      json: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      defaultThinkingLevel: "low",
      thinkingMode: "xai-reasoning-effort",
      reasoningBudgetSupported: false,
    },
  }),
  model({
    id: "grok-build-0.1",
    name: "Grok Build 0.1",
    reasoning: false,
    input: ["text"],
    contextWindow: 256_000,
    maxTokens: 64_000,
    api: "openai-responses",
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    capabilities: {
      tools: true,
      json: true,
    },
  }),
];

const ZAI_MODELS: ModelDefinitionConfig[] = [
  model({
    id: "glm-5.2",
    name: "GLM-5.2",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  }),
  model({
    id: "glm-5.1",
    name: "GLM-5.1",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 128_000,
  }),
  model({
    id: "glm-5",
    name: "GLM-5",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 128_000,
  }),
  model({
    id: "glm-5-turbo",
    name: "GLM-5 Turbo",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 128_000,
  }),
  model({
    id: "glm-5v-turbo",
    name: "GLM-5V Turbo",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 128_000,
  }),
  model({
    id: "glm-4.7",
    name: "GLM-4.7",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 128_000,
  }),
  model({
    id: "glm-4.7-flashx",
    name: "GLM-4.7 FlashX",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 128_000,
  }),
  model({
    id: "glm-4.7-flash",
    name: "GLM-4.7 Flash",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 128_000,
  }),
];

const MINIMAX_MODELS: ModelDefinitionConfig[] = [
  model({
    id: "MiniMax-M2.7",
    name: "MiniMax M2.7",
    reasoning: true,
    contextWindow: 204_800,
    maxTokens: 131_072,
  }),
  model({
    id: "MiniMax-M2.7-highspeed",
    name: "MiniMax M2.7 Highspeed",
    reasoning: true,
    contextWindow: 204_800,
    maxTokens: 131_072,
  }),
  model({
    id: "MiniMax-M2.5",
    name: "MiniMax M2.5",
    reasoning: true,
    contextWindow: 204_800,
    maxTokens: 131_072,
  }),
  model({
    id: "MiniMax-M2.5-highspeed",
    name: "MiniMax M2.5 Highspeed",
    reasoning: true,
    contextWindow: 204_800,
    maxTokens: 131_072,
  }),
];

const MOONSHOT_MODELS: ModelDefinitionConfig[] = [
  model({
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 32_768,
  }),
  model({
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256_000,
    maxTokens: 8192,
  }),
];

const KIMI_CODING_MODELS: ModelDefinitionConfig[] = [
  model({
    id: "kimi-for-coding",
    name: "Kimi Coding",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 32_768,
  }),
];

const MISTRAL_MODELS: ModelDefinitionConfig[] = [
  model({
    id: "mistral-medium-3.5",
    name: "Mistral Medium 3.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
  }),
  model({
    id: "mistral-small-2603",
    name: "Mistral Small 4",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
  }),
  model({
    id: "mistral-large-2512",
    name: "Mistral Large 3",
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
  }),
  model({
    id: "devstral-2512",
    name: "Devstral 2",
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.4, output: 2, cacheRead: 0, cacheWrite: 0 },
  }),
  model({
    id: "ministral-14b-2512",
    name: "Ministral 3 14B",
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.2, output: 0.2, cacheRead: 0, cacheWrite: 0 },
  }),
  model({
    id: "ministral-8b-2512",
    name: "Ministral 3 8B",
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.15, output: 0.15, cacheRead: 0, cacheWrite: 0 },
  }),
  model({
    id: "ministral-3b-2512",
    name: "Ministral 3 3B",
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
  }),
];

const QWEN_MODELS: ModelDefinitionConfig[] = [
  model({
    id: "qwen3.7-max",
    name: "qwen3.7-max",
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  }),
  model({
    id: "qwen3.7-plus",
    name: "qwen3.7-plus",
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  }),
  model({
    id: "qwen3.6-flash",
    name: "qwen3.6-flash",
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  }),
  model({
    id: "deepseek-v4-pro",
    name: "deepseek-v4-pro",
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  }),
  model({
    id: "deepseek-v4-flash",
    name: "deepseek-v4-flash",
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  }),
  model({
    id: "kimi-k2.7-code",
    name: "kimi-k2.7-code",
    contextWindow: 262_144,
    maxTokens: 32_768,
  }),
  model({ id: "glm-5.2", name: "glm-5.2", contextWindow: 1_000_000, maxTokens: 128_000 }),
  model({
    id: "MiniMax-M2.5",
    name: "MiniMax-M2.5",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  }),
];

const QIANFAN_MODELS: ModelDefinitionConfig[] = [
  model({
    id: "ernie-5.1",
    name: "ERNIE 5.1",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 65_536,
  }),
  model({
    id: "ernie-5.0",
    name: "ERNIE 5.0",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 65_536,
  }),
  model({
    id: "ernie-5.0-thinking-latest",
    name: "ERNIE 5.0 Thinking Latest",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 65_536,
  }),
  model({
    id: "ernie-5.0-thinking-preview",
    name: "ERNIE 5.0 Thinking Preview",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 119_000,
    maxTokens: 64_000,
  }),
  model({
    id: "ernie-x1.1-preview",
    name: "ERNIE X1.1 Preview",
    reasoning: true,
    contextWindow: 64_000,
    maxTokens: 65_536,
  }),
  model({
    id: "ernie-x1.1",
    name: "ERNIE X1.1",
    reasoning: true,
    contextWindow: 64_000,
    maxTokens: 65_536,
  }),
  model({
    id: "ernie-x1-turbo-32k",
    name: "ERNIE X1 Turbo 32K",
    reasoning: true,
    contextWindow: 32_000,
    maxTokens: 28_160,
  }),
  model({
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  }),
  model({
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  }),
  model({
    id: "deepseek-v3.2-think",
    name: "DeepSeek V3.2 Think",
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 32_768,
  }),
  model({
    id: "deepseek-v3.2",
    name: "DeepSeek V3.2",
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 32_768,
  }),
];

export const CURRENT_MODEL_PROVIDER_CATALOG: Readonly<Record<string, ModelProviderConfig>> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    api: "openai-responses",
    models: OPENAI_MODELS,
  },
  "openai-codex": {
    baseUrl: "https://chatgpt.com/backend-api",
    api: "openai-codex-responses",
    auth: "oauth",
    models: OPENAI_CODEX_MODELS,
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: ANTHROPIC_MODELS,
  },
  minimax: {
    baseUrl: "https://api.minimax.io/anthropic",
    api: "anthropic-messages",
    models: MINIMAX_MODELS,
  },
  "minimax-cn": {
    baseUrl: "https://api.minimaxi.com/anthropic",
    api: "anthropic-messages",
    models: MINIMAX_MODELS,
  },
  "minimax-portal": {
    baseUrl: "https://api.minimax.io/anthropic",
    api: "openai-completions",
    auth: "oauth",
    models: MINIMAX_MODELS,
  },
  moonshot: {
    baseUrl: "https://api.moonshot.ai/v1",
    api: "openai-completions",
    models: MOONSHOT_MODELS,
  },
  "kimi-coding": {
    baseUrl: "https://api.kimi.com/coding/",
    api: "anthropic-messages",
    models: KIMI_CODING_MODELS,
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: "google-generative-ai",
    models: GOOGLE_MODELS,
  },
  "google-gemini-cli": {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: "google-generative-ai",
    auth: "oauth",
    models: GOOGLE_MODELS,
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    models: [
      model({
        id: "auto",
        name: "OpenRouter Auto",
        input: ["text", "image"],
        contextWindow: 200_000,
      }),
      model({
        id: "moonshotai/kimi-k2.6",
        name: "MoonshotAI Kimi K2.6",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 262_144,
        maxTokens: 262_144,
        api: "openai-completions",
        cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
      }),
      model({
        id: "moonshotai/kimi-k2.5",
        name: "MoonshotAI Kimi K2.5",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 262_144,
        maxTokens: 262_144,
        api: "openai-completions",
        cost: { input: 0.44, output: 2, cacheRead: 0.22, cacheWrite: 0 },
      }),
      ...OPENAI_MODELS.map((entry) => ({
        ...entry,
        id: `openai/${entry.id}`,
        name: `OpenAI ${entry.name}`,
        api: "openai-completions" as const,
      })),
      ...ANTHROPIC_MODELS.map((entry) => ({
        ...entry,
        id: `anthropic/${entry.id}`,
        name: `Anthropic ${entry.name}`,
        api: "openai-completions" as const,
      })),
      ...GOOGLE_MODELS.map((entry) => ({
        ...entry,
        id: `google/${entry.id}`,
        name: `Google ${entry.name}`,
        api: "openai-completions" as const,
      })),
    ],
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    api: "openai-completions",
    models: XAI_MODELS,
  },
  zai: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    models: ZAI_MODELS,
  },
  chutes: {
    baseUrl: CHUTES_BASE_URL,
    api: "openai-completions",
    models: CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition),
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    api: "openai-completions",
    models: MISTRAL_MODELS,
  },
  qwen: {
    baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    api: "openai-completions",
    models: QWEN_MODELS,
  },
  synthetic: {
    baseUrl: SYNTHETIC_BASE_URL,
    api: "anthropic-messages",
    models: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition),
  },
  venice: {
    baseUrl: VENICE_BASE_URL,
    api: "openai-completions",
    models: VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition),
  },
  together: {
    baseUrl: TOGETHER_BASE_URL,
    api: "openai-completions",
    models: TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition),
  },
  huggingface: {
    baseUrl: HUGGINGFACE_BASE_URL,
    api: "openai-completions",
    models: HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition),
  },
  qianfan: {
    baseUrl: "https://qianfan.baidubce.com/v2",
    api: "openai-completions",
    models: QIANFAN_MODELS,
  },
  xiaomi: {
    baseUrl: XIAOMI_BASE_URL,
    api: "openai-completions",
    models: XIAOMI_MODEL_CATALOG,
  },
  opencode: {
    baseUrl: "https://opencode.ai/zen/v1",
    api: "openai-completions",
    models: getOpencodeZenStaticFallbackModels(),
  },
  "vercel-ai-gateway": {
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    api: "openai-completions",
    models: VERCEL_AI_GATEWAY_MODEL_IDS.map(buildVercelAiGatewayModelDefinition),
  },
  "cloudflare-ai-gateway": {
    api: "anthropic-messages",
    models: CLOUDFLARE_AI_GATEWAY_MODEL_CATALOG.map((entry) =>
      buildCloudflareAiGatewayModelDefinition({ id: entry.id }),
    ),
  },
  litellm: {
    baseUrl: "http://localhost:4000/v1",
    api: "openai-completions",
    request: { allowPrivateNetwork: true },
    models: [],
  },
  vllm: {
    baseUrl: "http://127.0.0.1:8000/v1",
    api: "openai-completions",
    request: { allowPrivateNetwork: true },
    models: [],
  },
  "github-copilot": {
    baseUrl: "https://api.individual.githubcopilot.com",
    api: "openai-responses",
    auth: "oauth",
    models: getDefaultCopilotModelIds().map(buildCopilotModelDefinition),
  },
  "copilot-proxy": {
    baseUrl: "http://127.0.0.1:4141/v1",
    api: "openai-completions",
    request: { allowPrivateNetwork: true },
    models: getDefaultCopilotProxyModelIds().map(buildCopilotProxyModelDefinition),
  },
  volcengine: {
    baseUrl: DOUBAO_BASE_URL,
    api: "openai-completions",
    models: DOUBAO_MODEL_CATALOG.map(buildDoubaoModelDefinition),
  },
  "volcengine-coding": {
    baseUrl: DOUBAO_CODING_BASE_URL,
    api: "openai-completions",
    models: DOUBAO_CODING_MODEL_CATALOG.map(buildDoubaoModelDefinition),
  },
  "volcengine-plan": {
    baseUrl: DOUBAO_CODING_BASE_URL,
    api: "openai-completions",
    models: DOUBAO_CODING_MODEL_CATALOG.map(buildDoubaoModelDefinition),
  },
  byteplus: {
    baseUrl: BYTEPLUS_BASE_URL,
    api: "openai-completions",
    models: BYTEPLUS_MODEL_CATALOG.map(buildBytePlusModelDefinition),
  },
  "byteplus-coding": {
    baseUrl: BYTEPLUS_CODING_BASE_URL,
    api: "openai-completions",
    models: BYTEPLUS_CODING_MODEL_CATALOG.map(buildBytePlusModelDefinition),
  },
  "byteplus-plan": {
    baseUrl: BYTEPLUS_CODING_BASE_URL,
    api: "openai-completions",
    models: BYTEPLUS_CODING_MODEL_CATALOG.map(buildBytePlusModelDefinition),
  },
};

export function cloneCurrentModelProvider(provider: string): ModelProviderConfig | undefined {
  const entry = CURRENT_MODEL_PROVIDER_CATALOG[provider];
  if (!entry) {
    return undefined;
  }
  return {
    ...entry,
    models: entry.models.map((model) => ({ ...model, cost: { ...model.cost } })),
  };
}

export function listCurrentModelCatalogRows(): NormalizedModelCatalogRow[] {
  return Object.entries(CURRENT_MODEL_PROVIDER_CATALOG).flatMap(([provider, providerConfig]) =>
    normalizeProviderCatalogRows({
      provider,
      providerConfig,
      source: "current-preview",
      status: "preview",
    }),
  );
}
