import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { FasedAgentConfig } from "../config/config.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { resolveFasedAgentPackageRootSync } from "../infra/fased-root.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { clearPluginCommands } from "./commands.js";
import {
  applyTestPluginDefaults,
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveMemorySlotDecision,
  type NormalizedPluginsConfig,
} from "./config-state.js";
import { discoverFasedAgentPlugins } from "./discovery.js";
import { initializeGlobalHookRunner } from "./hook-runner-global.js";
import { repairUpdateOwnedPluginInstallState } from "./installs.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { isPathInside, safeRealpathSync, safeStatSync } from "./path-safety.js";
import { bindManagedPluginSnapshot, readCanonicalPluginLock } from "./readiness-receipt.js";
import { createPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";
import { createPluginRuntime } from "./runtime/index.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import type {
  FasedAgentPluginDefinition,
  FasedAgentPluginModule,
  PluginDiagnostic,
  PluginLogger,
} from "./types.js";

export type PluginLoadResult = PluginRegistry;

export type PluginLoadOptions = {
  config?: FasedAgentConfig;
  workspaceDir?: string;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  cache?: boolean;
  mode?: "full" | "validate";
  preloadedModules?: Map<string, FasedAgentPluginModule>;
};

const registryCache = new Map<string, PluginRegistry>();

export function clearPluginLoaderCache(): void {
  registryCache.clear();
}

const defaultLogger = () => createSubsystemLogger("plugins");

function applyManagedRequiredAllowlist(
  config: NormalizedPluginsConfig,
  env: NodeJS.ProcessEnv = process.env,
): NormalizedPluginsConfig {
  const lockPath = env.FASED_PLUGIN_LOCK_PATH?.trim();
  if (!lockPath || config.allow.length === 0) {
    return config;
  }
  const requiredManaged = readCanonicalPluginLock(lockPath)
    .entries.filter((entry) => entry.required)
    .map((entry) => entry.id);
  if (requiredManaged.length === 0) {
    return config;
  }
  return {
    ...config,
    allow: [...new Set([...config.allow, ...requiredManaged])].toSorted(),
  };
}

const resolvePluginSdkAliasFile = (params: {
  srcFile: string;
  distFile: string;
  modulePath?: string;
}): string | null => {
  try {
    const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
    const isProduction = process.env.NODE_ENV === "production";
    const isTest = process.env.VITEST || process.env.NODE_ENV === "test";
    const normalizedModulePath = modulePath.replace(/\\/g, "/");
    const isDistRuntime = normalizedModulePath.includes("/dist/");
    let cursor = path.dirname(modulePath);
    for (let i = 0; i < 6; i += 1) {
      const srcCandidate = path.join(cursor, "src", "plugin-sdk", params.srcFile);
      const distCandidate = path.join(cursor, "dist", "plugin-sdk", params.distFile);
      const orderedCandidates = isDistRuntime
        ? [distCandidate, srcCandidate]
        : isProduction
          ? isTest
            ? [distCandidate, srcCandidate]
            : [distCandidate]
          : [srcCandidate, distCandidate];
      for (const candidate of orderedCandidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  } catch {
    // ignore
  }
  return null;
};

const PLUGIN_SDK_ALIAS_SPECS = [
  { requests: ["fased/plugin-sdk"], srcFile: "index.ts", distFile: "index.js" },
  {
    requests: ["fased/plugin-sdk/account-id"],
    srcFile: "account-id.ts",
    distFile: "account-id.js",
  },
  {
    requests: ["fased/plugin-sdk/channel-plugin-common"],
    srcFile: "channel-plugin-common.ts",
    distFile: "channel-plugin-common.js",
  },
  {
    requests: ["fased/plugin-sdk/command-status"],
    srcFile: "command-status.ts",
    distFile: "command-status.js",
  },
  {
    requests: ["fased/plugin-sdk/device-pair"],
    srcFile: "device-pair.ts",
    distFile: "device-pair.js",
  },
  {
    requests: ["fased/plugin-sdk/discord"],
    srcFile: "discord.ts",
    distFile: "discord.js",
  },
  {
    requests: ["fased/plugin-sdk/provider-web-search-config-contract"],
    srcFile: "provider-web-search-config-contract.ts",
    distFile: "provider-web-search-config-contract.js",
  },
  {
    requests: ["fased/plugin-sdk/sat-runtime"],
    srcFile: "sat-runtime.ts",
    distFile: "sat-runtime.js",
  },
  {
    requests: ["fased/plugin-sdk/slack"],
    srcFile: "slack.ts",
    distFile: "slack.js",
  },
  {
    requests: ["fased/plugin-sdk/telegram"],
    srcFile: "telegram.ts",
    distFile: "telegram.js",
  },
  {
    requests: ["fased/plugin-sdk/whatsapp"],
    srcFile: "whatsapp.ts",
    distFile: "whatsapp.js",
  },
] as const;

const OFFICIAL_CHANNEL_PLUGIN_IDS = new Set(["discord", "slack", "telegram", "whatsapp"]);

function repairOfficialChannelRuntimeDependencies(params: {
  pluginId: string;
  pluginRoot: string;
  logger: PluginLogger;
  coreRoot?: string;
}): void {
  if (!OFFICIAL_CHANNEL_PLUGIN_IDS.has(params.pluginId)) {
    return;
  }
  const coreRoot =
    params.coreRoot ?? resolveFasedAgentPackageRootSync({ moduleUrl: import.meta.url });
  if (!coreRoot || path.resolve(coreRoot) === path.resolve(params.pluginRoot)) {
    return;
  }
  let manifest: {
    name?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(params.pluginRoot, "package.json"), "utf8"));
  } catch {
    return;
  }
  if (manifest.name !== `@fased/${params.pluginId}`) {
    return;
  }
  const dependencyNames = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  for (const dependencyName of dependencyNames) {
    const segments = dependencyName.split("/");
    const source = path.join(params.pluginRoot, "node_modules", ...segments);
    if (!fs.existsSync(source)) {
      continue;
    }
    const target = path.join(coreRoot, "node_modules", ...segments);
    try {
      const sourceReal = fs.realpathSync(source);
      let shouldCreate = true;
      try {
        const current = fs.lstatSync(target);
        if (!current.isSymbolicLink()) {
          shouldCreate = false;
        } else {
          const targetReal = fs.realpathSync(target);
          if (targetReal === sourceReal) {
            shouldCreate = false;
          } else {
            fs.unlinkSync(target);
          }
        }
      } catch {
        // Missing or stale target; create it below.
      }
      if (!shouldCreate) {
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(sourceReal, target, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      params.logger.warn(
        `[plugins] unable to expose ${dependencyName} from ${params.pluginId}: ${String(error)}`,
      );
    }
  }
}

function resolvePluginSdkAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const spec of PLUGIN_SDK_ALIAS_SPECS) {
    const resolved = resolvePluginSdkAliasFile({
      srcFile: spec.srcFile,
      distFile: spec.distFile,
    });
    if (!resolved) {
      continue;
    }
    for (const request of spec.requests) {
      aliases[request] = resolved;
    }
  }
  return aliases;
}

function isNativePluginEntry(source: string): boolean {
  return [".js", ".mjs", ".cjs"].includes(path.extname(source).toLowerCase());
}

export async function preloadNativePluginModules(
  options: PluginLoadOptions = {},
): Promise<Map<string, FasedAgentPluginModule>> {
  const cfg = applyTestPluginDefaults(options.config ?? {}, process.env);
  const logger = options.logger ?? defaultLogger();
  const normalized = applyManagedRequiredAllowlist(normalizePluginsConfig(cfg.plugins));
  const discovery = discoverFasedAgentPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: normalized.loadPaths,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: options.workspaceDir,
    cache: options.cache,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );
  const modules = new Map<string, FasedAgentPluginModule>();

  for (const candidate of discovery.candidates) {
    const manifestRecord = manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord || !isNativePluginEntry(candidate.source)) {
      continue;
    }
    const enableState = resolveEffectiveEnableState({
      id: manifestRecord.id,
      origin: candidate.origin,
      config: normalized,
      rootConfig: cfg,
    });
    if (!enableState.enabled) {
      continue;
    }
    const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
    const opened = openBoundaryFileSync({
      absolutePath: candidate.source,
      rootPath: pluginRoot,
      boundaryLabel: "plugin root",
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      continue;
    }
    const safeSource = opened.path;
    fs.closeSync(opened.fd);
    const startedAt = Date.now();
    try {
      const moduleUrl = pathToFileURL(safeSource).href;
      const loaded = (await import(moduleUrl)) as FasedAgentPluginModule;
      modules.set(safeSource, loaded);
      logger.info(`[plugins] ${manifestRecord.id} native preload ${Date.now() - startedAt}ms`);
    } catch (error) {
      logger.warn(
        `[plugins] ${manifestRecord.id} native preload failed after ${Date.now() - startedAt}ms; falling back to Jiti: ${String(error)}`,
      );
    }
  }

  return modules;
}

export const __testing = {
  applyManagedRequiredAllowlist,
  repairOfficialChannelRuntimeDependencies,
  resolvePluginSdkAliasFile,
  resolvePluginSdkAliases,
};

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
  coreGatewayMethodNames?: string[];
}): string {
  const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
  const coreGatewayMethods = [...(params.coreGatewayMethodNames ?? [])]
    .map((method) => method.trim())
    .filter(Boolean)
    .toSorted();
  return `${workspaceKey}::${JSON.stringify(params.plugins)}::${JSON.stringify(coreGatewayMethods)}`;
}

function validatePluginConfig(params: {
  schema?: Record<string, unknown>;
  cacheKey?: string;
  value?: unknown;
}): { ok: boolean; value?: Record<string, unknown>; errors?: string[] } {
  const schema = params.schema;
  if (!schema) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  if (isEmptyPluginConfigSchema(schema)) {
    const value = params.value;
    if (value === undefined) {
      return { ok: true, value: undefined };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, errors: ["<root>: must be object"] };
    }
    if (Object.keys(value).length > 0) {
      return { ok: false, errors: ["<root>: config must be empty"] };
    }
    return { ok: true, value: value as Record<string, unknown> };
  }
  const cacheKey = params.cacheKey ?? JSON.stringify(schema);
  const result = validateJsonSchemaValue({
    schema,
    cacheKey,
    value: params.value ?? {},
  });
  if (result.ok) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  return { ok: false, errors: result.errors };
}

function isEmptyPluginConfigSchema(schema: Record<string, unknown>): boolean {
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    return false;
  }
  const properties = schema.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties) ||
    Object.keys(properties).length > 0
  ) {
    return false;
  }
  return !(
    "required" in schema ||
    "dependentRequired" in schema ||
    "dependencies" in schema ||
    "minProperties" in schema ||
    "allOf" in schema ||
    "anyOf" in schema ||
    "oneOf" in schema ||
    "not" in schema
  );
}

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: FasedAgentPluginDefinition;
  register?: FasedAgentPluginDefinition["register"];
} {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (typeof resolved === "function") {
    return {
      register: resolved as FasedAgentPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const def = resolved as FasedAgentPluginDefinition;
    const register = def.register ?? def.activate;
    return { definition: def, register };
  }
  return {};
}

function isManagedPluginMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.FASED_PLUGIN_CODE_ROOT?.trim() && env.FASED_PLUGIN_LOCK_PATH?.trim());
}

function createPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  source: string;
  origin: PluginRecord["origin"];
  workspaceDir?: string;
  enabled: boolean;
  configSchema: boolean;
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    description: params.description,
    version: params.version,
    source: params.source,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    enabled: params.enabled,
    status: params.enabled ? "loaded" : "disabled",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    webSearchProviderIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpHandlers: 0,
    hookCount: 0,
    configSchema: params.configSchema,
    configUiHints: undefined,
    configJsonSchema: undefined,
  };
}

function recordPluginError(params: {
  logger: PluginLogger;
  registry: PluginRegistry;
  record: PluginRecord;
  seenIds: Map<string, PluginRecord["origin"]>;
  pluginId: string;
  origin: PluginRecord["origin"];
  error: unknown;
  logPrefix: string;
  diagnosticMessagePrefix: string;
}) {
  const errorText = String(params.error);
  params.logger.error(`${params.logPrefix}${errorText}`);
  params.record.status = "error";
  params.record.error = errorText;
  params.registry.plugins.push(params.record);
  params.seenIds.set(params.pluginId, params.origin);
  params.registry.diagnostics.push({
    level: "error",
    pluginId: params.record.id,
    source: params.record.source,
    message: `${params.diagnosticMessagePrefix}${errorText}`,
  });
}

function pushDiagnostics(diagnostics: PluginDiagnostic[], append: PluginDiagnostic[]) {
  diagnostics.push(...append);
}

type PathMatcher = {
  exact: Set<string>;
  dirs: string[];
};

type InstallTrackingRule = {
  trackedWithoutPaths: boolean;
  matcher: PathMatcher;
};

type PluginProvenanceIndex = {
  loadPathMatcher: PathMatcher;
  installRules: Map<string, InstallTrackingRule>;
};

function createPathMatcher(): PathMatcher {
  return { exact: new Set<string>(), dirs: [] };
}

function addPathToMatcher(matcher: PathMatcher, rawPath: string): void {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return;
  }
  const resolved = resolveUserPath(trimmed);
  if (!resolved) {
    return;
  }
  if (matcher.exact.has(resolved) || matcher.dirs.includes(resolved)) {
    return;
  }
  const stat = safeStatSync(resolved);
  if (stat?.isDirectory()) {
    matcher.dirs.push(resolved);
    return;
  }
  matcher.exact.add(resolved);
}

function matchesPathMatcher(matcher: PathMatcher, sourcePath: string): boolean {
  if (matcher.exact.has(sourcePath)) {
    return true;
  }
  return matcher.dirs.some((dirPath) => isPathInside(dirPath, sourcePath));
}

function buildProvenanceIndex(params: {
  config: FasedAgentConfig;
  normalizedLoadPaths: string[];
}): PluginProvenanceIndex {
  const loadPathMatcher = createPathMatcher();
  for (const loadPath of params.normalizedLoadPaths) {
    addPathToMatcher(loadPathMatcher, loadPath);
  }

  const installRules = new Map<string, InstallTrackingRule>();
  const installs =
    repairUpdateOwnedPluginInstallState(params.config).config.plugins?.installs ?? {};
  for (const [pluginId, install] of Object.entries(installs)) {
    const rule: InstallTrackingRule = {
      trackedWithoutPaths: false,
      matcher: createPathMatcher(),
    };
    const trackedPaths = [install.installPath, install.sourcePath]
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    if (trackedPaths.length === 0) {
      rule.trackedWithoutPaths = true;
    } else {
      for (const trackedPath of trackedPaths) {
        addPathToMatcher(rule.matcher, trackedPath);
      }
    }
    installRules.set(pluginId, rule);
  }

  return { loadPathMatcher, installRules };
}

function isTrackedByProvenance(params: {
  pluginId: string;
  source: string;
  index: PluginProvenanceIndex;
}): boolean {
  const sourcePath = resolveUserPath(params.source);
  const installRule = params.index.installRules.get(params.pluginId);
  if (installRule) {
    if (installRule.trackedWithoutPaths) {
      return true;
    }
    if (matchesPathMatcher(installRule.matcher, sourcePath)) {
      return true;
    }
  }
  return matchesPathMatcher(params.index.loadPathMatcher, sourcePath);
}

function warnWhenAllowlistIsOpen(params: {
  logger: PluginLogger;
  pluginsEnabled: boolean;
  allow: string[];
  discoverablePlugins: Array<{ id: string; source: string; origin: PluginRecord["origin"] }>;
}) {
  if (!params.pluginsEnabled) {
    return;
  }
  if (params.allow.length > 0) {
    return;
  }
  const nonBundled = params.discoverablePlugins.filter((entry) => entry.origin !== "bundled");
  if (nonBundled.length === 0) {
    return;
  }
  const preview = nonBundled
    .slice(0, 6)
    .map((entry) => `${entry.id} (${entry.source})`)
    .join(", ");
  const extra = nonBundled.length > 6 ? ` (+${nonBundled.length - 6} more)` : "";
  params.logger.warn(
    `[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load: ${preview}${extra}. Set plugins.allow to explicit trusted ids.`,
  );
}

function warnAboutUntrackedLoadedPlugins(params: {
  registry: PluginRegistry;
  provenance: PluginProvenanceIndex;
  logger: PluginLogger;
}) {
  for (const plugin of params.registry.plugins) {
    if (plugin.status !== "loaded" || plugin.origin === "bundled") {
      continue;
    }
    if (
      isTrackedByProvenance({
        pluginId: plugin.id,
        source: plugin.source,
        index: params.provenance,
      })
    ) {
      continue;
    }
    const message =
      "loaded without install/load-path provenance; treat as untracked local code and pin trust via plugins.allow or install records";
    params.registry.diagnostics.push({
      level: "warn",
      pluginId: plugin.id,
      source: plugin.source,
      message,
    });
    params.logger.warn(`[plugins] ${plugin.id}: ${message} (${plugin.source})`);
  }
}

export function loadFasedAgentPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  // Test env: default-disable plugins unless explicitly configured.
  // This keeps unit/gateway suites fast and avoids loading heavyweight plugin deps by accident.
  const cfg = applyTestPluginDefaults(options.config ?? {}, process.env);
  const logger = options.logger ?? defaultLogger();
  const validateOnly = options.mode === "validate";
  const normalized = applyManagedRequiredAllowlist(normalizePluginsConfig(cfg.plugins));
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: normalized,
    coreGatewayMethodNames: Object.keys(options.coreGatewayHandlers ?? {}),
  });
  const cacheEnabled = options.cache !== false;
  if (cacheEnabled) {
    const cached = registryCache.get(cacheKey);
    if (cached) {
      setActivePluginRegistry(cached, cacheKey);
      return cached;
    }
  }

  // Clear previously registered plugin commands before reloading
  clearPluginCommands();

  const runtime = createPluginRuntime();
  const { registry, createApi } = createPluginRegistry({
    logger,
    runtime,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
  });

  const discovery = discoverFasedAgentPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: normalized.loadPaths,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: options.workspaceDir,
    cache: options.cache,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  if (discovery.managedLock && discovery.managedCodeRoot) {
    const managedBindings = new Map<string, { id: string; digest: string; source: string }>();
    for (const candidate of discovery.candidates) {
      if (!candidate.managedDigest || !candidate.managedCodeRoot) {
        continue;
      }
      const manifestRecord = manifestRegistry.plugins.find(
        (record) => record.rootDir === candidate.rootDir && record.source === candidate.source,
      );
      if (!manifestRecord) {
        continue;
      }
      managedBindings.set(manifestRecord.id, {
        id: manifestRecord.id,
        digest: candidate.managedDigest,
        source: candidate.source,
      });
    }
    bindManagedPluginSnapshot(registry, {
      codeRoot: discovery.managedCodeRoot,
      lock: discovery.managedLock,
      bindings: managedBindings,
    });
  }
  pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
  warnWhenAllowlistIsOpen({
    logger,
    pluginsEnabled: normalized.enabled,
    allow: normalized.allow,
    discoverablePlugins: manifestRegistry.plugins.map((plugin) => ({
      id: plugin.id,
      source: plugin.source,
      origin: plugin.origin,
    })),
  });
  const provenance = buildProvenanceIndex({
    config: cfg,
    normalizedLoadPaths: normalized.loadPaths,
  });

  // Lazy: avoid creating the Jiti loader when all plugins are disabled (common in unit tests).
  let jitiLoader: ReturnType<typeof createJiti> | null = null;
  const getJiti = () => {
    if (jitiLoader) {
      return jitiLoader;
    }
    const pluginSdkAliases = resolvePluginSdkAliases();
    jitiLoader = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
      ...(Object.keys(pluginSdkAliases).length > 0
        ? {
            alias: pluginSdkAliases,
          }
        : {}),
    });
    return jitiLoader;
  };

  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );

  const seenIds = new Map<string, PluginRecord["origin"]>();
  const memorySlot = normalized.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  let memorySlotMatched = false;

  for (const candidate of discovery.candidates) {
    const manifestRecord = manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord) {
      continue;
    }
    const pluginId = manifestRecord.id;
    const existingOrigin = seenIds.get(pluginId);
    if (existingOrigin) {
      const record = createPluginRecord({
        id: pluginId,
        name: manifestRecord.name ?? pluginId,
        description: manifestRecord.description,
        version: manifestRecord.version,
        source: candidate.source,
        origin: candidate.origin,
        workspaceDir: candidate.workspaceDir,
        enabled: false,
        configSchema: Boolean(manifestRecord.configSchema),
      });
      record.status = "disabled";
      record.error = `overridden by ${existingOrigin} plugin`;
      registry.plugins.push(record);
      continue;
    }

    const enableState = resolveEffectiveEnableState({
      id: pluginId,
      origin: candidate.origin,
      config: normalized,
      rootConfig: cfg,
    });
    const entry = normalized.entries[pluginId];
    const record = createPluginRecord({
      id: pluginId,
      name: manifestRecord.name ?? pluginId,
      description: manifestRecord.description,
      version: manifestRecord.version,
      source: candidate.source,
      origin: candidate.origin,
      workspaceDir: candidate.workspaceDir,
      enabled: enableState.enabled,
      configSchema: Boolean(manifestRecord.configSchema),
    });
    record.kind = manifestRecord.kind;
    record.configUiHints = manifestRecord.configUiHints;
    record.configJsonSchema = manifestRecord.configSchema;

    if (!enableState.enabled) {
      record.status = "disabled";
      record.error = enableState.reason;
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    if (!manifestRecord.configSchema) {
      record.status = "error";
      record.error = "missing config schema";
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
      continue;
    }

    if (candidate.managedDigest && candidate.managedCodeRoot) {
      const expectedRoot = path.join(
        candidate.managedCodeRoot,
        candidate.managedDigest.slice("sha256:".length),
      );
      const source = path.resolve(candidate.source);
      const sourceRealPath = safeRealpathSync(source);
      const root = path.resolve(candidate.rootDir);
      const rootRealPath = safeRealpathSync(root);
      if (
        !sourceRealPath ||
        sourceRealPath !== source ||
        !isPathInside(expectedRoot, source) ||
        !rootRealPath ||
        rootRealPath !== root ||
        !isPathInside(expectedRoot, root)
      ) {
        const message = `managed plugin identity rejected: lock entry "${pluginId}" source is not the exact canonical digest-bound path`;
        record.status = "error";
        record.error = message;
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        registry.diagnostics.push({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message,
        });
        continue;
      }
    }

    const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
    const opened = openBoundaryFileSync({
      absolutePath: candidate.source,
      rootPath: pluginRoot,
      boundaryLabel: "plugin root",
      // Discovery stores rootDir as realpath but source may still be a lexical alias
      // (e.g. /var/... vs /private/var/... on macOS). Canonical boundary checks
      // still enforce containment; skip lexical pre-check to avoid false escapes.
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      record.status = "error";
      record.error = "plugin entry path escapes plugin root or fails alias checks";
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
      continue;
    }
    const safeSource = opened.path;
    fs.closeSync(opened.fd);
    if (candidate.managedDigest && candidate.managedCodeRoot && safeSource !== candidate.source) {
      const message = `managed plugin identity rejected: lock entry "${pluginId}" source changed through a path alias`;
      record.status = "error";
      record.error = message;
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message,
      });
      continue;
    }

    repairOfficialChannelRuntimeDependencies({
      pluginId,
      pluginRoot,
      logger,
    });

    let mod: FasedAgentPluginModule | null = null;
    const moduleLoadStartedAt = Date.now();
    try {
      mod = options.preloadedModules?.get(safeSource) ?? null;
      if (!mod) {
        mod = getJiti()(safeSource) as FasedAgentPluginModule;
        logger.debug?.(`[plugins] ${record.id} Jiti load ${Date.now() - moduleLoadStartedAt}ms`);
      }
    } catch (err) {
      recordPluginError({
        logger,
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
        error: err,
        logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
        diagnosticMessagePrefix: "failed to load plugin: ",
      });
      continue;
    }

    const resolved = resolvePluginModuleExport(mod);
    const definition = resolved.definition;
    const register = resolved.register;

    if (definition?.id && definition.id !== record.id) {
      const managed = isManagedPluginMode();
      const message = managed
        ? `managed plugin identity rejected: lock entry "${record.id}" exports "${definition.id}"`
        : `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`;
      registry.diagnostics.push({
        level: managed ? "error" : "warn",
        pluginId: record.id,
        source: record.source,
        message,
      });
      if (managed) {
        record.status = "error";
        record.error = message;
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }
    }

    record.name = definition?.name ?? record.name;
    record.description = definition?.description ?? record.description;
    record.version = definition?.version ?? record.version;
    const manifestKind = record.kind as string | undefined;
    const exportKind = definition?.kind as string | undefined;
    if (manifestKind && exportKind && exportKind !== manifestKind) {
      registry.diagnostics.push({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `plugin kind mismatch (manifest uses "${manifestKind}", export uses "${exportKind}")`,
      });
    }
    record.kind = definition?.kind ?? record.kind;

    if (record.kind === "memory" && memorySlot === record.id) {
      memorySlotMatched = true;
    }

    const memoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: record.kind,
      slot: memorySlot,
      selectedId: selectedMemoryPluginId,
    });

    if (!memoryDecision.enabled) {
      record.enabled = false;
      record.status = "disabled";
      record.error = memoryDecision.reason;
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    if (memoryDecision.selected && record.kind === "memory") {
      selectedMemoryPluginId = record.id;
    }

    const validatedConfig = validatePluginConfig({
      schema: manifestRecord.configSchema,
      cacheKey: manifestRecord.schemaCacheKey,
      value: entry?.config,
    });

    if (!validatedConfig.ok) {
      logger.error(`[plugins] ${record.id} invalid config: ${validatedConfig.errors?.join(", ")}`);
      record.status = "error";
      record.error = `invalid config: ${validatedConfig.errors?.join(", ")}`;
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
      continue;
    }

    if (validateOnly) {
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    if (typeof register !== "function") {
      logger.error(`[plugins] ${record.id} missing register/activate export`);
      record.status = "error";
      record.error = "plugin export missing register/activate";
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
      continue;
    }

    const api = createApi(record, {
      config: cfg,
      pluginConfig: validatedConfig.value,
    });

    try {
      const result = register(api);
      if (result && typeof result.then === "function") {
        registry.diagnostics.push({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: "plugin register returned a promise; async registration is ignored",
        });
      }
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
    } catch (err) {
      recordPluginError({
        logger,
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
        error: err,
        logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
        diagnosticMessagePrefix: "plugin failed during register: ",
      });
    }
  }

  if (typeof memorySlot === "string" && !memorySlotMatched) {
    registry.diagnostics.push({
      level: "warn",
      message: `memory slot plugin not found or not marked as memory: ${memorySlot}`,
    });
  }

  warnAboutUntrackedLoadedPlugins({
    registry,
    provenance,
    logger,
  });

  if (cacheEnabled) {
    registryCache.set(cacheKey, registry);
  }
  setActivePluginRegistry(registry, cacheKey);
  initializeGlobalHookRunner(registry);
  return registry;
}

export function resolveRuntimePluginRegistry(options: PluginLoadOptions = {}): PluginRegistry {
  return loadFasedAgentPlugins(options);
}

function safeRealpathOrResolve(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
