import type { AgentModelConfig } from "./types.agents-shared.js";

type AgentModelListLike = {
  primary?: string;
  fallbacks?: string[];
};

export const MAX_AGENT_MODEL_FALLBACKS = 1;

export function normalizeAgentModelFallbackValues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .slice(0, MAX_AGENT_MODEL_FALLBACKS);
}

export function resolveAgentModelPrimaryValue(model?: AgentModelConfig): string | undefined {
  if (typeof model === "string") {
    const trimmed = model.trim();
    return trimmed || undefined;
  }
  if (!model || typeof model !== "object") {
    return undefined;
  }
  const primary = model.primary?.trim();
  return primary || undefined;
}

export function resolveAgentModelFallbackValues(model?: AgentModelConfig): string[] {
  if (!model || typeof model !== "object") {
    return [];
  }
  return normalizeAgentModelFallbackValues(model.fallbacks) ?? [];
}

export function toAgentModelListLike(model?: AgentModelConfig): AgentModelListLike | undefined {
  if (typeof model === "string") {
    const primary = model.trim();
    return primary ? { primary } : undefined;
  }
  if (!model || typeof model !== "object") {
    return undefined;
  }
  return model;
}
