import { normalizeProviderId } from "../agents/provider-id.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { loadFasedAgentPlugins, type PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import type { ProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins");

export function resolvePluginProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
}): ProviderPlugin[] {
  const registry = loadFasedAgentPlugins({
    config: params.config,
    workspaceDir: params.workspaceDir,
    logger: createPluginLoaderLogger(log),
  });

  return registry.providers.map((entry) => entry.provider);
}

type ManifestProviderParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
};

type ProviderOnlyParams = ManifestProviderParams & {
  onlyPluginIds?: readonly string[];
};

type ModelSupportMatchKind = "pattern" | "prefix";

function resolveManifestRegistry(params: ManifestProviderParams): PluginManifestRegistry {
  return (
    params.manifestRegistry ??
    loadPluginManifestRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    })
  );
}

function resolveProviderManifestPlugins(
  registry: PluginManifestRegistry,
  onlyPluginIds?: readonly string[],
): PluginManifestRecord[] {
  const onlyPluginIdSet = onlyPluginIds ? new Set(onlyPluginIds) : null;
  return registry.plugins.filter(
    (plugin) => plugin.providers.length > 0 && (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)),
  );
}

function stripModelProfileSuffix(value: string): string {
  const trimmed = value.trim();
  const at = trimmed.indexOf("@");
  return at <= 0 ? trimmed : trimmed.slice(0, at).trim();
}

function splitExplicitModelRef(rawModel: string): { provider?: string; modelId: string } | null {
  const trimmed = rawModel.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    const modelId = stripModelProfileSuffix(trimmed);
    return modelId ? { modelId } : null;
  }
  const provider = normalizeProviderId(trimmed.slice(0, slash));
  const modelId = stripModelProfileSuffix(trimmed.slice(slash + 1));
  if (!provider || !modelId) {
    return null;
  }
  return { provider, modelId };
}

function resolveModelSupportMatchKind(
  plugin: PluginManifestRecord,
  modelId: string,
): ModelSupportMatchKind | undefined {
  const patterns = plugin.modelSupport?.modelPatterns ?? [];
  for (const patternSource of patterns) {
    try {
      if (new RegExp(patternSource, "u").test(modelId)) {
        return "pattern";
      }
    } catch {
      continue;
    }
  }

  const prefixes = plugin.modelSupport?.modelPrefixes ?? [];
  for (const prefix of prefixes) {
    if (modelId.startsWith(prefix)) {
      return "prefix";
    }
  }

  return undefined;
}

function dedupeSortedPluginIds(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function resolvePreferredManifestPluginIds(
  registry: PluginManifestRegistry,
  matchedPluginIds: readonly string[],
): string[] | undefined {
  if (matchedPluginIds.length === 0) {
    return undefined;
  }
  const uniquePluginIds = dedupeSortedPluginIds(matchedPluginIds);
  if (uniquePluginIds.length <= 1) {
    return uniquePluginIds;
  }
  const nonBundledPluginIds = uniquePluginIds.filter((pluginId) => {
    const plugin = registry.plugins.find((entry) => entry.id === pluginId);
    return plugin?.origin !== "bundled";
  });
  if (nonBundledPluginIds.length === 1) {
    return nonBundledPluginIds;
  }
  if (nonBundledPluginIds.length > 1) {
    return undefined;
  }
  return undefined;
}

export function resolveDiscoveredProviderPluginIds(params: ProviderOnlyParams): string[] {
  return resolveProviderManifestPlugins(resolveManifestRegistry(params), params.onlyPluginIds)
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveEnabledProviderPluginIds(params: ProviderOnlyParams): string[] {
  const registry = resolveManifestRegistry(params);
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return resolveProviderManifestPlugins(registry, params.onlyPluginIds)
    .filter(
      (plugin) =>
        resolveEffectiveEnableState({
          id: plugin.id,
          origin: plugin.origin,
          config: normalizedConfig,
          rootConfig: params.config,
        }).enabled,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveOwningPluginIdsForProvider(
  params: ManifestProviderParams & { provider: string },
): string[] | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!normalizedProvider) {
    return undefined;
  }

  const pluginIds = resolveManifestRegistry(params)
    .plugins.filter((plugin) =>
      plugin.providers.some((providerId) => normalizeProviderId(providerId) === normalizedProvider),
    )
    .map((plugin) => plugin.id);

  return pluginIds.length > 0 ? pluginIds : undefined;
}

export function resolveOwningPluginIdsForModelRef(
  params: ManifestProviderParams & { model: string },
): string[] | undefined {
  const parsed = splitExplicitModelRef(params.model);
  if (!parsed) {
    return undefined;
  }

  if (parsed.provider) {
    return resolveOwningPluginIdsForProvider({
      ...params,
      provider: parsed.provider,
    });
  }

  const registry = resolveManifestRegistry(params);
  const matchedByPattern = registry.plugins
    .filter((plugin) => resolveModelSupportMatchKind(plugin, parsed.modelId) === "pattern")
    .map((plugin) => plugin.id);
  const preferredPatternPluginIds = resolvePreferredManifestPluginIds(registry, matchedByPattern);
  if (preferredPatternPluginIds) {
    return preferredPatternPluginIds;
  }

  const matchedByPrefix = registry.plugins
    .filter((plugin) => resolveModelSupportMatchKind(plugin, parsed.modelId) === "prefix")
    .map((plugin) => plugin.id);
  return resolvePreferredManifestPluginIds(registry, matchedByPrefix);
}

export function resolveOwningPluginIdsForModelRefs(
  params: ManifestProviderParams & { models: readonly string[] },
): string[] {
  return dedupeSortedPluginIds(
    params.models.flatMap(
      (model) =>
        resolveOwningPluginIdsForModelRef({
          ...params,
          model,
        }) ?? [],
    ),
  );
}
