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
import {
  MANAGED_UPDATER_COMPATIBILITY_FILES,
  installManagedUpdaterCompatibilityFiles,
  stageManagedUpdaterGeneration,
} from "./managed-updater-bundle.mjs";

function assertPortableProfile(value) {
  const profile = normalizeManagedProfile(value);
  if (profile !== "local" && profile !== "source") {
    throw new Error(
      "Protected Local and Hosting must use the verified Go lifecycle engine; the portable runtime installer cannot mutate them.",
    );
  }
  return profile;
}

function parseArgs(argv) {
  const rollback = argv[0] === "--rollback";
  const values = new Map();
  const tokens = rollback ? argv.slice(1) : argv;
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid portable runtime installer argument: ${key || ""}`);
    }
    values.set(key, value);
  }
  const packageRoot = values.get("--package-root");
  const stateDir = values.get("--state-dir");
  const prefix = values.get("--prefix");
  if (!stateDir || !prefix || (!rollback && !packageRoot)) {
    throw new Error("--package-root, --state-dir, and --prefix are required");
  }
  if (values.has("--host-transaction-id") || values.has("--host-transaction-version")) {
    throw new Error("Root transaction selectors are forbidden in the portable runtime installer.");
  }
  return {
    rollback,
    packageRoot: packageRoot ? path.resolve(packageRoot) : null,
    previousPackageRoot: values.get("--previous-package-root")
      ? path.resolve(values.get("--previous-package-root"))
      : null,
    stateDir: path.resolve(stateDir),
    prefix: path.resolve(prefix),
    profile: assertPortableProfile(values.get("--profile")),
    updateChannel: values.get("--update-channel")?.trim() || null,
  };
}

async function pathExists(target) {
  return fsp
    .lstat(target)
    .then(() => true)
    .catch(() => false);
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
  let backup = null;
  if (await pathExists(linkPath)) {
    const stat = await fsp.lstat(linkPath);
    if (stat.isSymbolicLink()) {
      await fsp.rm(linkPath, { force: true });
    } else {
      backup = `${linkPath}.legacy-${Date.now()}-${process.pid}`;
      await fsp.rename(linkPath, backup);
    }
  }
  try {
    await atomicSymlink(target, linkPath);
  } catch (error) {
    if (backup) {
      await fsp.rename(backup, linkPath).catch(() => undefined);
    }
    throw error;
  }
  return backup;
}

async function installStableFiles(paths, releaseRoot) {
  const scriptDir = path.join(releaseRoot, "scripts");
  await copyExecutable(path.join(scriptDir, "fased-managed-launcher.sh"), paths.launcherPath);
  await copyExecutable(path.join(scriptDir, "fased-managed-service.sh"), paths.serviceLauncherPath);
  const bundleManifest = path.join(scriptDir, "managed-updater-bundle.v1.json");
  if (await pathExists(bundleManifest)) {
    const generation = await stageManagedUpdaterGeneration({
      updaterDir: paths.updaterDir,
      runtimeRoot: releaseRoot,
      durable: false,
    });
    await installManagedUpdaterCompatibilityFiles({
      updaterDir: paths.updaterDir,
      generation,
      copyExecutable,
      durable: false,
    });
  } else {
    for (const name of MANAGED_UPDATER_COMPATIBILITY_FILES) {
      await copyExecutable(path.join(scriptDir, name), path.join(paths.updaterDir, name));
    }
    await copyExecutable(path.join(scriptDir, "fased-managed-updater.mjs"), paths.updaterPath);
  }
  await fsp.mkdir(path.dirname(paths.prefixLauncherPath), { recursive: true });
  const backup = await replaceWithSymlink(paths.launcherPath, paths.prefixLauncherPath);
  if (backup) {
    await fsp.rm(backup, { recursive: true, force: true });
  }
}

export async function installManagedRuntime(params) {
  const profile = assertPortableProfile(params.profile);
  if (params.hostTransactionId || params.hostTransactionVersion) {
    throw new Error("Root transaction selectors are forbidden in the portable runtime installer.");
  }
  const paths = resolveManagedRuntimePaths(params);
  const existing = readManagedInstallManifest(paths.manifestPath);
  const version = await assertManagedRuntime(params.packageRoot);
  const metadata = await readHostedRuntimeMetadata(params.packageRoot);
  let previousRoot = await resolveLinkTarget(paths.currentLink);
  let previousVersion = previousRoot ? await readPackageVersion(previousRoot) : null;
  let releaseRoot = path.join(paths.releasesDir, version);

  await fsp.mkdir(paths.releasesDir, { recursive: true });
  await fsp.mkdir(paths.stagingDir, { recursive: true });
  const packageReal = await fsp.realpath(params.packageRoot).catch(() => params.packageRoot);
  const releaseReal = await fsp.realpath(releaseRoot).catch(() => releaseRoot);
  if (packageReal === releaseReal && existing?.runtime?.activeVersion === version) {
    previousVersion = existing.runtime.previousVersion || null;
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
      const legacyRoot = path.join(paths.releasesDir, legacyVersion);
      if (!(await pathExists(legacyRoot))) {
        await moveDirectory(params.previousPackageRoot, legacyRoot);
      }
      previousRoot = legacyRoot;
      previousVersion = legacyVersion;
    }
  }
  if (previousRoot && path.resolve(previousRoot) !== path.resolve(releaseRoot)) {
    await atomicSymlink(previousRoot, paths.previousLink);
  }

  const manifest = buildManagedInstallManifest({
    paths,
    profile,
    version,
    dependencyHash: metadata?.dependencyHash,
    previousVersion: previousVersion || null,
    service: existing?.service,
    updateChannel: params.updateChannel || existing?.update?.channel,
  });
  await atomicSymlink(releaseRoot, paths.currentLink);
  const compatibilityBackup = await replaceWithSymlink(
    paths.currentLink,
    paths.compatibilityPackageRoot,
  );
  await installStableFiles(paths, releaseRoot);
  await atomicWriteJson(paths.manifestPath, manifest, 0o600);
  await fsp.chmod(paths.stateDir, 0o700);
  if (compatibilityBackup) {
    await fsp.rm(compatibilityBackup, { recursive: true, force: true });
  }
  return { manifest, paths, releaseRoot };
}

export async function rollbackManagedRuntime(params) {
  const paths = resolveManagedRuntimePaths(params);
  const manifest = readManagedInstallManifest(paths.manifestPath);
  if (!manifest) {
    throw new Error("Portable installation manifest is unavailable for rollback.");
  }
  assertPortableProfile(manifest.profile);
  const currentRoot = await resolveLinkTarget(paths.currentLink);
  const previousRoot = await resolveLinkTarget(paths.previousLink);
  if (!previousRoot || !currentRoot || path.resolve(previousRoot) === path.resolve(currentRoot)) {
    throw new Error("No previous portable runtime is available for rollback.");
  }
  const previousVersion = await assertManagedRuntime(previousRoot);
  const currentVersion = await readPackageVersion(currentRoot);
  const metadata = await readHostedRuntimeMetadata(previousRoot);
  await atomicSymlink(currentRoot, paths.previousLink);
  await atomicSymlink(previousRoot, paths.currentLink);
  await replaceWithSymlink(paths.currentLink, paths.compatibilityPackageRoot);
  await atomicWriteJson(
    paths.manifestPath,
    buildManagedInstallManifest({
      paths,
      profile: manifest.profile,
      version: previousVersion,
      dependencyHash: metadata?.dependencyHash,
      previousVersion: currentVersion,
      service: manifest.service,
      updateChannel: manifest.update?.channel,
    }),
    0o600,
  );
  return { paths, releaseRoot: previousRoot };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.rollback
      ? await rollbackManagedRuntime(options)
      : await installManagedRuntime(options);
    process.stdout.write(
      `${options.rollback ? "Rolled back" : "Activated"} portable runtime v${result.manifest?.runtime?.activeVersion || "previous"}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export const __testing = {
  assertPortableProfile,
  parseArgs,
  installStableFiles,
  moveDirectory,
  replaceWithSymlink,
};
