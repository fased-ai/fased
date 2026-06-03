import type { FasedAgentConfig } from "./config.js";

const DEFAULT_MEMORY_PLUGIN_ID = "memory-core";

function normalizePluginId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const pluginId = value.trim();
  return pluginId ? pluginId : null;
}

function listIncludesNormalized(values: readonly string[] | undefined, pluginId: string): boolean {
  return values?.some((value) => normalizePluginId(value) === pluginId) === true;
}

export function resolveActiveMemoryPluginAllowlistId(cfg: FasedAgentConfig): string | null {
  if (cfg.plugins?.enabled === false) {
    return null;
  }
  const rawSlot = normalizePluginId(cfg.plugins?.slots?.memory);
  const pluginId = rawSlot ?? DEFAULT_MEMORY_PLUGIN_ID;
  if (pluginId.toLowerCase() === "none") {
    return null;
  }
  if (cfg.plugins?.entries?.[pluginId]?.enabled === false) {
    return null;
  }
  if (listIncludesNormalized(cfg.plugins?.deny, pluginId)) {
    return null;
  }
  return pluginId;
}

export function ensurePluginAllowlisted(
  cfg: FasedAgentConfig,
  pluginId: string,
  options: { createIfMissing?: boolean } = {},
): FasedAgentConfig {
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId) {
    return cfg;
  }
  const allow = cfg.plugins?.allow;
  if (!Array.isArray(allow)) {
    if (!options.createIfMissing) {
      return cfg;
    }
    return {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        allow: [normalizedPluginId],
      },
    };
  }
  if (allow.includes(normalizedPluginId)) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, normalizedPluginId],
    },
  };
}

export function ensureActiveMemoryPluginAllowlisted(
  cfg: FasedAgentConfig,
  options: { createIfMissing?: boolean } = {},
): FasedAgentConfig {
  const pluginId = resolveActiveMemoryPluginAllowlistId(cfg);
  if (!pluginId) {
    return cfg;
  }
  return ensurePluginAllowlisted(cfg, pluginId, options);
}

export function repairInstalledPluginAllowlist(cfg: FasedAgentConfig): {
  config: FasedAgentConfig;
  repairedPluginIds: string[];
} {
  const allow = cfg.plugins?.allow;
  const allowWasConfigured = Array.isArray(allow);
  const allowSet = new Set((allow ?? []).map(normalizePluginId).filter((id) => id !== null));
  const candidatePluginIds = new Set<string>();
  for (const [pluginId, entry] of Object.entries(cfg.plugins?.entries ?? {})) {
    if (entry?.enabled === false) {
      continue;
    }
    const normalized = normalizePluginId(pluginId);
    if (normalized) {
      candidatePluginIds.add(normalized);
    }
  }
  for (const pluginId of Object.keys(cfg.plugins?.installs ?? {})) {
    const normalized = normalizePluginId(pluginId);
    if (normalized) {
      candidatePluginIds.add(normalized);
    }
  }

  const memoryPluginId = resolveActiveMemoryPluginAllowlistId(cfg);
  if (memoryPluginId && (allowWasConfigured || candidatePluginIds.size > 0)) {
    candidatePluginIds.add(memoryPluginId);
  }

  const repairedPluginIds = new Set<string>();
  for (const pluginId of candidatePluginIds) {
    if (allowSet.has(pluginId)) {
      continue;
    }
    allowSet.add(pluginId);
    repairedPluginIds.add(pluginId);
  }

  if (repairedPluginIds.size === 0) {
    return { config: cfg, repairedPluginIds: [] };
  }

  const sortedPluginIds = [...repairedPluginIds].toSorted((left, right) =>
    left.localeCompare(right),
  );
  const sortedAllow = [...allowSet].toSorted((left, right) => left.localeCompare(right));
  return {
    config: {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        allow: sortedAllow,
      },
    },
    repairedPluginIds: sortedPluginIds,
  };
}
