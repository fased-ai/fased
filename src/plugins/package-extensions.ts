import path from "node:path";
import { fileExists } from "../infra/archive.js";
import { MANIFEST_KEY } from "../project.js";
import { isPathInside } from "../security/scan-paths.js";
import { DEFAULT_PLUGIN_ENTRY_CANDIDATES, type PluginManifest } from "./manifest.js";

export type PluginPackageManifest = {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
} & Partial<Record<typeof MANIFEST_KEY, { extensions?: string[] }>>;

export type ResolvedPluginPackageExtensions = {
  extensions: string[];
  source: "fased" | "legacy-plugin-manifest";
};

function normalizeEntry(entry: unknown): string | null {
  if (typeof entry !== "string") {
    return null;
  }
  const trimmed = entry.trim();
  if (!trimmed || path.isAbsolute(trimmed)) {
    return null;
  }
  const normalized = trimmed.replace(/^\.\/+/, "");
  if (!normalized || normalized === "." || normalized === "..") {
    return null;
  }
  return normalized;
}

async function inferExtensionsFromLegacyPluginManifest(params: {
  manifest: PluginPackageManifest;
  packageDir: string;
  pluginManifest?: PluginManifest;
}): Promise<string[]> {
  if (!params.pluginManifest) {
    return [];
  }

  const packageDir = path.resolve(params.packageDir);
  const candidates = [
    params.manifest.main,
    params.manifest.module,
    ...DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  ];
  const seen = new Set<string>();
  const entries: string[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeEntry(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const resolved = path.resolve(packageDir, normalized);
    if (!isPathInside(packageDir, resolved)) {
      continue;
    }
    if (await fileExists(resolved)) {
      entries.push(normalized);
    }
  }

  return entries;
}

export async function resolvePluginPackageExtensions(params: {
  manifest: PluginPackageManifest;
  packageDir: string;
  pluginManifest?: PluginManifest;
}): Promise<ResolvedPluginPackageExtensions> {
  let manifestKey: typeof MANIFEST_KEY | null = null;
  let extensions = params.manifest[MANIFEST_KEY]?.extensions;
  if (Array.isArray(extensions)) {
    manifestKey = MANIFEST_KEY;
  }

  if (Array.isArray(extensions)) {
    const list = extensions.map((e) => (typeof e === "string" ? e.trim() : "")).filter(Boolean);
    if (list.length === 0) {
      throw new Error(`package.json ${manifestKey ?? MANIFEST_KEY}.extensions is empty`);
    }
    return {
      extensions: list,
      source: "fased",
    };
  }

  const inferred = await inferExtensionsFromLegacyPluginManifest(params);
  if (inferred.length > 0) {
    return {
      extensions: inferred,
      source: "legacy-plugin-manifest",
    };
  }

  throw new Error(`package.json missing ${MANIFEST_KEY}.extensions`);
}
