import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai/compat";
import { log } from "./logger.js";

type OpenAIServiceTier = "default" | "auto" | "priority" | "standard_only";
type OpenAITextVerbosity = "low" | "medium" | "high";

const VALID_SERVICE_TIERS = new Set(["default", "auto", "priority", "standard_only"]);
const VALID_TEXT_VERBOSITY = new Set(["low", "medium", "high"]);

function withPayloadPatch(
  baseStreamFn: StreamFn | undefined,
  patch: (payload: Record<string, unknown>, model: Parameters<StreamFn>[0]) => void,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      onPayload: (payload: unknown) => {
        if (payload && typeof payload === "object") {
          patch(payload as Record<string, unknown>, model);
        }
        return options?.onPayload?.(payload, model);
      },
    });
}

function readParam(extraParams: Record<string, unknown> | undefined, keys: string[]): unknown {
  if (!extraParams) {
    return undefined;
  }
  for (const key of keys) {
    if (Object.hasOwn(extraParams, key)) {
      return extraParams[key];
    }
  }
  return undefined;
}

function isDirectOpenAI(model: { baseUrl?: unknown; provider?: unknown }): boolean {
  if (typeof model.baseUrl !== "string") {
    return model.baseUrl === undefined && model.provider === "openai";
  }
  if (!model.baseUrl.trim()) {
    return false;
  }
  try {
    return new URL(model.baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function isDirectAzureOpenAI(model: { baseUrl?: unknown }): boolean {
  if (typeof model.baseUrl !== "string" || !model.baseUrl.trim()) {
    return false;
  }
  try {
    return new URL(model.baseUrl).hostname.endsWith(".openai.azure.com");
  } catch {
    return false;
  }
}

function isOpenAIResponsesApi(model: { api?: unknown }): boolean {
  return model.api === "openai-responses" || model.api === "azure-openai-responses";
}

function isCodexResponsesApi(model: { api?: unknown }): boolean {
  return model.api === "openai-codex-responses";
}

function supportsStore(model: { compat?: unknown }): boolean {
  const compat = model.compat;
  return !(
    compat &&
    typeof compat === "object" &&
    (compat as Record<string, unknown>).supportsStore === false
  );
}

function directResponsesRoute(model: { api?: unknown; provider?: unknown; baseUrl?: unknown }) {
  return (
    (model.api === "openai-responses" && (isDirectOpenAI(model) || isDirectAzureOpenAI(model))) ||
    (model.api === "azure-openai-responses" && isDirectAzureOpenAI(model))
  );
}

function serviceTierRoute(model: { api?: unknown; provider?: unknown; baseUrl?: unknown }) {
  return (
    isCodexResponsesApi(model) ||
    (model.api === "openai-responses" && model.provider === "openai" && isDirectOpenAI(model))
  );
}

export function resolveOpenAIFastMode(
  extraParams: Record<string, unknown> | undefined,
): boolean | undefined {
  return typeof extraParams?.fastMode === "boolean" ? extraParams.fastMode : undefined;
}

function formatExtraParamValue(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function resolveOpenAIServiceTier(
  extraParams: Record<string, unknown> | undefined,
): OpenAIServiceTier | undefined {
  const value = readParam(extraParams, ["serviceTier", "service_tier"]);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && VALID_SERVICE_TIERS.has(value)) {
    return value as OpenAIServiceTier;
  }
  log.warn(`ignoring invalid OpenAI service tier param: ${formatExtraParamValue(value)}`);
  return undefined;
}

export function resolveOpenAITextVerbosity(
  extraParams: Record<string, unknown> | undefined,
): OpenAITextVerbosity | undefined {
  const value = readParam(extraParams, ["textVerbosity", "text_verbosity"]);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && VALID_TEXT_VERBOSITY.has(value)) {
    return value as OpenAITextVerbosity;
  }
  log.warn(`ignoring invalid OpenAI text verbosity param: ${formatExtraParamValue(value)}`);
  return undefined;
}

export function createOpenAIDefaultTransportWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      transport: options?.transport ?? "auto",
      openaiWsWarmup: (options as { openaiWsWarmup?: boolean } | undefined)?.openaiWsWarmup ?? true,
    } as Parameters<StreamFn>[2] & { openaiWsWarmup?: boolean });
}

export function createOpenAIAttributionHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  return baseStreamFn ?? streamSimple;
}

export function createOpenAIServiceTierWrapper(
  baseStreamFn: StreamFn | undefined,
  serviceTier: OpenAIServiceTier,
): StreamFn {
  return withPayloadPatch(baseStreamFn, (payload, model) => {
    if (!serviceTierRoute(model)) {
      return;
    }
    if (!("service_tier" in payload)) {
      payload.service_tier = serviceTier;
    }
  });
}

export function createOpenAIFastModeWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return withPayloadPatch(baseStreamFn, (payload, model) => {
    if (!serviceTierRoute(model)) {
      return;
    }
    if (!("service_tier" in payload)) {
      payload.service_tier = "priority";
    }
    const text = payload.text;
    if (!text || typeof text !== "object" || !("verbosity" in text)) {
      payload.text = { ...(text && typeof text === "object" ? text : {}), verbosity: "low" };
    }
  });
}

export function createOpenAITextVerbosityWrapper(
  baseStreamFn: StreamFn | undefined,
  textVerbosity: OpenAITextVerbosity,
): StreamFn {
  return withPayloadPatch(baseStreamFn, (payload, model) => {
    if (!directResponsesRoute(model) && !isCodexResponsesApi(model)) {
      return;
    }
    const text = payload.text;
    if (!isCodexResponsesApi(model) && text && typeof text === "object" && "verbosity" in text) {
      return;
    }
    payload.text = {
      ...(text && typeof text === "object" ? text : {}),
      verbosity: textVerbosity,
    };
  });
}

export function createOpenAIReasoningCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  return withPayloadPatch(baseStreamFn, (payload, model) => {
    if (isOpenAIResponsesApi(model) && !directResponsesRoute(model)) {
      delete payload.reasoning;
      delete payload.reasoningEffort;
      delete payload.reasoning_effort;
    }
  });
}

export function createCodexNativeWebSearchWrapper(
  baseStreamFn: StreamFn | undefined,
  params: { config?: unknown; agentDir?: string },
): StreamFn {
  return withPayloadPatch(baseStreamFn, (payload, model) => {
    const config = params.config as
      | {
          tools?: { web?: { search?: { enabled?: boolean; openaiCodex?: { enabled?: boolean } } } };
        }
      | undefined;
    if (
      !isCodexResponsesApi(model) ||
      config?.tools?.web?.search?.enabled !== true ||
      config.tools.web.search.openaiCodex?.enabled !== true
    ) {
      return;
    }
    const existing = Array.isArray(payload.tools) ? payload.tools : [];
    if (
      existing.some(
        (tool) =>
          tool && typeof tool === "object" && (tool as { type?: unknown }).type === "web_search",
      )
    ) {
      return;
    }
    payload.tools = [
      ...existing,
      {
        type: "web_search",
        external_web_access: true,
        filters: { allowed_domains: ["example.com"] },
      },
    ];
  });
}

export function createOpenAIResponsesContextManagementWrapper(
  baseStreamFn: StreamFn | undefined,
  extraParams?: Record<string, unknown>,
): StreamFn {
  return withPayloadPatch(baseStreamFn, (payload, model) => {
    if (!supportsStore(model)) {
      delete payload.store;
    } else if (directResponsesRoute(model) && model.api === "openai-responses") {
      payload.store = true;
    }

    if (isCodexResponsesApi(model)) {
      payload.store = false;
      return;
    }

    if (isOpenAIResponsesApi(model) && !directResponsesRoute(model)) {
      delete payload.prompt_cache_key;
      delete payload.prompt_cache_retention;
    }

    const compactionParam = readParam(extraParams, [
      "responsesServerCompaction",
      "responses_server_compaction",
    ]);
    const shouldCompact =
      compactionParam === true ||
      (compactionParam !== false && model.api === "openai-responses" && isDirectOpenAI(model));
    if (
      shouldCompact &&
      !("context_management" in payload) &&
      supportsStore(model) &&
      isOpenAIResponsesApi(model)
    ) {
      const configuredThreshold = readParam(extraParams, [
        "responsesCompactThreshold",
        "responses_compact_threshold",
      ]);
      const threshold =
        typeof configuredThreshold === "number"
          ? configuredThreshold
          : typeof model.contextWindow === "number"
            ? Math.trunc(model.contextWindow * 0.7)
            : 80_000;
      payload.context_management = [{ type: "compaction", compact_threshold: threshold }];
    }
  });
}
