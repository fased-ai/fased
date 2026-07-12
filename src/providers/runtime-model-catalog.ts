import { createHash } from "node:crypto";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { buildModelCatalogMergeKey } from "../agents/model-catalog-normalized.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { deriveModelMetadata } from "../agents/model-metadata.js";
import type { FasedAgentConfig, ModelCapabilityConfig } from "../config/types.js";
import {
  buildProviderRefreshEnvFromCredentials,
  fetchProviderRefreshSnapshotForRoutes,
  type ProviderRefreshModelSnapshot,
  type ProviderRefreshSnapshot,
} from "./refresh.js";

const DISCOVERY_TTL_MS = 5 * 60_000;

type RuntimeDiscoveryCache = {
  key: string;
  expiresAt: number;
  value: Promise<ProviderRefreshSnapshot>;
};

let cache: RuntimeDiscoveryCache | null = null;

function interactiveRuntimeProviders(store: AuthProfileStore): Set<string> {
  const credentialTypesByProvider = new Map<string, Set<string>>();
  for (const credential of Object.values(store.profiles ?? {})) {
    const provider = credential.provider.trim().toLowerCase();
    if (!provider) {
      continue;
    }
    const types = credentialTypesByProvider.get(provider) ?? new Set<string>();
    types.add(credential.type);
    credentialTypesByProvider.set(provider, types);
  }
  return new Set(
    [...credentialTypesByProvider.entries()].flatMap(([provider, types]) =>
      !types.has("api_key") && (types.has("oauth") || types.has("token")) ? [provider] : [],
    ),
  );
}

export function resetRuntimeProviderModelCatalogCache(): void {
  cache = null;
}

function discoveryKey(params: {
  routes: Iterable<string>;
  cfg: FasedAgentConfig;
  store: AuthProfileStore;
}): string {
  const routes = [...params.routes].map((route) => route.trim().toLowerCase()).toSorted();
  const endpoints = routes.map((route) => {
    const provider = params.cfg.models?.providers?.[route];
    return [route, provider?.baseUrl ?? "", provider?.api ?? ""];
  });
  const credentialIdentity = createHash("sha256")
    .update(JSON.stringify(params.store.profiles ?? {}))
    .digest("hex");
  return JSON.stringify({ endpoints, credentialIdentity });
}

async function loadSnapshot(params: {
  routes: Iterable<string>;
  cfg: FasedAgentConfig;
  store: AuthProfileStore;
}): Promise<ProviderRefreshSnapshot> {
  const key = discoveryKey(params);
  const now = Date.now();
  if (cache?.key === key && cache.expiresAt > now) {
    return await cache.value;
  }
  const value = fetchProviderRefreshSnapshotForRoutes({
    routes: params.routes,
    env: buildProviderRefreshEnvFromCredentials({
      env: process.env,
      authStores: [params.store],
      modelProviders: params.cfg.models?.providers,
    }),
  });
  cache = { key, expiresAt: now + DISCOVERY_TTL_MS, value };
  try {
    return await value;
  } catch (error) {
    if (cache?.value === value) {
      cache = null;
    }
    throw error;
  }
}

function snapshotCapabilities(model: ProviderRefreshModelSnapshot): ModelCapabilityConfig {
  return {
    ...(model.tools !== undefined ? { tools: model.tools } : {}),
    ...(model.json !== undefined ? { json: model.json } : {}),
    ...(model.audio !== undefined ? { audio: model.audio } : {}),
    ...(model.video !== undefined ? { video: model.video } : {}),
    ...(model.speech !== undefined ? { speech: model.speech } : {}),
    ...(model.thinkingLevels?.length ? { thinkingLevels: model.thinkingLevels } : {}),
    ...(model.defaultThinkingLevel ? { defaultThinkingLevel: model.defaultThinkingLevel } : {}),
    ...(model.thinkingMode ? { thinkingMode: model.thinkingMode } : {}),
    ...(model.reasoningBudgetSupported !== undefined
      ? { reasoningBudgetSupported: model.reasoningBudgetSupported }
      : {}),
  };
}

function snapshotHasCapabilityMetadata(model: ProviderRefreshModelSnapshot): boolean {
  return (
    model.input !== undefined ||
    model.reasoning !== undefined ||
    model.tools !== undefined ||
    model.json !== undefined ||
    model.audio !== undefined ||
    model.video !== undefined ||
    model.speech !== undefined ||
    model.thinkingLevels !== undefined ||
    model.defaultThinkingLevel !== undefined ||
    model.thinkingMode !== undefined ||
    model.reasoningBudgetSupported !== undefined ||
    model.contextWindow !== undefined ||
    model.maxTokens !== undefined
  );
}

function snapshotRoutes(
  snapshot: ProviderRefreshSnapshot,
): Map<string, ProviderRefreshModelSnapshot[]> {
  const routes = new Map<string, ProviderRefreshModelSnapshot[]>();
  for (const provider of Object.values(snapshot.providers ?? {})) {
    for (const [route, values] of Object.entries(provider.routes ?? {})) {
      routes.set(
        route.trim().toLowerCase(),
        values.flatMap((value) =>
          typeof value === "string" ? [{ id: value }] : value?.id?.trim() ? [value] : [],
        ),
      );
    }
  }
  return routes;
}

function mergeDiscoveredRoute(params: {
  route: string;
  discovered: ProviderRefreshModelSnapshot[];
  catalog: ModelCatalogEntry[];
  cfg: FasedAgentConfig;
  retrievedAt: string;
}): ModelCatalogEntry[] {
  const baseByKey = new Map(
    params.catalog.map((model) => [buildModelCatalogMergeKey(model.provider, model.id), model]),
  );
  const providerConfig = params.cfg.models?.providers?.[params.route];
  return params.discovered.map((model) => {
    const base = baseByKey.get(buildModelCatalogMergeKey(params.route, model.id));
    const capabilities = snapshotCapabilities(model);
    const entry: ModelCatalogEntry = {
      id: model.id,
      name: base?.name ?? model.id,
      provider: params.route,
      ...((model.contextWindow ?? base?.contextWindow)
        ? { contextWindow: model.contextWindow ?? base?.contextWindow }
        : {}),
      ...((model.maxTokens ?? base?.maxTokens)
        ? { maxTokens: model.maxTokens ?? base?.maxTokens }
        : {}),
      ...((model.reasoning ?? base?.reasoning)
        ? { reasoning: model.reasoning ?? base?.reasoning }
        : {}),
      input: model.input ?? base?.input ?? ["text"],
      ...((base?.baseUrl ?? providerConfig?.baseUrl)
        ? { baseUrl: base?.baseUrl ?? providerConfig?.baseUrl }
        : {}),
      ...((base?.api ?? providerConfig?.api) ? { api: base?.api ?? providerConfig?.api } : {}),
      ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
      catalogSource: "provider-api",
    };
    return {
      ...entry,
      metadata: {
        ...deriveModelMetadata({
          model: entry,
          cfg: params.cfg,
          providerConfig,
          ...(snapshotHasCapabilityMetadata(model)
            ? {
                capabilitySource: "provider-api" as const,
                capabilityRetrievedAt: params.retrievedAt,
              }
            : {}),
        }),
        retrievedAt: params.retrievedAt,
      },
    };
  });
}

export async function applyRuntimeProviderModelDiscovery(params: {
  cfg: FasedAgentConfig;
  store: AuthProfileStore;
  routes: Iterable<string>;
  catalog: ModelCatalogEntry[];
}): Promise<ModelCatalogEntry[]> {
  const requestedRoutes = new Set(
    [...params.routes].map((route) => route.trim().toLowerCase()).filter(Boolean),
  );
  if (requestedRoutes.size === 0) {
    return [];
  }
  const runtimeProviders = interactiveRuntimeProviders(params.store);
  const providerApiRoutes = [...requestedRoutes].filter((route) => !runtimeProviders.has(route));
  if (providerApiRoutes.length === 0) {
    return params.catalog;
  }
  let snapshot: ProviderRefreshSnapshot;
  try {
    snapshot = await loadSnapshot({
      ...params,
      routes: providerApiRoutes,
    });
  } catch {
    return params.catalog.filter(
      (model) => !providerApiRoutes.includes(model.provider.trim().toLowerCase()),
    );
  }
  const discoveredRoutes = snapshotRoutes(snapshot);
  const retrievedAt = new Date().toISOString();
  const authoritativeRoutes = new Set(
    [...discoveredRoutes.keys()].filter((route) => requestedRoutes.has(route)),
  );
  const retained = params.catalog.filter(
    (model) => !providerApiRoutes.includes(model.provider.trim().toLowerCase()),
  );
  const discovered = [...authoritativeRoutes].flatMap((route) =>
    mergeDiscoveredRoute({
      route,
      discovered: discoveredRoutes.get(route) ?? [],
      catalog: params.catalog,
      cfg: params.cfg,
      retrievedAt,
    }),
  );
  return [...retained, ...discovered].toSorted(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      (left.metadata?.recommendationRank ?? Number.MAX_SAFE_INTEGER) -
        (right.metadata?.recommendationRank ?? Number.MAX_SAFE_INTEGER) ||
      left.name.localeCompare(right.name),
  );
}

export function filterCatalogToAuthoritativeAvailability(
  catalog: ModelCatalogEntry[],
  store?: AuthProfileStore,
): ModelCatalogEntry[] {
  const runtimeProviders = store ? interactiveRuntimeProviders(store) : new Set<string>();
  const byProvider = new Map<string, ModelCatalogEntry[]>();
  for (const model of catalog) {
    const provider = model.provider.trim().toLowerCase();
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), model]);
  }
  return [...byProvider.entries()].flatMap(([provider, models]) => {
    if (models.some((model) => model.catalogSource === "provider-api")) {
      return models.filter((model) => model.catalogSource === "provider-api");
    }
    if (runtimeProviders.has(provider)) {
      return models.filter((model) => model.catalogSource === "runtime");
    }
    return models;
  });
}
