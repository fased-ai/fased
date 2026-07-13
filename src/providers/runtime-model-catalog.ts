import { createHash } from "node:crypto";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { buildModelCatalogMergeKey } from "../agents/model-catalog-normalized.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import {
  deriveModelMetadata,
  type ModelCredentialRouteMetadata,
} from "../agents/model-metadata.js";
import type {
  FasedAgentConfig,
  ModelCapabilityConfig,
  ModelProviderAuthMode,
} from "../config/types.js";
import { discoverGitHubCopilotModels } from "./github-copilot-model-discovery.js";
import { discoverOpenAICodexModels } from "./openai-codex-model-discovery.js";
import {
  buildProviderRefreshEnvFromCredentials,
  fetchProviderRefreshSnapshotForRoutes,
  type ProviderRefreshModelSnapshot,
  type ProviderRefreshSnapshot,
} from "./refresh.js";
import { getProviderBrandManifestForRoute, type ProviderAuthMethodManifest } from "./registry.js";

const DISCOVERY_TTL_MS = 5 * 60_000;

type RuntimeDiscoveryCache = {
  key: string;
  expiresAt: number;
  value: Promise<ProviderRefreshSnapshot>;
};

let cache: RuntimeDiscoveryCache | null = null;

const SPECIALIZED_DISCOVERY_ROUTES = new Set(["openai-codex", "github-copilot"]);

function authModeForProfileType(type: "api_key" | "oauth" | "token"): ModelProviderAuthMode {
  return type === "api_key" ? "api-key" : type;
}

function methodMatchesAuthMode(
  method: ProviderAuthMethodManifest,
  authMode: ModelProviderAuthMode,
): boolean {
  const methodMode: ModelProviderAuthMode =
    method.kind === "api-key" || method.kind === "manual"
      ? "api-key"
      : method.kind === "token"
        ? "token"
        : "oauth";
  return methodMode === authMode;
}

function methodRouteIds(method: ProviderAuthMethodManifest): string[] {
  return [method.route, method.statusRoute, method.configProviderId]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
}

function credentialRoutesForProvider(
  store: AuthProfileStore,
  route: string,
): ModelCredentialRouteMetadata[] {
  const normalizedRoute = route.trim().toLowerCase();
  const manifest = getProviderBrandManifestForRoute(normalizedRoute);
  const routes: ModelCredentialRouteMetadata[] = [];
  const seen = new Set<string>();
  for (const profile of Object.values(store.profiles ?? {})) {
    const profileProvider = profile.provider.trim().toLowerCase();
    if (!profileProvider) {
      continue;
    }
    const profileManifest = getProviderBrandManifestForRoute(profileProvider);
    if (profileProvider !== normalizedRoute && profileManifest?.id !== manifest?.id) {
      continue;
    }
    const authMode = authModeForProfileType(profile.type);
    const method = manifest?.methods.find(
      (candidate) =>
        methodMatchesAuthMode(candidate, authMode) &&
        (methodRouteIds(candidate).includes(profileProvider) ||
          methodRouteIds(candidate).includes(normalizedRoute)),
    );
    const id = method?.id ?? `${normalizedRoute}:${authMode}`;
    const key = `${id}:${authMode}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    routes.push({
      id,
      label: method?.label ?? manifest?.label ?? normalizedRoute,
      authMode,
    });
  }
  return routes;
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

async function discoverInteractiveRoutes(params: {
  routes: Set<string>;
  cfg: FasedAgentConfig;
  store: AuthProfileStore;
  agentDir?: string;
}): Promise<Map<string, ProviderRefreshModelSnapshot[]>> {
  const discovered = new Map<string, ProviderRefreshModelSnapshot[]>();
  if (params.routes.has("openai-codex")) {
    discovered.set(
      "openai-codex",
      await discoverOpenAICodexModels({
        cfg: params.cfg,
        store: params.store,
        agentDir: params.agentDir,
      }),
    );
  }
  if (params.routes.has("github-copilot")) {
    discovered.set(
      "github-copilot",
      await discoverGitHubCopilotModels({
        cfg: params.cfg,
        store: params.store,
        agentDir: params.agentDir,
      }),
    );
  }
  return discovered;
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
  store: AuthProfileStore;
  retrievedAt: string;
}): ModelCatalogEntry[] {
  const baseByKey = new Map(
    params.catalog.map((model) => [buildModelCatalogMergeKey(model.provider, model.id), model]),
  );
  const providerConfig = params.cfg.models?.providers?.[params.route];
  const credentialRoutes = credentialRoutesForProvider(params.store, params.route);
  return params.discovered.map((model) => {
    const base = baseByKey.get(buildModelCatalogMergeKey(params.route, model.id));
    const capabilities = snapshotCapabilities(model);
    const entry: ModelCatalogEntry = {
      id: model.id,
      name: model.name ?? base?.name ?? model.id,
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
      ...((model.price ?? base?.cost) ? { cost: model.price ?? base?.cost } : {}),
      ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
      ...(model.responsesLite !== undefined
        ? { compat: { ...base?.compat, responsesLite: model.responsesLite } }
        : base?.compat
          ? { compat: base.compat }
          : {}),
      catalogSource: "provider-api",
    };
    return {
      ...entry,
      metadata: {
        ...base?.metadata,
        ...deriveModelMetadata({
          model: entry,
          cfg: params.cfg,
          providerConfig,
          ...(credentialRoutes.length > 0 ? { credentialRoutes } : {}),
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
  agentDir?: string;
}): Promise<ModelCatalogEntry[]> {
  const requestedRoutes = new Set(
    [...params.routes].map((route) => route.trim().toLowerCase()).filter(Boolean),
  );
  if (requestedRoutes.size === 0) {
    return [];
  }
  const specializedRoutes = new Set(
    [...requestedRoutes].filter((route) => SPECIALIZED_DISCOVERY_ROUTES.has(route)),
  );
  const providerApiRoutes = [...requestedRoutes].filter((route) => !specializedRoutes.has(route));
  const interactiveRoutes = await discoverInteractiveRoutes({
    routes: requestedRoutes,
    cfg: params.cfg,
    store: params.store,
    agentDir: params.agentDir,
  }).catch(() => new Map<string, ProviderRefreshModelSnapshot[]>());
  let discoveredRoutes = new Map<string, ProviderRefreshModelSnapshot[]>(interactiveRoutes);
  if (providerApiRoutes.length > 0) {
    try {
      const snapshot = await loadSnapshot({
        ...params,
        routes: providerApiRoutes,
      });
      discoveredRoutes = new Map([...discoveredRoutes, ...snapshotRoutes(snapshot)]);
    } catch {
      // Authenticated route discovery remains usable when another provider is offline.
    }
  }
  const retrievedAt = new Date().toISOString();
  const authoritativeRoutes = new Set(
    [...discoveredRoutes.keys()].filter((route) => requestedRoutes.has(route)),
  );
  // Authenticated availability fails closed. A reviewed recommendation is not
  // proof that the selected credential can execute that model.
  const replacedRoutes = new Set(providerApiRoutes);
  for (const route of specializedRoutes) {
    replacedRoutes.add(route);
  }
  const retained = params.catalog.filter(
    (model) => !replacedRoutes.has(model.provider.trim().toLowerCase()),
  );
  const discovered = [...authoritativeRoutes].flatMap((route) =>
    mergeDiscoveredRoute({
      route,
      discovered: discoveredRoutes.get(route) ?? [],
      catalog: params.catalog,
      cfg: params.cfg,
      store: params.store,
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
  const specializedProviders = store
    ? new Set(
        Object.values(store.profiles ?? {})
          .map((profile) => profile.provider.trim().toLowerCase())
          .filter((provider) => SPECIALIZED_DISCOVERY_ROUTES.has(provider)),
      )
    : new Set<string>();
  const byProvider = new Map<string, ModelCatalogEntry[]>();
  for (const model of catalog) {
    const provider = model.provider.trim().toLowerCase();
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), model]);
  }
  return [...byProvider.entries()].flatMap(([provider, models]) => {
    if (models.some((model) => model.catalogSource === "provider-api")) {
      return models.filter((model) => model.catalogSource === "provider-api");
    }
    if (specializedProviders.has(provider)) {
      return models.filter(
        (model) => model.catalogSource === "runtime" || model.catalogSource === "provider-api",
      );
    }
    return models;
  });
}
