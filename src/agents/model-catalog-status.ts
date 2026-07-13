import type { FasedAgentConfig } from "../config/config.js";
import type { ProviderHealth } from "../providers/health.js";
import { listCurrentModelCatalogProviderIds } from "./current-model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { deriveModelMetadata, type ModelFeature, type ModelMetadata } from "./model-metadata.js";
import type { ProviderExtensionCatalogIndex } from "./provider-extension-catalog-index.js";
import { listProviderExtensionCatalogManifestEntries } from "./provider-extension-catalog-manifest.js";
import { normalizeProviderId } from "./provider-id.js";

type ModelCatalogCapabilityCounts = Record<`${ModelFeature}Models`, number>;

const SOURCE_CONFIDENCE_RANK: Record<string, number> = {
  configured: 600,
  runtime: 500,
  manifest: 400,
  "provider-index": 300,
  "current-preview": 200,
  catalog: 100,
};

function createCapabilityCounts(): ModelCatalogCapabilityCounts {
  return {
    textModels: 0,
    visionModels: 0,
    reasoningModels: 0,
    toolsModels: 0,
    jsonModels: 0,
    audioModels: 0,
    videoModels: 0,
    speechModels: 0,
  };
}

function capabilityKey(feature: ModelFeature): keyof ModelCatalogCapabilityCounts {
  return `${feature}Models`;
}

function resolveProviderConfig(params: { cfg: FasedAgentConfig; provider: string }) {
  return params.cfg.models?.providers?.[params.provider];
}

function deriveStatusMetadata(params: {
  cfg: FasedAgentConfig;
  model: ModelCatalogEntry;
  provider: string;
}): ModelMetadata {
  return (
    params.model.metadata ??
    deriveModelMetadata({
      model: params.model,
      cfg: params.cfg,
      providerConfig: resolveProviderConfig({
        cfg: params.cfg,
        provider: params.provider,
      }),
    })
  );
}

function higherConfidence(left: string, right: string): string {
  return (SOURCE_CONFIDENCE_RANK[left] ?? 0) >= (SOURCE_CONFIDENCE_RANK[right] ?? 0) ? left : right;
}

export function buildModelCatalogStatus(params: {
  catalog: ModelCatalogEntry[];
  cfg: FasedAgentConfig;
  providerExtensionCatalog?: ProviderExtensionCatalogIndex;
  providerHealth?: Record<string, ProviderHealth>;
  checkedAtMs?: number;
}) {
  const configuredProviders = new Set(
    Object.keys(params.cfg.models?.providers ?? {}).map((provider) =>
      normalizeProviderId(provider),
    ),
  );
  const sourceCounts: Record<string, number> = {};
  const providers = new Map<
    string,
    {
      provider: string;
      totalModels: number;
      configured: boolean;
      reasoningModels: number;
      visionModels: number;
      sources: Set<string>;
      sourceConfidence: string;
      capabilityCounts: ModelCatalogCapabilityCounts;
      authModes: Set<string>;
      privateNetwork: {
        models: number;
        allowed: number;
        blocked: number;
      };
      maxContextWindow?: number;
      maxOutputTokens?: number;
    }
  >();
  let reasoningModels = 0;
  let visionModels = 0;
  const capabilityCounts = createCapabilityCounts();

  for (const model of params.catalog) {
    const provider = normalizeProviderId(model.provider);
    if (!provider) {
      continue;
    }
    const source = model.catalogSource ?? "catalog";
    sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
    let entry = providers.get(provider);
    if (!entry) {
      entry = {
        provider,
        totalModels: 0,
        configured: configuredProviders.has(provider),
        reasoningModels: 0,
        visionModels: 0,
        sources: new Set<string>(),
        sourceConfidence: source,
        capabilityCounts: createCapabilityCounts(),
        authModes: new Set<string>(),
        privateNetwork: {
          models: 0,
          allowed: 0,
          blocked: 0,
        },
      };
      providers.set(provider, entry);
    }
    entry.totalModels += 1;
    entry.sources.add(source);
    entry.sourceConfidence = higherConfidence(entry.sourceConfidence, source);

    const metadata = deriveStatusMetadata({ cfg: params.cfg, model, provider });
    entry.authModes.add(metadata.authMode);
    for (const feature of metadata.features) {
      entry.capabilityCounts[capabilityKey(feature)] += 1;
      capabilityCounts[capabilityKey(feature)] += 1;
    }
    if (metadata.privateNetwork) {
      entry.privateNetwork.models += 1;
      if (metadata.privateNetworkAllowed) {
        entry.privateNetwork.allowed += 1;
      } else {
        entry.privateNetwork.blocked += 1;
      }
    }
    if (typeof metadata.contextWindow === "number") {
      entry.maxContextWindow = Math.max(entry.maxContextWindow ?? 0, metadata.contextWindow);
    }
    if (typeof metadata.maxTokens === "number") {
      entry.maxOutputTokens = Math.max(entry.maxOutputTokens ?? 0, metadata.maxTokens);
    }

    if (model.reasoning === true) {
      reasoningModels += 1;
      entry.reasoningModels += 1;
    }
    if (model.input?.includes("image")) {
      visionModels += 1;
      entry.visionModels += 1;
    }
  }

  const providerRows = Array.from(providers.values())
    .map((provider) => ({
      provider: provider.provider,
      totalModels: provider.totalModels,
      configured: provider.configured,
      reasoningModels: provider.reasoningModels,
      visionModels: provider.visionModels,
      sources: Array.from(provider.sources).toSorted((left, right) => left.localeCompare(right)),
      sourceConfidence: provider.sourceConfidence,
      capabilityCounts: provider.capabilityCounts,
      authModes: Array.from(provider.authModes).toSorted((left, right) =>
        left.localeCompare(right),
      ),
      privateNetwork: provider.privateNetwork,
      probeStatus: params.providerHealth?.[provider.provider]
        ? params.providerHealth[provider.provider].reachable === "ok" &&
          params.providerHealth[provider.provider].auth !== "fail"
          ? "ok"
          : params.providerHealth[provider.provider].reachable === "fail" ||
              params.providerHealth[provider.provider].auth === "fail"
            ? "fail"
            : "unknown"
        : "not-run",
      ...(params.providerHealth?.[provider.provider]
        ? {
            health: {
              reachable: params.providerHealth[provider.provider].reachable,
              auth: params.providerHealth[provider.provider].auth,
              modelsDiscovered: params.providerHealth[provider.provider].modelsDiscovered,
              privateNetworkApproved:
                params.providerHealth[provider.provider].privateNetworkApproved,
              ...(typeof params.providerHealth[provider.provider].checkedAtMs === "number"
                ? { checkedAtMs: params.providerHealth[provider.provider].checkedAtMs }
                : {}),
              ...(params.providerHealth[provider.provider].detail
                ? { detail: params.providerHealth[provider.provider].detail }
                : {}),
            },
          }
        : {}),
      ...(provider.maxContextWindow ? { maxContextWindow: provider.maxContextWindow } : {}),
      ...(provider.maxOutputTokens ? { maxOutputTokens: provider.maxOutputTokens } : {}),
    }))
    .toSorted((left, right) => left.provider.localeCompare(right.provider));

  const manifestEntries = listProviderExtensionCatalogManifestEntries();
  const mappedManifestProviderIds = [
    ...new Set(
      manifestEntries.flatMap((entry) =>
        entry.status === "mapped" ? entry.fasedProviderIds.map(normalizeProviderId) : [],
      ),
    ),
  ]
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
  const catalogProviderIds = new Set([
    ...listCurrentModelCatalogProviderIds(),
    ...providerRows.map((provider) => provider.provider),
    ...Object.keys(params.providerExtensionCatalog?.providers ?? {}).map(normalizeProviderId),
  ]);
  const deferredProviderIds = manifestEntries
    .filter((entry) => entry.status === "deferred")
    .map((entry) => normalizeProviderId(entry.upstreamProviderId))
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));

  const providerExtensionEntries = (params.providerExtensionCatalog?.entries ?? []).map(
    (entry) => ({
      id: entry.id,
      source: entry.source,
      trusted: entry.trusted,
      providerIds: entry.providerIds,
      loadedProviderIds: entry.loadedProviderIds,
      modelCount: entry.modelCount,
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
    }),
  );
  const providerExtensionWarnings = providerExtensionEntries.filter(
    (entry) => entry.status === "error" || entry.status === "skipped-untrusted",
  );

  return {
    checkedAtMs: params.checkedAtMs ?? Date.now(),
    cache: {
      modelCatalog: "shared-loader",
      providerExtensionCatalog: params.providerExtensionCatalog
        ? "fresh-status-load"
        : "not-loaded",
    },
    totalProviders: providerRows.length,
    totalModels: params.catalog.length,
    configuredProviders: providerRows.filter((provider) => provider.configured).length,
    availableProviders: providerRows.filter((provider) => !provider.configured).length,
    reasoningModels,
    visionModels,
    capabilityCounts,
    sourceCounts,
    providers: providerRows,
    providerExtensionCatalog: {
      totalEntries: providerExtensionEntries.length,
      loadedEntries: providerExtensionEntries.filter((entry) => entry.status === "loaded").length,
      skippedUntrustedEntries: providerExtensionEntries.filter(
        (entry) => entry.status === "skipped-untrusted",
      ).length,
      emptyEntries: providerExtensionEntries.filter((entry) => entry.status === "empty").length,
      errorEntries: providerExtensionEntries.filter((entry) => entry.status === "error").length,
      modelCount: providerExtensionEntries.reduce((total, entry) => total + entry.modelCount, 0),
      loadedProviderIds: Object.keys(params.providerExtensionCatalog?.providers ?? {}).toSorted(
        (left, right) => left.localeCompare(right),
      ),
      warnings: providerExtensionWarnings,
      entries: providerExtensionEntries,
    },
    providerExtensionManifest: {
      upstreamProviderCount: manifestEntries.length,
      mappedProviderCount: manifestEntries.filter((entry) => entry.status === "mapped").length,
      deferredProviderCount: manifestEntries.filter((entry) => entry.status === "deferred").length,
      mappedProviderIds: mappedManifestProviderIds,
      deferredProviderIds,
      missingMappedProviderIds: mappedManifestProviderIds.filter(
        (providerId) => !catalogProviderIds.has(providerId),
      ),
    },
  };
}
