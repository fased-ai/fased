import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { log } from "../../../src/agents/pi-embedded-runner/logger.js";

const ANTHROPIC_CONTEXT_1M_BETA = "context-1m-2025-08-07";
const PI_AI_DEFAULT_ANTHROPIC_BETAS = [
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
] as const;
const PI_AI_OAUTH_ANTHROPIC_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  ...PI_AI_DEFAULT_ANTHROPIC_BETAS,
] as const;
const VALID_ANTHROPIC_SERVICE_TIERS = new Set(["auto", "standard_only"]);

function isAnthropic1MModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return normalized.startsWith("claude-opus-") || normalized.startsWith("claude-sonnet-");
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

function mergeAnthropicBetaHeader(
  headers: Record<string, string> | undefined,
  betas: string[],
): Record<string, string> {
  const merged = { ...headers };
  const existingKey = Object.keys(merged).find((key) => key.toLowerCase() === "anthropic-beta");
  const existing = existingKey ? parseHeaderList(merged[existingKey]) : [];
  const key = existingKey ?? "anthropic-beta";
  merged[key] = [...new Set([...existing, ...betas])].join(",");
  return merged;
}

function isAnthropicOAuthApiKey(apiKey: unknown): boolean {
  return typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
}

function isDirectAnthropicModel(model: { baseUrl?: unknown }): boolean {
  if (typeof model.baseUrl !== "string" || !model.baseUrl.trim()) {
    return true;
  }
  try {
    return new URL(model.baseUrl).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

export function resolveAnthropicBetas(
  extraParams: Record<string, unknown> | undefined,
  modelId: string,
): string[] | undefined {
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
      log.warn(`ignoring context1m for non-opus/sonnet model: anthropic/${modelId}`);
    }
  }

  return betas.size > 0 ? [...betas] : undefined;
}

export function createAnthropicBetaHeadersWrapper(
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
    const piAiBetas = isOauth
      ? (PI_AI_OAUTH_ANTHROPIC_BETAS as readonly string[])
      : (PI_AI_DEFAULT_ANTHROPIC_BETAS as readonly string[]);
    return underlying(model, context, {
      ...options,
      headers: mergeAnthropicBetaHeader(options?.headers, [
        ...new Set([...piAiBetas, ...effectiveBetas]),
      ]),
    });
  };
}

export function resolveAnthropicServiceTier(
  extraParams: Record<string, unknown> | undefined,
): "auto" | "standard_only" | undefined {
  const value = extraParams?.serviceTier ?? extraParams?.service_tier;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && VALID_ANTHROPIC_SERVICE_TIERS.has(value)) {
    return value as "auto" | "standard_only";
  }
  log.warn(`ignoring invalid Anthropic service tier param: ${formatExtraParamValue(value)}`);
  return undefined;
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

export function createAnthropicServiceTierWrapper(
  baseStreamFn: StreamFn | undefined,
  serviceTier: "auto" | "standard_only",
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      onPayload: (payload: unknown) => {
        if (
          isDirectAnthropicModel(model) &&
          payload &&
          typeof payload === "object" &&
          !("service_tier" in payload)
        ) {
          (payload as Record<string, unknown>).service_tier = serviceTier;
        }
        return options?.onPayload?.(payload);
      },
    });
}

export function resolveAnthropicFastMode(
  extraParams: Record<string, unknown> | undefined,
): boolean | undefined {
  return typeof extraParams?.fastMode === "boolean" ? extraParams.fastMode : undefined;
}

export function createAnthropicFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: boolean,
): StreamFn {
  return createAnthropicServiceTierWrapper(baseStreamFn, fastMode ? "auto" : "standard_only");
}
