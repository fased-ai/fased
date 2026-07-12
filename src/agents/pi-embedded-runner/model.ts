import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { FasedAgentConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.js";
import { isOpenAISignInRuntimeModelSupported } from "../../providers/registry.js";
import { isPrivateNetworkBaseUrl } from "../../utils/private-network-url.js";
import { resolveFasedAgentAgentDir } from "../agent-paths.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { normalizeModelCompat } from "../model-compat.js";
import { resolveForwardCompatModel } from "../model-forward-compat.js";
import { normalizeProviderId } from "../model-selection.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
import {
  attachModelProviderRequestTransport,
  sanitizeConfiguredModelProviderRequest,
} from "../provider-request-config.js";

type ConfiguredModelProviderRequestInput = Parameters<
  typeof sanitizeConfiguredModelProviderRequest
>[0];

type InlineModelEntry = ModelDefinitionConfig & {
  provider: string;
  baseUrl?: string;
  request?: unknown;
};
type InlineProviderConfig = {
  baseUrl?: string;
  api?: ModelDefinitionConfig["api"];
  request?: unknown;
  models?: ModelDefinitionConfig[];
};

export { buildModelAliasLines };

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export function buildInlineProviderModels(
  providers: Record<string, InlineProviderConfig>,
): InlineModelEntry[] {
  return Object.entries(providers).flatMap(([providerId, entry]) => {
    const trimmed = providerId.trim();
    if (!trimmed) {
      return [];
    }
    return (entry?.models ?? []).map((model) => ({
      ...model,
      provider: trimmed,
      baseUrl: entry?.baseUrl,
      api: model.api ?? entry?.api,
      ...(entry?.request ? { request: entry.request } : {}),
    }));
  });
}

function resolveConfiguredProvider(params: {
  provider: string;
  cfg?: FasedAgentConfig;
}): InlineProviderConfig | undefined {
  const providers = params.cfg?.models?.providers ?? {};
  const direct = providers[params.provider];
  if (direct) {
    return direct;
  }
  const normalizedProvider = normalizeProviderId(params.provider);
  const matched = Object.entries(providers).find(
    ([id]) => normalizeProviderId(id) === normalizedProvider,
  )?.[1];
  return matched;
}

function attachConfiguredProviderRequest<TApi extends Api>(
  model: Model<TApi>,
  cfg?: FasedAgentConfig,
): Model<TApi> {
  const inlineRequest = (model as Model<TApi> & { request?: unknown }).request;
  const configuredProvider = resolveConfiguredProvider({ provider: model.provider, cfg });
  const configuredRequest = inlineRequest ?? configuredProvider?.request;
  const request =
    configuredRequest && typeof configuredRequest === "object"
      ? sanitizeConfiguredModelProviderRequest(
          configuredRequest as ConfiguredModelProviderRequestInput,
        )
      : undefined;
  const baseUrl = model.baseUrl ?? configuredProvider?.baseUrl;
  const privateNetworkFallback =
    !request && isPrivateNetworkBaseUrl(baseUrl) ? { allowPrivateNetwork: false } : undefined;
  return attachModelProviderRequestTransport(model, request ?? privateNetworkFallback);
}

export function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: FasedAgentConfig,
): {
  model?: Model<Api>;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const resolvedAgentDir = agentDir ?? resolveFasedAgentAgentDir();
  const authStorage = discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = discoverModels(authStorage, resolvedAgentDir);
  const normalizedProvider = normalizeProviderId(provider);
  const runtimeModelId = modelId.trim();
  if (
    normalizedProvider === OPENAI_CODEX_PROVIDER_ID &&
    !isOpenAISignInRuntimeModelSupported(runtimeModelId)
  ) {
    return {
      error: `Unsupported OpenAI-Codex sign-in model: ${runtimeModelId}`,
      authStorage,
      modelRegistry,
    };
  }
  const model = modelRegistry.find(provider, runtimeModelId) as Model<Api> | null;

  if (!model) {
    const providers = cfg?.models?.providers ?? {};
    const inlineModels = buildInlineProviderModels(providers);
    const inlineMatch = inlineModels.find(
      (entry) =>
        normalizeProviderId(entry.provider) === normalizedProvider && entry.id === runtimeModelId,
    );
    if (inlineMatch) {
      const normalized = normalizeModelCompat(inlineMatch as Model<Api>);
      return {
        model: attachConfiguredProviderRequest(normalized, cfg),
        authStorage,
        modelRegistry,
      };
    }
    // Forward-compat fallbacks must be checked BEFORE the generic providerCfg fallback.
    // Otherwise, configured providers can default to a generic API and break specific transports.
    const forwardCompat = resolveForwardCompatModel(provider, runtimeModelId, modelRegistry);
    if (forwardCompat) {
      return { model: forwardCompat, authStorage, modelRegistry };
    }
    // OpenRouter is a pass-through proxy — any model ID available on OpenRouter
    // should work without being pre-registered in the local catalog.
    if (normalizedProvider === "openrouter") {
      const fallbackModel: Model<Api> = normalizeModelCompat({
        id: runtimeModelId,
        name: runtimeModelId,
        api: "openai-completions",
        provider,
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: DEFAULT_CONTEXT_TOKENS,
        // Align with OPENROUTER_DEFAULT_MAX_TOKENS in models-config.providers.ts
        maxTokens: 8192,
      } as Model<Api>);
      return {
        model: attachConfiguredProviderRequest(fallbackModel, cfg),
        authStorage,
        modelRegistry,
      };
    }
    const providerCfg = providers[provider];
    if (providerCfg || modelId.startsWith("mock-")) {
      const fallbackModel: Model<Api> = normalizeModelCompat({
        id: runtimeModelId,
        name: runtimeModelId,
        api: providerCfg?.api ?? "openai-responses",
        provider,
        baseUrl: providerCfg?.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: providerCfg?.models?.[0]?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        maxTokens: providerCfg?.models?.[0]?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
      } as Model<Api>);
      return {
        model: attachConfiguredProviderRequest(fallbackModel, cfg),
        authStorage,
        modelRegistry,
      };
    }
    return {
      error: buildUnknownModelError(provider, modelId),
      authStorage,
      modelRegistry,
    };
  }
  return {
    model: attachConfiguredProviderRequest(normalizeModelCompat(model), cfg),
    authStorage,
    modelRegistry,
  };
}

export function resolveModelWithRegistry(params: {
  provider: string;
  modelId: string;
  cfg?: FasedAgentConfig;
  modelRegistry: ModelRegistry;
}): Model<Api> | null {
  const normalizedProvider = normalizeProviderId(params.provider);
  const runtimeModelId = params.modelId.trim();
  const model = params.modelRegistry.find(params.provider, runtimeModelId) as Model<Api> | null;
  if (model) {
    return attachConfiguredProviderRequest(model, params.cfg);
  }
  const inlineModels = buildInlineProviderModels(params.cfg?.models?.providers ?? {});
  const inlineMatch = inlineModels.find(
    (entry) =>
      normalizeProviderId(entry.provider) === normalizedProvider && entry.id === runtimeModelId,
  );
  return inlineMatch
    ? attachConfiguredProviderRequest(normalizeModelCompat(inlineMatch as Model<Api>), params.cfg)
    : null;
}

/**
 * Build a more helpful error when the model is not found.
 *
 * Local providers like vLLM need a dummy API key to be registered. This detects
 * known providers that require opt-in auth and adds a hint.
 *
 * See: https://github.com/fased-ai/fased/issues/17328
 */
const LOCAL_PROVIDER_HINTS: Record<string, string> = {
  ollama:
    "Ollama requires authentication to be registered as a provider. " +
    'Set OLLAMA_API_KEY (any value works) or run "fased configure". ' +
    "See: https://docs.fased.ai/gateway/local-models",
  vllm:
    "vLLM requires authentication to be registered as a provider. " +
    'Set VLLM_API_KEY (any value works) or run "fased configure". ' +
    "See: https://docs.fased.ai/providers/vllm",
  lmstudio:
    "LM Studio must be running and registered as a provider. " +
    'Start LM Studio on localhost:1234 or run "fased configure". ' +
    "See: https://docs.fased.ai/providers/lmstudio",
};

function buildUnknownModelError(provider: string, modelId: string): string {
  const base = `Unknown model: ${provider}/${modelId}`;
  const hint = LOCAL_PROVIDER_HINTS[provider.toLowerCase()];
  return hint ? `${base}. ${hint}` : base;
}
