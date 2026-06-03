import type { FasedAgentConfig } from "../config/config.js";
import {
  isPluginRuntimeSessionReadAllowed,
  normalizePluginsConfig,
  PLUGIN_ADMIN_RPC_ACTION_METHODS,
  type PluginAdminRpcActionGrant,
  type PluginAdminRpcActionMethod,
} from "./config-state.js";

export type PluginRuntimeSessionReadGrantResult = {
  config: FasedAgentConfig;
  pluginId: string;
  enabled: boolean;
  changed: boolean;
};

export type PluginAdminRpcActionGrantResult = {
  config: FasedAgentConfig;
  pluginId: string;
  method: PluginAdminRpcActionMethod;
  enabled: boolean;
  sources: string[];
  changed: boolean;
};

function assertPluginAdminRpcActionMethod(method: string): PluginAdminRpcActionMethod {
  if ((PLUGIN_ADMIN_RPC_ACTION_METHODS as readonly string[]).includes(method)) {
    return method as PluginAdminRpcActionMethod;
  }
  throw new Error(`unsupported plugin admin RPC method: ${method}`);
}

function dedupeSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].toSorted((a, b) =>
    a.localeCompare(b),
  );
}

function serializeGrants(grants: readonly PluginAdminRpcActionGrant[]): string {
  return JSON.stringify(
    grants.map((grant) => ({
      method: grant.method,
      sources: dedupeSorted(grant.sources),
      requireOperatorApproval: grant.requireOperatorApproval,
    })),
  );
}

export function getPluginRuntimeSessionReadGrant(
  config: FasedAgentConfig,
  pluginId: string,
): boolean {
  const id = pluginId.trim();
  if (!id) {
    return false;
  }
  return isPluginRuntimeSessionReadAllowed(normalizePluginsConfig(config.plugins), id);
}

export function setPluginRuntimeSessionReadGrant(
  config: FasedAgentConfig,
  pluginId: string,
  enabled: boolean,
): PluginRuntimeSessionReadGrantResult {
  const id = pluginId.trim();
  if (!id) {
    throw new Error("plugin id is required");
  }

  const existingEntry = config.plugins?.entries?.[id] ?? {};
  const existingRuntime = existingEntry.runtime ?? {};
  const existingHelpers = existingRuntime.helpers ?? {};
  const existingSessions = existingHelpers.sessions ?? {};
  const previous = getPluginRuntimeSessionReadGrant(config, id);

  const next: FasedAgentConfig = {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [id]: {
          ...existingEntry,
          runtime: {
            ...existingRuntime,
            helpers: {
              ...existingHelpers,
              sessions: {
                ...existingSessions,
                read: enabled,
              },
            },
          },
        },
      },
    },
  };

  return {
    config: next,
    pluginId: id,
    enabled,
    changed: previous !== enabled,
  };
}

export function setPluginAdminRpcActionGrant(
  config: FasedAgentConfig,
  pluginId: string,
  method: string,
  enabled: boolean,
  sources: string[],
): PluginAdminRpcActionGrantResult {
  const id = pluginId.trim();
  if (!id) {
    throw new Error("plugin id is required");
  }
  const adminRpcMethod = assertPluginAdminRpcActionMethod(method.trim());
  const normalizedSources = dedupeSorted(sources);
  if (enabled && normalizedSources.length === 0) {
    throw new Error("at least one source key is required to grant plugin admin RPC access");
  }

  const existingEntry = config.plugins?.entries?.[id] ?? {};
  const existingRuntime = existingEntry.runtime ?? {};
  const normalizedGrants =
    normalizePluginsConfig(config.plugins).entries[id]?.runtime?.adminRpcActions.allow ?? [];
  const preservedGrants = normalizedGrants.filter((grant) => grant.method !== adminRpcMethod);
  const nextGrants = enabled
    ? [
        ...preservedGrants,
        {
          method: adminRpcMethod,
          sources: normalizedSources,
          requireOperatorApproval: true,
        },
      ]
    : preservedGrants;
  const changed = serializeGrants(normalizedGrants) !== serializeGrants(nextGrants);

  const next: FasedAgentConfig = {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [id]: {
          ...existingEntry,
          runtime: {
            ...existingRuntime,
            adminRpcActions: {
              ...existingRuntime.adminRpcActions,
              allow: nextGrants,
            },
          },
        },
      },
    },
  };

  return {
    config: next,
    pluginId: id,
    method: adminRpcMethod,
    enabled,
    sources: normalizedSources,
    changed,
  };
}
