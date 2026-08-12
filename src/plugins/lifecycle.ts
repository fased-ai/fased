import type { FasedAgentConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { enablePluginInConfig } from "./enable.js";
import { recordPluginInstall } from "./installs.js";
import { clearPluginManifestRegistryCache } from "./manifest-registry.js";
import type { PluginRecord } from "./registry.js";
import { applyExclusiveSlotSelection } from "./slots.js";
import { buildPluginStatusReport, type PluginStatusReport } from "./status.js";
import {
  resolveUninstallDirectoryTarget,
  uninstallPlugin,
  type UninstallPluginParams,
  type UninstallPluginResult,
} from "./uninstall.js";
import {
  updatePinnedNpmPlugins,
  type PluginUpdateIntegrityDriftParams,
  type PluginUpdateLogger,
  type PluginUpdateSummary,
} from "./update.js";

export type PluginLifecycleEntry = PluginRecord & {
  install?: PluginInstallRecord;
  managed: boolean;
};

export type PluginLifecycleReport = Omit<PluginStatusReport, "plugins"> & {
  plugins: PluginLifecycleEntry[];
};

export type FinalizePluginInstallResult = {
  config: FasedAgentConfig;
  slotWarnings: string[];
};

export type PluginUninstallPreviewResult =
  | {
      ok: true;
      pluginId: string;
      pluginName: string;
      keepFiles: boolean;
      hasEntry: boolean;
      hasInstall: boolean;
      isLinked: boolean;
      preview: string[];
      deleteTarget?: string;
    }
  | {
      ok: false;
      error: string;
      pluginId?: string;
    };

export function applySlotSelectionForPlugin(
  config: FasedAgentConfig,
  pluginId: string,
): { config: FasedAgentConfig; warnings: string[] } {
  const report = buildPluginStatusReport({ config });
  const plugins = report.plugins ?? [];
  const plugin = plugins.find((entry) => entry.id === pluginId);
  if (!plugin) {
    return { config, warnings: [] };
  }
  const result = applyExclusiveSlotSelection({
    config,
    selectedId: plugin.id,
    selectedKind: plugin.kind,
    registry: report,
  });
  return { config: result.config, warnings: result.warnings };
}

export function addPluginLoadPath(cfg: FasedAgentConfig, pluginPath: string): FasedAgentConfig {
  const existing = cfg.plugins?.load?.paths ?? [];
  const merged = Array.from(new Set([...existing, pluginPath]));
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      load: {
        ...cfg.plugins?.load,
        paths: merged,
      },
    },
  };
}

export function finalizeInstalledPluginConfig(params: {
  config: FasedAgentConfig;
  pluginId: string;
  installRecord?: PluginInstallRecord;
  loadPath?: string;
  refreshManifestRegistry?: boolean;
}): FinalizePluginInstallResult {
  if (params.refreshManifestRegistry) {
    clearPluginManifestRegistryCache();
  }

  let next = params.config;
  if (params.loadPath) {
    next = addPluginLoadPath(next, params.loadPath);
  }
  next = enablePluginInConfig(next, params.pluginId).config;
  if (params.installRecord) {
    next = recordPluginInstall(next, {
      pluginId: params.pluginId,
      ...params.installRecord,
    });
  }
  next = ensurePluginAllowlisted(next, params.pluginId, { createIfMissing: true });

  const slotResult = applySlotSelectionForPlugin(next, params.pluginId);
  return {
    config: slotResult.config,
    slotWarnings: slotResult.warnings,
  };
}

export function buildPluginLifecycleReport(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  report?: PluginStatusReport;
}): PluginLifecycleReport {
  const config = params?.config ?? loadConfig();
  const report =
    params?.report ??
    buildPluginStatusReport({
      config,
      ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });

  const installs = config.plugins?.installs ?? {};
  const plugins = report.plugins ?? [];
  return {
    ...report,
    plugins: plugins.map((plugin) => ({
      ...plugin,
      ...(installs[plugin.id] ? { install: installs[plugin.id] } : {}),
      managed: Boolean((config.plugins?.entries ?? {})[plugin.id] || installs[plugin.id]),
    })),
  };
}

export function resolvePluginLifecycleEntry(params: {
  idOrName: string;
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  report?: PluginLifecycleReport;
}): PluginLifecycleEntry | undefined {
  const report =
    params.report ??
    buildPluginLifecycleReport({
      config: params.config,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
  return report.plugins.find(
    (plugin) => plugin.id === params.idOrName || plugin.name === params.idOrName,
  );
}

export function buildPluginUninstallPreview(params: {
  config: FasedAgentConfig;
  idOrName: string;
  keepFiles?: boolean;
  extensionsDir?: string;
  report?: PluginLifecycleReport;
}): PluginUninstallPreviewResult {
  const keepFiles = Boolean(params.keepFiles);
  const entry = resolvePluginLifecycleEntry({
    idOrName: params.idOrName,
    config: params.config,
    report: params.report,
  });
  const pluginId = entry?.id ?? params.idOrName;
  const hasEntry = pluginId in (params.config.plugins?.entries ?? {});
  const hasInstall = pluginId in (params.config.plugins?.installs ?? {});

  if (!hasEntry && !hasInstall) {
    return {
      ok: false,
      error: entry
        ? `Plugin "${pluginId}" is not managed by plugins config/install records and cannot be uninstalled.`
        : `Plugin not found: ${params.idOrName}`,
      ...(entry ? { pluginId } : {}),
    };
  }

  const install = params.config.plugins?.installs?.[pluginId];
  const isLinked = install?.source === "path";
  const preview: string[] = [];
  if (hasEntry) {
    preview.push("config entry");
  }
  if (hasInstall) {
    preview.push("install record");
  }
  if (params.config.plugins?.allow?.includes(pluginId)) {
    preview.push("allowlist entry");
  }
  if (
    isLinked &&
    install?.sourcePath &&
    params.config.plugins?.load?.paths?.includes(install.sourcePath)
  ) {
    preview.push("load path");
  }
  if (params.config.plugins?.slots?.memory === pluginId) {
    preview.push('memory slot (will reset to "memory-core")');
  }

  const deleteTarget = !keepFiles
    ? resolveUninstallDirectoryTarget({
        pluginId,
        hasInstall,
        installRecord: install,
        extensionsDir: params.extensionsDir,
      })
    : null;
  if (deleteTarget) {
    preview.push(`directory: ${deleteTarget}`);
  }

  return {
    ok: true,
    pluginId,
    pluginName: entry?.name || pluginId,
    keepFiles,
    hasEntry,
    hasInstall,
    isLinked,
    preview,
    ...(deleteTarget ? { deleteTarget } : {}),
  };
}

export async function executePluginUninstallLifecycle(
  params: UninstallPluginParams,
): Promise<UninstallPluginResult> {
  return await uninstallPlugin(params);
}

export async function executePluginUpdateLifecycle(params: {
  config: FasedAgentConfig;
  logger?: PluginUpdateLogger;
  pluginIds?: string[];
  skipIds?: Set<string>;
  dryRun?: boolean;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<PluginUpdateSummary> {
  return await updatePinnedNpmPlugins(params);
}
