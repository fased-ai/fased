import type { ModelProviderConfig } from "../config/types.models.js";
import { normalizeModelCatalogProviderId } from "./model-catalog-normalized.js";

export type ProviderExtensionCatalogSource = "bundled" | "workspace" | "global" | "config";

export type ProviderExtensionCatalogModule = {
  provider?: ModelProviderConfig;
  providers?: Record<string, ModelProviderConfig | undefined>;
  default?: {
    provider?: ModelProviderConfig;
    providers?: Record<string, ModelProviderConfig | undefined>;
  };
};

export type ProviderExtensionCatalogEntry = {
  id: string;
  source: ProviderExtensionCatalogSource;
  providerIds: readonly string[];
  trusted?: boolean;
  load: () => ProviderExtensionCatalogModule | Promise<ProviderExtensionCatalogModule>;
};

export type ProviderExtensionCatalogEntryStatus = {
  id: string;
  source: ProviderExtensionCatalogSource;
  trusted: boolean;
  providerIds: string[];
  loadedProviderIds: string[];
  modelCount: number;
  status: "loaded" | "skipped-untrusted" | "empty" | "error";
  error?: string;
};

export type ProviderExtensionCatalogIndex = {
  providers: Record<string, ModelProviderConfig>;
  entries: ProviderExtensionCatalogEntryStatus[];
};

const UNSAFE_PROVIDER_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const DEFAULT_PROVIDER_EXTENSION_CATALOG_ENTRIES: readonly ProviderExtensionCatalogEntry[] = [];

let providerExtensionCatalogEntriesForTest: readonly ProviderExtensionCatalogEntry[] | undefined;

export function __setProviderExtensionCatalogEntriesForTest(
  entries?: readonly ProviderExtensionCatalogEntry[],
): void {
  providerExtensionCatalogEntriesForTest = entries;
}

export function listBundledProviderExtensionCatalogEntries(): readonly ProviderExtensionCatalogEntry[] {
  return providerExtensionCatalogEntriesForTest ?? DEFAULT_PROVIDER_EXTENSION_CATALOG_ENTRIES;
}

function normalizeProviderIds(providerIds: readonly string[]): string[] {
  return [
    ...new Set(
      providerIds
        .map((providerId) => normalizeModelCatalogProviderId(providerId))
        .filter((providerId) => providerId.length > 0 && !UNSAFE_PROVIDER_KEYS.has(providerId)),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function normalizeEntryTrust(entry: ProviderExtensionCatalogEntry): boolean {
  return entry.trusted === true || entry.source === "bundled";
}

function collectProviderConfigs(
  entry: ProviderExtensionCatalogEntry,
  module: ProviderExtensionCatalogModule,
): Record<string, ModelProviderConfig> {
  const providers: Record<string, ModelProviderConfig> = {};
  const explicitProviderIds = normalizeProviderIds(entry.providerIds);
  const moduleProviders = module.providers ?? module.default?.providers;

  if (moduleProviders) {
    for (const [providerIdRaw, providerConfig] of Object.entries(moduleProviders)) {
      const providerId = normalizeProviderIds([providerIdRaw])[0];
      if (!providerId || !providerConfig) {
        continue;
      }
      providers[providerId] = providerConfig;
    }
  }

  const singleProvider = module.provider ?? module.default?.provider;
  if (singleProvider && explicitProviderIds[0]) {
    providers[explicitProviderIds[0]] = singleProvider;
  }

  return providers;
}

function countModels(providers: Record<string, ModelProviderConfig>): number {
  return Object.values(providers).reduce(
    (total, provider) => total + (Array.isArray(provider.models) ? provider.models.length : 0),
    0,
  );
}

function formatCatalogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadProviderExtensionCatalogIndex(params?: {
  entries?: readonly ProviderExtensionCatalogEntry[];
  includeUntrusted?: boolean;
}): Promise<ProviderExtensionCatalogIndex> {
  const entries = params?.entries ?? listBundledProviderExtensionCatalogEntries();
  const includeUntrusted = params?.includeUntrusted === true;
  const providers: Record<string, ModelProviderConfig> = {};
  const statuses: ProviderExtensionCatalogEntryStatus[] = [];

  for (const entry of entries) {
    const providerIds = normalizeProviderIds(entry.providerIds);
    const trusted = normalizeEntryTrust(entry);
    if (!trusted && !includeUntrusted) {
      statuses.push({
        id: entry.id,
        source: entry.source,
        trusted,
        providerIds,
        loadedProviderIds: [],
        modelCount: 0,
        status: "skipped-untrusted",
      });
      continue;
    }

    try {
      const module = await entry.load();
      const loadedProviders = collectProviderConfigs(entry, module);
      const loadedProviderIds = Object.keys(loadedProviders).toSorted((left, right) =>
        left.localeCompare(right),
      );
      for (const providerId of loadedProviderIds) {
        providers[providerId] = loadedProviders[providerId]!;
      }
      const modelCount = countModels(loadedProviders);
      statuses.push({
        id: entry.id,
        source: entry.source,
        trusted,
        providerIds,
        loadedProviderIds,
        modelCount,
        status: loadedProviderIds.length > 0 ? "loaded" : "empty",
      });
    } catch (error) {
      statuses.push({
        id: entry.id,
        source: entry.source,
        trusted,
        providerIds,
        loadedProviderIds: [],
        modelCount: 0,
        status: "error",
        error: formatCatalogError(error),
      });
    }
  }

  return { providers, entries: statuses };
}
