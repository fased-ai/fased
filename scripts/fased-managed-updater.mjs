#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants, writeSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CORE_NAME = "fased-managed-updater-core.mjs";
const DESCRIPTOR_NAME = ".fased-managed-updater-bundle.json";
const GENERATION_RECEIPT_NAME = "managed-updater-generation.v1.json";
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const VERSION_PATTERN = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const FILE_TYPES = new Set(["entrypoint", "support", "launcher", "manifest"]);
const FILE_MODES = new Set([0o644, 0o755]);
const MAIN_ENTRYPOINT_SLOT = Symbol.for("fased.managed-updater.main-entrypoint");

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

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).toSorted().join(",") ===
      [...expected].toSorted((left, right) => left.localeCompare(right)).join(",")
  );
}

function parseVersion(value) {
  const match = VERSION_PATTERN.exec(String(value ?? ""));
  if (!match) {
    return null;
  }
  return {
    value: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) {
    throw new Error("managed updater bootstrap received an invalid release version");
  }
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumeric = /^[0-9]+$/u.test(leftPart);
    const rightNumeric = /^[0-9]+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) < Number(rightPart) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function resolveStateDir() {
  return path.resolve(
    process.env.FASED_STATE_DIR ||
      process.env.FASED_CONFIG_DIR ||
      path.join(process.env.HOME || os.homedir(), ".fased"),
  );
}

async function safeRegularFile(candidate) {
  try {
    const info = await fsp.lstat(candidate);
    return info.isFile() && !info.isSymbolicLink() ? candidate : null;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readInstallSelection(stateDir) {
  const manifestPath = path.join(stateDir, "install.json");
  try {
    const info = await fsp.lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("managed installation manifest is not one regular file");
    }
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    if (
      (manifest?.schemaVersion !== 1 && manifest?.schemaVersion !== 2) ||
      typeof manifest?.runtime?.activeVersion !== "string"
    ) {
      throw new Error("managed installation manifest is invalid");
    }
    const currentLink = path.join(stateDir, "runtime", "current");
    const currentRoot = await fsp.realpath(currentLink);
    const releasesRoot = await fsp.realpath(path.join(stateDir, "runtime", "releases"));
    if (currentRoot === releasesRoot || !currentRoot.startsWith(`${releasesRoot}${path.sep}`)) {
      throw new Error("managed runtime current pointer escaped its release root");
    }
    return {
      currentRoot,
      profile: String(manifest.profile ?? "local"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function hashRegularFile(filePath) {
  const named = await fsp.lstat(filePath);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) {
    throw new Error(`managed updater bootstrap file is unsafe: ${filePath}`);
  }
  const handle = await fsp.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino
    ) {
      throw new Error(`managed updater bootstrap file changed before verification: ${filePath}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, opened.size - offset),
        offset,
      );
      if (bytesRead <= 0) {
        throw new Error(`managed updater bootstrap file changed while reading: ${filePath}`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const rebound = await handle.stat();
    if (
      rebound.dev !== opened.dev ||
      rebound.ino !== opened.ino ||
      rebound.size !== opened.size ||
      rebound.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error(`managed updater bootstrap file changed during verification: ${filePath}`);
    }
    return {
      sha256: hash.digest("hex"),
      size: opened.size,
      mode: opened.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

function parseReleaseIdentity(value, { allowDevelopment = false } = {}) {
  const development = value?.development === true;
  if (
    !exactKeys(value, ["commit", "dependencyHash", "development", "version"]) ||
    !parseVersion(value.version) ||
    (development
      ? !allowDevelopment ||
        value.commit !== null ||
        (value.dependencyHash !== null &&
          !/^sha256:[a-f0-9]{64}$/u.test(String(value.dependencyHash ?? "")))
      : value.development !== false ||
        !/^[a-f0-9]{40}$/u.test(String(value.commit ?? "")) ||
        !/^sha256:[a-f0-9]{64}$/u.test(String(value.dependencyHash ?? "")))
  ) {
    return null;
  }
  return {
    version: value.version,
    commit: development ? null : value.commit,
    dependencyHash: value.dependencyHash,
    development,
  };
}

function parseInventory(value, descriptorPath) {
  if (
    !Array.isArray(value) ||
    value.length < 5 ||
    value.length > 64 ||
    value.some(
      (record) =>
        !exactKeys(record, ["mode", "name", "sha256", "size", "type"]) ||
        !SAFE_FILE_NAME.test(String(record.name ?? "")) ||
        !FILE_TYPES.has(record.type) ||
        !SHA256_PATTERN.test(String(record.sha256 ?? "")) ||
        !Number.isSafeInteger(record.size) ||
        record.size < 0 ||
        !FILE_MODES.has(record.mode),
    ) ||
    new Set(value.map((record) => record.name)).size !== value.length
  ) {
    throw new Error(`managed updater release inventory is invalid: ${descriptorPath}`);
  }
  return value;
}

function updaterBundleDigest(descriptor) {
  return createHash("sha256")
    .update(
      canonicalJSON({
        schemaVersion: descriptor.schemaVersion,
        entrypoint: descriptor.entrypoint,
        minimumSupervisorProtocol: descriptor.minimumSupervisorProtocol,
        release: descriptor.release,
        files: descriptor.files,
      }),
    )
    .digest("hex");
}

async function verifyInventory(root, descriptor, entrypointIdentity, descriptorPath) {
  const names = new Set();
  let corePath = null;
  let entrypointMatched = false;
  for (const record of descriptor.files) {
    names.add(record.name);
    const candidate = path.join(root, record.name);
    const identity = await hashRegularFile(candidate);
    if (
      identity.sha256 !== record.sha256 ||
      identity.size !== record.size ||
      identity.mode !== record.mode
    ) {
      throw new Error(`managed updater release file identity is invalid: ${record.name}`);
    }
    if (record.name === descriptor.entrypoint && record.type === "entrypoint") {
      entrypointMatched =
        identity.sha256 === entrypointIdentity.sha256 &&
        identity.size === entrypointIdentity.size &&
        identity.mode === entrypointIdentity.mode;
    }
    if (record.name === CORE_NAME && record.type === "support") {
      corePath = candidate;
    }
  }
  if (
    !entrypointMatched ||
    !corePath ||
    !names.has("managed-updater-bundle.v1.json") ||
    !names.has("managed-updater-bundle.mjs")
  ) {
    throw new Error(`managed updater release inventory is incomplete: ${descriptorPath}`);
  }
  return corePath;
}

async function verifiedRuntimeCore(runtimeRoot, entrypointIdentity) {
  const descriptorPath = path.join(runtimeRoot, DESCRIPTOR_NAME);
  const descriptorFile = await safeRegularFile(descriptorPath);
  if (!descriptorFile) {
    return null;
  }
  const descriptor = JSON.parse(await fsp.readFile(descriptorFile, "utf8"));
  const release = parseReleaseIdentity(descriptor?.release);
  if (
    !exactKeys(descriptor, [
      "architecture",
      "bundleDigest",
      "entrypoint",
      "files",
      "minimumSupervisorProtocol",
      "release",
      "schemaVersion",
    ]) ||
    descriptor.schemaVersion !== 2 ||
    descriptor?.architecture !== process.arch ||
    descriptor?.entrypoint !== "fased-managed-updater.mjs" ||
    !/^sha256:[a-f0-9]{64}$/u.test(String(descriptor?.bundleDigest ?? "")) ||
    !Number.isSafeInteger(descriptor.minimumSupervisorProtocol) ||
    descriptor.minimumSupervisorProtocol < 1 ||
    descriptor.minimumSupervisorProtocol > 64 ||
    !release
  ) {
    throw new Error(`managed updater release descriptor is invalid: ${descriptorPath}`);
  }
  descriptor.release = release;
  descriptor.files = parseInventory(descriptor.files, descriptorPath);
  if (descriptor.bundleDigest !== `sha256:${updaterBundleDigest(descriptor)}`) {
    throw new Error(`managed updater release bundle digest is invalid: ${descriptorPath}`);
  }
  const corePath = await verifyInventory(
    path.join(runtimeRoot, "scripts"),
    descriptor,
    entrypointIdentity,
    descriptorPath,
  );
  return {
    corePath,
    version: release.version,
  };
}

async function verifiedGenerationCore(generationRoot, entrypointIdentity) {
  const receiptPath = path.join(generationRoot, GENERATION_RECEIPT_NAME);
  const receiptFile = await safeRegularFile(receiptPath);
  if (!receiptFile) {
    return null;
  }
  const receipt = JSON.parse(await fsp.readFile(receiptFile, "utf8"));
  const release = parseReleaseIdentity(receipt?.release, { allowDevelopment: true });
  if (
    !exactKeys(receipt, [
      "bundleDigest",
      "entrypoint",
      "files",
      "minimumSupervisorProtocol",
      "release",
      "schemaVersion",
    ]) ||
    receipt.schemaVersion !== 2 ||
    receipt.entrypoint !== "fased-managed-updater.mjs" ||
    !/^sha256:[a-f0-9]{64}$/u.test(String(receipt.bundleDigest ?? "")) ||
    !Number.isSafeInteger(receipt.minimumSupervisorProtocol) ||
    receipt.minimumSupervisorProtocol < 1 ||
    receipt.minimumSupervisorProtocol > 64 ||
    !release
  ) {
    throw new Error(`managed updater generation receipt is invalid: ${receiptPath}`);
  }
  receipt.release = release;
  receipt.files = parseInventory(receipt.files, receiptPath);
  if (receipt.bundleDigest !== `sha256:${updaterBundleDigest(receipt)}`) {
    throw new Error(`managed updater generation bundle digest is invalid: ${receiptPath}`);
  }
  return await verifyInventory(generationRoot, receipt, entrypointIdentity, receiptPath);
}

async function readRecoveryTargetVersions(stateDir) {
  const versions = new Set();
  for (const [name, field] of [
    ["hosted-update-transaction.json", "targetVersion"],
    ["local-paired-update-transaction.json", "targetVersion"],
    ["protected-local-migration-transaction.json", "targetVersion"],
    ["protected-local-controller-transaction.json", "version"],
  ]) {
    const journalPath = path.join(stateDir, name);
    try {
      const stat = await fsp.lstat(journalPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`managed updater recovery journal is unsafe: ${journalPath}`);
      }
      const value = JSON.parse(await fsp.readFile(journalPath, "utf8"));
      const version = parseVersion(value?.[field]);
      if (version) {
        versions.add(version.value);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return versions;
}

async function findVerifiedReleaseCore(stateDir, entrypointIdentity, expectedVersions = new Set()) {
  const releasesRoot = path.join(stateDir, "runtime", "releases");
  const entries = await fsp.readdir(releasesRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const releaseRoot = path.join(releasesRoot, entry.name);
    const verified = await verifiedRuntimeCore(releaseRoot, entrypointIdentity).catch(() => null);
    if (verified && (expectedVersions.size === 0 || expectedVersions.has(verified.version))) {
      candidates.push(verified);
    }
  }
  candidates.sort((left, right) => compareVersions(right.version, left.version));
  return candidates[0]?.corePath ?? null;
}

export async function resolveManagedUpdaterCore({
  entrypointPath = fileURLToPath(import.meta.url),
  stateDir = resolveStateDir(),
} = {}) {
  const updaterDir = path.dirname(path.resolve(entrypointPath));
  const adjacentCore = await safeRegularFile(path.join(updaterDir, CORE_NAME));
  if (adjacentCore) {
    return adjacentCore;
  }
  const entrypointIdentity = await hashRegularFile(entrypointPath);
  const generationRoot = await fsp
    .realpath(path.join(updaterDir, "current"))
    .catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
  if (generationRoot) {
    const selected = await verifiedGenerationCore(generationRoot, entrypointIdentity);
    if (selected) {
      return selected;
    }
  }
  const selection = await readInstallSelection(stateDir);
  if (selection) {
    const activeCore = path.join(selection.currentRoot, "scripts", CORE_NAME);
    if (selection.profile !== "hosting" && selection.profile !== "protected-local") {
      const selected = await safeRegularFile(activeCore);
      if (selected) {
        return selected;
      }
    }
    const verifiedActive = await verifiedRuntimeCore(selection.currentRoot, entrypointIdentity);
    if (verifiedActive) {
      return verifiedActive.corePath;
    }
  }
  const recoveryVersions = await readRecoveryTargetVersions(stateDir);
  const recoveryCore = await findVerifiedReleaseCore(
    stateDir,
    entrypointIdentity,
    recoveryVersions,
  );
  if (recoveryCore) {
    return recoveryCore;
  }
  throw new Error(
    "The managed updater bootstrap could not locate a complete verified target updater generation.",
  );
}

export async function run(argv = process.argv.slice(2)) {
  const corePath = await resolveManagedUpdaterCore();
  const core = await import(
    `${pathToFileURL(corePath).href}?bootstrap=${encodeURIComponent(path.resolve(corePath))}`
  );
  if (typeof core.run !== "function") {
    throw new Error("The selected managed updater generation has no runnable update entrypoint.");
  }
  await core.run(argv);
}

async function runningAsEntrypoint() {
  const moduleUrl = import.meta.url;
  const modulePath = fileURLToPath(import.meta.url);
  const boundEntrypoint = globalThis[MAIN_ENTRYPOINT_SLOT];
  if (typeof boundEntrypoint === "string") {
    return boundEntrypoint === moduleUrl;
  }
  if (!process.argv[1]) {
    return false;
  }
  const invokedPath = await fsp.realpath(path.resolve(process.argv[1])).catch(() => null);
  if (invokedPath !== modulePath) {
    return false;
  }
  Object.defineProperty(globalThis, MAIN_ENTRYPOINT_SLOT, {
    value: moduleUrl,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return true;
}

if (await runningAsEntrypoint()) {
  try {
    await run();
  } catch (error) {
    // Emit updater failures synchronously so a piped CLI or immediate process
    // teardown cannot discard the only actionable diagnostic.
    writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export const __testing = {
  findVerifiedReleaseCore,
  hashRegularFile,
  readRecoveryTargetVersions,
  readInstallSelection,
  runningAsEntrypoint,
  resolveManagedUpdaterCore,
  resolveStateDir,
  safeRegularFile,
  verifiedGenerationCore,
  verifiedRuntimeCore,
};
