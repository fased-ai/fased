import { createRequire } from "node:module";

declare const __FASED_VERSION__: string | undefined;
const CORE_PACKAGE_NAMES = new Set(["fased", "@fased/fased"]);

const PACKAGE_JSON_CANDIDATES = [
  "../package.json",
  "../../package.json",
  "../../../package.json",
  "./package.json",
] as const;

const BUILD_INFO_CANDIDATES = [
  "../build-info.json",
  "../../build-info.json",
  "./build-info.json",
] as const;

function readVersionFromJsonCandidates(
  moduleUrl: string,
  candidates: readonly string[],
  opts: { requirePackageName?: boolean } = {},
): string | null {
  try {
    const require = createRequire(moduleUrl);
    for (const candidate of candidates) {
      try {
        const parsed = require(candidate) as { name?: string; version?: string };
        const version = parsed.version?.trim();
        if (!version) {
          continue;
        }
        if (opts.requirePackageName && !CORE_PACKAGE_NAMES.has(parsed.name ?? "")) {
          continue;
        }
        return version;
      } catch {
        // ignore missing or unreadable candidate
      }
    }
    return null;
  } catch {
    return null;
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export function readVersionFromPackageJsonForModuleUrl(moduleUrl: string): string | null {
  return readVersionFromJsonCandidates(moduleUrl, PACKAGE_JSON_CANDIDATES, {
    requirePackageName: true,
  });
}

export function readVersionFromBuildInfoForModuleUrl(moduleUrl: string): string | null {
  return readVersionFromJsonCandidates(moduleUrl, BUILD_INFO_CANDIDATES);
}

export function resolveVersionFromModuleUrl(moduleUrl: string): string | null {
  return (
    readVersionFromPackageJsonForModuleUrl(moduleUrl) ||
    readVersionFromBuildInfoForModuleUrl(moduleUrl)
  );
}

export type RuntimeVersionEnv = {
  [key: string]: string | undefined;
};

export type RuntimeSource = "source-checkout" | "managed-package" | "packaged-runtime";

export function resolveRuntimeSource(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
  moduleUrl = import.meta.url,
): RuntimeSource {
  const configured = env["FASED_RUNTIME_SOURCE"]?.trim();
  if (
    configured === "source-checkout" ||
    configured === "managed-package" ||
    configured === "packaged-runtime"
  ) {
    return configured;
  }
  if (
    moduleUrl.includes("/install-cache/npm-global/") ||
    moduleUrl.includes("/node_modules/@fased/fased/")
  ) {
    return "managed-package";
  }
  return env["FASED_GATEWAY_MODE"] === "managed" ? "packaged-runtime" : "source-checkout";
}

export function resolveRuntimeServiceVersion(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
  fallback = "dev",
): string {
  return (
    firstNonEmpty(env["FASED_VERSION"], env["FASED_SERVICE_VERSION"], env["npm_package_version"]) ??
    fallback
  );
}

// Single source of truth for the current FasedAgent version.
// - Embedded/bundled builds: injected define or env var.
// - Dev/npm builds: package.json.
export const VERSION =
  (typeof __FASED_VERSION__ === "string" && __FASED_VERSION__) ||
  process.env.FASED_BUNDLED_VERSION ||
  resolveVersionFromModuleUrl(import.meta.url) ||
  "0.0.0";
