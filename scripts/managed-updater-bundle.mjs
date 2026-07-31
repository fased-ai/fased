import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const MANAGED_UPDATER_BUNDLE_SCHEMA_VERSION = 1;
export const MANAGED_UPDATER_BUNDLE_MANIFEST = "managed-updater-bundle.v1.json";
export const MANAGED_UPDATER_COMPATIBILITY_FILES = Object.freeze([
  "hosted-release-manifest.mjs",
  "managed-runtime-layout.mjs",
]);

const SAFE_BUNDLE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function canonicalJSON(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJSON(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  const named = await fsp.lstat(filePath);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) {
    throw new Error(`managed updater source is unsafe: ${filePath}`);
  }
  const handle = await fsp.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== named.dev || stat.ino !== named.ino) {
      throw new Error(`managed updater source is unsafe: ${filePath}`);
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      );
      if (bytesRead <= 0) {
        throw new Error(`managed updater source changed during hashing: ${filePath}`);
      }
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const rebound = await handle.stat();
    if (
      rebound.dev !== stat.dev ||
      rebound.ino !== stat.ino ||
      rebound.size !== stat.size ||
      rebound.mtimeMs !== stat.mtimeMs
    ) {
      throw new Error(`managed updater source changed during hashing: ${filePath}`);
    }
    return { sha256: digest.digest("hex"), size: stat.size };
  } finally {
    await handle.close();
  }
}

async function fsyncPath(targetPath) {
  const handle = await fsp.open(targetPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicSymlink(target, linkPath) {
  await fsp.mkdir(path.dirname(linkPath), { recursive: true });
  const temporaryPath = `${linkPath}.tmp-${process.pid}-${randomUUID()}`;
  await fsp.rm(temporaryPath, { force: true });
  await fsp.symlink(target, temporaryPath, "dir");
  await fsp.rename(temporaryPath, linkPath);
  await fsyncPath(path.dirname(linkPath));
}

function parseBundleManifest(value, manifestPath) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "entrypoint,files,schemaVersion" ||
    value.schemaVersion !== MANAGED_UPDATER_BUNDLE_SCHEMA_VERSION ||
    !SAFE_BUNDLE_FILE.test(value.entrypoint || "") ||
    !Array.isArray(value.files) ||
    value.files.length < 3 ||
    value.files.length > 64 ||
    value.files.some((file) => typeof file !== "string" || !SAFE_BUNDLE_FILE.test(file)) ||
    new Set(value.files).size !== value.files.length ||
    !value.files.includes(value.entrypoint)
  ) {
    throw new Error(`managed updater bundle manifest is invalid: ${manifestPath}`);
  }
  return Object.freeze({
    schemaVersion: MANAGED_UPDATER_BUNDLE_SCHEMA_VERSION,
    entrypoint: value.entrypoint,
    files: Object.freeze([...value.files]),
  });
}

export async function readManagedUpdaterBundleManifest(runtimeRoot) {
  const scriptsDir = path.join(path.resolve(runtimeRoot), "scripts");
  const manifestPath = path.join(scriptsDir, MANAGED_UPDATER_BUNDLE_MANIFEST);
  const named = await fsp.lstat(manifestPath);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) {
    throw new Error(`managed updater bundle manifest is unsafe: ${manifestPath}`);
  }
  const value = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  return {
    scriptsDir,
    manifestPath,
    manifest: parseBundleManifest(value, manifestPath),
  };
}

export async function stageManagedUpdaterGeneration({ updaterDir, runtimeRoot, durable = false }) {
  const resolvedUpdaterDir = path.resolve(updaterDir);
  const { scriptsDir, manifest } = await readManagedUpdaterBundleManifest(runtimeRoot);
  const records = [];
  for (const name of manifest.files) {
    const sourcePath = path.join(scriptsDir, name);
    const identity = await sha256File(sourcePath);
    records.push(Object.freeze({ name, ...identity }));
  }
  const bundleDigest = createHash("sha256")
    .update(
      canonicalJSON({
        schemaVersion: manifest.schemaVersion,
        entrypoint: manifest.entrypoint,
        files: records,
      }),
    )
    .digest("hex");
  if (!SHA256_PATTERN.test(bundleDigest)) {
    throw new Error("managed updater bundle digest is invalid");
  }

  const generationsDir = path.join(resolvedUpdaterDir, "generations");
  const generationDir = path.join(generationsDir, bundleDigest);
  const stagingDir = path.join(
    resolvedUpdaterDir,
    `.generation-${bundleDigest}-${process.pid}-${randomUUID()}`,
  );
  await fsp.mkdir(generationsDir, { recursive: true });
  const existing = await fsp.lstat(generationDir).catch(() => null);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`managed updater generation is unsafe: ${generationDir}`);
    }
  } else {
    await fsp.mkdir(stagingDir, { recursive: false, mode: 0o755 });
    try {
      for (const record of records) {
        const sourcePath = path.join(scriptsDir, record.name);
        const destinationPath = path.join(stagingDir, record.name);
        await fsp.copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
        await fsp.chmod(destinationPath, 0o755);
        const copied = await sha256File(destinationPath);
        if (copied.sha256 !== record.sha256 || copied.size !== record.size) {
          throw new Error(`managed updater generation copy mismatch: ${record.name}`);
        }
        if (durable) {
          await fsyncPath(destinationPath);
        }
      }
      const receipt = {
        schemaVersion: MANAGED_UPDATER_BUNDLE_SCHEMA_VERSION,
        bundleDigest: `sha256:${bundleDigest}`,
        entrypoint: manifest.entrypoint,
        files: records,
      };
      const receiptPath = path.join(stagingDir, MANAGED_UPDATER_BUNDLE_MANIFEST);
      await fsp.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
        mode: 0o644,
        flag: "wx",
      });
      if (durable) {
        await fsyncPath(receiptPath);
        await fsyncPath(stagingDir);
      }
      await fsp.rename(stagingDir, generationDir);
      if (durable) {
        await fsyncPath(generationsDir);
      }
    } catch (error) {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  const currentLink = path.join(resolvedUpdaterDir, "current");
  await atomicSymlink(path.relative(resolvedUpdaterDir, generationDir), currentLink);
  return Object.freeze({
    bundleDigest: `sha256:${bundleDigest}`,
    generationDir,
    currentLink,
    entrypointPath: path.join(generationDir, manifest.entrypoint),
    files: Object.freeze(records),
  });
}

export async function installManagedUpdaterCompatibilityFiles({
  updaterDir,
  generation,
  copyExecutable,
  durable = false,
}) {
  for (const name of MANAGED_UPDATER_COMPATIBILITY_FILES) {
    await copyExecutable(path.join(generation.generationDir, name), path.join(updaterDir, name));
  }
  const updaterPath = path.join(updaterDir, "fased-managed-updater.mjs");
  await copyExecutable(generation.entrypointPath, updaterPath);
  if (durable) {
    for (const targetPath of [
      ...MANAGED_UPDATER_COMPATIBILITY_FILES.map((name) => path.join(updaterDir, name)),
      updaterPath,
    ]) {
      await fsyncPath(targetPath);
    }
    await fsyncPath(updaterDir);
  }
  return updaterPath;
}
