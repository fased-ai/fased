import type { FasedAgentConfig } from "../config/types.js";
import {
  applyRuntimeProviderModelDiscovery,
  filterCatalogToAuthoritativeAvailability,
} from "../providers/runtime-model-catalog.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { buildCredentialScopedAllowedModelSet } from "./model-catalog-access.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { normalizeProviderId } from "./provider-id.js";

export async function resolveAuthenticatedModelCatalog(params: {
  cfg: FasedAgentConfig;
  store: AuthProfileStore;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  agentDir?: string;
  forceRefresh?: boolean;
  /** Execution scopes discovery to its chosen route; interactive refresh omits this. */
  discoveryRoutes?: Iterable<string>;
}) {
  const initialScope = buildCredentialScopedAllowedModelSet({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    store: params.store,
  });
  const discoveryRoutes = params.discoveryRoutes
    ? new Set(
        [...params.discoveryRoutes]
          .map(normalizeProviderId)
          .filter((route) => initialScope.usableProviders.has(route)),
      )
    : initialScope.usableProviders;
  const discoveredCatalog = filterCatalogToAuthoritativeAvailability(
    await applyRuntimeProviderModelDiscovery({
      cfg: params.cfg,
      store: params.store,
      routes: discoveryRoutes,
      catalog: initialScope.usableCatalog,
      agentDir: params.agentDir,
      forceRefresh: params.forceRefresh,
    }),
    params.store,
  );
  return buildCredentialScopedAllowedModelSet({
    cfg: params.cfg,
    catalog: discoveredCatalog,
    defaultProvider: params.defaultProvider,
    storedProviders: initialScope.usableProviders,
  });
}
