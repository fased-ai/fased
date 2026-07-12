import type { FasedAgentConfig } from "../config/types.js";
import {
  applyRuntimeProviderModelDiscovery,
  filterCatalogToAuthoritativeAvailability,
} from "../providers/runtime-model-catalog.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { buildCredentialScopedAllowedModelSet } from "./model-catalog-access.js";
import type { ModelCatalogEntry } from "./model-catalog.js";

export async function resolveAuthenticatedModelCatalog(params: {
  cfg: FasedAgentConfig;
  store: AuthProfileStore;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
}) {
  const initialScope = buildCredentialScopedAllowedModelSet({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    store: params.store,
  });
  const discoveredCatalog = filterCatalogToAuthoritativeAvailability(
    await applyRuntimeProviderModelDiscovery({
      cfg: params.cfg,
      store: params.store,
      routes: initialScope.usableProviders,
      catalog: initialScope.usableCatalog,
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
