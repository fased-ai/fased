import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MANAGED_UPDATER_BUNDLE_SCHEMA_VERSION = 2;
export const MANAGED_UPDATER_BUNDLE_MANIFEST = "managed-updater-bundle.v1.json";
export const MANAGED_UPDATER_GENERATION_RECEIPT = "managed-updater-generation.v1.json";
export const MANAGED_UPDATER_RELEASE_DESCRIPTOR = ".fased-managed-updater-bundle.json";
export const MANAGED_UPDATER_COMPATIBILITY_FILES = Object.freeze([
  "hosted-release-manifest.mjs",
  "managed-runtime-layout.mjs",
]);

const SAFE_BUNDLE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const ARCHITECTURES = new Set(["x64", "arm64"]);
const BUNDLE_FILE_TYPES = new Set(["entrypoint", "support", "launcher", "manifest"]);
const BUNDLE_FILE_MODES = new Map([
  ["0644", 0o644],
  ["0755", 0o755],
]);

function isSafeReleaseDescriptorMode(mode) {
  const permissions = mode & 0o7777;
  return (permissions & 0o400) !== 0 && (permissions & 0o7133) === 0;
}

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
    return { sha256: digest.digest("hex"), size: stat.size, mode: stat.mode & 0o777 };
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
    Object.keys(value).toSorted().join(",") !==
      "entrypoint,files,minimumSupervisorProtocol,schemaVersion" ||
    value.schemaVersion !== MANAGED_UPDATER_BUNDLE_SCHEMA_VERSION ||
    !SAFE_BUNDLE_FILE.test(value.entrypoint || "") ||
    !Number.isSafeInteger(value.minimumSupervisorProtocol) ||
    value.minimumSupervisorProtocol < 1 ||
    value.minimumSupervisorProtocol > 64 ||
    !Array.isArray(value.files) ||
    value.files.length < 5 ||
    value.files.length > 64 ||
    value.files.some(
      (file) =>
        !file ||
        typeof file !== "object" ||
        Array.isArray(file) ||
        Object.keys(file).toSorted().join(",") !== "mode,name,type" ||
        !SAFE_BUNDLE_FILE.test(file.name || "") ||
        !BUNDLE_FILE_TYPES.has(file.type) ||
        !BUNDLE_FILE_MODES.has(file.mode),
    ) ||
    new Set(value.files.map((file) => file.name)).size !== value.files.length ||
    !value.files.some((file) => file.name === value.entrypoint && file.type === "entrypoint") ||
    !value.files.some(
      (file) => file.name === MANAGED_UPDATER_BUNDLE_MANIFEST && file.type === "manifest",
    ) ||
    !value.files.some(
      (file) => file.name === "managed-updater-bundle.mjs" && file.type === "support",
    )
  ) {
    throw new Error(`managed updater bundle manifest is invalid: ${manifestPath}`);
  }
  return Object.freeze({
    schemaVersion: MANAGED_UPDATER_BUNDLE_SCHEMA_VERSION,
    entrypoint: value.entrypoint,
    minimumSupervisorProtocol: value.minimumSupervisorProtocol,
    files: Object.freeze(
      value.files.map((file) =>
        Object.freeze({
          name: file.name,
          type: file.type,
          mode: BUNDLE_FILE_MODES.get(file.mode),
          modeText: file.mode,
        }),
      ),
    ),
  });
}

async function readReleaseIdentity(runtimeRoot) {
  const metadataPath = path.join(path.resolve(runtimeRoot), ".fased-hosted-runtime.json");
  const metadataStat = await fsp.lstat(metadataPath).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (metadataStat) {
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.nlink !== 1) {
      throw new Error(`managed updater release identity is unsafe: ${metadataPath}`);
    }
    const value = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
    if (value?.schemaVersion === 1 && SHA256_PATTERN.test(value.dependencyHash || "")) {
      const packagePath = path.join(path.resolve(runtimeRoot), "package.json");
      const packageValue = JSON.parse(await fsp.readFile(packagePath, "utf8"));
      if (!RELEASE_VERSION_PATTERN.test(packageValue?.version || "")) {
        throw new Error(`managed updater development identity is invalid: ${packagePath}`);
      }
      const descriptorPath = path.join(
        path.resolve(runtimeRoot),
        MANAGED_UPDATER_RELEASE_DESCRIPTOR,
      );
      const descriptorStat = await fsp.lstat(descriptorPath).catch((error) => {
        if (error?.code === "ENOENT") {
          return null;
        }
        throw error;
      });
      if (descriptorStat) {
        if (
          !descriptorStat.isFile() ||
          descriptorStat.isSymbolicLink() ||
          descriptorStat.nlink !== 1 ||
          !isSafeReleaseDescriptorMode(descriptorStat.mode)
        ) {
          throw new Error(`managed updater release descriptor is unsafe: ${descriptorPath}`);
        }
        const descriptor = parseReleaseDescriptor(
          JSON.parse(await fsp.readFile(descriptorPath, "utf8")),
          descriptorPath,
        );
        if (
          descriptor.release.version !== packageValue.version ||
          descriptor.release.dependencyHash !== `sha256:${value.dependencyHash}` ||
          descriptor.release.development !== false
        ) {
          throw new Error(`managed updater release descriptor is mismatched: ${descriptorPath}`);
        }
        return descriptor.release;
      }
      return Object.freeze({
        version: packageValue.version,
        commit: null,
        dependencyHash: `sha256:${value.dependencyHash}`,
        development: true,
      });
    }
    if (
      value?.schemaVersion !== 2 ||
      !RELEASE_VERSION_PATTERN.test(value.version || "") ||
      !COMMIT_PATTERN.test(value.commit || "") ||
      !SHA256_PATTERN.test(value.dependencyHash || "")
    ) {
      throw new Error(`managed updater release identity is invalid: ${metadataPath}`);
    }
    return Object.freeze({
      version: value.version,
      commit: value.commit,
      dependencyHash: `sha256:${value.dependencyHash}`,
      development: false,
    });
  }
  const packagePath = path.join(path.resolve(runtimeRoot), "package.json");
  const packageValue = JSON.parse(await fsp.readFile(packagePath, "utf8"));
  if (!RELEASE_VERSION_PATTERN.test(packageValue?.version || "")) {
    throw new Error(`managed updater development identity is invalid: ${packagePath}`);
  }
  return Object.freeze({
    version: packageValue.version,
    commit: null,
    dependencyHash: null,
    development: true,
  });
}

async function buildManagedUpdaterFileRecords(scriptsDir, manifest) {
  const records = [];
  for (const file of manifest.files) {
    const sourcePath = path.join(scriptsDir, file.name);
    const identity = await sha256File(sourcePath);
    records.push(
      Object.freeze({
        name: file.name,
        type: file.type,
        mode: file.mode,
        size: identity.size,
        sha256: identity.sha256,
      }),
    );
  }
  return Object.freeze(records);
}

function updaterBundleDigest(manifest, releaseIdentity, records) {
  return createHash("sha256")
    .update(
      canonicalJSON({
        schemaVersion: manifest.schemaVersion,
        entrypoint: manifest.entrypoint,
        minimumSupervisorProtocol: manifest.minimumSupervisorProtocol,
        release: releaseIdentity,
        files: records,
      }),
    )
    .digest("hex");
}

function parseReleaseDescriptor(value, descriptorPath) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !==
      "architecture,bundleDigest,entrypoint,files,minimumSupervisorProtocol,release,schemaVersion" ||
    value.schemaVersion !== MANAGED_UPDATER_BUNDLE_SCHEMA_VERSION ||
    !ARCHITECTURES.has(value.architecture) ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.bundleDigest || "") ||
    !SAFE_BUNDLE_FILE.test(value.entrypoint || "") ||
    !Number.isSafeInteger(value.minimumSupervisorProtocol) ||
    value.minimumSupervisorProtocol < 1 ||
    value.minimumSupervisorProtocol > 64 ||
    !Array.isArray(value.files) ||
    value.files.length < 5 ||
    value.files.length > 64 ||
    value.files.some(
      (file) =>
        !file ||
        typeof file !== "object" ||
        Array.isArray(file) ||
        Object.keys(file).toSorted().join(",") !== "mode,name,sha256,size,type" ||
        !SAFE_BUNDLE_FILE.test(file.name || "") ||
        !BUNDLE_FILE_TYPES.has(file.type) ||
        !new Set(BUNDLE_FILE_MODES.values()).has(file.mode) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !SHA256_PATTERN.test(file.sha256 || ""),
    ) ||
    new Set(value.files.map((file) => file.name)).size !== value.files.length
  ) {
    throw new Error(`managed updater release descriptor is invalid: ${descriptorPath}`);
  }
  return Object.freeze({
    ...value,
    release: Object.freeze({ ...value.release }),
    files: Object.freeze(value.files.map((file) => Object.freeze({ ...file }))),
  });
}

export async function buildManagedUpdaterReleaseDescriptor({ runtimeRoot, architecture }) {
  if (!ARCHITECTURES.has(architecture)) {
    throw new Error(`managed updater release architecture is unsupported: ${architecture}`);
  }
  const { scriptsDir, manifest } = await readManagedUpdaterBundleManifest(runtimeRoot);
  const releaseIdentity = await readReleaseIdentity(runtimeRoot);
  if (releaseIdentity.development || !releaseIdentity.commit) {
    throw new Error("managed updater release descriptor requires an exact production identity");
  }
  const records = await buildManagedUpdaterFileRecords(scriptsDir, manifest);
  const bundleDigest = updaterBundleDigest(manifest, releaseIdentity, records);
  return Object.freeze({
    schemaVersion: MANAGED_UPDATER_BUNDLE_SCHEMA_VERSION,
    architecture,
    bundleDigest: `sha256:${bundleDigest}`,
    entrypoint: manifest.entrypoint,
    minimumSupervisorProtocol: manifest.minimumSupervisorProtocol,
    release: releaseIdentity,
    files: records,
  });
}

export async function writeManagedUpdaterReleaseDescriptor({
  runtimeRoot,
  architecture,
  outputPath = path.join(path.resolve(runtimeRoot), MANAGED_UPDATER_RELEASE_DESCRIPTOR),
}) {
  const descriptor = await buildManagedUpdaterReleaseDescriptor({
    runtimeRoot,
    architecture,
  });
  await fsp.writeFile(outputPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
    mode: 0o644,
  });
  return descriptor;
}

async function verifyManagedUpdaterReleaseDescriptor(runtimeRoot, expected) {
  const descriptorPath = path.join(path.resolve(runtimeRoot), MANAGED_UPDATER_RELEASE_DESCRIPTOR);
  const named = await fsp.lstat(descriptorPath);
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1 ||
    !isSafeReleaseDescriptorMode(named.mode)
  ) {
    throw new Error(`managed updater release descriptor is unsafe: ${descriptorPath}`);
  }
  const descriptor = parseReleaseDescriptor(
    JSON.parse(await fsp.readFile(descriptorPath, "utf8")),
    descriptorPath,
  );
  if (
    descriptor.architecture !== process.arch ||
    canonicalJSON({
      schemaVersion: descriptor.schemaVersion,
      bundleDigest: descriptor.bundleDigest,
      entrypoint: descriptor.entrypoint,
      minimumSupervisorProtocol: descriptor.minimumSupervisorProtocol,
      release: descriptor.release,
      files: descriptor.files,
    }) !==
      canonicalJSON({
        schemaVersion: MANAGED_UPDATER_BUNDLE_SCHEMA_VERSION,
        bundleDigest: `sha256:${expected.bundleDigest}`,
        entrypoint: expected.manifest.entrypoint,
        minimumSupervisorProtocol: expected.manifest.minimumSupervisorProtocol,
        release: expected.releaseIdentity,
        files: expected.records,
      })
  ) {
    throw new Error(`managed updater release descriptor is mismatched: ${descriptorPath}`);
  }
  return descriptor;
}

async function readLinkTarget(linkPath) {
  const stat = await fsp.lstat(linkPath).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!stat) {
    return null;
  }
  if (!stat.isSymbolicLink()) {
    throw new Error(`managed updater generation pointer is not a symlink: ${linkPath}`);
  }
  return await fsp.realpath(linkPath);
}

async function validateManagedUpdaterGeneration({
  generationDir,
  manifest,
  records,
  bundleDigest,
  releaseIdentity,
  normalizeModes = false,
  durable = false,
}) {
  const stat = await fsp.lstat(generationDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`managed updater generation is unsafe: ${generationDir}`);
  }
  const expectedNames = new Set([
    ...records.map((record) => record.name),
    MANAGED_UPDATER_GENERATION_RECEIPT,
  ]);
  const actualNames = await fsp.readdir(generationDir);
  if (
    actualNames.length !== expectedNames.size ||
    actualNames.some((name) => !expectedNames.has(name))
  ) {
    throw new Error(`managed updater generation inventory is invalid: ${generationDir}`);
  }
  const modeRepairs = [];
  for (const record of records) {
    const targetPath = path.join(generationDir, record.name);
    const identity = await sha256File(targetPath);
    if (identity.sha256 !== record.sha256 || identity.size !== record.size) {
      throw new Error(`managed updater generation identity is invalid: ${record.name}`);
    }
    if (identity.mode !== record.mode) {
      if (!normalizeModes) {
        throw new Error(`managed updater generation identity is invalid: ${record.name}`);
      }
      modeRepairs.push({ targetPath, mode: record.mode });
    }
  }
  const receiptPath = path.join(generationDir, MANAGED_UPDATER_GENERATION_RECEIPT);
  const receiptStat = await fsp.lstat(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.nlink !== 1) {
    throw new Error(`managed updater generation receipt is unsafe: ${receiptPath}`);
  }
  const receipt = JSON.parse(await fsp.readFile(receiptPath, "utf8"));
  const expectedReceipt = {
    schemaVersion: MANAGED_UPDATER_BUNDLE_SCHEMA_VERSION,
    bundleDigest: `sha256:${bundleDigest}`,
    entrypoint: manifest.entrypoint,
    minimumSupervisorProtocol: manifest.minimumSupervisorProtocol,
    release: releaseIdentity,
    files: records,
  };
  if (canonicalJSON(receipt) !== canonicalJSON(expectedReceipt)) {
    throw new Error(`managed updater generation receipt is invalid: ${receiptPath}`);
  }
  if ((receiptStat.mode & 0o777) !== 0o644) {
    if (!normalizeModes) {
      throw new Error(`managed updater generation receipt is unsafe: ${receiptPath}`);
    }
    modeRepairs.push({ targetPath: receiptPath, mode: 0o644 });
  }
  for (const repair of modeRepairs) {
    await fsp.chmod(repair.targetPath, repair.mode);
    if (durable) {
      await fsyncPath(repair.targetPath);
    }
  }
  await import(
    `${pathToFileURL(path.join(generationDir, manifest.entrypoint)).href}?bundle-smoke=${bundleDigest}`
  );
}

async function readGenerationReceipt(generationDir) {
  const receiptPath = path.join(generationDir, MANAGED_UPDATER_GENERATION_RECEIPT);
  const named = await fsp.lstat(receiptPath);
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1 ||
    (named.mode & 0o777) !== 0o644
  ) {
    throw new Error(`managed updater generation receipt is unsafe: ${receiptPath}`);
  }
  const receipt = JSON.parse(await fsp.readFile(receiptPath, "utf8"));
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    Object.keys(receipt).toSorted().join(",") !==
      "bundleDigest,entrypoint,files,minimumSupervisorProtocol,release,schemaVersion" ||
    receipt.schemaVersion !== MANAGED_UPDATER_BUNDLE_SCHEMA_VERSION ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt.bundleDigest || "") ||
    !SAFE_BUNDLE_FILE.test(receipt.entrypoint || "") ||
    !Number.isSafeInteger(receipt.minimumSupervisorProtocol) ||
    receipt.minimumSupervisorProtocol < 1 ||
    receipt.minimumSupervisorProtocol > 64 ||
    !Array.isArray(receipt.files) ||
    receipt.files.length < 5 ||
    receipt.files.length > 64 ||
    receipt.files.some(
      (file) =>
        !file ||
        typeof file !== "object" ||
        Array.isArray(file) ||
        Object.keys(file).toSorted().join(",") !== "mode,name,sha256,size,type" ||
        !SAFE_BUNDLE_FILE.test(file.name || "") ||
        !BUNDLE_FILE_TYPES.has(file.type) ||
        !new Set(BUNDLE_FILE_MODES.values()).has(file.mode) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !SHA256_PATTERN.test(file.sha256 || ""),
    ) ||
    new Set(receipt.files.map((file) => file.name)).size !== receipt.files.length ||
    !receipt.files.some((file) => file.name === receipt.entrypoint && file.type === "entrypoint")
  ) {
    throw new Error(`managed updater generation receipt is invalid: ${receiptPath}`);
  }
  const calculatedDigest = createHash("sha256")
    .update(
      canonicalJSON({
        schemaVersion: receipt.schemaVersion,
        entrypoint: receipt.entrypoint,
        minimumSupervisorProtocol: receipt.minimumSupervisorProtocol,
        release: receipt.release,
        files: receipt.files,
      }),
    )
    .digest("hex");
  if (receipt.bundleDigest !== `sha256:${calculatedDigest}`) {
    throw new Error(`managed updater generation receipt digest is invalid: ${receiptPath}`);
  }
  return Object.freeze({
    ...receipt,
    files: Object.freeze(receipt.files.map((file) => Object.freeze({ ...file }))),
  });
}

export async function inspectManagedUpdaterGeneration(generationDir) {
  const resolvedGeneration = path.resolve(generationDir);
  const stat = await fsp.lstat(resolvedGeneration);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`managed updater generation is unsafe: ${resolvedGeneration}`);
  }
  const receipt = await readGenerationReceipt(resolvedGeneration);
  const expectedNames = new Set([
    ...receipt.files.map((record) => record.name),
    MANAGED_UPDATER_GENERATION_RECEIPT,
  ]);
  const actualNames = await fsp.readdir(resolvedGeneration);
  if (
    actualNames.length !== expectedNames.size ||
    actualNames.some((name) => !expectedNames.has(name))
  ) {
    throw new Error(`managed updater generation inventory is invalid: ${resolvedGeneration}`);
  }
  for (const record of receipt.files) {
    const identity = await sha256File(path.join(resolvedGeneration, record.name));
    if (
      identity.sha256 !== record.sha256 ||
      identity.size !== record.size ||
      identity.mode !== record.mode
    ) {
      throw new Error(`managed updater generation identity is invalid: ${record.name}`);
    }
  }
  const bundleDigest = receipt.bundleDigest.slice("sha256:".length);
  if (path.basename(resolvedGeneration) !== bundleDigest) {
    throw new Error(
      `managed updater generation directory identity is invalid: ${resolvedGeneration}`,
    );
  }
  await import(
    `${pathToFileURL(path.join(resolvedGeneration, receipt.entrypoint)).href}?generation-smoke=${bundleDigest}`
  );
  return Object.freeze({
    generationDir: resolvedGeneration,
    bundleDigest: receipt.bundleDigest,
    entrypointPath: path.join(resolvedGeneration, receipt.entrypoint),
    receipt,
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

export async function stageManagedUpdaterGeneration({
  updaterDir,
  runtimeRoot,
  durable = false,
  activate = true,
}) {
  const resolvedUpdaterDir = path.resolve(updaterDir);
  const { scriptsDir, manifest } = await readManagedUpdaterBundleManifest(runtimeRoot);
  const releaseIdentity = await readReleaseIdentity(runtimeRoot);
  const records = await buildManagedUpdaterFileRecords(scriptsDir, manifest);
  const bundleDigest = updaterBundleDigest(manifest, releaseIdentity, records);
  if (!SHA256_PATTERN.test(bundleDigest)) {
    throw new Error("managed updater bundle digest is invalid");
  }
  if (!releaseIdentity.development) {
    await verifyManagedUpdaterReleaseDescriptor(runtimeRoot, {
      bundleDigest,
      manifest,
      releaseIdentity,
      records,
    });
  }

  const generationsDir = path.join(resolvedUpdaterDir, "generations");
  const generationDir = path.join(generationsDir, bundleDigest);
  const stagingDir = path.join(
    resolvedUpdaterDir,
    `.generation-${bundleDigest}-${process.pid}-${randomUUID()}`,
  );
  await fsp.mkdir(generationsDir, { recursive: true });
  const currentLink = path.join(resolvedUpdaterDir, "current");
  const previousGenerationDir = await readLinkTarget(currentLink);
  const existing = await fsp.lstat(generationDir).catch(() => null);
  if (existing) {
    await validateManagedUpdaterGeneration({
      generationDir,
      manifest,
      records,
      bundleDigest,
      releaseIdentity,
      normalizeModes: true,
      durable,
    });
  } else {
    await fsp.mkdir(stagingDir, { recursive: false, mode: 0o755 });
    try {
      for (const record of records) {
        const sourcePath = path.join(scriptsDir, record.name);
        const destinationPath = path.join(stagingDir, record.name);
        await fsp.copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
        await fsp.chmod(destinationPath, record.mode);
        const copied = await sha256File(destinationPath);
        if (
          copied.sha256 !== record.sha256 ||
          copied.size !== record.size ||
          copied.mode !== record.mode
        ) {
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
        minimumSupervisorProtocol: manifest.minimumSupervisorProtocol,
        release: releaseIdentity,
        files: records,
      };
      const receiptPath = path.join(stagingDir, MANAGED_UPDATER_GENERATION_RECEIPT);
      await fsp.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
        mode: 0o644,
        flag: "wx",
      });
      await fsp.chmod(receiptPath, 0o644);
      if (durable) {
        await fsyncPath(receiptPath);
        await fsyncPath(stagingDir);
      }
      await validateManagedUpdaterGeneration({
        generationDir: stagingDir,
        manifest,
        records,
        bundleDigest,
        releaseIdentity,
      });
      await fsp.rename(stagingDir, generationDir);
      if (durable) {
        await fsyncPath(generationsDir);
      }
    } catch (error) {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  if (activate) {
    await atomicSymlink(path.relative(resolvedUpdaterDir, generationDir), currentLink);
  }
  return Object.freeze({
    bundleDigest: `sha256:${bundleDigest}`,
    generationDir,
    previousGenerationDir,
    currentLink,
    entrypointPath: path.join(generationDir, manifest.entrypoint),
    files: Object.freeze(records),
    release: releaseIdentity,
    activated: activate,
  });
}

export async function activateManagedUpdaterGeneration({
  updaterDir,
  generationDir,
  durable = false,
}) {
  const resolvedUpdaterDir = path.resolve(updaterDir);
  const inspected = await inspectManagedUpdaterGeneration(generationDir);
  const generationsDir = path.join(resolvedUpdaterDir, "generations");
  if (
    inspected.generationDir === generationsDir ||
    !inspected.generationDir.startsWith(`${generationsDir}${path.sep}`)
  ) {
    throw new Error("managed updater target generation escaped its generation root");
  }
  const currentLink = path.join(resolvedUpdaterDir, "current");
  await atomicSymlink(path.relative(resolvedUpdaterDir, inspected.generationDir), currentLink);
  if (durable) {
    await fsyncPath(currentLink);
    await fsyncPath(resolvedUpdaterDir);
  }
  return Object.freeze({ ...inspected, currentLink });
}

export async function restoreManagedUpdaterGeneration({
  updaterDir,
  generationDir,
  durable = false,
}) {
  const resolvedUpdaterDir = path.resolve(updaterDir);
  const currentLink = path.join(resolvedUpdaterDir, "current");
  if (!generationDir) {
    await fsp.rm(currentLink, { force: true });
    if (durable) {
      await fsyncPath(resolvedUpdaterDir);
    }
    return Object.freeze({ restored: true, generationDir: null, currentLink });
  }
  const resolvedGeneration = path.resolve(generationDir);
  const generationsDir = path.join(resolvedUpdaterDir, "generations");
  if (
    resolvedGeneration === generationsDir ||
    !resolvedGeneration.startsWith(`${generationsDir}${path.sep}`)
  ) {
    throw new Error("managed updater rollback generation escaped its generation root");
  }
  const restored = await activateManagedUpdaterGeneration({
    updaterDir: resolvedUpdaterDir,
    generationDir: resolvedGeneration,
    durable,
  });
  return Object.freeze({ restored: true, ...restored });
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
