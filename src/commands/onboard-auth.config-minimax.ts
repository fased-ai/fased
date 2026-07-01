import type { FasedAgentConfig } from "../config/config.js";
import { toAgentModelListLike } from "../config/model-input.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
} from "./onboard-auth.config-shared.js";
import {
  buildMinimaxApiModelDefinition,
  buildMinimaxModelDefinition,
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_MINIMAX_CONTEXT_WINDOW,
  DEFAULT_MINIMAX_MAX_TOKENS,
  MINIMAX_DEFAULT_MODEL_ID,
  MINIMAX_API_BASE_URL,
  MINIMAX_CN_API_BASE_URL,
  MINIMAX_HOSTED_COST,
  MINIMAX_HOSTED_MODEL_ID,
  MINIMAX_HOSTED_MODEL_REF,
} from "./onboard-auth.models.js";

export function applyMinimaxProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models["anthropic/claude-opus-4-8"] = {
    ...models["anthropic/claude-opus-4-8"],
    alias: models["anthropic/claude-opus-4-8"]?.alias ?? "Opus",
  };
  return applyOnboardAuthAgentModelsAndProviders(cfg, {
    agentModels: models,
    providers: { ...cfg.models?.providers },
  });
}

export function applyMinimaxHostedProviderConfig(
  cfg: FasedAgentConfig,
  params?: { baseUrl?: string },
): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[MINIMAX_HOSTED_MODEL_REF] = {
    ...models[MINIMAX_HOSTED_MODEL_REF],
    alias: models[MINIMAX_HOSTED_MODEL_REF]?.alias ?? "Minimax",
  };

  const providers = { ...cfg.models?.providers };
  const hostedModel = buildMinimaxModelDefinition({
    id: MINIMAX_HOSTED_MODEL_ID,
    cost: MINIMAX_HOSTED_COST,
    contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
  });
  const existingProvider = providers.minimax;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const hasHostedModel = existingModels.some((model) => model.id === MINIMAX_HOSTED_MODEL_ID);
  const mergedModels = hasHostedModel ? existingModels : [...existingModels, hostedModel];
  providers.minimax = {
    ...existingProvider,
    baseUrl: params?.baseUrl?.trim() || DEFAULT_MINIMAX_BASE_URL,
    apiKey: "minimax",
    api: "openai-completions",
    models: mergedModels.length > 0 ? mergedModels : [hostedModel],
  };

  return applyOnboardAuthAgentModelsAndProviders(cfg, { agentModels: models, providers });
}

export function applyMinimaxConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  return applyMinimaxHostedConfig(cfg);
}

export function applyMinimaxHostedConfig(
  cfg: FasedAgentConfig,
  params?: { baseUrl?: string },
): FasedAgentConfig {
  const next = applyMinimaxHostedProviderConfig(cfg, params);
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...toAgentModelListLike(next.agents?.defaults?.model),
          primary: MINIMAX_HOSTED_MODEL_REF,
        },
      },
    },
  };
}

// MiniMax Anthropic-compatible API (platform.minimax.io/anthropic)
export function applyMinimaxApiProviderConfig(
  cfg: FasedAgentConfig,
  modelId: string = MINIMAX_DEFAULT_MODEL_ID,
): FasedAgentConfig {
  return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
    providerId: "minimax",
    modelId,
    baseUrl: MINIMAX_API_BASE_URL,
  });
}

export function applyMinimaxApiConfig(
  cfg: FasedAgentConfig,
  modelId: string = MINIMAX_DEFAULT_MODEL_ID,
): FasedAgentConfig {
  return applyMinimaxApiConfigWithBaseUrl(cfg, {
    providerId: "minimax",
    modelId,
    baseUrl: MINIMAX_API_BASE_URL,
  });
}

// MiniMax China API (api.minimaxi.com)
export function applyMinimaxApiProviderConfigCn(
  cfg: FasedAgentConfig,
  modelId: string = MINIMAX_DEFAULT_MODEL_ID,
): FasedAgentConfig {
  return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
    providerId: "minimax-cn",
    modelId,
    baseUrl: MINIMAX_CN_API_BASE_URL,
  });
}

export function applyMinimaxApiConfigCn(
  cfg: FasedAgentConfig,
  modelId: string = MINIMAX_DEFAULT_MODEL_ID,
): FasedAgentConfig {
  return applyMinimaxApiConfigWithBaseUrl(cfg, {
    providerId: "minimax-cn",
    modelId,
    baseUrl: MINIMAX_CN_API_BASE_URL,
  });
}

type MinimaxApiProviderConfigParams = {
  providerId: string;
  modelId: string;
  baseUrl: string;
};

function applyMinimaxApiProviderConfigWithBaseUrl(
  cfg: FasedAgentConfig,
  params: MinimaxApiProviderConfigParams,
): FasedAgentConfig {
  const providers = { ...cfg.models?.providers } as Record<string, ModelProviderConfig>;
  const existingProvider = providers[params.providerId];
  const existingModels = existingProvider?.models ?? [];
  const apiModel = buildMinimaxApiModelDefinition(params.modelId);
  const hasApiModel = existingModels.some((model) => model.id === params.modelId);
  const mergedModels = hasApiModel ? existingModels : [...existingModels, apiModel];
  const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {
    baseUrl: params.baseUrl,
    models: [],
  };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim() === "minimax" ? "" : resolvedApiKey;
  providers[params.providerId] = {
    ...existingProviderRest,
    baseUrl: params.baseUrl,
    api: "anthropic-messages",
    authHeader: true,
    ...(normalizedApiKey?.trim() ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : [apiModel],
  };

  const models = { ...cfg.agents?.defaults?.models };
  const modelRef = `${params.providerId}/${params.modelId}`;
  models[modelRef] = {
    ...models[modelRef],
    alias: "Minimax",
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
    models: { mode: cfg.models?.mode ?? "merge", providers },
  };
}

function applyMinimaxApiConfigWithBaseUrl(
  cfg: FasedAgentConfig,
  params: MinimaxApiProviderConfigParams,
): FasedAgentConfig {
  const next = applyMinimaxApiProviderConfigWithBaseUrl(cfg, params);
  return applyAgentDefaultModelPrimary(next, `${params.providerId}/${params.modelId}`);
}
