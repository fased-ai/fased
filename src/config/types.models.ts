import type { ModelThinkingLevel, ModelThinkingMode } from "../shared/model-thinking.js";
import type { SecretInput } from "./types.secrets.js";

export const MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
  "github-copilot",
  "ollama",
] as const;

export type ModelApi = (typeof MODEL_APIS)[number];

export type ModelCompatConfig = {
  responsesLite?: boolean;
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsTools?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  thinkingFormat?: "openai" | "zai" | "qwen";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresMistralToolIds?: boolean;
};

export type ModelCapabilityConfig = {
  tools?: boolean;
  json?: boolean;
  audio?: boolean;
  video?: boolean;
  speech?: boolean;
  streaming?: boolean;
  fixedReasoning?: boolean;
  thinkingLevels?: ModelThinkingLevel[];
  defaultThinkingLevel?: ModelThinkingLevel;
  thinkingMode?: ModelThinkingMode;
  reasoningBudgetSupported?: boolean;
};

export type ModelProviderAuthMode = "api-key" | "oauth" | "token" | "aws-sdk";

export type ModelProviderRequestConfig = {
  allowPrivateNetwork?: boolean;
};

export type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow?: number;
  /** Legacy/runtime alias for usable context after provider-side reservations. */
  contextTokens?: number;
  maxTokens?: number;
  baseUrl?: string;
  headers?: Record<string, string>;
  compat?: ModelCompatConfig;
  capabilities?: ModelCapabilityConfig;
};

export type ModelProviderConfig = {
  baseUrl?: string;
  apiKey?: SecretInput;
  auth?: ModelProviderAuthMode;
  api?: ModelApi;
  headers?: Record<string, string>;
  authHeader?: boolean;
  request?: ModelProviderRequestConfig;
  models: ModelDefinitionConfig[];
};

export type ModelsConfig = {
  mode?: "merge" | "replace";
  providers?: Record<string, ModelProviderConfig>;
};
