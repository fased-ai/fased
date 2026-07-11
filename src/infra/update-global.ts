import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../utils.js";

export type GlobalInstallManager = "npm" | "pnpm" | "bun";

export type HostedNpmInstallTarget = {
  manager: "npm";
  globalRoot: string;
  cacheRoot: string;
  env: NodeJS.ProcessEnv;
};

export type CommandRunner = (
  argv: string[],
  options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

const PRIMARY_PACKAGE_NAME = "@fased/fased";
const LEGACY_PACKAGE_NAME = "fased";
const ALL_PACKAGE_NAMES = [PRIMARY_PACKAGE_NAME, LEGACY_PACKAGE_NAME] as const;
const GLOBAL_RENAME_PREFIX = ".";
const NPM_GLOBAL_INSTALL_QUIET_FLAGS = [
  "--no-fund",
  "--no-audit",
  "--loglevel=error",
  "--prefer-offline",
  "--no-progress",
] as const;
const NPM_GLOBAL_INSTALL_OMIT_OPTIONAL_FLAGS = [
  "--omit=optional",
  ...NPM_GLOBAL_INSTALL_QUIET_FLAGS,
] as const;

async function tryRealpath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function resolveBunGlobalRoot(): string {
  const bunInstall = process.env.BUN_INSTALL?.trim() || path.join(os.homedir(), ".bun");
  return path.join(bunInstall, "install", "global", "node_modules");
}

export function resolveNodeModulesRootForPackageRoot(pkgRoot: string): string {
  const parent = path.dirname(pkgRoot);
  if (path.basename(parent).startsWith("@")) {
    return path.dirname(parent);
  }
  return parent;
}

export function resolveHostedNpmInstallTarget(pkgRoot: string): HostedNpmInstallTarget | null {
  const resolved = path.resolve(pkgRoot);
  const prefixMarker = `${path.sep}.fased${path.sep}install-cache${path.sep}npm-global`;
  const globalRootSuffix = `${path.sep}lib${path.sep}node_modules`;
  const globalRootMarker = `${prefixMarker}${globalRootSuffix}`;
  const markerIndex = resolved.indexOf(`${globalRootMarker}${path.sep}`);
  if (markerIndex < 0) {
    return null;
  }

  const prefix = resolved.slice(0, markerIndex + prefixMarker.length);
  const globalRoot = path.join(prefix, "lib", "node_modules");
  const cache = path.join(path.dirname(prefix), "npm-cache");
  const expectedRoot = resolveNodeModulesRootForPackageRoot(resolved);
  if (path.resolve(expectedRoot) !== path.resolve(globalRoot)) {
    return null;
  }

  return {
    manager: "npm",
    globalRoot,
    cacheRoot: path.dirname(prefix),
    env: {
      npm_config_prefix: prefix,
      npm_config_cache: cache,
    },
  };
}

export async function resolveGlobalRoot(
  manager: GlobalInstallManager,
  runCommand: CommandRunner,
  timeoutMs: number,
): Promise<string | null> {
  if (manager === "bun") {
    return resolveBunGlobalRoot();
  }
  const argv = manager === "pnpm" ? ["pnpm", "root", "-g"] : ["npm", "root", "-g"];
  const res = await runCommand(argv, { timeoutMs }).catch(() => null);
  if (!res || res.code !== 0) {
    return null;
  }
  const root = res.stdout.trim();
  return root || null;
}

export async function resolveGlobalPackageRoot(
  manager: GlobalInstallManager,
  runCommand: CommandRunner,
  timeoutMs: number,
): Promise<string | null> {
  const root = await resolveGlobalRoot(manager, runCommand, timeoutMs);
  if (!root) {
    return null;
  }
  for (const name of ALL_PACKAGE_NAMES) {
    const candidate = path.join(root, name);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return path.join(root, PRIMARY_PACKAGE_NAME);
}

export async function detectGlobalInstallManagerForRoot(
  runCommand: CommandRunner,
  pkgRoot: string,
  timeoutMs: number,
): Promise<GlobalInstallManager | null> {
  const hostedTarget = resolveHostedNpmInstallTarget(pkgRoot);
  if (hostedTarget) {
    return hostedTarget.manager;
  }

  const pkgReal = await tryRealpath(pkgRoot);

  const candidates: Array<{
    manager: "npm" | "pnpm";
    argv: string[];
  }> = [
    { manager: "npm", argv: ["npm", "root", "-g"] },
    { manager: "pnpm", argv: ["pnpm", "root", "-g"] },
  ];

  for (const { manager, argv } of candidates) {
    const res = await runCommand(argv, { timeoutMs }).catch(() => null);
    if (!res || res.code !== 0) {
      continue;
    }
    const globalRoot = res.stdout.trim();
    if (!globalRoot) {
      continue;
    }
    const globalReal = await tryRealpath(globalRoot);
    for (const name of ALL_PACKAGE_NAMES) {
      const expected = path.join(globalReal, name);
      const expectedReal = await tryRealpath(expected);
      if (path.resolve(expectedReal) === path.resolve(pkgReal)) {
        return manager;
      }
    }
  }

  const bunGlobalRoot = resolveBunGlobalRoot();
  const bunGlobalReal = await tryRealpath(bunGlobalRoot);
  for (const name of ALL_PACKAGE_NAMES) {
    const bunExpected = path.join(bunGlobalReal, name);
    const bunExpectedReal = await tryRealpath(bunExpected);
    if (path.resolve(bunExpectedReal) === path.resolve(pkgReal)) {
      return "bun";
    }
  }

  return null;
}

export async function detectGlobalInstallManagerByPresence(
  runCommand: CommandRunner,
  timeoutMs: number,
): Promise<GlobalInstallManager | null> {
  for (const manager of ["npm", "pnpm"] as const) {
    const root = await resolveGlobalRoot(manager, runCommand, timeoutMs);
    if (!root) {
      continue;
    }
    for (const name of ALL_PACKAGE_NAMES) {
      if (await pathExists(path.join(root, name))) {
        return manager;
      }
    }
  }

  const bunRoot = resolveBunGlobalRoot();
  for (const name of ALL_PACKAGE_NAMES) {
    if (await pathExists(path.join(bunRoot, name))) {
      return "bun";
    }
  }
  return null;
}

export function globalInstallArgs(manager: GlobalInstallManager, spec: string): string[] {
  if (manager === "pnpm") {
    return ["pnpm", "add", "-g", spec];
  }
  if (manager === "bun") {
    return ["bun", "add", "-g", spec];
  }
  return ["npm", "i", "-g", spec, ...NPM_GLOBAL_INSTALL_QUIET_FLAGS];
}

export function globalInstallFallbackArgs(
  manager: GlobalInstallManager,
  spec: string,
): string[] | null {
  if (manager !== "npm") {
    return null;
  }
  return ["npm", "i", "-g", spec, ...NPM_GLOBAL_INSTALL_OMIT_OPTIONAL_FLAGS];
}

export async function cleanupGlobalRenameDirs(params: {
  globalRoot: string;
  packageName: string;
}): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const root = params.globalRoot.trim();
  const name = params.packageName.trim();
  if (!root || !name) {
    return { removed };
  }
  const safeNames = Array.from(new Set([name, path.basename(name)].filter(Boolean)));
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return { removed };
  }
  for (const entry of entries) {
    if (!safeNames.some((safeName) => entry.startsWith(`${GLOBAL_RENAME_PREFIX}${safeName}-`))) {
      continue;
    }
    const target = path.join(root, entry);
    try {
      const stat = await fs.lstat(target);
      if (!stat.isDirectory()) {
        continue;
      }
      await fs.rm(target, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // ignore cleanup failures
    }
  }
  return { removed };
}
