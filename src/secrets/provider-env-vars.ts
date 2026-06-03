import { resolveProviderAuthAliasMap } from "../agents/provider-auth-aliases.js";
import type { FasedAgentConfig } from "../config/config.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";

const CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY"],
  chutes: ["CHUTES_API_KEY", "CHUTES_OAUTH_TOKEN"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY", "KIMICODE_API_KEY"],
  synthetic: ["SYNTHETIC_API_KEY"],
  venice: ["VENICE_API_KEY"],
  zai: ["ZAI_API_KEY", "Z_AI_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
  litellm: ["LITELLM_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  opencode: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  huggingface: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
  qianfan: ["QIANFAN_API_KEY"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  volcengine: ["VOLCANO_ENGINE_API_KEY"],
  "volcengine-coding": ["VOLCANO_ENGINE_API_KEY"],
  "volcengine-plan": ["VOLCANO_ENGINE_API_KEY"],
  byteplus: ["BYTEPLUS_API_KEY"],
  "byteplus-coding": ["BYTEPLUS_API_KEY"],
  "byteplus-plan": ["BYTEPLUS_API_KEY"],
} as const;

export type ProviderEnvVarLookupParams = {
  config?: FasedAgentConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
};

function appendUniqueEnvVarCandidates(
  target: Record<string, string[]>,
  providerId: string,
  keys: readonly string[],
) {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId || keys.length === 0) {
    return;
  }
  const bucket = (target[normalizedProviderId] ??= []);
  const seen = new Set(bucket);
  for (const key of keys) {
    const normalizedKey = key.trim();
    if (!normalizedKey || seen.has(normalizedKey)) {
      continue;
    }
    seen.add(normalizedKey);
    bucket.push(normalizedKey);
  }
}

function resolveProviderEnvVarCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, string[]> {
  const candidates: Record<string, string[]> = Object.create(null) as Record<string, string[]>;

  for (const [providerId, keys] of Object.entries(CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES)) {
    appendUniqueEnvVarCandidates(candidates, providerId, keys);
  }

  const registry = loadPluginManifestRegistry({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
  });
  for (const plugin of registry.plugins) {
    if (!plugin.providerAuthEnvVars) {
      continue;
    }
    for (const [providerId, keys] of Object.entries(plugin.providerAuthEnvVars).toSorted(
      ([left], [right]) => left.localeCompare(right),
    )) {
      appendUniqueEnvVarCandidates(candidates, providerId, keys);
    }
  }

  const aliases = resolveProviderAuthAliasMap(params);
  for (const [alias, target] of Object.entries(aliases).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const keys = candidates[target];
    if (keys) {
      appendUniqueEnvVarCandidates(candidates, alias, keys);
    }
  }

  return candidates;
}

export function resolveProviderEnvVars(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return resolveProviderEnvVarCandidates(params);
}

export const PROVIDER_ENV_VARS: Record<string, readonly string[]> = {
  ...resolveProviderEnvVars(),
};

export function getProviderEnvVars(
  providerId: string,
  params?: ProviderEnvVarLookupParams,
): string[] {
  const providerEnvVars = resolveProviderEnvVars(params);
  const envVars = Object.hasOwn(providerEnvVars, providerId)
    ? providerEnvVars[providerId]
    : undefined;
  return Array.isArray(envVars) ? [...envVars] : [];
}

export function listKnownProviderAuthEnvVarNames(params?: ProviderEnvVarLookupParams): string[] {
  return [...new Set(Object.values(resolveProviderEnvVars(params)).flatMap((keys) => keys))];
}

export function listKnownSecretEnvVarNames(params?: ProviderEnvVarLookupParams): string[] {
  return listKnownProviderAuthEnvVarNames(params);
}
