import {
  buildCloudflareAiGatewayModelDefinition,
  CLOUDFLARE_AI_GATEWAY_MODEL_CATALOG,
  resolveCloudflareAiGatewayBaseUrl,
} from "../agents/cloudflare-ai-gateway.js";
import type { FasedAgentConfig } from "../config/config.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModels,
} from "./onboard-auth.config-shared.js";
import {
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
} from "./onboard-auth.credentials.js";

export function applyVercelAiGatewayProviderConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF] = {
    ...models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF],
    alias: models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF]?.alias ?? "Vercel AI",
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

export function applyCloudflareAiGatewayProviderConfig(
  cfg: FasedAgentConfig,
  params?: { accountId?: string; gatewayId?: string },
): FasedAgentConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF] = {
    ...models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF],
    alias: models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF]?.alias ?? "Cloudflare AI",
  };

  const defaultModels = CLOUDFLARE_AI_GATEWAY_MODEL_CATALOG.map((entry) =>
    buildCloudflareAiGatewayModelDefinition({ id: entry.id }),
  );
  const existingProvider = cfg.models?.providers?.["cloudflare-ai-gateway"] as
    | { baseUrl?: unknown }
    | undefined;
  const baseUrl =
    params?.accountId && params?.gatewayId
      ? resolveCloudflareAiGatewayBaseUrl({
          accountId: params.accountId,
          gatewayId: params.gatewayId,
        })
      : typeof existingProvider?.baseUrl === "string"
        ? existingProvider.baseUrl
        : undefined;

  if (!baseUrl) {
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

  return applyProviderConfigWithDefaultModels(cfg, {
    agentModels: models,
    providerId: "cloudflare-ai-gateway",
    api: "anthropic-messages",
    baseUrl,
    defaultModels,
  });
}

export function applyVercelAiGatewayConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  const next = applyVercelAiGatewayProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF);
}

export function applyCloudflareAiGatewayConfig(
  cfg: FasedAgentConfig,
  params?: { accountId?: string; gatewayId?: string },
): FasedAgentConfig {
  const next = applyCloudflareAiGatewayProviderConfig(cfg, params);
  return applyAgentDefaultModelPrimary(next, CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF);
}
