type BedrockClientLike = {
  send(command: unknown): Promise<unknown>;
};

type BedrockModelSummary = {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  responseStreamingSupported?: boolean;
  modelLifecycle?: { status?: string };
};

export type BedrockDiscoveryConfig = {
  providerFilter?: string[];
  refreshInterval?: number;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
};

export type DiscoveredBedrockModel = {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
};

const DEFAULT_CONTEXT_WINDOW = 32_000;
const DEFAULT_MAX_TOKENS = 4_096;

const cache = new Map<string, { at: number; models: DiscoveredBedrockModel[] }>();

function normalizeModality(value: string): "text" | "image" | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "text") {
    return "text";
  }
  if (normalized === "image") {
    return "image";
  }
  return undefined;
}

function cacheKey(params: { region: string; config?: BedrockDiscoveryConfig }): string {
  return JSON.stringify({
    region: params.region,
    providerFilter:
      params.config?.providerFilter?.map((entry) => entry.toLowerCase()).toSorted() ?? [],
    contextWindow: params.config?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: params.config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
  });
}

function isUsableSummary(summary: BedrockModelSummary): summary is BedrockModelSummary & {
  modelId: string;
} {
  if (!summary.modelId?.trim()) {
    return false;
  }
  if (summary.modelLifecycle?.status !== "ACTIVE") {
    return false;
  }
  if (!summary.responseStreamingSupported) {
    return false;
  }
  const outputs = summary.outputModalities ?? [];
  return outputs.some((entry) => entry.trim().toUpperCase() === "TEXT");
}

function mapSummary(
  summary: BedrockModelSummary & { modelId: string },
  config?: BedrockDiscoveryConfig,
): DiscoveredBedrockModel {
  const input = Array.from(
    new Set((summary.inputModalities ?? []).map(normalizeModality).filter(Boolean)),
  ) as Array<"text" | "image">;
  return {
    id: summary.modelId,
    name: summary.modelName?.trim() || summary.modelId,
    provider: summary.providerName?.trim() || "bedrock",
    reasoning: false,
    input: input.length ? input : ["text"],
    contextWindow: config?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

export async function discoverBedrockModels(params: {
  region: string;
  config?: BedrockDiscoveryConfig;
  clientFactory: () => BedrockClientLike;
  nowMs?: number;
}): Promise<DiscoveredBedrockModel[]> {
  const now = params.nowMs ?? Date.now();
  const refreshInterval = params.config?.refreshInterval ?? 60_000;
  const key = cacheKey(params);
  const cached = cache.get(key);
  if (cached && refreshInterval > 0 && now - cached.at < refreshInterval) {
    return cached.models;
  }

  const client = params.clientFactory();
  const response = (await client.send({} as never)) as { modelSummaries?: BedrockModelSummary[] };
  const providerFilter = new Set(
    (params.config?.providerFilter ?? [])
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  const models = (response.modelSummaries ?? [])
    .filter(isUsableSummary)
    .filter((summary) => {
      if (providerFilter.size === 0) {
        return true;
      }
      return providerFilter.has((summary.providerName ?? "").trim().toLowerCase());
    })
    .map((summary) => mapSummary(summary, params.config));

  if (refreshInterval > 0) {
    cache.set(key, { at: now, models });
  }
  return models;
}

export function resetBedrockDiscoveryCacheForTest() {
  cache.clear();
}
