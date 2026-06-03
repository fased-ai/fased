import type { FasedAgentConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  buildLitellmModelDefinition as buildSharedLitellmModelDefinition,
  LITELLM_BASE_URL,
  LITELLM_DEFAULT_MODEL_ID,
  LITELLM_DEFAULT_MODEL_REF,
  LITELLM_MODEL_CATALOG,
} from "../providers/litellm-models.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
} from "./onboard-auth.config-shared.js";

export { LITELLM_BASE_URL, LITELLM_DEFAULT_MODEL_ID };

function buildLitellmModelDefinition(): ModelDefinitionConfig {
  return buildSharedLitellmModelDefinition(LITELLM_MODEL_CATALOG[0]);
}

export function applyLitellmProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[LITELLM_DEFAULT_MODEL_REF] = {
    ...models[LITELLM_DEFAULT_MODEL_REF],
    alias: models[LITELLM_DEFAULT_MODEL_REF]?.alias ?? "LiteLLM proxy default",
  };

  const defaultModel = buildLitellmModelDefinition();

  const existingProvider = cfg.models?.providers?.litellm as { baseUrl?: unknown } | undefined;
  const resolvedBaseUrl =
    typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "litellm",
    api: "openai-completions",
    baseUrl: resolvedBaseUrl || LITELLM_BASE_URL,
    defaultModel,
    defaultModelId: LITELLM_DEFAULT_MODEL_ID,
  });
}

export function applyLitellmConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyLitellmProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, LITELLM_DEFAULT_MODEL_REF);
}
