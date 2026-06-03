import { QIANFAN_BASE_URL, QIANFAN_DEFAULT_MODEL_ID } from "../agents/models-config.providers.js";
import type { ModelDefinitionConfig } from "../config/types.js";

export const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";
export const MINIMAX_API_BASE_URL = "https://api.minimax.io/anthropic";
export const MINIMAX_CN_API_BASE_URL = "https://api.minimaxi.com/anthropic";
export const MINIMAX_HOSTED_MODEL_ID = "MiniMax-M2.7";
export const MINIMAX_HOSTED_MODEL_REF = `minimax/${MINIMAX_HOSTED_MODEL_ID}`;
export const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.7";
export const MINIMAX_HIGHSPEED_MODEL_ID = "MiniMax-M2.7-highspeed";
export const DEFAULT_MINIMAX_CONTEXT_WINDOW = 204800;
export const DEFAULT_MINIMAX_MAX_TOKENS = 131072;

export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";
export const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.6";
export const MOONSHOT_DEFAULT_MODEL_REF = `moonshot/${MOONSHOT_DEFAULT_MODEL_ID}`;
export const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 262144;
export const MOONSHOT_DEFAULT_MAX_TOKENS = 32768;
export const KIMI_CODING_MODEL_ID = "kimi-for-coding";
export const KIMI_CODING_MODEL_REF = `kimi-coding/${KIMI_CODING_MODEL_ID}`;

export { QIANFAN_BASE_URL, QIANFAN_DEFAULT_MODEL_ID };
export const QIANFAN_DEFAULT_MODEL_REF = `qianfan/${QIANFAN_DEFAULT_MODEL_ID}`;

export const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const ZAI_CODING_CN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
export const ZAI_GLOBAL_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_CN_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const ZAI_DEFAULT_MODEL_ID = "glm-5.1";
export const ZAI_RECOMMENDED_MODEL_IDS = [
  "glm-5.1",
  "glm-5",
  "glm-5-turbo",
  "glm-5v-turbo",
  "glm-4.7",
  "glm-4.7-flashx",
  "glm-4.7-flash",
] as const;

export function resolveZaiBaseUrl(endpoint?: string): string {
  switch (endpoint) {
    case "coding-cn":
      return ZAI_CODING_CN_BASE_URL;
    case "global":
      return ZAI_GLOBAL_BASE_URL;
    case "cn":
      return ZAI_CN_BASE_URL;
    case "coding-global":
      return ZAI_CODING_GLOBAL_BASE_URL;
    default:
      return ZAI_GLOBAL_BASE_URL;
  }
}

// Pricing per 1M tokens (USD) — https://platform.minimaxi.com/document/Price
export const MINIMAX_API_COST = {
  input: 0.3,
  output: 1.2,
  cacheRead: 0.03,
  cacheWrite: 0.12,
};
export const MINIMAX_HOSTED_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
export const MOONSHOT_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const ZAI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const MINIMAX_MODEL_CATALOG = {
  "MiniMax-M2.7": { name: "MiniMax M2.7", reasoning: true },
  "MiniMax-M2.7-highspeed": { name: "MiniMax M2.7 Highspeed", reasoning: true },
  "MiniMax-M2.5": { name: "MiniMax M2.5", reasoning: true },
  "MiniMax-M2.5-highspeed": { name: "MiniMax M2.5 Highspeed", reasoning: true },
} as const;

type MinimaxCatalogId = keyof typeof MINIMAX_MODEL_CATALOG;

const ZAI_MODEL_CATALOG: Record<
  (typeof ZAI_RECOMMENDED_MODEL_IDS)[number],
  {
    name: string;
    reasoning: boolean;
    input?: readonly ("text" | "image")[];
    contextWindow?: number;
    maxTokens?: number;
  }
> = {
  "glm-5.1": { name: "GLM-5.1", reasoning: true, contextWindow: 200000, maxTokens: 128000 },
  "glm-5": { name: "GLM-5", reasoning: true, contextWindow: 200000, maxTokens: 128000 },
  "glm-5-turbo": {
    name: "GLM-5 Turbo",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 128000,
  },
  "glm-5v-turbo": {
    name: "GLM-5V Turbo",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 128000,
  },
  "glm-4.7": { name: "GLM-4.7", reasoning: true, contextWindow: 200000, maxTokens: 128000 },
  "glm-4.7-flashx": {
    name: "GLM-4.7 FlashX",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 128000,
  },
  "glm-4.7-flash": {
    name: "GLM-4.7 Flash",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 128000,
  },
};

type ZaiCatalogId = (typeof ZAI_RECOMMENDED_MODEL_IDS)[number];

export function buildMinimaxModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  cost: ModelDefinitionConfig["cost"];
  contextWindow: number;
  maxTokens: number;
}): ModelDefinitionConfig {
  const catalog = MINIMAX_MODEL_CATALOG[params.id as MinimaxCatalogId];
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? `MiniMax ${params.id}`,
    reasoning: params.reasoning ?? catalog?.reasoning ?? false,
    input: ["text"],
    cost: params.cost,
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
  };
}

export function buildMinimaxApiModelDefinition(modelId: string): ModelDefinitionConfig {
  return buildMinimaxModelDefinition({
    id: modelId,
    cost: MINIMAX_API_COST,
    contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
  });
}

export function buildMoonshotModelDefinition(): ModelDefinitionConfig {
  return {
    id: MOONSHOT_DEFAULT_MODEL_ID,
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    cost: MOONSHOT_DEFAULT_COST,
    contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
  };
}

export const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
export const MISTRAL_DEFAULT_MODEL_ID = "mistral-medium-3.5";
export const MISTRAL_DEFAULT_MODEL_REF = `mistral/${MISTRAL_DEFAULT_MODEL_ID}`;
export const MISTRAL_DEFAULT_CONTEXT_WINDOW = 262144;
export const MISTRAL_DEFAULT_MAX_TOKENS = 262144;
export const MISTRAL_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const MISTRAL_MODEL_CATALOG = [
  {
    id: "mistral-medium-3.5",
    name: "Mistral Medium 3.5",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "mistral-small-2603",
    name: "Mistral Small 4",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "mistral-large-2512",
    name: "Mistral Large 3",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "mistral-medium-2508",
    name: "Mistral Medium 3.1",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.4, output: 2, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "devstral-2512",
    name: "Devstral 2",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.4, output: 2, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "magistral-medium-2509",
    name: "Magistral Medium 1.2",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128_000,
    maxTokens: 128_000,
    cost: { input: 2, output: 5, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "magistral-small-2509",
    name: "Magistral Small 1.2",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128_000,
    maxTokens: 128_000,
    cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "ministral-14b-2512",
    name: "Ministral 3 14B",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.2, output: 0.2, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "ministral-8b-2512",
    name: "Ministral 3 8B",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.15, output: 0.15, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "ministral-3b-2512",
    name: "Ministral 3 3B",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
  },
] as const;

export function buildMistralModelDefinition(
  modelId = MISTRAL_DEFAULT_MODEL_ID,
): ModelDefinitionConfig {
  const catalog =
    MISTRAL_MODEL_CATALOG.find((entry) => entry.id === modelId) ?? MISTRAL_MODEL_CATALOG[0];
  return {
    id: catalog.id,
    name: catalog.name,
    reasoning: catalog.reasoning,
    input: [...catalog.input],
    cost: catalog.cost ?? MISTRAL_DEFAULT_COST,
    contextWindow: catalog.contextWindow,
    maxTokens: catalog.maxTokens,
  };
}

export function buildZaiModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  cost?: ModelDefinitionConfig["cost"];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = ZAI_MODEL_CATALOG[params.id as ZaiCatalogId];
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? `GLM ${params.id}`,
    reasoning: params.reasoning ?? catalog?.reasoning ?? true,
    input: catalog?.input ? [...catalog.input] : ["text"],
    cost: params.cost ?? ZAI_DEFAULT_COST,
    contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 204800,
    maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 131072,
  };
}

export const XAI_BASE_URL = "https://api.x.ai/v1";
export const XAI_DEFAULT_MODEL_ID = "grok-4.3";
export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;
export const XAI_DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const XAI_DEFAULT_MAX_TOKENS = 64_000;
export const XAI_DEFAULT_COST = {
  input: 1.25,
  output: 2.5,
  cacheRead: 0.2,
  cacheWrite: 0,
};

export const XAI_MODEL_CATALOG = [
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
  {
    id: "grok-4.20-multi-agent-0309",
    name: "Grok 4.20 Multi-Agent",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 2_000_000,
    maxTokens: 64_000,
  },
  {
    id: "grok-4.20-0309-reasoning",
    name: "Grok 4.20 Reasoning",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 2_000_000,
    maxTokens: 64_000,
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    name: "Grok 4.20 Non-Reasoning",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 2_000_000,
    maxTokens: 64_000,
  },
] as const;

export function buildXaiModelDefinition(modelId = XAI_DEFAULT_MODEL_ID): ModelDefinitionConfig {
  const catalog = XAI_MODEL_CATALOG.find((entry) => entry.id === modelId) ?? XAI_MODEL_CATALOG[0];
  const capabilities: NonNullable<ModelDefinitionConfig["capabilities"]> =
    catalog.id === "grok-4.3"
      ? {
          tools: true,
          json: true,
          thinkingLevels: ["off", "low", "medium", "high"],
          defaultThinkingLevel: "low",
          thinkingMode: "xai-reasoning-effort",
          reasoningBudgetSupported: false,
        }
      : catalog.id === "grok-4.20-multi-agent-0309"
        ? {
            tools: true,
            json: true,
            thinkingLevels: ["low", "medium", "high", "xhigh"],
            defaultThinkingLevel: "low",
            thinkingMode: "xai-multi-agent-effort",
            reasoningBudgetSupported: false,
          }
        : catalog.id === "grok-4.20-0309-reasoning"
          ? {
              tools: true,
              json: true,
              fixedReasoning: true,
            }
          : {
              tools: true,
              json: true,
            };
  return {
    id: catalog.id,
    name: catalog.name,
    reasoning: catalog.reasoning,
    input: [...catalog.input],
    api: "openai-responses",
    capabilities,
    cost: XAI_DEFAULT_COST,
    contextWindow: catalog.contextWindow,
    maxTokens: catalog.maxTokens,
  };
}
