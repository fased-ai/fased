import { readFile } from "node:fs/promises";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { ModelCapabilityConfig } from "../config/types.models.js";
import {
  BASE_THINKING_LEVELS,
  type ModelThinkingLevel,
  type ModelThinkingMode,
} from "../shared/model-thinking.js";
import {
  ANTHROPIC_MODEL_IDS,
  ANTHROPIC_PROVIDER_BRAND_ID,
  ANTHROPIC_ROUTE_ID,
  BYTEPLUS_CODING_ROUTE_ID,
  BYTEPLUS_CODING_MODEL_IDS,
  BYTEPLUS_MODEL_IDS,
  BYTEPLUS_PLAN_ROUTE_ID,
  BYTEPLUS_PROVIDER_BRAND_ID,
  BYTEPLUS_ROUTE_ID,
  CHUTES_MODEL_IDS,
  CHUTES_PROVIDER_BRAND_ID,
  CHUTES_ROUTE_ID,
  CLOUDFLARE_AI_GATEWAY_MODEL_IDS,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_BRAND_ID,
  CLOUDFLARE_AI_GATEWAY_ROUTE_ID,
  COPILOT_PROXY_MODEL_IDS,
  COPILOT_PROVIDER_BRAND_ID,
  COPILOT_PROXY_ROUTE_ID,
  CUSTOM_PROVIDER_BRAND_ID,
  CUSTOM_PROVIDER_ROUTE_ID,
  GITHUB_COPILOT_ROUTE_ID,
  GOOGLE_API_ROUTE_ID,
  GOOGLE_GEMINI_CLI_ROUTE_ID,
  GOOGLE_GEMINI_MODEL_IDS,
  GOOGLE_PROVIDER_BRAND_ID,
  HUGGINGFACE_MODEL_IDS,
  HUGGINGFACE_PROVIDER_BRAND_ID,
  HUGGINGFACE_ROUTE_ID,
  KIMI_CODING_MODEL_IDS,
  KIMI_CODING_ROUTE_ID,
  LMSTUDIO_PROVIDER_BRAND_ID,
  LMSTUDIO_ROUTE_ID,
  LITELLM_BASE_URL,
  LITELLM_MODEL_IDS,
  LITELLM_PROVIDER_BRAND_ID,
  LITELLM_ROUTE_ID,
  MINIMAX_API_ROUTE_ID,
  MINIMAX_CN_ROUTE_ID,
  MINIMAX_MODEL_IDS,
  MINIMAX_PORTAL_ROUTE_ID,
  MINIMAX_PROVIDER_BRAND_ID,
  MISTRAL_MODEL_IDS,
  MISTRAL_PROVIDER_BRAND_ID,
  MISTRAL_ROUTE_ID,
  MOONSHOT_MODEL_IDS,
  MOONSHOT_PROVIDER_BRAND_ID,
  MOONSHOT_ROUTE_ID,
  OPENCODE_ZEN_MODEL_IDS,
  OPENCODE_ZEN_PROVIDER_BRAND_ID,
  OPENCODE_ZEN_ROUTE_ID,
  OLLAMA_PROVIDER_BRAND_ID,
  OLLAMA_ROUTE_ID,
  OPENAI_API_MODEL_IDS,
  OPENAI_API_ROUTE_ID,
  OPENAI_SIGN_IN_MODEL_IDS,
  OPENAI_CODEX_ROUTE_ID,
  OPENROUTER_MODEL_IDS,
  OPENROUTER_PROVIDER_BRAND_ID,
  OPENROUTER_ROUTE_ID,
  OPENAI_PROVIDER_BRAND_ID,
  QIANFAN_MODEL_IDS,
  QIANFAN_PROVIDER_BRAND_ID,
  QIANFAN_ROUTE_ID,
  QWEN_API_MODEL_IDS,
  QWEN_API_ROUTE_ID,
  QWEN_CODING_PLAN_MODEL_IDS,
  QWEN_CODING_PLAN_ROUTE_ID,
  QWEN_PROVIDER_BRAND_ID,
  SYNTHETIC_MODEL_IDS,
  SYNTHETIC_PROVIDER_BRAND_ID,
  SYNTHETIC_ROUTE_ID,
  TOGETHER_MODEL_IDS,
  TOGETHER_PROVIDER_BRAND_ID,
  TOGETHER_ROUTE_ID,
  VENICE_MODEL_IDS,
  VENICE_PROVIDER_BRAND_ID,
  VENICE_ROUTE_ID,
  VERCEL_AI_GATEWAY_MODEL_IDS,
  VERCEL_AI_GATEWAY_PROVIDER_BRAND_ID,
  VERCEL_AI_GATEWAY_ROUTE_ID,
  VLLM_PROVIDER_BRAND_ID,
  VLLM_ROUTE_ID,
  VOLCENGINE_CODING_MODEL_IDS,
  VOLCENGINE_CODING_ROUTE_ID,
  VOLCENGINE_MODEL_IDS,
  VOLCENGINE_PLAN_ROUTE_ID,
  VOLCENGINE_PROVIDER_BRAND_ID,
  VOLCENGINE_ROUTE_ID,
  XIAOMI_MODEL_IDS,
  XIAOMI_PROVIDER_BRAND_ID,
  XIAOMI_ROUTE_ID,
  XAI_MODEL_IDS,
  XAI_PROVIDER_BRAND_ID,
  XAI_ROUTE_ID,
  ZAI_MODEL_IDS,
  ZAI_PROVIDER_BRAND_ID,
  ZAI_ROUTE_ID,
  type ProviderBrandManifest,
  listProviderBrandManifests,
  lookupProviderManifestModelCapability,
  resolveProviderRouteModelCapability,
} from "./registry.js";

export type ProviderRefreshModelSnapshot = {
  id: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  tools?: boolean;
  json?: boolean;
  audio?: boolean;
  video?: boolean;
  speech?: boolean;
  thinkingLevels?: ModelThinkingLevel[];
  defaultThinkingLevel?: ModelThinkingLevel;
  thinkingMode?: ModelThinkingMode;
  reasoningBudgetSupported?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  source?: string;
};

export type ProviderRefreshRouteSnapshot = Array<string | ProviderRefreshModelSnapshot>;
export type ProviderRefreshMissingSourceReason =
  | "credential-missing"
  | "base-url-missing"
  | "catalog-unsupported";
export type ProviderRefreshMissingSource = {
  reason: ProviderRefreshMissingSourceReason;
  detail?: string;
};

export type ProviderRefreshSnapshot = {
  providers?: Record<
    string,
    {
      routes?: Record<string, ProviderRefreshRouteSnapshot>;
      models?: string[];
      missing?: Record<string, ProviderRefreshMissingSource>;
    }
  >;
};

export type ProviderRefreshRouteReport = {
  brandId: string;
  route: string;
  currentModels: string[];
  discoveredModels: string[];
  additions: string[];
  removals: string[];
  missingSource: boolean;
  missingSourceReason?: ProviderRefreshMissingSourceReason;
  missingSourceDetail?: string;
  modelMetadata: ProviderRefreshModelSnapshot[];
  capabilityMetadata: {
    total: number;
    reasoning: number;
    thinking: number;
    vision: number;
    tools: number;
    json: number;
    contextWindow: number;
    maxTokens: number;
  };
};

export type ProviderRefreshReport = {
  generatedAt: string;
  source: string;
  routes: ProviderRefreshRouteReport[];
};

export type ProviderRefreshOptions = {
  snapshot?: ProviderRefreshSnapshot;
  source?: string;
  now?: Date;
  manifests?: ProviderBrandManifest[];
};

type ProviderRefreshEnv = Record<string, string | undefined>;
type ProviderRefreshModelProviderSource = Record<
  string,
  {
    baseUrl?: unknown;
    apiKey?: unknown;
  }
>;

const OPENAI_DOCS_MODELS_URL = "https://developers.openai.com/api/docs/models/all";
const CHUTES_MODELS_URL = "https://llm.chutes.ai/v1/models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const VERCEL_AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const HUGGINGFACE_MODELS_URL = "https://router.huggingface.co/v1/models";
const VENICE_MODELS_URL = "https://api.venice.ai/api/v1/models";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const GOOGLE_GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const XAI_MODELS_URL = "https://api.x.ai/v1/models";
const MISTRAL_MODELS_URL = "https://api.mistral.ai/v1/models";
const MINIMAX_MODELS_URL = "https://api.minimax.io/v1/models";
const MINIMAX_PORTAL_DEFAULT_BASE_URL = "https://api.minimax.io/anthropic";
const MOONSHOT_MODELS_URL = "https://api.moonshot.ai/v1/models";
const KIMI_CODING_DEFAULT_BASE_URL = "https://api.kimi.com/coding";
const ZAI_MODELS_URL = "https://api.z.ai/api/paas/v4/models";
const QIANFAN_MODELS_URL = "https://qianfan.baidubce.com/v2/models";
const VOLCENGINE_MODELS_URL = "https://ark.cn-beijing.volces.com/api/v3/models";
const VOLCENGINE_CODING_MODELS_URL = "https://ark.cn-beijing.volces.com/api/coding/v3/models";
const BYTEPLUS_MODELS_URL = "https://ark.ap-southeast.bytepluses.com/api/v3/models";
const BYTEPLUS_CODING_MODELS_URL = "https://ark.ap-southeast.bytepluses.com/api/coding/v3/models";
const QWEN_DASHSCOPE_MODELS_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/models";
const QWEN_CODING_PLAN_MODELS_URL = "https://coding.dashscope.aliyuncs.com/v1/models";
const COPILOT_PROXY_DEFAULT_BASE_URL = "http://127.0.0.1:4141/v1";
const XIAOMI_MODELS_URL = "https://api.xiaomimimo.com/v1/models";
const SYNTHETIC_DEFAULT_BASE_URL = "https://api.synthetic.new/anthropic";
const SYNTHETIC_DEFAULT_MODELS_URL = "https://api.synthetic.new/openai/v1/models";
const TOGETHER_MODELS_URL = "https://api.together.xyz/v1/models";
const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const LMSTUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const LITELLM_DEFAULT_BASE_URL = LITELLM_BASE_URL;

const OPENAI_CURRENT_API_MODEL_RE = /^gpt-5\.(?:[4-9]|\d{2,})(?:-(?:mini|nano|terra|luna))?$/;
const OPENAI_CURRENT_SIGN_IN_MODEL_RE = /^gpt-(?:5\.(?:[4-9]|\d{2,})(?:-mini)?|5\.3-codex-spark)$/;
const CHUTES_CURRENT_NORMAL_UI_MODEL_RE =
  /^(?:google\/gemma-4-[^/]+-TEE|Qwen\/Qwen3(?:\.\d+)?-[^/]+-TEE|deepseek-ai\/DeepSeek-V3\.2-TEE|zai-org\/GLM-5(?:\.\d+)?-TEE|moonshotai\/Kimi-K2\.6-TEE)$/;
const OPENROUTER_CURRENT_NORMAL_UI_MODEL_RE =
  /^(?:openrouter\/owl-alpha|openai\/gpt-(?:5\.6-(?:sol|terra|luna)|5\.5|5\.4(?:-(?:mini|nano))?)|anthropic\/claude-(?:fable-5|opus-4\.8|sonnet-5|haiku-4\.5)|google\/gemini-(?:3\.5-flash|3\.1-(?:pro-preview|flash-lite)|3-flash-preview)|x-ai\/(?:grok-4\.5|grok-4\.3|grok-build-0\.1)|mistralai\/(?:mistral-medium-3-5|mistral-small-2603|mistral-large-2512|devstral-2512)|qwen\/qwen3\.(?:7-(?:max|plus)|6-flash)|z-ai\/glm-5\.2|deepseek\/deepseek-v4-(?:pro|flash)|minimax\/minimax-m2\.7|moonshotai\/kimi-k2\.6)$/;
const VERCEL_AI_GATEWAY_CURRENT_NORMAL_UI_MODEL_RE =
  /^(?:openai\/gpt-(?:5\.5|5\.4(?:-(?:mini|nano))?)|anthropic\/claude-(?:fable-5|opus-4\.8|sonnet-5|haiku-4\.5)|google\/gemini-(?:3\.5-flash|3\.1-(?:pro-preview|flash-lite)|3-flash-preview)|xai\/(?:grok-4\.3|grok-build-0\.1)|mistral\/(?:mistral-medium-3\.5|mistral-small-2603|mistral-large-2512|devstral-2512)|minimax\/minimax-m2\.7(?:-highspeed)?|moonshotai\/kimi-k2\.6)$/;
const OPENCODE_ZEN_CURRENT_NORMAL_UI_MODEL_RE =
  /^(?:gpt-5\.(?:5|4(?:-(?:mini|nano))?|3-codex-spark)|claude-(?:fable-5|opus-4-8|sonnet-5|haiku-4-5)|gemini-(?:3\.5-flash|3\.1-pro|3-flash)|qwen3\.7-plus|minimax-m2\.7|glm-5\.2|kimi-k2\.6)$/;

function normalizeModelIds(
  values: Iterable<string>,
  options: {
    lowercase?: boolean;
  } = {},
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const id = options.lowercase ? trimmed.toLowerCase() : trimmed;
    const seenKey = id.toLowerCase();
    if (!id || seen.has(seenKey)) {
      continue;
    }
    seen.add(seenKey);
    result.push(id);
  }
  return result;
}

function setProviderRefreshEnvValue(
  target: ProviderRefreshEnv,
  key: string,
  value: string | undefined,
): void {
  const trimmed = value?.trim();
  if (!trimmed || target[key]?.trim()) {
    return;
  }
  target[key] = trimmed;
}

function resolveEnvSecretValue(value: unknown, env: ProviderRefreshEnv): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.source === "env" && typeof record.id === "string") {
    return env[record.id]?.trim() || undefined;
  }
  return undefined;
}

function resolveApiKeyProfileValue(
  profile: AuthProfileStore["profiles"][string],
  env: ProviderRefreshEnv,
): string | undefined {
  if (profile.type !== "api_key") {
    return undefined;
  }
  return resolveEnvSecretValue(profile.key, env) ?? resolveEnvSecretValue(profile.keyRef, env);
}

function resolveTokenProfileValue(
  profile: AuthProfileStore["profiles"][string],
  env: ProviderRefreshEnv,
): string | undefined {
  if (profile.type === "api_key") {
    return resolveApiKeyProfileValue(profile, env);
  }
  if (profile.type === "token") {
    return (
      resolveEnvSecretValue(profile.token, env) ?? resolveEnvSecretValue(profile.tokenRef, env)
    );
  }
  return profile.access?.trim() || undefined;
}

function resolveProfileMetadata(
  profile: AuthProfileStore["profiles"][string],
): Record<string, unknown> {
  const metadata = (profile as { metadata?: unknown }).metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function setProviderRefreshEnvFromProfile(params: {
  target: ProviderRefreshEnv;
  env: ProviderRefreshEnv;
  profile: AuthProfileStore["profiles"][string];
}): void {
  const provider = params.profile.provider.trim();
  const apiKey = resolveApiKeyProfileValue(params.profile, params.env);
  switch (provider) {
    case "anthropic":
      setProviderRefreshEnvValue(params.target, "ANTHROPIC_API_KEY", apiKey);
      break;
    case "google":
    case "gemini":
      setProviderRefreshEnvValue(params.target, "GEMINI_API_KEY", apiKey);
      break;
    case "google-gemini-cli": {
      setProviderRefreshEnvValue(
        params.target,
        "GOOGLE_GEMINI_CLI_OAUTH_TOKEN",
        resolveTokenProfileValue(params.profile, params.env),
      );
      const metadata = resolveProfileMetadata(params.profile);
      setProviderRefreshEnvValue(
        params.target,
        "GOOGLE_CLOUD_PROJECT",
        metadataString(metadata, "projectId"),
      );
      setProviderRefreshEnvValue(
        params.target,
        "GOOGLE_CLOUD_PROJECT_ID",
        metadataString(metadata, "projectId"),
      );
      break;
    }
    case "xai":
      setProviderRefreshEnvValue(params.target, "XAI_API_KEY", apiKey);
      break;
    case "mistral":
      setProviderRefreshEnvValue(params.target, "MISTRAL_API_KEY", apiKey);
      break;
    case "minimax":
    case "minimax-cn":
      setProviderRefreshEnvValue(params.target, "MINIMAX_API_KEY", apiKey);
      break;
    case "minimax-portal":
      setProviderRefreshEnvValue(
        params.target,
        "MINIMAX_PORTAL_OAUTH_TOKEN",
        resolveTokenProfileValue(params.profile, params.env),
      );
      break;
    case "moonshot":
    case "moonshot-cn":
      setProviderRefreshEnvValue(params.target, "MOONSHOT_API_KEY", apiKey);
      break;
    case "kimi-code":
    case "kimi-coding":
      setProviderRefreshEnvValue(params.target, "KIMI_CODING_API_KEY", apiKey);
      break;
    case "zai":
      setProviderRefreshEnvValue(params.target, "ZAI_API_KEY", apiKey);
      break;
    case "qianfan":
      setProviderRefreshEnvValue(params.target, "QIANFAN_API_KEY", apiKey);
      break;
    case "qwen":
      setProviderRefreshEnvValue(params.target, "DASHSCOPE_API_KEY", apiKey);
      break;
    case "qwen-coding-plan":
      setProviderRefreshEnvValue(params.target, "BAILIAN_CODING_PLAN_API_KEY", apiKey);
      break;
    case "volcengine":
      setProviderRefreshEnvValue(params.target, "VOLCANO_ENGINE_API_KEY", apiKey);
      break;
    case "byteplus":
      setProviderRefreshEnvValue(params.target, "BYTEPLUS_API_KEY", apiKey);
      break;
    case "copilot-proxy":
      setProviderRefreshEnvValue(
        params.target,
        "COPILOT_PROXY_API_KEY",
        resolveTokenProfileValue(params.profile, params.env),
      );
      break;
    case "xiaomi":
      setProviderRefreshEnvValue(params.target, "XIAOMI_API_KEY", apiKey);
      break;
    case "synthetic":
      setProviderRefreshEnvValue(params.target, "SYNTHETIC_API_KEY", apiKey);
      break;
    case "vllm":
      setProviderRefreshEnvValue(params.target, "VLLM_API_KEY", apiKey);
      break;
    case "litellm":
      setProviderRefreshEnvValue(params.target, "LITELLM_API_KEY", apiKey);
      break;
    case "cloudflare-ai-gateway": {
      setProviderRefreshEnvValue(params.target, "CLOUDFLARE_AI_GATEWAY_API_KEY", apiKey);
      const metadata = resolveProfileMetadata(params.profile);
      setProviderRefreshEnvValue(
        params.target,
        "CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID",
        metadataString(metadata, "accountId"),
      );
      setProviderRefreshEnvValue(
        params.target,
        "CLOUDFLARE_AI_GATEWAY_GATEWAY_ID",
        metadataString(metadata, "gatewayId"),
      );
      break;
    }
    case "together":
      setProviderRefreshEnvValue(params.target, "TOGETHER_API_KEY", apiKey);
      break;
    default:
      if (provider.startsWith("custom-")) {
        setProviderRefreshEnvValue(params.target, "CUSTOM_PROVIDER_API_KEY", apiKey);
      }
      break;
  }
}

function setProviderRefreshEnvFromModelProvider(params: {
  target: ProviderRefreshEnv;
  env: ProviderRefreshEnv;
  providerId: string;
  provider: ProviderRefreshModelProviderSource[string];
}): void {
  const apiKey = resolveEnvSecretValue(params.provider.apiKey, params.env);
  const baseUrl =
    typeof params.provider.baseUrl === "string" ? params.provider.baseUrl.trim() : undefined;
  switch (params.providerId) {
    case "vllm":
      setProviderRefreshEnvValue(params.target, "VLLM_API_KEY", apiKey);
      setProviderRefreshEnvValue(params.target, "VLLM_BASE_URL", baseUrl);
      break;
    case "litellm":
      setProviderRefreshEnvValue(params.target, "LITELLM_API_KEY", apiKey);
      setProviderRefreshEnvValue(params.target, "LITELLM_BASE_URL", baseUrl);
      break;
    case "cloudflare-ai-gateway":
      setProviderRefreshEnvValue(params.target, "CLOUDFLARE_AI_GATEWAY_API_KEY", apiKey);
      setProviderRefreshEnvValue(params.target, "CLOUDFLARE_AI_GATEWAY_BASE_URL", baseUrl);
      break;
    case "minimax-portal":
      setProviderRefreshEnvValue(params.target, "MINIMAX_PORTAL_BASE_URL", baseUrl);
      break;
    case "kimi-coding":
      setProviderRefreshEnvValue(params.target, "KIMI_CODING_API_KEY", apiKey);
      setProviderRefreshEnvValue(params.target, "KIMI_CODING_BASE_URL", baseUrl);
      break;
    case "copilot-proxy":
      setProviderRefreshEnvValue(params.target, "COPILOT_PROXY_API_KEY", apiKey);
      setProviderRefreshEnvValue(params.target, "COPILOT_PROXY_BASE_URL", baseUrl);
      break;
    case "xiaomi":
      setProviderRefreshEnvValue(params.target, "XIAOMI_API_KEY", apiKey);
      setProviderRefreshEnvValue(params.target, "XIAOMI_BASE_URL", baseUrl);
      break;
    case "synthetic":
      setProviderRefreshEnvValue(params.target, "SYNTHETIC_API_KEY", apiKey);
      setProviderRefreshEnvValue(params.target, "SYNTHETIC_BASE_URL", baseUrl);
      break;
    default:
      if (params.providerId.startsWith("custom-")) {
        setProviderRefreshEnvValue(params.target, "CUSTOM_PROVIDER_API_KEY", apiKey);
        setProviderRefreshEnvValue(params.target, "CUSTOM_PROVIDER_BASE_URL", baseUrl);
      }
      break;
  }
}

export function buildProviderRefreshEnvFromCredentials(
  params: {
    env?: ProviderRefreshEnv;
    authStores?: Array<AuthProfileStore | undefined>;
    modelProviders?: ProviderRefreshModelProviderSource;
  } = {},
): ProviderRefreshEnv {
  const env = params.env ?? process.env;
  const target: ProviderRefreshEnv = { ...env };
  for (const store of params.authStores ?? []) {
    for (const profile of Object.values(store?.profiles ?? {})) {
      setProviderRefreshEnvFromProfile({ target, env, profile });
    }
  }
  for (const [providerId, provider] of Object.entries(params.modelProviders ?? {})) {
    setProviderRefreshEnvFromModelProvider({ target, env, providerId, provider });
  }
  return target;
}

function modelRefsForRoute(manifest: ProviderBrandManifest, route: string): string[] {
  const prefix = `${route}/`;
  return manifest.models.recommended
    .filter((ref) => ref.startsWith(prefix))
    .map((ref) => ref.slice(prefix.length));
}

function manifestRouteIds(manifest: ProviderBrandManifest): string[] {
  const modelRoutes = manifest.models.recommended
    .map((ref) => ref.slice(0, ref.indexOf("/")))
    .filter((route) => route.length > 0);
  return [...new Set([...manifest.methods.map((method) => method.route), ...modelRoutes])];
}

function normalizeProviderRefreshModelEntry(
  entry: string | ProviderRefreshModelSnapshot,
): ProviderRefreshModelSnapshot | null {
  if (typeof entry === "string") {
    const id = entry.trim();
    return id ? { id } : null;
  }
  const id = entry?.id?.trim();
  if (!id) {
    return null;
  }
  return {
    id,
    ...(entry.input ? { input: entry.input } : {}),
    ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
    ...(entry.tools !== undefined ? { tools: entry.tools } : {}),
    ...(entry.json !== undefined ? { json: entry.json } : {}),
    ...(entry.audio !== undefined ? { audio: entry.audio } : {}),
    ...(entry.video !== undefined ? { video: entry.video } : {}),
    ...(entry.speech !== undefined ? { speech: entry.speech } : {}),
    ...(entry.thinkingLevels?.length ? { thinkingLevels: entry.thinkingLevels } : {}),
    ...(entry.defaultThinkingLevel ? { defaultThinkingLevel: entry.defaultThinkingLevel } : {}),
    ...(entry.thinkingMode ? { thinkingMode: entry.thinkingMode } : {}),
    ...(entry.reasoningBudgetSupported !== undefined
      ? { reasoningBudgetSupported: entry.reasoningBudgetSupported }
      : {}),
    ...(typeof entry.contextWindow === "number" && entry.contextWindow > 0
      ? { contextWindow: entry.contextWindow }
      : {}),
    ...(typeof entry.maxTokens === "number" && entry.maxTokens > 0
      ? { maxTokens: entry.maxTokens }
      : {}),
    ...(entry.source ? { source: entry.source } : {}),
  };
}

function normalizeProviderRefreshRouteSnapshot(
  entries: ProviderRefreshRouteSnapshot,
): ProviderRefreshModelSnapshot[] {
  const seen = new Set<string>();
  const result: ProviderRefreshModelSnapshot[] = [];
  for (const entry of entries) {
    const normalized = normalizeProviderRefreshModelEntry(entry);
    if (!normalized) {
      continue;
    }
    const key = normalized.id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function summarizeCapabilityMetadata(models: ProviderRefreshModelSnapshot[]) {
  return {
    total: models.filter(
      (model) =>
        model.input ||
        model.reasoning !== undefined ||
        model.tools !== undefined ||
        model.json !== undefined ||
        model.audio !== undefined ||
        model.video !== undefined ||
        model.speech !== undefined ||
        model.thinkingLevels?.length ||
        model.defaultThinkingLevel ||
        model.thinkingMode ||
        model.reasoningBudgetSupported !== undefined ||
        model.contextWindow ||
        model.maxTokens,
    ).length,
    reasoning: models.filter((model) => model.reasoning === true).length,
    thinking: models.filter(
      (model) =>
        Boolean(model.thinkingLevels?.length) ||
        Boolean(model.defaultThinkingLevel) ||
        Boolean(model.thinkingMode) ||
        model.reasoningBudgetSupported !== undefined,
    ).length,
    vision: models.filter((model) => model.input?.includes("image")).length,
    tools: models.filter((model) => model.tools === true).length,
    json: models.filter((model) => model.json === true).length,
    audio: models.filter((model) => model.audio === true).length,
    video: models.filter((model) => model.video === true).length,
    speech: models.filter((model) => model.speech === true).length,
    contextWindow: models.filter((model) => typeof model.contextWindow === "number").length,
    maxTokens: models.filter((model) => typeof model.maxTokens === "number").length,
  };
}

function snapshotModelsForRoute(
  snapshot: ProviderRefreshSnapshot | undefined,
  brandId: string,
  route: string,
): { ids: string[]; metadata: ProviderRefreshModelSnapshot[] } | null {
  const provider = snapshot?.providers?.[brandId];
  const routeModels = provider?.routes?.[route];
  if (Array.isArray(routeModels)) {
    const metadata = normalizeProviderRefreshRouteSnapshot(routeModels);
    return { ids: normalizeModelIds(metadata.map((model) => model.id)), metadata };
  }
  if (route === brandId && Array.isArray(provider?.models)) {
    const metadata = normalizeProviderRefreshRouteSnapshot(provider.models);
    return { ids: normalizeModelIds(metadata.map((model) => model.id)), metadata };
  }
  return null;
}

function snapshotMissingForRoute(
  snapshot: ProviderRefreshSnapshot | undefined,
  brandId: string,
  route: string,
): ProviderRefreshMissingSource | undefined {
  return snapshot?.providers?.[brandId]?.missing?.[route];
}

function missingProviderRoutes(
  brandId: string,
  missing: Record<string, ProviderRefreshMissingSource>,
): ProviderRefreshSnapshot {
  return {
    providers: {
      [brandId]: {
        missing,
      },
    },
  };
}

function withCuratedThinkingMetadata(
  route: string,
  model: ProviderRefreshModelSnapshot,
): ProviderRefreshModelSnapshot {
  const manifestCapabilities = lookupProviderManifestModelCapability(route, model.id);
  const inferredCapabilities =
    manifestCapabilities?.fixedReasoning === true
      ? undefined
      : resolveProviderRouteModelCapability({
          route,
          model: model.id,
          reasoning: model.reasoning,
        });
  const capabilities = {
    ...inferredCapabilities,
    ...manifestCapabilities,
    ...(model.thinkingLevels?.length ? { thinkingLevels: model.thinkingLevels } : {}),
    ...(model.defaultThinkingLevel ? { defaultThinkingLevel: model.defaultThinkingLevel } : {}),
    ...(model.thinkingMode ? { thinkingMode: model.thinkingMode } : {}),
    ...(model.reasoningBudgetSupported !== undefined
      ? { reasoningBudgetSupported: model.reasoningBudgetSupported }
      : {}),
  };
  return {
    ...model,
    ...(capabilities.tools !== undefined ? { tools: capabilities.tools } : {}),
    ...(capabilities.json !== undefined ? { json: capabilities.json } : {}),
    ...(capabilities.audio !== undefined ? { audio: capabilities.audio } : {}),
    ...(capabilities.video !== undefined ? { video: capabilities.video } : {}),
    ...(capabilities.speech !== undefined ? { speech: capabilities.speech } : {}),
    ...(capabilities.thinkingLevels?.length ? { thinkingLevels: capabilities.thinkingLevels } : {}),
    ...(capabilities.defaultThinkingLevel
      ? { defaultThinkingLevel: capabilities.defaultThinkingLevel }
      : {}),
    ...(capabilities.thinkingMode ? { thinkingMode: capabilities.thinkingMode } : {}),
    ...(capabilities.reasoningBudgetSupported !== undefined
      ? { reasoningBudgetSupported: capabilities.reasoningBudgetSupported }
      : {}),
  };
}

export function buildProviderRefreshReport(
  options: ProviderRefreshOptions = {},
): ProviderRefreshReport {
  const manifests = options.manifests ?? listProviderBrandManifests();
  const snapshot = options.snapshot;
  const routes: ProviderRefreshRouteReport[] = [];

  for (const manifest of manifests) {
    const routeIds = manifestRouteIds(manifest);
    for (const route of routeIds) {
      const currentModels = modelRefsForRoute(manifest, route);
      const discovered = snapshotModelsForRoute(snapshot, manifest.id, route);
      const missing = snapshotMissingForRoute(snapshot, manifest.id, route);
      if (!discovered && missing) {
        routes.push({
          brandId: manifest.id,
          route,
          currentModels,
          discoveredModels: [],
          additions: [],
          removals: [],
          missingSource: true,
          missingSourceReason: missing.reason,
          ...(missing.detail ? { missingSourceDetail: missing.detail } : {}),
          modelMetadata: [],
          capabilityMetadata: summarizeCapabilityMetadata([]),
        });
        continue;
      }
      if (!discovered && manifest.models.dynamic) {
        routes.push({
          brandId: manifest.id,
          route,
          currentModels,
          discoveredModels: [],
          additions: [],
          removals: [],
          missingSource: false,
          modelMetadata: [],
          capabilityMetadata: summarizeCapabilityMetadata([]),
        });
        continue;
      }
      if (!discovered) {
        routes.push({
          brandId: manifest.id,
          route,
          currentModels,
          discoveredModels: [],
          additions: [],
          removals: [],
          missingSource: true,
          modelMetadata: [],
          capabilityMetadata: summarizeCapabilityMetadata([]),
        });
        continue;
      }

      const current = new Set(currentModels);
      const discoveredModels = discovered.ids;
      const discoveredSet = new Set(discoveredModels);
      const discoveredMetadataById = new Map(
        discovered.metadata.map((model) => [model.id.toLowerCase(), model]),
      );
      const modelMetadata = discoveredModels
        .map((id) =>
          withCuratedThinkingMetadata(
            route,
            discoveredMetadataById.get(id.toLowerCase()) ?? { id },
          ),
        )
        .filter((model) => model.id);
      routes.push({
        brandId: manifest.id,
        route,
        currentModels,
        discoveredModels,
        additions: discoveredModels.filter((id) => !current.has(id)),
        removals: currentModels.filter((id) => !discoveredSet.has(id)),
        missingSource: false,
        modelMetadata,
        capabilityMetadata: summarizeCapabilityMetadata(modelMetadata),
      });
    }
  }

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    source: options.source ?? "snapshot",
    routes,
  };
}

function formatStringArrayBlock(exportName: string, values: readonly string[]): string {
  const body = values.map((value) => `  "${value}",`).join("\n");
  return `export const ${exportName} = [\n${body}\n] as const;`;
}

function replaceExportedStringArray(
  source: string,
  exportName: string,
  values: readonly string[],
): string {
  const pattern = new RegExp(`export const ${exportName} = \\[[\\s\\S]*?\\] as const;`);
  return source.replace(pattern, formatStringArrayBlock(exportName, values));
}

function mergeCuratedAndDiscoveredModels(params: {
  currentModels: readonly string[];
  discoveredModels: readonly string[];
}): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of [...params.currentModels, ...params.discoveredModels]) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(value);
  }
  return merged;
}

export function applyProviderRefreshToRegistrySource(
  source: string,
  report: ProviderRefreshReport,
): string {
  let next = source;
  const exportByRoute = new Map<string, string>([
    [`${OPENAI_PROVIDER_BRAND_ID}/${OPENAI_API_ROUTE_ID}`, "OPENAI_API_MODEL_IDS"],
    [`${OPENAI_PROVIDER_BRAND_ID}/${OPENAI_CODEX_ROUTE_ID}`, "OPENAI_SIGN_IN_MODEL_IDS"],
    [`${ANTHROPIC_PROVIDER_BRAND_ID}/${ANTHROPIC_ROUTE_ID}`, "ANTHROPIC_MODEL_IDS"],
    [`${CHUTES_PROVIDER_BRAND_ID}/${CHUTES_ROUTE_ID}`, "CHUTES_MODEL_IDS"],
    [`${MINIMAX_PROVIDER_BRAND_ID}/${MINIMAX_API_ROUTE_ID}`, "MINIMAX_MODEL_IDS"],
    [`${MINIMAX_PROVIDER_BRAND_ID}/${MINIMAX_CN_ROUTE_ID}`, "MINIMAX_MODEL_IDS"],
    [`${MOONSHOT_PROVIDER_BRAND_ID}/${MOONSHOT_ROUTE_ID}`, "MOONSHOT_MODEL_IDS"],
    [`${GOOGLE_PROVIDER_BRAND_ID}/${GOOGLE_API_ROUTE_ID}`, "GOOGLE_GEMINI_MODEL_IDS"],
    [`${GOOGLE_PROVIDER_BRAND_ID}/${GOOGLE_GEMINI_CLI_ROUTE_ID}`, "GOOGLE_GEMINI_MODEL_IDS"],
    [`${XAI_PROVIDER_BRAND_ID}/${XAI_ROUTE_ID}`, "XAI_MODEL_IDS"],
    [`${MISTRAL_PROVIDER_BRAND_ID}/${MISTRAL_ROUTE_ID}`, "MISTRAL_MODEL_IDS"],
    [`${VOLCENGINE_PROVIDER_BRAND_ID}/${VOLCENGINE_ROUTE_ID}`, "VOLCENGINE_MODEL_IDS"],
    [
      `${VOLCENGINE_PROVIDER_BRAND_ID}/${VOLCENGINE_CODING_ROUTE_ID}`,
      "VOLCENGINE_CODING_MODEL_IDS",
    ],
    [`${BYTEPLUS_PROVIDER_BRAND_ID}/${BYTEPLUS_ROUTE_ID}`, "BYTEPLUS_MODEL_IDS"],
    [`${BYTEPLUS_PROVIDER_BRAND_ID}/${BYTEPLUS_CODING_ROUTE_ID}`, "BYTEPLUS_CODING_MODEL_IDS"],
    [`${OPENROUTER_PROVIDER_BRAND_ID}/${OPENROUTER_ROUTE_ID}`, "OPENROUTER_MODEL_IDS"],
    [`${ZAI_PROVIDER_BRAND_ID}/${ZAI_ROUTE_ID}`, "ZAI_MODEL_IDS"],
    [`${QIANFAN_PROVIDER_BRAND_ID}/${QIANFAN_ROUTE_ID}`, "QIANFAN_MODEL_IDS"],
    [`${COPILOT_PROVIDER_BRAND_ID}/${GITHUB_COPILOT_ROUTE_ID}`, "GITHUB_COPILOT_MODEL_IDS"],
    [`${COPILOT_PROVIDER_BRAND_ID}/${COPILOT_PROXY_ROUTE_ID}`, "COPILOT_PROXY_MODEL_IDS"],
    [
      `${VERCEL_AI_GATEWAY_PROVIDER_BRAND_ID}/${VERCEL_AI_GATEWAY_ROUTE_ID}`,
      "VERCEL_AI_GATEWAY_MODEL_IDS",
    ],
    [`${OPENCODE_ZEN_PROVIDER_BRAND_ID}/${OPENCODE_ZEN_ROUTE_ID}`, "OPENCODE_ZEN_MODEL_IDS"],
    [`${HUGGINGFACE_PROVIDER_BRAND_ID}/${HUGGINGFACE_ROUTE_ID}`, "HUGGINGFACE_MODEL_IDS"],
    [`${VENICE_PROVIDER_BRAND_ID}/${VENICE_ROUTE_ID}`, "VENICE_MODEL_IDS"],
  ]);

  const replacedExports = new Set<string>();
  for (const route of report.routes) {
    if (route.missingSource) {
      continue;
    }
    if (route.discoveredModels.length === 0) {
      continue;
    }
    const exportName = exportByRoute.get(`${route.brandId}/${route.route}`);
    if (!exportName || replacedExports.has(exportName)) {
      continue;
    }
    next = replaceExportedStringArray(
      next,
      exportName,
      mergeCuratedAndDiscoveredModels({
        currentModels: route.currentModels,
        discoveredModels: route.discoveredModels,
      }),
    );
    replacedExports.add(exportName);
  }
  return next;
}

export function buildProviderRegistryReviewPatch(params: {
  registryPath: string;
  registrySource: string;
  report: ProviderRefreshReport;
}): string {
  const next = applyProviderRefreshToRegistrySource(params.registrySource, params.report);
  if (next === params.registrySource) {
    return "";
  }
  return [
    "*** Begin Patch",
    `*** Delete File: ${params.registryPath}`,
    `*** Add File: ${params.registryPath}`,
    ...next.split(/\r?\n/).map((line) => `+${line}`),
    "*** End Patch",
    "",
  ].join("\n");
}

function formatProviderCapabilityObject(value: ProviderRefreshModelSnapshot, refreshedAt: string) {
  const body: string[] = [];
  if (value.input?.length) {
    body.push(`    input: ${JSON.stringify(value.input)},`);
  }
  if (value.reasoning !== undefined) {
    body.push(`    reasoning: ${value.reasoning},`);
  }
  const capabilities: ModelCapabilityConfig = {};
  if (value.tools !== undefined) {
    capabilities.tools = value.tools;
  }
  if (value.json !== undefined) {
    capabilities.json = value.json;
  }
  if (value.audio !== undefined) {
    capabilities.audio = value.audio;
  }
  if (value.video !== undefined) {
    capabilities.video = value.video;
  }
  if (value.speech !== undefined) {
    capabilities.speech = value.speech;
  }
  if (value.thinkingLevels?.length) {
    capabilities.thinkingLevels = value.thinkingLevels;
  }
  if (value.defaultThinkingLevel) {
    capabilities.defaultThinkingLevel = value.defaultThinkingLevel;
  }
  if (value.thinkingMode) {
    capabilities.thinkingMode = value.thinkingMode;
  }
  if (value.reasoningBudgetSupported !== undefined) {
    capabilities.reasoningBudgetSupported = value.reasoningBudgetSupported;
  }
  if (Object.keys(capabilities).length > 0) {
    body.push(`    capabilities: ${JSON.stringify(capabilities)},`);
  }
  if (value.contextWindow) {
    body.push(`    contextWindow: ${value.contextWindow},`);
  }
  if (value.maxTokens) {
    body.push(`    maxTokens: ${value.maxTokens},`);
  }
  if (value.source) {
    body.push(`    source: ${JSON.stringify(value.source)},`);
  }
  body.push(`    refreshedAt: ${JSON.stringify(refreshedAt)},`);
  return ["  {", ...body, "  }"].join("\n");
}

export function buildProviderCapabilityOverridesSource(report: ProviderRefreshReport): string {
  const entries: Array<{ key: string; value: ProviderRefreshModelSnapshot }> = [];
  for (const route of report.routes) {
    if (route.missingSource || route.capabilityMetadata.total === 0) {
      continue;
    }
    for (const model of route.modelMetadata) {
      if (
        !model.input &&
        model.reasoning === undefined &&
        model.tools === undefined &&
        model.json === undefined &&
        !model.thinkingLevels?.length &&
        !model.defaultThinkingLevel &&
        !model.thinkingMode &&
        model.reasoningBudgetSupported === undefined &&
        !model.contextWindow &&
        !model.maxTokens
      ) {
        continue;
      }
      entries.push({
        key: `${route.route}/${model.id}`.toLowerCase(),
        value: model,
      });
    }
  }
  entries.sort((left, right) => left.key.localeCompare(right.key));
  const lines = [
    'import type { ModelCapabilityConfig } from "../config/types.models.js";',
    "",
    "export type RefreshedModelCapability = {",
    '  input?: Array<"text" | "image">;',
    "  reasoning?: boolean;",
    "  capabilities?: ModelCapabilityConfig;",
    "  contextWindow?: number;",
    "  maxTokens?: number;",
    "  source?: string;",
    "  refreshedAt?: string;",
    "};",
    "",
    "export const REFRESHED_MODEL_CAPABILITIES: Record<string, RefreshedModelCapability> = {",
    ...entries.flatMap((entry) => [
      `  ${JSON.stringify(entry.key)}: ${formatProviderCapabilityObject(
        entry.value,
        report.generatedAt,
      ).trimStart()},`,
    ]),
    "};",
    "",
    "export function lookupRefreshedModelCapability(",
    "  provider: string,",
    "  model: string,",
    "): RefreshedModelCapability | undefined {",
    "  const key = `${provider.trim()}/${model.trim()}`.toLowerCase();",
    "  return REFRESHED_MODEL_CAPABILITIES[key];",
    "}",
    "",
  ];
  return lines.join("\n");
}

export async function loadProviderRefreshSnapshotFromFile(
  path: string,
): Promise<ProviderRefreshSnapshot> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as ProviderRefreshSnapshot;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid provider refresh snapshot: ${path}`);
  }
  return parsed;
}

export function parseOpenAIModelIdsFromDocsHtml(html: string): string[] {
  const matches = html.match(/\bgpt-[a-z0-9][a-z0-9.-]*(?:-[a-z0-9][a-z0-9.-]*)?\b/gi) ?? [];
  return normalizeModelIds(matches, { lowercase: true });
}

export function parseChutesModelIdsFromModelsResponse(payload: unknown): string[] {
  const rawEntries = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const ids = rawEntries.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }
    if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
      return [(entry as { id: string }).id];
    }
    return [];
  });
  return normalizeModelIds(ids);
}

export function parseOpenRouterModelIdsFromModelsResponse(payload: unknown): string[] {
  return parseOpenRouterModelSnapshotsFromModelsResponse(payload).map((model) => model.id);
}

function readProviderCapability(
  providers: Record<string, unknown>[],
  keys: readonly string[],
): boolean | undefined {
  let sawFalse = false;
  for (const provider of providers) {
    for (const key of keys) {
      const value = readBoolean(provider[key]);
      if (value === true) {
        return true;
      }
      if (value === false) {
        sawFalse = true;
      }
    }
  }
  return sawFalse ? false : undefined;
}

function readMaxProviderContext(providers: Record<string, unknown>[]): number | undefined {
  const values = providers
    .map(
      (provider) =>
        readPositiveNumber(provider.context_length) ?? readPositiveNumber(provider.contextWindow),
    )
    .filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.max(...values) : undefined;
}

export function parseHuggingfaceModelSnapshotsFromModelsResponse(
  payload: unknown,
): ProviderRefreshModelSnapshot[] {
  const rawEntries =
    payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray(payload)
        ? payload
        : [];
  const models = rawEntries.flatMap((entry): ProviderRefreshModelSnapshot[] => {
    if (typeof entry === "string") {
      return [{ id: entry, source: "catalog" }];
    }
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const id = readString(record.id);
    if (!id) {
      return [];
    }
    const architecture = asRecord(record.architecture);
    const modalityValues = [
      ...readStringArrayFrom(architecture, ["input_modalities", "inputModalities"]),
      ...readStringArrayFrom(record, ["input_modalities", "inputModalities", "modalities"]),
    ].map((value) => value.toLowerCase());
    const input = normalizeModelInput(modalityValues);
    const providers = Array.isArray(record.providers) ? record.providers.map(asRecord) : [];
    const contextWindow =
      readMaxProviderContext(providers) ??
      readPositiveNumber(record.context_length) ??
      readPositiveNumber(record.contextWindow);
    const tools = readProviderCapability(providers, ["supports_tools", "tools"]);
    const json = readProviderCapability(providers, [
      "supports_structured_output",
      "supports_structured_outputs",
      "json",
    ]);
    return [
      {
        id,
        ...(input ? { input } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(json !== undefined ? { json } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        source: "catalog",
      },
    ];
  });
  const byId = new Map(models.map((model) => [model.id.toLowerCase(), model]));
  return normalizeModelIds(models.map((model) => model.id)).map(
    (id) => byId.get(id.toLowerCase()) ?? { id },
  );
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readCapabilitySupported(value: unknown): boolean | undefined {
  const direct = readBoolean(value);
  if (direct !== undefined) {
    return direct;
  }
  const record = asRecord(value);
  return readBoolean(record.supported);
}

function readPositiveNumberFrom(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = readPositiveNumber(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readStringArrayFrom(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const values = asStringArray(record[key]);
    if (values.length > 0) {
      return values;
    }
  }
  return [];
}

function normalizeProviderModelId(value: string): string {
  return value.startsWith("models/") ? value.slice("models/".length) : value;
}

function normalizeModelInput(values: string[]): Array<"text" | "image"> | undefined {
  const lower = values.map((value) => value.toLowerCase());
  const input: Array<"text" | "image"> = [];
  if (
    lower.length === 0 ||
    lower.some((value) => ["text", "text-in", "input_text"].includes(value))
  ) {
    input.push("text");
  }
  if (lower.some((value) => ["image", "vision", "input_image"].includes(value))) {
    input.push("image");
  }
  return input.length > 0 ? input : undefined;
}

function readExplicitReasoning(record: Record<string, unknown>): boolean | undefined {
  const direct = readBoolean(record.reasoning);
  if (direct !== undefined) {
    return direct;
  }
  const supportedFields = [
    ...readStringArrayFrom(record, ["supported_parameters", "supportedParameters"]),
    ...readStringArrayFrom(record, ["supported_features", "supportedFeatures"]),
  ].map((value) => value.toLowerCase());
  if (
    supportedFields.some((value) =>
      ["reasoning", "reasoning_effort", "include_reasoning", "thinking"].includes(value),
    )
  ) {
    return true;
  }
  return undefined;
}

function readThinkingCapabilityMetadata(capabilities: Record<string, unknown>): {
  reasoning?: boolean;
  thinkingLevels?: ModelThinkingLevel[];
  defaultThinkingLevel?: ModelThinkingLevel;
  thinkingMode?: ModelThinkingMode;
  reasoningBudgetSupported?: boolean;
} {
  const thinking = asRecord(capabilities.thinking);
  const thinkingTypes = asRecord(thinking.types);
  const adaptiveSupported =
    readCapabilitySupported(asRecord(thinkingTypes.adaptive)) ??
    readCapabilitySupported(thinking.adaptive) ??
    readCapabilitySupported(capabilities.adaptive_thinking) ??
    readCapabilitySupported(capabilities.adaptiveThinking);
  const enabledSupported =
    readCapabilitySupported(asRecord(thinkingTypes.enabled)) ??
    readCapabilitySupported(thinking.enabled) ??
    readCapabilitySupported(capabilities.extended_thinking) ??
    readCapabilitySupported(capabilities.extendedThinking);
  const thinkingSupported =
    adaptiveSupported === true ||
    enabledSupported === true ||
    readCapabilitySupported(capabilities.thinking) === true ||
    readCapabilitySupported(thinking.supported) === true;

  if (!thinkingSupported) {
    return {};
  }

  return {
    reasoning: true,
    thinkingLevels: [...BASE_THINKING_LEVELS],
    defaultThinkingLevel: "low",
    thinkingMode: adaptiveSupported === true ? "anthropic-adaptive" : "anthropic-thinking-budget",
    reasoningBudgetSupported: enabledSupported === true,
  };
}

export function parseOpenRouterModelSnapshotsFromModelsResponse(
  payload: unknown,
): ProviderRefreshModelSnapshot[] {
  const rawEntries =
    payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray(payload)
        ? payload
        : [];
  const models = rawEntries.flatMap((entry): ProviderRefreshModelSnapshot[] => {
    if (typeof entry === "string") {
      return [{ id: entry }];
    }
    if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
      const record = entry as Record<string, unknown>;
      const architecture =
        record.architecture && typeof record.architecture === "object"
          ? (record.architecture as Record<string, unknown>)
          : {};
      const topProvider =
        record.top_provider && typeof record.top_provider === "object"
          ? (record.top_provider as Record<string, unknown>)
          : {};
      const inputModalities = new Set(
        asStringArray(architecture.input_modalities).map((value) => value.toLowerCase()),
      );
      const outputModalities = new Set(
        asStringArray(architecture.output_modalities).map((value) => value.toLowerCase()),
      );
      const supportedParameters = asStringArray(record.supported_parameters).map((value) =>
        value.toLowerCase(),
      );
      const tags = new Set(asStringArray(record.tags).map((value) => value.toLowerCase()));
      const input: Array<"text" | "image"> = [];
      if (inputModalities.size === 0 || inputModalities.has("text")) {
        input.push("text");
      }
      if (inputModalities.has("image") || tags.has("vision")) {
        input.push("image");
      }
      const reasoning =
        tags.has("reasoning") ||
        supportedParameters.some((value) =>
          ["reasoning", "reasoning_effort", "include_reasoning"].includes(value),
        );
      const tools =
        supportedParameters.some((value) =>
          ["tools", "tool_choice", "parallel_tool_calls"].includes(value),
        ) || tags.has("tool-use");
      const json = supportedParameters.some((value) =>
        ["response_format", "structured_outputs", "json_schema"].includes(value),
      );
      const audio =
        inputModalities.has("audio") || outputModalities.has("audio") || tags.has("audio");
      const video =
        inputModalities.has("video") || outputModalities.has("video") || tags.has("video");
      const speech = outputModalities.has("audio");
      const contextWindow =
        readPositiveNumber(record.context_length) ??
        readPositiveNumber(record.context_window) ??
        readPositiveNumber(record.contextWindow);
      const maxTokens =
        readPositiveNumber(topProvider.max_completion_tokens) ??
        readPositiveNumber(record.max_tokens) ??
        readPositiveNumber(record.maxTokens);
      return [
        {
          id: (entry as { id: string }).id,
          ...(input.length > 0 ? { input } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(tools ? { tools } : {}),
          ...(json ? { json } : {}),
          ...(audio ? { audio } : {}),
          ...(video ? { video } : {}),
          ...(speech ? { speech } : {}),
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxTokens ? { maxTokens } : {}),
          source: "catalog",
        },
      ];
    }
    return [];
  });
  const byId = new Map(models.map((model) => [model.id.toLowerCase(), model]));
  return normalizeModelIds(models.map((model) => model.id)).map(
    (id) => byId.get(id.toLowerCase()) ?? { id },
  );
}

export function parseGenericModelSnapshotsFromModelsResponse(
  payload: unknown,
): ProviderRefreshModelSnapshot[] {
  const rawEntries =
    payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : payload &&
          typeof payload === "object" &&
          Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : payload &&
            typeof payload === "object" &&
            Array.isArray((payload as { items?: unknown }).items)
          ? (payload as { items: unknown[] }).items
          : Array.isArray(payload)
            ? payload
            : [];
  const models = rawEntries.flatMap((entry): ProviderRefreshModelSnapshot[] => {
    if (typeof entry === "string") {
      return [{ id: normalizeProviderModelId(entry), source: "catalog" }];
    }
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const id =
      readString(record.id) ??
      readString(record.key) ??
      readString(record.name) ??
      readString(record.model);
    if (!id) {
      return [];
    }
    const architecture = asRecord(record.architecture);
    const capabilities = asRecord(record.capabilities);
    const thinking = readThinkingCapabilityMetadata(capabilities);
    const imageSupported =
      readCapabilitySupported(capabilities.vision) ??
      readCapabilitySupported(capabilities.image) ??
      readCapabilitySupported(capabilities.image_input) ??
      readCapabilitySupported(capabilities.imageInput);
    const modalityValues = [
      ...readStringArrayFrom(record, [
        "input",
        "input_modalities",
        "inputModalities",
        "modalities",
        "supported_input_modalities",
      ]),
      ...readStringArrayFrom(architecture, ["input_modalities", "inputModalities"]),
      ...readStringArrayFrom(capabilities, ["input", "modalities"]),
      ...(imageSupported === true ? ["text", "image"] : []),
    ].map((value) => value.toLowerCase());
    const input = normalizeModelInput(modalityValues);
    const modalitySet = new Set(modalityValues);
    const reasoning =
      readExplicitReasoning(record) ?? readExplicitReasoning(capabilities) ?? thinking.reasoning;
    const supportedFields = [
      ...readStringArrayFrom(record, ["supported_parameters", "supportedParameters"]),
      ...readStringArrayFrom(record, ["supported_features", "supportedFeatures"]),
    ].map((value) => value.toLowerCase());
    const tools =
      readBoolean(record.tools) ??
      readBoolean(capabilities.tools) ??
      readCapabilitySupported(capabilities.tools) ??
      readCapabilitySupported(capabilities.tool_use) ??
      readCapabilitySupported(capabilities.toolUse) ??
      (supportedFields.some((value) =>
        ["tools", "tool_choice", "parallel_tool_calls"].includes(value),
      )
        ? true
        : undefined);
    const json =
      readBoolean(record.json) ??
      readBoolean(capabilities.json) ??
      readCapabilitySupported(capabilities.json) ??
      readCapabilitySupported(capabilities.structured_outputs) ??
      readCapabilitySupported(capabilities.structuredOutputs) ??
      (supportedFields.some((value) =>
        ["response_format", "structured_outputs", "json_schema", "json_mode"].includes(value),
      )
        ? true
        : undefined);
    const audio =
      readBoolean(record.audio) ??
      readBoolean(capabilities.audio) ??
      readCapabilitySupported(capabilities.audio) ??
      (modalitySet.has("audio") ? true : undefined);
    const video =
      readBoolean(record.video) ??
      readBoolean(capabilities.video) ??
      readCapabilitySupported(capabilities.video) ??
      (modalitySet.has("video") ? true : undefined);
    const speech =
      readBoolean(record.speech) ??
      readBoolean(capabilities.speech) ??
      readCapabilitySupported(capabilities.speech) ??
      (modalitySet.has("speech") || modalitySet.has("tts") || modalitySet.has("voice")
        ? true
        : undefined);
    const contextWindow = readPositiveNumberFrom(record, [
      "contextWindow",
      "context_window",
      "context_length",
      "max_model_len",
      "max_context_length",
      "max_input_tokens",
      "maxInputTokens",
      "inputTokenLimit",
      "input_token_limit",
    ]);
    const maxTokens = readPositiveNumberFrom(record, [
      "maxTokens",
      "max_tokens",
      "max_output_tokens",
      "max_output_length",
      "maxOutputTokens",
      "outputTokenLimit",
      "max_completion_tokens",
    ]);
    return [
      {
        id: normalizeProviderModelId(id),
        ...(input ? { input } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(json !== undefined ? { json } : {}),
        ...(audio !== undefined ? { audio } : {}),
        ...(video !== undefined ? { video } : {}),
        ...(speech !== undefined ? { speech } : {}),
        ...(thinking.thinkingLevels?.length ? { thinkingLevels: thinking.thinkingLevels } : {}),
        ...(thinking.defaultThinkingLevel
          ? { defaultThinkingLevel: thinking.defaultThinkingLevel }
          : {}),
        ...(thinking.thinkingMode ? { thinkingMode: thinking.thinkingMode } : {}),
        ...(thinking.reasoningBudgetSupported !== undefined
          ? { reasoningBudgetSupported: thinking.reasoningBudgetSupported }
          : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        source: "catalog",
      },
    ];
  });
  const byId = new Map(models.map((model) => [model.id.toLowerCase(), model]));
  return normalizeModelIds(models.map((model) => model.id)).map(
    (id) => byId.get(id.toLowerCase()) ?? { id },
  );
}

export function parseVercelAiGatewayModelIdsFromModelsResponse(payload: unknown): string[] {
  return parseOpenRouterModelIdsFromModelsResponse(payload);
}

export function parseOpencodeZenModelIdsFromModelsResponse(payload: unknown): string[] {
  return parseOpenRouterModelIdsFromModelsResponse(payload);
}

export function parseHuggingfaceModelIdsFromModelsResponse(payload: unknown): string[] {
  return parseHuggingfaceModelSnapshotsFromModelsResponse(payload).map((model) => model.id);
}

function normalizeVeniceThinkingLevels(values: string[]): ModelThinkingLevel[] {
  const seen = new Set<ModelThinkingLevel>();
  const levels: ModelThinkingLevel[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase() === "none" ? "off" : value.toLowerCase();
    const level =
      normalized === "off" ||
      normalized === "minimal" ||
      normalized === "low" ||
      normalized === "medium" ||
      normalized === "high" ||
      normalized === "xhigh"
        ? normalized
        : normalized === "max"
          ? "xhigh"
          : undefined;
    if (!level || seen.has(level)) {
      continue;
    }
    seen.add(level);
    levels.push(level);
  }
  return levels;
}

export function parseVeniceModelSnapshotsFromModelsResponse(
  payload: unknown,
): ProviderRefreshModelSnapshot[] {
  const rawEntries =
    payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray(payload)
        ? payload
        : [];
  const models = rawEntries.flatMap((entry): ProviderRefreshModelSnapshot[] => {
    if (typeof entry === "string") {
      return [{ id: entry, source: "catalog" }];
    }
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const id = readString(record.id);
    if (!id) {
      return [];
    }
    const spec = asRecord(record.model_spec);
    const capabilities = asRecord(spec.capabilities);
    const input: Array<"text" | "image"> = ["text"];
    const vision = readBoolean(capabilities.supportsVision);
    if (vision === true) {
      input.push("image");
    }
    const reasoning = readBoolean(capabilities.supportsReasoning);
    const supportsReasoningEffort = readBoolean(capabilities.supportsReasoningEffort);
    const thinkingLevels =
      supportsReasoningEffort === true
        ? normalizeVeniceThinkingLevels(asStringArray(capabilities.reasoningEffortOptions))
        : [];
    const defaultThinkingLevel =
      thinkingLevels.length > 0
        ? normalizeVeniceThinkingLevels([readString(capabilities.defaultReasoningEffort) ?? ""])[0]
        : undefined;
    const contextWindow =
      readPositiveNumber(record.context_length) ??
      readPositiveNumber(spec.availableContextTokens) ??
      readPositiveNumber(spec.available_context_tokens);
    const maxTokens =
      readPositiveNumber(spec.maxCompletionTokens) ??
      readPositiveNumber(spec.max_completion_tokens) ??
      readPositiveNumber(record.max_tokens);
    const audio = readBoolean(capabilities.supportsAudioInput);
    const video = readBoolean(capabilities.supportsVideoInput);
    const speech = readBoolean(capabilities.supportsAudioOutput);
    const tools = readBoolean(capabilities.supportsFunctionCalling);
    const json = readBoolean(capabilities.supportsResponseSchema);
    return [
      {
        id,
        input,
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(json !== undefined ? { json } : {}),
        ...(audio !== undefined ? { audio } : {}),
        ...(video !== undefined ? { video } : {}),
        ...(speech !== undefined ? { speech } : {}),
        ...(thinkingLevels.length > 0 ? { thinkingLevels } : {}),
        ...(defaultThinkingLevel && thinkingLevels.includes(defaultThinkingLevel)
          ? { defaultThinkingLevel }
          : {}),
        ...(thinkingLevels.length > 0 ? { thinkingMode: "generic-reasoning" } : {}),
        ...(supportsReasoningEffort !== undefined ? { reasoningBudgetSupported: false } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        source: "catalog",
      },
    ];
  });
  const byId = new Map(models.map((model) => [model.id.toLowerCase(), model]));
  return normalizeModelIds(models.map((model) => model.id)).map(
    (id) => byId.get(id.toLowerCase()) ?? { id },
  );
}

export function parseVeniceModelIdsFromModelsResponse(payload: unknown): string[] {
  return parseVeniceModelSnapshotsFromModelsResponse(payload).map((model) => model.id);
}

function sortWithPreferredOrder(values: string[], preferred: readonly string[]): string[] {
  const rank = new Map(preferred.map((value, index) => [value, index]));
  return [...values].toSorted((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.localeCompare(right);
  });
}

function selectModelSnapshotsByIds(
  entries: ProviderRefreshModelSnapshot[],
  selectedIds: string[],
  route?: string,
): ProviderRefreshModelSnapshot[] {
  const byId = new Map(entries.map((entry) => [entry.id.toLowerCase(), entry]));
  return selectedIds.map((id) => {
    const model = byId.get(id.toLowerCase()) ?? { id };
    return route ? withCuratedThinkingMetadata(route, model) : model;
  });
}

function selectManifestModelsForNormalUi(
  modelIds: Iterable<string>,
  preferred: readonly string[],
): string[] {
  const allowed = new Set<string>(preferred.map((id) => id.toLowerCase()));
  return sortWithPreferredOrder(
    normalizeModelIds(modelIds).filter((id) => allowed.has(id.toLowerCase())),
    preferred,
  );
}

export function selectOpenAIApiModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return sortWithPreferredOrder(
    normalizeModelIds(modelIds, { lowercase: true }).filter((id) =>
      OPENAI_CURRENT_API_MODEL_RE.test(id),
    ),
    OPENAI_API_MODEL_IDS,
  );
}

export function selectOpenAISignInModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return sortWithPreferredOrder(
    normalizeModelIds(modelIds, { lowercase: true }).filter((id) =>
      OPENAI_CURRENT_SIGN_IN_MODEL_RE.test(id),
    ),
    OPENAI_SIGN_IN_MODEL_IDS,
  );
}

export function selectChutesModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return sortWithPreferredOrder(
    normalizeModelIds(modelIds).filter((id) => CHUTES_CURRENT_NORMAL_UI_MODEL_RE.test(id)),
    CHUTES_MODEL_IDS,
  );
}

export function selectAnthropicModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, ANTHROPIC_MODEL_IDS);
}

export function selectGoogleGeminiModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, GOOGLE_GEMINI_MODEL_IDS);
}

export function selectXaiModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, XAI_MODEL_IDS);
}

export function selectMistralModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, MISTRAL_MODEL_IDS);
}

export function selectMinimaxModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, MINIMAX_MODEL_IDS);
}

export function selectMoonshotModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, MOONSHOT_MODEL_IDS);
}

export function selectKimiCodingModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, KIMI_CODING_MODEL_IDS);
}

export function selectZaiModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, ZAI_MODEL_IDS);
}

export function selectQianfanModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, QIANFAN_MODEL_IDS);
}

export function selectVolcengineModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, VOLCENGINE_MODEL_IDS);
}

export function selectVolcengineCodingModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, VOLCENGINE_CODING_MODEL_IDS);
}

export function selectBytePlusModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, BYTEPLUS_MODEL_IDS);
}

export function selectBytePlusCodingModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, BYTEPLUS_CODING_MODEL_IDS);
}

export function selectQwenModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, QWEN_API_MODEL_IDS);
}

export function selectQwenCodingPlanModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, QWEN_CODING_PLAN_MODEL_IDS);
}

export function selectCopilotProxyModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, COPILOT_PROXY_MODEL_IDS);
}

export function selectXiaomiModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, XIAOMI_MODEL_IDS);
}

export function selectSyntheticModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, SYNTHETIC_MODEL_IDS);
}

export function selectTogetherModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, TOGETHER_MODEL_IDS);
}

export function selectCloudflareAiGatewayModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return selectManifestModelsForNormalUi(modelIds, CLOUDFLARE_AI_GATEWAY_MODEL_IDS);
}

export function selectDynamicProviderModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return normalizeModelIds(modelIds);
}

export function selectLitellmModelsForNormalUi(modelIds: Iterable<string>): string[] {
  const discovered = selectDynamicProviderModelsForNormalUi(modelIds);
  return discovered.length > 0 ? discovered : [...LITELLM_MODEL_IDS];
}

export function selectOpenRouterModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return sortWithPreferredOrder(
    normalizeModelIds(modelIds).filter((id) => OPENROUTER_CURRENT_NORMAL_UI_MODEL_RE.test(id)),
    OPENROUTER_MODEL_IDS,
  );
}

export function selectVercelAiGatewayModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return sortWithPreferredOrder(
    normalizeModelIds(modelIds).filter((id) =>
      VERCEL_AI_GATEWAY_CURRENT_NORMAL_UI_MODEL_RE.test(id),
    ),
    VERCEL_AI_GATEWAY_MODEL_IDS,
  );
}

export function selectOpencodeZenModelsForNormalUi(modelIds: Iterable<string>): string[] {
  return sortWithPreferredOrder(
    normalizeModelIds(modelIds).filter((id) => OPENCODE_ZEN_CURRENT_NORMAL_UI_MODEL_RE.test(id)),
    OPENCODE_ZEN_MODEL_IDS,
  );
}

export function selectHuggingfaceModelsForNormalUi(modelIds: Iterable<string>): string[] {
  const allowed = new Set<string>(HUGGINGFACE_MODEL_IDS);
  return sortWithPreferredOrder(
    normalizeModelIds(modelIds).filter((id) => allowed.has(id)),
    HUGGINGFACE_MODEL_IDS,
  );
}

export function selectVeniceModelsForNormalUi(modelIds: Iterable<string>): string[] {
  const allowed = new Set<string>(VENICE_MODEL_IDS);
  return sortWithPreferredOrder(
    normalizeModelIds(modelIds).filter((id) => allowed.has(id)),
    VENICE_MODEL_IDS,
  );
}

function readEnv(env: ProviderRefreshEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

async function fetchJsonCatalog(params: {
  fetch: typeof fetch;
  url: string;
  headers?: Record<string, string>;
  label: string;
}): Promise<unknown> {
  const response = await params.fetch(params.url, {
    headers: params.headers,
  });
  if (!response.ok) {
    throw new Error(`${params.label} model catalog fetch failed: HTTP ${response.status}`);
  }
  return response.json();
}

function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function optionalBearerHeaders(token: string | undefined): Record<string, string> | undefined {
  const normalized = token?.trim();
  if (!normalized || normalized.toLowerCase() === "n/a") {
    return undefined;
  }
  return bearerHeaders(normalized);
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function appendPath(baseUrl: string, path: string): string {
  const base = trimTrailingSlash(baseUrl);
  if (!base) {
    return "";
  }
  if (base.endsWith(`/${path}`)) {
    return base;
  }
  return `${base}/${path.replace(/^\/+/, "")}`;
}

function resolveSyntheticCatalogModelsUrl(baseUrl: string): string {
  const base = trimTrailingSlash(baseUrl);
  if (!base) {
    return SYNTHETIC_DEFAULT_MODELS_URL;
  }
  if (base.endsWith("/openai/v1")) {
    return appendPath(base, "models");
  }
  if (base.endsWith("/openai")) {
    return appendPath(base, "v1/models");
  }
  if (base.endsWith("/anthropic/v1")) {
    return `${base.slice(0, -"/anthropic/v1".length)}/openai/v1/models`;
  }
  if (base.endsWith("/anthropic")) {
    return `${base.slice(0, -"/anthropic".length)}/openai/v1/models`;
  }
  return appendPath(base, "models");
}

function readBaseUrl(env: ProviderRefreshEnv, names: readonly string[], fallback?: string): string {
  return readEnv(env, names) ?? fallback ?? "";
}

function cloudflareAiGatewayBaseUrl(env: ProviderRefreshEnv): string {
  const explicit = readEnv(env, ["CLOUDFLARE_AI_GATEWAY_BASE_URL"]);
  if (explicit) {
    return explicit;
  }
  const accountId = readEnv(env, ["CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID"]);
  const gatewayId = readEnv(env, ["CLOUDFLARE_AI_GATEWAY_GATEWAY_ID"]);
  if (!accountId || !gatewayId) {
    return "";
  }
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`;
}

function cloudflareAiGatewayHeaders(env: ProviderRefreshEnv, providerKey: string) {
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "x-api-key": providerKey,
  };
  const gatewayAuth = readEnv(env, [
    "CLOUDFLARE_AI_GATEWAY_AUTHORIZATION",
    "CLOUDFLARE_AI_GATEWAY_TOKEN",
  ]);
  if (gatewayAuth) {
    headers["cf-aig-authorization"] = gatewayAuth.toLowerCase().startsWith("bearer ")
      ? gatewayAuth
      : `Bearer ${gatewayAuth}`;
  }
  return headers;
}

export async function fetchOpenAIProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const fetchImpl = params.fetch ?? fetch;
  const response = await fetchImpl(OPENAI_DOCS_MODELS_URL);
  if (!response.ok) {
    throw new Error(`OpenAI docs model fetch failed: HTTP ${response.status}`);
  }
  const html = await response.text();
  const ids = parseOpenAIModelIdsFromDocsHtml(html);
  return {
    providers: {
      [OPENAI_PROVIDER_BRAND_ID]: {
        missing: {
          [OPENAI_CODEX_ROUTE_ID]: {
            reason: "catalog-unsupported",
            detail: "OpenAI public model docs do not verify ChatGPT sign-in route compatibility.",
          },
        },
        routes: {
          [OPENAI_API_ROUTE_ID]: selectOpenAIApiModelsForNormalUi(ids),
        },
      },
    },
  };
}

export async function fetchChutesProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const fetchImpl = params.fetch ?? fetch;
  const response = await fetchImpl(CHUTES_MODELS_URL);
  if (!response.ok) {
    throw new Error(`Chutes model catalog fetch failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = models.map((model) => model.id);
  return {
    providers: {
      [CHUTES_PROVIDER_BRAND_ID]: {
        routes: {
          [CHUTES_ROUTE_ID]: selectModelSnapshotsByIds(
            models,
            selectChutesModelsForNormalUi(ids),
            CHUTES_ROUTE_ID,
          ),
        },
      },
    },
  };
}

export async function fetchAnthropicProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const token = readEnv(params.env ?? process.env, ["ANTHROPIC_API_KEY"]);
  if (!token) {
    return missingProviderRoutes(ANTHROPIC_PROVIDER_BRAND_ID, {
      [ANTHROPIC_ROUTE_ID]: {
        reason: "credential-missing",
        detail: "Set ANTHROPIC_API_KEY or configure an Anthropic API-key auth profile.",
      },
    });
  }
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: ANTHROPIC_MODELS_URL,
    headers: {
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
    },
    label: "Anthropic",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectAnthropicModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [ANTHROPIC_PROVIDER_BRAND_ID]: {
        routes: {
          [ANTHROPIC_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, ANTHROPIC_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchGoogleGeminiProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const env = params.env ?? process.env;
  const apiKey = readEnv(env, ["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
  const oauthToken = readEnv(env, ["GOOGLE_GEMINI_CLI_OAUTH_TOKEN", "GEMINI_CLI_OAUTH_TOKEN"]);
  const fetchImpl = params.fetch ?? fetch;
  const routes: Record<string, ProviderRefreshRouteSnapshot> = {};
  const missing: Record<string, ProviderRefreshMissingSource> = {};
  if (apiKey) {
    const url = new URL(GOOGLE_GEMINI_MODELS_URL);
    url.searchParams.set("key", apiKey);
    const payload = await fetchJsonCatalog({
      fetch: fetchImpl,
      url: String(url),
      label: "Google Gemini",
    });
    const models = parseGenericModelSnapshotsFromModelsResponse(payload);
    const ids = selectGoogleGeminiModelsForNormalUi(models.map((model) => model.id));
    routes[GOOGLE_API_ROUTE_ID] = selectModelSnapshotsByIds(models, ids, GOOGLE_API_ROUTE_ID);
  } else {
    missing[GOOGLE_API_ROUTE_ID] = {
      reason: "credential-missing",
      detail: "Set GEMINI_API_KEY or configure a Google Gemini API-key auth profile.",
    };
  }
  if (oauthToken) {
    const payload = await fetchJsonCatalog({
      fetch: fetchImpl,
      url: GOOGLE_GEMINI_MODELS_URL,
      headers: bearerHeaders(oauthToken),
      label: "Gemini CLI OAuth",
    });
    const models = parseGenericModelSnapshotsFromModelsResponse(payload);
    const ids = selectGoogleGeminiModelsForNormalUi(models.map((model) => model.id));
    routes[GOOGLE_GEMINI_CLI_ROUTE_ID] = selectModelSnapshotsByIds(
      models,
      ids,
      GOOGLE_GEMINI_CLI_ROUTE_ID,
    );
  } else {
    missing[GOOGLE_GEMINI_CLI_ROUTE_ID] = {
      reason: "credential-missing",
      detail: "Configure Gemini CLI OAuth or set GOOGLE_GEMINI_CLI_OAUTH_TOKEN.",
    };
  }
  return {
    providers: {
      [GOOGLE_PROVIDER_BRAND_ID]: {
        ...(Object.keys(missing).length ? { missing } : {}),
        routes,
      },
    },
  };
}

export async function fetchXaiProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const token = readEnv(params.env ?? process.env, ["XAI_API_KEY"]);
  if (!token) {
    return missingProviderRoutes(XAI_PROVIDER_BRAND_ID, {
      [XAI_ROUTE_ID]: {
        reason: "credential-missing",
        detail: "Set XAI_API_KEY or configure an xAI API-key auth profile.",
      },
    });
  }
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: XAI_MODELS_URL,
    headers: bearerHeaders(token),
    label: "xAI",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectXaiModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [XAI_PROVIDER_BRAND_ID]: {
        routes: {
          [XAI_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, XAI_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchMistralProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const token = readEnv(params.env ?? process.env, ["MISTRAL_API_KEY"]);
  if (!token) {
    return missingProviderRoutes(MISTRAL_PROVIDER_BRAND_ID, {
      [MISTRAL_ROUTE_ID]: {
        reason: "credential-missing",
        detail: "Set MISTRAL_API_KEY or configure a Mistral API-key auth profile.",
      },
    });
  }
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: MISTRAL_MODELS_URL,
    headers: bearerHeaders(token),
    label: "Mistral AI",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectMistralModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [MISTRAL_PROVIDER_BRAND_ID]: {
        routes: {
          [MISTRAL_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, MISTRAL_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchMinimaxProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const env = params.env ?? process.env;
  const token = readEnv(env, ["MINIMAX_API_KEY"]);
  const portalToken = readEnv(env, ["MINIMAX_PORTAL_OAUTH_TOKEN", "MINIMAX_PORTAL_API_KEY"]);
  const fetchImpl = params.fetch ?? fetch;
  const routes: Record<string, ProviderRefreshRouteSnapshot> = {};
  const missing: Record<string, ProviderRefreshMissingSource> = {};
  if (token) {
    const payload = await fetchJsonCatalog({
      fetch: fetchImpl,
      url: MINIMAX_MODELS_URL,
      headers: bearerHeaders(token),
      label: "MiniMax",
    });
    const models = parseGenericModelSnapshotsFromModelsResponse(payload);
    const ids = selectMinimaxModelsForNormalUi(models.map((model) => model.id));
    routes[MINIMAX_API_ROUTE_ID] = selectModelSnapshotsByIds(models, ids, MINIMAX_API_ROUTE_ID);
    routes[MINIMAX_CN_ROUTE_ID] = selectModelSnapshotsByIds(models, ids, MINIMAX_CN_ROUTE_ID);
  } else {
    missing[MINIMAX_API_ROUTE_ID] = {
      reason: "credential-missing",
      detail: "Set MINIMAX_API_KEY or configure a MiniMax API-key auth profile.",
    };
    missing[MINIMAX_CN_ROUTE_ID] = {
      reason: "credential-missing",
      detail: "Set MINIMAX_API_KEY or configure a MiniMax CN API-key auth profile.",
    };
  }
  if (portalToken) {
    const baseUrl = readBaseUrl(env, ["MINIMAX_PORTAL_BASE_URL"], MINIMAX_PORTAL_DEFAULT_BASE_URL);
    const payload = await fetchJsonCatalog({
      fetch: fetchImpl,
      url: appendPath(baseUrl, "v1/models"),
      headers: bearerHeaders(portalToken),
      label: "MiniMax Portal",
    });
    const models = parseGenericModelSnapshotsFromModelsResponse(payload);
    const ids = selectMinimaxModelsForNormalUi(models.map((model) => model.id));
    routes[MINIMAX_PORTAL_ROUTE_ID] = selectModelSnapshotsByIds(
      models,
      ids,
      MINIMAX_PORTAL_ROUTE_ID,
    );
  } else {
    missing[MINIMAX_PORTAL_ROUTE_ID] = {
      reason: "credential-missing",
      detail: "Configure MiniMax portal OAuth or set MINIMAX_PORTAL_OAUTH_TOKEN.",
    };
  }
  return {
    providers: {
      [MINIMAX_PROVIDER_BRAND_ID]: {
        ...(Object.keys(missing).length ? { missing } : {}),
        routes,
      },
    },
  };
}

export async function fetchMoonshotProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const env = params.env ?? process.env;
  const token = readEnv(env, ["MOONSHOT_API_KEY"]);
  const kimiToken = readEnv(env, ["KIMI_CODING_API_KEY", "KIMI_API_KEY", "KIMICODE_API_KEY"]);
  const fetchImpl = params.fetch ?? fetch;
  const routes: Record<string, ProviderRefreshRouteSnapshot> = {};
  const missing: Record<string, ProviderRefreshMissingSource> = {};
  if (token) {
    const payload = await fetchJsonCatalog({
      fetch: fetchImpl,
      url: MOONSHOT_MODELS_URL,
      headers: bearerHeaders(token),
      label: "Moonshot AI",
    });
    const models = parseGenericModelSnapshotsFromModelsResponse(payload);
    const ids = selectMoonshotModelsForNormalUi(models.map((model) => model.id));
    routes[MOONSHOT_ROUTE_ID] = selectModelSnapshotsByIds(models, ids, MOONSHOT_ROUTE_ID);
  } else {
    missing[MOONSHOT_ROUTE_ID] = {
      reason: "credential-missing",
      detail: "Set MOONSHOT_API_KEY or configure a Moonshot API-key auth profile.",
    };
  }
  if (kimiToken) {
    const baseUrl = readBaseUrl(env, ["KIMI_CODING_BASE_URL"], KIMI_CODING_DEFAULT_BASE_URL);
    const payload = await fetchJsonCatalog({
      fetch: fetchImpl,
      url: appendPath(baseUrl, "v1/models"),
      headers: bearerHeaders(kimiToken),
      label: "Kimi Coding",
    });
    const models = parseGenericModelSnapshotsFromModelsResponse(payload);
    const ids = selectKimiCodingModelsForNormalUi(models.map((model) => model.id));
    routes[KIMI_CODING_ROUTE_ID] = selectModelSnapshotsByIds(models, ids, KIMI_CODING_ROUTE_ID);
  } else {
    missing[KIMI_CODING_ROUTE_ID] = {
      reason: "credential-missing",
      detail: "Set KIMI_CODING_API_KEY or configure a Kimi Coding API-key auth profile.",
    };
  }
  return {
    providers: {
      [MOONSHOT_PROVIDER_BRAND_ID]: {
        ...(Object.keys(missing).length ? { missing } : {}),
        routes,
      },
    },
  };
}

export async function fetchZaiProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const token = readEnv(params.env ?? process.env, ["ZAI_API_KEY", "Z_AI_API_KEY"]);
  if (!token) {
    return missingProviderRoutes(ZAI_PROVIDER_BRAND_ID, {
      [ZAI_ROUTE_ID]: {
        reason: "credential-missing",
        detail: "Set ZAI_API_KEY or configure a Z.AI API-key auth profile.",
      },
    });
  }
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: ZAI_MODELS_URL,
    headers: bearerHeaders(token),
    label: "Z.AI",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectZaiModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [ZAI_PROVIDER_BRAND_ID]: {
        routes: {
          [ZAI_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, ZAI_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchQianfanProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const token = readEnv(params.env ?? process.env, ["QIANFAN_API_KEY"]);
  if (!token) {
    return missingProviderRoutes(QIANFAN_PROVIDER_BRAND_ID, {
      [QIANFAN_ROUTE_ID]: {
        reason: "credential-missing",
        detail: "Set QIANFAN_API_KEY or configure a Qianfan API-key auth profile.",
      },
    });
  }
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: QIANFAN_MODELS_URL,
    headers: bearerHeaders(token),
    label: "Qianfan",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectQianfanModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [QIANFAN_PROVIDER_BRAND_ID]: {
        routes: {
          [QIANFAN_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, QIANFAN_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchVolcengineProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const token = readEnv(params.env ?? process.env, ["VOLCANO_ENGINE_API_KEY"]);
  if (!token) {
    return missingProviderRoutes(VOLCENGINE_PROVIDER_BRAND_ID, {
      [VOLCENGINE_ROUTE_ID]: {
        reason: "credential-missing",
        detail: "Set VOLCANO_ENGINE_API_KEY or configure a Volcano Engine API-key auth profile.",
      },
      [VOLCENGINE_CODING_ROUTE_ID]: {
        reason: "credential-missing",
        detail: "Set VOLCANO_ENGINE_API_KEY for the Volcano coding route catalog.",
      },
      [VOLCENGINE_PLAN_ROUTE_ID]: {
        reason: "credential-missing",
        detail: "Set VOLCANO_ENGINE_API_KEY for the Volcano plan route catalog.",
      },
    });
  }
  const fetchImpl = params.fetch ?? fetch;
  const [normalPayload, codingPayload] = await Promise.all([
    fetchJsonCatalog({
      fetch: fetchImpl,
      url: VOLCENGINE_MODELS_URL,
      headers: bearerHeaders(token),
      label: "Volcano Engine",
    }),
    fetchJsonCatalog({
      fetch: fetchImpl,
      url: VOLCENGINE_CODING_MODELS_URL,
      headers: bearerHeaders(token),
      label: "Volcano Engine Coding Plan",
    }),
  ]);
  const normalModels = parseGenericModelSnapshotsFromModelsResponse(normalPayload);
  const codingModels = parseGenericModelSnapshotsFromModelsResponse(codingPayload);
  const normalIds = selectVolcengineModelsForNormalUi(normalModels.map((model) => model.id));
  const codingIds = selectVolcengineCodingModelsForNormalUi(codingModels.map((model) => model.id));
  return {
    providers: {
      [VOLCENGINE_PROVIDER_BRAND_ID]: {
        routes: {
          [VOLCENGINE_ROUTE_ID]: selectModelSnapshotsByIds(
            normalModels,
            normalIds,
            VOLCENGINE_ROUTE_ID,
          ),
          [VOLCENGINE_CODING_ROUTE_ID]: selectModelSnapshotsByIds(
            codingModels,
            codingIds,
            VOLCENGINE_CODING_ROUTE_ID,
          ),
          [VOLCENGINE_PLAN_ROUTE_ID]: selectModelSnapshotsByIds(
            codingModels,
            codingIds,
            VOLCENGINE_PLAN_ROUTE_ID,
          ),
        },
      },
    },
  };
}

export async function fetchBytePlusProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const token = readEnv(params.env ?? process.env, ["BYTEPLUS_API_KEY"]);
  if (!token) {
    return missingProviderRoutes(BYTEPLUS_PROVIDER_BRAND_ID, {
      [BYTEPLUS_ROUTE_ID]: {
        reason: "credential-missing",
        detail: "Set BYTEPLUS_API_KEY or configure a BytePlus API-key auth profile.",
      },
      [BYTEPLUS_CODING_ROUTE_ID]: {
        reason: "credential-missing",
        detail: "Set BYTEPLUS_API_KEY for the BytePlus coding route catalog.",
      },
      [BYTEPLUS_PLAN_ROUTE_ID]: {
        reason: "credential-missing",
        detail: "Set BYTEPLUS_API_KEY for the BytePlus plan route catalog.",
      },
    });
  }
  const fetchImpl = params.fetch ?? fetch;
  const [normalPayload, codingPayload] = await Promise.all([
    fetchJsonCatalog({
      fetch: fetchImpl,
      url: BYTEPLUS_MODELS_URL,
      headers: bearerHeaders(token),
      label: "BytePlus",
    }),
    fetchJsonCatalog({
      fetch: fetchImpl,
      url: BYTEPLUS_CODING_MODELS_URL,
      headers: bearerHeaders(token),
      label: "BytePlus Coding Plan",
    }),
  ]);
  const normalModels = parseGenericModelSnapshotsFromModelsResponse(normalPayload);
  const codingModels = parseGenericModelSnapshotsFromModelsResponse(codingPayload);
  const normalIds = selectBytePlusModelsForNormalUi(normalModels.map((model) => model.id));
  const codingIds = selectBytePlusCodingModelsForNormalUi(codingModels.map((model) => model.id));
  return {
    providers: {
      [BYTEPLUS_PROVIDER_BRAND_ID]: {
        routes: {
          [BYTEPLUS_ROUTE_ID]: selectModelSnapshotsByIds(
            normalModels,
            normalIds,
            BYTEPLUS_ROUTE_ID,
          ),
          [BYTEPLUS_CODING_ROUTE_ID]: selectModelSnapshotsByIds(
            codingModels,
            codingIds,
            BYTEPLUS_CODING_ROUTE_ID,
          ),
          [BYTEPLUS_PLAN_ROUTE_ID]: selectModelSnapshotsByIds(
            codingModels,
            codingIds,
            BYTEPLUS_PLAN_ROUTE_ID,
          ),
        },
      },
    },
  };
}

export async function fetchQwenProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const fetchImpl = params.fetch ?? fetch;
  const env = params.env ?? process.env;
  const dashscopeToken = readEnv(env, ["DASHSCOPE_API_KEY", "QWEN_API_KEY"]);
  const codingPlanToken = readEnv(env, ["BAILIAN_CODING_PLAN_API_KEY", "QWEN_CODING_PLAN_API_KEY"]);
  const routes: Record<string, ProviderRefreshRouteSnapshot> = {};
  const missing: Record<string, ProviderRefreshMissingSource> = {};

  if (codingPlanToken) {
    const payload = await fetchJsonCatalog({
      fetch: fetchImpl,
      url: QWEN_CODING_PLAN_MODELS_URL,
      headers: bearerHeaders(codingPlanToken),
      label: "Qwen Coding Plan",
    });
    const models = parseGenericModelSnapshotsFromModelsResponse(payload);
    const ids = selectQwenCodingPlanModelsForNormalUi(models.map((model) => model.id));
    routes[QWEN_CODING_PLAN_ROUTE_ID] = selectModelSnapshotsByIds(
      models,
      ids,
      QWEN_CODING_PLAN_ROUTE_ID,
    );
  } else {
    missing[QWEN_CODING_PLAN_ROUTE_ID] = {
      reason: "credential-missing",
      detail: "Set BAILIAN_CODING_PLAN_API_KEY or configure qwen-coding-plan auth.",
    };
  }

  if (dashscopeToken) {
    const payload = await fetchJsonCatalog({
      fetch: fetchImpl,
      url: QWEN_DASHSCOPE_MODELS_URL,
      headers: bearerHeaders(dashscopeToken),
      label: "Qwen DashScope",
    });
    const models = parseGenericModelSnapshotsFromModelsResponse(payload);
    const ids = selectQwenModelsForNormalUi(models.map((model) => model.id));
    routes[QWEN_API_ROUTE_ID] = selectModelSnapshotsByIds(models, ids, QWEN_API_ROUTE_ID);
  } else {
    missing[QWEN_API_ROUTE_ID] = {
      reason: "credential-missing",
      detail: "Set DASHSCOPE_API_KEY or configure qwen auth.",
    };
  }

  return {
    providers: {
      [QWEN_PROVIDER_BRAND_ID]: {
        ...(Object.keys(routes).length ? { routes } : {}),
        ...(Object.keys(missing).length ? { missing } : {}),
      },
    },
  };
}

export async function fetchCopilotProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const env = params.env ?? process.env;
  const token = readEnv(env, ["COPILOT_PROXY_API_KEY", "COPILOT_PROXY_TOKEN"]);
  const baseUrl = readBaseUrl(env, ["COPILOT_PROXY_BASE_URL"], COPILOT_PROXY_DEFAULT_BASE_URL);
  const hasConfiguredProxy = Boolean(token || readEnv(env, ["COPILOT_PROXY_BASE_URL"]));
  if (!hasConfiguredProxy) {
    return missingProviderRoutes(COPILOT_PROVIDER_BRAND_ID, {
      [COPILOT_PROXY_ROUTE_ID]: {
        reason: "base-url-missing",
        detail:
          "Configure Copilot Proxy or set COPILOT_PROXY_BASE_URL to opt into probing the local proxy.",
      },
    });
  }
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: appendPath(baseUrl, "models"),
    headers: optionalBearerHeaders(token),
    label: "Copilot Proxy",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectCopilotProxyModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [COPILOT_PROVIDER_BRAND_ID]: {
        routes: {
          [COPILOT_PROXY_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, COPILOT_PROXY_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchVllmProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const env = params.env ?? process.env;
  const baseUrl = readBaseUrl(env, ["VLLM_BASE_URL"], VLLM_DEFAULT_BASE_URL);
  const token = readEnv(env, ["VLLM_API_KEY"]);
  if (!token && !readEnv(env, ["VLLM_BASE_URL"])) {
    return missingProviderRoutes(VLLM_PROVIDER_BRAND_ID, {
      [VLLM_ROUTE_ID]: {
        reason: "base-url-missing",
        detail:
          "Set VLLM_BASE_URL or VLLM_API_KEY to opt into probing a local/private vLLM server.",
      },
    });
  }
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: appendPath(baseUrl, "models"),
    headers: token ? bearerHeaders(token) : undefined,
    label: "vLLM",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectDynamicProviderModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [VLLM_PROVIDER_BRAND_ID]: {
        routes: {
          [VLLM_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, VLLM_ROUTE_ID),
        },
      },
    },
  };
}

function resolveOllamaRefreshBaseUrl(value: string): string {
  return trimTrailingSlash(value || OLLAMA_DEFAULT_BASE_URL).replace(/\/v1$/i, "");
}

function resolveLmStudioRefreshBaseUrl(value: string): string {
  const trimmed = trimTrailingSlash(value || LMSTUDIO_DEFAULT_BASE_URL);
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export async function fetchOllamaProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const env = params.env ?? process.env;
  const baseUrl = resolveOllamaRefreshBaseUrl(
    readBaseUrl(env, ["OLLAMA_BASE_URL"], OLLAMA_DEFAULT_BASE_URL),
  );
  const token = readEnv(env, ["OLLAMA_API_KEY"]);
  if (!token && !readEnv(env, ["OLLAMA_BASE_URL"])) {
    return missingProviderRoutes(OLLAMA_PROVIDER_BRAND_ID, {
      [OLLAMA_ROUTE_ID]: {
        reason: "base-url-missing",
        detail:
          "Start local Ollama or set OLLAMA_BASE_URL/OLLAMA_API_KEY before probing the native Ollama API.",
      },
    });
  }
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: appendPath(baseUrl, "api/tags"),
    headers: token && token !== "ollama-local" ? bearerHeaders(token) : undefined,
    label: "Ollama",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectDynamicProviderModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [OLLAMA_PROVIDER_BRAND_ID]: {
        routes: {
          [OLLAMA_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, OLLAMA_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchLmStudioProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const env = params.env ?? process.env;
  const baseUrl = resolveLmStudioRefreshBaseUrl(
    readBaseUrl(env, ["LMSTUDIO_BASE_URL", "LM_STUDIO_BASE_URL"], LMSTUDIO_DEFAULT_BASE_URL),
  );
  const token = readEnv(env, ["LM_API_TOKEN", "LMSTUDIO_API_KEY", "LM_STUDIO_API_KEY"]);
  if (!token && !readEnv(env, ["LMSTUDIO_BASE_URL", "LM_STUDIO_BASE_URL"])) {
    return missingProviderRoutes(LMSTUDIO_PROVIDER_BRAND_ID, {
      [LMSTUDIO_ROUTE_ID]: {
        reason: "base-url-missing",
        detail:
          "Start LM Studio on localhost:1234 or set LMSTUDIO_BASE_URL before probing the local model catalog.",
      },
    });
  }
  const catalogBaseUrl = baseUrl.replace(/\/v1$/i, "");
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: appendPath(catalogBaseUrl, "api/v1/models"),
    headers: token && token !== "lmstudio-local" ? bearerHeaders(token) : undefined,
    label: "LM Studio",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectDynamicProviderModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [LMSTUDIO_PROVIDER_BRAND_ID]: {
        routes: {
          [LMSTUDIO_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, LMSTUDIO_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchLitellmProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const env = params.env ?? process.env;
  const baseUrl = readBaseUrl(env, ["LITELLM_BASE_URL"], LITELLM_DEFAULT_BASE_URL);
  const token = readEnv(env, ["LITELLM_API_KEY"]);
  if (!token && !readEnv(env, ["LITELLM_BASE_URL"])) {
    return missingProviderRoutes(LITELLM_PROVIDER_BRAND_ID, {
      [LITELLM_ROUTE_ID]: {
        reason: "base-url-missing",
        detail: "Set LITELLM_BASE_URL or LITELLM_API_KEY to opt into probing a LiteLLM server.",
      },
    });
  }
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: appendPath(baseUrl, "models"),
    headers: token ? bearerHeaders(token) : undefined,
    label: "LiteLLM",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectLitellmModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [LITELLM_PROVIDER_BRAND_ID]: {
        routes: {
          [LITELLM_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, LITELLM_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchCloudflareAiGatewayProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const env = params.env ?? process.env;
  const token = readEnv(env, ["CLOUDFLARE_AI_GATEWAY_API_KEY"]);
  const baseUrl = cloudflareAiGatewayBaseUrl(env);
  if (!token || !baseUrl) {
    return missingProviderRoutes(CLOUDFLARE_AI_GATEWAY_PROVIDER_BRAND_ID, {
      [CLOUDFLARE_AI_GATEWAY_ROUTE_ID]: {
        reason: token ? "base-url-missing" : "credential-missing",
        detail: token
          ? "Set CLOUDFLARE_AI_GATEWAY_BASE_URL or account/gateway IDs."
          : "Set CLOUDFLARE_AI_GATEWAY_API_KEY or configure Cloudflare AI Gateway credentials.",
      },
    });
  }
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: appendPath(baseUrl, "v1/models"),
    headers: cloudflareAiGatewayHeaders(env, token),
    label: "Cloudflare AI Gateway",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectCloudflareAiGatewayModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [CLOUDFLARE_AI_GATEWAY_PROVIDER_BRAND_ID]: {
        routes: {
          [CLOUDFLARE_AI_GATEWAY_ROUTE_ID]: selectModelSnapshotsByIds(
            models,
            ids,
            CLOUDFLARE_AI_GATEWAY_ROUTE_ID,
          ),
        },
      },
    },
  };
}

export async function fetchCustomProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const env = params.env ?? process.env;
  const baseUrl = readEnv(env, ["CUSTOM_PROVIDER_BASE_URL", "CUSTOM_BASE_URL"]);
  if (!baseUrl) {
    return missingProviderRoutes(CUSTOM_PROVIDER_BRAND_ID, {
      [CUSTOM_PROVIDER_ROUTE_ID]: {
        reason: "base-url-missing",
        detail: "Set CUSTOM_PROVIDER_BASE_URL or configure a Custom Provider base URL.",
      },
    });
  }
  const token = readEnv(env, ["CUSTOM_PROVIDER_API_KEY", "CUSTOM_API_KEY"]);
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: appendPath(baseUrl, "models"),
    headers: token ? bearerHeaders(token) : undefined,
    label: "Custom Provider",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectDynamicProviderModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [CUSTOM_PROVIDER_BRAND_ID]: {
        routes: {
          [CUSTOM_PROVIDER_ROUTE_ID]: selectModelSnapshotsByIds(
            models,
            ids,
            CUSTOM_PROVIDER_ROUTE_ID,
          ),
        },
      },
    },
  };
}

export async function fetchXiaomiProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const env = params.env ?? process.env;
  const token = readEnv(env, ["XIAOMI_API_KEY"]);
  if (!token) {
    return missingProviderRoutes(XIAOMI_PROVIDER_BRAND_ID, {
      [XIAOMI_ROUTE_ID]: {
        reason: "credential-missing",
        detail: "Set XIAOMI_API_KEY or configure a Xiaomi API-key auth profile.",
      },
    });
  }
  const baseUrl = readBaseUrl(env, ["XIAOMI_BASE_URL"]);
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: baseUrl ? appendPath(baseUrl, "models") : XIAOMI_MODELS_URL,
    headers: bearerHeaders(token),
    label: "Xiaomi",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectXiaomiModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [XIAOMI_PROVIDER_BRAND_ID]: {
        routes: {
          [XIAOMI_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, XIAOMI_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchSyntheticProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const env = params.env ?? process.env;
  const token = readEnv(env, ["SYNTHETIC_API_KEY"]);
  const baseUrl = readBaseUrl(env, ["SYNTHETIC_BASE_URL"], SYNTHETIC_DEFAULT_BASE_URL);
  const catalogBaseUrl = readBaseUrl(env, ["SYNTHETIC_CATALOG_BASE_URL"]);
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: catalogBaseUrl
      ? appendPath(catalogBaseUrl, "models")
      : resolveSyntheticCatalogModelsUrl(baseUrl),
    headers: token ? bearerHeaders(token) : undefined,
    label: "Synthetic",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectSyntheticModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [SYNTHETIC_PROVIDER_BRAND_ID]: {
        routes: {
          [SYNTHETIC_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, SYNTHETIC_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchTogetherProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const env = params.env ?? process.env;
  const token = readEnv(env, ["TOGETHER_API_KEY"]);
  if (!token) {
    return missingProviderRoutes(TOGETHER_PROVIDER_BRAND_ID, {
      [TOGETHER_ROUTE_ID]: {
        reason: "credential-missing",
        detail: "Set TOGETHER_API_KEY or configure a Together AI API-key auth profile.",
      },
    });
  }
  const baseUrl = readBaseUrl(env, ["TOGETHER_BASE_URL"]);
  const payload = await fetchJsonCatalog({
    fetch: params.fetch ?? fetch,
    url: baseUrl ? appendPath(baseUrl, "models") : TOGETHER_MODELS_URL,
    headers: bearerHeaders(token),
    label: "Together AI",
  });
  const models = parseGenericModelSnapshotsFromModelsResponse(payload);
  const ids = selectTogetherModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [TOGETHER_PROVIDER_BRAND_ID]: {
        routes: {
          [TOGETHER_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, TOGETHER_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchOpenRouterProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const fetchImpl = params.fetch ?? fetch;
  const response = await fetchImpl(OPENROUTER_MODELS_URL);
  if (!response.ok) {
    throw new Error(`OpenRouter model catalog fetch failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const models = parseOpenRouterModelSnapshotsFromModelsResponse(payload);
  const ids = selectOpenRouterModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [OPENROUTER_PROVIDER_BRAND_ID]: {
        routes: {
          [OPENROUTER_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, OPENROUTER_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchVercelAiGatewayProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const fetchImpl = params.fetch ?? fetch;
  const response = await fetchImpl(VERCEL_AI_GATEWAY_MODELS_URL);
  if (!response.ok) {
    throw new Error(`Vercel AI Gateway model catalog fetch failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const models = parseOpenRouterModelSnapshotsFromModelsResponse(payload);
  const ids = selectVercelAiGatewayModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [VERCEL_AI_GATEWAY_PROVIDER_BRAND_ID]: {
        routes: {
          [VERCEL_AI_GATEWAY_ROUTE_ID]: selectModelSnapshotsByIds(
            models,
            ids,
            VERCEL_AI_GATEWAY_ROUTE_ID,
          ),
        },
      },
    },
  };
}

export async function fetchOpencodeZenProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const fetchImpl = params.fetch ?? fetch;
  const response = await fetchImpl(OPENCODE_ZEN_MODELS_URL);
  if (!response.ok) {
    throw new Error(`OpenCode Zen model catalog fetch failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const models = parseOpenRouterModelSnapshotsFromModelsResponse(payload);
  const ids = selectOpencodeZenModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [OPENCODE_ZEN_PROVIDER_BRAND_ID]: {
        routes: {
          [OPENCODE_ZEN_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, OPENCODE_ZEN_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchHuggingfaceProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const fetchImpl = params.fetch ?? fetch;
  const response = await fetchImpl(HUGGINGFACE_MODELS_URL);
  if (!response.ok) {
    throw new Error(`Hugging Face model catalog fetch failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const models = parseHuggingfaceModelSnapshotsFromModelsResponse(payload);
  const ids = selectHuggingfaceModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [HUGGINGFACE_PROVIDER_BRAND_ID]: {
        routes: {
          [HUGGINGFACE_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, HUGGINGFACE_ROUTE_ID),
        },
      },
    },
  };
}

export async function fetchVeniceProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const fetchImpl = params.fetch ?? fetch;
  const response = await fetchImpl(VENICE_MODELS_URL);
  if (!response.ok) {
    throw new Error(`Venice AI model catalog fetch failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const models = parseVeniceModelSnapshotsFromModelsResponse(payload);
  const ids = selectVeniceModelsForNormalUi(models.map((model) => model.id));
  return {
    providers: {
      [VENICE_PROVIDER_BRAND_ID]: {
        routes: {
          [VENICE_ROUTE_ID]: selectModelSnapshotsByIds(models, ids, VENICE_ROUTE_ID),
        },
      },
    },
  };
}

function fetchStaticUnsupportedProviderRefreshSnapshot(): ProviderRefreshSnapshot {
  return mergeProviderRefreshSnapshots([
    missingProviderRoutes(COPILOT_PROVIDER_BRAND_ID, {
      [GITHUB_COPILOT_ROUTE_ID]: {
        reason: "catalog-unsupported",
        detail:
          "Direct GitHub Copilot model catalog probing is not implemented; configure Copilot Proxy for a probeable /models route.",
      },
    }),
  ]);
}

function mergeProviderRefreshSnapshots(
  snapshots: ProviderRefreshSnapshot[],
): ProviderRefreshSnapshot {
  const providers: NonNullable<ProviderRefreshSnapshot["providers"]> = {};
  for (const snapshot of snapshots) {
    for (const [providerId, provider] of Object.entries(snapshot.providers ?? {})) {
      const existing = providers[providerId] ?? {};
      providers[providerId] = {
        ...existing,
        ...(provider.models ? { models: provider.models } : {}),
        ...(provider.missing
          ? {
              missing: {
                ...existing.missing,
                ...provider.missing,
              },
            }
          : {}),
        routes: {
          ...existing.routes,
          ...provider.routes,
        },
      };
    }
  }
  return { providers };
}

export async function fetchOfficialProviderRefreshSnapshot(
  params: {
    fetch?: typeof fetch;
    env?: ProviderRefreshEnv;
  } = {},
): Promise<ProviderRefreshSnapshot> {
  const fetchImpl = params.fetch ?? fetch;
  const [
    openai,
    chutes,
    anthropic,
    google,
    xai,
    mistral,
    volcengine,
    byteplus,
    minimax,
    moonshot,
    qwen,
    copilot,
    xiaomi,
    synthetic,
    together,
    openrouter,
    zai,
    qianfan,
    vercelAiGateway,
    opencodeZen,
    ollama,
    lmstudio,
    vllm,
    litellm,
    cloudflareAiGateway,
    custom,
    huggingface,
    venice,
    staticUnsupported,
  ] = await Promise.all([
    fetchOpenAIProviderRefreshSnapshot({ fetch: fetchImpl }),
    fetchChutesProviderRefreshSnapshot({ fetch: fetchImpl }),
    fetchAnthropicProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchGoogleGeminiProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchXaiProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchMistralProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchVolcengineProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchBytePlusProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchMinimaxProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchMoonshotProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchQwenProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchCopilotProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchXiaomiProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchSyntheticProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchTogetherProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchOpenRouterProviderRefreshSnapshot({ fetch: fetchImpl }),
    fetchZaiProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchQianfanProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchVercelAiGatewayProviderRefreshSnapshot({ fetch: fetchImpl }),
    fetchOpencodeZenProviderRefreshSnapshot({ fetch: fetchImpl }),
    fetchOllamaProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchLmStudioProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchVllmProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchLitellmProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchCloudflareAiGatewayProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchCustomProviderRefreshSnapshot({ fetch: fetchImpl, env: params.env }),
    fetchHuggingfaceProviderRefreshSnapshot({ fetch: fetchImpl }),
    fetchVeniceProviderRefreshSnapshot({ fetch: fetchImpl }),
    Promise.resolve(fetchStaticUnsupportedProviderRefreshSnapshot()),
  ]);
  return mergeProviderRefreshSnapshots([
    openai,
    chutes,
    anthropic,
    google,
    xai,
    mistral,
    volcengine,
    byteplus,
    minimax,
    moonshot,
    qwen,
    copilot,
    xiaomi,
    synthetic,
    together,
    openrouter,
    zai,
    qianfan,
    vercelAiGateway,
    opencodeZen,
    ollama,
    lmstudio,
    vllm,
    litellm,
    cloudflareAiGateway,
    custom,
    huggingface,
    venice,
    staticUnsupported,
  ]);
}
