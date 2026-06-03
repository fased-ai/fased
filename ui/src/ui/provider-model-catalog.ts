import {
  getProviderBrandManifestForRoute,
  listProviderBrandManifests,
  lookupProviderManifestModelCapability,
} from "../../../src/providers/registry.ts";
import type { ModelCatalogEntry } from "./types.ts";

type ParsedModelRef = {
  provider: string;
  id: string;
};
type ModelCatalogMetadata = NonNullable<ModelCatalogEntry["metadata"]>;

function parseModelRef(ref: string): ParsedModelRef | null {
  const value = ref.trim();
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex === value.length - 1) {
    return null;
  }
  return {
    provider: value.slice(0, slashIndex),
    id: value.slice(slashIndex + 1),
  };
}

function catalogKeys(entry: ModelCatalogEntry) {
  const provider = entry.provider?.trim().toLowerCase();
  const id = entry.id?.trim().toLowerCase();
  if (!provider || !id) {
    return [];
  }
  const prefixedId = id.startsWith(`${provider}/`) ? id : `${provider}/${id}`;
  return [`${provider}/${id}`, prefixedId];
}

function buildRuntimeIndex(catalog: ModelCatalogEntry[]) {
  const byKey = new Map<string, ModelCatalogEntry>();
  for (const entry of catalog) {
    for (const key of catalogKeys(entry)) {
      if (!byKey.has(key)) {
        byKey.set(key, entry);
      }
    }
  }
  return byKey;
}

function providerKey(value: string | undefined | null) {
  return value?.trim().toLowerCase() ?? "";
}

function displayModelName(id: string) {
  return id
    .split("/")
    .at(-1)!
    .split(/[-_.:]+/g)
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

function metadataForModel(provider: string, id: string, runtime?: ModelCatalogEntry) {
  const capability = lookupProviderManifestModelCapability(provider, id) ?? {};
  const features = new Set<ModelCatalogMetadata["features"][number]>(
    runtime?.metadata?.features ?? ["text"],
  );
  features.add("text");
  if (runtime?.reasoning || capability.fixedReasoning || capability.thinkingLevels?.length) {
    features.add("reasoning");
  }
  if (capability.tools) {
    features.add("tools");
  }
  if (capability.json) {
    features.add("json");
  }
  if (capability.audio) {
    features.add("audio");
  }
  if (capability.video) {
    features.add("video");
  }
  if (capability.speech) {
    features.add("speech");
  }
  if (runtime?.input?.includes("image")) {
    features.add("vision");
  }
  return {
    provider,
    model: id,
    label: runtime?.metadata?.label ?? runtime?.name ?? displayModelName(id),
    contextWindow: runtime?.metadata?.contextWindow ?? runtime?.contextWindow,
    maxTokens: runtime?.metadata?.maxTokens ?? runtime?.maxTokens,
    features: [...features],
    ...(capability.thinkingLevels ? { thinkingLevels: capability.thinkingLevels } : {}),
    ...(capability.defaultThinkingLevel
      ? { defaultThinkingLevel: capability.defaultThinkingLevel }
      : {}),
    ...(capability.thinkingMode ? { thinkingMode: capability.thinkingMode } : {}),
    ...(capability.reasoningBudgetSupported !== undefined
      ? { reasoningBudgetSupported: capability.reasoningBudgetSupported }
      : {}),
    authMode: runtime?.metadata?.authMode ?? "api-key",
    privateNetwork: runtime?.metadata?.privateNetwork ?? false,
    privateNetworkAllowed: runtime?.metadata?.privateNetworkAllowed ?? false,
    streaming: runtime?.metadata?.streaming ?? true,
    capabilityConfidence: runtime?.metadata?.capabilityConfidence ?? "declared",
    recommended: true,
    default: runtime?.metadata?.default ?? false,
  } satisfies ModelCatalogMetadata;
}

export function buildManifestModelCatalog(
  catalog: ModelCatalogEntry[] = [],
  options: { includeAllManifest?: boolean; includeRuntimeModels?: boolean } = {},
): ModelCatalogEntry[] {
  const runtimeByKey = buildRuntimeIndex(catalog);
  const inputProviders = new Set(
    catalog.map((entry) => providerKey(entry.provider)).filter(Boolean),
  );
  const entries: ModelCatalogEntry[] = [];
  const seen = new Set<string>();

  const addEntry = (params: { provider: string; id: string; runtime?: ModelCatalogEntry }) => {
    const key = `${params.provider.toLowerCase()}/${params.id.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const runtime = params.runtime;
    const capability = lookupProviderManifestModelCapability(params.provider, params.id) ?? {};
    entries.push({
      id: params.id,
      name: runtime?.name ?? displayModelName(params.id),
      provider: params.provider,
      contextWindow: runtime?.contextWindow,
      maxTokens: runtime?.maxTokens,
      reasoning:
        runtime?.reasoning ??
        Boolean(capability.fixedReasoning || capability.thinkingLevels?.length),
      input: runtime?.input ?? ["text"],
      baseUrl: runtime?.baseUrl,
      api: runtime?.api,
      catalogSource: runtime?.catalogSource ?? "manifest",
      metadata: metadataForModel(params.provider, params.id, runtime),
    });
  };

  for (const manifest of listProviderBrandManifests()) {
    for (const ref of manifest.models.recommended) {
      const parsed = parseModelRef(ref);
      if (!parsed) {
        continue;
      }
      if (!options.includeAllManifest && !inputProviders.has(providerKey(parsed.provider))) {
        continue;
      }
      const key = `${parsed.provider.toLowerCase()}/${parsed.id.toLowerCase()}`;
      const runtime = runtimeByKey.get(key);
      addEntry({ provider: parsed.provider, id: parsed.id, runtime });
    }
  }

  if (options.includeRuntimeModels) {
    for (const runtime of catalog) {
      const provider = runtime.provider?.trim();
      const id = runtime.id?.trim();
      if (!provider || !id) {
        continue;
      }
      const manifest = getProviderBrandManifestForRoute(provider);
      const dynamicOrConfigured =
        manifest?.models.dynamic || runtime.catalogSource === "configured";
      if (!dynamicOrConfigured) {
        continue;
      }
      addEntry({ provider, id, runtime });
    }
  }

  return entries;
}
