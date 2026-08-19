import fs from "node:fs/promises";
import path from "node:path";
import { fileExists, readJsonFile, resolveArchiveKind } from "../infra/archive.js";
import { resolveExistingInstallPath, withExtractedArchiveRoot } from "../infra/install-flow.js";
import {
  resolveInstallModeOptions,
  resolveTimedInstallModeOptions,
} from "../infra/install-mode-options.js";
import { installPackageDir } from "../infra/install-package-dir.js";
import {
  resolveSafeInstallDir,
  safeDirName,
  unscopedPackageName,
} from "../infra/install-safe-path.js";
import {
  type NpmIntegrityDrift,
  type NpmSpecResolution,
  resolveArchiveSourcePath,
} from "../infra/install-source-utils.js";
import { isManagedLifecycleRuntime } from "../infra/managed-runtime-authority.js";
import {
  finalizeNpmSpecArchiveInstall,
  installFromNpmSpecArchiveWithInstaller,
} from "../infra/npm-pack-install.js";
import { validateRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { extensionUsesSkippedScannerPath, isPathInside } from "../security/scan-paths.js";
import * as skillScanner from "../security/skill-scanner.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { loadPluginManifest, type PluginManifest } from "./manifest.js";
import {
  resolvePluginPackageExtensions,
  type PluginPackageManifest,
} from "./package-extensions.js";

type PluginInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type PackageManifest = PluginPackageManifest;

type ExpectedPluginIdsParams = {
  expectedPluginId?: string;
  expectedPluginIds?: string[];
};

const MAX_PLUGIN_ACCESS_ENTRIES = 50_000;

/**
 * Plugin code is written by the operator but read by the isolated Gateway.
 * Converge only the exact canonical install tree, never arbitrary user state.
 */
export async function convergeInstalledPluginAccess(params: {
  extensionsDir: string;
  targetDir: string;
}): Promise<void> {
  const extensionsDir = path.resolve(params.extensionsDir);
  const targetDir = path.resolve(params.targetDir);
  if (!isPathInside(extensionsDir, targetDir)) {
    throw new Error("plugin access convergence target escaped the extensions directory");
  }
  const extensions = await fs.lstat(extensionsDir);
  if (!extensions.isDirectory() || extensions.isSymbolicLink()) {
    throw new Error("plugin extensions root is not a regular directory");
  }
  await fs.chmod(extensionsDir, 0o2770);
  const canConvergeGroup = process.platform !== "win32";

  const pending = [targetDir];
  let inspected = 0;
  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath) {
      continue;
    }
    inspected += 1;
    if (inspected > MAX_PLUGIN_ACCESS_ENTRIES) {
      throw new Error("plugin access convergence tree is too large");
    }
    const stat = await fs.lstat(currentPath);
    if (stat.isSymbolicLink()) {
      const resolved = await fs.realpath(currentPath);
      if (resolved !== targetDir && !isPathInside(targetDir, resolved)) {
        throw new Error("plugin install contains a symlink outside its canonical install tree");
      }
      continue;
    }
    if (stat.isDirectory()) {
      if (canConvergeGroup) {
        await fs.chown(currentPath, stat.uid, extensions.gid);
      }
      await fs.chmod(currentPath, 0o2750);
      for (const name of await fs.readdir(currentPath)) {
        pending.push(path.join(currentPath, name));
      }
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("plugin install contains an unsafe filesystem entry");
    }
    if (canConvergeGroup) {
      await fs.chown(currentPath, stat.uid, extensions.gid);
    }
    await fs.chmod(currentPath, (stat.mode & 0o111) !== 0 ? 0o750 : 0o640);
  }
}

function normalizeExpectedPluginIds(params: ExpectedPluginIdsParams): string[] {
  const ids = new Set<string>();
  for (const raw of [params.expectedPluginId, ...(params.expectedPluginIds ?? [])]) {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) {
      continue;
    }
    ids.add(unscopedPackageName(trimmed));
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}

export type PluginInstallPackageReview = {
  pluginId: string;
  packageName?: string;
  version?: string;
  extensions: string[];
  kind?: string;
  channels: string[];
  providers: string[];
  skills: string[];
  tools: string[];
  dependencyCount: number;
  dependencyKinds: string[];
  scriptNames: string[];
  dependencyWarnings: string[];
  scriptWarnings: string[];
  runtimeWarnings?: string[];
};

export type InstallPluginResult =
  | {
      ok: true;
      pluginId: string;
      targetDir: string;
      manifestName?: string;
      version?: string;
      extensions: string[];
      review?: PluginInstallPackageReview;
      npmResolution?: NpmSpecResolution;
      integrityDrift?: NpmIntegrityDrift;
    }
  | { ok: false; error: string };

export type PluginNpmIntegrityDriftParams = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: NpmSpecResolution;
};

const managedPluginMutationError =
  "Managed installations do not install or replace third-party plugin code from the application. Use the digest-bound `fased plugins install` or `fased plugins update` catalog command; npm and path mutation remain available only in a developer source runtime.";

function rejectManagedPluginMutation(): InstallPluginResult | null {
  return isManagedLifecycleRuntime() ? { ok: false, error: managedPluginMutationError } : null;
}

const defaultLogger: PluginInstallLogger = {};
function safeFileName(input: string): string {
  return safeDirName(input);
}

function validatePluginId(pluginId: string): string | null {
  if (!pluginId) {
    return "invalid plugin name: missing";
  }
  if (pluginId === "." || pluginId === "..") {
    return "invalid plugin name: reserved path segment";
  }
  if (pluginId.includes("/") || pluginId.includes("\\")) {
    return "invalid plugin name: path separators not allowed";
  }
  return null;
}

function buildFileInstallResult(pluginId: string, targetFile: string): InstallPluginResult {
  return {
    ok: true,
    pluginId,
    targetDir: targetFile,
    manifestName: undefined,
    version: undefined,
    extensions: [path.basename(targetFile)],
  };
}

function countManifestEntries(value: Record<string, string> | undefined): number {
  return Object.keys(value ?? {}).length;
}

function listManifestKeys(value: Record<string, string> | undefined): string[] {
  return Object.keys(value ?? {})
    .map((entry) => entry.trim())
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function isTypeScriptExtensionEntry(entry: string): boolean {
  const ext = path.extname(entry.trim()).toLowerCase();
  return ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts";
}

function buildRuntimeWarnings(extensions: string[]): string[] {
  const sourceEntries = extensions
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter(isTypeScriptExtensionEntry)
    .toSorted((left, right) => left.localeCompare(right));
  if (sourceEntries.length === 0) {
    return [];
  }
  const label = sourceEntries.length === 1 ? "entry" : "entries";
  return [
    `package exposes TypeScript extension ${label} (${sourceEntries.join(", ")}); publish compiled JavaScript runtime output before enabling this plugin`,
  ];
}

function buildInstallPackageReview(params: {
  pluginId: string;
  manifest: PackageManifest;
  extensions: string[];
  pluginManifest?: PluginManifest;
}): PluginInstallPackageReview {
  const dependencyKinds: string[] = [];
  const dependencyCount = countManifestEntries(params.manifest.dependencies);
  const optionalDependencyCount = countManifestEntries(params.manifest.optionalDependencies);
  const peerDependencyCount = countManifestEntries(params.manifest.peerDependencies);
  const totalDependencyCount = dependencyCount + optionalDependencyCount + peerDependencyCount;
  if (dependencyCount > 0) {
    dependencyKinds.push(`dependencies:${dependencyCount}`);
  }
  if (optionalDependencyCount > 0) {
    dependencyKinds.push(`optionalDependencies:${optionalDependencyCount}`);
  }
  if (peerDependencyCount > 0) {
    dependencyKinds.push(`peerDependencies:${peerDependencyCount}`);
  }
  const scriptNames = listManifestKeys(params.manifest.scripts);
  const dependencyWarnings =
    totalDependencyCount > 0
      ? [
          `package declares ${totalDependencyCount} dependenc${totalDependencyCount === 1 ? "y" : "ies"}; Fased installs runtime dependencies with npm --ignore-scripts`,
        ]
      : [];
  const scriptWarnings =
    scriptNames.length > 0
      ? [
          `package declares npm scripts (${scriptNames.join(", ")}); Fased pack/install paths use --ignore-scripts`,
        ]
      : [];
  const runtimeWarnings = buildRuntimeWarnings(params.extensions);
  return {
    pluginId: params.pluginId,
    packageName: params.manifest.name || undefined,
    version: params.manifest.version || undefined,
    extensions: params.extensions,
    kind: params.pluginManifest?.kind,
    channels: params.pluginManifest?.channels ?? [],
    providers: params.pluginManifest?.providers ?? [],
    skills: params.pluginManifest?.skills ?? [],
    tools: params.pluginManifest?.contracts?.tools ?? [],
    dependencyCount: totalDependencyCount,
    dependencyKinds,
    scriptNames,
    dependencyWarnings,
    scriptWarnings,
    runtimeWarnings,
  };
}

export function resolvePluginInstallDir(pluginId: string, extensionsDir?: string): string {
  const extensionsBase = extensionsDir
    ? resolveUserPath(extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    throw new Error(pluginIdError);
  }
  const targetDirResult = resolveSafeInstallDir({
    baseDir: extensionsBase,
    id: pluginId,
    invalidNameMessage: "invalid plugin name: path traversal detected",
  });
  if (!targetDirResult.ok) {
    throw new Error(targetDirResult.error);
  }
  return targetDirResult.path;
}

async function installPluginFromPackageDir(params: {
  packageDir: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
  expectedPluginIds?: string[];
}): Promise<InstallPluginResult> {
  const { logger, timeoutMs, mode, dryRun } = resolveTimedInstallModeOptions(params, defaultLogger);

  const manifestPath = path.join(params.packageDir, "package.json");
  if (!(await fileExists(manifestPath))) {
    return { ok: false, error: "extracted package missing package.json" };
  }

  let manifest: PackageManifest;
  try {
    manifest = await readJsonFile<PackageManifest>(manifestPath);
  } catch (err) {
    return { ok: false, error: `invalid package.json: ${String(err)}` };
  }

  const pkgName = typeof manifest.name === "string" ? manifest.name : "";
  const npmPluginId = pkgName ? unscopedPackageName(pkgName) : "plugin";

  // Prefer the canonical `id` from fased.plugin.json over the npm package name.
  // This avoids a latent key-mismatch bug: if the manifest id (e.g. "memory-cognee")
  // differs from the npm package name (e.g. "cognee-fased"), the plugin registry
  // uses the manifest id as the authoritative key, so the config entry must match it.
  const pluginManifestResult = loadPluginManifest(params.packageDir);
  const manifestPlugin =
    pluginManifestResult.ok && pluginManifestResult.manifest.id
      ? pluginManifestResult.manifest
      : undefined;
  const manifestPluginId =
    pluginManifestResult.ok && pluginManifestResult.manifest.id
      ? unscopedPackageName(pluginManifestResult.manifest.id)
      : undefined;
  let extensions: string[];
  try {
    const resolvedExtensions = await resolvePluginPackageExtensions({
      manifest,
      packageDir: params.packageDir,
      pluginManifest: manifestPlugin,
    });
    extensions = resolvedExtensions.extensions;
    if (resolvedExtensions.source === "legacy-plugin-manifest") {
      logger.info?.(
        `Plugin "${manifestPlugin?.id ?? npmPluginId}" uses legacy plugin manifest entry inference; prefer package.json fased.extensions for new packages.`,
      );
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const pluginId = manifestPluginId ?? npmPluginId;
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    return { ok: false, error: pluginIdError };
  }
  const expectedPluginIds = normalizeExpectedPluginIds(params);
  if (expectedPluginIds.length > 0 && !expectedPluginIds.includes(pluginId)) {
    return {
      ok: false,
      error: `plugin id mismatch: expected ${expectedPluginIds.join(" or ")}, got ${pluginId}`,
    };
  }

  if (manifestPluginId && manifestPluginId !== npmPluginId) {
    logger.info?.(
      `Plugin manifest id "${manifestPluginId}" differs from npm package name "${npmPluginId}"; using manifest id as the config key.`,
    );
  }

  const packageDir = path.resolve(params.packageDir);
  const forcedScanEntries: string[] = [];
  for (const entry of extensions) {
    const resolvedEntry = path.resolve(packageDir, entry);
    if (!isPathInside(packageDir, resolvedEntry)) {
      logger.warn?.(`extension entry escapes plugin directory and will not be scanned: ${entry}`);
      continue;
    }
    if (extensionUsesSkippedScannerPath(entry)) {
      logger.warn?.(
        `extension entry is in a hidden/node_modules path and will receive targeted scan coverage: ${entry}`,
      );
    }
    forcedScanEntries.push(resolvedEntry);
  }

  // Scan plugin source for dangerous code patterns (warn-only; never blocks install)
  try {
    const scanSummary = await skillScanner.scanDirectoryWithSummary(params.packageDir, {
      includeFiles: forcedScanEntries,
    });
    if (scanSummary.critical > 0) {
      const criticalDetails = scanSummary.findings
        .filter((f) => f.severity === "critical")
        .map((f) => `${f.message} (${f.file}:${f.line})`)
        .join("; ");
      logger.warn?.(
        `WARNING: Plugin "${pluginId}" contains dangerous code patterns: ${criticalDetails}`,
      );
    } else if (scanSummary.warn > 0) {
      logger.warn?.(
        `Plugin "${pluginId}" has ${scanSummary.warn} suspicious code pattern(s). Run "fased security audit --deep" for details.`,
      );
    }
  } catch (err) {
    logger.warn?.(
      `Plugin "${pluginId}" code safety scan failed (${String(err)}). Installation continues; run "fased security audit --deep" after install.`,
    );
  }

  const extensionsDir = params.extensionsDir
    ? resolveUserPath(params.extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  await fs.mkdir(extensionsDir, { recursive: true, mode: 0o2770 });
  await fs.chmod(extensionsDir, 0o2770);

  const targetDirResult = resolveSafeInstallDir({
    baseDir: extensionsDir,
    id: pluginId,
    invalidNameMessage: "invalid plugin name: path traversal detected",
  });
  if (!targetDirResult.ok) {
    return { ok: false, error: targetDirResult.error };
  }
  const targetDir = targetDirResult.path;

  if (mode === "install" && (await fileExists(targetDir))) {
    return {
      ok: false,
      error: `plugin already exists: ${targetDir} (delete it first)`,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      pluginId,
      targetDir,
      manifestName: pkgName || undefined,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
      extensions,
      review: buildInstallPackageReview({
        pluginId,
        manifest,
        extensions,
        pluginManifest: manifestPlugin,
      }),
    };
  }

  const hasDeps = Boolean(
    (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) ||
    (manifest.optionalDependencies && Object.keys(manifest.optionalDependencies).length > 0),
  );
  const installRes = await installPackageDir({
    sourceDir: params.packageDir,
    targetDir,
    mode,
    timeoutMs,
    logger,
    copyErrorPrefix: "failed to copy plugin",
    hasDeps,
    depsLogMessage: "Installing plugin dependencies…",
    afterCopy: async () => {
      for (const entry of extensions) {
        const resolvedEntry = path.resolve(targetDir, entry);
        if (!isPathInside(targetDir, resolvedEntry)) {
          logger.warn?.(`extension entry escapes plugin directory: ${entry}`);
          continue;
        }
        if (!(await fileExists(resolvedEntry))) {
          logger.warn?.(`extension entry not found: ${entry}`);
        }
      }
    },
    afterInstall: async () => {
      await convergeInstalledPluginAccess({ extensionsDir, targetDir });
    },
  });
  if (!installRes.ok) {
    return installRes;
  }

  return {
    ok: true,
    pluginId,
    targetDir,
    manifestName: pkgName || undefined,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
    extensions,
    review: buildInstallPackageReview({
      pluginId,
      manifest,
      extensions,
      pluginManifest: manifestPlugin,
    }),
  };
}

export async function installPluginFromArchive(params: {
  archivePath: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
  expectedPluginIds?: string[];
}): Promise<InstallPluginResult> {
  const managedRejection = rejectManagedPluginMutation();
  if (managedRejection) {
    return managedRejection;
  }
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const mode = params.mode ?? "install";
  const archivePathResult = await resolveArchiveSourcePath(params.archivePath);
  if (!archivePathResult.ok) {
    return archivePathResult;
  }
  const archivePath = archivePathResult.path;

  return await withExtractedArchiveRoot({
    archivePath,
    tempDirPrefix: "fased-plugin-",
    timeoutMs,
    logger,
    onExtracted: async (packageDir) =>
      await installPluginFromPackageDir({
        packageDir,
        extensionsDir: params.extensionsDir,
        timeoutMs,
        logger,
        mode,
        dryRun: params.dryRun,
        expectedPluginId: params.expectedPluginId,
        expectedPluginIds: params.expectedPluginIds,
      }),
  });
}

export async function installPluginFromDir(params: {
  dirPath: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
  expectedPluginIds?: string[];
}): Promise<InstallPluginResult> {
  const managedRejection = rejectManagedPluginMutation();
  if (managedRejection) {
    return managedRejection;
  }
  const dirPath = resolveUserPath(params.dirPath);
  if (!(await fileExists(dirPath))) {
    return { ok: false, error: `directory not found: ${dirPath}` };
  }
  const stat = await fs.stat(dirPath);
  if (!stat.isDirectory()) {
    return { ok: false, error: `not a directory: ${dirPath}` };
  }

  return await installPluginFromPackageDir({
    packageDir: dirPath,
    extensionsDir: params.extensionsDir,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
    expectedPluginId: params.expectedPluginId,
    expectedPluginIds: params.expectedPluginIds,
  });
}

export async function installPluginFromFile(params: {
  filePath: string;
  extensionsDir?: string;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
}): Promise<InstallPluginResult> {
  const managedRejection = rejectManagedPluginMutation();
  if (managedRejection) {
    return managedRejection;
  }
  const { logger, mode, dryRun } = resolveInstallModeOptions(params, defaultLogger);

  const filePath = resolveUserPath(params.filePath);
  if (!(await fileExists(filePath))) {
    return { ok: false, error: `file not found: ${filePath}` };
  }

  const extensionsDir = params.extensionsDir
    ? resolveUserPath(params.extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  await fs.mkdir(extensionsDir, { recursive: true });

  const base = path.basename(filePath, path.extname(filePath));
  const pluginId = base || "plugin";
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    return { ok: false, error: pluginIdError };
  }
  const targetFile = path.join(extensionsDir, `${safeFileName(pluginId)}${path.extname(filePath)}`);

  if (mode === "install" && (await fileExists(targetFile))) {
    return { ok: false, error: `plugin already exists: ${targetFile} (delete it first)` };
  }

  if (dryRun) {
    return buildFileInstallResult(pluginId, targetFile);
  }

  logger.info?.(`Installing to ${targetFile}…`);
  await fs.copyFile(filePath, targetFile);

  return buildFileInstallResult(pluginId, targetFile);
}

export async function installPluginFromNpmSpec(params: {
  spec: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
  expectedPluginIds?: string[];
  expectedIntegrity?: string;
  onIntegrityDrift?: (params: PluginNpmIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<InstallPluginResult> {
  const managedRejection = rejectManagedPluginMutation();
  if (managedRejection) {
    return managedRejection;
  }
  const { logger, timeoutMs, mode, dryRun } = resolveTimedInstallModeOptions(params, defaultLogger);
  const expectedPluginId = params.expectedPluginId;
  const expectedPluginIds = params.expectedPluginIds;
  const spec = params.spec.trim();
  const specError = validateRegistryNpmSpec(spec);
  if (specError) {
    return { ok: false, error: specError };
  }

  logger.info?.(`Downloading ${spec}…`);
  const flowResult = await installFromNpmSpecArchiveWithInstaller({
    tempDirPrefix: "fased-npm-pack-",
    spec,
    timeoutMs,
    expectedIntegrity: params.expectedIntegrity,
    onIntegrityDrift: params.onIntegrityDrift,
    warn: (message) => {
      logger.warn?.(message);
    },
    installFromArchive: installPluginFromArchive,
    archiveInstallParams: {
      extensionsDir: params.extensionsDir,
      timeoutMs,
      logger,
      mode,
      dryRun,
      expectedPluginId,
      expectedPluginIds,
    },
  });
  return finalizeNpmSpecArchiveInstall(flowResult);
}

export async function installPluginFromPath(params: {
  path: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
  expectedPluginIds?: string[];
}): Promise<InstallPluginResult> {
  const managedRejection = rejectManagedPluginMutation();
  if (managedRejection) {
    return managedRejection;
  }
  const pathResult = await resolveExistingInstallPath(params.path);
  if (!pathResult.ok) {
    return pathResult;
  }
  const { resolvedPath: resolved, stat } = pathResult;

  if (stat.isDirectory()) {
    return await installPluginFromDir({
      dirPath: resolved,
      extensionsDir: params.extensionsDir,
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      mode: params.mode,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
      expectedPluginIds: params.expectedPluginIds,
    });
  }

  const archiveKind = resolveArchiveKind(resolved);
  if (archiveKind) {
    return await installPluginFromArchive({
      archivePath: resolved,
      extensionsDir: params.extensionsDir,
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      mode: params.mode,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
      expectedPluginIds: params.expectedPluginIds,
    });
  }

  return await installPluginFromFile({
    filePath: resolved,
    extensionsDir: params.extensionsDir,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
  });
}
