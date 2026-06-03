import { normalizeProviderId } from "../agents/provider-id.js";
import type { ModelProviderConfig } from "../config/types.js";
import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderDiscoveryOrder,
  ProviderPlugin,
} from "./types.js";

const DISCOVERY_ORDER: readonly ProviderDiscoveryOrder[] = ["simple", "profile", "paired", "late"];

function resolveProviderCatalogHook(provider: ProviderPlugin) {
  return provider.catalog ?? provider.discovery;
}

function resolveProviderCatalogOrderHook(provider: ProviderPlugin) {
  return provider.catalog ?? provider.discovery ?? provider.staticCatalog;
}

function isUnsafeProviderKey(value: string): boolean {
  return value === "__proto__" || value === "prototype" || value === "constructor";
}

function normalizeProviderResultKey(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = normalizeProviderId(value);
  if (!normalized || isUnsafeProviderKey(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeSingleProviderResultKey(provider: ProviderPlugin): string | undefined {
  return [provider.id, ...(provider.aliases ?? [])]
    .map((candidate) => normalizeProviderResultKey(candidate))
    .find((candidate): candidate is string => Boolean(candidate));
}

export function groupPluginDiscoveryProvidersByOrder(
  providers: ProviderPlugin[],
): Record<ProviderDiscoveryOrder, ProviderPlugin[]> {
  const grouped = {
    simple: [],
    profile: [],
    paired: [],
    late: [],
  } as Record<ProviderDiscoveryOrder, ProviderPlugin[]>;

  for (const provider of providers) {
    const order = resolveProviderCatalogOrderHook(provider)?.order ?? "late";
    grouped[order].push(provider);
  }

  for (const order of DISCOVERY_ORDER) {
    grouped[order].sort((a, b) => a.label.localeCompare(b.label));
  }

  return grouped;
}

export function normalizePluginDiscoveryResult(params: {
  provider: ProviderPlugin;
  result: ProviderCatalogResult;
}): Record<string, ModelProviderConfig> {
  const result = params.result;
  if (!result) {
    return {};
  }

  if ("provider" in result) {
    const key = normalizeSingleProviderResultKey(params.provider);
    return key ? { [key]: result.provider } : {};
  }

  const normalized: Record<string, (typeof result.providers)[string]> = {};
  for (const [key, value] of Object.entries(result.providers)) {
    const normalizedKey = normalizeProviderResultKey(key);
    if (!normalizedKey || !value) {
      continue;
    }
    normalized[normalizedKey] = value;
  }
  return normalized;
}

export function runProviderCatalog(
  params: ProviderCatalogContext & {
    provider: ProviderPlugin;
  },
) {
  return resolveProviderCatalogHook(params.provider)?.run({
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env: params.env,
    resolveProviderApiKey: params.resolveProviderApiKey,
    resolveProviderAuth: params.resolveProviderAuth,
  });
}

export function runProviderStaticCatalog(
  params: ProviderCatalogContext & {
    provider: ProviderPlugin;
  },
) {
  return params.provider.staticCatalog?.run({
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env: params.env,
    resolveProviderApiKey: params.resolveProviderApiKey,
    resolveProviderAuth: params.resolveProviderAuth,
  });
}
