import type { Api, Model } from "@mariozechner/pi-ai";
import type { FasedAgentConfig } from "../config/config.js";
import type {
  ModelCapabilityConfig,
  ModelProviderAuthMode,
  ModelProviderConfig,
} from "../config/types.models.js";
import { lookupRefreshedModelCapability } from "../providers/refreshed-model-capabilities.js";
import {
  getProviderBrandManifestForRoute,
  lookupProviderManifestModelCapability,
  providerModelRecommendationRank,
} from "../providers/registry.js";
import {
  resolveModelThinkingCapability,
  type ModelThinkingLevel,
  type ModelThinkingMode,
} from "../shared/model-thinking.js";
import { isPrivateNetworkBaseUrl } from "../utils/private-network-url.js";
import type { ModelCatalogSource } from "./model-catalog-normalized.js";

export type ModelFeature =
  | "text"
  | "vision"
  | "reasoning"
  | "tools"
  | "json"
  | "audio"
  | "video"
  | "speech";

export type ModelCapabilityConfidence = "verified" | "declared" | "inferred" | "unknown";

export type ModelAvailabilitySource =
  | "provider-api"
  | "runtime-catalog"
  | "configured"
  | "provider-plugin"
  | "reviewed-catalog"
  | "curated-recommendation";

export type ModelCapabilitySource =
  | "provider-api"
  | "official-docs"
  | "runtime"
  | "configured"
  | "inferred"
  | "unknown";

export type ModelMetadata = {
  provider: string;
  model: string;
  label: string;
  contextWindow?: number;
  maxTokens?: number;
  apiRoute?: string;
  features: ModelFeature[];
  thinkingLevels?: ModelThinkingLevel[];
  defaultThinkingLevel?: ModelThinkingLevel;
  thinkingMode?: ModelThinkingMode;
  reasoningBudgetSupported?: boolean;
  streaming: boolean;
  capabilityConfidence: ModelCapabilityConfidence;
  capabilitySource: ModelCapabilitySource;
  capabilityRetrievedAt?: string;
  retrievedAt: string;
  availabilitySource: ModelAvailabilitySource;
  authRoute: string;
  authMode: ModelProviderAuthMode;
  privateNetwork: boolean;
  privateNetworkAllowed: boolean;
  recommended?: boolean;
  recommendationRank?: number;
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
  catalogSource?: ModelCatalogSource;
};

function availabilitySourceForCatalogSource(
  source: ModelCatalogSource | undefined,
): ModelAvailabilitySource {
  switch (source) {
    case "provider-api":
      return "provider-api";
    case "runtime":
      return "runtime-catalog";
    case "configured":
      return "configured";
    case "provider-index":
      return "provider-plugin";
    case "manifest":
      return "curated-recommendation";
    case "current-preview":
    default:
      return "reviewed-catalog";
  }
}

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
  catalogSource?: ModelCatalogSource;
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

const LOCAL_DYNAMIC_PROVIDERS = new Set(["ollama", "lmstudio", "vllm", "litellm"]);
const CURATED_CATALOG_REVIEWED_AT = "2026-07-12T00:00:00.000Z";

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
  const providerRoute = params.provider.trim().toLowerCase();
  const method = getProviderBrandManifestForRoute(providerRoute)?.methods.find(
    (entry) =>
      entry.route.trim().toLowerCase() === providerRoute ||
      entry.statusRoute?.trim().toLowerCase() === providerRoute ||
      entry.configProviderId?.trim().toLowerCase() === providerRoute,
  );
  if (method?.kind === "oauth" || method?.kind === "device") {
    return "oauth";
  }
  if (method?.kind === "token") {
    return "token";
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
  capabilitySource?: ModelCapabilitySource;
  capabilityRetrievedAt?: string;
}): ModelMetadata {
  const provider = params.model.provider.trim();
  const modelId = params.model.id.trim();
  const providerConfig = params.providerConfig ?? resolveProviderConfig(params.cfg, provider);
  const baseUrl = params.model.baseUrl ?? providerConfig?.baseUrl ?? "";
  const api = params.model.api ?? providerConfig?.api;
  const refreshed = lookupRefreshedModelCapability(provider, modelId);
  const manifestCapabilities = lookupProviderManifestModelCapability(provider, modelId);
  const input = params.model.input ?? refreshed?.input ?? ["text"];
  const capabilities =
    manifestCapabilities || params.model.capabilities || refreshed?.capabilities
      ? {
          ...refreshed?.capabilities,
          ...manifestCapabilities,
          ...params.model.capabilities,
        }
      : undefined;
  const capabilitySource: ModelCapabilitySource =
    params.capabilitySource ??
    (params.model.capabilities
      ? params.model.catalogSource === "configured"
        ? "configured"
        : "runtime"
      : refreshed
        ? refreshed.source === "catalog" || refreshed.source === "provider-api"
          ? "provider-api"
          : "official-docs"
        : manifestCapabilities
          ? "official-docs"
          : api && !LOCAL_DYNAMIC_PROVIDERS.has(provider)
            ? "inferred"
            : "unknown");
  const capabilityConfidence: ModelCapabilityConfidence =
    capabilitySource === "provider-api" || capabilitySource === "official-docs"
      ? "verified"
      : capabilitySource === "runtime" || capabilitySource === "configured"
        ? "declared"
        : capabilitySource === "inferred"
          ? "inferred"
          : "unknown";
  const shouldInferApiCapabilities = !LOCAL_DYNAMIC_PROVIDERS.has(provider);
  const reasoning = params.model.reasoning ?? refreshed?.reasoning;
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
    ...(typeof api === "string" && api.trim() ? { apiRoute: api.trim() } : {}),
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
    capabilitySource,
    ...((params.capabilityRetrievedAt ??
    refreshed?.refreshedAt ??
    (capabilitySource === "official-docs" ? CURATED_CATALOG_REVIEWED_AT : undefined))
      ? {
          capabilityRetrievedAt:
            params.capabilityRetrievedAt ?? refreshed?.refreshedAt ?? CURATED_CATALOG_REVIEWED_AT,
        }
      : {}),
    retrievedAt: refreshed?.refreshedAt ?? CURATED_CATALOG_REVIEWED_AT,
    availabilitySource: availabilitySourceForCatalogSource(params.model.catalogSource),
    authRoute: provider,
    authMode: resolveAuthMode({ provider, providerConfig }),
    privateNetwork,
    privateNetworkAllowed: privateNetwork
      ? providerConfig?.request?.allowPrivateNetwork === true
      : false,
    ...(params.recommended ? { recommended: true } : {}),
    ...(providerModelRecommendationRank(provider, modelId)
      ? { recommendationRank: providerModelRecommendationRank(provider, modelId) }
      : {}),
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
