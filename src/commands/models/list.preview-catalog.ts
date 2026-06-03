import { normalizeModelCatalogProviderId } from "../../agents/model-catalog-normalized.js";
import { buildFasedModelCatalogRows } from "../../agents/model-catalog-source.js";
import { loadModelCatalog, type ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { FasedAgentConfig } from "../../config/config.js";
import type { ModelListSource } from "./list.registry.js";

function toModelListSource(
  entry: ModelCatalogEntry | ReturnType<typeof buildFasedModelCatalogRows>[number],
): ModelListSource {
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    input: entry.input,
    baseUrl: entry.baseUrl,
    api: entry.api,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    reasoning: entry.reasoning,
    metadata: "metadata" in entry ? entry.metadata : undefined,
  };
}

export function loadPreviewModelListSources(params: {
  cfg: FasedAgentConfig;
  providerFilter?: string;
}): ModelListSource[] {
  const providerFilter = params.providerFilter
    ? normalizeModelCatalogProviderId(params.providerFilter)
    : undefined;
  return buildFasedModelCatalogRows({ config: params.cfg })
    .filter((row) => !providerFilter || row.provider === providerFilter)
    .map(toModelListSource);
}

export async function loadMergedPreviewModelListSources(params: {
  cfg: FasedAgentConfig;
  providerFilter?: string;
}): Promise<ModelListSource[]> {
  const providerFilter = params.providerFilter
    ? normalizeModelCatalogProviderId(params.providerFilter)
    : undefined;
  try {
    const catalog = await loadModelCatalog({
      config: params.cfg,
      useCache: false,
      includeMetadata: true,
    });
    if (catalog.length > 0) {
      return catalog
        .filter((entry) => !providerFilter || entry.provider === providerFilter)
        .map(toModelListSource);
    }
  } catch {
    // Fall through to the static preview catalog. This path is used when the
    // runtime registry is stale or temporarily unavailable during install/update.
  }
  return loadPreviewModelListSources(params);
}
