import path from "node:path";
import { type Api, type Model } from "@mariozechner/pi-ai";
import { formatCliCommand } from "../cli/command-format.js";
import type { FasedAgentConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.js";
import { getShellEnvAppliedKeys } from "../infra/shell-env.js";
import {
  normalizeOptionalSecretInput,
  normalizeSecretInput,
} from "../utils/normalize-secret-input.js";
import {
  type AuthProfileStore,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
  resolveAuthStorePathForDisplay,
} from "./auth-profiles.js";
import { normalizeProviderId } from "./model-selection.js";

export { ensureAuthProfileStore, resolveAuthProfileOrder } from "./auth-profiles.js";

function resolveProviderConfig(
  cfg: FasedAgentConfig | undefined,
  provider: string,
): ModelProviderConfig | undefined {
  const providers = cfg?.models?.providers ?? {};
  const direct = providers[provider] as ModelProviderConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeProviderId(provider);
  if (normalized === provider) {
    const matched = Object.entries(providers).find(
      ([key]) => normalizeProviderId(key) === normalized,
    );
    return matched?.[1];
  }
  return (
    (providers[normalized] as ModelProviderConfig | undefined) ??
    Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1]
  );
}

export function getCustomProviderApiKey(
  cfg: FasedAgentConfig | undefined,
  provider: string,
): string | undefined {
  const entry = resolveProviderConfig(cfg, provider);
  return normalizeOptionalSecretInput(entry?.apiKey);
}

export type ResolvedProviderAuth = {
  apiKey?: string;
  profileId?: string;
  source: string;
  mode: "api-key" | "oauth" | "token" | "aws-sdk";
};

export async function resolveApiKeyForProvider(params: {
  provider: string;
  cfg?: FasedAgentConfig;
  profileId?: string;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
}): Promise<ResolvedProviderAuth> {
  const { provider, cfg, profileId, preferredProfile } = params;
  const store = params.store ?? ensureAuthProfileStore(params.agentDir);

  if (profileId) {
    const resolved = await resolveApiKeyForProfile({
      cfg,
      store,
      profileId,
      agentDir: params.agentDir,
    });
    if (!resolved) {
      throw new Error(`No credentials found for profile "${profileId}".`);
    }
    const mode = store.profiles[profileId]?.type;
    return {
      apiKey: resolved.apiKey,
      profileId,
      source: `profile:${profileId}`,
      mode: mode === "oauth" ? "oauth" : mode === "token" ? "token" : "api-key",
    };
  }

  const order = resolveAuthProfileOrder({
    cfg,
    store,
    provider,
    preferredProfile,
  });
  for (const candidate of order) {
    try {
      const resolved = await resolveApiKeyForProfile({
        cfg,
        store,
        profileId: candidate,
        agentDir: params.agentDir,
      });
      if (resolved) {
        const mode = store.profiles[candidate]?.type;
        return {
          apiKey: resolved.apiKey,
          profileId: candidate,
          source: `profile:${candidate}`,
          mode: mode === "oauth" ? "oauth" : mode === "token" ? "token" : "api-key",
        };
      }
    } catch {}
  }

  const envResolved = resolveEnvApiKey(provider);
  if (envResolved) {
    return {
      apiKey: envResolved.apiKey,
      source: envResolved.source,
      mode: envResolved.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key",
    };
  }

  const customKey = getCustomProviderApiKey(cfg, provider);
  if (customKey) {
    return { apiKey: customKey, source: "models.json", mode: "api-key" };
  }

  if (provider === "openai") {
    const hasCodex = listProfilesForProvider(store, "openai-codex").length > 0;
    if (hasCodex) {
      throw new Error(
        'No API key found for provider "openai". You are authenticated with OpenAI sign-in on the legacy openai-codex route. Use openai-codex/gpt-5.5 or set OPENAI_API_KEY to use openai/gpt-5.5.',
      );
    }
  }

  const authStorePath = resolveAuthStorePathForDisplay(params.agentDir);
  const resolvedAgentDir = path.dirname(authStorePath);
  throw new Error(
    [
      `No API key found for provider "${provider}".`,
      `Auth store: ${authStorePath} (agentDir: ${resolvedAgentDir}).`,
      `Configure auth for this agent (${formatCliCommand("fased agents add <id>")}) or copy auth-profiles.json from the main agentDir.`,
    ].join(" "),
  );
}

export type EnvApiKeyResult = { apiKey: string; source: string };
export type ModelAuthMode = "api-key" | "oauth" | "token" | "mixed" | "aws-sdk" | "unknown";

export function applyLocalNoAuthHeaderOverride<T extends Model<Api>>(
  model: T,
  auth: ResolvedProviderAuth,
): T {
  const provider = model.provider.toLowerCase();
  const isLocalProvider =
    provider === "ollama" ||
    provider === "lmstudio" ||
    provider === "local" ||
    provider === "local-openai" ||
    provider.includes("local");
  if (!isLocalProvider && !auth.source.toLowerCase().includes("synthetic local key")) {
    return model;
  }
  return {
    ...model,
    headers: {
      ...(model as { headers?: Record<string, unknown> }).headers,
      Authorization: null,
    },
  } as T;
}

export function resolveAwsSdkEnvVarName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
    return "AWS_BEARER_TOKEN_BEDROCK";
  }
  if (env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim()) {
    return "AWS_ACCESS_KEY_ID";
  }
  if (env.AWS_PROFILE?.trim()) {
    return "AWS_PROFILE";
  }
  return undefined;
}

function isAwsSdkProvider(provider: string): boolean {
  const normalized = normalizeProviderId(provider);
  return (
    normalized === "amazon-bedrock" || normalized === "aws-bedrock" || normalized === "bedrock"
  );
}

export function resolveEnvApiKey(provider: string): EnvApiKeyResult | null {
  const normalized = normalizeProviderId(provider);
  const applied = new Set(getShellEnvAppliedKeys());
  const pick = (envVar: string): EnvApiKeyResult | null => {
    const value = normalizeOptionalSecretInput(process.env[envVar]);
    if (!value) {
      return null;
    }
    const source = applied.has(envVar) ? `shell env: ${envVar}` : `env: ${envVar}`;
    return { apiKey: value, source };
  };

  if (normalized === "github-copilot") {
    return pick("COPILOT_GITHUB_TOKEN") ?? pick("GH_TOKEN") ?? pick("GITHUB_TOKEN");
  }

  if (normalized === "anthropic") {
    return pick("ANTHROPIC_OAUTH_TOKEN") ?? pick("ANTHROPIC_API_KEY");
  }

  if (normalized === "chutes") {
    return pick("CHUTES_OAUTH_TOKEN") ?? pick("CHUTES_API_KEY");
  }

  if (normalized === "zai") {
    return pick("ZAI_API_KEY") ?? pick("Z_AI_API_KEY");
  }

  if (normalized === "opencode") {
    return pick("OPENCODE_API_KEY") ?? pick("OPENCODE_ZEN_API_KEY");
  }

  if (normalized === "qwen-coding-plan") {
    return pick("BAILIAN_CODING_PLAN_API_KEY") ?? pick("QWEN_CODING_PLAN_API_KEY");
  }

  if (normalized === "arcee") {
    return pick("ARCEEAI_API_KEY") ?? pick("ARCEE_API_KEY");
  }

  if (normalized === "tencent-tokenhub") {
    return pick("TENCENT_TOKENHUB_API_KEY") ?? pick("TENCENT_API_KEY");
  }

  if (
    normalized === "volcengine" ||
    normalized === "volcengine-coding" ||
    normalized === "volcengine-plan"
  ) {
    return pick("VOLCANO_ENGINE_API_KEY");
  }

  if (
    normalized === "byteplus" ||
    normalized === "byteplus-coding" ||
    normalized === "byteplus-plan"
  ) {
    return pick("BYTEPLUS_API_KEY");
  }
  if (normalized === "minimax-portal") {
    return pick("MINIMAX_OAUTH_TOKEN") ?? pick("MINIMAX_API_KEY");
  }

  if (normalized === "kimi-coding") {
    return pick("KIMI_API_KEY") ?? pick("KIMICODE_API_KEY");
  }

  if (normalized === "huggingface") {
    return pick("HUGGINGFACE_HUB_TOKEN") ?? pick("HF_TOKEN");
  }

  if (normalized === "ollama") {
    return pick("OLLAMA_API_KEY");
  }

  if (normalized === "lmstudio") {
    return pick("LM_API_TOKEN") ?? pick("LMSTUDIO_API_KEY") ?? pick("LM_STUDIO_API_KEY");
  }

  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
    voyage: "VOYAGE_API_KEY",
    deepgram: "DEEPGRAM_API_KEY",
    xai: "XAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    litellm: "LITELLM_API_KEY",
    "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
    "cloudflare-ai-gateway": "CLOUDFLARE_AI_GATEWAY_API_KEY",
    moonshot: "MOONSHOT_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    fireworks: "FIREWORKS_API_KEY",
    "stepfun-plan": "STEPFUN_API_KEY",
    minimax: "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_API_KEY",
    xiaomi: "XIAOMI_API_KEY",
    synthetic: "SYNTHETIC_API_KEY",
    venice: "VENICE_API_KEY",
    mistral: "MISTRAL_API_KEY",
    nvidia: "NVIDIA_API_KEY",
    opencode: "OPENCODE_API_KEY",
    together: "TOGETHER_API_KEY",
    qianfan: "QIANFAN_API_KEY",
    qwen: "DASHSCOPE_API_KEY",
    vllm: "VLLM_API_KEY",
  };
  const envVar = envMap[normalized];
  if (!envVar) {
    return null;
  }
  return pick(envVar);
}

export function resolveModelAuthMode(
  provider?: string,
  cfg?: FasedAgentConfig,
  store?: AuthProfileStore,
): ModelAuthMode | undefined {
  const resolved = provider?.trim();
  if (!resolved) {
    return undefined;
  }

  const authOverride = resolveProviderConfig(cfg, resolved)?.auth;
  if (authOverride === "aws-sdk") {
    return "aws-sdk";
  }

  const authStore = store ?? ensureAuthProfileStore();
  const profiles = listProfilesForProvider(authStore, resolved);
  if (profiles.length > 0) {
    const modes = new Set(
      profiles
        .map((id) => authStore.profiles[id]?.type)
        .filter((mode): mode is "api_key" | "oauth" | "token" => Boolean(mode)),
    );
    const distinct = ["oauth", "token", "api_key"].filter((k) =>
      modes.has(k as "oauth" | "token" | "api_key"),
    );
    if (distinct.length >= 2) {
      return "mixed";
    }
    if (modes.has("oauth")) {
      return "oauth";
    }
    if (modes.has("token")) {
      return "token";
    }
    if (modes.has("api_key")) {
      return "api-key";
    }
  }

  const envKey = resolveEnvApiKey(resolved);
  if (envKey?.apiKey) {
    return envKey.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key";
  }

  if (getCustomProviderApiKey(cfg, resolved)) {
    return "api-key";
  }

  if (isAwsSdkProvider(resolved)) {
    return "aws-sdk";
  }

  return "unknown";
}

export async function getApiKeyForModel(params: {
  model: Model<Api>;
  cfg?: FasedAgentConfig;
  profileId?: string;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
}): Promise<ResolvedProviderAuth> {
  return resolveApiKeyForProvider({
    provider: params.model.provider,
    cfg: params.cfg,
    profileId: params.profileId,
    preferredProfile: params.preferredProfile,
    store: params.store,
    agentDir: params.agentDir,
  });
}

export function requireApiKey(auth: ResolvedProviderAuth, provider: string): string {
  const key = normalizeSecretInput(auth.apiKey);
  if (key) {
    return key;
  }
  throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth.mode}).`);
}
