import type { StreamFn } from "@mariozechner/pi-agent-core";
import { normalizeProviderId } from "../agents/provider-id.js";
import type { FasedAgentConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.js";
import {
  createConfiguredOllamaCompatStreamWrapper,
  createConfiguredOllamaStreamFn,
} from "../plugin-sdk/ollama-runtime.js";

type RuntimeContext = {
  provider?: string;
  modelId?: string;
  model?: {
    id?: string;
    api?: string;
    provider?: string;
    baseUrl?: string;
    headers?: unknown;
  };
  streamFn?: StreamFn;
  [key: string]: unknown;
};

type ProviderRuntimeHookParams = {
  provider?: string;
  context?: RuntimeContext;
};

function resolveConfiguredProvider(
  config: FasedAgentConfig | undefined,
  providerId: string | undefined,
): ModelProviderConfig | undefined {
  const providers = config?.models?.providers;
  const trimmed = providerId?.trim();
  if (!providers || !trimmed) {
    return undefined;
  }
  const direct = providers[trimmed];
  if (direct) {
    return direct;
  }
  const normalized = normalizeProviderId(trimmed);
  for (const [candidateId, candidate] of Object.entries(providers)) {
    if (normalizeProviderId(candidateId) === normalized) {
      return candidate;
    }
  }
  return undefined;
}

function isOllamaRuntimeContext(provider: string | undefined, context: RuntimeContext): boolean {
  const providerId = normalizeProviderId(provider ?? context.provider ?? "");
  const modelProvider = normalizeProviderId(String(context.model?.provider ?? ""));
  return context.model?.api === "ollama" || providerId === "ollama" || modelProvider === "ollama";
}

export function resolveProviderStreamFn(params: {
  provider: string;
  config?: FasedAgentConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowRuntimePluginLoad?: boolean;
  context: RuntimeContext;
}): StreamFn | undefined {
  if (!isOllamaRuntimeContext(params.provider, params.context)) {
    return undefined;
  }
  const providerId = params.context.model?.provider ?? params.provider;
  const providerConfig = resolveConfiguredProvider(params.config, providerId);
  return createConfiguredOllamaStreamFn({
    model: params.context.model ?? {},
    providerBaseUrl:
      typeof providerConfig?.baseUrl === "string" ? providerConfig.baseUrl : undefined,
  });
}

export function wrapProviderStreamFn(params: {
  provider: string;
  config?: FasedAgentConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: RuntimeContext;
}): StreamFn | undefined {
  if (!isOllamaRuntimeContext(params.provider, params.context)) {
    return params.context.streamFn;
  }
  return createConfiguredOllamaCompatStreamWrapper({
    provider: params.provider,
    modelId: String(params.context.modelId ?? params.context.model?.id ?? ""),
    model: params.context.model as never,
    streamFn: params.context.streamFn,
    config: params.config,
    thinkingLevel: params.context.thinkingLevel,
    extraParams:
      params.context.extraParams &&
      typeof params.context.extraParams === "object" &&
      !Array.isArray(params.context.extraParams)
        ? (params.context.extraParams as Record<string, unknown>)
        : undefined,
  });
}

export function prepareProviderExtraParams(params: { context: { extraParams?: unknown } }) {
  return params.context.extraParams;
}

export function resolveProviderTransportTurnStateWithPlugin(
  _params?: ProviderRuntimeHookParams,
): { headers?: Record<string, string>; metadata?: Record<string, unknown> } | undefined {
  return undefined;
}

export function resolveProviderWebSocketSessionPolicyWithPlugin(
  _params?: ProviderRuntimeHookParams,
): { headers?: Record<string, string>; degradeCooldownMs?: number } | undefined {
  return undefined;
}

export function resolveProviderBuiltInModelSuppression(_params?: ProviderRuntimeHookParams):
  | {
      suppress?: boolean;
      errorMessage?: string;
    }
  | undefined {
  return undefined;
}

export function resolveProviderModernModelRef(_params?: ProviderRuntimeHookParams) {
  return undefined;
}

export function normalizeProviderModelIdWithPlugin(params?: {
  context?: { modelId?: string };
}): string | undefined {
  return params?.context?.modelId;
}

export function classifyProviderFailoverReasonWithPlugin(_params?: ProviderRuntimeHookParams) {
  return undefined;
}

export function matchesProviderContextOverflowWithPlugin(_params?: ProviderRuntimeHookParams) {
  return false;
}
