import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ProviderHeaders, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai/compat";
import WebSocket from "ws";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { loadConfig, writeConfigFile, type FasedAgentConfig } from "../../config/config.js";
import { resolveFasedAgentAgentDir } from "../agent-paths.js";
import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
} from "../auth-profiles.js";
import { createOpenAICodexAppServerStreamFn } from "../openai-codex-app-server.js";
import { ensureOpenAICodexRuntimeComponent } from "../openai-codex-runtime-component.js";
import { mergeTransportHeaders } from "../transport-stream-shared.js";
import { log } from "./logger.js";
import {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "./moonshot-stream-wrappers.js";
import { createOpenAIResponsesContextManagementWrapper as createRouteOpenAIResponsesContextManagementWrapper } from "./openai-stream-wrappers.js";

const OPENROUTER_APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://fased.ai",
  "X-Title": "FasedAgent",
};
const ANTHROPIC_CONTEXT_1M_BETA = "context-1m-2025-08-07";
const ANTHROPIC_1M_MODEL_PREFIXES = ["claude-opus-4", "claude-sonnet-4"] as const;
// NOTE: We only force `store=true` for *direct* OpenAI Responses.
// Codex responses (chatgpt.com/backend-api/codex/responses) require `store=false`.

type ProviderRuntimeDeps = {
  prepareProviderExtraParams: (params: {
    provider: string;
    modelId: string;
    config?: FasedAgentConfig;
    context: {
      config?: FasedAgentConfig;
      provider: string;
      modelId: string;
      extraParams?: Record<string, unknown>;
      thinkingLevel?: ThinkLevel;
      model?: object;
      streamFn?: StreamFn;
    };
  }) => Record<string, unknown> | undefined;
  wrapProviderStreamFn: (params: {
    provider: string;
    config?: FasedAgentConfig;
    context: {
      config?: FasedAgentConfig;
      provider: string;
      modelId: string;
      extraParams?: Record<string, unknown>;
      thinkingLevel?: ThinkLevel;
      model?: object;
      agentDir?: string;
      streamFn?: StreamFn;
    };
  }) => StreamFn | undefined;
};

const defaultProviderRuntimeDeps: ProviderRuntimeDeps = {
  prepareProviderExtraParams: ({ context }) => context.extraParams,
  wrapProviderStreamFn: ({ context }) => context.streamFn,
};

const providerRuntimeDeps: ProviderRuntimeDeps = { ...defaultProviderRuntimeDeps };

function sanitizeExtraParams(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) =>
        value !== undefined && key !== "__proto__" && key !== "constructor" && key !== "prototype",
    ),
  );
}

function normalizeExtraParamAliases(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const normalized = sanitizeExtraParams(input);
  if (Object.hasOwn(normalized, "parallelToolCalls")) {
    normalized.parallel_tool_calls = normalized.parallelToolCalls;
    delete normalized.parallelToolCalls;
  }
  if (Object.hasOwn(normalized, "textVerbosity")) {
    normalized.text_verbosity = normalized.textVerbosity;
    delete normalized.textVerbosity;
  }
  return normalized;
}

function defaultExtraParams(provider: string, modelId: string): Record<string, unknown> {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = modelId.trim().toLowerCase();
  if (normalizedProvider === "openai" && /^gpt-5(?:\.|$|-)/.test(normalizedModel)) {
    return {
      parallel_tool_calls: true,
      text_verbosity: "low",
      openaiWsWarmup: true,
    };
  }
  return {};
}

const testing = {
  setProviderRuntimeDepsForTest(deps: Partial<ProviderRuntimeDeps> | undefined): void {
    providerRuntimeDeps.prepareProviderExtraParams =
      deps?.prepareProviderExtraParams ?? defaultProviderRuntimeDeps.prepareProviderExtraParams;
    providerRuntimeDeps.wrapProviderStreamFn =
      deps?.wrapProviderStreamFn ?? defaultProviderRuntimeDeps.wrapProviderStreamFn;
  },
  resetProviderRuntimeDepsForTest(): void {
    providerRuntimeDeps.prepareProviderExtraParams =
      defaultProviderRuntimeDeps.prepareProviderExtraParams;
    providerRuntimeDeps.wrapProviderStreamFn = defaultProviderRuntimeDeps.wrapProviderStreamFn;
  },
};

/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 *
 * @internal Exported for testing only
 */
function resolveConfiguredExtraParams(params: {
  cfg: FasedAgentConfig | undefined;
  provider: string;
  modelId: string;
  agentId?: string;
}): Record<string, unknown> | undefined {
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  const globalParams = modelConfig?.params
    ? normalizeExtraParamAliases(modelConfig.params)
    : undefined;
  const rawAgentParams =
    params.agentId && params.cfg?.agents?.list
      ? params.cfg.agents.list.find((agent) => agent.id === params.agentId)?.params
      : undefined;
  const agentParams = rawAgentParams ? normalizeExtraParamAliases(rawAgentParams) : undefined;

  const defaults = defaultExtraParams(params.provider, params.modelId);

  if (Object.keys(defaults).length === 0 && !globalParams && !agentParams) {
    return undefined;
  }

  return Object.assign({}, defaults, globalParams, agentParams);
}

export function resolveExtraParams(params: {
  cfg: FasedAgentConfig | undefined;
  provider: string;
  modelId: string;
  agentId?: string;
}): Record<string, unknown> | undefined {
  const configured = resolveConfiguredExtraParams(params);
  const prepared = providerRuntimeDeps.prepareProviderExtraParams({
    provider: params.provider,
    modelId: params.modelId,
    config: params.cfg,
    context: {
      config: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      extraParams: configured,
    },
  });
  return prepared ?? configured;
}

export function resolvePreparedExtraParams(params: {
  cfg: FasedAgentConfig | undefined;
  provider: string;
  modelId: string;
  agentId?: string;
  extraParamsOverride?: Record<string, unknown>;
  thinkingLevel?: ThinkLevel;
  model?: object;
  streamFn?: StreamFn;
}): Record<string, unknown> {
  const extraParams = resolveConfiguredExtraParams({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
  });
  const merged = {
    ...sanitizeExtraParams(extraParams),
    ...normalizeExtraParamAliases(params.extraParamsOverride),
  };
  const prepared = providerRuntimeDeps.prepareProviderExtraParams({
    provider: params.provider,
    modelId: params.modelId,
    config: params.cfg,
    context: {
      config: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      extraParams: merged,
      thinkingLevel: params.thinkingLevel,
      model: params.model,
      streamFn: params.streamFn,
    },
  });
  return prepared ?? merged;
}

export function resolveAgentTransportOverride(params: {
  settingsManager?: {
    getGlobalSettings?: () => Record<string, unknown>;
    getProjectSettings?: () => Record<string, unknown>;
  };
  effectiveExtraParams?: Record<string, unknown>;
}): string | undefined {
  const globalTransport = params.settingsManager?.getGlobalSettings?.().transport;
  const projectTransport = params.settingsManager?.getProjectSettings?.().transport;
  if (typeof projectTransport === "string" && projectTransport.trim()) {
    return undefined;
  }
  if (typeof globalTransport === "string" && globalTransport.trim()) {
    return undefined;
  }
  const preparedTransport = params.effectiveExtraParams?.transport;
  return typeof preparedTransport === "string" && preparedTransport.trim()
    ? preparedTransport
    : undefined;
}

type CacheRetention = "none" | "short" | "long";
type CacheRetentionStreamOptions = Partial<SimpleStreamOptions> & {
  cacheRetention?: CacheRetention;
};
type OpenRouterResponseCacheConfig = {
  enabled?: boolean;
  clear?: boolean;
  ttlSeconds?: number;
};

/**
 * Resolve cacheRetention from extraParams, supporting both new `cacheRetention`
 * and legacy `cacheControlTtl` values for backwards compatibility.
 *
 * Mapping: "5m" → "short", "1h" → "long"
 *
 * Applies to:
 * - direct Anthropic provider
 *
 * OpenRouter uses openai-completions API with hardcoded cache_control instead
 * of the cacheRetention stream option.
 *
 * Defaults to "short" for direct Anthropic when not explicitly configured.
 */
function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): CacheRetention | undefined {
  // Prefer new cacheRetention if present
  const newVal = extraParams?.cacheRetention;
  if (newVal === "none" || newVal === "short" || newVal === "long") {
    return newVal;
  }

  // Fall back to legacy cacheControlTtl with mapping
  const legacy = extraParams?.cacheControlTtl;
  if (legacy === "5m") {
    return "short";
  }
  if (legacy === "1h") {
    return "long";
  }

  // Default to "short" only for direct Anthropic when not explicitly configured.
  // Bedrock retains upstream provider defaults unless explicitly set.
  // Default to "short" for direct Anthropic when not explicitly configured
  return provider === "anthropic" ? "short" : undefined;
}

function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): StreamFn | undefined {
  if (!extraParams || Object.keys(extraParams).length === 0) {
    return undefined;
  }

  const streamParams: CacheRetentionStreamOptions = {};
  if (typeof extraParams.temperature === "number") {
    streamParams.temperature = extraParams.temperature;
  }
  if (typeof extraParams.maxTokens === "number") {
    streamParams.maxTokens = extraParams.maxTokens;
  }
  if (typeof extraParams.openaiWsWarmup === "boolean") {
    (streamParams as CacheRetentionStreamOptions & { openaiWsWarmup?: boolean }).openaiWsWarmup =
      extraParams.openaiWsWarmup;
  }
  const transport = extraParams.transport;
  if (transport === "sse" || transport === "websocket" || transport === "auto") {
    streamParams.transport = transport;
  } else if (transport != null) {
    const transportSummary = typeof transport === "string" ? transport : typeof transport;
    log.warn(`ignoring invalid transport param: ${transportSummary}`);
  }
  const cacheRetention = resolveCacheRetention(extraParams, provider);
  if (cacheRetention) {
    streamParams.cacheRetention = cacheRetention;
  }

  // Extract OpenRouter provider routing preferences from extraParams.provider.
  // Injected into model.compat.openRouterRouting so pi-ai's buildParams sets
  // params.provider in the API request body (openai-completions.js L359-362).
  // pi-ai's OpenRouterRouting type only declares { only?, order? }, but at
  // runtime the full object is forwarded — enabling allow_fallbacks,
  // data_collection, ignore, sort, quantizations, etc.
  const providerRouting =
    provider === "openrouter" &&
    extraParams.provider != null &&
    typeof extraParams.provider === "object"
      ? (extraParams.provider as Record<string, unknown>)
      : undefined;

  if (Object.keys(streamParams).length === 0 && !providerRouting) {
    return undefined;
  }

  log.debug(`creating streamFn wrapper with params: ${JSON.stringify(streamParams)}`);
  if (providerRouting) {
    log.debug(`OpenRouter provider routing: ${JSON.stringify(providerRouting)}`);
  }

  const underlying = baseStreamFn ?? streamSimple;
  const wrappedStreamFn: StreamFn = (model, context, options) => {
    // When provider routing is configured, inject it into model.compat so
    // pi-ai picks it up via model.compat.openRouterRouting.
    const effectiveModel = providerRouting
      ? ({
          ...model,
          compat: { ...model.compat, openRouterRouting: providerRouting },
        } as unknown as typeof model)
      : model;
    return underlying(effectiveModel, context, {
      ...streamParams,
      ...options,
    });
  };

  return wrappedStreamFn;
}

function createParallelToolCallsWrapper(
  baseStreamFn: StreamFn | undefined,
  value: unknown,
): StreamFn | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    const rendered =
      typeof value === "string" || typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : (JSON.stringify(value) ?? typeof value);
    log.warn(`ignoring invalid parallel_tool_calls param: ${rendered}`);
    return undefined;
  }
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const supported =
      model.api === "openai-completions" ||
      model.api === "openai-responses" ||
      model.api === "azure-openai-responses";
    if (!supported) {
      return underlying(model, context, options);
    }
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          (payload as Record<string, unknown>).parallel_tool_calls = value;
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

function isOllamaKimiCloudModel(provider: string, modelId: string): boolean {
  return provider === "ollama" && /^kimi(?:[-:]|$)/i.test(modelId) && /:cloud$/i.test(modelId);
}

function isDirectOpenAIBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return false;
  }

  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === "api.openai.com" || host === "chatgpt.com" || host.endsWith(".openai.azure.com")
    );
  } catch {
    const normalized = baseUrl.toLowerCase();
    return (
      normalized.includes("api.openai.com") ||
      normalized.includes("chatgpt.com") ||
      normalized.includes(".openai.azure.com")
    );
  }
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function resolvePreferredParam(
  extraParams: Record<string, unknown> | undefined,
  camelKey: string,
  snakeKey: string,
): unknown {
  if (!extraParams) {
    return undefined;
  }
  return extraParams[camelKey] !== undefined ? extraParams[camelKey] : extraParams[snakeKey];
}

function parseBooleanParam(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function resolveOpenRouterResponseCacheConfig(
  extraParams: Record<string, unknown> | undefined,
): OpenRouterResponseCacheConfig | undefined {
  const enabled = parseBooleanParam(
    resolvePreferredParam(extraParams, "responseCache", "response_cache"),
  );
  const clear = parseBooleanParam(
    resolvePreferredParam(extraParams, "responseCacheClear", "response_cache_clear"),
  );
  const ttlSeconds = parsePositiveInteger(
    resolvePreferredParam(extraParams, "responseCacheTtlSeconds", "response_cache_ttl_seconds"),
  );
  if (enabled === undefined && clear === undefined && ttlSeconds === undefined) {
    return undefined;
  }
  return { enabled, clear, ttlSeconds };
}

function isNativeOpenRouterBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return true;
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isOpenAICompletionsApi(api: unknown): boolean {
  return api === undefined || api === "openai-completions";
}

function normalizeOpenRouterModelId(modelId: unknown): string | undefined {
  const normalized = readString(modelId)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return normalized.startsWith("openrouter/") ? normalized.slice("openrouter/".length) : normalized;
}

function isOpenRouterDeepSeekV4ModelId(modelId: unknown): boolean {
  const normalized = normalizeOpenRouterModelId(modelId);
  if (!normalized?.startsWith("deepseek/")) {
    return false;
  }
  const deepSeekModelId = normalized.slice("deepseek/".length).split(":", 1)[0];
  return deepSeekModelId === "deepseek-v4-flash" || deepSeekModelId === "deepseek-v4-pro";
}

function isOpenRouterAnthropicModelId(modelId: unknown): boolean {
  return normalizeOpenRouterModelId(modelId)?.startsWith("anthropic/") === true;
}

function isVerifiedNativeOpenRouterRoute(model: {
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  if (!isNativeOpenRouterBaseUrl(model.baseUrl)) {
    return false;
  }
  return readString(model.provider)?.toLowerCase() === "openrouter";
}

function resolveOpenRouterResponseCacheHeaders(params: {
  config: OpenRouterResponseCacheConfig | undefined;
  model: { baseUrl?: unknown };
}): Record<string, string> | undefined {
  const { config } = params;
  if (!config || !isNativeOpenRouterBaseUrl(params.model.baseUrl)) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  if (config.enabled === true) {
    headers["X-OpenRouter-Cache"] = "true";
  }
  if (config.clear === true) {
    headers["X-OpenRouter-Cache-Clear"] = "true";
  }
  if (config.ttlSeconds !== undefined) {
    headers["X-OpenRouter-Cache-TTL"] = String(config.ttlSeconds);
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function createOpenAIReasoningEffortWrapper(
  baseStreamFn: StreamFn | undefined,
  reasoningEffort: ThinkLevel | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const supportsReasoningEffort =
      model.api === "openai-codex-responses" ||
      (model.api === "openai-responses" &&
        model.provider === "openai" &&
        (model.baseUrl === undefined || isDirectOpenAIBaseUrl(model.baseUrl)));
    if (!reasoningEffort || !supportsReasoningEffort) {
      return underlying(model, context, options);
    }
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          const reasoning = payloadObj.reasoning;
          payloadObj.reasoning = {
            ...(reasoning && typeof reasoning === "object" ? reasoning : {}),
            effort: reasoningEffort === "off" ? "none" : reasoningEffort,
          };
        }
        originalOnPayload?.(payload, model);
      },
    });
  };
}

function createCodexDefaultTransportWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    // pi-ai needs a Node WebSocket implementation that accepts handshake headers.
    // Node's browser-compatible global WebSocket ignores that constructor option.
    if (typeof process !== "undefined" && process.versions?.node) {
      globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
    }
    return underlying(model, context, {
      ...options,
      transport: options?.transport ?? "auto",
    });
  };
}

function usesCodexResponsesLite(model: object): boolean {
  const candidate = model as { api?: unknown; compat?: { responsesLite?: unknown } };
  return candidate.api === "openai-codex-responses" && candidate.compat?.responsesLite === true;
}

function createCodexResponsesLiteWrapper(
  baseStreamFn: StreamFn | undefined,
  params?: { cfg?: FasedAgentConfig; agentDir?: string; resolvedApiKey?: string },
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const appServer = createOpenAICodexAppServerStreamFn({
    resolveExecutable: async () => {
      const runtime = await ensureOpenAICodexRuntimeComponent({
        config: params?.cfg ?? loadConfig(),
      });
      if (runtime.installed) {
        await writeConfigFile(runtime.config);
      }
      return runtime.executable;
    },
    resolveToken: async () => {
      if (params?.resolvedApiKey?.trim()) {
        return params.resolvedApiKey.trim();
      }
      const agentDir = params?.agentDir ?? resolveFasedAgentAgentDir();
      const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
      const profileId = listProfilesForProvider(store, "openai-codex")[0];
      if (!profileId) {
        return undefined;
      }
      return (
        await resolveApiKeyForProfile({
          cfg: params?.cfg ?? {},
          store,
          profileId,
          agentDir,
        })
      )?.apiKey;
    },
  });
  return (model, context, options) => {
    if (!usesCodexResponsesLite(model)) {
      return underlying(model, context, options);
    }
    return appServer(model, context, options);
  };
}

function isAnthropic1MModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return ANTHROPIC_1M_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function parseHeaderList(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveAnthropicBetas(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelId: string,
): string[] | undefined {
  if (provider !== "anthropic") {
    return undefined;
  }

  const betas = new Set<string>();
  const configured = extraParams?.anthropicBeta;
  if (typeof configured === "string" && configured.trim()) {
    betas.add(configured.trim());
  } else if (Array.isArray(configured)) {
    for (const beta of configured) {
      if (typeof beta === "string" && beta.trim()) {
        betas.add(beta.trim());
      }
    }
  }

  if (extraParams?.context1m === true) {
    if (isAnthropic1MModel(modelId)) {
      betas.add(ANTHROPIC_CONTEXT_1M_BETA);
    } else {
      log.warn(`ignoring context1m for non-opus/sonnet model: ${provider}/${modelId}`);
    }
  }

  return betas.size > 0 ? [...betas] : undefined;
}

function mergeAnthropicBetaHeader(
  headers: ProviderHeaders | undefined,
  betas: string[],
): Record<string, string> {
  const merged = mergeTransportHeaders(headers) ?? {};
  const existingKey = Object.keys(merged).find((key) => key.toLowerCase() === "anthropic-beta");
  const existing = existingKey ? parseHeaderList(merged[existingKey]) : [];
  const values = Array.from(new Set([...existing, ...betas]));
  const key = existingKey ?? "anthropic-beta";
  merged[key] = values.join(",");
  return merged;
}

// Betas that pi-ai's createClient injects for standard Anthropic API key calls.
// Must be included when injecting anthropic-beta via options.headers, because
// pi-ai's mergeHeaders uses Object.assign (last-wins), which would otherwise
// overwrite the hardcoded defaultHeaders["anthropic-beta"].
const PI_AI_DEFAULT_ANTHROPIC_BETAS = [
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
] as const;

// Additional betas pi-ai injects when the API key is an OAuth token (sk-ant-oat-*).
// These are required for Anthropic to accept OAuth Bearer auth. Losing oauth-2025-04-20
// causes a 401 "OAuth authentication is currently not supported".
const PI_AI_OAUTH_ANTHROPIC_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  ...PI_AI_DEFAULT_ANTHROPIC_BETAS,
] as const;

function isAnthropicOAuthApiKey(apiKey: unknown): boolean {
  return typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
}

function createAnthropicBetaHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
  betas: string[],
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const isOauth = isAnthropicOAuthApiKey(options?.apiKey);
    const requestedContext1m = betas.includes(ANTHROPIC_CONTEXT_1M_BETA);
    const effectiveBetas =
      isOauth && requestedContext1m
        ? betas.filter((beta) => beta !== ANTHROPIC_CONTEXT_1M_BETA)
        : betas;
    if (isOauth && requestedContext1m) {
      log.warn(
        `ignoring context1m for OAuth token auth on ${model.provider}/${model.id}; Anthropic rejects context-1m beta with OAuth auth`,
      );
    }

    // Preserve the betas pi-ai's createClient would inject for the given token type.
    // Without this, our options.headers["anthropic-beta"] overwrites the pi-ai
    // defaultHeaders via Object.assign, stripping critical betas like oauth-2025-04-20.
    const piAiBetas = isOauth
      ? (PI_AI_OAUTH_ANTHROPIC_BETAS as readonly string[])
      : (PI_AI_DEFAULT_ANTHROPIC_BETAS as readonly string[]);
    const allBetas = [...new Set([...piAiBetas, ...effectiveBetas])];
    return underlying(model, context, {
      ...options,
      headers: mergeAnthropicBetaHeader(options?.headers, allBetas),
    });
  };
}

function isOpenRouterAnthropicModel(provider: string, modelId: string): boolean {
  return provider.toLowerCase() === "openrouter" && isOpenRouterAnthropicModelId(modelId);
}

type PayloadMessage = {
  role?: string;
  content?: unknown;
};

function shouldPatchOpenRouterAnthropicPayload(model: {
  api?: unknown;
  provider?: unknown;
  id?: unknown;
  baseUrl?: unknown;
}): boolean {
  return (
    isOpenAICompletionsApi(model.api) &&
    isOpenRouterAnthropicModelId(model.id) &&
    isVerifiedNativeOpenRouterRoute(model)
  );
}

function isEnabledReasoningValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "off" && normalized !== "none";
  }
  return true;
}

function isOpenRouterReasoningPayloadEnabled(payload: Record<string, unknown>): boolean {
  return (
    isEnabledReasoningValue(payload.reasoning) || isEnabledReasoningValue(payload.reasoning_effort)
  );
}

function assistantMessageHasToolUse(message: Record<string, unknown>): boolean {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block) =>
      block &&
      typeof block === "object" &&
      ((block as { type?: unknown }).type === "tool_use" ||
        (block as { type?: unknown }).type === "toolCall"),
  );
}

function stripTrailingAssistantPrefillMessages(payload: Record<string, unknown>): number {
  if (!Array.isArray(payload.messages)) {
    return 0;
  }

  let stripped = 0;
  while (payload.messages.length > 0) {
    const finalMessage = payload.messages[payload.messages.length - 1];
    if (!finalMessage || typeof finalMessage !== "object") {
      break;
    }
    const message = finalMessage as Record<string, unknown>;
    if (message.role !== "assistant" || assistantMessageHasToolUse(message)) {
      break;
    }
    payload.messages.pop();
    stripped += 1;
  }
  return stripped;
}

/**
 * Inject cache_control into the system message for OpenRouter Anthropic models.
 * OpenRouter passes through Anthropic's cache_control field — caching the system
 * prompt avoids re-processing it on every request.
 */
function createOpenRouterSystemCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      typeof model.provider !== "string" ||
      typeof model.id !== "string" ||
      !isOpenRouterAnthropicModel(model.provider, model.id)
    ) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        const messages = (payload as Record<string, unknown>)?.messages;
        if (Array.isArray(messages)) {
          for (const msg of messages as PayloadMessage[]) {
            if (msg.role !== "system" && msg.role !== "developer") {
              continue;
            }
            if (typeof msg.content === "string") {
              msg.content = [
                { type: "text", text: msg.content, cache_control: { type: "ephemeral" } },
              ];
            } else if (Array.isArray(msg.content) && msg.content.length > 0) {
              const last = msg.content[msg.content.length - 1];
              if (last && typeof last === "object") {
                (last as Record<string, unknown>).cache_control = { type: "ephemeral" };
              }
            }
          }
        }
        if (
          payload &&
          typeof payload === "object" &&
          shouldPatchOpenRouterAnthropicPayload(model) &&
          isOpenRouterReasoningPayloadEnabled(payload as Record<string, unknown>)
        ) {
          const stripped = stripTrailingAssistantPrefillMessages(
            payload as Record<string, unknown>,
          );
          if (stripped > 0) {
            log.warn(
              `removed ${stripped} trailing assistant prefill message${stripped === 1 ? "" : "s"} because OpenRouter-routed Anthropic reasoning requires conversations to end with a user turn`,
            );
          }
        }
        originalOnPayload?.(payload, model);
      },
    });
  };
}

/**
 * Map FasedAgent's ThinkLevel to OpenRouter's reasoning.effort values.
 * "off" maps to "none"; all other levels pass through as-is.
 */
function mapThinkingLevelToOpenRouterReasoningEffort(
  thinkingLevel: ThinkLevel,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" {
  if (thinkingLevel === "off") {
    return "none";
  }
  return thinkingLevel;
}

function shouldApplySiliconFlowThinkingOffCompat(params: {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkLevel;
}): boolean {
  return (
    params.provider === "siliconflow" &&
    params.thinkingLevel === "off" &&
    params.modelId.startsWith("Pro/")
  );
}

/**
 * SiliconFlow's Pro/* models reject string thinking modes (including "off")
 * with HTTP 400 invalid-parameter errors. Normalize to `thinking: null` to
 * preserve "thinking disabled" intent without sending an invalid enum value.
 */
function createSiliconFlowThinkingWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (payloadObj.thinking === "off") {
            payloadObj.thinking = null;
          }
        }
        originalOnPayload?.(payload, model);
      },
    });
  };
}

function shouldPatchOpenRouterDeepSeekV4Payload(model: {
  api?: unknown;
  provider?: unknown;
  id?: unknown;
  baseUrl?: unknown;
}): boolean {
  return (
    isOpenAICompletionsApi(model.api) &&
    isOpenRouterDeepSeekV4ModelId(model.id) &&
    isVerifiedNativeOpenRouterRoute(model)
  );
}

function stripAssistantReasoningContent(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages)) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    delete (message as Record<string, unknown>).reasoning_content;
  }
}

function ensureAssistantReasoningContent(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages)) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const messageObj = message as Record<string, unknown>;
    if (messageObj.role === "assistant" && !("reasoning_content" in messageObj)) {
      messageObj.reasoning_content = "";
    }
  }
}

function patchOpenRouterDeepSeekV4Payload(
  payload: Record<string, unknown>,
  thinkingLevel: ThinkLevel,
): void {
  if (thinkingLevel === "off") {
    payload.thinking = { type: "disabled" };
    delete payload.reasoning;
    delete payload.reasoning_effort;
    stripAssistantReasoningContent(payload);
    return;
  }

  payload.thinking = { type: "enabled" };
  payload.reasoning_effort = mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel);
  delete payload.reasoning;
  ensureAssistantReasoningContent(payload);
}

/**
 * Create a streamFn wrapper that adds OpenRouter app attribution headers
 * and injects reasoning.effort based on the configured thinking level.
 */
function createOpenRouterWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
  responseCacheConfig?: OpenRouterResponseCacheConfig,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const onPayload = options?.onPayload;
    const responseCacheHeaders = resolveOpenRouterResponseCacheHeaders({
      config: responseCacheConfig,
      model,
    });
    return underlying(model, context, {
      ...options,
      headers: {
        ...OPENROUTER_APP_HEADERS,
        ...responseCacheHeaders,
        ...options?.headers,
      },
      onPayload: (payload) => {
        if (thinkingLevel && payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (shouldPatchOpenRouterDeepSeekV4Payload(model)) {
            patchOpenRouterDeepSeekV4Payload(payloadObj, thinkingLevel);
            onPayload?.(payload, model);
            return;
          }

          // pi-ai may inject a top-level reasoning_effort (OpenAI flat format).
          // OpenRouter expects the nested reasoning.effort format instead, and
          // rejects payloads containing both fields. Remove the flat field so
          // only the nested one is sent.
          delete payloadObj.reasoning_effort;

          // When thinking is "off", do not inject reasoning at all.
          // Some models (e.g. deepseek/deepseek-r1) require reasoning and reject
          // { effort: "none" } with "Reasoning is mandatory for this endpoint and
          // cannot be disabled." Omitting the field lets each model use its own
          // default reasoning behavior.
          if (thinkingLevel !== "off") {
            const existingReasoning = payloadObj.reasoning;

            // OpenRouter treats reasoning.effort and reasoning.max_tokens as
            // alternative controls. If max_tokens is already present, do not
            // inject effort and do not overwrite caller-supplied reasoning.
            if (
              existingReasoning &&
              typeof existingReasoning === "object" &&
              !Array.isArray(existingReasoning)
            ) {
              const reasoningObj = existingReasoning as Record<string, unknown>;
              if (!("max_tokens" in reasoningObj) && !("effort" in reasoningObj)) {
                reasoningObj.effort = mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel);
              }
            } else if (!existingReasoning) {
              payloadObj.reasoning = {
                effort: mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel),
              };
            }
          }
        }
        onPayload?.(payload, model);
      },
    });
  };
}

function isGemini31Model(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return (
    normalized.includes("gemini-3.1-pro") ||
    normalized.includes("gemini-3.1-flash") ||
    normalized.includes("gemini-3-flash")
  );
}

function mapThinkLevelToGoogleThinkingLevel(
  thinkingLevel: ThinkLevel,
): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | undefined {
  switch (thinkingLevel) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
    case "xhigh":
      return "HIGH";
    default:
      return undefined;
  }
}

function sanitizeGoogleThinkingPayload(params: {
  payload: unknown;
  modelId?: string;
  thinkingLevel?: ThinkLevel;
}): void {
  if (!params.payload || typeof params.payload !== "object") {
    return;
  }
  const payloadObj = params.payload as Record<string, unknown>;
  const config = payloadObj.config;
  if (!config || typeof config !== "object") {
    return;
  }
  const configObj = config as Record<string, unknown>;
  const thinkingConfig = configObj.thinkingConfig;
  if (!thinkingConfig || typeof thinkingConfig !== "object") {
    return;
  }
  const thinkingConfigObj = thinkingConfig as Record<string, unknown>;
  const thinkingBudget = thinkingConfigObj.thinkingBudget;
  if (typeof thinkingBudget !== "number" || thinkingBudget >= 0) {
    return;
  }

  // pi-ai can emit thinkingBudget=-1 for some Gemini 3.1 IDs; a negative budget
  // is invalid for Google-compatible backends and can lead to malformed handling.
  delete thinkingConfigObj.thinkingBudget;

  if (
    typeof params.modelId === "string" &&
    isGemini31Model(params.modelId) &&
    params.thinkingLevel &&
    params.thinkingLevel !== "off" &&
    thinkingConfigObj.thinkingLevel === undefined
  ) {
    const mappedLevel = mapThinkLevelToGoogleThinkingLevel(params.thinkingLevel);
    if (mappedLevel) {
      thinkingConfigObj.thinkingLevel = mappedLevel;
    }
  }
}

function createGoogleThinkingPayloadWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const onPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (model.api === "google-generative-ai") {
          sanitizeGoogleThinkingPayload({
            payload,
            modelId: model.id,
            thinkingLevel,
          });
        }
        onPayload?.(payload, model);
      },
    });
  };
}

/**
 * Create a streamFn wrapper that injects tool_stream=true for Z.AI providers.
 *
 * Z.AI's API supports the `tool_stream` parameter to enable real-time streaming
 * of tool call arguments and reasoning content. When enabled, the API returns
 * progressive tool_call deltas, allowing users to see tool execution in real-time.
 *
 * @see https://docs.z.ai/api-reference#streaming
 */
function createZaiToolStreamWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!enabled) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          // Inject tool_stream: true for Z.AI API
          (payload as Record<string, unknown>).tool_stream = true;
        }
        originalOnPayload?.(payload, model);
      },
    });
  };
}

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also adds OpenRouter app attribution headers when using the OpenRouter provider.
 *
 * @internal Exported for testing
 */
export function applyExtraParamsToAgent(
  agent: { streamFn?: StreamFn },
  cfg: FasedAgentConfig | undefined,
  provider: string,
  modelId: string,
  extraParamsOverride?: Record<string, unknown>,
  thinkingLevel?: ThinkLevel,
  agentId?: string,
  agentDir?: string,
  model?: object,
  resolvedApiKey?: string,
): void {
  const extraParams = resolveConfiguredExtraParams({
    cfg,
    provider,
    modelId,
    agentId,
  });
  if (provider === "openai-codex") {
    // Default Codex to WebSocket-first when nothing else specifies transport.
    agent.streamFn = createCodexDefaultTransportWrapper(agent.streamFn);
    agent.streamFn = createCodexResponsesLiteWrapper(agent.streamFn, {
      cfg,
      agentDir,
      resolvedApiKey,
    });
  }
  const merged = Object.assign(
    {},
    sanitizeExtraParams(extraParams),
    normalizeExtraParamAliases(extraParamsOverride),
  );
  const preparedProviderExtraParams = providerRuntimeDeps.prepareProviderExtraParams({
    provider,
    modelId,
    config: cfg,
    context: {
      config: cfg,
      provider,
      modelId,
      extraParams: merged,
      thinkingLevel,
      model,
      streamFn: agent.streamFn,
    },
  });
  const effectiveProviderExtraParams = preparedProviderExtraParams ?? merged;
  const streamFnBeforeProviderHook = agent.streamFn;
  const providerWrappedStreamFn = providerRuntimeDeps.wrapProviderStreamFn({
    provider,
    config: cfg,
    context: {
      config: cfg,
      provider,
      modelId,
      extraParams: effectiveProviderExtraParams,
      thinkingLevel,
      model: {
        ...model,
        id: modelId,
        provider,
        ...(provider === "ollama" ? { api: "ollama" } : {}),
      },
      agentDir,
      streamFn: agent.streamFn,
    },
  });
  if (providerWrappedStreamFn) {
    agent.streamFn = providerWrappedStreamFn;
  }
  const providerRuntimeHandled =
    providerWrappedStreamFn !== undefined && providerWrappedStreamFn !== streamFnBeforeProviderHook;
  const wrappedStreamFn = createStreamFnWithExtraParams(
    agent.streamFn,
    effectiveProviderExtraParams,
    provider,
  );

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${provider}/${modelId}`);
    agent.streamFn = wrappedStreamFn;
  }

  const parallelToolCalls = createParallelToolCallsWrapper(
    agent.streamFn,
    effectiveProviderExtraParams.parallel_tool_calls,
  );
  if (parallelToolCalls) {
    agent.streamFn = parallelToolCalls;
  }

  const anthropicBetas = resolveAnthropicBetas(effectiveProviderExtraParams, provider, modelId);
  if (anthropicBetas?.length) {
    log.debug(
      `applying Anthropic beta header for ${provider}/${modelId}: ${anthropicBetas.join(",")}`,
    );
    agent.streamFn = createAnthropicBetaHeadersWrapper(agent.streamFn, anthropicBetas);
  }

  if (shouldApplySiliconFlowThinkingOffCompat({ provider, modelId, thinkingLevel })) {
    log.debug(
      `normalizing thinking=off to thinking=null for SiliconFlow compatibility (${provider}/${modelId})`,
    );
    agent.streamFn = createSiliconFlowThinkingWrapper(agent.streamFn);
  }

  if (provider === "openrouter" && !providerRuntimeHandled) {
    log.debug(`applying OpenRouter app attribution headers for ${provider}/${modelId}`);
    // "auto" is a dynamic routing model — we don't know which underlying model
    // OpenRouter will select, and it may be a reasoning-required endpoint.
    // Omit the thinkingLevel so we never inject `reasoning.effort: "none"`,
    // which would cause a 400 on models where reasoning is mandatory.
    // Users who need reasoning control should target a specific model ID.
    // See: fased/fased#24851
    const openRouterThinkingLevel = modelId === "auto" ? undefined : thinkingLevel;
    agent.streamFn = createOpenRouterWrapper(
      agent.streamFn,
      openRouterThinkingLevel,
      resolveOpenRouterResponseCacheConfig(effectiveProviderExtraParams),
    );
    agent.streamFn = createOpenRouterSystemCacheWrapper(agent.streamFn);
  }

  if (provider === "moonshot" || isOllamaKimiCloudModel(provider, modelId)) {
    const configuredThinking = effectiveProviderExtraParams.thinking;
    const hasPinnedToolChoice =
      model &&
      typeof model === "object" &&
      "tool_choice" in model &&
      typeof (model as Record<string, unknown>).tool_choice === "object";
    const thinkingType = hasPinnedToolChoice
      ? "disabled"
      : resolveMoonshotThinkingType({ configuredThinking, thinkingLevel });
    agent.streamFn = createMoonshotThinkingWrapper(agent.streamFn, thinkingType);
  }

  // Enable Z.AI tool_stream for real-time tool call streaming.
  // Enabled by default for Z.AI provider, can be disabled via params.tool_stream: false
  if (provider === "zai" || provider === "z-ai") {
    const toolStreamEnabled = merged?.tool_stream !== false;
    if (toolStreamEnabled) {
      log.debug(`enabling Z.AI tool_stream for ${provider}/${modelId}`);
      agent.streamFn = createZaiToolStreamWrapper(agent.streamFn, true);
    }
  }

  // Guard Google payloads against invalid negative thinking budgets emitted by
  // upstream model-ID heuristics for Gemini 3.1 variants.
  agent.streamFn = createGoogleThinkingPayloadWrapper(agent.streamFn, thinkingLevel);

  // Work around upstream pi-ai hardcoding `store: false` for Responses API.
  // Force `store=true` for direct OpenAI Responses models and auto-enable
  // server-side compaction for compatible OpenAI Responses payloads.
  agent.streamFn = createRouteOpenAIResponsesContextManagementWrapper(
    agent.streamFn,
    effectiveProviderExtraParams,
  );
  agent.streamFn = createOpenAIReasoningEffortWrapper(agent.streamFn, thinkingLevel);
}

export { testing as __testing };
