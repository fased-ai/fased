import type { ModelCapabilityConfig, ModelDefinitionConfig } from "../config/types.js";
import { BASE_THINKING_LEVELS } from "../shared/model-thinking.js";
import { COPILOT_PROXY_MODEL_IDS, GITHUB_COPILOT_MODEL_IDS } from "./registry.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

export function getDefaultCopilotModelIds(): string[] {
  return [...GITHUB_COPILOT_MODEL_IDS];
}

export function getDefaultCopilotProxyModelIds(): string[] {
  return [...COPILOT_PROXY_MODEL_IDS];
}

function buildCopilotCapability(modelId: string): ModelCapabilityConfig {
  const normalized = modelId.trim().toLowerCase();
  if (/^gpt-5(?:[.-]|$)/.test(normalized)) {
    return {
      tools: true,
      json: true,
      thinkingLevels: [...BASE_THINKING_LEVELS],
      defaultThinkingLevel: "low",
      thinkingMode: "openai-reasoning-effort",
      reasoningBudgetSupported: false,
    };
  }
  if (
    normalized === "claude-opus-4.7" ||
    normalized === "claude-opus-4.6" ||
    normalized === "claude-opus-4.6-fast" ||
    normalized === "claude-sonnet-4.6"
  ) {
    return {
      tools: true,
      json: true,
      thinkingLevels: [...BASE_THINKING_LEVELS],
      defaultThinkingLevel: "low",
      thinkingMode: "anthropic-adaptive",
      reasoningBudgetSupported: true,
    };
  }
  if (
    normalized === "claude-opus-4.5" ||
    normalized === "claude-sonnet-4.5" ||
    normalized === "claude-haiku-4.5"
  ) {
    return {
      tools: true,
      json: true,
      thinkingLevels: [...BASE_THINKING_LEVELS],
      defaultThinkingLevel: "low",
      thinkingMode: "anthropic-thinking-budget",
      reasoningBudgetSupported: true,
    };
  }
  if (
    normalized === "gemini-2.5-pro" ||
    normalized === "gemini-3.1-pro" ||
    normalized === "gemini-3-flash"
  ) {
    return {
      tools: true,
      json: true,
      thinkingLevels: [...BASE_THINKING_LEVELS],
      defaultThinkingLevel: "low",
      thinkingMode: "google-thinking-budget",
      reasoningBudgetSupported: true,
    };
  }
  return { tools: true, json: true };
}

function buildCopilotModelDefinitionForApi(
  modelId: string,
  api: ModelDefinitionConfig["api"],
): ModelDefinitionConfig {
  const id = modelId.trim();
  if (!id) {
    throw new Error("Model id required");
  }
  return {
    id,
    name: id,
    // pi-coding-agent's registry schema doesn't know about a "github-copilot" API.
    // Keep the provider id as "github-copilot" while using the compatible API
    // surface selected by the route.
    api,
    reasoning: Boolean(buildCopilotCapability(id).thinkingMode),
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    capabilities: buildCopilotCapability(id),
  };
}

export function buildCopilotModelDefinition(modelId: string): ModelDefinitionConfig {
  return buildCopilotModelDefinitionForApi(modelId, "openai-responses");
}

export function buildCopilotProxyModelDefinition(modelId: string): ModelDefinitionConfig {
  return buildCopilotModelDefinitionForApi(modelId, "openai-completions");
}
