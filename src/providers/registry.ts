import type { ModelCapabilityConfig } from "../config/types.models.js";
import {
  BASE_THINKING_LEVELS,
  XHIGH_THINKING_LEVELS,
  resolveModelThinkingCapability,
} from "../shared/model-thinking.js";
import {
  buildCloudflareAiGatewayModelCapabilityOverrides,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  CLOUDFLARE_AI_GATEWAY_MODEL_IDS,
  CLOUDFLARE_AI_GATEWAY_MODEL_REFS,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_BRAND_ID,
  CLOUDFLARE_AI_GATEWAY_ROUTE_ID,
} from "./cloudflare-ai-gateway-shared.js";
import {
  buildHuggingfaceModelCapabilityOverrides,
  HUGGINGFACE_MODEL_IDS,
  HUGGINGFACE_MODEL_REFS,
} from "./huggingface-models.js";
import {
  buildLitellmModelCapabilityOverrides,
  LITELLM_DEFAULT_MODEL_REF,
  LITELLM_MODEL_IDS,
  LITELLM_MODEL_REFS,
} from "./litellm-models.js";
import {
  buildOpencodeZenModelCapabilityOverrides,
  OPENCODE_ZEN_DEFAULT_MODEL_REF,
  OPENCODE_ZEN_MODEL_IDS,
  OPENCODE_ZEN_MODEL_REFS,
} from "./opencode-zen-shared.js";
import { buildSyntheticModelCapabilityOverrides, SYNTHETIC_MODEL_IDS } from "./synthetic-models.js";
import {
  buildTogetherModelCapabilityOverrides,
  TOGETHER_DEFAULT_MODEL_REF,
  TOGETHER_MODEL_IDS,
  TOGETHER_MODEL_REFS,
} from "./together-models.js";
import {
  buildVeniceModelCapabilityOverrides,
  VENICE_DEFAULT_MODEL_REF,
  VENICE_MODEL_IDS,
  VENICE_MODEL_REFS,
} from "./venice-models.js";
import {
  buildVercelAiGatewayModelCapabilityOverrides,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
  VERCEL_AI_GATEWAY_MODEL_IDS,
  VERCEL_AI_GATEWAY_MODEL_REFS,
} from "./vercel-ai-gateway-models.js";
import { buildXiaomiModelCapabilityOverrides, XIAOMI_MODEL_IDS } from "./xiaomi-models.js";

export {
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID,
  CLOUDFLARE_AI_GATEWAY_MODEL_CATALOG,
  CLOUDFLARE_AI_GATEWAY_MODEL_IDS,
  CLOUDFLARE_AI_GATEWAY_MODEL_REFS,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_BRAND_ID,
  CLOUDFLARE_AI_GATEWAY_ROUTE_ID,
  resolveCloudflareAiGatewayBaseUrl,
} from "./cloudflare-ai-gateway-shared.js";
export {
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
  VERCEL_AI_GATEWAY_MODEL_IDS,
  VERCEL_AI_GATEWAY_MODEL_REFS,
} from "./vercel-ai-gateway-models.js";
export {
  OPENCODE_ZEN_DEFAULT_MODEL,
  OPENCODE_ZEN_DEFAULT_MODEL_REF,
  OPENCODE_ZEN_MODEL_IDS,
  OPENCODE_ZEN_MODEL_REFS,
} from "./opencode-zen-shared.js";
export {
  HUGGINGFACE_DEFAULT_MODEL_ID,
  HUGGINGFACE_DEFAULT_MODEL_REF,
  HUGGINGFACE_MODEL_IDS,
  HUGGINGFACE_MODEL_REFS,
} from "./huggingface-models.js";
export {
  VENICE_DEFAULT_MODEL_ID,
  VENICE_DEFAULT_MODEL_REF,
  VENICE_MODEL_IDS,
  VENICE_MODEL_REFS,
} from "./venice-models.js";
export {
  LITELLM_BASE_URL,
  LITELLM_DEFAULT_MODEL_ID,
  LITELLM_DEFAULT_MODEL_REF,
  LITELLM_MODEL_IDS,
  LITELLM_MODEL_REFS,
} from "./litellm-models.js";
export { SYNTHETIC_MODEL_IDS } from "./synthetic-models.js";
export {
  TOGETHER_DEFAULT_MODEL_ID,
  TOGETHER_DEFAULT_MODEL_REF,
  TOGETHER_MODEL_IDS,
  TOGETHER_MODEL_REFS,
} from "./together-models.js";
export { XIAOMI_MODEL_IDS } from "./xiaomi-models.js";

export type ProviderAuthMethodKind = "api-key" | "oauth" | "token" | "device" | "manual";

export type ProviderAuthMethodManifest = {
  id: string;
  route: string;
  configProviderId?: string;
  statusRoute?: string;
  kind: ProviderAuthMethodKind;
  label: string;
  hint?: string;
  setupRequirement?: string;
  buttonLabel?: string;
};

export type ProviderBrandManifest = {
  id: string;
  label: string;
  priority: number;
  hint?: string;
  routeAliases?: string[];
  modelProviderIds?: string[];
  methods: ProviderAuthMethodManifest[];
  models: {
    recommended: string[];
    routeRules: Record<string, string[]>;
    dynamic?: boolean;
  };
  modelCapabilities?: Record<string, ModelCapabilityConfig>;
};

export const PROVIDER_BRAND_ORDER = [
  "openai",
  "anthropic",
  "chutes",
  "ollama",
  "lmstudio",
  "vllm",
  "minimax",
  "moonshot",
  "google",
  "xai",
  "mistral",
  "volcengine",
  "byteplus",
  "openrouter",
  "qwen",
  "zai",
  "qianfan",
  "copilot",
  "ai-gateway",
  "opencode-zen",
  "xiaomi",
  "synthetic",
  "together",
  "huggingface",
  "venice",
  "litellm",
  "cloudflare-ai-gateway",
  "custom",
] as const;

const PROVIDER_BRAND_ORDER_INDEX = new Map(
  PROVIDER_BRAND_ORDER.map((providerId, index) => [providerId, index]),
);

export const OPENAI_PROVIDER_BRAND_ID = "openai";
export const OPENAI_API_ROUTE_ID = "openai";
export const OPENAI_CODEX_ROUTE_ID = "openai-codex";
export const ANTHROPIC_PROVIDER_BRAND_ID = "anthropic";
export const ANTHROPIC_ROUTE_ID = "anthropic";
export const CHUTES_PROVIDER_BRAND_ID = "chutes";
export const CHUTES_ROUTE_ID = "chutes";
export const OLLAMA_PROVIDER_BRAND_ID = "ollama";
export const OLLAMA_ROUTE_ID = "ollama";
export const LMSTUDIO_PROVIDER_BRAND_ID = "lmstudio";
export const LMSTUDIO_ROUTE_ID = "lmstudio";
export const VLLM_PROVIDER_BRAND_ID = "vllm";
export const VLLM_ROUTE_ID = "vllm";
export const MINIMAX_PROVIDER_BRAND_ID = "minimax";
export const MINIMAX_API_ROUTE_ID = "minimax";
export const MINIMAX_CN_ROUTE_ID = "minimax-cn";
export const MINIMAX_PORTAL_ROUTE_ID = "minimax-portal";
export const MOONSHOT_PROVIDER_BRAND_ID = "moonshot";
export const MOONSHOT_ROUTE_ID = "moonshot";
export const KIMI_CODING_ROUTE_ID = "kimi-coding";
export const GOOGLE_PROVIDER_BRAND_ID = "google";
export const GOOGLE_API_ROUTE_ID = "google";
export const GOOGLE_GEMINI_CLI_ROUTE_ID = "google-gemini-cli";
export const XAI_PROVIDER_BRAND_ID = "xai";
export const XAI_ROUTE_ID = "xai";
export const MISTRAL_PROVIDER_BRAND_ID = "mistral";
export const MISTRAL_ROUTE_ID = "mistral";
export const VOLCENGINE_PROVIDER_BRAND_ID = "volcengine";
export const VOLCENGINE_ROUTE_ID = "volcengine";
export const VOLCENGINE_CODING_ROUTE_ID = "volcengine-coding";
export const VOLCENGINE_PLAN_ROUTE_ID = "volcengine-plan";
export const BYTEPLUS_PROVIDER_BRAND_ID = "byteplus";
export const BYTEPLUS_ROUTE_ID = "byteplus";
export const BYTEPLUS_CODING_ROUTE_ID = "byteplus-coding";
export const BYTEPLUS_PLAN_ROUTE_ID = "byteplus-plan";
export const OPENROUTER_PROVIDER_BRAND_ID = "openrouter";
export const OPENROUTER_ROUTE_ID = "openrouter";
export const QWEN_PROVIDER_BRAND_ID = "qwen";
export const QWEN_API_ROUTE_ID = "qwen";
export const QWEN_CODING_PLAN_ROUTE_ID = "qwen-coding-plan";
export const ZAI_PROVIDER_BRAND_ID = "zai";
export const ZAI_ROUTE_ID = "zai";
export const QIANFAN_PROVIDER_BRAND_ID = "qianfan";
export const QIANFAN_ROUTE_ID = "qianfan";
export const COPILOT_PROVIDER_BRAND_ID = "copilot";
export const GITHUB_COPILOT_ROUTE_ID = "github-copilot";
export const COPILOT_PROXY_ROUTE_ID = "copilot-proxy";
export const VERCEL_AI_GATEWAY_PROVIDER_BRAND_ID = "ai-gateway";
export const VERCEL_AI_GATEWAY_ROUTE_ID = "vercel-ai-gateway";
export const OPENCODE_ZEN_PROVIDER_BRAND_ID = "opencode-zen";
export const OPENCODE_ZEN_ROUTE_ID = "opencode";
export const XIAOMI_PROVIDER_BRAND_ID = "xiaomi";
export const XIAOMI_ROUTE_ID = "xiaomi";
export const SYNTHETIC_PROVIDER_BRAND_ID = "synthetic";
export const SYNTHETIC_ROUTE_ID = "synthetic";
export const TOGETHER_PROVIDER_BRAND_ID = "together";
export const TOGETHER_ROUTE_ID = "together";
export const HUGGINGFACE_PROVIDER_BRAND_ID = "huggingface";
export const HUGGINGFACE_ROUTE_ID = "huggingface";
export const VENICE_PROVIDER_BRAND_ID = "venice";
export const VENICE_ROUTE_ID = "venice";
export const LITELLM_PROVIDER_BRAND_ID = "litellm";
export const LITELLM_ROUTE_ID = "litellm";
export const CUSTOM_PROVIDER_BRAND_ID = "custom";
export const CUSTOM_PROVIDER_ROUTE_ID = "custom";

export const OPENAI_API_MODEL_IDS = [
  "gpt-5.6",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
] as const;

export const OPENAI_SIGN_IN_MODEL_IDS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
] as const;

export const OPENAI_API_MODEL_REFS = OPENAI_API_MODEL_IDS.map(
  (id) => `${OPENAI_API_ROUTE_ID}/${id}`,
);

export const OPENAI_SIGN_IN_MODEL_REFS = OPENAI_SIGN_IN_MODEL_IDS.map(
  (id) => `${OPENAI_CODEX_ROUTE_ID}/${id}`,
);

export const ANTHROPIC_MODEL_IDS = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
] as const;
export const ANTHROPIC_MODEL_REFS = ANTHROPIC_MODEL_IDS.map((id) => `${ANTHROPIC_ROUTE_ID}/${id}`);

export const CHUTES_MODEL_IDS = [
  "google/gemma-4-31B-turbo-TEE",
  "Qwen/Qwen3-32B-TEE",
  "deepseek-ai/DeepSeek-V3.2-TEE",
  "zai-org/GLM-5.1-TEE",
  "moonshotai/Kimi-K2.6-TEE",
  "Qwen/Qwen3.6-27B-TEE",
  "Qwen/Qwen3.5-397B-A17B-TEE",
  "zai-org/GLM-5-TEE",
] as const;
export const CHUTES_MODEL_REFS = CHUTES_MODEL_IDS.map((id) => `${CHUTES_ROUTE_ID}/${id}`);

export const OLLAMA_MODEL_REFS: string[] = [];
export const LMSTUDIO_MODEL_REFS: string[] = [];
export const VLLM_MODEL_REFS: string[] = [];

export const MINIMAX_MODEL_IDS = [
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.5-highspeed",
] as const;
export const MINIMAX_API_MODEL_REFS = MINIMAX_MODEL_IDS.map(
  (id) => `${MINIMAX_API_ROUTE_ID}/${id}`,
);
export const MINIMAX_CN_MODEL_REFS = MINIMAX_MODEL_IDS.map((id) => `${MINIMAX_CN_ROUTE_ID}/${id}`);
export const MINIMAX_PORTAL_MODEL_REFS = ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"].map(
  (id) => `${MINIMAX_PORTAL_ROUTE_ID}/${id}`,
);

export const MOONSHOT_MODEL_IDS = ["kimi-k2.6", "kimi-k2.5"] as const;
export const MOONSHOT_MODEL_REFS = MOONSHOT_MODEL_IDS.map((id) => `${MOONSHOT_ROUTE_ID}/${id}`);
export const KIMI_CODING_MODEL_IDS = ["kimi-for-coding"] as const;
export const KIMI_CODING_MODEL_REFS = KIMI_CODING_MODEL_IDS.map(
  (id) => `${KIMI_CODING_ROUTE_ID}/${id}`,
);

export const GOOGLE_GEMINI_MODEL_IDS = [
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
] as const;
export const GOOGLE_API_MODEL_REFS = GOOGLE_GEMINI_MODEL_IDS.map(
  (id) => `${GOOGLE_API_ROUTE_ID}/${id}`,
);
export const GOOGLE_GEMINI_CLI_MODEL_REFS = GOOGLE_GEMINI_MODEL_IDS.map(
  (id) => `${GOOGLE_GEMINI_CLI_ROUTE_ID}/${id}`,
);

export const XAI_MODEL_IDS = ["grok-4.5", "grok-4.3", "grok-build-0.1"] as const;
export const XAI_MODEL_REFS = XAI_MODEL_IDS.map((id) => `${XAI_ROUTE_ID}/${id}`);

export const MISTRAL_MODEL_IDS = [
  "mistral-medium-3.5",
  "mistral-small-2603",
  "mistral-large-2512",
  "devstral-2512",
  "ministral-14b-2512",
  "ministral-8b-2512",
  "ministral-3b-2512",
] as const;
export const MISTRAL_MODEL_REFS = MISTRAL_MODEL_IDS.map((id) => `${MISTRAL_ROUTE_ID}/${id}`);

export const VOLCENGINE_MODEL_IDS = [
  "doubao-seed-2-0-pro-260215",
  "doubao-seed-2-0-lite-260215",
  "doubao-seed-2-0-mini-260215",
  "doubao-seed-2-0-code-preview-260215",
  "deepseek-v3-2-251201",
  "glm-4-7-251222",
] as const;
export const VOLCENGINE_MODEL_REFS = VOLCENGINE_MODEL_IDS.map(
  (id) => `${VOLCENGINE_ROUTE_ID}/${id}`,
);
export const VOLCENGINE_CODING_MODEL_IDS = [
  "ark-code-latest",
  "doubao-seed-2.0-code",
  "doubao-seed-2.0-pro",
  "doubao-seed-2.0-lite",
  "doubao-seed-code",
  "minimax-m2.5",
  "glm-4.7",
  "deepseek-v3.2",
  "kimi-k2.5",
] as const;
export const VOLCENGINE_CODING_MODEL_REFS = VOLCENGINE_CODING_MODEL_IDS.flatMap((id) => [
  `${VOLCENGINE_CODING_ROUTE_ID}/${id}`,
  `${VOLCENGINE_PLAN_ROUTE_ID}/${id}`,
]);
export const BYTEPLUS_MODEL_IDS = [
  "seed-2-0-pro-260328",
  "seed-2-0-lite-260228",
  "seed-2-0-mini-260215",
  "seed-2-0-code-preview-260328",
  "deepseek-v3-2-251201",
  "glm-4-7-251222",
] as const;
export const BYTEPLUS_MODEL_REFS = BYTEPLUS_MODEL_IDS.map((id) => `${BYTEPLUS_ROUTE_ID}/${id}`);
export const BYTEPLUS_CODING_MODEL_IDS = [
  "ark-code-latest",
  "dola-seed-2.0-pro",
  "dola-seed-2.0-lite",
  "dola-seed-2.0-code",
  "bytedance-seed-code",
  "glm-5.1",
  "glm-4.7",
  "kimi-k2.5",
  "gpt-oss-120b",
] as const;
export const BYTEPLUS_CODING_MODEL_REFS = BYTEPLUS_CODING_MODEL_IDS.flatMap((id) => [
  `${BYTEPLUS_CODING_ROUTE_ID}/${id}`,
  `${BYTEPLUS_PLAN_ROUTE_ID}/${id}`,
]);

export const OPENROUTER_MODEL_IDS = [
  "openrouter/owl-alpha",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "anthropic/claude-fable-5",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4.5",
  "google/gemini-3.5-flash",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite",
  "x-ai/grok-4.5",
  "x-ai/grok-4.3",
  "x-ai/grok-build-0.1",
  "mistralai/mistral-medium-3-5",
  "mistralai/mistral-small-2603",
  "mistralai/mistral-large-2512",
  "mistralai/devstral-2512",
  "qwen/qwen3.7-max",
  "qwen/qwen3.7-plus",
  "qwen/qwen3.6-flash",
  "z-ai/glm-5.2",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "minimax/minimax-m2.7",
  "moonshotai/kimi-k2.6",
] as const;
export const OPENROUTER_MODEL_REFS = OPENROUTER_MODEL_IDS.map(
  (id) => `${OPENROUTER_ROUTE_ID}/${id}`,
);

export const QWEN_API_MODEL_IDS = ["qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash"] as const;
export const QWEN_API_MODEL_REFS = QWEN_API_MODEL_IDS.map((id) => `${QWEN_API_ROUTE_ID}/${id}`);
export const QWEN_CODING_PLAN_MODEL_IDS = [
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "kimi-k2.7-code",
  "glm-5.2",
  "MiniMax-M2.5",
] as const;
export const QWEN_CODING_PLAN_MODEL_REFS = QWEN_CODING_PLAN_MODEL_IDS.map(
  (id) => `${QWEN_CODING_PLAN_ROUTE_ID}/${id}`,
);
export const ZAI_MODEL_IDS = [
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "glm-5-turbo",
  "glm-5v-turbo",
  "glm-4.7",
  "glm-4.7-flashx",
  "glm-4.7-flash",
] as const;
export const ZAI_MODEL_REFS = ZAI_MODEL_IDS.map((id) => `${ZAI_ROUTE_ID}/${id}`);
const ZAI_TEXT_MODEL_CAPABILITY: ModelCapabilityConfig = {
  tools: true,
  json: true,
  thinkingLevels: ["off", "low"],
  defaultThinkingLevel: "low",
  thinkingMode: "zai-binary",
  reasoningBudgetSupported: false,
};
const ZAI_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> = Object.fromEntries(
  ZAI_MODEL_REFS.map((ref) => [
    ref,
    ref.endsWith("/glm-5v-turbo")
      ? {
          ...ZAI_TEXT_MODEL_CAPABILITY,
          video: true,
        }
      : ZAI_TEXT_MODEL_CAPABILITY,
  ]),
);

export const QIANFAN_MODEL_IDS = [
  "ernie-5.1",
  "ernie-5.0",
  "ernie-5.0-thinking-latest",
  "ernie-5.0-thinking-preview",
  "ernie-x1.1-preview",
  "ernie-x1.1",
  "ernie-x1-turbo-32k",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v3.2-think",
  "deepseek-v3.2",
] as const;
export const QIANFAN_MODEL_REFS = QIANFAN_MODEL_IDS.map((id) => `${QIANFAN_ROUTE_ID}/${id}`);
const QIANFAN_ERNIE_FIXED_REASONING_REFS = new Set([
  "qianfan/ernie-5.1",
  "qianfan/ernie-5.0",
  "qianfan/ernie-5.0-thinking-latest",
  "qianfan/ernie-5.0-thinking-preview",
  "qianfan/ernie-x1.1-preview",
  "qianfan/ernie-x1.1",
  "qianfan/ernie-x1-turbo-32k",
]);
const QIANFAN_DEEPSEEK_THINKING_REFS = new Set([
  "qianfan/deepseek-v4-pro",
  "qianfan/deepseek-v4-flash",
  "qianfan/deepseek-v3.2-think",
  "qianfan/deepseek-v3.2",
]);
const QIANFAN_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  Object.fromEntries(
    QIANFAN_MODEL_REFS.map((ref) => [
      ref,
      {
        tools: true,
        json: true,
        ...(QIANFAN_ERNIE_FIXED_REASONING_REFS.has(ref)
          ? { fixedReasoning: true }
          : QIANFAN_DEEPSEEK_THINKING_REFS.has(ref)
            ? {
                thinkingLevels: [...BASE_THINKING_LEVELS],
                defaultThinkingLevel: "low",
                thinkingMode: "generic-reasoning",
                reasoningBudgetSupported: true,
              }
            : {}),
      } satisfies ModelCapabilityConfig,
    ]),
  );

export const GITHUB_COPILOT_MODEL_IDS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "gpt-4.1",
  "claude-fable-5",
  "claude-opus-4.8",
  "claude-sonnet-5",
  "claude-haiku-4.5",
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3-flash",
  "grok-build-0.1",
] as const;
export const GITHUB_COPILOT_MODEL_REFS = GITHUB_COPILOT_MODEL_IDS.map(
  (id) => `${GITHUB_COPILOT_ROUTE_ID}/${id}`,
);
export const COPILOT_PROXY_MODEL_IDS = [...GITHUB_COPILOT_MODEL_IDS] as const;
export const COPILOT_PROXY_MODEL_REFS = COPILOT_PROXY_MODEL_IDS.map(
  (id) => `${COPILOT_PROXY_ROUTE_ID}/${id}`,
);
export const GITHUB_COPILOT_DEFAULT_MODEL_REF = `${GITHUB_COPILOT_ROUTE_ID}/gpt-5.5`;
const COPILOT_OPENAI_REASONING_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
]);
const COPILOT_ANTHROPIC_ADAPTIVE_MODELS = new Set([
  "claude-fable-5",
  "claude-opus-4.8",
  "claude-sonnet-5",
]);
const COPILOT_ANTHROPIC_BUDGET_MODELS = new Set(["claude-haiku-4.5"]);
const COPILOT_GOOGLE_MODELS = new Set(["gemini-3.5-flash", "gemini-3.1-pro", "gemini-3-flash"]);

function buildCopilotCapabilityOverrides(
  refs: readonly string[],
): Record<string, ModelCapabilityConfig> {
  return Object.fromEntries(
    refs.map((ref) => {
      const modelId = ref.slice(ref.indexOf("/") + 1);
      const capability: ModelCapabilityConfig = {
        tools: true,
        json: true,
        ...(COPILOT_OPENAI_REASONING_MODELS.has(modelId)
          ? {
              thinkingLevels: [...BASE_THINKING_LEVELS],
              defaultThinkingLevel: "low",
              thinkingMode: "openai-reasoning-effort",
              reasoningBudgetSupported: false,
            }
          : COPILOT_ANTHROPIC_ADAPTIVE_MODELS.has(modelId)
            ? {
                thinkingLevels: [...BASE_THINKING_LEVELS],
                defaultThinkingLevel: "low",
                thinkingMode: "anthropic-adaptive",
                reasoningBudgetSupported: true,
              }
            : COPILOT_ANTHROPIC_BUDGET_MODELS.has(modelId)
              ? {
                  thinkingLevels: [...BASE_THINKING_LEVELS],
                  defaultThinkingLevel: "low",
                  thinkingMode: "anthropic-thinking-budget",
                  reasoningBudgetSupported: true,
                }
              : COPILOT_GOOGLE_MODELS.has(modelId)
                ? {
                    thinkingLevels: [...BASE_THINKING_LEVELS],
                    defaultThinkingLevel: "low",
                    thinkingMode: "google-thinking-budget",
                    reasoningBudgetSupported: true,
                  }
                : {}),
      };
      return [ref, capability] as const;
    }),
  );
}

const COPILOT_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> = {
  ...buildCopilotCapabilityOverrides(GITHUB_COPILOT_MODEL_REFS),
  ...buildCopilotCapabilityOverrides(COPILOT_PROXY_MODEL_REFS),
};

const VERCEL_AI_GATEWAY_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  buildVercelAiGatewayModelCapabilityOverrides(VERCEL_AI_GATEWAY_MODEL_REFS);

const OPENCODE_ZEN_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  buildOpencodeZenModelCapabilityOverrides(OPENCODE_ZEN_MODEL_REFS);

export const XIAOMI_MODEL_REFS = XIAOMI_MODEL_IDS.map((id) => `${XIAOMI_ROUTE_ID}/${id}`);
export const XIAOMI_DEFAULT_MODEL_REF = `${XIAOMI_ROUTE_ID}/mimo-v2.5-pro`;
const XIAOMI_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  buildXiaomiModelCapabilityOverrides(XIAOMI_ROUTE_ID);

export const SYNTHETIC_MODEL_REFS = SYNTHETIC_MODEL_IDS.map((id) => `${SYNTHETIC_ROUTE_ID}/${id}`);
export const SYNTHETIC_DEFAULT_MODEL_REF = `${SYNTHETIC_ROUTE_ID}/hf:MiniMaxAI/MiniMax-M2.5`;
const SYNTHETIC_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  buildSyntheticModelCapabilityOverrides(SYNTHETIC_ROUTE_ID);

const TOGETHER_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  buildTogetherModelCapabilityOverrides(TOGETHER_ROUTE_ID);

const HUGGINGFACE_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  buildHuggingfaceModelCapabilityOverrides(HUGGINGFACE_ROUTE_ID);

const VENICE_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  buildVeniceModelCapabilityOverrides(VENICE_ROUTE_ID);

const LITELLM_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  buildLitellmModelCapabilityOverrides(LITELLM_ROUTE_ID);
const CLOUDFLARE_AI_GATEWAY_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  buildCloudflareAiGatewayModelCapabilityOverrides(CLOUDFLARE_AI_GATEWAY_ROUTE_ID);
export const CUSTOM_PROVIDER_MODEL_REFS: string[] = [];

function parseModelRef(ref: string): { route: string; model: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return null;
  }
  return {
    route: ref.slice(0, slash).trim(),
    model: ref.slice(slash + 1).trim(),
  };
}

function inferThinkingTarget(route: string, model: string): { provider: string; model: string } {
  const lower = model.trim().toLowerCase();
  const nested = (prefix: string, provider: string) => {
    if (!lower.startsWith(`${prefix}/`)) {
      return null;
    }
    return { provider, model: model.slice(prefix.length + 1) };
  };
  return (
    nested("openai", OPENAI_API_ROUTE_ID) ??
    nested("anthropic", ANTHROPIC_ROUTE_ID) ??
    nested("google", GOOGLE_API_ROUTE_ID) ??
    nested("x-ai", XAI_ROUTE_ID) ??
    nested("xai", XAI_ROUTE_ID) ??
    nested("mistralai", MISTRAL_ROUTE_ID) ??
    nested("minimax", MINIMAX_API_ROUTE_ID) ??
    nested("qwen", QWEN_API_ROUTE_ID) ??
    nested("moonshotai", MOONSHOT_ROUTE_ID) ??
    nested("z-ai", ZAI_ROUTE_ID) ??
    nested("zai-org", ZAI_ROUTE_ID) ??
    nested("glm", ZAI_ROUTE_ID) ?? {
      provider:
        lower.includes("claude-") || lower.includes("claude_")
          ? ANTHROPIC_ROUTE_ID
          : lower.includes("gemini-")
            ? GOOGLE_API_ROUTE_ID
            : lower.includes("qwen")
              ? QWEN_API_ROUTE_ID
              : lower.includes("kimi")
                ? MOONSHOT_ROUTE_ID
                : lower.includes("glm-")
                  ? ZAI_ROUTE_ID
                  : route,
      model,
    }
  );
}

export function resolveProviderRouteModelCapability(params: {
  route: string;
  model: string;
  reasoning?: boolean;
}): ModelCapabilityConfig | undefined {
  const target = inferThinkingTarget(params.route, params.model);
  const thinking = resolveModelThinkingCapability({
    provider: target.provider,
    model: target.model,
    reasoning: params.reasoning,
  });
  if (!thinking) {
    return undefined;
  }
  return {
    thinkingLevels: thinking.thinkingLevels,
    defaultThinkingLevel: thinking.defaultThinkingLevel,
    thinkingMode: thinking.thinkingMode,
    reasoningBudgetSupported: thinking.reasoningBudgetSupported,
  };
}

function resolveManifestModelCapability(ref: string): ModelCapabilityConfig | undefined {
  const parsed = parseModelRef(ref);
  if (!parsed) {
    return undefined;
  }
  return resolveProviderRouteModelCapability({
    route: parsed.route,
    model: parsed.model,
  });
}

function buildProviderModelCapabilities(
  refs: readonly string[],
): Record<string, ModelCapabilityConfig> {
  return Object.fromEntries(
    refs.map((ref) => [ref.toLowerCase(), resolveManifestModelCapability(ref) ?? {}] as const),
  );
}

function buildProviderModelCapabilitiesWithOverrides(
  refs: readonly string[],
  overrides: Record<string, ModelCapabilityConfig>,
): Record<string, ModelCapabilityConfig> {
  const base = buildProviderModelCapabilities(refs);
  for (const [ref, capability] of Object.entries(overrides)) {
    base[ref.toLowerCase()] = {
      ...base[ref.toLowerCase()],
      ...capability,
    };
  }
  return base;
}

const ANTHROPIC_THINKING_LEVELS = [...BASE_THINKING_LEVELS];
const ANTHROPIC_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> = {
  "anthropic/claude-fable-5": {
    thinkingLevels: ANTHROPIC_THINKING_LEVELS,
    defaultThinkingLevel: "low",
    thinkingMode: "anthropic-adaptive",
    reasoningBudgetSupported: false,
  },
  "anthropic/claude-opus-4-8": {
    thinkingLevels: ANTHROPIC_THINKING_LEVELS,
    defaultThinkingLevel: "low",
    thinkingMode: "anthropic-adaptive",
    reasoningBudgetSupported: false,
  },
  "anthropic/claude-sonnet-5": {
    thinkingLevels: ANTHROPIC_THINKING_LEVELS,
    defaultThinkingLevel: "low",
    thinkingMode: "anthropic-adaptive",
    reasoningBudgetSupported: false,
  },
  "anthropic/claude-haiku-4-5": {
    thinkingLevels: ANTHROPIC_THINKING_LEVELS,
    defaultThinkingLevel: "low",
    thinkingMode: "anthropic-thinking-budget",
    reasoningBudgetSupported: true,
  },
};

const CHUTES_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> = Object.fromEntries(
  CHUTES_MODEL_IDS.map((id) => [
    `${CHUTES_ROUTE_ID}/${id}`,
    {
      tools: true,
      json: true,
      ...resolveProviderRouteModelCapability({
        route: CHUTES_ROUTE_ID,
        model: id,
        reasoning: true,
      }),
      ...(id === "moonshotai/Kimi-K2.6-TEE" ? { video: true } : {}),
    } satisfies ModelCapabilityConfig,
  ]),
);

const MINIMAX_THINKING_LEVELS = [...BASE_THINKING_LEVELS];
const MINIMAX_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  Object.fromEntries(
    [...MINIMAX_API_MODEL_REFS, ...MINIMAX_CN_MODEL_REFS, ...MINIMAX_PORTAL_MODEL_REFS].map(
      (ref) => [
        ref,
        {
          tools: true,
          thinkingLevels: MINIMAX_THINKING_LEVELS,
          defaultThinkingLevel: "off",
          thinkingMode: "anthropic-thinking-budget",
          reasoningBudgetSupported: false,
        } satisfies ModelCapabilityConfig,
      ],
    ),
  );

const MOONSHOT_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  Object.fromEntries(
    [...MOONSHOT_MODEL_REFS, ...KIMI_CODING_MODEL_REFS].map((ref) => [
      ref,
      {
        tools: true,
        ...(ref === `${MOONSHOT_ROUTE_ID}/kimi-k2.6` ? { video: true } : {}),
        thinkingLevels: [...BASE_THINKING_LEVELS],
        defaultThinkingLevel: "low",
        thinkingMode: "moonshot-thinking",
        reasoningBudgetSupported: false,
      } satisfies ModelCapabilityConfig,
    ]),
  );

const GOOGLE_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> = Object.fromEntries(
  [...GOOGLE_API_MODEL_REFS, ...GOOGLE_GEMINI_CLI_MODEL_REFS].map((ref) => [
    ref,
    {
      tools: true,
      json: true,
      audio: true,
      video: true,
      thinkingLevels: [...BASE_THINKING_LEVELS],
      defaultThinkingLevel: "low",
      thinkingMode: "google-thinking-budget",
      reasoningBudgetSupported: true,
    } satisfies ModelCapabilityConfig,
  ]),
);

const XAI_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> = {
  "xai/grok-4.5": {
    tools: true,
    json: true,
    thinkingLevels: ["off", "low", "medium", "high"],
    defaultThinkingLevel: "low",
    thinkingMode: "xai-reasoning-effort",
    reasoningBudgetSupported: false,
  },
  "xai/grok-4.3": {
    tools: true,
    json: true,
    thinkingLevels: ["off", "low", "medium", "high"],
    defaultThinkingLevel: "low",
    thinkingMode: "xai-reasoning-effort",
    reasoningBudgetSupported: false,
  },
  "xai/grok-build-0.1": {
    tools: true,
    json: true,
  },
};

const MISTRAL_ADJUSTABLE_THINKING_LEVELS = ["off", "high"] as const;
const MISTRAL_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  Object.fromEntries(
    MISTRAL_MODEL_REFS.map((ref) => [
      ref,
      {
        tools: true,
        json: true,
        ...(ref === "mistral/mistral-medium-3.5" || ref === "mistral/mistral-small-2603"
          ? {
              thinkingLevels: [...MISTRAL_ADJUSTABLE_THINKING_LEVELS],
              defaultThinkingLevel: "high",
              thinkingMode: "mistral-reasoning-effort",
              reasoningBudgetSupported: false,
            }
          : {}),
      } satisfies ModelCapabilityConfig,
    ]),
  );

const VOLCENGINE_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
const VOLCENGINE_REASONING_REFS = new Set([
  "volcengine/doubao-seed-2-0-pro-260215",
  "volcengine/doubao-seed-2-0-lite-260215",
  "volcengine/doubao-seed-2-0-mini-260215",
  "volcengine/doubao-seed-2-0-code-preview-260215",
  "volcengine-coding/doubao-seed-2.0-code",
  "volcengine-plan/doubao-seed-2.0-code",
  "volcengine-coding/doubao-seed-2.0-pro",
  "volcengine-plan/doubao-seed-2.0-pro",
  "volcengine-coding/doubao-seed-2.0-lite",
  "volcengine-plan/doubao-seed-2.0-lite",
  "volcengine-coding/doubao-seed-code",
  "volcengine-plan/doubao-seed-code",
]);
const VOLCENGINE_VIDEO_REFS = new Set([
  "volcengine/doubao-seed-2-0-pro-260215",
  "volcengine/doubao-seed-2-0-lite-260215",
  "volcengine/doubao-seed-2-0-mini-260215",
  "volcengine/doubao-seed-2-0-code-preview-260215",
  "volcengine-coding/doubao-seed-2.0-code",
  "volcengine-plan/doubao-seed-2.0-code",
  "volcengine-coding/doubao-seed-2.0-pro",
  "volcengine-plan/doubao-seed-2.0-pro",
  "volcengine-coding/doubao-seed-2.0-lite",
  "volcengine-plan/doubao-seed-2.0-lite",
  "volcengine-coding/doubao-seed-code",
  "volcengine-plan/doubao-seed-code",
]);
const VOLCENGINE_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  Object.fromEntries(
    [...VOLCENGINE_MODEL_REFS, ...VOLCENGINE_CODING_MODEL_REFS].map((ref) => [
      ref,
      {
        tools: true,
        json: true,
        ...(VOLCENGINE_REASONING_REFS.has(ref)
          ? {
              thinkingLevels: [...VOLCENGINE_THINKING_LEVELS],
              defaultThinkingLevel: "medium",
              thinkingMode: "volcengine-reasoning-effort",
              reasoningBudgetSupported: false,
            }
          : {}),
        ...(VOLCENGINE_VIDEO_REFS.has(ref) ? { video: true } : {}),
      } satisfies ModelCapabilityConfig,
    ]),
  );

const BYTEPLUS_THINKING_LEVELS = ["off", "high"] as const;
const BYTEPLUS_REASONING_REFS = new Set([
  "byteplus/seed-2-0-pro-260328",
  "byteplus/seed-2-0-lite-260228",
  "byteplus/seed-2-0-mini-260215",
  "byteplus/seed-2-0-code-preview-260328",
  "byteplus-coding/dola-seed-2.0-pro",
  "byteplus-plan/dola-seed-2.0-pro",
  "byteplus-coding/dola-seed-2.0-lite",
  "byteplus-plan/dola-seed-2.0-lite",
  "byteplus-coding/dola-seed-2.0-code",
  "byteplus-plan/dola-seed-2.0-code",
  "byteplus-coding/bytedance-seed-code",
  "byteplus-plan/bytedance-seed-code",
]);
const BYTEPLUS_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  Object.fromEntries(
    [...BYTEPLUS_MODEL_REFS, ...BYTEPLUS_CODING_MODEL_REFS].map((ref) => [
      ref,
      {
        tools: true,
        json: true,
        ...(BYTEPLUS_REASONING_REFS.has(ref)
          ? {
              thinkingLevels: [...BYTEPLUS_THINKING_LEVELS],
              defaultThinkingLevel: "high",
              thinkingMode: "byteplus-thinking-type",
              reasoningBudgetSupported: false,
            }
          : {}),
      } satisfies ModelCapabilityConfig,
    ]),
  );

const OPENROUTER_AUDIO_MODEL_REFS = new Set([
  "openrouter/google/gemini-3.5-flash",
  "openrouter/google/gemini-3.1-pro-preview",
  "openrouter/google/gemini-3-flash-preview",
  "openrouter/google/gemini-3.1-flash-lite",
]);
const OPENROUTER_VIDEO_MODEL_REFS = new Set([
  "openrouter/google/gemini-3.5-flash",
  "openrouter/google/gemini-3.1-pro-preview",
  "openrouter/google/gemini-3-flash-preview",
  "openrouter/google/gemini-3.1-flash-lite",
  "openrouter/qwen/qwen3.7-max",
  "openrouter/qwen/qwen3.7-plus",
  "openrouter/qwen/qwen3.6-flash",
]);
const OPENROUTER_MISTRAL_REASONING_MODEL_REFS = new Set([
  "openrouter/mistralai/mistral-medium-3-5",
  "openrouter/mistralai/mistral-small-2603",
]);
const OPENROUTER_MINIMAX_REASONING_MODEL_REFS = new Set(["openrouter/minimax/minimax-m2.7"]);
const OPENROUTER_GENERIC_REASONING_MODEL_REFS = new Set([
  "openrouter/deepseek/deepseek-v4-pro",
  "openrouter/deepseek/deepseek-v4-flash",
]);
const OPENROUTER_OPENAI_REASONING_MODEL_REFS = new Set([
  "openrouter/openai/gpt-5.6-sol",
  "openrouter/openai/gpt-5.6-terra",
  "openrouter/openai/gpt-5.6-luna",
  "openrouter/openai/gpt-5.5",
  "openrouter/openai/gpt-5.4",
  "openrouter/openai/gpt-5.4-mini",
  "openrouter/openai/gpt-5.4-nano",
]);
const OPENROUTER_XAI_REASONING_MODEL_REFS = new Set([
  "openrouter/x-ai/grok-4.5",
  "openrouter/x-ai/grok-4.3",
]);
const OPENROUTER_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> =
  Object.fromEntries(
    OPENROUTER_MODEL_REFS.map((ref) => [
      ref,
      {
        tools: true,
        json: true,
        ...(OPENROUTER_AUDIO_MODEL_REFS.has(ref) ? { audio: true } : {}),
        ...(OPENROUTER_VIDEO_MODEL_REFS.has(ref) ? { video: true } : {}),
        ...(OPENROUTER_MISTRAL_REASONING_MODEL_REFS.has(ref)
          ? {
              thinkingLevels: [...MISTRAL_ADJUSTABLE_THINKING_LEVELS],
              defaultThinkingLevel: "high",
              thinkingMode: "mistral-reasoning-effort",
              reasoningBudgetSupported: false,
            }
          : {}),
        ...(OPENROUTER_MINIMAX_REASONING_MODEL_REFS.has(ref)
          ? {
              thinkingLevels: [...MINIMAX_THINKING_LEVELS],
              defaultThinkingLevel: "off",
              thinkingMode: "anthropic-thinking-budget",
              reasoningBudgetSupported: false,
            }
          : {}),
        ...(OPENROUTER_GENERIC_REASONING_MODEL_REFS.has(ref)
          ? {
              thinkingLevels: [...BASE_THINKING_LEVELS],
              defaultThinkingLevel: "low",
              thinkingMode: "generic-reasoning",
              reasoningBudgetSupported: false,
            }
          : {}),
        ...(OPENROUTER_OPENAI_REASONING_MODEL_REFS.has(ref)
          ? {
              thinkingLevels: [...XHIGH_THINKING_LEVELS],
              defaultThinkingLevel: "low",
              thinkingMode: "openai-reasoning-effort",
              reasoningBudgetSupported: false,
            }
          : {}),
        ...(OPENROUTER_XAI_REASONING_MODEL_REFS.has(ref)
          ? {
              thinkingLevels: ["off", "low", "medium", "high"],
              defaultThinkingLevel: "low",
              thinkingMode: "xai-reasoning-effort",
              reasoningBudgetSupported: false,
            }
          : {}),
      } satisfies ModelCapabilityConfig,
    ]),
  );

const QWEN_NON_THINKING_MODEL_REFS = new Set([
  "qwen-coding-plan/kimi-k2.7-code",
  "qwen-coding-plan/glm-5.2",
  "qwen-coding-plan/MiniMax-M2.5",
]);
const QWEN_MODEL_CAPABILITY_OVERRIDES: Record<string, ModelCapabilityConfig> = Object.fromEntries(
  [...QWEN_API_MODEL_REFS, ...QWEN_CODING_PLAN_MODEL_REFS].map((ref) => [
    ref,
    {
      tools: true,
      json: true,
      ...(!QWEN_NON_THINKING_MODEL_REFS.has(ref)
        ? {
            thinkingLevels: [...BASE_THINKING_LEVELS],
            defaultThinkingLevel: "low",
            thinkingMode: "qwen-thinking",
            reasoningBudgetSupported: true,
          }
        : {}),
    } satisfies ModelCapabilityConfig,
  ]),
);

export const OPENAI_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: OPENAI_PROVIDER_BRAND_ID,
  label: "OpenAI",
  priority: 1,
  hint: "OpenAI sign-in + API key",
  methods: [
    {
      id: "openai-codex",
      route: OPENAI_CODEX_ROUTE_ID,
      kind: "oauth",
      label: "Sign in",
      hint: "Open the OpenAI sign-in URL, finish login in the browser, then Fased completes the OAuth flow.",
    },
    {
      id: "openai-api-key",
      route: OPENAI_API_ROUTE_ID,
      kind: "api-key",
      label: "API key",
    },
  ],
  models: {
    recommended: [...OPENAI_API_MODEL_REFS, ...OPENAI_SIGN_IN_MODEL_REFS],
    routeRules: {
      [OPENAI_API_ROUTE_ID]: [`${OPENAI_API_ROUTE_ID}/*`],
      [OPENAI_CODEX_ROUTE_ID]: [`${OPENAI_CODEX_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilities([
    ...OPENAI_API_MODEL_REFS,
    ...OPENAI_SIGN_IN_MODEL_REFS,
  ]),
};

export const ANTHROPIC_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: ANTHROPIC_PROVIDER_BRAND_ID,
  label: "Anthropic",
  priority: 2,
  hint: "Claude Code OAuth + setup-token + API key",
  methods: [
    {
      id: "anthropic-oauth",
      route: ANTHROPIC_ROUTE_ID,
      kind: "oauth",
      label: "Sign in (Claude Code)",
      hint: "Claude or Console account; Pro, Max, Team, Enterprise, or Console access",
      buttonLabel: "Sign in",
    },
    {
      id: "token",
      route: ANTHROPIC_ROUTE_ID,
      kind: "token",
      label: "Token (setup-token)",
      hint: "run `claude setup-token` elsewhere, then paste the token here",
      buttonLabel: "Paste token",
    },
    {
      id: "apiKey",
      route: ANTHROPIC_ROUTE_ID,
      kind: "api-key",
      label: "API key",
    },
  ],
  models: {
    recommended: [...ANTHROPIC_MODEL_REFS],
    routeRules: {
      [ANTHROPIC_ROUTE_ID]: [`${ANTHROPIC_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    ANTHROPIC_MODEL_REFS,
    ANTHROPIC_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const CHUTES_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: CHUTES_PROVIDER_BRAND_ID,
  label: "Chutes",
  priority: 3,
  hint: "Sign in + API key",
  methods: [
    {
      id: "chutes",
      route: CHUTES_ROUTE_ID,
      kind: "oauth",
      label: "Sign in",
      hint: "Requires a Chutes OAuth app client id. Enter the cid, then Fased generates the Chutes sign-in URL.",
      buttonLabel: "Sign in",
    },
    {
      id: "chutes-api-key",
      route: CHUTES_ROUTE_ID,
      kind: "api-key",
      label: "API key",
    },
  ],
  models: {
    recommended: [...CHUTES_MODEL_REFS],
    routeRules: {
      [CHUTES_ROUTE_ID]: [`${CHUTES_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    CHUTES_MODEL_REFS,
    CHUTES_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const OLLAMA_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: OLLAMA_PROVIDER_BRAND_ID,
  label: "Ollama",
  priority: 4,
  hint: "Local, cloud, or hybrid Ollama through the native API",
  modelProviderIds: [OLLAMA_ROUTE_ID],
  methods: [
    {
      id: "ollama",
      route: OLLAMA_ROUTE_ID,
      kind: "manual",
      label: "Ollama native URL + model",
      hint: "Use the native Ollama base URL, for example http://127.0.0.1:11434. Do not use /v1.",
      buttonLabel: "Configure",
    },
  ],
  models: {
    recommended: OLLAMA_MODEL_REFS,
    dynamic: true,
    routeRules: {
      [OLLAMA_ROUTE_ID]: [`${OLLAMA_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilities(OLLAMA_MODEL_REFS),
};

export const LMSTUDIO_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: LMSTUDIO_PROVIDER_BRAND_ID,
  label: "LM Studio",
  priority: 4,
  hint: "Local LM Studio server on localhost:1234",
  modelProviderIds: [LMSTUDIO_ROUTE_ID],
  methods: [
    {
      id: "lmstudio",
      route: LMSTUDIO_ROUTE_ID,
      kind: "manual",
      label: "LM Studio URL + model",
      hint: "Use http://127.0.0.1:1234/v1, optional API token, and a model key from LM Studio.",
      buttonLabel: "Configure",
    },
  ],
  models: {
    recommended: LMSTUDIO_MODEL_REFS,
    dynamic: true,
    routeRules: {
      [LMSTUDIO_ROUTE_ID]: [`${LMSTUDIO_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilities(LMSTUDIO_MODEL_REFS),
};

export const VLLM_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: VLLM_PROVIDER_BRAND_ID,
  label: "vLLM-compatible",
  priority: 4,
  hint: "OpenAI-compatible local server: vLLM, SGLang, TGI, LocalAI, or FastChat",
  modelProviderIds: [VLLM_ROUTE_ID],
  methods: [
    {
      id: "vllm",
      route: VLLM_ROUTE_ID,
      kind: "manual",
      label: "vLLM-compatible URL + model",
      hint: "Enter the /v1 base URL, API key or local placeholder, and served model ID for vLLM, SGLang, TGI, LocalAI, or FastChat.",
      buttonLabel: "Configure",
    },
  ],
  models: {
    recommended: VLLM_MODEL_REFS,
    dynamic: true,
    routeRules: {
      [VLLM_ROUTE_ID]: [`${VLLM_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilities(VLLM_MODEL_REFS),
};

export const MINIMAX_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: MINIMAX_PROVIDER_BRAND_ID,
  label: "MiniMax",
  priority: 5,
  hint: "MiniMax OAuth + API key",
  modelProviderIds: [MINIMAX_API_ROUTE_ID, MINIMAX_CN_ROUTE_ID, MINIMAX_PORTAL_ROUTE_ID],
  methods: [
    {
      id: "minimax-portal",
      route: MINIMAX_PORTAL_ROUTE_ID,
      kind: "oauth",
      label: "Sign in",
      hint: "Global or CN endpoint; uses MiniMax portal sign-in",
      setupRequirement:
        "Requires MiniMax portal/coding-plan access. Choose Global or CN, then open the approval URL and approve before the code expires.",
      buttonLabel: "Sign in",
    },
    {
      id: "minimax-api",
      route: MINIMAX_API_ROUTE_ID,
      kind: "api-key",
      label: "API key",
    },
    {
      id: "minimax-api-key-cn",
      route: MINIMAX_CN_ROUTE_ID,
      kind: "api-key",
      label: "API key (CN)",
      hint: "China endpoint (api.minimaxi.com)",
    },
    {
      id: "minimax-api-lightning",
      route: MINIMAX_API_ROUTE_ID,
      configProviderId: "minimax-lightning",
      statusRoute: MINIMAX_API_ROUTE_ID,
      kind: "api-key",
      label: "Highspeed API key",
      hint: "Fast M2.7 tier",
    },
  ],
  models: {
    recommended: [
      ...MINIMAX_API_MODEL_REFS,
      ...MINIMAX_CN_MODEL_REFS,
      ...MINIMAX_PORTAL_MODEL_REFS,
    ],
    routeRules: {
      [MINIMAX_API_ROUTE_ID]: [`${MINIMAX_API_ROUTE_ID}/*`],
      [MINIMAX_CN_ROUTE_ID]: [`${MINIMAX_CN_ROUTE_ID}/*`],
      [MINIMAX_PORTAL_ROUTE_ID]: [`${MINIMAX_PORTAL_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    [...MINIMAX_API_MODEL_REFS, ...MINIMAX_CN_MODEL_REFS, ...MINIMAX_PORTAL_MODEL_REFS],
    MINIMAX_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const MOONSHOT_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: MOONSHOT_PROVIDER_BRAND_ID,
  label: "Moonshot AI",
  priority: 6,
  hint: "Kimi API + Kimi Code",
  modelProviderIds: [MOONSHOT_ROUTE_ID, KIMI_CODING_ROUTE_ID],
  methods: [
    {
      id: "moonshot-api-key",
      route: MOONSHOT_ROUTE_ID,
      kind: "api-key",
      label: "Kimi API key (.ai)",
      hint: "Kimi Open Platform endpoint (api.moonshot.ai)",
    },
    {
      id: "moonshot-api-key-cn",
      route: MOONSHOT_ROUTE_ID,
      configProviderId: "moonshot-cn",
      statusRoute: MOONSHOT_ROUTE_ID,
      kind: "api-key",
      label: "Kimi API key (.cn)",
      hint: "China endpoint (api.moonshot.cn)",
    },
    {
      id: "kimi-code-api-key",
      route: KIMI_CODING_ROUTE_ID,
      kind: "api-key",
      label: "Kimi Code API key (subscription)",
      hint: "Kimi Code membership endpoint (api.kimi.com/coding)",
    },
  ],
  models: {
    recommended: [...MOONSHOT_MODEL_REFS, ...KIMI_CODING_MODEL_REFS],
    routeRules: {
      [MOONSHOT_ROUTE_ID]: [`${MOONSHOT_ROUTE_ID}/*`],
      [KIMI_CODING_ROUTE_ID]: [`${KIMI_CODING_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    [...MOONSHOT_MODEL_REFS, ...KIMI_CODING_MODEL_REFS],
    MOONSHOT_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const GOOGLE_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: GOOGLE_PROVIDER_BRAND_ID,
  label: "Google",
  priority: 7,
  hint: "Gemini API key + OAuth",
  routeAliases: ["gemini"],
  modelProviderIds: [GOOGLE_API_ROUTE_ID, "gemini", GOOGLE_GEMINI_CLI_ROUTE_ID],
  methods: [
    {
      id: "gemini-api-key",
      route: GOOGLE_API_ROUTE_ID,
      kind: "api-key",
      label: "Gemini API key",
    },
    {
      id: "google-gemini-cli",
      route: GOOGLE_GEMINI_CLI_ROUTE_ID,
      kind: "oauth",
      label: "Sign in (Gemini CLI)",
      hint: "Unofficial flow; review account-risk warning before use",
      setupRequirement:
        "Requires gemini-cli installed on the gateway machine, or GEMINI_CLI_OAUTH_CLIENT_ID set before sign-in.",
    },
  ],
  models: {
    recommended: [...GOOGLE_API_MODEL_REFS, ...GOOGLE_GEMINI_CLI_MODEL_REFS],
    routeRules: {
      [GOOGLE_API_ROUTE_ID]: [`${GOOGLE_API_ROUTE_ID}/*`, "gemini/*"],
      [GOOGLE_GEMINI_CLI_ROUTE_ID]: [`${GOOGLE_GEMINI_CLI_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    [...GOOGLE_API_MODEL_REFS, ...GOOGLE_GEMINI_CLI_MODEL_REFS],
    GOOGLE_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const XAI_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: XAI_PROVIDER_BRAND_ID,
  label: "xAI (Grok)",
  priority: 8,
  hint: "Grok API key or xAI account sign-in",
  methods: [
    {
      id: "xai-oauth",
      route: XAI_ROUTE_ID,
      kind: "oauth",
      label: "xAI sign-in",
      hint: "Browser sign-in for eligible xAI/Grok accounts",
      buttonLabel: "Sign in",
    },
    {
      id: "xai-device-code",
      route: XAI_ROUTE_ID,
      kind: "device",
      label: "xAI device code",
      hint: "Remote-friendly sign-in for eligible xAI/Grok accounts",
      buttonLabel: "Device code",
    },
    {
      id: "xai-api-key",
      route: XAI_ROUTE_ID,
      kind: "api-key",
      label: "xAI API key",
    },
  ],
  models: {
    recommended: [...XAI_MODEL_REFS],
    routeRules: {
      [XAI_ROUTE_ID]: [`${XAI_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    XAI_MODEL_REFS,
    XAI_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const MISTRAL_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: MISTRAL_PROVIDER_BRAND_ID,
  label: "Mistral AI",
  priority: 9,
  hint: "Mistral API key",
  methods: [
    {
      id: "mistral-api-key",
      route: MISTRAL_ROUTE_ID,
      kind: "api-key",
      label: "Mistral API key",
    },
  ],
  models: {
    recommended: [...MISTRAL_MODEL_REFS],
    routeRules: {
      [MISTRAL_ROUTE_ID]: [`${MISTRAL_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    MISTRAL_MODEL_REFS,
    MISTRAL_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const VOLCENGINE_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: VOLCENGINE_PROVIDER_BRAND_ID,
  label: "Volcano Engine",
  priority: 10,
  hint: "Ark API key + Coding Plan",
  modelProviderIds: [VOLCENGINE_ROUTE_ID, VOLCENGINE_CODING_ROUTE_ID, VOLCENGINE_PLAN_ROUTE_ID],
  methods: [
    {
      id: "volcengine-api-key",
      route: VOLCENGINE_ROUTE_ID,
      kind: "api-key",
      label: "Volcano Engine API key",
    },
  ],
  models: {
    recommended: [...VOLCENGINE_MODEL_REFS, ...VOLCENGINE_CODING_MODEL_REFS],
    routeRules: {
      [VOLCENGINE_ROUTE_ID]: [`${VOLCENGINE_ROUTE_ID}/*`],
      [VOLCENGINE_CODING_ROUTE_ID]: [`${VOLCENGINE_CODING_ROUTE_ID}/*`],
      [VOLCENGINE_PLAN_ROUTE_ID]: [`${VOLCENGINE_PLAN_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    [...VOLCENGINE_MODEL_REFS, ...VOLCENGINE_CODING_MODEL_REFS],
    VOLCENGINE_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const BYTEPLUS_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: BYTEPLUS_PROVIDER_BRAND_ID,
  label: "BytePlus",
  priority: 11,
  hint: "ModelArk API key + Coding Plan",
  modelProviderIds: [BYTEPLUS_ROUTE_ID, BYTEPLUS_CODING_ROUTE_ID, BYTEPLUS_PLAN_ROUTE_ID],
  methods: [
    {
      id: "byteplus-api-key",
      route: BYTEPLUS_ROUTE_ID,
      kind: "api-key",
      label: "BytePlus API key",
    },
  ],
  models: {
    recommended: [...BYTEPLUS_MODEL_REFS, ...BYTEPLUS_CODING_MODEL_REFS],
    routeRules: {
      [BYTEPLUS_ROUTE_ID]: [`${BYTEPLUS_ROUTE_ID}/*`],
      [BYTEPLUS_CODING_ROUTE_ID]: [`${BYTEPLUS_CODING_ROUTE_ID}/*`],
      [BYTEPLUS_PLAN_ROUTE_ID]: [`${BYTEPLUS_PLAN_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    [...BYTEPLUS_MODEL_REFS, ...BYTEPLUS_CODING_MODEL_REFS],
    BYTEPLUS_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const OPENROUTER_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: OPENROUTER_PROVIDER_BRAND_ID,
  label: "OpenRouter",
  priority: 12,
  hint: "API key",
  methods: [
    {
      id: "openrouter-api-key",
      route: OPENROUTER_ROUTE_ID,
      kind: "api-key",
      label: "OpenRouter API key",
    },
  ],
  models: {
    recommended: [...OPENROUTER_MODEL_REFS],
    dynamic: true,
    routeRules: {
      [OPENROUTER_ROUTE_ID]: [`${OPENROUTER_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    OPENROUTER_MODEL_REFS,
    OPENROUTER_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const QWEN_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: QWEN_PROVIDER_BRAND_ID,
  label: "Qwen",
  priority: 14,
  hint: "Coding Plan + DashScope API key",
  modelProviderIds: [QWEN_CODING_PLAN_ROUTE_ID, QWEN_API_ROUTE_ID],
  methods: [
    {
      id: "qwen-coding-plan-api-key",
      route: QWEN_CODING_PLAN_ROUTE_ID,
      kind: "api-key",
      label: "Coding Plan API key",
      hint: "Alibaba Cloud Coding Plan endpoint (coding.dashscope.aliyuncs.com)",
    },
    {
      id: "qwen-api-key",
      route: QWEN_API_ROUTE_ID,
      kind: "api-key",
      label: "DashScope API key",
      hint: "DashScope OpenAI-compatible endpoint (dashscope.aliyuncs.com)",
    },
  ],
  models: {
    recommended: [...QWEN_CODING_PLAN_MODEL_REFS, ...QWEN_API_MODEL_REFS],
    routeRules: {
      [QWEN_CODING_PLAN_ROUTE_ID]: [`${QWEN_CODING_PLAN_ROUTE_ID}/*`],
      [QWEN_API_ROUTE_ID]: [`${QWEN_API_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    [...QWEN_CODING_PLAN_MODEL_REFS, ...QWEN_API_MODEL_REFS],
    QWEN_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const ZAI_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: ZAI_PROVIDER_BRAND_ID,
  label: "Z.AI",
  priority: 15,
  hint: "GLM Coding Plan / Global / CN",
  modelProviderIds: [ZAI_ROUTE_ID],
  methods: [
    {
      id: "zai-coding-global",
      route: ZAI_ROUTE_ID,
      configProviderId: "zai-coding-global",
      statusRoute: ZAI_ROUTE_ID,
      kind: "api-key",
      label: "Coding-Plan-Global",
      hint: "GLM Coding Plan Global (api.z.ai)",
    },
    {
      id: "zai-coding-cn",
      route: ZAI_ROUTE_ID,
      configProviderId: "zai-coding-cn",
      statusRoute: ZAI_ROUTE_ID,
      kind: "api-key",
      label: "Coding-Plan-CN",
      hint: "GLM Coding Plan CN (open.bigmodel.cn)",
    },
    {
      id: "zai-global",
      route: ZAI_ROUTE_ID,
      configProviderId: ZAI_ROUTE_ID,
      kind: "api-key",
      label: "Global",
      hint: "Z.AI Global (api.z.ai)",
    },
    {
      id: "zai-cn",
      route: ZAI_ROUTE_ID,
      configProviderId: "zai-cn",
      statusRoute: ZAI_ROUTE_ID,
      kind: "api-key",
      label: "CN",
      hint: "Z.AI CN (open.bigmodel.cn)",
    },
  ],
  models: {
    recommended: [...ZAI_MODEL_REFS],
    routeRules: {
      [ZAI_ROUTE_ID]: [`${ZAI_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    ZAI_MODEL_REFS,
    ZAI_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const QIANFAN_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: QIANFAN_PROVIDER_BRAND_ID,
  label: "Qianfan",
  priority: 16,
  hint: "Baidu Qianfan API key",
  methods: [
    {
      id: "qianfan-api-key",
      route: QIANFAN_ROUTE_ID,
      kind: "api-key",
      label: "Qianfan API key",
    },
  ],
  models: {
    recommended: [...QIANFAN_MODEL_REFS],
    routeRules: {
      [QIANFAN_ROUTE_ID]: [`${QIANFAN_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    QIANFAN_MODEL_REFS,
    QIANFAN_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const COPILOT_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: COPILOT_PROVIDER_BRAND_ID,
  label: "Copilot",
  priority: 17,
  hint: "GitHub device login + local proxy",
  modelProviderIds: [GITHUB_COPILOT_ROUTE_ID, COPILOT_PROXY_ROUTE_ID],
  methods: [
    {
      id: "github-copilot",
      route: GITHUB_COPILOT_ROUTE_ID,
      kind: "device",
      label: "GitHub sign in",
      hint: "GitHub OAuth device flow; requires an active Copilot subscription",
      buttonLabel: "Sign in",
    },
    {
      id: "copilot-proxy",
      route: COPILOT_PROXY_ROUTE_ID,
      kind: "device",
      label: "Proxy sign in",
      hint: "Local VS Code Copilot Proxy bridge",
      buttonLabel: "Configure",
    },
  ],
  models: {
    recommended: [...GITHUB_COPILOT_MODEL_REFS, ...COPILOT_PROXY_MODEL_REFS],
    dynamic: true,
    routeRules: {
      [GITHUB_COPILOT_ROUTE_ID]: [`${GITHUB_COPILOT_ROUTE_ID}/*`],
      [COPILOT_PROXY_ROUTE_ID]: [`${COPILOT_PROXY_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    [...GITHUB_COPILOT_MODEL_REFS, ...COPILOT_PROXY_MODEL_REFS],
    COPILOT_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const VERCEL_AI_GATEWAY_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: VERCEL_AI_GATEWAY_PROVIDER_BRAND_ID,
  label: "Vercel AI",
  priority: 18,
  hint: "API key",
  modelProviderIds: [VERCEL_AI_GATEWAY_ROUTE_ID],
  methods: [
    {
      id: "ai-gateway-api-key",
      route: VERCEL_AI_GATEWAY_ROUTE_ID,
      kind: "api-key",
      label: "Vercel AI API key",
    },
  ],
  models: {
    recommended: [...VERCEL_AI_GATEWAY_MODEL_REFS],
    dynamic: true,
    routeRules: {
      [VERCEL_AI_GATEWAY_ROUTE_ID]: [`${VERCEL_AI_GATEWAY_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    VERCEL_AI_GATEWAY_MODEL_REFS,
    VERCEL_AI_GATEWAY_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const OPENCODE_ZEN_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: OPENCODE_ZEN_PROVIDER_BRAND_ID,
  label: "OpenCode Zen",
  priority: 19,
  hint: "API key",
  modelProviderIds: [OPENCODE_ZEN_ROUTE_ID],
  methods: [
    {
      id: "opencode-zen",
      route: OPENCODE_ZEN_ROUTE_ID,
      kind: "api-key",
      label: "OpenCode Zen API key",
      hint: "Sign in to OpenCode Zen, then paste the API key",
    },
  ],
  models: {
    recommended: [...OPENCODE_ZEN_MODEL_REFS],
    dynamic: true,
    routeRules: {
      [OPENCODE_ZEN_ROUTE_ID]: [`${OPENCODE_ZEN_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    OPENCODE_ZEN_MODEL_REFS,
    OPENCODE_ZEN_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const XIAOMI_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: XIAOMI_PROVIDER_BRAND_ID,
  label: "Xiaomi",
  priority: 20,
  hint: "MiMo API key",
  modelProviderIds: [XIAOMI_ROUTE_ID],
  methods: [
    {
      id: "xiaomi-api-key",
      route: XIAOMI_ROUTE_ID,
      kind: "api-key",
      label: "Xiaomi API key",
      hint: "Create an API key in the Xiaomi MiMo API Open Platform",
    },
  ],
  models: {
    recommended: [...XIAOMI_MODEL_REFS],
    routeRules: {
      [XIAOMI_ROUTE_ID]: [`${XIAOMI_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    XIAOMI_MODEL_REFS,
    XIAOMI_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const SYNTHETIC_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: SYNTHETIC_PROVIDER_BRAND_ID,
  label: "Synthetic",
  priority: 21,
  hint: "Anthropic-compatible API key",
  modelProviderIds: [SYNTHETIC_ROUTE_ID],
  methods: [
    {
      id: "synthetic-api-key",
      route: SYNTHETIC_ROUTE_ID,
      kind: "api-key",
      label: "Synthetic API key",
      hint: "Create an API key in Synthetic",
    },
  ],
  models: {
    recommended: [...SYNTHETIC_MODEL_REFS],
    routeRules: {
      [SYNTHETIC_ROUTE_ID]: [`${SYNTHETIC_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    SYNTHETIC_MODEL_REFS,
    SYNTHETIC_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const TOGETHER_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: TOGETHER_PROVIDER_BRAND_ID,
  label: "Together AI",
  priority: 22,
  hint: "API key",
  modelProviderIds: [TOGETHER_ROUTE_ID],
  methods: [
    {
      id: "together-api-key",
      route: TOGETHER_ROUTE_ID,
      kind: "api-key",
      label: "Together AI API key",
      hint: "Create an API key in Together AI",
    },
  ],
  models: {
    recommended: [...TOGETHER_MODEL_REFS],
    routeRules: {
      [TOGETHER_ROUTE_ID]: [`${TOGETHER_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilitiesWithOverrides(
    TOGETHER_MODEL_REFS,
    TOGETHER_MODEL_CAPABILITY_OVERRIDES,
  ),
};

export const HUGGINGFACE_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: HUGGINGFACE_PROVIDER_BRAND_ID,
  label: "Hugging Face",
  priority: 23,
  hint: "Inference Providers token",
  modelProviderIds: [HUGGINGFACE_ROUTE_ID],
  methods: [
    {
      id: "huggingface-api-key",
      route: HUGGINGFACE_ROUTE_ID,
      kind: "api-key",
      label: "Hugging Face token",
      hint: "Create a fine-grained token with Inference Providers access",
    },
  ],
  models: {
    recommended: [...HUGGINGFACE_MODEL_REFS],
    dynamic: true,
    routeRules: {
      [HUGGINGFACE_ROUTE_ID]: [`${HUGGINGFACE_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: HUGGINGFACE_MODEL_CAPABILITY_OVERRIDES,
};

export const VENICE_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: VENICE_PROVIDER_BRAND_ID,
  label: "Venice AI",
  priority: 24,
  hint: "Privacy-focused API key",
  modelProviderIds: [VENICE_ROUTE_ID],
  methods: [
    {
      id: "venice-api-key",
      route: VENICE_ROUTE_ID,
      kind: "api-key",
      label: "Venice AI API key",
      hint: "Create an API key in Venice settings",
    },
  ],
  models: {
    recommended: [...VENICE_MODEL_REFS],
    dynamic: true,
    routeRules: {
      [VENICE_ROUTE_ID]: [`${VENICE_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: VENICE_MODEL_CAPABILITY_OVERRIDES,
};

export const LITELLM_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: LITELLM_PROVIDER_BRAND_ID,
  label: "LiteLLM",
  priority: 25,
  hint: "OpenAI-compatible LLM proxy",
  modelProviderIds: [LITELLM_ROUTE_ID],
  methods: [
    {
      id: "litellm-api-key",
      route: LITELLM_ROUTE_ID,
      kind: "api-key",
      label: "LiteLLM API key",
      hint: "LiteLLM Proxy virtual key or master key plus /v1 base URL",
    },
  ],
  models: {
    recommended: [...LITELLM_MODEL_REFS],
    dynamic: true,
    routeRules: {
      [LITELLM_ROUTE_ID]: [`${LITELLM_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: LITELLM_MODEL_CAPABILITY_OVERRIDES,
};

export const CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: CLOUDFLARE_AI_GATEWAY_PROVIDER_BRAND_ID,
  label: "Cloudflare AI",
  priority: 26,
  hint: "Anthropic through Cloudflare AI",
  modelProviderIds: [CLOUDFLARE_AI_GATEWAY_ROUTE_ID],
  methods: [
    {
      id: "cloudflare-ai-gateway-api-key",
      route: CLOUDFLARE_AI_GATEWAY_ROUTE_ID,
      kind: "manual",
      label: "Cloudflare AI API key",
      hint: "Requires Cloudflare Account ID, Gateway ID, and Anthropic provider API key",
      buttonLabel: "Configure",
    },
  ],
  models: {
    recommended: [...CLOUDFLARE_AI_GATEWAY_MODEL_REFS],
    routeRules: {
      [CLOUDFLARE_AI_GATEWAY_ROUTE_ID]: [`${CLOUDFLARE_AI_GATEWAY_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: CLOUDFLARE_AI_GATEWAY_MODEL_CAPABILITY_OVERRIDES,
};

export const CUSTOM_PROVIDER_MANIFEST: ProviderBrandManifest = {
  id: CUSTOM_PROVIDER_BRAND_ID,
  label: "Custom Provider",
  priority: 27,
  hint: "OpenAI or Anthropic-compatible endpoint outside the built-in provider cards",
  modelProviderIds: [CUSTOM_PROVIDER_ROUTE_ID],
  methods: [
    {
      id: "custom-api-key",
      route: CUSTOM_PROVIDER_ROUTE_ID,
      kind: "manual",
      label: "Custom Provider",
      hint: "Requires base URL, endpoint compatibility, model ID, and optional API key. Use this for SGLang or other compatible endpoints when the vLLM-compatible shortcut does not fit.",
      buttonLabel: "Configure",
    },
  ],
  models: {
    recommended: CUSTOM_PROVIDER_MODEL_REFS,
    dynamic: true,
    routeRules: {
      [CUSTOM_PROVIDER_ROUTE_ID]: [`${CUSTOM_PROVIDER_ROUTE_ID}/*`],
    },
  },
  modelCapabilities: buildProviderModelCapabilities(CUSTOM_PROVIDER_MODEL_REFS),
};

export const PROVIDER_REGISTRY = [
  OPENAI_PROVIDER_MANIFEST,
  ANTHROPIC_PROVIDER_MANIFEST,
  CHUTES_PROVIDER_MANIFEST,
  OLLAMA_PROVIDER_MANIFEST,
  LMSTUDIO_PROVIDER_MANIFEST,
  VLLM_PROVIDER_MANIFEST,
  MINIMAX_PROVIDER_MANIFEST,
  MOONSHOT_PROVIDER_MANIFEST,
  GOOGLE_PROVIDER_MANIFEST,
  XAI_PROVIDER_MANIFEST,
  MISTRAL_PROVIDER_MANIFEST,
  VOLCENGINE_PROVIDER_MANIFEST,
  BYTEPLUS_PROVIDER_MANIFEST,
  OPENROUTER_PROVIDER_MANIFEST,
  QWEN_PROVIDER_MANIFEST,
  ZAI_PROVIDER_MANIFEST,
  QIANFAN_PROVIDER_MANIFEST,
  COPILOT_PROVIDER_MANIFEST,
  VERCEL_AI_GATEWAY_PROVIDER_MANIFEST,
  OPENCODE_ZEN_PROVIDER_MANIFEST,
  XIAOMI_PROVIDER_MANIFEST,
  SYNTHETIC_PROVIDER_MANIFEST,
  TOGETHER_PROVIDER_MANIFEST,
  HUGGINGFACE_PROVIDER_MANIFEST,
  VENICE_PROVIDER_MANIFEST,
  LITELLM_PROVIDER_MANIFEST,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST,
  CUSTOM_PROVIDER_MANIFEST,
] as const;

const PROVIDER_MANIFEST_BY_ID = new Map(PROVIDER_REGISTRY.map((entry) => [entry.id, entry]));
const PROVIDER_MANIFEST_BY_ROUTE = new Map(
  PROVIDER_REGISTRY.flatMap((entry) => [
    ...entry.methods.map((method) => [method.route, entry] as const),
    ...(entry.routeAliases ?? []).map((alias) => [alias, entry] as const),
    ...(entry.modelProviderIds ?? []).map((providerId) => [providerId, entry] as const),
  ]),
);
const STANDARD_PROVIDER_MODEL_REFS: ReadonlySet<string> = new Set(
  PROVIDER_REGISTRY.flatMap((entry) => entry.models.recommended.map((ref) => ref.toLowerCase())),
);
const PROVIDER_MODEL_CAPABILITY_BY_REF: ReadonlyMap<string, ModelCapabilityConfig> = new Map(
  PROVIDER_REGISTRY.flatMap((entry) =>
    Object.entries(entry.modelCapabilities ?? {}).map(
      ([ref, capability]) => [ref.toLowerCase(), capability] as const,
    ),
  ),
);
const OPENAI_SIGN_IN_MODEL_ID_SET: ReadonlySet<string> = new Set(OPENAI_SIGN_IN_MODEL_IDS);

export function listProviderBrandManifests(): ProviderBrandManifest[] {
  return [...PROVIDER_REGISTRY];
}

export function getProviderBrandManifest(id: string): ProviderBrandManifest | undefined {
  return PROVIDER_MANIFEST_BY_ID.get(id.trim().toLowerCase());
}

export function getProviderBrandManifestForRoute(route: string): ProviderBrandManifest | undefined {
  return PROVIDER_MANIFEST_BY_ROUTE.get(route.trim().toLowerCase());
}

export function providerRegistryPriorityForRoute(route: string): number {
  return getProviderBrandManifestForRoute(route)?.priority ?? Number.MAX_SAFE_INTEGER;
}

export function providerBrandOrderIndex(providerId: string): number {
  return (
    (PROVIDER_BRAND_ORDER_INDEX as ReadonlyMap<string, number>).get(
      providerId.trim().toLowerCase(),
    ) ?? Number.MAX_SAFE_INTEGER
  );
}

export function isOpenAIProviderRoute(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === OPENAI_API_ROUTE_ID || normalized === OPENAI_CODEX_ROUTE_ID;
}

export function isOpenAISignInRuntimeModelSupported(id: string): boolean {
  return OPENAI_SIGN_IN_MODEL_ID_SET.has(id.trim().toLowerCase());
}

export function lookupProviderManifestModelCapability(
  provider: string,
  model: string,
): ModelCapabilityConfig | undefined {
  const providerId = provider.trim().toLowerCase();
  const modelId = model.trim().toLowerCase();
  if (!providerId || !modelId) {
    return undefined;
  }
  return PROVIDER_MODEL_CAPABILITY_BY_REF.get(`${providerId}/${modelId}`);
}

export function isStandardProviderModelRef(ref: string): boolean {
  const value = ref.trim();
  if (!value) {
    return false;
  }
  const slash = value.indexOf("/");
  if (slash === -1) {
    return true;
  }
  const provider = value.slice(0, slash).trim().toLowerCase();
  if (!getProviderBrandManifestForRoute(provider)) {
    return false;
  }
  if (getProviderBrandManifestForRoute(provider)?.models.dynamic) {
    return true;
  }
  return STANDARD_PROVIDER_MODEL_REFS.has(value.toLowerCase());
}

export function isStandardProviderCatalogEntry(entry: { provider: string; id: string }): boolean {
  const provider = entry.provider.trim();
  const id = entry.id.trim();
  if (!provider || !id) {
    return false;
  }
  return isStandardProviderModelRef(`${provider}/${id}`);
}
