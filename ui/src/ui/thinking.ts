import {
  listThinkingLevelLabels as listCoreThinkingLevelLabels,
  normalizeThinkLevel,
  resolveModelThinkingCapability,
  type ModelThinkingLevel,
  type ModelThinkingMode,
} from "../../../src/shared/model-thinking.ts";

export type ThinkingCatalogEntry = {
  provider: string;
  id: string;
  reasoning?: boolean;
  capabilities?: {
    fixedReasoning?: boolean;
    thinkingLevels?: ModelThinkingLevel[];
    defaultThinkingLevel?: ModelThinkingLevel;
    thinkingMode?: ModelThinkingMode;
    reasoningBudgetSupported?: boolean;
  };
  metadata?: {
    features?: Array<
      "text" | "vision" | "reasoning" | "tools" | "json" | "audio" | "video" | "speech"
    >;
    thinkingLevels?: ModelThinkingLevel[];
    defaultThinkingLevel?: ModelThinkingLevel;
    thinkingMode?: ModelThinkingMode;
    reasoningBudgetSupported?: boolean;
  };
};

export { normalizeThinkLevel };

export function listThinkingLevelLabels(
  provider?: string | null,
  model?: string | null,
): readonly ModelThinkingLevel[] {
  return listCoreThinkingLevelLabels(provider, model);
}

export function formatThinkingLevels(provider?: string | null, model?: string | null): string {
  return listThinkingLevelLabels(provider, model).join(", ");
}

function candidateCapabilities(candidate?: ThinkingCatalogEntry) {
  if (!candidate) {
    return undefined;
  }
  return {
    ...candidate.capabilities,
    ...(candidate.metadata?.thinkingLevels
      ? { thinkingLevels: candidate.metadata.thinkingLevels }
      : {}),
    ...(candidate.metadata?.defaultThinkingLevel
      ? { defaultThinkingLevel: candidate.metadata.defaultThinkingLevel }
      : {}),
    ...(candidate.metadata?.thinkingMode ? { thinkingMode: candidate.metadata.thinkingMode } : {}),
    ...(candidate.metadata?.reasoningBudgetSupported !== undefined
      ? { reasoningBudgetSupported: candidate.metadata.reasoningBudgetSupported }
      : {}),
  };
}

export function resolveThinkingCapabilityForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}) {
  const candidate = params.catalog?.find(
    (entry) =>
      entry.provider.trim().toLowerCase() === params.provider.trim().toLowerCase() &&
      entry.id.trim().toLowerCase() === params.model.trim().toLowerCase(),
  );
  return resolveModelThinkingCapability({
    provider: params.provider,
    model: params.model,
    reasoning: candidate?.metadata?.features?.includes("reasoning") ? true : candidate?.reasoning,
    capabilities: candidateCapabilities(candidate),
  });
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}): ModelThinkingLevel {
  return (
    resolveThinkingCapabilityForModel(params)?.defaultThinkingLevel ??
    resolveModelThinkingCapability({
      provider: params.provider,
      model: params.model,
      reasoning: false,
    })?.defaultThinkingLevel ??
    "off"
  );
}
