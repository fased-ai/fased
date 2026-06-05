import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig, PluginEntryConfig, PluginsConfig } from "./types.js";

type PathExists = (candidate: string) => boolean;

export type MovedRepoPluginPathRepair = {
  config: FasedAgentConfig;
  changed: boolean;
  rewrittenPaths: string[];
};

export type MovedRepoPluginPathRepairOptions = {
  cwd?: string;
  pathExists?: PathExists;
  repoRoot?: string;
};

function safePathExists(pathExists: PathExists, candidate: string): boolean {
  try {
    return pathExists(candidate);
  } catch {
    return false;
  }
}

function inferRepoRoot(params: { cwd: string; pathExists: PathExists }): string | null {
  let cursor = path.resolve(params.cwd);
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      safePathExists(params.pathExists, path.join(cursor, "package.json")) &&
      safePathExists(params.pathExists, path.join(cursor, "extensions"))
    ) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}

function legacyRootCandidates(repoRoot: string): string[] {
  const parent = path.dirname(repoRoot);
  return [path.join(parent, "agent", "fased"), path.join(parent, "agent")].toSorted(
    (left, right) => right.length - left.length,
  );
}

function rewriteMovedRepoPathValue(
  value: string,
  params: { repoRoot: string; pathExists: PathExists },
): string {
  const sourcePrefix = "source:";
  const prefix = value.startsWith(sourcePrefix) ? sourcePrefix : "";
  const body = prefix ? value.slice(prefix.length) : value;
  if (!path.isAbsolute(body)) {
    return value;
  }

  for (const oldRoot of legacyRootCandidates(params.repoRoot)) {
    if (body !== oldRoot && !body.startsWith(`${oldRoot}${path.sep}`)) {
      continue;
    }
    const suffix = body.slice(oldRoot.length);
    const candidate = `${params.repoRoot}${suffix}`;
    if (safePathExists(params.pathExists, candidate)) {
      return `${prefix}${candidate}`;
    }
  }

  return value;
}

function rewriteStringArray(
  values: string[] | undefined,
  params: { repoRoot: string; pathExists: PathExists },
): { values: string[] | undefined; changed: boolean; rewrittenPaths: string[] } {
  if (!values) {
    return { values, changed: false, rewrittenPaths: [] };
  }
  let changed = false;
  const rewrittenPaths: string[] = [];
  const next = values.map((value) => {
    const rewritten = rewriteMovedRepoPathValue(value, params);
    if (rewritten !== value) {
      changed = true;
      rewrittenPaths.push(rewritten);
    }
    return rewritten;
  });
  return { values: changed ? next : values, changed, rewrittenPaths };
}

function repairPluginEntries(
  entries: PluginsConfig["entries"],
  params: { repoRoot: string; pathExists: PathExists },
): {
  entries: PluginsConfig["entries"];
  changed: boolean;
  rewrittenPaths: string[];
} {
  if (!entries) {
    return { entries, changed: false, rewrittenPaths: [] };
  }

  let changed = false;
  const rewrittenPaths: string[] = [];
  const nextEntries: Record<string, PluginEntryConfig> = {};

  for (const [pluginId, entry] of Object.entries(entries)) {
    let nextEntry = entry;
    const grants = entry.runtime?.adminRpcActions?.allow;
    if (grants) {
      let grantsChanged = false;
      const nextGrants = grants.map((grant) => {
        const sourcesRepair = rewriteStringArray(grant.sources, params);
        if (!sourcesRepair.changed) {
          return grant;
        }
        grantsChanged = true;
        rewrittenPaths.push(...sourcesRepair.rewrittenPaths);
        return { ...grant, sources: sourcesRepair.values };
      });

      if (grantsChanged) {
        changed = true;
        nextEntry = {
          ...entry,
          runtime: {
            ...entry.runtime,
            adminRpcActions: {
              ...entry.runtime.adminRpcActions,
              allow: nextGrants,
            },
          },
        };
      }
    }
    nextEntries[pluginId] = nextEntry;
  }

  return { entries: changed ? nextEntries : entries, changed, rewrittenPaths };
}

export function repairMovedRepoPluginPaths(
  config: FasedAgentConfig,
  options: MovedRepoPluginPathRepairOptions = {},
): MovedRepoPluginPathRepair {
  const pathExists = options.pathExists ?? fs.existsSync;
  const repoRoot =
    options.repoRoot ??
    inferRepoRoot({
      cwd: options.cwd ?? process.cwd(),
      pathExists,
    });
  if (!repoRoot || !config.plugins) {
    return { config, changed: false, rewrittenPaths: [] };
  }

  let changed = false;
  const rewrittenPaths: string[] = [];
  let plugins = config.plugins;

  const loadPathsRepair = rewriteStringArray(config.plugins.load?.paths, { repoRoot, pathExists });
  if (loadPathsRepair.changed) {
    changed = true;
    rewrittenPaths.push(...loadPathsRepair.rewrittenPaths);
    plugins = {
      ...plugins,
      load: {
        ...plugins.load,
        paths: loadPathsRepair.values,
      },
    };
  }

  const entriesRepair = repairPluginEntries(config.plugins.entries, { repoRoot, pathExists });
  if (entriesRepair.changed) {
    changed = true;
    rewrittenPaths.push(...entriesRepair.rewrittenPaths);
    plugins = {
      ...plugins,
      entries: entriesRepair.entries,
    };
  }

  if (!changed) {
    return { config, changed: false, rewrittenPaths: [] };
  }

  return {
    config: {
      ...config,
      plugins,
    },
    changed: true,
    rewrittenPaths,
  };
}
