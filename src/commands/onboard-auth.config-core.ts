import {
  buildChutesModelDefinition,
  CHUTES_BASE_URL,
  CHUTES_DEFAULT_MODEL_REF,
  CHUTES_MODEL_CATALOG,
} from "../agents/chutes-models.js";
import {
  buildHuggingfaceModelDefinition,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_MODEL_CATALOG,
} from "../agents/huggingface-models.js";
import {
  buildKimiCodingProvider,
  buildQwenProvider,
  buildQianfanProvider,
  buildXiaomiProvider,
  QWEN_CODING_PLAN_BASE_URL,
  QWEN_CODING_PLAN_DEFAULT_MODEL_REF,
  QWEN_DASHSCOPE_BASE_URL,
  QWEN_DEFAULT_MODEL_REF,
  QIANFAN_DEFAULT_MODEL_ID,
  XIAOMI_DEFAULT_MODEL_ID,
} from "../agents/models-config.providers.js";
import {
  buildSyntheticModelDefinition,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_DEFAULT_MODEL_REF,
  SYNTHETIC_MODEL_CATALOG,
} from "../agents/synthetic-models.js";
import {
  buildTogetherModelDefinition,
  TOGETHER_BASE_URL,
  TOGETHER_MODEL_CATALOG,
} from "../agents/together-models.js";
import {
  buildVeniceModelDefinition,
  VENICE_BASE_URL,
  VENICE_DEFAULT_MODEL_REF,
  VENICE_MODEL_CATALOG,
} from "../agents/venice-models.js";
import type { FasedAgentConfig } from "../config/config.js";
import type { ModelApi } from "../config/types.models.js";
import {
  HUGGINGFACE_DEFAULT_MODEL_REF,
  MISTRAL_DEFAULT_MODEL_REF,
  OPENROUTER_DEFAULT_MODEL_REF,
  TOGETHER_DEFAULT_MODEL_REF,
  XIAOMI_DEFAULT_MODEL_REF,
  ZAI_DEFAULT_MODEL_REF,
  XAI_DEFAULT_MODEL_REF,
} from "./onboard-auth.credentials.js";
export {
  applyCloudflareAiGatewayConfig,
  applyCloudflareAiGatewayProviderConfig,
  applyVercelAiGatewayConfig,
  applyVercelAiGatewayProviderConfig,
} from "./onboard-auth.config-gateways.js";
export {
  applyLitellmConfig,
  applyLitellmProviderConfig,
  LITELLM_BASE_URL,
  LITELLM_DEFAULT_MODEL_ID,
} from "./onboard-auth.config-litellm.js";
import {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
  applyProviderConfigWithDefaultModel,
  applyProviderConfigWithDefaultModels,
  applyProviderConfigWithModelCatalog,
} from "./onboard-auth.config-shared.js";
import {
  buildMistralModelDefinition,
  buildZaiModelDefinition,
  buildMoonshotModelDefinition,
  buildXaiModelDefinition,
  MISTRAL_BASE_URL,
  MISTRAL_MODEL_CATALOG,
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_REF,
  KIMI_CODING_MODEL_ID,
  KIMI_CODING_MODEL_REF,
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
  MOONSHOT_DEFAULT_MODEL_REF,
  ZAI_DEFAULT_MODEL_ID,
  ZAI_RECOMMENDED_MODEL_IDS,
  resolveZaiBaseUrl,
  XAI_BASE_URL,
  XAI_MODEL_CATALOG,
} from "./onboard-auth.models.js";

export function applyZaiProviderConfig(
  cfg: FasedAgentConfig,
  params?: { endpoint?: string; modelId?: string },
): FasedAgentConfig {
  const modelId = params?.modelId?.trim() || ZAI_DEFAULT_MODEL_ID;
  const modelRef = `zai/${modelId}`;

  const models = { ...cfg.agents?.defaults?.models };
  models[modelRef] = {
    ...models[modelRef],
    alias: models[modelRef]?.alias ?? "GLM",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.zai;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];

  const defaultModels = ZAI_RECOMMENDED_MODEL_IDS.map((id) => buildZaiModelDefinition({ id }));

  const mergedModels = [...existingModels];
  const seen = new Set(existingModels.map((m) => m.id));
  for (const model of defaultModels) {
    if (!seen.has(model.id)) {
      mergedModels.push(model);
      seen.add(model.id);
    }
  }

  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim();

  const baseUrl = params?.endpoint
    ? resolveZaiBaseUrl(params.endpoint)
    : (typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl : "") ||
      resolveZaiBaseUrl();

  providers.zai = {
    ...existingProviderRest,
    baseUrl,
    api: "openai-completions",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : defaultModels,
  };

  return applyOnboardAuthAgentModelsAndProviders(cfg, { agentModels: models, providers });
}

export function applyZaiConfig(
  cfg: FasedAgentConfig,
  params?: { endpoint?: string; modelId?: string },
): FasedAgentConfig {
  const modelId = params?.modelId?.trim() || ZAI_DEFAULT_MODEL_ID;
  const modelRef = modelId === ZAI_DEFAULT_MODEL_ID ? ZAI_DEFAULT_MODEL_REF : `zai/${modelId}`;
  const next = applyZaiProviderConfig(cfg, params);
  return applyAgentDefaultModelPrimary(next, modelRef);
}

export function applyOpenrouterProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[OPENROUTER_DEFAULT_MODEL_REF] = {
    ...models[OPENROUTER_DEFAULT_MODEL_REF],
    alias: models[OPENROUTER_DEFAULT_MODEL_REF]?.alias ?? "OpenRouter",
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
  };
}

export function applyOpenrouterConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyOpenrouterProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, OPENROUTER_DEFAULT_MODEL_REF);
}

export function applyChutesProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[CHUTES_DEFAULT_MODEL_REF] = {
    ...models[CHUTES_DEFAULT_MODEL_REF],
    alias: models[CHUTES_DEFAULT_MODEL_REF]?.alias ?? "Chutes",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "chutes",
    api: "openai-completions",
    baseUrl: CHUTES_BASE_URL,
    catalogModels: CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition),
  });
}

export function applyChutesConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyChutesProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, CHUTES_DEFAULT_MODEL_REF);
}

export function applyMoonshotProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  return applyMoonshotProviderConfigWithBaseUrl(cfg, MOONSHOT_BASE_URL);
}

export function applyMoonshotProviderConfigCn(cfg: FasedAgentConfig): FasedAgentConfig {
  return applyMoonshotProviderConfigWithBaseUrl(cfg, MOONSHOT_CN_BASE_URL);
}

function applyMoonshotProviderConfigWithBaseUrl(
  cfg: FasedAgentConfig,
  baseUrl: string,
): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[MOONSHOT_DEFAULT_MODEL_REF] = {
    ...models[MOONSHOT_DEFAULT_MODEL_REF],
    alias: models[MOONSHOT_DEFAULT_MODEL_REF]?.alias ?? "Kimi",
  };

  const defaultModel = buildMoonshotModelDefinition();

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "moonshot",
    api: "openai-completions",
    baseUrl,
    defaultModel,
    defaultModelId: MOONSHOT_DEFAULT_MODEL_ID,
  });
}

export function applyMoonshotConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyMoonshotProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, MOONSHOT_DEFAULT_MODEL_REF);
}

export function applyMoonshotConfigCn(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyMoonshotProviderConfigCn(cfg);
  return applyAgentDefaultModelPrimary(next, MOONSHOT_DEFAULT_MODEL_REF);
}

export function applyKimiCodeProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[KIMI_CODING_MODEL_REF] = {
    ...models[KIMI_CODING_MODEL_REF],
    alias: models[KIMI_CODING_MODEL_REF]?.alias ?? "Kimi for Coding",
  };

  const defaultModel = buildKimiCodingProvider().models[0];

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "kimi-coding",
    api: "anthropic-messages",
    baseUrl: "https://api.kimi.com/coding/",
    defaultModel,
    defaultModelId: KIMI_CODING_MODEL_ID,
  });
}

export function applyKimiCodeConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyKimiCodeProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, KIMI_CODING_MODEL_REF);
}

export function applySyntheticProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[SYNTHETIC_DEFAULT_MODEL_REF] = {
    ...models[SYNTHETIC_DEFAULT_MODEL_REF],
    alias: models[SYNTHETIC_DEFAULT_MODEL_REF]?.alias ?? "MiniMax M2.5",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.synthetic;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const syntheticModels = SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition);
  const mergedModels = [
    ...existingModels,
    ...syntheticModels.filter(
      (model) => !existingModels.some((existing) => existing.id === model.id),
    ),
  ];
  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim();
  providers.synthetic = {
    ...existingProviderRest,
    baseUrl: SYNTHETIC_BASE_URL,
    api: "anthropic-messages",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : syntheticModels,
  };

  return applyOnboardAuthAgentModelsAndProviders(cfg, { agentModels: models, providers });
}

export function applySyntheticConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applySyntheticProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, SYNTHETIC_DEFAULT_MODEL_REF);
}

export function applyXiaomiProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[XIAOMI_DEFAULT_MODEL_REF] = {
    ...models[XIAOMI_DEFAULT_MODEL_REF],
    alias: models[XIAOMI_DEFAULT_MODEL_REF]?.alias ?? "Xiaomi",
  };
  const defaultProvider = buildXiaomiProvider();
  const resolvedApi = defaultProvider.api ?? "openai-completions";
  return applyProviderConfigWithDefaultModels(cfg, {
    agentModels: models,
    providerId: "xiaomi",
    api: resolvedApi,
    baseUrl: defaultProvider.baseUrl ?? "",
    defaultModels: defaultProvider.models ?? [],
    defaultModelId: XIAOMI_DEFAULT_MODEL_ID,
  });
}

export function applyXiaomiConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyXiaomiProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, XIAOMI_DEFAULT_MODEL_REF);
}

/**
 * Apply Venice provider configuration without changing the default model.
 * Registers Venice models and sets up the provider, but preserves existing model selection.
 */
export function applyVeniceProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[VENICE_DEFAULT_MODEL_REF] = {
    ...models[VENICE_DEFAULT_MODEL_REF],
    alias: models[VENICE_DEFAULT_MODEL_REF]?.alias ?? "GLM 5.1",
  };

  const veniceModels = VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "venice",
    api: "openai-completions",
    baseUrl: VENICE_BASE_URL,
    catalogModels: veniceModels,
  });
}

/**
 * Apply Venice provider configuration AND set Venice as the default model.
 * Use this when Venice is the primary provider choice during onboarding.
 */
export function applyVeniceConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyVeniceProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, VENICE_DEFAULT_MODEL_REF);
}

/**
 * Apply Together provider configuration without changing the default model.
 * Registers Together models and sets up the provider, but preserves existing model selection.
 */
export function applyTogetherProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[TOGETHER_DEFAULT_MODEL_REF] = {
    ...models[TOGETHER_DEFAULT_MODEL_REF],
    alias: models[TOGETHER_DEFAULT_MODEL_REF]?.alias ?? "Together AI",
  };

  const togetherModels = TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition);
  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "together",
    api: "openai-completions",
    baseUrl: TOGETHER_BASE_URL,
    catalogModels: togetherModels,
  });
}

/**
 * Apply Together provider configuration AND set Together as the default model.
 * Use this when Together is the primary provider choice during onboarding.
 */
export function applyTogetherConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyTogetherProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, TOGETHER_DEFAULT_MODEL_REF);
}

/**
 * Apply Hugging Face (Inference Providers) provider configuration without changing the default model.
 */
export function applyHuggingfaceProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[HUGGINGFACE_DEFAULT_MODEL_REF] = {
    ...models[HUGGINGFACE_DEFAULT_MODEL_REF],
    alias: models[HUGGINGFACE_DEFAULT_MODEL_REF]?.alias ?? "Hugging Face",
  };

  const hfModels = HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "huggingface",
    api: "openai-completions",
    baseUrl: HUGGINGFACE_BASE_URL,
    catalogModels: hfModels,
  });
}

/**
 * Apply Hugging Face provider configuration AND set Hugging Face as the default model.
 */
export function applyHuggingfaceConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyHuggingfaceProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, HUGGINGFACE_DEFAULT_MODEL_REF);
}

export function applyXaiProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[XAI_DEFAULT_MODEL_REF] = {
    ...models[XAI_DEFAULT_MODEL_REF],
    alias: models[XAI_DEFAULT_MODEL_REF]?.alias ?? "Grok",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "xai",
    api: "openai-responses",
    baseUrl: XAI_BASE_URL,
    catalogModels: XAI_MODEL_CATALOG.map((entry) => buildXaiModelDefinition(entry.id)),
  });
}

export function applyXaiConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyXaiProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, XAI_DEFAULT_MODEL_REF);
}

export function applyMistralProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[MISTRAL_DEFAULT_MODEL_REF] = {
    ...models[MISTRAL_DEFAULT_MODEL_REF],
    alias: models[MISTRAL_DEFAULT_MODEL_REF]?.alias ?? "Mistral",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "mistral",
    api: "openai-completions",
    baseUrl: MISTRAL_BASE_URL,
    catalogModels: MISTRAL_MODEL_CATALOG.map((entry) => buildMistralModelDefinition(entry.id)),
  });
}

export function applyMistralConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyMistralProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, MISTRAL_DEFAULT_MODEL_REF);
}

function applyQwenProviderConfigWithBaseUrl(
  cfg: FasedAgentConfig,
  params: { providerId: "qwen" | "qwen-coding-plan"; baseUrl: string; defaultModelRef: string },
): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[params.defaultModelRef] = {
    ...models[params.defaultModelRef],
    alias: models[params.defaultModelRef]?.alias ?? "Qwen",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: params.providerId,
    api: "openai-completions",
    baseUrl: params.baseUrl,
    catalogModels: buildQwenProvider(params.baseUrl).models ?? [],
  });
}

export function applyQwenProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  return applyQwenProviderConfigWithBaseUrl(cfg, {
    providerId: "qwen",
    baseUrl: QWEN_DASHSCOPE_BASE_URL,
    defaultModelRef: QWEN_DEFAULT_MODEL_REF,
  });
}

export function applyQwenConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyQwenProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, QWEN_DEFAULT_MODEL_REF);
}

export function applyQwenCodingPlanProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  return applyQwenProviderConfigWithBaseUrl(cfg, {
    providerId: "qwen-coding-plan",
    baseUrl: QWEN_CODING_PLAN_BASE_URL,
    defaultModelRef: QWEN_CODING_PLAN_DEFAULT_MODEL_REF,
  });
}

export function applyQwenCodingPlanConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyQwenCodingPlanProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, QWEN_CODING_PLAN_DEFAULT_MODEL_REF);
}

export function applyAuthProfileConfig(
  cfg: FasedAgentConfig,
  params: {
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
    email?: string;
    preferProfileFirst?: boolean;
  },
): FasedAgentConfig {
  const normalizedProvider = params.provider.toLowerCase();
  const profiles = {
    ...cfg.auth?.profiles,
    [params.profileId]: {
      provider: params.provider,
      mode: params.mode,
      ...(params.email ? { email: params.email } : {}),
    },
  };

  const configuredProviderProfiles = Object.entries(cfg.auth?.profiles ?? {})
    .filter(([, profile]) => profile.provider.toLowerCase() === normalizedProvider)
    .map(([profileId, profile]) => ({ profileId, mode: profile.mode }));

  // Maintain `auth.order` when it already exists. Additionally, if we detect
  // mixed auth modes for the same provider (e.g. legacy oauth + newly selected
  // api_key), create an explicit order to keep the newly selected profile first.
  const existingProviderOrder = cfg.auth?.order?.[params.provider];
  const preferProfileFirst = params.preferProfileFirst ?? true;
  const reorderedProviderOrder =
    existingProviderOrder && preferProfileFirst
      ? [
          params.profileId,
          ...existingProviderOrder.filter((profileId) => profileId !== params.profileId),
        ]
      : existingProviderOrder;
  const hasMixedConfiguredModes = configuredProviderProfiles.some(
    ({ profileId, mode }) => profileId !== params.profileId && mode !== params.mode,
  );
  const derivedProviderOrder =
    existingProviderOrder === undefined && preferProfileFirst && hasMixedConfiguredModes
      ? [
          params.profileId,
          ...configuredProviderProfiles
            .map(({ profileId }) => profileId)
            .filter((profileId) => profileId !== params.profileId),
        ]
      : undefined;
  const order =
    existingProviderOrder !== undefined
      ? {
          ...cfg.auth?.order,
          [params.provider]: reorderedProviderOrder?.includes(params.profileId)
            ? reorderedProviderOrder
            : [...(reorderedProviderOrder ?? []), params.profileId],
        }
      : derivedProviderOrder
        ? {
            ...cfg.auth?.order,
            [params.provider]: derivedProviderOrder,
          }
        : cfg.auth?.order;
  return {
    ...cfg,
    auth: {
      ...cfg.auth,
      profiles,
      ...(order ? { order } : {}),
    },
  };
}

export function applyQianfanProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[QIANFAN_DEFAULT_MODEL_REF] = {
    ...models[QIANFAN_DEFAULT_MODEL_REF],
    alias: models[QIANFAN_DEFAULT_MODEL_REF]?.alias ?? "QIANFAN",
  };
  const defaultProvider = buildQianfanProvider();
  const existingProvider = cfg.models?.providers?.qianfan as
    | {
        baseUrl?: unknown;
        api?: unknown;
      }
    | undefined;
  const existingBaseUrl =
    typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";
  const resolvedBaseUrl = existingBaseUrl || QIANFAN_BASE_URL;
  const resolvedApi =
    typeof existingProvider?.api === "string"
      ? (existingProvider.api as ModelApi)
      : "openai-completions";

  return applyProviderConfigWithDefaultModels(cfg, {
    agentModels: models,
    providerId: "qianfan",
    api: resolvedApi,
    baseUrl: resolvedBaseUrl,
    defaultModels: defaultProvider.models ?? [],
    defaultModelId: QIANFAN_DEFAULT_MODEL_ID,
  });
}

export function applyQianfanConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyQianfanProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, QIANFAN_DEFAULT_MODEL_REF);
}
