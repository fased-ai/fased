import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion, VERSION } from "../version.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "./config-state.js";
import { discoverFasedAgentPlugins, type PluginCandidate } from "./discovery.js";
import {
  loadPluginManifest,
  type PluginManifest,
  type PluginManifestChannelConfig,
  type PluginManifestContracts,
  type PluginManifestModelSupport,
} from "./manifest.js";
import { checkMinHostVersion } from "./min-host-version.js";
import { safeRealpathSync } from "./path-safety.js";
import type { PluginConfigUiHint, PluginDiagnostic, PluginKind, PluginOrigin } from "./types.js";

type SeenIdEntry = {
  candidate: PluginCandidate;
  recordIndex: number;
};

// Precedence: config > workspace > global > bundled
const PLUGIN_ORIGIN_RANK: Readonly<Record<PluginOrigin, number>> = {
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

export type PluginManifestRecord = {
  id: string;
  runtimeOnly?: boolean;
  name?: string;
  description?: string;
  version?: string;
  enabledByDefault?: boolean;
  autoEnableWhenConfiguredProviders?: string[];
  legacyPluginIds?: string[];
  kind?: PluginKind;
  format?: string;
  channels: string[];
  providers: string[];
  hooks?: string[];
  modelSupport?: PluginManifestModelSupport;
  providerAuthEnvVars?: Record<string, string[]>;
  providerAuthAliases?: Record<string, string>;
  providerAuthChoices?: PluginManifest["providerAuthChoices"];
  skills: string[];
  origin: PluginOrigin;
  workspaceDir?: string;
  rootDir: string;
  source: string;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
  configUiHints?: Record<string, PluginConfigUiHint>;
  contracts?: PluginManifestContracts;
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
  channelCatalogMeta?: {
    id: string;
    label?: string;
    blurb?: string;
    preferOver?: readonly string[];
  };
  startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
};

export type PluginManifestRegistry = {
  plugins: PluginManifestRecord[];
  diagnostics: PluginDiagnostic[];
};

const registryCache = new Map<string, { expiresAt: number; registry: PluginManifestRegistry }>();

const DEFAULT_MANIFEST_CACHE_MS = 200;
const LEGACY_REMOVED_PLUGIN_IDS = new Set<string>();

function isRuntimeOnlyComponent(params: {
  manifest: PluginManifest;
  candidate: PluginCandidate;
}): boolean {
  if (params.manifest.runtimeOnly === true) {
    return true;
  }
  // @fased/openai-runtime releases before the runtimeOnly manifest field was
  // introduced still need to coexist with the source-tree component during
  // an upgrade. Restrict compatibility to the official package identity.
  return (
    params.manifest.id === "openai-runtime" &&
    params.candidate.packageName === "@fased/openai-runtime"
  );
}

export function clearPluginManifestRegistryCache(): void {
  registryCache.clear();
}

function resolveManifestCacheMs(env: NodeJS.ProcessEnv): number {
  const raw = env.FASED_PLUGIN_MANIFEST_CACHE_MS?.trim();
  if (raw === "" || raw === "0") {
    return 0;
  }
  if (!raw) {
    return DEFAULT_MANIFEST_CACHE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MANIFEST_CACHE_MS;
  }
  return Math.max(0, parsed);
}

function shouldUseManifestCache(env: NodeJS.ProcessEnv): boolean {
  const disabled = env.FASED_DISABLE_PLUGIN_MANIFEST_CACHE?.trim();
  if (disabled) {
    return false;
  }
  return resolveManifestCacheMs(env) > 0;
}

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
  hostVersion: string;
}): string {
  const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
  // The manifest registry only depends on where plugins are discovered from (workspace + load paths).
  // It does not depend on allow/deny/entries enable-state, so exclude those for higher cache hit rates.
  const loadPaths = params.plugins.loadPaths
    .map((p) => resolveUserPath(p))
    .map((p) => p.trim())
    .filter(Boolean)
    .toSorted();
  return `${workspaceKey}::${params.hostVersion}::${JSON.stringify(loadPaths)}`;
}

function safeStatMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function normalizeManifestLabel(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePreferredPluginIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const values = raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function mergePackageChannelMetaIntoChannelConfigs(params: {
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
  packageChannel?: PluginCandidate["packageManifest"] extends infer T
    ? T extends { channel?: infer C }
      ? C
      : never
    : never;
}): Record<string, PluginManifestChannelConfig> | undefined {
  const channelId = params.packageChannel?.id?.trim();
  if (!channelId || !params.channelConfigs?.[channelId]) {
    return params.channelConfigs;
  }

  const existing = params.channelConfigs[channelId];
  const label =
    existing.label ??
    (typeof params.packageChannel?.label === "string" ? params.packageChannel.label.trim() : "");
  const description =
    existing.description ??
    (typeof params.packageChannel?.blurb === "string" ? params.packageChannel.blurb.trim() : "");
  const preferOver =
    existing.preferOver ?? normalizePreferredPluginIds(params.packageChannel?.preferOver);

  return {
    ...params.channelConfigs,
    [channelId]: {
      ...existing,
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
      ...(preferOver?.length ? { preferOver } : {}),
    },
  };
}

function buildRecord(params: {
  manifest: PluginManifest;
  candidate: PluginCandidate;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
}): PluginManifestRecord {
  const channelConfigs = mergePackageChannelMetaIntoChannelConfigs({
    channelConfigs: params.manifest.channelConfigs,
    packageChannel: params.candidate.packageManifest?.channel,
  });
  return {
    id: params.manifest.id,
    runtimeOnly: isRuntimeOnlyComponent(params) ? true : undefined,
    name: normalizeManifestLabel(params.manifest.name) ?? params.candidate.packageName,
    description:
      normalizeManifestLabel(params.manifest.description) ?? params.candidate.packageDescription,
    version: normalizeManifestLabel(params.manifest.version) ?? params.candidate.packageVersion,
    enabledByDefault: params.manifest.enabledByDefault === true ? true : undefined,
    autoEnableWhenConfiguredProviders: params.manifest.autoEnableWhenConfiguredProviders,
    legacyPluginIds: params.manifest.legacyPluginIds,
    kind: params.manifest.kind,
    channels: params.manifest.channels ?? [],
    providers: params.manifest.providers ?? [],
    modelSupport: params.manifest.modelSupport,
    providerAuthEnvVars: params.manifest.providerAuthEnvVars,
    providerAuthAliases: params.manifest.providerAuthAliases,
    providerAuthChoices: params.manifest.providerAuthChoices,
    skills: params.manifest.skills ?? [],
    origin: params.candidate.origin,
    workspaceDir: params.candidate.workspaceDir,
    rootDir: params.candidate.rootDir,
    source: params.candidate.source,
    manifestPath: params.manifestPath,
    schemaCacheKey: params.schemaCacheKey,
    configSchema: params.configSchema,
    configUiHints: params.manifest.uiHints,
    contracts: params.manifest.contracts,
    channelConfigs,
    startupDeferConfiguredChannelFullLoadUntilAfterListen:
      params.candidate.packageManifest?.startup?.deferConfiguredChannelFullLoadUntilAfterListen ===
      true,
    ...(params.candidate.packageManifest?.channel?.id
      ? {
          channelCatalogMeta: {
            id: params.candidate.packageManifest.channel.id,
            ...(typeof params.candidate.packageManifest.channel.label === "string"
              ? { label: params.candidate.packageManifest.channel.label }
              : {}),
            ...(typeof params.candidate.packageManifest.channel.blurb === "string"
              ? { blurb: params.candidate.packageManifest.channel.blurb }
              : {}),
            ...(params.candidate.packageManifest.channel.preferOver
              ? { preferOver: params.candidate.packageManifest.channel.preferOver }
              : {}),
          },
        }
      : {}),
  };
}

export function loadPluginManifestRegistry(params: {
  config?: FasedAgentConfig;
  workspaceDir?: string;
  cache?: boolean;
  env?: NodeJS.ProcessEnv;
  candidates?: PluginCandidate[];
  diagnostics?: PluginDiagnostic[];
}): PluginManifestRegistry {
  const config = params.config ?? {};
  const normalized = normalizePluginsConfig(config.plugins);
  const env = params.env ?? process.env;
  const currentHostVersion = resolveRuntimeServiceVersion(env, VERSION);
  const cacheKey = buildCacheKey({
    workspaceDir: params.workspaceDir,
    plugins: normalized,
    hostVersion: currentHostVersion,
  });
  const cacheEnabled = params.cache !== false && shouldUseManifestCache(env);
  if (cacheEnabled) {
    const cached = registryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.registry;
    }
  }

  const discovery = params.candidates
    ? {
        candidates: params.candidates,
        diagnostics: params.diagnostics ?? [],
      }
    : discoverFasedAgentPlugins({
        workspaceDir: params.workspaceDir,
        extraPaths: normalized.loadPaths,
      });
  const diagnostics: PluginDiagnostic[] = [...discovery.diagnostics];
  const candidates: PluginCandidate[] = discovery.candidates;
  const records: PluginManifestRecord[] = [];
  const seenIds = new Map<string, SeenIdEntry>();
  const realpathCache = new Map<string, string>();

  for (const candidate of candidates) {
    const manifestRes = loadPluginManifest(candidate.rootDir);
    if (!manifestRes.ok) {
      if (candidate.idHint && LEGACY_REMOVED_PLUGIN_IDS.has(candidate.idHint)) {
        continue;
      }
      diagnostics.push({
        level: "error",
        message: manifestRes.error,
        source: manifestRes.manifestPath,
      });
      continue;
    }
    const manifest = manifestRes.manifest;
    const minHostVersionCheck = checkMinHostVersion({
      currentVersion: currentHostVersion,
      minHostVersion: candidate.packageManifest?.install?.minHostVersion,
    });
    if (!minHostVersionCheck.ok) {
      const packageManifestSource = path.join(
        candidate.packageDir ?? candidate.rootDir,
        "package.json",
      );
      diagnostics.push({
        level: minHostVersionCheck.kind === "unknown_host_version" ? "warn" : "error",
        pluginId: manifest.id,
        source: packageManifestSource,
        message:
          minHostVersionCheck.kind === "invalid"
            ? `plugin manifest invalid | ${minHostVersionCheck.error}`
            : minHostVersionCheck.kind === "unknown_host_version"
              ? `plugin requires Fased >=${minHostVersionCheck.requirement.minimumLabel}, but this host version could not be determined; skipping load`
              : `plugin requires Fased >=${minHostVersionCheck.requirement.minimumLabel}, but this host is ${minHostVersionCheck.currentVersion}; skipping load`,
      });
      continue;
    }

    if (candidate.idHint && candidate.idHint !== manifest.id) {
      diagnostics.push({
        level: "warn",
        pluginId: manifest.id,
        source: candidate.source,
        message: `plugin id mismatch (manifest uses "${manifest.id}", entry hints "${candidate.idHint}")`,
      });
    }

    const configSchema = manifest.configSchema;
    const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
    const schemaCacheKey = manifestMtime
      ? `${manifestRes.manifestPath}:${manifestMtime}`
      : manifestRes.manifestPath;

    const existing = seenIds.get(manifest.id);
    if (existing) {
      // Check whether both candidates point to the same physical directory
      // (e.g. via symlinks or different path representations). If so, this
      // is a false-positive duplicate and can be silently skipped.
      const existingReal = safeRealpathSync(existing.candidate.rootDir, realpathCache);
      const candidateReal = safeRealpathSync(candidate.rootDir, realpathCache);
      const samePlugin = Boolean(existingReal && candidateReal && existingReal === candidateReal);
      if (samePlugin) {
        // Prefer higher-precedence origins even if candidates are passed in
        // an unexpected order (config > workspace > global > bundled).
        if (PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existing.candidate.origin]) {
          records[existing.recordIndex] = buildRecord({
            manifest,
            candidate,
            manifestPath: manifestRes.manifestPath,
            schemaCacheKey,
            configSchema,
          });
          seenIds.set(manifest.id, { candidate, recordIndex: existing.recordIndex });
        }
        continue;
      }
      if (
        isRuntimeOnlyComponent({ manifest, candidate }) &&
        records[existing.recordIndex]?.runtimeOnly === true
      ) {
        if (PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existing.candidate.origin]) {
          records[existing.recordIndex] = buildRecord({
            manifest,
            candidate,
            manifestPath: manifestRes.manifestPath,
            schemaCacheKey,
            configSchema,
          });
          seenIds.set(manifest.id, { candidate, recordIndex: existing.recordIndex });
        }
        continue;
      }
      diagnostics.push({
        level: "warn",
        pluginId: manifest.id,
        source: candidate.source,
        message: `duplicate plugin id detected; later plugin may be overridden (${candidate.source})`,
      });
    } else {
      seenIds.set(manifest.id, { candidate, recordIndex: records.length });
    }

    records.push(
      buildRecord({
        manifest,
        candidate,
        manifestPath: manifestRes.manifestPath,
        schemaCacheKey,
        configSchema,
      }),
    );
  }

  const registry = { plugins: records, diagnostics };
  if (cacheEnabled) {
    const ttl = resolveManifestCacheMs(env);
    if (ttl > 0) {
      registryCache.set(cacheKey, { expiresAt: Date.now() + ttl, registry });
    }
  }
  return registry;
}
