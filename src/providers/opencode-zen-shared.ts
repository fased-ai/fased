import type { ModelCapabilityConfig } from "../config/types.models.js";
import { resolveModelThinkingCapability } from "../shared/model-thinking.js";

export const OPENCODE_ZEN_MODEL_IDS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex-spark",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3-flash",
  "qwen3.7-plus",
  "minimax-m2.7",
  "glm-5.2",
  "kimi-k2.6",
] as const;

export const OPENCODE_ZEN_MODEL_REFS = OPENCODE_ZEN_MODEL_IDS.map((id) => `opencode/${id}`);
export const OPENCODE_ZEN_DEFAULT_MODEL_REF = "opencode/gpt-5.5";
export const OPENCODE_ZEN_DEFAULT_MODEL = OPENCODE_ZEN_DEFAULT_MODEL_REF.slice("opencode/".length);

function inferOpencodeZenThinkingTarget(modelId: string): { provider: string; model: string } {
  const model = modelId.trim().toLowerCase();
  if (model.startsWith("claude-")) {
    return { provider: "anthropic", model };
  }
  if (model.startsWith("gemini-")) {
    return { provider: "google", model };
  }
  if (model.startsWith("glm-")) {
    return { provider: "zai", model };
  }
  if (model.startsWith("kimi-")) {
    return { provider: "moonshot", model };
  }
  if (model.startsWith("qwen")) {
    return { provider: "qwen", model };
  }
  if (model.startsWith("gpt-")) {
    return { provider: "openai", model };
  }
  return { provider: "opencode", model };
}

export function buildOpencodeZenModelCapability(modelId: string): ModelCapabilityConfig {
  const target = inferOpencodeZenThinkingTarget(modelId);
  const thinking = resolveModelThinkingCapability({
    provider: target.provider,
    model: target.model,
    reasoning: true,
  });
  return {
    tools: true,
    json: true,
    ...(thinking
      ? {
          thinkingLevels: thinking.thinkingLevels,
          defaultThinkingLevel: thinking.defaultThinkingLevel,
          thinkingMode: thinking.thinkingMode,
          reasoningBudgetSupported: thinking.reasoningBudgetSupported,
        }
      : {}),
  };
}

export function buildOpencodeZenModelCapabilityOverrides(
  refs: readonly string[],
): Record<string, ModelCapabilityConfig> {
  return Object.fromEntries(
    refs.map((ref) => [ref, buildOpencodeZenModelCapability(ref.replace(/^opencode\//, ""))]),
  );
}
