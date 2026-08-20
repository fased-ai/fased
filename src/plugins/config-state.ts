import { CORE_RUNTIME_CHANNEL_IDS, normalizeChatChannelId } from "../channels/ids.js";
import type { FasedAgentConfig } from "../config/config.js";
import type { PluginRecord } from "./registry.js";
import { defaultSlotIdForKey } from "./slots.js";

export type NormalizedPluginsConfig = {
  enabled: boolean;
  allow: string[];
  deny: string[];
  loadPaths: string[];
  slots: {
    memory?: string | null;
  };
  entries: Record<string, { enabled?: boolean; config?: unknown; runtime?: PluginRuntimeAccess }>;
};

export const PLUGIN_ADMIN_RPC_ACTION_METHODS = [
  "chat.inject",
  "push.test",
  "web.login.start",
  "web.login.wait",
] as const;

export type PluginAdminRpcActionMethod = (typeof PLUGIN_ADMIN_RPC_ACTION_METHODS)[number];

export type PluginAdminRpcActionGrant = {
  method: PluginAdminRpcActionMethod;
  sources: string[];
  requireOperatorApproval: boolean;
};

export type PluginRuntimeAccess = {
  helpers: {
    sessions: {
      read: boolean;
    };
  };
  adminRpcActions: {
    allow: PluginAdminRpcActionGrant[];
  };
};

export const BUNDLED_ENABLED_BY_DEFAULT = new Set<string>([
  ...CORE_RUNTIME_CHANNEL_IDS,
  "device-pair",
  "sat-mining",
]);

const normalizeList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
};

function isPluginAdminRpcActionMethod(value: unknown): value is PluginAdminRpcActionMethod {
  return (
    typeof value === "string" &&
    (PLUGIN_ADMIN_RPC_ACTION_METHODS as readonly string[]).includes(value)
  );
}

function normalizePluginAdminRpcActionGrants(value: unknown): PluginAdminRpcActionGrant[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const actions = value as Record<string, unknown>;
  const allow = Array.isArray(actions.allow) ? actions.allow : [];
  const normalized: PluginAdminRpcActionGrant[] = [];
  for (const item of allow) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const grant = item as Record<string, unknown>;
    if (!isPluginAdminRpcActionMethod(grant.method)) {
      continue;
    }
    normalized.push({
      method: grant.method,
      sources: normalizeList(grant.sources),
      requireOperatorApproval: grant.requireOperatorApproval === true,
    });
  }
  return normalized;
}

const normalizeSlotValue = (value: unknown): string | null | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase() === "none") {
    return null;
  }
  return trimmed;
};

const normalizePluginEntries = (entries: unknown): NormalizedPluginsConfig["entries"] => {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return {};
  }
  const normalized: NormalizedPluginsConfig["entries"] = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!key.trim()) {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      normalized[key] = {};
      continue;
    }
    const entry = value as Record<string, unknown>;
    normalized[key] = {
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
      config: "config" in entry ? entry.config : undefined,
      runtime: normalizePluginRuntimeAccess(entry.runtime),
    };
  }
  return normalized;
};

function normalizePluginRuntimeAccess(value: unknown): PluginRuntimeAccess | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const runtime = value as Record<string, unknown>;
  const helpers =
    runtime.helpers && typeof runtime.helpers === "object" && !Array.isArray(runtime.helpers)
      ? (runtime.helpers as Record<string, unknown>)
      : undefined;
  const sessions =
    helpers?.sessions && typeof helpers.sessions === "object" && !Array.isArray(helpers.sessions)
      ? (helpers.sessions as Record<string, unknown>)
      : undefined;
  return {
    helpers: {
      sessions: {
        read: sessions?.read === true,
      },
    },
    adminRpcActions: {
      allow: normalizePluginAdminRpcActionGrants(runtime.adminRpcActions),
    },
  };
}

export function isPluginRuntimeSessionReadAllowed(
  config: NormalizedPluginsConfig,
  pluginId: string,
): boolean {
  return config.entries[pluginId]?.runtime?.helpers.sessions.read === true;
}

export type PluginAdminRpcActionSource = {
  origin?: string;
  source?: string;
};

export type PluginAdminRpcActionGrantDecision =
  | {
      allowed: true;
      pluginId: string;
      method: PluginAdminRpcActionMethod;
      grant: PluginAdminRpcActionGrant;
      matchedSource: string;
    }
  | {
      allowed: false;
      pluginId: string;
      method: string;
      reason:
        | "invalid-admin-rpc-method"
        | "missing-runtime-admin-rpc-grant"
        | "missing-source-allowlist"
        | "source-not-allowlisted"
        | "operator-approval-required";
      sourceKeys: string[];
    };

export function resolvePluginAdminRpcActionSourceKeys(
  source: PluginAdminRpcActionSource = {},
): string[] {
  const keys: string[] = [];
  if (source.origin?.trim()) {
    keys.push(`origin:${source.origin.trim()}`);
  }
  if (source.source?.trim()) {
    const value = source.source.trim();
    keys.push(value, `source:${value}`);
  }
  return Array.from(new Set(keys));
}

export function resolvePluginAdminRpcActionGrant(params: {
  config: NormalizedPluginsConfig;
  pluginId: string;
  method: string;
  source?: PluginAdminRpcActionSource;
}): PluginAdminRpcActionGrantDecision {
  const sourceKeys = resolvePluginAdminRpcActionSourceKeys(params.source);
  if (!isPluginAdminRpcActionMethod(params.method)) {
    return {
      allowed: false,
      pluginId: params.pluginId,
      method: params.method,
      reason: "invalid-admin-rpc-method",
      sourceKeys,
    };
  }

  const grants =
    params.config.entries[params.pluginId]?.runtime?.adminRpcActions.allow.filter(
      (grant) => grant.method === params.method,
    ) ?? [];
  if (grants.length === 0) {
    return {
      allowed: false,
      pluginId: params.pluginId,
      method: params.method,
      reason: "missing-runtime-admin-rpc-grant",
      sourceKeys,
    };
  }

  const grantsWithSources = grants.filter((grant) => grant.sources.length > 0);
  if (grantsWithSources.length === 0) {
    return {
      allowed: false,
      pluginId: params.pluginId,
      method: params.method,
      reason: "missing-source-allowlist",
      sourceKeys,
    };
  }

  for (const grant of grantsWithSources) {
    const matchedSource = sourceKeys.find((key) => grant.sources.includes(key));
    if (!matchedSource) {
      continue;
    }
    if (!grant.requireOperatorApproval) {
      return {
        allowed: false,
        pluginId: params.pluginId,
        method: params.method,
        reason: "operator-approval-required",
        sourceKeys,
      };
    }
    return {
      allowed: true,
      pluginId: params.pluginId,
      method: params.method,
      grant,
      matchedSource,
    };
  }

  return {
    allowed: false,
    pluginId: params.pluginId,
    method: params.method,
    reason: "source-not-allowlisted",
    sourceKeys,
  };
}

export const normalizePluginsConfig = (
  config?: FasedAgentConfig["plugins"],
): NormalizedPluginsConfig => {
  const memorySlot = normalizeSlotValue(config?.slots?.memory);
  return {
    enabled: config?.enabled !== false,
    allow: normalizeList(config?.allow),
    deny: normalizeList(config?.deny),
    loadPaths: normalizeList(config?.load?.paths),
    slots: {
      memory: memorySlot === undefined ? defaultSlotIdForKey("memory") : memorySlot,
    },
    entries: normalizePluginEntries(config?.entries),
  };
};

const hasExplicitMemorySlot = (plugins?: FasedAgentConfig["plugins"]) =>
  Boolean(plugins?.slots && Object.prototype.hasOwnProperty.call(plugins.slots, "memory"));

const hasExplicitMemoryEntry = (plugins?: FasedAgentConfig["plugins"]) =>
  Boolean(plugins?.entries && Object.prototype.hasOwnProperty.call(plugins.entries, "memory-core"));

const hasExplicitPluginConfig = (plugins?: FasedAgentConfig["plugins"]) => {
  if (!plugins) {
    return false;
  }
  if (typeof plugins.enabled === "boolean") {
    return true;
  }
  if (Array.isArray(plugins.allow) && plugins.allow.length > 0) {
    return true;
  }
  if (Array.isArray(plugins.deny) && plugins.deny.length > 0) {
    return true;
  }
  if (plugins.load?.paths && Array.isArray(plugins.load.paths) && plugins.load.paths.length > 0) {
    return true;
  }
  if (plugins.slots && Object.keys(plugins.slots).length > 0) {
    return true;
  }
  if (plugins.entries && Object.keys(plugins.entries).length > 0) {
    return true;
  }
  return false;
};

export function applyTestPluginDefaults(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): FasedAgentConfig {
  if (!env.VITEST) {
    return cfg;
  }
  const plugins = cfg.plugins;
  const explicitConfig = hasExplicitPluginConfig(plugins);
  if (explicitConfig) {
    if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
      return cfg;
    }
    return {
      ...cfg,
      plugins: {
        ...plugins,
        slots: {
          ...plugins?.slots,
          memory: "none",
        },
      },
    };
  }

  return {
    ...cfg,
    plugins: {
      ...plugins,
      enabled: false,
      slots: {
        ...plugins?.slots,
        memory: "none",
      },
    },
  };
}

export function isTestDefaultMemorySlotDisabled(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!env.VITEST) {
    return false;
  }
  const plugins = cfg.plugins;
  if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
    return false;
  }
  return true;
}

export function resolveEnableState(
  id: string,
  origin: PluginRecord["origin"],
  config: NormalizedPluginsConfig,
): { enabled: boolean; reason?: string } {
  if (!config.enabled) {
    return { enabled: false, reason: "plugins disabled" };
  }
  if (config.deny.includes(id)) {
    return { enabled: false, reason: "blocked by denylist" };
  }
  if (config.allow.length > 0 && !config.allow.includes(id)) {
    return { enabled: false, reason: "not in allowlist" };
  }
  if (config.slots.memory === id) {
    return { enabled: true };
  }
  const entry = config.entries[id];
  if (entry?.enabled === true) {
    return { enabled: true };
  }
  if (entry?.enabled === false) {
    return { enabled: false, reason: "disabled in config" };
  }
  if (origin === "bundled" && BUNDLED_ENABLED_BY_DEFAULT.has(id)) {
    return { enabled: true };
  }
  if (origin === "bundled") {
    return { enabled: false, reason: "bundled (disabled by default)" };
  }
  return { enabled: true };
}

export function isBundledChannelEnabledByChannelConfig(
  cfg: FasedAgentConfig | undefined,
  pluginId: string,
): boolean {
  if (!cfg) {
    return false;
  }
  const channelId = normalizeChatChannelId(pluginId);
  if (!channelId) {
    return false;
  }
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = channels?.[channelId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  return (entry as Record<string, unknown>).enabled === true;
}

export function resolveEffectiveEnableState(params: {
  id: string;
  origin: PluginRecord["origin"];
  config: NormalizedPluginsConfig;
  rootConfig?: FasedAgentConfig;
}): { enabled: boolean; reason?: string } {
  const base = resolveEnableState(params.id, params.origin, params.config);
  if (
    !base.enabled &&
    base.reason === "bundled (disabled by default)" &&
    isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return { enabled: true };
  }
  return base;
}

export function resolveMemorySlotDecision(params: {
  id: string;
  kind?: string;
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  if (params.kind !== "memory") {
    return { enabled: true };
  }
  if (params.slot === null) {
    return { enabled: false, reason: "memory slot disabled" };
  }
  if (typeof params.slot === "string") {
    if (params.slot === params.id) {
      return { enabled: true, selected: true };
    }
    return {
      enabled: false,
      reason: `memory slot set to "${params.slot}"`,
    };
  }
  if (params.selectedId && params.selectedId !== params.id) {
    return {
      enabled: false,
      reason: `memory slot already filled by "${params.selectedId}"`,
    };
  }
  return { enabled: true, selected: true };
}
