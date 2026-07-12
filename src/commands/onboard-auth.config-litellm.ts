import type { FasedAgentConfig } from "../config/config.js";
import { LITELLM_BASE_URL, LITELLM_DEFAULT_MODEL_ID } from "../providers/litellm-models.js";

export { LITELLM_BASE_URL, LITELLM_DEFAULT_MODEL_ID };

export function applyLitellmProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.litellm;
  const resolvedBaseUrl =
    typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";
  providers.litellm = {
    ...existingProvider,
    ...(typeof existingProvider?.apiKey === "string" && existingProvider.apiKey.trim()
      ? { apiKey: existingProvider.apiKey.trim() }
      : {}),
    baseUrl: resolvedBaseUrl || LITELLM_BASE_URL,
    api: "openai-completions",
    request: { ...existingProvider?.request, allowPrivateNetwork: true },
    models: existingProvider?.models ?? [],
  };
  return {
    ...cfg,
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
    },
  };
}

export function applyLitellmConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  return applyLitellmProviderConfig(cfg);
}
