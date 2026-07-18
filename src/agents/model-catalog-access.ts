import type { FasedAgentConfig } from "../config/types.js";
import { listProvidersWithStoredCredentials, type AuthProfileStore } from "./auth-profiles.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "./model-auth.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { buildAllowedModelSet, modelKey, normalizeProviderId } from "./model-selection.js";

export function providerHasConfiguredCredential(cfg: FasedAgentConfig, provider: string): boolean {
  return Boolean(resolveEnvApiKey(provider)?.apiKey || getCustomProviderApiKey(cfg, provider));
}

export function normalizeProviderSet(providers: Iterable<string> | undefined): Set<string> {
  return new Set(
    [...(providers ?? [])].map((provider) => normalizeProviderId(provider)).filter(Boolean),
  );
}

export function buildUsableModelProviderSet(params: {
  cfg: FasedAgentConfig;
  catalog: Array<{ provider: string }>;
  storedProviders?: Iterable<string>;
  store?: AuthProfileStore;
}): Set<string> {
  const usable = normalizeProviderSet(
    params.storedProviders ??
      (params.store ? listProvidersWithStoredCredentials(params.store) : []),
  );
  for (const entry of params.catalog) {
    const provider = normalizeProviderId(entry.provider);
    if (!provider || usable.has(provider)) {
      continue;
    }
    if (providerHasConfiguredCredential(params.cfg, provider)) {
      usable.add(provider);
    }
  }
  return usable;
}

export function filterModelCatalogByProviders<T extends { provider: string }>(
  catalog: T[],
  providers: Iterable<string>,
): T[] {
  const normalizedProviders = normalizeProviderSet(providers);
  if (normalizedProviders.size === 0) {
    return [];
  }
  return catalog.filter((entry) => normalizedProviders.has(normalizeProviderId(entry.provider)));
}

export function buildCredentialScopedAllowedModelSet(params: {
  cfg: FasedAgentConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
  storedProviders?: Iterable<string>;
  store?: AuthProfileStore;
}): {
  usableProviders: Set<string>;
  usableCatalog: ModelCatalogEntry[];
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
  allowAny: boolean;
} {
  const usableProviders = buildUsableModelProviderSet({
    cfg: params.cfg,
    catalog: params.catalog,
    storedProviders: params.storedProviders,
    store: params.store,
  });
  const usableCatalog = filterModelCatalogByProviders(params.catalog, usableProviders);
  const allowed = buildAllowedModelSet({
    cfg: params.cfg,
    catalog: usableCatalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  const allowedCatalog = filterModelCatalogByProviders(allowed.allowedCatalog, usableProviders);
  const allowedKeys = new Set(allowedCatalog.map((entry) => modelKey(entry.provider, entry.id)));
  return {
    usableProviders,
    usableCatalog,
    allowedCatalog,
    allowedKeys,
    allowAny: allowed.allowAny,
  };
}
