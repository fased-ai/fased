#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertManagedRuntime,
  atomicSymlink,
  atomicWriteJson,
  buildManagedInstallManifest,
  copyExecutable,
  normalizeManagedProfile,
  readHostedRuntimeMetadata,
  readManagedInstallManifest,
  readPackageVersion,
  resolveLinkTarget,
  resolveManagedRuntimePaths,
} from "./managed-runtime-layout.mjs";

function parseArgs(argv) {
  const rollback = argv[0] === "--rollback";
  const tokens = rollback ? argv.slice(1) : argv;
  const values = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid managed runtime installer argument: ${key || ""}`);
    }
    values.set(key, value);
    index += 1;
  }
  const packageRoot = values.get("--package-root");
  const stateDir = values.get("--state-dir");
  const prefix = values.get("--prefix");
  if (!stateDir || !prefix || (!rollback && !packageRoot)) {
    throw new Error("--package-root, --state-dir, and --prefix are required");
  }
  return {
    rollback,
    packageRoot: packageRoot ? path.resolve(packageRoot) : null,
    previousPackageRoot: values.get("--previous-package-root")
      ? path.resolve(values.get("--previous-package-root"))
      : null,
    stateDir: path.resolve(stateDir),
    prefix: path.resolve(prefix),
    profile: normalizeManagedProfile(values.get("--profile")),
  };
}

async function pathExists(target) {
  try {
    await fsp.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function moveDirectory(source, destination) {
  try {
    await fsp.rename(source, destination);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
  }
  await fsp.cp(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  await fsp.rm(source, { recursive: true, force: true });
}

async function replaceWithSymlink(target, linkPath) {
  let backupPath = null;
  if (await pathExists(linkPath)) {
    const stat = await fsp.lstat(linkPath);
    if (stat.isSymbolicLink()) {
      await fsp.rm(linkPath, { force: true });
    } else {
      backupPath = `${linkPath}.legacy-${Date.now()}-${process.pid}`;
      await fsp.rename(linkPath, backupPath);
    }
  }
  try {
    await atomicSymlink(target, linkPath);
  } catch (error) {
    if (backupPath) {
      await fsp.rename(backupPath, linkPath).catch(() => undefined);
    }
    throw error;
  }
  return backupPath;
}

async function installStableFiles(paths, releaseRoot) {
  const scriptDir = path.join(releaseRoot, "scripts");
  await copyExecutable(path.join(scriptDir, "fased-managed-launcher.sh"), paths.launcherPath);
  await copyExecutable(path.join(scriptDir, "fased-managed-service.sh"), paths.serviceLauncherPath);
  await copyExecutable(path.join(scriptDir, "fased-managed-updater.mjs"), paths.updaterPath);
  await copyExecutable(
    path.join(scriptDir, "managed-runtime-layout.mjs"),
    path.join(paths.updaterDir, "managed-runtime-layout.mjs"),
  );
  await fsp.mkdir(path.dirname(paths.prefixLauncherPath), { recursive: true });
  const launcherBackup = await replaceWithSymlink(paths.launcherPath, paths.prefixLauncherPath);
  if (launcherBackup) {
    await fsp.rm(launcherBackup, { recursive: true, force: true });
  }
}

export async function installManagedRuntime(params) {
  const paths = resolveManagedRuntimePaths(params);
  const existingManifest = readManagedInstallManifest(paths.manifestPath);
  const version = await assertManagedRuntime(params.packageRoot);
  const metadata = await readHostedRuntimeMetadata(params.packageRoot);
  let previousRoot = await resolveLinkTarget(paths.currentLink);
  let previousVersion = previousRoot ? await readPackageVersion(previousRoot) : null;
  let releaseRoot = path.join(paths.releasesDir, version);

  await fsp.mkdir(paths.releasesDir, { recursive: true });
  await fsp.mkdir(paths.stagingDir, { recursive: true });

  const packageReal = await fsp.realpath(params.packageRoot).catch(() => params.packageRoot);
  const releaseReal = await fsp.realpath(releaseRoot).catch(() => releaseRoot);
  if (packageReal === releaseReal && existingManifest?.runtime?.activeVersion === version) {
    previousVersion = existingManifest.runtime.previousVersion || null;
  }
  if (packageReal !== releaseReal) {
    if (await pathExists(releaseRoot)) {
      if (previousVersion === version) {
        releaseRoot = path.join(
          paths.releasesDir,
          `${version}.repair-${Date.now()}-${process.pid}`,
        );
      } else {
        await fsp.rm(releaseRoot, { recursive: true, force: true });
      }
    }
    await moveDirectory(params.packageRoot, releaseRoot);
  }
  await assertManagedRuntime(releaseRoot, version);

  if (
    !previousRoot &&
    params.previousPackageRoot &&
    (await pathExists(params.previousPackageRoot))
  ) {
    const legacyVersion = await readPackageVersion(params.previousPackageRoot);
    if (legacyVersion && legacyVersion !== version) {
      const legacyReleaseRoot = path.join(paths.releasesDir, legacyVersion);
      if (await pathExists(legacyReleaseRoot)) {
        await fsp.rm(params.previousPackageRoot, { recursive: true, force: true });
      } else {
        await moveDirectory(params.previousPackageRoot, legacyReleaseRoot);
      }
      previousRoot = legacyReleaseRoot;
      previousVersion = legacyVersion;
    }
  }

  if (previousRoot && path.resolve(previousRoot) !== path.resolve(releaseRoot)) {
    await atomicSymlink(previousRoot, paths.previousLink);
  }
  await atomicSymlink(releaseRoot, paths.currentLink);

  const compatibilityBackup = await replaceWithSymlink(
    paths.currentLink,
    paths.compatibilityPackageRoot,
  );
  await installStableFiles(paths, releaseRoot);

  const manifest = buildManagedInstallManifest({
    paths,
    profile: params.profile,
    version,
    dependencyHash: metadata?.dependencyHash,
    previousVersion: previousVersion || null,
  });
  await atomicWriteJson(paths.manifestPath, manifest, 0o600);
  await fsp.chmod(paths.stateDir, 0o700).catch(() => undefined);
  if (compatibilityBackup) {
    await fsp.rm(compatibilityBackup, { recursive: true, force: true });
  }
  return { manifest, paths, releaseRoot };
}

export async function rollbackManagedRuntime(params) {
  const paths = resolveManagedRuntimePaths(params);
  const manifest = readManagedInstallManifest(paths.manifestPath);
  if (!manifest) {
    throw new Error("Managed installation manifest is unavailable for rollback.");
  }
  const currentRoot = await resolveLinkTarget(paths.currentLink);
  const previousRoot = await resolveLinkTarget(paths.previousLink);
  if (!previousRoot || !currentRoot || path.resolve(previousRoot) === path.resolve(currentRoot)) {
    throw new Error("No previous managed runtime is available for rollback.");
  }
  const previousVersion = await assertManagedRuntime(previousRoot);
  const currentVersion = await readPackageVersion(currentRoot);
  const metadata = await readHostedRuntimeMetadata(previousRoot);

  await atomicSymlink(currentRoot, paths.previousLink);
  await atomicSymlink(previousRoot, paths.currentLink);
  await replaceWithSymlink(paths.currentLink, paths.compatibilityPackageRoot);
  await installStableFiles(paths, previousRoot);
  const previousManifest = buildManagedInstallManifest({
    paths,
    profile: manifest.profile,
    version: previousVersion,
    dependencyHash: metadata?.dependencyHash,
    previousVersion: currentVersion,
  });
  await atomicWriteJson(paths.manifestPath, previousManifest, 0o600);
  return { manifest: previousManifest, paths, releaseRoot: previousRoot };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.rollback
      ? await rollbackManagedRuntime(options)
      : await installManagedRuntime(options);
    process.stdout.write(
      `${options.rollback ? "Rolled back to" : "Installed stable Fased updater and activated"} managed runtime v${result.manifest.runtime.activeVersion}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export const __testing = {
  installStableFiles,
  moveDirectory,
  replaceWithSymlink,
};
