import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveFasedAgentPackageRootSync } from "../infra/fased-root.js";
import { CONFIG_DIR, isRecord, resolveUserPath } from "../utils.js";
import { enablePluginInConfig } from "./enable.js";
import type { PluginPackageInstall } from "./manifest.js";
import type { PluginWebSearchProviderEntry } from "./types.js";

export type OfficialExternalWebSearchProvider = {
  id?: string;
  label?: string;
  hint?: string;
  onboardingScopes?: unknown;
  requiresCredential?: boolean;
  credentialLabel?: string;
  envVars?: unknown;
  placeholder?: string;
  signupUrl?: string;
  docsUrl?: string;
  credentialPath?: string;
  autoDetectOrder?: number;
};

export type WebSearchInstallCatalogEntry = {
  pluginId: string;
  label: string;
  install: PluginPackageInstall;
  provider: PluginWebSearchProviderEntry;
  trustedSourceLinkedOfficialInstall?: boolean;
};

type OfficialExternalPluginCatalogEntry = {
  name?: string;
  description?: string;
  source?: string;
  kind?: string;
  fased?: OfficialExternalPluginManifest;
};

type OfficialExternalPluginManifest = {
  plugin?: {
    id?: string;
    label?: string;
  };
  install?: PluginPackageInstall;
  webSearchProviders?: OfficialExternalWebSearchProvider[];
};

const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_RELATIVE_PATH = path.join(
  "config",
  "official-external-plugin-catalog.json",
);

const DEFAULT_EXTERNAL_CATALOG_PATHS = [
  path.join(CONFIG_DIR, "mpm", "plugins.json"),
  path.join(CONFIG_DIR, "mpm", "catalog.json"),
  path.join(CONFIG_DIR, "plugins", "catalog.json"),
];

const ENV_CATALOG_PATHS = ["FASED_PLUGIN_CATALOG_PATHS", "FASED_MPM_CATALOG_PATHS"];

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(normalizeString).filter((entry): entry is string => Boolean(entry))
    : [];
}

function normalizeOnboardingScopes(
  value: OfficialExternalWebSearchProvider["onboardingScopes"],
): readonly "text-inference"[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const scopes = value.filter((entry): entry is "text-inference" => entry === "text-inference");
  return scopes.length > 0 ? scopes : undefined;
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

function parseCatalogEntries(raw: unknown): OfficialExternalPluginCatalogEntry[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is OfficialExternalPluginCatalogEntry => isRecord(entry));
  }
  if (!isRecord(raw)) {
    return [];
  }
  const list = raw.entries ?? raw.packages ?? raw.plugins;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is OfficialExternalPluginCatalogEntry => isRecord(entry));
}

function loadCatalogEntriesFromPaths(
  paths: Iterable<string>,
): OfficialExternalPluginCatalogEntry[] {
  const entries: OfficialExternalPluginCatalogEntry[] = [];
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

function resolveOfficialCatalogPaths(options?: { officialCatalogPaths?: string[] }): string[] {
  if (options?.officialCatalogPaths !== undefined) {
    return options.officialCatalogPaths.map((entry) => entry.trim()).filter(Boolean);
  }
  const packageRoots = [
    resolveFasedAgentPackageRootSync({ cwd: process.cwd() }),
    resolveFasedAgentPackageRootSync({ moduleUrl: import.meta.url }),
    process.cwd(),
  ].filter((entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index);
  return packageRoots.map((packageRoot) =>
    path.join(packageRoot, OFFICIAL_EXTERNAL_PLUGIN_CATALOG_RELATIVE_PATH),
  );
}

function resolveExternalCatalogPaths(options?: { catalogPaths?: string[] }): string[] {
  if (options?.catalogPaths !== undefined) {
    return options.catalogPaths.map((entry) => entry.trim()).filter(Boolean);
  }
  for (const key of ENV_CATALOG_PATHS) {
    const raw = process.env[key];
    if (raw && raw.trim()) {
      return splitEnvPaths(raw).map((entry) => resolveUserPath(entry));
    }
  }
  return DEFAULT_EXTERNAL_CATALOG_PATHS;
}

function resolveManifest(
  entry: OfficialExternalPluginCatalogEntry,
): OfficialExternalPluginManifest | null {
  return entry.fased ?? null;
}

function pathSegments(pathValue: string): string[] {
  return pathValue
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function getConfigPath(config: FasedAgentConfig | undefined, pathValue: string): unknown {
  let current: unknown = config;
  for (const segment of pathSegments(pathValue)) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setConfigPath(target: FasedAgentConfig, pathValue: string, value: unknown): void {
  const segments = pathSegments(pathValue);
  let current: Record<string, unknown> = target as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  const leaf = segments.at(-1);
  if (leaf) {
    current[leaf] = value;
  }
}

function buildProviderEntry(params: {
  pluginId: string;
  provider: OfficialExternalWebSearchProvider;
}): PluginWebSearchProviderEntry | null {
  const providerId = normalizeString(params.provider.id);
  const label = normalizeString(params.provider.label);
  const hint = normalizeString(params.provider.hint);
  const credentialPath =
    normalizeString(params.provider.credentialPath) ??
    `plugins.entries.${params.pluginId}.config.webSearch.apiKey`;
  const envVars = normalizeStringList(params.provider.envVars);
  const placeholder = normalizeString(params.provider.placeholder);
  const signupUrl = normalizeString(params.provider.signupUrl);
  if (!providerId || !label || !hint || envVars.length === 0 || !placeholder || !signupUrl) {
    return null;
  }
  const onboardingScopes = normalizeOnboardingScopes(params.provider.onboardingScopes);
  return {
    id: providerId,
    pluginId: params.pluginId,
    label,
    hint,
    envVars,
    placeholder,
    signupUrl,
    credentialPath,
    ...(onboardingScopes ? { onboardingScopes } : {}),
    ...(params.provider.requiresCredential === false ? { requiresCredential: false } : {}),
    ...(normalizeString(params.provider.credentialLabel)
      ? { credentialLabel: normalizeString(params.provider.credentialLabel) }
      : {}),
    ...(normalizeString(params.provider.docsUrl)
      ? { docsUrl: normalizeString(params.provider.docsUrl) }
      : {}),
    ...(typeof params.provider.autoDetectOrder === "number"
      ? { autoDetectOrder: params.provider.autoDetectOrder }
      : {}),
    getCredentialValue: (searchConfig?: Record<string, unknown>) => searchConfig?.apiKey,
    setCredentialValue: (value: string, searchConfig?: Record<string, unknown>) => {
      if (searchConfig) {
        searchConfig.apiKey = value;
      }
    },
    getConfiguredCredentialValue: (config?: FasedAgentConfig) =>
      getConfigPath(config, credentialPath),
    setConfiguredCredentialValue: (configTarget: FasedAgentConfig, value: unknown) => {
      setConfigPath(configTarget, credentialPath, value);
    },
    applySelectionConfig: (config: FasedAgentConfig) =>
      enablePluginInConfig(config, params.pluginId).config,
    createTool: () => null,
  };
}

function buildInstallCatalogEntry(
  entry: OfficialExternalPluginCatalogEntry,
  trustedSourceLinkedOfficialInstall: boolean,
): WebSearchInstallCatalogEntry[] {
  const manifest = resolveManifest(entry);
  const pluginId = normalizeString(manifest?.plugin?.id);
  const install = manifest?.install;
  if (!manifest || !pluginId || !install) {
    return [];
  }
  const label = normalizeString(manifest.plugin?.label) ?? pluginId;
  return (manifest.webSearchProviders ?? [])
    .map((provider) => buildProviderEntry({ pluginId, provider }))
    .filter((provider): provider is PluginWebSearchProviderEntry => Boolean(provider))
    .map((provider) => ({
      pluginId,
      label,
      install,
      provider,
      ...(trustedSourceLinkedOfficialInstall ? { trustedSourceLinkedOfficialInstall } : {}),
    }));
}

export function resolveWebSearchInstallCatalogEntries(options?: {
  catalogPaths?: string[];
  officialCatalogPaths?: string[];
}): WebSearchInstallCatalogEntry[] {
  const officialEntries = loadCatalogEntriesFromPaths(resolveOfficialCatalogPaths(options)).flatMap(
    (entry) => buildInstallCatalogEntry(entry, true),
  );
  const externalEntries = loadCatalogEntriesFromPaths(resolveExternalCatalogPaths(options)).flatMap(
    (entry) => buildInstallCatalogEntry(entry, false),
  );
  const byProvider = new Map<string, WebSearchInstallCatalogEntry>();
  for (const entry of [...externalEntries, ...officialEntries]) {
    if (!byProvider.has(entry.provider.id)) {
      byProvider.set(entry.provider.id, entry);
    }
  }
  return [...byProvider.values()].toSorted(
    (left, right) =>
      left.provider.label.localeCompare(right.provider.label) ||
      left.provider.id.localeCompare(right.provider.id),
  );
}

export function resolveWebSearchInstallCatalogEntry(params: {
  providerId?: string;
  pluginId?: string;
}): WebSearchInstallCatalogEntry | undefined {
  const providerId = normalizeString(params.providerId);
  const pluginId = normalizeString(params.pluginId);
  return resolveWebSearchInstallCatalogEntries().find(
    (entry) =>
      (!providerId || entry.provider.id === providerId) &&
      (!pluginId || entry.pluginId === pluginId),
  );
}
