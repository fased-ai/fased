import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginRegistry } from "./registry.js";

const CACHE_SCHEMA_VERSION = 2;

export type CachedPluginStatus = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  origin: string;
  status: "loaded" | "disabled" | "error";
  error?: string;
  channelIds: string[];
  providerIds: string[];
  hookNames: string[];
  sourceMtimeMs: number | null;
};

export type PluginStatusCache = {
  schemaVersion: number;
  packageVersion: string;
  generatedAt: string;
  configPath: string;
  configFingerprint: string;
  plugins: CachedPluginStatus[];
  diagnostics: Array<{
    level: string;
    message: string;
    pluginId?: string;
    source?: string;
  }>;
};

function statMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function configFingerprint(configPath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins?: unknown;
    };
    return createHash("sha256")
      .update(JSON.stringify(canonicalize({ plugins: parsed.plugins })))
      .digest("hex");
  } catch {
    return createHash("sha256").update("missing-config").digest("hex");
  }
}

export function resolvePluginStatusCachePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const explicitPath = env.FASED_PLUGIN_STATUS_CACHE_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }
  const stateDir = env.FASED_STATE_DIR?.trim() || path.join(homeDir, ".fased");
  return path.join(stateDir, "runtime", "plugin-status.json");
}

export function resolvePluginStatusConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return (
    env.FASED_CONFIG_PATH?.trim() ||
    path.join(env.FASED_STATE_DIR?.trim() || path.join(homeDir, ".fased"), "fased.json")
  );
}

export function readCurrentPackageVersion(argv1: string | undefined): string | null {
  if (!argv1) {
    return null;
  }
  try {
    const entry = fs.realpathSync(argv1);
    const packagePath = path.join(path.dirname(entry), "package.json");
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function readValidPluginStatusCache(params: {
  cachePath?: string;
  configPath?: string;
  packageVersion: string;
}): PluginStatusCache | null {
  const cachePath = params.cachePath ?? resolvePluginStatusCachePath();
  const configPath = params.configPath ?? resolvePluginStatusConfigPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as PluginStatusCache;
    if (
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
      parsed.packageVersion !== params.packageVersion ||
      parsed.configPath !== configPath ||
      parsed.configFingerprint !== configFingerprint(configPath) ||
      !Array.isArray(parsed.plugins) ||
      !Array.isArray(parsed.diagnostics)
    ) {
      return null;
    }
    for (const plugin of parsed.plugins) {
      if (plugin.sourceMtimeMs !== statMtimeMs(plugin.source)) {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writePluginStatusCache(params: {
  cachePath?: string;
  configPath: string;
  packageVersion: string;
  registry: PluginRegistry;
}): void {
  const cachePath = params.cachePath ?? resolvePluginStatusCachePath();
  const cache: PluginStatusCache = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    packageVersion: params.packageVersion,
    generatedAt: new Date().toISOString(),
    configPath: params.configPath,
    configFingerprint: configFingerprint(params.configPath),
    plugins: params.registry.plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name ?? plugin.id,
      version: plugin.version,
      description: plugin.description,
      source: plugin.source,
      origin: plugin.origin,
      status: plugin.status,
      error: plugin.error,
      channelIds: plugin.channelIds,
      providerIds: plugin.providerIds,
      hookNames: plugin.hookNames,
      sourceMtimeMs: statMtimeMs(plugin.source),
    })),
    diagnostics: params.registry.diagnostics.map((diagnostic) => ({
      level: diagnostic.level,
      message: diagnostic.message,
      pluginId: diagnostic.pluginId,
      source: diagnostic.source,
    })),
  };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${cachePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(cache)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, cachePath);
}
