import type { Api, Model } from "@mariozechner/pi-ai";
import type { FasedAgentConfig } from "../config/config.js";
import type {
  ModelCapabilityConfig,
  ModelProviderAuthMode,
  ModelProviderConfig,
} from "../config/types.models.js";
import { lookupRefreshedModelCapability } from "../providers/refreshed-model-capabilities.js";
import { lookupProviderManifestModelCapability } from "../providers/registry.js";
import {
  resolveModelThinkingCapability,
  type ModelThinkingLevel,
  type ModelThinkingMode,
} from "../shared/model-thinking.js";
import { isPrivateNetworkBaseUrl } from "../utils/private-network-url.js";

export type ModelFeature =
  | "text"
  | "vision"
  | "reasoning"
  | "tools"
  | "json"
  | "audio"
  | "video"
  | "speech";

export type ModelCapabilityConfidence = "declared" | "unknown";

export type ModelMetadata = {
  provider: string;
  model: string;
  label: string;
  contextWindow?: number;
  maxTokens?: number;
  features: ModelFeature[];
  thinkingLevels?: ModelThinkingLevel[];
  defaultThinkingLevel?: ModelThinkingLevel;
  thinkingMode?: ModelThinkingMode;
  reasoningBudgetSupported?: boolean;
  streaming: boolean;
  capabilityConfidence: ModelCapabilityConfidence;
  authMode: ModelProviderAuthMode;
  privateNetwork: boolean;
  privateNetworkAllowed: boolean;
  recommended?: boolean;
  default?: boolean;
};

type ModelLike = Pick<
  Model<Api>,
  | "id"
  | "name"
  | "provider"
  | "baseUrl"
  | "api"
  | "reasoning"
  | "input"
  | "contextWindow"
  | "maxTokens"
> & {
  capabilities?: ModelCapabilityConfig;
};

type CatalogModelLike = {
  id: string;
  name?: string;
  provider: string;
  baseUrl?: string;
  api?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  capabilities?: ModelCapabilityConfig;
};

const FEATURE_LABELS: Record<ModelFeature, string> = {
  text: "text",
  vision: "vision",
  reasoning: "reasoning",
  tools: "tools",
  json: "json",
  audio: "audio",
  video: "video",
  speech: "speech",
};

const TOOL_CAPABLE_APIS = new Set([
  "anthropic-messages",
  "github-copilot",
  "google-generative-ai",
  "openai-codex-responses",
  "openai-completions",
  "openai-responses",
]);

const JSON_CAPABLE_APIS = new Set([
  "anthropic-messages",
  "google-generative-ai",
  "openai-codex-responses",
  "openai-completions",
  "openai-responses",
]);

const LOCAL_DYNAMIC_PROVIDERS = new Set(["ollama", "lmstudio", "vllm"]);

function resolveProviderConfig(
  cfg: FasedAgentConfig | undefined,
  provider: string,
): ModelProviderConfig | undefined {
  return cfg?.models?.providers?.[provider];
}

function resolveAuthMode(params: {
  provider: string;
  providerConfig?: ModelProviderConfig;
}): ModelProviderAuthMode {
  if (params.providerConfig?.auth) {
    return params.providerConfig.auth;
  }
  return "api-key";
}

function addFeature(features: ModelFeature[], feature: ModelFeature, enabled: boolean) {
  if (enabled && !features.includes(feature)) {
    features.push(feature);
  }
}

export function deriveModelMetadata(params: {
  model: ModelLike | CatalogModelLike;
  cfg?: FasedAgentConfig;
  providerConfig?: ModelProviderConfig;
  recommended?: boolean;
  default?: boolean;
}): ModelMetadata {
  const provider = params.model.provider.trim();
  const modelId = params.model.id.trim();
  const providerConfig = params.providerConfig ?? resolveProviderConfig(params.cfg, provider);
  const baseUrl = params.model.baseUrl ?? providerConfig?.baseUrl ?? "";
  const api = params.model.api ?? providerConfig?.api;
  const refreshed = lookupRefreshedModelCapability(provider, modelId);
  const manifestCapabilities = lookupProviderManifestModelCapability(provider, modelId);
  const input = refreshed?.input ?? params.model.input ?? ["text"];
  const capabilities =
    manifestCapabilities || params.model.capabilities || refreshed?.capabilities
      ? {
          ...manifestCapabilities,
          ...params.model.capabilities,
          ...refreshed?.capabilities,
        }
      : undefined;
  const capabilityConfidence: ModelCapabilityConfidence =
    capabilities || refreshed || manifestCapabilities ? "declared" : "unknown";
  const shouldInferApiCapabilities = !(
    LOCAL_DYNAMIC_PROVIDERS.has(provider) && capabilityConfidence === "unknown"
  );
  const reasoning = refreshed?.reasoning ?? params.model.reasoning;
  const thinking = resolveModelThinkingCapability({
    provider,
    model: modelId,
    reasoning,
    capabilities,
  });
  const features: ModelFeature[] = [];

  addFeature(features, "text", input.length === 0 || input.includes("text"));
  addFeature(features, "vision", input.includes("image"));
  addFeature(features, "reasoning", thinking !== null || capabilities?.fixedReasoning === true);
  addFeature(
    features,
    "tools",
    capabilities?.tools === true ||
      (shouldInferApiCapabilities &&
        capabilities?.tools === undefined &&
        typeof api === "string" &&
        TOOL_CAPABLE_APIS.has(api)),
  );
  addFeature(
    features,
    "json",
    capabilities?.json === true ||
      (shouldInferApiCapabilities &&
        capabilities?.json === undefined &&
        typeof api === "string" &&
        JSON_CAPABLE_APIS.has(api)),
  );
  addFeature(features, "audio", capabilities?.audio === true);
  addFeature(features, "video", capabilities?.video === true);
  addFeature(features, "speech", capabilities?.speech === true);

  const privateNetwork = baseUrl ? isPrivateNetworkBaseUrl(baseUrl) : false;
  return {
    provider,
    model: modelId,
    label: params.model.name?.trim() || modelId,
    contextWindow:
      typeof refreshed?.contextWindow === "number" && refreshed.contextWindow > 0
        ? refreshed.contextWindow
        : typeof params.model.contextWindow === "number" && params.model.contextWindow > 0
          ? params.model.contextWindow
          : undefined,
    maxTokens:
      typeof refreshed?.maxTokens === "number" && refreshed.maxTokens > 0
        ? refreshed.maxTokens
        : typeof params.model.maxTokens === "number" && params.model.maxTokens > 0
          ? params.model.maxTokens
          : undefined,
    features,
    ...(thinking
      ? {
          thinkingLevels: thinking.thinkingLevels,
          defaultThinkingLevel: thinking.defaultThinkingLevel,
          thinkingMode: thinking.thinkingMode,
          reasoningBudgetSupported: thinking.reasoningBudgetSupported,
        }
      : {}),
    streaming: capabilities?.streaming !== false,
    capabilityConfidence,
    authMode: resolveAuthMode({ provider, providerConfig }),
    privateNetwork,
    privateNetworkAllowed: privateNetwork
      ? providerConfig?.request?.allowPrivateNetwork === true
      : false,
    ...(params.recommended ? { recommended: true } : {}),
    ...(params.default ? { default: true } : {}),
  };
}

export function formatModelFeatureList(
  metadata: Pick<ModelMetadata, "features" | "privateNetwork" | "privateNetworkAllowed">,
): string[] {
  const visible = metadata.features
    .filter((feature) => feature !== "text")
    .map((feature) => FEATURE_LABELS[feature]);
  if (metadata.privateNetwork) {
    visible.push(metadata.privateNetworkAllowed ? "private-net" : "private-net blocked");
  }
  return visible;
}
