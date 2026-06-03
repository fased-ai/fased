import type { ModelCapabilityConfig, ModelDefinitionConfig } from "../config/types.models.js";
import { resolveModelThinkingCapability } from "../shared/model-thinking.js";

type VercelAiGatewayModelCatalogEntry = {
  id: string;
  contextWindow: number;
  maxTokens: number;
  tags: readonly string[];
};

export const VERCEL_AI_GATEWAY_MODEL_CATALOG = [
  {
    id: "openai/gpt-5.5-pro",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    tags: ["reasoning", "tool-use", "implicit-caching", "file-input", "web-search", "vision"],
  },
  {
    id: "openai/gpt-5.5",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    tags: ["reasoning", "tool-use", "web-search", "implicit-caching", "file-input", "vision"],
  },
  {
    id: "openai/gpt-5.4-pro",
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    tags: ["reasoning", "tool-use", "vision", "file-input", "implicit-caching", "web-search"],
  },
  {
    id: "openai/gpt-5.4",
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    tags: ["reasoning", "tool-use", "vision", "file-input", "implicit-caching", "web-search"],
  },
  {
    id: "openai/gpt-5.4-mini",
    contextWindow: 400_000,
    maxTokens: 128_000,
    tags: ["reasoning", "tool-use", "vision", "file-input", "implicit-caching", "web-search"],
  },
  {
    id: "openai/gpt-5.4-nano",
    contextWindow: 400_000,
    maxTokens: 128_000,
    tags: ["reasoning", "tool-use", "implicit-caching", "web-search", "vision", "file-input"],
  },
  {
    id: "openai/gpt-5.3-codex",
    contextWindow: 400_000,
    maxTokens: 128_000,
    tags: ["reasoning", "tool-use", "file-input", "vision", "web-search", "implicit-caching"],
  },
  {
    id: "openai/gpt-5-codex",
    contextWindow: 400_000,
    maxTokens: 128_000,
    tags: ["file-input", "implicit-caching", "reasoning", "tool-use", "web-search"],
  },
  {
    id: "anthropic/claude-opus-4.7",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    tags: ["tool-use", "reasoning", "vision", "file-input", "explicit-caching", "web-search"],
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    tags: ["file-input", "reasoning", "tool-use", "vision", "explicit-caching", "web-search"],
  },
  {
    id: "anthropic/claude-opus-4.6",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    tags: ["tool-use", "reasoning", "vision", "file-input", "explicit-caching", "web-search"],
  },
  {
    id: "anthropic/claude-haiku-4.5",
    contextWindow: 200_000,
    maxTokens: 64_000,
    tags: ["file-input", "reasoning", "tool-use", "vision", "explicit-caching"],
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    tags: ["file-input", "reasoning", "tool-use", "vision", "explicit-caching"],
  },
  {
    id: "google/gemini-3.1-pro-preview",
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    tags: ["file-input", "tool-use", "reasoning", "vision", "web-search", "implicit-caching"],
  },
  {
    id: "google/gemini-3.1-flash-lite",
    contextWindow: 1_000_000,
    maxTokens: 65_000,
    tags: ["reasoning", "tool-use", "implicit-caching", "file-input", "vision", "web-search"],
  },
  {
    id: "google/gemini-3-flash",
    contextWindow: 1_000_000,
    maxTokens: 65_000,
    tags: ["reasoning", "tool-use", "file-input", "vision", "web-search", "implicit-caching"],
  },
  {
    id: "google/gemini-2.5-pro",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    tags: ["file-input", "reasoning", "tool-use", "vision", "web-search", "implicit-caching"],
  },
  {
    id: "google/gemini-2.5-flash",
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    tags: ["file-input", "reasoning", "tool-use", "vision", "web-search", "implicit-caching"],
  },
  {
    id: "xai/grok-4.3",
    contextWindow: 1_000_000,
    maxTokens: 1_000_000,
    tags: ["reasoning", "tool-use", "implicit-caching", "file-input", "vision", "web-search"],
  },
  {
    id: "xai/grok-code-fast-1",
    contextWindow: 256_000,
    maxTokens: 256_000,
    tags: ["reasoning", "tool-use", "implicit-caching"],
  },
  {
    id: "mistral/mistral-large-3",
    contextWindow: 256_000,
    maxTokens: 256_000,
    tags: ["vision"],
  },
  {
    id: "mistral/mistral-medium",
    contextWindow: 128_000,
    maxTokens: 64_000,
    tags: ["tool-use", "vision"],
  },
  {
    id: "mistral/devstral-2",
    contextWindow: 256_000,
    maxTokens: 256_000,
    tags: ["tool-use"],
  },
  {
    id: "minimax/minimax-m2.7",
    contextWindow: 204_800,
    maxTokens: 131_000,
    tags: ["reasoning", "tool-use", "implicit-caching", "file-input", "vision"],
  },
  {
    id: "minimax/minimax-m2.7-highspeed",
    contextWindow: 204_800,
    maxTokens: 131_100,
    tags: ["reasoning", "tool-use", "implicit-caching", "vision"],
  },
  {
    id: "moonshotai/kimi-k2.6",
    contextWindow: 262_000,
    maxTokens: 262_000,
    tags: ["reasoning", "tool-use", "vision", "file-input", "implicit-caching"],
  },
] as const satisfies readonly VercelAiGatewayModelCatalogEntry[];

export const VERCEL_AI_GATEWAY_MODEL_IDS = VERCEL_AI_GATEWAY_MODEL_CATALOG.map((model) => model.id);

export const VERCEL_AI_GATEWAY_MODEL_REFS = VERCEL_AI_GATEWAY_MODEL_IDS.map(
  (id) => `vercel-ai-gateway/${id}`,
);

export const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF = "vercel-ai-gateway/openai/gpt-5.5";

const VERCEL_AI_GATEWAY_PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  google: "Google",
  minimax: "MiniMax",
  mistral: "Mistral",
  moonshotai: "Moonshot",
  openai: "OpenAI",
  xai: "xAI",
};

function findVercelAiGatewayModelEntry(id: string): VercelAiGatewayModelCatalogEntry | undefined {
  const normalized = id
    .trim()
    .replace(/^vercel-ai-gateway\//, "")
    .toLowerCase();
  return VERCEL_AI_GATEWAY_MODEL_CATALOG.find((model) => model.id.toLowerCase() === normalized);
}

function inferProviderTarget(id: string): { provider: string; model: string } {
  const [prefix, ...modelParts] = id
    .trim()
    .replace(/^vercel-ai-gateway\//, "")
    .split("/");
  const model = modelParts.join("/");
  switch (prefix) {
    case "anthropic":
      return { provider: "anthropic", model };
    case "google":
      return { provider: "google", model };
    case "minimax":
      return { provider: "minimax", model };
    case "moonshotai":
      return { provider: "moonshot", model };
    case "openai":
      return { provider: "openai", model };
    case "xai":
      return { provider: "xai", model };
    default:
      return { provider: "vercel-ai-gateway", model: id };
  }
}

export function buildVercelAiGatewayModelCapability(id: string): ModelCapabilityConfig | undefined {
  const entry = findVercelAiGatewayModelEntry(id);
  if (!entry) {
    return undefined;
  }
  const tags = new Set(entry.tags.map((tag) => tag.toLowerCase()));
  const target = inferProviderTarget(entry.id);
  const thinking = tags.has("reasoning")
    ? resolveModelThinkingCapability({
        provider: target.provider,
        model: target.model,
        reasoning: true,
      })
    : null;
  return {
    tools: tags.has("tool-use"),
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

export function buildVercelAiGatewayModelCapabilityOverrides(
  refs: readonly string[],
): Record<string, ModelCapabilityConfig> {
  return Object.fromEntries(
    refs.flatMap((ref) => {
      const capability = buildVercelAiGatewayModelCapability(ref);
      return capability ? ([[ref, capability]] as const) : [];
    }),
  );
}

function formatVercelAiGatewayModelName(id: string): string {
  const [provider, ...modelParts] = id.split("/");
  const label = VERCEL_AI_GATEWAY_PROVIDER_LABELS[provider ?? ""] ?? provider;
  const modelId = modelParts.join("/");
  if (!label || !modelId) {
    return id;
  }
  const name = modelId
    .replace(/\bapi\b/gi, "API")
    .replace(/\bgpt\b/gi, "GPT")
    .replace(/\bxai\b/gi, "xAI")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
  return `${label} ${name}`;
}

export function buildVercelAiGatewayModelDefinition(id: string): ModelDefinitionConfig {
  const entry = findVercelAiGatewayModelEntry(id);
  const tags = new Set(entry?.tags.map((tag) => tag.toLowerCase()) ?? []);
  const capabilities = buildVercelAiGatewayModelCapability(id);
  return {
    id,
    name: formatVercelAiGatewayModelName(id),
    reasoning: tags.has("reasoning"),
    input: tags.has("vision") ? ["text", "image"] : ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: entry?.contextWindow ?? 200_000,
    maxTokens: entry?.maxTokens ?? 8192,
    api: "openai-completions",
    ...(capabilities ? { capabilities } : {}),
  };
}
