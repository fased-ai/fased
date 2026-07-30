import { existsSync } from "node:fs";
import type { FasedAgentConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import { resolvePluginInstallDir } from "./install.js";

export type PluginInstallUpdate = PluginInstallRecord & { pluginId: string };

export type UpdateOwnedPluginInstallStateRepair = {
  config: FasedAgentConfig;
  changed: boolean;
  changes: string[];
  warnings: string[];
  repairedPluginIds: string[];
};

export function buildNpmResolutionInstallFields(
  resolution?: NpmSpecResolution,
): Pick<
  PluginInstallRecord,
  "resolvedName" | "resolvedVersion" | "resolvedSpec" | "integrity" | "shasum" | "resolvedAt"
> {
  return {
    resolvedName: resolution?.name,
    resolvedVersion: resolution?.version,
    resolvedSpec: resolution?.resolvedSpec,
    integrity: resolution?.integrity,
    shasum: resolution?.shasum,
    resolvedAt: resolution?.resolvedAt,
  };
}

export function recordPluginInstall(
  cfg: FasedAgentConfig,
  update: PluginInstallUpdate,
): FasedAgentConfig {
  const { pluginId, ...record } = update;
  const installs = {
    ...cfg.plugins?.installs,
    [pluginId]: {
      ...cfg.plugins?.installs?.[pluginId],
      ...record,
      installedAt: record.installedAt ?? new Date().toISOString(),
    },
  };

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      installs: {
        ...installs,
        [pluginId]: installs[pluginId],
      },
    },
  };
}

export function repairUpdateOwnedPluginInstallState(
  cfg: FasedAgentConfig,
  options: {
    resolveNpmInstallPath?: (pluginId: string) => string;
    installPathExists?: (installPath: string) => boolean;
  } = {},
): UpdateOwnedPluginInstallStateRepair {
  const installs = cfg.plugins?.installs;
  if (!installs || Object.keys(installs).length === 0) {
    return {
      config: cfg,
      changed: false,
      changes: [],
      warnings: [],
      repairedPluginIds: [],
    };
  }

  const resolveNpmInstallPath = options.resolveNpmInstallPath ?? resolvePluginInstallDir;
  const installPathExists = options.installPathExists ?? existsSync;
  const nextInstalls: Record<string, PluginInstallRecord> = { ...installs };
  const changes: string[] = [];
  const warnings: string[] = [];
  const repairedPluginIds: string[] = [];

  for (const [pluginId, record] of Object.entries(installs).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (record.source !== "npm") {
      continue;
    }
    if (!record.spec?.trim()) {
      warnings.push(`Skipped npm install record repair for "${pluginId}": missing npm spec.`);
      continue;
    }
    let installPath: string;
    try {
      installPath = resolveNpmInstallPath(pluginId);
    } catch (err) {
      warnings.push(
        `Skipped npm install record repair for "${pluginId}": ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const configuredInstallPath = record.installPath?.trim();
    if (configuredInstallPath) {
      if (
        configuredInstallPath === installPath ||
        installPathExists(configuredInstallPath) ||
        !installPathExists(installPath)
      ) {
        continue;
      }
    }

    nextInstalls[pluginId] = {
      ...record,
      installPath,
    };
    repairedPluginIds.push(pluginId);
    changes.push(
      `${configuredInstallPath ? "Replaced stale" : "Repaired"} npm install record for "${pluginId}" with install path ${installPath}.`,
    );
  }

  if (repairedPluginIds.length === 0) {
    return {
      config: cfg,
      changed: false,
      changes,
      warnings,
      repairedPluginIds,
    };
  }

  return {
    config: {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        installs: nextInstalls,
      },
    },
    changed: true,
    changes,
    warnings,
    repairedPluginIds,
  };
}
