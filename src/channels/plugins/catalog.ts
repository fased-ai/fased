import fs from "node:fs";
import path from "node:path";
import { resolveFasedAgentPackageRootSync } from "../../infra/fased-root.js";
import { discoverFasedAgentPlugins } from "../../plugins/discovery.js";
import {
  getPackageManifestMetadata,
  type FasedAgentPackageManifest,
  type ManifestKey,
} from "../../plugins/manifest.js";
import type { PluginOrigin } from "../../plugins/types.js";
import { CONFIG_DIR, isRecord, resolveUserPath } from "../../utils.js";
import {
  channelDeliveryAllowsInstall,
  getChannelDelivery,
  type ChannelDelivery,
} from "../delivery.js";
import type { ChannelMeta } from "./types.js";

export type ChannelUiMetaEntry = {
  id: string;
  label: string;
  detailLabel: string;
  systemImage?: string;
};

export type ChannelUiCatalog = {
  entries: ChannelUiMetaEntry[];
  order: string[];
  labels: Record<string, string>;
  detailLabels: Record<string, string>;
  systemImages: Record<string, string>;
  byId: Record<string, ChannelUiMetaEntry>;
};

export type ChannelPluginCatalogSource = PluginOrigin | "external-catalog" | "official-catalog";

export type ChannelPluginCatalogEntry = {
  id: string;
  meta: ChannelMeta;
  delivery: ChannelDelivery;
  catalogSource: ChannelPluginCatalogSource;
  install: {
    npmSpec?: string;
    localPath?: string;
    defaultChoice?: "npm" | "local";
    expectedIntegrity?: string;
  };
};

export function resolveChannelPluginExpectedPluginIds(entry: {
  id: string;
  meta?: { aliases?: string[] };
}): string[] {
  const pluginIds = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const pluginId = value.trim();
    if (pluginId) {
      pluginIds.add(pluginId);
    }
  };
  add(entry.id);
  for (const alias of entry.meta?.aliases ?? []) {
    add(alias);
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

type CatalogOptions = {
  workspaceDir?: string;
  catalogPaths?: string[];
  officialCatalogPaths?: string[];
};

const ORIGIN_PRIORITY: Record<PluginOrigin, number> = {
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};
const EXTERNAL_CATALOG_PRIORITY = ORIGIN_PRIORITY.bundled + 1;
const OFFICIAL_CATALOG_PRIORITY = EXTERNAL_CATALOG_PRIORITY + 1;
const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = path.join("config", "official-channel-catalog.json");

type ExternalCatalogEntry = {
  name?: string;
  version?: string;
  description?: string;
} & Partial<Record<ManifestKey, FasedAgentPackageManifest>>;

const DEFAULT_CATALOG_PATHS = [
  path.join(CONFIG_DIR, "mpm", "plugins.json"),
  path.join(CONFIG_DIR, "mpm", "catalog.json"),
  path.join(CONFIG_DIR, "plugins", "catalog.json"),
];

const ENV_CATALOG_PATHS = ["FASED_PLUGIN_CATALOG_PATHS", "FASED_MPM_CATALOG_PATHS"];

function parseCatalogEntries(raw: unknown): ExternalCatalogEntry[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is ExternalCatalogEntry => isRecord(entry));
  }
  if (!isRecord(raw)) {
    return [];
  }
  const list = raw.entries ?? raw.packages ?? raw.plugins;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is ExternalCatalogEntry => isRecord(entry));
}

function splitEnvPaths(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/[;,]/g)
    .flatMap((chunk) => chunk.split(path.delimiter))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveExternalCatalogPaths(options: CatalogOptions): string[] {
  if (options.catalogPaths && options.catalogPaths.length > 0) {
    return options.catalogPaths.map((entry) => entry.trim()).filter(Boolean);
  }
  for (const key of ENV_CATALOG_PATHS) {
    const raw = process.env[key];
    if (raw && raw.trim()) {
      return splitEnvPaths(raw);
    }
  }
  return DEFAULT_CATALOG_PATHS;
}

function loadExternalCatalogEntries(options: CatalogOptions): ExternalCatalogEntry[] {
  const paths = resolveExternalCatalogPaths(options);
  return loadCatalogEntriesFromPaths(paths.map((rawPath) => resolveUserPath(rawPath)));
}

function loadCatalogEntriesFromPaths(paths: Iterable<string>): ExternalCatalogEntry[] {
  const entries: ExternalCatalogEntry[] = [];
  for (const resolved of paths) {
    if (!fs.existsSync(resolved)) {
      continue;
    }
    try {
      const payload = JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
      entries.push(...parseCatalogEntries(payload));
    } catch {
      // Ignore invalid catalog files.
    }
  }
  return entries;
}

function toChannelMeta(params: {
  channel: NonNullable<FasedAgentPackageManifest["channel"]>;
  id: string;
}): ChannelMeta | null {
  const label = params.channel.label?.trim();
  if (!label) {
    return null;
  }
  const selectionLabel = params.channel.selectionLabel?.trim() || label;
  const detailLabel = params.channel.detailLabel?.trim();
  const docsPath = params.channel.docsPath?.trim() || `/channels/${params.id}`;
  const blurb = params.channel.blurb?.trim() || "";
  const systemImage = params.channel.systemImage?.trim();

  return {
    id: params.id,
    label,
    selectionLabel,
    ...(detailLabel ? { detailLabel } : {}),
    docsPath,
    docsLabel: params.channel.docsLabel?.trim() || undefined,
    blurb,
    ...(params.channel.aliases ? { aliases: params.channel.aliases } : {}),
    ...(params.channel.preferOver ? { preferOver: params.channel.preferOver } : {}),
    ...(params.channel.order !== undefined ? { order: params.channel.order } : {}),
    ...(params.channel.selectionDocsPrefix
      ? { selectionDocsPrefix: params.channel.selectionDocsPrefix }
      : {}),
    ...(params.channel.selectionDocsOmitLabel !== undefined
      ? { selectionDocsOmitLabel: params.channel.selectionDocsOmitLabel }
      : {}),
    ...(params.channel.selectionExtras ? { selectionExtras: params.channel.selectionExtras } : {}),
    ...(systemImage ? { systemImage } : {}),
    ...(params.channel.showConfigured !== undefined
      ? { showConfigured: params.channel.showConfigured }
      : {}),
    ...(params.channel.quickstartAllowFrom !== undefined
      ? { quickstartAllowFrom: params.channel.quickstartAllowFrom }
      : {}),
    ...(params.channel.forceAccountBinding !== undefined
      ? { forceAccountBinding: params.channel.forceAccountBinding }
      : {}),
    ...(params.channel.preferSessionLookupForAnnounceTarget !== undefined
      ? {
          preferSessionLookupForAnnounceTarget: params.channel.preferSessionLookupForAnnounceTarget,
        }
      : {}),
  };
}

function resolveInstallInfo(params: {
  manifest: FasedAgentPackageManifest;
  packageName?: string;
  packageDir?: string;
  workspaceDir?: string;
}): ChannelPluginCatalogEntry["install"] | null {
  const npmSpec = params.manifest.install?.npmSpec?.trim() || undefined;
  if (!npmSpec && !params.manifest.install?.localPath?.trim()) {
    return null;
  }
  let localPath = params.manifest.install?.localPath?.trim() || undefined;
  if (!localPath && params.workspaceDir && params.packageDir) {
    localPath = path.relative(params.workspaceDir, params.packageDir) || undefined;
  }
  const defaultChoice = params.manifest.install?.defaultChoice ?? (localPath ? "local" : "npm");
  const expectedIntegrity = params.manifest.install?.expectedIntegrity?.trim() || undefined;
  return {
    ...(npmSpec ? { npmSpec } : {}),
    ...(localPath ? { localPath } : {}),
    ...(defaultChoice ? { defaultChoice } : {}),
    ...(expectedIntegrity ? { expectedIntegrity } : {}),
  };
}

function buildCatalogEntry(candidate: {
  packageName?: string;
  packageDir?: string;
  workspaceDir?: string;
  packageManifest?: FasedAgentPackageManifest;
  catalogSource: ChannelPluginCatalogSource;
}): ChannelPluginCatalogEntry | null {
  const manifest = candidate.packageManifest;
  if (!manifest?.channel) {
    return null;
  }
  const id = manifest.channel.id?.trim();
  if (!id) {
    return null;
  }
  const meta = toChannelMeta({ channel: manifest.channel, id });
  if (!meta) {
    return null;
  }
  const delivery =
    candidate.catalogSource === "official-catalog" ? "official-addon" : getChannelDelivery(id);
  const install = resolveInstallInfo({
    manifest,
    packageName: candidate.packageName,
    packageDir: candidate.packageDir,
    workspaceDir: candidate.workspaceDir,
  });
  if (!install && channelDeliveryAllowsInstall(delivery)) {
    return null;
  }
  return {
    id,
    meta,
    delivery,
    catalogSource: candidate.catalogSource,
    install: channelDeliveryAllowsInstall(delivery) ? (install ?? {}) : {},
  };
}

function buildExternalCatalogEntry(
  entry: ExternalCatalogEntry,
  catalogSource: ChannelPluginCatalogSource,
): ChannelPluginCatalogEntry | null {
  const manifest = getPackageManifestMetadata(entry);
  return buildCatalogEntry({
    packageName: entry.name,
    packageManifest: manifest,
    catalogSource,
  });
}

function resolveOfficialCatalogPaths(options: CatalogOptions): string[] {
  if (options.officialCatalogPaths && options.officialCatalogPaths.length > 0) {
    return options.officialCatalogPaths.map((entry) => entry.trim()).filter(Boolean);
  }
  const packageRoots = [
    resolveFasedAgentPackageRootSync({ cwd: process.cwd() }),
    resolveFasedAgentPackageRootSync({ moduleUrl: import.meta.url }),
    process.cwd(),
  ].filter((entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index);
  return packageRoots.map((packageRoot) =>
    path.join(packageRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH),
  );
}

function loadOfficialCatalogEntries(options: CatalogOptions): ChannelPluginCatalogEntry[] {
  return loadCatalogEntriesFromPaths(resolveOfficialCatalogPaths(options))
    .map((entry) => buildExternalCatalogEntry(entry, "official-catalog"))
    .filter((entry): entry is ChannelPluginCatalogEntry => Boolean(entry));
}

export function formatChannelPluginCatalogSource(source: ChannelPluginCatalogSource): string {
  switch (source) {
    case "bundled":
      return "bundled plugin";
    case "config":
      return "config plugin";
    case "workspace":
      return "workspace plugin";
    case "global":
      return "global plugin";
    case "external-catalog":
      return "external catalog";
    case "official-catalog":
      return "bundled official catalog";
  }
}

export function formatChannelPluginCatalogInstallBits(entry: ChannelPluginCatalogEntry): string[] {
  const bits = [entry.delivery, formatChannelPluginCatalogSource(entry.catalogSource)];
  if (entry.install.expectedIntegrity) {
    bits.push("integrity pinned");
  }
  if (entry.install.localPath) {
    bits.push("local path available");
  }
  return bits;
}

export function formatChannelPluginCatalogSelectionHint(entry: ChannelPluginCatalogEntry): string {
  const action =
    entry.delivery === "official-addon"
      ? "install"
      : entry.delivery === "bundled"
        ? "enable bundled"
        : "docs required";
  return [...formatChannelPluginCatalogInstallBits(entry), action].join(" · ");
}

export function formatChannelPluginCatalogStatusLine(entry: ChannelPluginCatalogEntry): string {
  const next =
    entry.delivery === "official-addon"
      ? "install add-on to enable"
      : entry.delivery === "bundled"
        ? "enable bundled integration"
        : `follow ${entry.meta.docsPath}`;
  return `${entry.meta.label}: ${formatChannelPluginCatalogInstallBits(entry).join(", ")}, ${next}`;
}

export function buildChannelUiCatalog(
  plugins: Array<{ id: string; meta: ChannelMeta }>,
): ChannelUiCatalog {
  const entries: ChannelUiMetaEntry[] = plugins.map((plugin) => {
    const detailLabel = plugin.meta.detailLabel ?? plugin.meta.selectionLabel ?? plugin.meta.label;
    return {
      id: plugin.id,
      label: plugin.meta.label,
      detailLabel,
      ...(plugin.meta.systemImage ? { systemImage: plugin.meta.systemImage } : {}),
    };
  });
  const order = entries.map((entry) => entry.id);
  const labels: Record<string, string> = {};
  const detailLabels: Record<string, string> = {};
  const systemImages: Record<string, string> = {};
  const byId: Record<string, ChannelUiMetaEntry> = {};
  for (const entry of entries) {
    labels[entry.id] = entry.label;
    detailLabels[entry.id] = entry.detailLabel;
    if (entry.systemImage) {
      systemImages[entry.id] = entry.systemImage;
    }
    byId[entry.id] = entry;
  }
  return { entries, order, labels, detailLabels, systemImages, byId };
}

export function listChannelPluginCatalogEntries(
  options: CatalogOptions = {},
): ChannelPluginCatalogEntry[] {
  const discovery = discoverFasedAgentPlugins({ workspaceDir: options.workspaceDir });
  const resolved = new Map<string, { entry: ChannelPluginCatalogEntry; priority: number }>();

  for (const candidate of discovery.candidates) {
    const entry = buildCatalogEntry({
      ...candidate,
      catalogSource: candidate.origin,
    });
    if (!entry) {
      continue;
    }
    const priority = ORIGIN_PRIORITY[candidate.origin] ?? 99;
    const existing = resolved.get(entry.id);
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  }

  const externalEntries = loadExternalCatalogEntries(options)
    .map((entry) => buildExternalCatalogEntry(entry, "external-catalog"))
    .filter((entry): entry is ChannelPluginCatalogEntry => Boolean(entry));
  for (const entry of externalEntries) {
    const existing = resolved.get(entry.id);
    if (!existing || EXTERNAL_CATALOG_PRIORITY < existing.priority) {
      resolved.set(entry.id, { entry, priority: EXTERNAL_CATALOG_PRIORITY });
    }
  }

  for (const entry of loadOfficialCatalogEntries(options)) {
    const existing = resolved.get(entry.id);
    if (!existing || OFFICIAL_CATALOG_PRIORITY < existing.priority) {
      resolved.set(entry.id, { entry, priority: OFFICIAL_CATALOG_PRIORITY });
    }
  }

  return Array.from(resolved.values())
    .map(({ entry }) => entry)
    .toSorted((a, b) => {
      const orderA = a.meta.order ?? 999;
      const orderB = b.meta.order ?? 999;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return a.meta.label.localeCompare(b.meta.label);
    });
}

export function getChannelPluginCatalogEntry(
  id: string,
  options: CatalogOptions = {},
): ChannelPluginCatalogEntry | undefined {
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }
  return listChannelPluginCatalogEntries(options).find((entry) => entry.id === trimmed);
}
