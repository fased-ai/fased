import {
  loadModelCatalog as defaultLoadModelCatalog,
  type ModelCatalogEntry,
  resetModelCatalogCacheForTest,
} from "../agents/model-catalog.js";
import { type FasedAgentConfig, loadConfig } from "../config/config.js";
import { resetRuntimeProviderModelCatalogCache } from "../providers/runtime-model-catalog.js";

export type GatewayModelChoice = ModelCatalogEntry;

type LoadModelCatalog = (params: {
  config: FasedAgentConfig;
  readOnly?: boolean;
  useCache?: boolean;
}) => Promise<GatewayModelChoice[]>;

type LoadGatewayModelCatalogParams = {
  getConfig?: () => FasedAgentConfig;
  loadModelCatalog?: LoadModelCatalog;
  readOnly?: boolean;
};

type GatewayModelCatalogCache = {
  lastSuccessfulCatalog: GatewayModelChoice[] | null;
  inFlightRefresh: Promise<GatewayModelChoice[]> | null;
  staleGeneration: number;
  appliedGeneration: number;
};

function createGatewayModelCatalogCache(): GatewayModelCatalogCache {
  return {
    lastSuccessfulCatalog: null,
    inFlightRefresh: null,
    staleGeneration: 0,
    appliedGeneration: 0,
  };
}

const readOnlyModelCatalogCache = createGatewayModelCatalogCache();
const fullModelCatalogCache = createGatewayModelCatalogCache();

function resetGatewayModelCatalogCache(cache: GatewayModelCatalogCache): void {
  cache.lastSuccessfulCatalog = null;
  cache.inFlightRefresh = null;
  cache.staleGeneration = 0;
  cache.appliedGeneration = 0;
}

function isGatewayModelCatalogStale(cache: GatewayModelCatalogCache): boolean {
  return cache.appliedGeneration < cache.staleGeneration;
}

function resolveGatewayModelCatalogCache(
  params?: LoadGatewayModelCatalogParams,
): GatewayModelCatalogCache {
  return params?.readOnly === false ? fullModelCatalogCache : readOnlyModelCatalogCache;
}

function resolveLoadModelCatalog(params?: LoadGatewayModelCatalogParams): LoadModelCatalog {
  return params?.loadModelCatalog ?? (defaultLoadModelCatalog as LoadModelCatalog);
}

function startGatewayModelCatalogRefresh(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  const cache = resolveGatewayModelCatalogCache(params);
  const config = (params?.getConfig ?? loadConfig)();
  const readOnly = params?.readOnly !== false;
  const refreshGeneration = cache.staleGeneration;
  const refresh = resolveLoadModelCatalog(params)({
    config,
    readOnly,
    useCache: false,
  })
    .then((catalog) => {
      if ((readOnly || catalog.length > 0) && refreshGeneration === cache.staleGeneration) {
        cache.lastSuccessfulCatalog = catalog;
        cache.appliedGeneration = cache.staleGeneration;
      }
      return catalog;
    })
    .finally(() => {
      if (cache.inFlightRefresh === refresh) {
        cache.inFlightRefresh = null;
      }
    });
  cache.inFlightRefresh = refresh;
  return refresh;
}

export function markGatewayModelCatalogStaleForReload(): void {
  readOnlyModelCatalogCache.staleGeneration += 1;
  fullModelCatalogCache.staleGeneration += 1;
  resetRuntimeProviderModelCatalogCache();
}

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export function __resetModelCatalogCacheForTest() {
  resetGatewayModelCatalogCache(readOnlyModelCatalogCache);
  resetGatewayModelCatalogCache(fullModelCatalogCache);
  resetModelCatalogCacheForTest();
  resetRuntimeProviderModelCatalogCache();
}

export async function loadGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  const cache = resolveGatewayModelCatalogCache(params);
  if (!isGatewayModelCatalogStale(cache) && cache.lastSuccessfulCatalog !== null) {
    return cache.lastSuccessfulCatalog;
  }
  if (isGatewayModelCatalogStale(cache) && cache.lastSuccessfulCatalog !== null) {
    if (!cache.inFlightRefresh) {
      void startGatewayModelCatalogRefresh(params).catch(() => undefined);
    }
    return cache.lastSuccessfulCatalog;
  }
  if (cache.inFlightRefresh) {
    return await cache.inFlightRefresh;
  }
  return await startGatewayModelCatalogRefresh(params);
}
