import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MANAGED_INSTALL_SCHEMA_VERSION = 1;

export function resolveManagedStateDir(env = process.env, homedir = os.homedir) {
  return path.resolve(
    env.FASED_STATE_DIR || env.FASED_CONFIG_DIR || path.join(homedir(), ".fased"),
  );
}

export function resolveManagedRuntimePaths({ stateDir, prefix } = {}) {
  const resolvedStateDir = path.resolve(stateDir || resolveManagedStateDir());
  const resolvedPrefix = path.resolve(
    prefix || path.join(resolvedStateDir, "install-cache", "npm-global"),
  );
  const runtimeDir = path.join(resolvedStateDir, "runtime");
  const binDir = path.join(resolvedStateDir, "bin");
  const updaterDir = path.join(resolvedStateDir, "updater");
  return {
    stateDir: resolvedStateDir,
    manifestPath: path.join(resolvedStateDir, "install.json"),
    runtimeDir,
    releasesDir: path.join(runtimeDir, "releases"),
    currentLink: path.join(runtimeDir, "current"),
    previousLink: path.join(runtimeDir, "previous"),
    stagingDir: path.join(runtimeDir, ".staging"),
    binDir,
    launcherPath: path.join(binDir, "fased"),
    serviceLauncherPath: path.join(binDir, "fased-service"),
    updaterDir,
    updaterPath: path.join(updaterDir, "fased-managed-updater.mjs"),
    prefix: resolvedPrefix,
    compatibilityPackageRoot: path.join(resolvedPrefix, "lib", "node_modules", "@fased", "fased"),
    prefixLauncherPath: path.join(resolvedPrefix, "bin", "fased"),
  };
}

export function normalizeManagedProfile(value) {
  const profile = String(value || "")
    .trim()
    .toLowerCase();
  if (profile === "hosting" || profile === "local" || profile === "source") {
    return profile;
  }
  return "local";
}

export function readManagedInstallManifest(manifestPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (parsed?.schemaVersion !== MANAGED_INSTALL_SCHEMA_VERSION) {
      return null;
    }
    if (!parsed.runtime || typeof parsed.runtime.activeVersion !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readPackageVersion(packageRoot) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(packageRoot, "package.json"), "utf8"));
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

export async function readHostedRuntimeMetadata(packageRoot) {
  try {
    const parsed = JSON.parse(
      await fsp.readFile(path.join(packageRoot, ".fased-hosted-runtime.json"), "utf8"),
    );
    if (parsed?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(parsed.dependencyHash || "")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function assertManagedRuntime(packageRoot, expectedVersion) {
  const version = await readPackageVersion(packageRoot);
  if (!version || (expectedVersion && version !== expectedVersion)) {
    throw new Error(
      `Managed runtime version mismatch: expected ${expectedVersion || "a package version"}, found ${version || "unknown"}.`,
    );
  }
  for (const required of [
    "fased.mjs",
    "node_modules",
    "scripts/start-managed.sh",
    "dist/control-ui/version.json",
  ]) {
    await fsp.access(path.join(packageRoot, required));
  }
  const ui = JSON.parse(
    await fsp.readFile(path.join(packageRoot, "dist", "control-ui", "version.json"), "utf8"),
  );
  if (ui?.version !== version) {
    throw new Error(
      `Managed dashboard version ${ui?.version || "unknown"} does not match runtime ${version}.`,
    );
  }
  return version;
}

export async function atomicWriteFile(targetPath, content, mode = 0o600) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temporaryPath, content, { mode });
  await fsp.chmod(temporaryPath, mode);
  await fsp.rename(temporaryPath, targetPath);
}

export async function atomicWriteJson(targetPath, value, mode = 0o600) {
  await atomicWriteFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function atomicSymlink(target, linkPath) {
  await fsp.mkdir(path.dirname(linkPath), { recursive: true });
  const temporaryPath = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.rm(temporaryPath, { force: true, recursive: true });
  await fsp.symlink(target, temporaryPath, "dir");
  await fsp.rename(temporaryPath, linkPath);
}

export async function copyExecutable(source, destination) {
  const content = await fsp.readFile(source);
  await atomicWriteFile(destination, content, 0o755);
}

export async function resolveLinkTarget(linkPath) {
  try {
    return await fsp.realpath(linkPath);
  } catch {
    return null;
  }
}

export function buildManagedInstallManifest({
  paths,
  profile,
  version,
  dependencyHash,
  previousVersion,
  source = "managed-artifact",
}) {
  const normalizedProfile = normalizeManagedProfile(profile);
  return {
    schemaVersion: MANAGED_INSTALL_SCHEMA_VERSION,
    profile: normalizedProfile,
    source,
    stateDir: paths.stateDir,
    configPath: path.join(paths.stateDir, "fased.json"),
    runtime: {
      activeVersion: version,
      previousVersion: previousVersion || null,
      currentLink: paths.currentLink,
      previousLink: paths.previousLink,
      releasesDir: paths.releasesDir,
      dependencyHash: dependencyHash || null,
    },
    package: {
      prefix: paths.prefix,
      compatibilityRoot: paths.compatibilityPackageRoot,
    },
    service: {
      name: "fased-gateway.service",
      scope: normalizedProfile === "hosting" ? "system" : "user",
      launcher: paths.serviceLauncherPath,
    },
    updater: {
      version,
      path: paths.updaterPath,
    },
    updatedAt: new Date().toISOString(),
  };
}
