import type { ModelCapabilityConfig, ModelDefinitionConfig } from "../config/types.models.js";
import { BASE_THINKING_LEVELS } from "../shared/model-thinking.js";

export const CLOUDFLARE_AI_GATEWAY_PROVIDER_BRAND_ID = "cloudflare-ai-gateway";
export const CLOUDFLARE_AI_GATEWAY_ROUTE_ID = "cloudflare-ai-gateway";
export const CLOUDFLARE_AI_GATEWAY_PROVIDER_PATH = "anthropic";
export const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID = "claude-sonnet-4-6";
export const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF = `${CLOUDFLARE_AI_GATEWAY_ROUTE_ID}/${CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID}`;

const CLOUDFLARE_AI_GATEWAY_ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const CLOUDFLARE_ANTHROPIC_BASE_CAPABILITY: Pick<ModelCapabilityConfig, "tools" | "json"> = {
  tools: true,
  json: true,
};

const CLOUDFLARE_ANTHROPIC_THINKING = {
  thinkingLevels: [...BASE_THINKING_LEVELS],
  defaultThinkingLevel: "low",
  reasoningBudgetSupported: true,
} satisfies Pick<
  ModelCapabilityConfig,
  "thinkingLevels" | "defaultThinkingLevel" | "reasoningBudgetSupported"
>;

export const CLOUDFLARE_AI_GATEWAY_MODEL_CATALOG = [
  {
    id: CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID,
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: CLOUDFLARE_AI_GATEWAY_ZERO_COST,
    contextWindow: 200_000,
    maxTokens: 64_000,
    capabilities: {
      ...CLOUDFLARE_ANTHROPIC_BASE_CAPABILITY,
      ...CLOUDFLARE_ANTHROPIC_THINKING,
      thinkingMode: "anthropic-adaptive",
    },
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: CLOUDFLARE_AI_GATEWAY_ZERO_COST,
    contextWindow: 200_000,
    maxTokens: 64_000,
    capabilities: {
      ...CLOUDFLARE_ANTHROPIC_BASE_CAPABILITY,
      ...CLOUDFLARE_ANTHROPIC_THINKING,
      thinkingMode: "anthropic-adaptive",
      reasoningBudgetSupported: false,
    },
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: CLOUDFLARE_AI_GATEWAY_ZERO_COST,
    contextWindow: 200_000,
    maxTokens: 64_000,
    capabilities: {
      ...CLOUDFLARE_ANTHROPIC_BASE_CAPABILITY,
      ...CLOUDFLARE_ANTHROPIC_THINKING,
      thinkingMode: "anthropic-thinking-budget",
    },
  },
] satisfies ModelDefinitionConfig[];

export type CloudflareAiGatewayCatalogEntry = (typeof CLOUDFLARE_AI_GATEWAY_MODEL_CATALOG)[number];

export const CLOUDFLARE_AI_GATEWAY_MODEL_IDS = CLOUDFLARE_AI_GATEWAY_MODEL_CATALOG.map(
  (model) => model.id,
);
export const CLOUDFLARE_AI_GATEWAY_MODEL_REFS = CLOUDFLARE_AI_GATEWAY_MODEL_IDS.map(
  (id) => `${CLOUDFLARE_AI_GATEWAY_ROUTE_ID}/${id}`,
);

export function buildCloudflareAiGatewayModelDefinition(params?: {
  id?: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
}): ModelDefinitionConfig {
  const requestedId = params?.id?.trim() || CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID;
  const model =
    CLOUDFLARE_AI_GATEWAY_MODEL_CATALOG.find((entry) => entry.id === requestedId) ??
    CLOUDFLARE_AI_GATEWAY_MODEL_CATALOG[0];
  return {
    id: requestedId,
    name: params?.name ?? model.name,
    api: "anthropic-messages",
    reasoning: params?.reasoning ?? model.reasoning,
    input: params?.input ?? [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    capabilities: model.capabilities ? { ...model.capabilities } : undefined,
  };
}

export function buildCloudflareAiGatewayModelCapabilityOverrides(
  routeId = CLOUDFLARE_AI_GATEWAY_ROUTE_ID,
): Record<string, ModelCapabilityConfig> {
  return Object.fromEntries(
    CLOUDFLARE_AI_GATEWAY_MODEL_CATALOG.map((model) => [
      `${routeId}/${model.id}`.toLowerCase(),
      model.capabilities ? { ...model.capabilities } : {},
    ]),
  );
}

export function resolveCloudflareAiGatewayBaseUrl(params: {
  accountId: string;
  gatewayId: string;
}): string {
  const accountId = params.accountId.trim();
  const gatewayId = params.gatewayId.trim();
  if (!accountId || !gatewayId) {
    return "";
  }
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${CLOUDFLARE_AI_GATEWAY_PROVIDER_PATH}`;
}
