import path from "node:path";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { listChannelPluginCatalogEntries } from "../channels/plugins/catalog.js";
import { loadConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveBundledPluginSources, type BundledPluginSource } from "./bundled-sources.js";
import {
  isPluginRuntimeSessionReadAllowed,
  normalizePluginsConfig,
  PLUGIN_ADMIN_RPC_ACTION_METHODS,
  resolvePluginAdminRpcActionGrant,
  resolvePluginAdminRpcActionSourceKeys,
  type PluginAdminRpcActionMethod,
} from "./config-state.js";
import {
  buildPluginLifecycleReport,
  type PluginLifecycleEntry,
  type PluginLifecycleReport,
} from "./lifecycle.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import type { PluginDiagnostic, PluginKind, PluginOrigin } from "./types.js";

export type PluginMarketplaceAction = "status" | "install" | "update" | "uninstall";

export type PluginMarketplaceInstallOptions = {
  npmSpec?: string;
  localPath?: string;
  resolvedLocalPath?: string;
  bundledLocalPath?: string;
  defaultChoice?: "npm" | "local";
  expectedIntegrity?: string;
};

export type PluginMarketplaceRuntimeHelpers = {
  sessions: {
    read: boolean;
  };
  adminRpcActions: {
    sourceKeys: string[];
    methods: Array<{
      method: PluginAdminRpcActionMethod;
      granted: boolean;
      effective: boolean;
      sources: string[];
      requireOperatorApproval: boolean;
      reason?: string;
    }>;
  };
};

export type PluginMarketplaceEntry = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  kind?: PluginKind;
  origin?: PluginOrigin;
  source?: string;
  status: PluginLifecycleEntry["status"] | "available";
  discovered: boolean;
  managed: boolean;
  loaded: boolean;
  enabled: boolean;
  hasInstallRecord: boolean;
  install?: PluginInstallRecord;
  error?: string;
  channels: string[];
  providers: string[];
  toolNames: string[];
  hookNames: string[];
  gatewayMethods: string[];
  cliCommands: string[];
  services: string[];
  commands: string[];
  httpHandlers: number;
  hookCount: number;
  channelCatalog?: ChannelPluginCatalogEntry["meta"];
  installOptions: PluginMarketplaceInstallOptions;
  runtimeHelpers?: PluginMarketplaceRuntimeHelpers;
  actions: PluginMarketplaceAction[];
};

export type PluginMarketplaceReport = {
  workspaceDir?: string;
  plugins: PluginMarketplaceEntry[];
  diagnostics: PluginDiagnostic[];
};

type MutableMarketplaceEntry = Omit<PluginMarketplaceEntry, "actions"> & {
  actions?: PluginMarketplaceAction[];
};

function dedupeSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function mergeDiagnostics(
  left: readonly PluginDiagnostic[],
  right: readonly PluginDiagnostic[],
): PluginDiagnostic[] {
  const merged = new Map<string, PluginDiagnostic>();
  for (const diag of [...left, ...right]) {
    const key = `${diag.level}::${diag.pluginId ?? ""}::${diag.source ?? ""}::${diag.message}`;
    if (!merged.has(key)) {
      merged.set(key, diag);
    }
  }
  return [...merged.values()];
}

function resolveCatalogLocalPath(
  localPath: string | undefined,
  workspaceDir?: string,
): string | undefined {
  const trimmed = localPath?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return workspaceDir ? path.resolve(workspaceDir, trimmed) : undefined;
}

function createEntry(id: string): MutableMarketplaceEntry {
  return {
    id,
    name: id,
    status: "available",
    discovered: false,
    managed: false,
    loaded: false,
    enabled: false,
    hasInstallRecord: false,
    channels: [],
    providers: [],
    toolNames: [],
    hookNames: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpHandlers: 0,
    hookCount: 0,
    installOptions: {},
  };
}

function mergeLifecycleEntry(target: MutableMarketplaceEntry, plugin: PluginLifecycleEntry): void {
  target.name = plugin.name || target.name;
  target.description = plugin.description ?? target.description;
  target.version = plugin.version ?? target.version;
  target.kind = plugin.kind ?? target.kind;
  target.origin = plugin.origin;
  target.source = plugin.source;
  target.status = plugin.status;
  target.discovered = true;
  target.managed = plugin.managed;
  target.loaded = plugin.status === "loaded";
  target.enabled = plugin.enabled;
  target.hasInstallRecord = Boolean(plugin.install);
  target.install = plugin.install ?? target.install;
  target.error = plugin.error ?? target.error;
  target.channels = dedupeSorted([...target.channels, ...plugin.channelIds]);
  target.providers = dedupeSorted([...target.providers, ...plugin.providerIds]);
  target.toolNames = dedupeSorted([...target.toolNames, ...plugin.toolNames]);
  target.hookNames = dedupeSorted([...target.hookNames, ...plugin.hookNames]);
  target.gatewayMethods = dedupeSorted([...target.gatewayMethods, ...plugin.gatewayMethods]);
  target.cliCommands = dedupeSorted([...target.cliCommands, ...plugin.cliCommands]);
  target.services = dedupeSorted([...target.services, ...plugin.services]);
  target.commands = dedupeSorted([...target.commands, ...plugin.commands]);
  target.httpHandlers = Math.max(target.httpHandlers, plugin.httpHandlers);
  target.hookCount = Math.max(target.hookCount, plugin.hookCount);
}

function mergeManifestRecord(
  target: MutableMarketplaceEntry,
  manifest: PluginManifestRecord,
): void {
  target.name = manifest.name || target.name;
  target.description = manifest.description ?? target.description;
  target.version = manifest.version ?? target.version;
  target.kind = manifest.kind ?? target.kind;
  target.origin = target.origin ?? manifest.origin;
  target.source = target.source ?? manifest.source;
  target.discovered = true;
  target.channels = dedupeSorted([...target.channels, ...manifest.channels]);
  target.providers = dedupeSorted([...target.providers, ...manifest.providers]);
}

function mergeCatalogEntry(
  target: MutableMarketplaceEntry,
  catalogEntry: ChannelPluginCatalogEntry,
  workspaceDir?: string,
): void {
  target.name = catalogEntry.meta.label || target.name;
  target.description = catalogEntry.meta.blurb || target.description;
  target.channelCatalog = catalogEntry.meta;
  target.channels = dedupeSorted([...target.channels, catalogEntry.id]);
  target.installOptions = {
    ...target.installOptions,
    npmSpec: target.installOptions.npmSpec ?? catalogEntry.install.npmSpec,
    localPath: target.installOptions.localPath ?? catalogEntry.install.localPath,
    resolvedLocalPath:
      target.installOptions.resolvedLocalPath ??
      resolveCatalogLocalPath(catalogEntry.install.localPath, workspaceDir),
    defaultChoice: target.installOptions.defaultChoice ?? catalogEntry.install.defaultChoice,
    expectedIntegrity:
      target.installOptions.expectedIntegrity ?? catalogEntry.install.expectedIntegrity,
  };
}

function mergeBundledSource(target: MutableMarketplaceEntry, source: BundledPluginSource): void {
  target.installOptions = {
    ...target.installOptions,
    npmSpec: target.installOptions.npmSpec ?? source.npmSpec,
    bundledLocalPath: target.installOptions.bundledLocalPath ?? source.localPath,
  };
}

function resolveRuntimeHelpers(
  config: ReturnType<typeof loadConfig>,
  entry: MutableMarketplaceEntry,
): PluginMarketplaceRuntimeHelpers {
  const pluginsConfig = normalizePluginsConfig(config.plugins);
  const pluginId = entry.id;
  const source = {
    ...(entry.origin ? { origin: entry.origin } : {}),
    ...(entry.source ? { source: entry.source } : {}),
  };
  const sourceKeys = resolvePluginAdminRpcActionSourceKeys(source);
  const grants = pluginsConfig.entries[pluginId]?.runtime?.adminRpcActions.allow ?? [];
  return {
    sessions: {
      read: isPluginRuntimeSessionReadAllowed(pluginsConfig, pluginId),
    },
    adminRpcActions: {
      sourceKeys,
      methods: PLUGIN_ADMIN_RPC_ACTION_METHODS.map((method) => {
        const grant = grants.find((item) => item.method === method);
        const decision = resolvePluginAdminRpcActionGrant({
          config: pluginsConfig,
          pluginId,
          method,
          source,
        });
        return {
          method,
          granted: Boolean(grant),
          effective: decision.allowed,
          sources: grant?.sources ?? [],
          requireOperatorApproval: grant?.requireOperatorApproval === true,
          ...(decision.allowed ? {} : { reason: decision.reason }),
        };
      }),
    },
  };
}

function resolveActions(entry: MutableMarketplaceEntry): PluginMarketplaceAction[] {
  const actions: PluginMarketplaceAction[] = ["status"];
  const hasInstallSource = Boolean(
    entry.installOptions.npmSpec ||
    entry.installOptions.resolvedLocalPath ||
    entry.installOptions.bundledLocalPath,
  );
  if (
    !entry.managed &&
    !entry.loaded &&
    hasInstallSource &&
    (entry.channelCatalog || !entry.discovered)
  ) {
    actions.push("install");
  }
  if (entry.install?.source === "npm" && entry.install.spec) {
    actions.push("update");
  }
  if (entry.managed) {
    actions.push("uninstall");
  }
  return actions;
}

function sortPlugins(left: PluginMarketplaceEntry, right: PluginMarketplaceEntry): number {
  const rankLeft = left.managed ? 0 : left.discovered ? 1 : 2;
  const rankRight = right.managed ? 0 : right.discovered ? 1 : 2;
  if (rankLeft !== rankRight) {
    return rankLeft - rankRight;
  }

  const orderLeft = left.channelCatalog?.order ?? 999;
  const orderRight = right.channelCatalog?.order ?? 999;
  if (orderLeft !== orderRight) {
    return orderLeft - orderRight;
  }

  return left.name.localeCompare(right.name);
}

export function buildPluginMarketplaceReport(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  lifecycleReport?: PluginLifecycleReport;
  manifestRegistry?: PluginManifestRegistry;
  channelCatalog?: ChannelPluginCatalogEntry[];
  bundledSources?: Map<string, BundledPluginSource>;
}): PluginMarketplaceReport {
  const config = params?.config ?? loadConfig();
  const lifecycleReport = params?.lifecycleReport ?? buildPluginLifecycleReport({ config });
  const workspaceDir = params?.workspaceDir ?? lifecycleReport.workspaceDir;
  const manifestRegistry =
    params?.manifestRegistry ??
    loadPluginManifestRegistry({
      config,
      ...(workspaceDir ? { workspaceDir } : {}),
    });
  const channelCatalog =
    params?.channelCatalog ?? listChannelPluginCatalogEntries(workspaceDir ? { workspaceDir } : {});
  const bundledSources =
    params?.bundledSources ?? resolveBundledPluginSources(workspaceDir ? { workspaceDir } : {});

  const entries = new Map<string, MutableMarketplaceEntry>();
  const getOrCreate = (id: string) => {
    const existing = entries.get(id);
    if (existing) {
      return existing;
    }
    const next = createEntry(id);
    entries.set(id, next);
    return next;
  };

  for (const plugin of lifecycleReport.plugins) {
    mergeLifecycleEntry(getOrCreate(plugin.id), plugin);
  }
  for (const plugin of manifestRegistry.plugins) {
    mergeManifestRecord(getOrCreate(plugin.id), plugin);
  }
  for (const entry of channelCatalog) {
    mergeCatalogEntry(getOrCreate(entry.id), entry, workspaceDir);
  }
  for (const source of bundledSources.values()) {
    mergeBundledSource(getOrCreate(source.pluginId), source);
  }

  const plugins = [...entries.values()]
    .map((entry) => ({
      ...entry,
      runtimeHelpers: resolveRuntimeHelpers(config, entry),
      actions: resolveActions(entry),
    }))
    .toSorted(sortPlugins);

  return {
    workspaceDir,
    plugins,
    diagnostics: mergeDiagnostics(lifecycleReport.diagnostics, manifestRegistry.diagnostics),
  };
}

export function resolvePluginMarketplaceEntry(params: {
  idOrName: string;
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  report?: PluginMarketplaceReport;
}): PluginMarketplaceEntry | undefined {
  const report =
    params.report ??
    buildPluginMarketplaceReport({
      config: params.config,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
  return report.plugins.find(
    (plugin) => plugin.id === params.idOrName || plugin.name === params.idOrName,
  );
}
