export const BASE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export const XHIGH_THINKING_LEVELS = [...BASE_THINKING_LEVELS, "xhigh"] as const;

export type ModelThinkingLevel = (typeof XHIGH_THINKING_LEVELS)[number];

export type ModelThinkingMode =
  | "openai-reasoning-effort"
  | "anthropic-thinking-budget"
  | "anthropic-adaptive"
  | "google-thinking-budget"
  | "xai-reasoning-effort"
  | "xai-multi-agent-effort"
  | "mistral-reasoning-effort"
  | "volcengine-reasoning-effort"
  | "byteplus-thinking-type"
  | "zai-binary"
  | "qwen-thinking"
  | "moonshot-thinking"
  | "generic-reasoning";

export type ModelThinkingCapabilityInput = {
  fixedReasoning?: boolean;
  thinkingLevels?: readonly string[];
  defaultThinkingLevel?: string;
  thinkingMode?: string;
  reasoningBudgetSupported?: boolean;
};

export type ModelThinkingCapability = {
  thinkingLevels: ModelThinkingLevel[];
  defaultThinkingLevel: ModelThinkingLevel;
  thinkingMode: ModelThinkingMode;
  reasoningBudgetSupported: boolean;
};

export const XHIGH_MODEL_REFS = [
  "openai/gpt-5.5",
  "openai/gpt-5.5-pro",
  "openai/gpt-5.4",
  "openai/gpt-5.4-pro",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.2",
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.3-codex",
  "github-copilot/gpt-5.2-codex",
  "github-copilot/gpt-5.2",
] as const;

const XHIGH_MODEL_SET = new Set(XHIGH_MODEL_REFS.map((entry) => entry.toLowerCase()));
const XHIGH_MODEL_IDS = new Set(
  XHIGH_MODEL_REFS.map((entry) => entry.split("/")[1]?.toLowerCase()).filter(
    (entry): entry is string => Boolean(entry),
  ),
);

function normalizeProviderId(provider?: string | null): string {
  if (!provider) {
    return "";
  }
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  return normalized;
}

export function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeProviderId(provider) === "zai";
}

export function normalizeThinkLevel(raw?: string | null): ModelThinkingLevel | undefined {
  if (!raw) {
    return undefined;
  }
  const key = raw.trim().toLowerCase();
  const collapsed = key.replace(/[\s_-]+/g, "");
  if (collapsed === "xhigh" || collapsed === "extrahigh") {
    return "xhigh";
  }
  if (key === "off") {
    return "off";
  }
  if (["on", "enable", "enabled"].includes(key)) {
    return "low";
  }
  if (["min", "minimal"].includes(key)) {
    return "minimal";
  }
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key)) {
    return "low";
  }
  if (["mid", "med", "medium", "thinkharder", "think-harder", "harder"].includes(key)) {
    return "medium";
  }
  if (
    ["high", "ultra", "ultrathink", "think-hard", "thinkhardest", "highest", "max"].includes(key)
  ) {
    return "high";
  }
  if (key === "think") {
    return "minimal";
  }
  return undefined;
}

export function supportsXHighThinking(provider?: string | null, model?: string | null): boolean {
  const modelKey = model?.trim().toLowerCase();
  if (!modelKey) {
    return false;
  }
  const providerKey = provider?.trim().toLowerCase();
  if (providerKey) {
    return XHIGH_MODEL_SET.has(`${providerKey}/${modelKey}`);
  }
  return XHIGH_MODEL_IDS.has(modelKey);
}

function normalizeThinkingLevels(values: readonly string[] | undefined): ModelThinkingLevel[] {
  const seen = new Set<ModelThinkingLevel>();
  const levels: ModelThinkingLevel[] = [];
  for (const value of values ?? []) {
    const normalized = normalizeThinkLevel(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    levels.push(normalized);
  }
  return levels;
}

function listGenericThinkingLevels(
  provider?: string | null,
  model?: string | null,
): ModelThinkingLevel[] {
  return supportsXHighThinking(provider, model)
    ? [...XHIGH_THINKING_LEVELS]
    : [...BASE_THINKING_LEVELS];
}

function isAnthropicAdaptiveModel(model?: string | null): boolean {
  const modelId = model?.trim().toLowerCase() ?? "";
  return (
    modelId.includes("opus-4-6") ||
    modelId.includes("opus-4.6") ||
    modelId.includes("opus-4-7") ||
    modelId.includes("opus-4.7") ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6") ||
    modelId.includes("sonnet-4-7") ||
    modelId.includes("sonnet-4.7")
  );
}

function resolveFallbackThinkingMode(
  provider?: string | null,
  model?: string | null,
): Pick<ModelThinkingCapability, "thinkingMode" | "reasoningBudgetSupported"> {
  const normalizedProvider = normalizeProviderId(provider);
  if (
    normalizedProvider === "openai" ||
    normalizedProvider === "openai-codex" ||
    normalizedProvider === "github-copilot" ||
    normalizedProvider === "copilot-proxy"
  ) {
    return { thinkingMode: "openai-reasoning-effort", reasoningBudgetSupported: false };
  }
  if (normalizedProvider === "anthropic") {
    return {
      thinkingMode: isAnthropicAdaptiveModel(model)
        ? "anthropic-adaptive"
        : "anthropic-thinking-budget",
      reasoningBudgetSupported: !isAnthropicAdaptiveModel(model),
    };
  }
  if (normalizedProvider === "google" || normalizedProvider === "google-gemini-cli") {
    return { thinkingMode: "google-thinking-budget", reasoningBudgetSupported: true };
  }
  if (normalizedProvider === "zai") {
    return { thinkingMode: "zai-binary", reasoningBudgetSupported: false };
  }
  if (normalizedProvider === "qwen" || normalizedProvider === "qwen-coding-plan") {
    return { thinkingMode: "qwen-thinking", reasoningBudgetSupported: true };
  }
  if (normalizedProvider === "moonshot" || normalizedProvider === "kimi-coding") {
    return { thinkingMode: "moonshot-thinking", reasoningBudgetSupported: false };
  }
  return { thinkingMode: "generic-reasoning", reasoningBudgetSupported: false };
}

function canInferReasoningFromProviderModel(provider?: string | null, model?: string | null) {
  const normalizedProvider = normalizeProviderId(provider);
  const modelId = model?.trim().toLowerCase() ?? "";
  if (!normalizedProvider || !modelId) {
    return false;
  }
  if (
    normalizedProvider === "openai" ||
    normalizedProvider === "openai-codex" ||
    normalizedProvider === "github-copilot" ||
    normalizedProvider === "copilot-proxy"
  ) {
    return /^gpt-5(?:[.-]|$)/.test(modelId);
  }
  if (normalizedProvider === "anthropic") {
    return modelId.startsWith("claude-") || modelId.includes("claude-");
  }
  if (normalizedProvider === "google" || normalizedProvider === "google-gemini-cli") {
    return modelId.startsWith("gemini-");
  }
  if (normalizedProvider === "zai") {
    return modelId.startsWith("glm-");
  }
  if (normalizedProvider === "qwen" || normalizedProvider === "qwen-coding-plan" || false) {
    return modelId.includes("qwen");
  }
  if (normalizedProvider === "moonshot" || normalizedProvider === "kimi-coding") {
    return modelId.includes("kimi");
  }
  if (normalizedProvider === "minimax" || normalizedProvider === "minimax-cn") {
    return modelId.includes("minimax-m2");
  }
  if (
    [
      "openrouter",
      "vercel-ai-gateway",
      "opencode",
      "huggingface",
      "venice",
      "together",
      "synthetic",
      "litellm",
    ].includes(normalizedProvider)
  ) {
    return /(gpt-5|claude-|gemini-|grok-|qwen|kimi|glm-|deepseek-r1|reasoning|thinking)/.test(
      modelId,
    );
  }
  return false;
}

export function resolveModelThinkingCapability(params: {
  provider?: string | null;
  model?: string | null;
  reasoning?: boolean;
  capabilities?: ModelThinkingCapabilityInput | null;
}): ModelThinkingCapability | null {
  const explicitLevels = normalizeThinkingLevels(params.capabilities?.thinkingLevels);
  const hasExplicitThinking =
    explicitLevels.length > 0 ||
    typeof params.capabilities?.thinkingMode === "string" ||
    typeof params.capabilities?.defaultThinkingLevel === "string";
  if (params.capabilities?.fixedReasoning === true && !hasExplicitThinking) {
    return null;
  }
  const hasReasoning =
    params.reasoning === true ||
    (params.reasoning !== false &&
      canInferReasoningFromProviderModel(params.provider, params.model));
  if (!hasReasoning && !hasExplicitThinking) {
    return null;
  }

  const fallback = resolveFallbackThinkingMode(params.provider, params.model);
  const fallbackLevels =
    fallback.thinkingMode === "zai-binary"
      ? (["off", "low"] satisfies ModelThinkingLevel[])
      : listGenericThinkingLevels(params.provider, params.model);
  const thinkingLevels = explicitLevels.length > 0 ? explicitLevels : fallbackLevels;
  const explicitDefault = normalizeThinkLevel(params.capabilities?.defaultThinkingLevel);
  const defaultThinkingLevel =
    explicitDefault && thinkingLevels.includes(explicitDefault)
      ? explicitDefault
      : thinkingLevels.includes("low")
        ? "low"
        : (thinkingLevels[0] ?? "off");
  return {
    thinkingLevels,
    defaultThinkingLevel,
    thinkingMode:
      (params.capabilities?.thinkingMode as ModelThinkingMode | undefined) ?? fallback.thinkingMode,
    reasoningBudgetSupported:
      params.capabilities?.reasoningBudgetSupported ?? fallback.reasoningBudgetSupported,
  };
}

export function listThinkingLevels(
  provider?: string | null,
  model?: string | null,
): ModelThinkingLevel[] {
  if (isBinaryThinkingProvider(provider)) {
    return ["off", "low"];
  }
  return listGenericThinkingLevels(provider, model);
}

export function listThinkingLevelLabels(
  provider?: string | null,
  model?: string | null,
): ModelThinkingLevel[] {
  return listThinkingLevels(provider, model);
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
): string {
  return listThinkingLevelLabels(provider, model).join(separator);
}

export function formatXHighModelHint(): string {
  const refs = [...XHIGH_MODEL_REFS] as string[];
  if (refs.length === 0) {
    return "unknown model";
  }
  if (refs.length === 1) {
    return refs[0];
  }
  if (refs.length === 2) {
    return `${refs[0]} or ${refs[1]}`;
  }
  return `${refs.slice(0, -1).join(", ")} or ${refs[refs.length - 1]}`;
}
