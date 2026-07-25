#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installProtectedLocalApplicationRuntime } from "./fased-host-updater.mjs";
import {
  loadOrAllocateProtectedLocalInstance,
  removeProtectedLocalInstance,
} from "./protected-local-layout.mjs";
import { buildProtectedLocalServicePlan } from "./protected-local-service-plan.mjs";

const RELEASE_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SIGNER_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const VERIFIED_ROOT_PATTERN =
  /^\/var\/lib\/fased-installer\/releases\/v[^/]+\/[a-f0-9]{64}\/extract\/package$/u;

function fail(message) {
  throw new Error(message);
}

function cleanAbsolute(value, label) {
  const resolved = String(value ?? "").trim();
  if (
    !path.isAbsolute(resolved) ||
    path.resolve(resolved) !== resolved ||
    resolved.includes("\r") ||
    resolved.includes("\n") ||
    resolved.includes("\0")
  ) {
    fail(`${label} must be absolute, clean, and single-line`);
  }
  return resolved;
}

function safeAccount(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,30}$/u.test(text) || text === "root") {
    fail(`${label} is invalid`);
  }
  return text;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return parsed;
}

function assertPathBelow(parent, candidate, label) {
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} must remain below ${parent}`);
  }
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(targetPath, content, mode, ownership) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const temporary = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await fsp.open(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    mode,
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
    if (ownership) {
      await handle.chown(ownership.uid, ownership.gid);
    }
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, targetPath);
  await fsyncDirectory(path.dirname(targetPath));
}

async function atomicCopy(source, destination, mode, ownership) {
  const sourceInfo = await fsp.lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.nlink !== 1) {
    fail(`protected Local source asset is unsafe: ${source}`);
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  await fsp.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(temporary, mode);
  if (ownership) {
    await fsp.chown(temporary, ownership.uid, ownership.gid);
  }
  const handle = await fsp.open(temporary, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, destination);
  await fsyncDirectory(path.dirname(destination));
}

function systemBinary(candidates, label) {
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      const info = fs.statSync(resolved);
      if (
        info.isFile() &&
        info.uid === 0 &&
        (info.mode & 0o022) === 0 &&
        fs.accessSync(resolved, fs.constants.X_OK) === undefined
      ) {
        return resolved;
      }
    } catch {
      // Try the next fixed system location.
    }
  }
  fail(`${label} is not available in a root-controlled system path`);
}

function runSystem(command, args, options = {}) {
  return execFileSync(command, args, {
    env: {
      HOME: "/root",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    },
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 120_000,
  });
}

function passwdRecord(user) {
  const getent = systemBinary(["/usr/bin/getent", "/bin/getent"], "getent");
  try {
    const fields = runSystem(getent, ["passwd", user]).trim().split(":");
    if (fields.length !== 7) {
      return null;
    }
    return {
      user: fields[0],
      uid: positiveInteger(fields[2], `${user} UID`),
      gid: positiveInteger(fields[3], `${user} GID`),
      home: fields[5],
      shell: fields[6],
    };
  } catch {
    return null;
  }
}

function groupRecord(group) {
  const getent = systemBinary(["/usr/bin/getent", "/bin/getent"], "getent");
  try {
    const fields = runSystem(getent, ["group", group]).trim().split(":");
    if (fields.length !== 4) {
      return null;
    }
    return { group: fields[0], gid: positiveInteger(fields[2], `${group} GID`) };
  } catch {
    return null;
  }
}

function ensureGroup(group) {
  const existing = groupRecord(group);
  if (existing) {
    return { ...existing, created: false };
  }
  const groupadd = systemBinary(["/usr/sbin/groupadd", "/sbin/groupadd"], "groupadd");
  runSystem(groupadd, ["--system", group]);
  const created = groupRecord(group) ?? fail(`could not create protected Local group ${group}`);
  return { ...created, created: true };
}

function ensureServiceUser(user, primaryGroup, home) {
  const existing = passwdRecord(user);
  const group = groupRecord(primaryGroup);
  if (!group) {
    fail(`protected Local primary group ${primaryGroup} is unavailable`);
  }
  if (existing) {
    if (
      existing.home !== home ||
      existing.gid !== group.gid ||
      !new Set(["/usr/sbin/nologin", "/sbin/nologin", "/bin/false"]).has(existing.shell)
    ) {
      fail(`existing protected Local account ${user} does not match its fixed service identity`);
    }
    return { ...existing, created: false };
  }
  const useradd = systemBinary(["/usr/sbin/useradd", "/sbin/useradd"], "useradd");
  runSystem(useradd, [
    "--system",
    "--gid",
    primaryGroup,
    "--home-dir",
    home,
    "--no-create-home",
    "--shell",
    "/usr/sbin/nologin",
    user,
  ]);
  const created = passwdRecord(user) ?? fail(`could not create protected Local account ${user}`);
  return { ...created, created: true };
}

function addGroups(user, groups) {
  const usermod = systemBinary(["/usr/sbin/usermod", "/sbin/usermod"], "usermod");
  runSystem(usermod, ["--append", "--groups", groups.join(","), user]);
}

function userGroups(user) {
  const id = systemBinary(["/usr/bin/id", "/bin/id"], "id");
  return new Set(runSystem(id, ["-nG", user]).trim().split(/\s+/u).filter(Boolean));
}

export function renderProtectedLocalOperatorEnvironment(params) {
  const { layout } = params;
  const values = {
    FASED_HOST_PROFILE: "local",
    FASED_PROTECTED_LOCAL: "1",
    FASED_PROTECTED_LOCAL_INSTANCE: layout.instanceId,
    FASED_WALLET_LOCAL_SIGNER_LIFECYCLE: "external",
    FASED_WALLET_LOCAL_SIGNER_BIN: layout.signerBinary,
    FASED_WALLET_LOCAL_SIGNER_SOCKET: layout.applicationSocket,
    FASED_HOST_UPDATER_SOCKET: `/run/fased-local-controller/${layout.instanceId}/request.sock`,
    FASED_HOST_UPDATERCTL_STATE: path.join(
      params.stateDir,
      "protected-local-controller-transaction.json",
    ),
  };
  return Object.freeze(values);
}

export function renderProtectedLocalOwnerWrapper(params) {
  const { layout } = params;
  const operatorUser = safeAccount(params.operatorUser, "operator user");
  const operatorUid = positiveInteger(params.operatorUid, "operator UID");
  const operatorGid = positiveInteger(params.operatorGid, "operator GID");
  return `#!/usr/bin/env bash
set -euo pipefail
export FASED_SIGNER_USER=${layout.signerUser}
export FASED_SIGNER_HOME=${layout.signerStateDir}
export FASED_SIGNER_BIN=${layout.signerBinary}
export FASED_SIGNER_CONTROL_SOCKET=${layout.controlSocket}
export FASED_SIGNER_OWNER_LOCK=/run/lock/fased-local-signer-owner-${layout.instanceId}.lock
export FASED_SIGNER_UPDATE_GATE=${layout.controllerStateDir}/signer-update-gate
export FASED_SIGNER_UPDATE_JOURNAL=${layout.controllerStateDir}/active-signer-transaction.json
export FASED_SIGNER_OWNER_LOCAL=1
export FASED_SIGNER_OUTPUT_USER=${operatorUser}
export FASED_SIGNER_OUTPUT_UID=${operatorUid}
export FASED_SIGNER_OUTPUT_GID=${operatorGid}
exec ${layout.installDir}/signer-owner "$@"
`;
}

export function buildProtectedLocalBootstrapSpec(params) {
  const operatorUser = safeAccount(params.operatorUser, "operator user");
  const operatorUid = positiveInteger(params.operatorUid, "operator UID");
  const operatorGid = positiveInteger(params.operatorGid, "operator GID");
  const operatorHome = cleanAbsolute(params.operatorHome, "operator home");
  const stateDir = cleanAbsolute(params.stateDir, "Local state directory");
  const runtimeDir = cleanAbsolute(params.runtimeDir, "application runtime directory");
  const nodeBinary = cleanAbsolute(params.nodeBinary, "Node.js binary");
  const releaseVersion = String(params.releaseVersion ?? "")
    .trim()
    .replace(/^v/u, "");
  const releaseCommit = String(params.releaseCommit ?? "")
    .trim()
    .toLowerCase();
  const updateChannel = String(params.updateChannel ?? "stable").trim();
  const gatewayPort = Number(params.gatewayPort ?? 18789);
  const gatewayMode = String(params.gatewayMode ?? "activate").trim();
  const gatewayHealthTimeoutMs = Number(params.gatewayHealthTimeoutMs ?? 120_000);
  if (!RELEASE_PATTERN.test(releaseVersion) || !COMMIT_PATTERN.test(releaseCommit)) {
    fail("protected Local bootstrap requires an exact application and signer release identity");
  }
  if (!new Set(["stable", "beta"]).has(updateChannel)) {
    fail("protected Local update channel must be stable or beta");
  }
  if (releaseVersion.includes("-") && updateChannel !== "beta") {
    fail("protected Local prereleases require the beta update channel");
  }
  if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) {
    fail("protected Local Gateway port is invalid");
  }
  if (!new Set(["prepare", "activate", "rollback"]).has(gatewayMode)) {
    fail("protected Local Gateway mode must be prepare, activate, or rollback");
  }
  if (
    !Number.isSafeInteger(gatewayHealthTimeoutMs) ||
    gatewayHealthTimeoutMs < 1_000 ||
    gatewayHealthTimeoutMs > 120_000
  ) {
    fail("protected Local Gateway health timeout must be 1000 through 120000 milliseconds");
  }
  assertPathBelow(operatorHome, stateDir, "Local state directory");
  assertPathBelow(stateDir, runtimeDir, "application runtime directory");
  return Object.freeze({
    operatorUser,
    operatorUid,
    operatorGid,
    operatorHome,
    stateDir,
    runtimeDir,
    nodeBinary,
    releaseVersion,
    releaseCommit,
    updateChannel,
    gatewayPort,
    gatewayMode,
    gatewayHealthTimeoutMs,
    profile: String(params.profile ?? "default"),
  });
}

async function validateVerifiedReleaseRoot(sourceRoot, spec) {
  const canonical = await fsp.realpath(cleanAbsolute(sourceRoot, "verified release root"));
  if (!VERIFIED_ROOT_PATTERN.test(canonical)) {
    fail("protected Local privileged bootstrap requires the root-owned attested release bundle");
  }
  const info = await fsp.lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
    fail("verified release root ownership or mode is unsafe");
  }
  const markerPath = path.join(canonical, ".fased-hosting-bundle-verified");
  const markerInfo = await fsp.lstat(markerPath);
  if (
    !markerInfo.isFile() ||
    markerInfo.isSymbolicLink() ||
    markerInfo.uid !== 0 ||
    markerInfo.nlink !== 1 ||
    (markerInfo.mode & 0o177) !== 0
  ) {
    fail("verified release marker ownership or mode is unsafe");
  }
  const marker = Object.fromEntries(
    (await fsp.readFile(markerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return at > 0 ? [line.slice(0, at), line.slice(at + 1)] : ["", ""];
      }),
  );
  const buildInfo = JSON.parse(
    await fsp.readFile(path.join(canonical, "dist", "build-info.json"), "utf8"),
  );
  const rootStore = path.dirname(path.dirname(canonical));
  const dependencies = await fsp.lstat(
    path.join(rootStore, "verified-dependencies", "node_modules"),
  );
  if (!dependencies.isDirectory() || dependencies.isSymbolicLink()) {
    fail("verified release root does not contain its attested dependency layer");
  }
  const packageMetadata = JSON.parse(
    await fsp.readFile(path.join(canonical, "package.json"), "utf8"),
  );
  const runtimeMetadata = JSON.parse(
    await fsp.readFile(path.join(canonical, ".fased-hosted-runtime.json"), "utf8"),
  );
  if (
    marker.version !== spec.releaseVersion ||
    marker.commit !== spec.releaseCommit ||
    buildInfo.version !== spec.releaseVersion ||
    buildInfo.commit !== spec.releaseCommit ||
    packageMetadata.version !== spec.releaseVersion ||
    !/^[a-f0-9]{64}$/u.test(marker.dependency_sha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(marker.dependency_hash ?? "") ||
    runtimeMetadata.dependencyHash !== marker.dependency_hash
  ) {
    fail("verified release root does not match the requested protected Local identity");
  }
  return canonical;
}

function verifySignerReleaseIdentity(signerBinary, spec) {
  const output = runSystem(signerBinary, ["--version"], { timeout: 10_000 }).trim();
  const match =
    /^fased-signerd ([^\s]+) commit=([a-f0-9]{40}) buildInputDigest=(sha256:[a-f0-9]{64}) development=(true|false)$/u.exec(
      output,
    );
  if (
    !match ||
    match[1] !== spec.releaseVersion ||
    match[2] !== spec.releaseCommit ||
    !SIGNER_DIGEST_PATTERN.test(match[3]) ||
    match[4] !== "false"
  ) {
    fail("verified signer binary does not have the exact production release identity");
  }
  return Object.freeze({
    version: match[1],
    commit: match[2],
    buildInputDigest: match[3],
    development: false,
  });
}

function parseConfig(configPath) {
  try {
    const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function buildControllerIdentity(releaseVersion, serverBytes, clientBytes) {
  return Object.freeze({
    schemaVersion: 1,
    version: releaseVersion,
    serverSha256: crypto.createHash("sha256").update(serverBytes).digest("hex"),
    clientSha256: crypto.createHash("sha256").update(clientBytes).digest("hex"),
  });
}

function resolveLegacySignerPaths(spec, config) {
  const env = config.env?.vars && typeof config.env.vars === "object" ? config.env.vars : {};
  const materialDir = path.resolve(
    String(env.FASED_WALLET_SIGNER_STATE_DIR || path.join(spec.stateDir, "wallet")),
  );
  assertPathBelow(spec.stateDir, materialDir, "legacy signer material directory");
  const stateDbPath = path.resolve(
    String(env.FASED_WALLET_LOCAL_SIGNER_STATE_DB || path.join(materialDir, "signerd-v2.db")),
  );
  const masterKeyPath = path.resolve(
    String(
      env.FASED_WALLET_LOCAL_SIGNER_MASTER_KEY || path.join(materialDir, "signerd-v2.master.key"),
    ),
  );
  for (const [label, candidate] of [
    ["legacy signer state database", stateDbPath],
    ["legacy signer master key", masterKeyPath],
  ]) {
    assertPathBelow(materialDir, candidate, label);
  }
  const socketPath = path.resolve(
    String(env.FASED_WALLET_LOCAL_SIGNER_SOCKET || path.join(materialDir, "local-signer.sock")),
  );
  assertPathBelow(materialDir, socketPath, "legacy signer socket");
  const signerBinary = path.resolve(
    String(env.FASED_WALLET_LOCAL_SIGNER_BIN || path.join(spec.stateDir, "bin", "fased-signerd")),
  );
  assertPathBelow(spec.stateDir, signerBinary, "legacy signer binary");
  const controlSocketPath = path.resolve(
    String(
      env.FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET ||
        path.join(materialDir, "local-signer-control.sock"),
    ),
  );
  assertPathBelow(materialDir, controlSocketPath, "legacy signer control socket");
  const socketBase = path.basename(socketPath).replace(/\.sock$/u, "");
  return {
    materialDir,
    signerBinary,
    controlSocketPath,
    stateDbPath,
    masterKeyPath,
    auditPath: path.join(path.dirname(socketPath), `${socketBase}.audit.jsonl`),
    pidPath: path.join(path.dirname(socketPath), `${socketBase}.pid`),
  };
}

function normalizeSignerWalletID(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized || "default";
}

function registeredSignerWallets(spec) {
  const registryPath = path.join(spec.stateDir, "wallet", "provider-registry.v1.json");
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const info = fs.lstatSync(registryPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size <= 0 ||
    info.size > 1024 * 1024
  ) {
    fail("wallet provider registry is not a safe bounded regular file");
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  if (registry?.version !== 1 || !Array.isArray(registry.wallets)) {
    fail("wallet provider registry has an unsupported schema");
  }
  const seen = new Set();
  const wallets = [];
  for (const wallet of registry.wallets) {
    if (wallet?.providerId !== "local-socket-signer") {
      continue;
    }
    const walletID = String(wallet.id ?? "").trim();
    const signerWalletID =
      typeof wallet.metadata?.signerWalletId === "string" && wallet.metadata.signerWalletId.trim()
        ? wallet.metadata.signerWalletId.trim()
        : normalizeSignerWalletID(walletID);
    const publicKey = String(wallet.addresses?.solana ?? "").trim();
    const role = String(wallet.metadata?.role ?? wallet.metadata?.purpose ?? "")
      .trim()
      .toLowerCase();
    if (
      !walletID ||
      signerWalletID.length > 64 ||
      normalizeSignerWalletID(signerWalletID) !== signerWalletID ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(publicKey) ||
      (role && !new Set(["agent", "mining", "vault"]).has(role)) ||
      seen.has(signerWalletID)
    ) {
      fail("wallet provider registry contains an invalid native signer identity");
    }
    seen.add(signerWalletID);
    wallets.push(Object.freeze({ walletID, signerWalletID, publicKey, role: role || null }));
  }
  return Object.freeze(wallets);
}

async function copyLegacyMaterial(legacy, layout, signerIdentity) {
  const stateExists = fs.existsSync(legacy.stateDbPath);
  const keyExists = fs.existsSync(legacy.masterKeyPath);
  if (stateExists !== keyExists) {
    fail("legacy signer state is incomplete; refusing a partial custody migration");
  }
  if (!stateExists) {
    return { migrated: false };
  }
  await atomicCopy(legacy.stateDbPath, path.join(layout.signerStateDir, "state.db"), 0o600, {
    uid: signerIdentity.uid,
    gid: signerIdentity.gid,
  });
  await atomicCopy(legacy.masterKeyPath, path.join(layout.signerStateDir, "master.key"), 0o600, {
    uid: signerIdentity.uid,
    gid: signerIdentity.gid,
  });
  if (fs.existsSync(legacy.auditPath)) {
    await atomicCopy(legacy.auditPath, layout.auditLog, 0o600, {
      uid: signerIdentity.uid,
      gid: signerIdentity.gid,
    });
  }
  return { migrated: true };
}

async function updateOperatorConfig(spec, layout, configGroup) {
  const configPath = path.join(spec.stateDir, "fased.json");
  const config = parseConfig(configPath);
  const protectedEnv = renderProtectedLocalOperatorEnvironment({ layout, stateDir: spec.stateDir });
  const variables = {
    ...config.env?.vars,
    ...protectedEnv,
    FASED_UPDATE_CHANNEL: spec.updateChannel,
  };
  for (const key of [
    "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET",
    "FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET",
    "FASED_WALLET_LOCAL_SIGNER_STATE_DB",
    "FASED_WALLET_LOCAL_SIGNER_MASTER_KEY",
    "FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER",
    "FASED_WALLET_SIGNER_STATE_DIR",
    "FASED_WALLET_PASSPHRASE_FILE",
  ]) {
    delete variables[key];
  }
  const next = {
    ...config,
    env: {
      ...config.env,
      vars: variables,
    },
  };
  await atomicWrite(configPath, `${JSON.stringify(next, null, 2)}\n`, 0o660, {
    uid: spec.operatorUid,
    gid: configGroup.gid,
  });
  const manifestPath = path.join(spec.stateDir, "install.json");
  const manifest = parseConfig(manifestPath);
  if (manifest.schemaVersion && manifest.runtime) {
    const nextManifest = {
      ...manifest,
      profile: "protected-local",
      service: {
        ...manifest.service,
        name: layout.gatewayUnit,
        scope: "system",
        launcher: path.join(layout.installDir, "gateway-launch"),
      },
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 0o660, {
      uid: spec.operatorUid,
      gid: configGroup.gid,
    });
  }
}

async function installControllerGeneration(sourceRoot, layout, spec) {
  const releaseDir = path.join(
    layout.installDir,
    "controller",
    "releases",
    `v${spec.releaseVersion}`,
  );
  await fsp.mkdir(releaseDir, { recursive: true, mode: 0o755 });
  for (const directory of [
    layout.installDir,
    path.join(layout.installDir, "controller"),
    path.join(layout.installDir, "controller", "releases"),
    releaseDir,
  ]) {
    await fsp.chown(directory, 0, 0);
    await fsp.chmod(directory, 0o755);
  }
  await atomicCopy(
    path.join(sourceRoot, "scripts", "fased-host-updater.mjs"),
    path.join(releaseDir, "fased-host-updater.mjs"),
    0o755,
    { uid: 0, gid: 0 },
  );
  await atomicCopy(
    path.join(sourceRoot, "scripts", "fased-host-updaterctl.mjs"),
    path.join(releaseDir, "fased-host-updaterctl.mjs"),
    0o755,
    { uid: 0, gid: 0 },
  );
  const current = path.join(layout.installDir, "controller", "current");
  const temporary = `${current}.tmp-${process.pid}`;
  await fsp.rm(temporary, { force: true });
  await fsp.symlink(releaseDir, temporary);
  await fsp.rename(temporary, current);
  await fsyncDirectory(path.dirname(current));
  const [serverBytes, clientBytes] = await Promise.all([
    fsp.readFile(path.join(releaseDir, "fased-host-updater.mjs")),
    fsp.readFile(path.join(releaseDir, "fased-host-updaterctl.mjs")),
  ]);
  await atomicWrite(
    path.join(layout.controllerStateDir, "controller-version.json"),
    `${JSON.stringify(buildControllerIdentity(spec.releaseVersion, serverBytes, clientBytes), null, 2)}\n`,
    0o600,
    { uid: 0, gid: 0 },
  );
}

async function resolveTrustedLegacyRuntimeHardlinks(spec) {
  const binaryPath = path.join(spec.stateDir, "bin", "fased-signerd");
  const enrollmentPath = path.join(spec.stateDir, "bin", "fased-signer-enroll");
  let binaryInfo;
  let enrollmentInfo;
  try {
    [binaryInfo, enrollmentInfo] = await Promise.all([
      fsp.lstat(binaryPath),
      fsp.lstat(enrollmentPath),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
  if (binaryInfo.nlink === 1 && enrollmentInfo.nlink === 1) {
    return new Set();
  }
  if (
    !binaryInfo.isFile() ||
    binaryInfo.isSymbolicLink() ||
    !enrollmentInfo.isFile() ||
    enrollmentInfo.isSymbolicLink() ||
    binaryInfo.nlink !== 2 ||
    enrollmentInfo.nlink !== 2 ||
    binaryInfo.dev !== enrollmentInfo.dev ||
    binaryInfo.ino !== enrollmentInfo.ino ||
    binaryInfo.uid !== spec.operatorUid ||
    enrollmentInfo.uid !== spec.operatorUid ||
    (binaryInfo.mode & 0o022) !== 0 ||
    (binaryInfo.mode & 0o111) === 0
  ) {
    return new Set();
  }
  const canonicalPaths = await Promise.all([
    fsp.realpath(binaryPath),
    fsp.realpath(enrollmentPath),
  ]);
  for (const canonical of canonicalPaths) {
    assertPathBelow(spec.stateDir, canonical, "trusted legacy Local signer launcher");
  }
  return new Set(canonicalPaths);
}

async function hardenOperatorRuntime(
  candidate,
  spec,
  visited = new Set(),
  trustedHardlinks = new Set(),
) {
  if (!fs.existsSync(candidate)) {
    return;
  }
  const canonical = await fsp.realpath(candidate);
  assertPathBelow(spec.stateDir, canonical, "protected Local application runtime");
  if (visited.has(canonical)) {
    return;
  }
  visited.add(canonical);
  const info = await fsp.lstat(canonical);
  if (info.isSymbolicLink()) {
    fail("protected Local application runtime resolved to a symlink");
  }
  if (info.isDirectory()) {
    await fsp.chown(canonical, spec.operatorUid, spec.operatorGid);
    await fsp.chmod(canonical, 0o755);
    for (const entry of await fsp.readdir(canonical, { withFileTypes: true })) {
      const entryPath = path.join(canonical, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fsp.realpath(entryPath);
        assertPathBelow(spec.stateDir, target, "protected Local runtime symlink target");
        await fsp.lchown(entryPath, spec.operatorUid, spec.operatorGid);
        await hardenOperatorRuntime(target, spec, visited, trustedHardlinks);
        continue;
      }
      await hardenOperatorRuntime(entryPath, spec, visited, trustedHardlinks);
    }
    return;
  }
  if (!info.isFile() || (info.nlink !== 1 && !trustedHardlinks.has(canonical))) {
    fail(`protected Local application runtime contains an unsafe entry: ${canonical}`);
  }
  await fsp.chown(canonical, spec.operatorUid, spec.operatorGid);
  await fsp.chmod(canonical, info.mode & 0o111 ? 0o755 : 0o644);
}

async function protectLegacyMaterial(legacy, spec) {
  for (const candidate of [legacy.stateDbPath, legacy.masterKeyPath, legacy.auditPath]) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const info = await fsp.lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      fail(`legacy signer material is unsafe: ${candidate}`);
    }
    await fsp.chown(candidate, spec.operatorUid, spec.operatorGid);
    await fsp.chmod(candidate, 0o600);
  }
}

async function shareApplicationState(spec, configGroup, legacy) {
  const trustedHardlinks = await resolveTrustedLegacyRuntimeHardlinks(spec);
  await fsp.mkdir(spec.stateDir, { recursive: true, mode: 0o2770 });
  const chown = systemBinary(["/usr/bin/chown", "/bin/chown"], "chown");
  const chmod = systemBinary(["/usr/bin/chmod", "/bin/chmod"], "chmod");
  runSystem(chown, ["-R", `${spec.operatorUid}:${configGroup.gid}`, spec.stateDir]);
  runSystem(chmod, ["-R", "g+rwX,o-rwx", spec.stateDir]);
  runSystem(chmod, ["g+s", spec.stateDir]);
  for (const protectedRuntimePath of [
    path.join(spec.stateDir, "runtime"),
    path.join(spec.stateDir, "updater"),
    path.join(spec.stateDir, "bin"),
  ]) {
    await hardenOperatorRuntime(protectedRuntimePath, spec, new Set(), trustedHardlinks);
  }
  await protectLegacyMaterial(legacy, spec);
}

async function installRootFiles(params) {
  const { sourceRoot, spec, layout, servicePlan, signerIdentity } = params;
  await fsp.mkdir(path.dirname(layout.signerBinary), { recursive: true, mode: 0o755 });
  for (const directory of [layout.installDir, path.dirname(layout.signerBinary)]) {
    await fsp.chown(directory, 0, 0);
    await fsp.chmod(directory, 0o755);
  }
  await atomicCopy(params.signerBinary, layout.signerBinary, 0o755, { uid: 0, gid: 0 });
  await installProtectedLocalApplicationRuntime({
    sourceRoot,
    dependencyRoot: path.join(
      path.dirname(path.dirname(sourceRoot)),
      "verified-dependencies",
      "node_modules",
    ),
    version: spec.releaseVersion,
    commit: spec.releaseCommit,
    paths: {
      applicationReleasesDir: layout.applicationReleasesDir,
      applicationCurrentLink: layout.applicationCurrentLink,
    },
  });
  await installControllerGeneration(sourceRoot, layout, spec);
  await atomicCopy(
    path.join(sourceRoot, "scripts", "fased-signer-owner-hosting.sh"),
    path.join(layout.installDir, "signer-owner"),
    0o700,
    { uid: 0, gid: 0 },
  );
  const ownerWrapper = `/usr/local/sbin/fased-local-signer-owner-${layout.instanceId}`;
  await atomicWrite(
    ownerWrapper,
    renderProtectedLocalOwnerWrapper({
      layout,
      operatorUid: spec.operatorUid,
      operatorGid: spec.operatorGid,
      operatorUser: spec.operatorUser,
    }),
    0o755,
    {
      uid: 0,
      gid: 0,
    },
  );
  for (const file of Object.values(servicePlan.files)) {
    await atomicWrite(file.path, file.content, file.mode, { uid: 0, gid: 0 });
  }
  const channelPath = `/etc/fased/local/${layout.instanceId}/update-channel`;
  await atomicWrite(channelPath, `${spec.updateChannel}\n`, 0o644, { uid: 0, gid: 0 });
  await fsp.mkdir(layout.signerStateDir, { recursive: true, mode: 0o700 });
  await fsp.chown(layout.signerStateDir, signerIdentity.uid, signerIdentity.gid);
  await fsp.chmod(layout.signerStateDir, 0o700);
  await fsp.mkdir(layout.controllerStateDir, { recursive: true, mode: 0o711 });
  await fsp.chown(layout.controllerStateDir, 0, 0);
  await fsp.chmod(layout.controllerStateDir, 0o711);
  await atomicWrite(
    path.join(layout.controllerStateDir, "signer-version"),
    `${spec.releaseVersion}\n`,
    0o600,
    { uid: 0, gid: 0 },
  );
}

async function prepareProtectedLocalRootDirectories(layout) {
  for (const directory of [
    "/var/lib/fased-local",
    layout.stateDir,
    "/opt/fased",
    "/opt/fased/local",
    layout.installDir,
    "/etc/fased",
    "/etc/fased/local",
  ]) {
    await fsp.mkdir(directory, { recursive: true, mode: 0o755 });
    const info = await fsp.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0) {
      fail(`protected Local privileged directory is unsafe: ${directory}`);
    }
    await fsp.chmod(directory, 0o755);
  }
}

function assertPrincipalSeparation(spec, layout) {
  const operatorGroups = userGroups(spec.operatorUser);
  const gatewayGroups = userGroups(layout.gatewayUser);
  if (operatorGroups.has(layout.gatewayGroup) || operatorGroups.has(layout.signerGroup)) {
    fail("operator received forbidden Gateway or signer group authority");
  }
  if (gatewayGroups.has(layout.operatorGroup) || gatewayGroups.has(layout.signerGroup)) {
    fail("Gateway received forbidden operator or signer group authority");
  }
}

async function waitForSocket(socketPath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await fsp.lstat(socketPath);
      if (info.isSocket() && !info.isSymbolicLink()) {
        return;
      }
    } catch {
      // Keep waiting for systemd and the signer.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fail(`protected Local service did not create ${socketPath}`);
}

async function verifyOperatorCapabilities(spec, layout) {
  const runuser = systemBinary(["/usr/sbin/runuser", "/sbin/runuser"], "runuser");
  const output = runSystem(
    runuser,
    [
      "-u",
      spec.operatorUser,
      "--",
      layout.signerBinary,
      "admin",
      "service",
      "capabilities",
      "--operator-socket",
      layout.operatorSocket,
    ],
    { timeout: 30_000 },
  );
  const result = JSON.parse(output);
  if (
    result.ready !== true ||
    result.capabilities?.protocol?.current !== 2 ||
    !result.capabilities?.features?.includes("signerOwnedKeys")
  ) {
    fail("protected Local signer did not acknowledge protocol-v2 signer-owned custody");
  }
}

function invokeOperatorWalletReadiness(spec, layout, wallet) {
  const runuser = systemBinary(["/usr/sbin/runuser", "/sbin/runuser"], "runuser");
  const output = runSystem(
    runuser,
    [
      "-u",
      spec.operatorUser,
      "--",
      layout.signerBinary,
      "admin",
      "wallet",
      "readiness",
      "--operator-socket",
      layout.operatorSocket,
      "--wallet-id",
      wallet.signerWalletID,
    ],
    { timeout: 30_000 },
  );
  const readiness = JSON.parse(output);
  if (
    readiness?.walletId !== wallet.signerWalletID ||
    readiness.publicKey !== wallet.publicKey ||
    !Number.isSafeInteger(readiness.walletVersion) ||
    !Number.isSafeInteger(readiness.policyVersion) ||
    !Number.isSafeInteger(readiness.networkVersion) ||
    typeof readiness.policyHash !== "string" ||
    (wallet.role && readiness.role !== wallet.role)
  ) {
    fail(`protected Local signer state does not match registered wallet ${wallet.walletID}`);
  }
  return Object.freeze({
    walletID: wallet.walletID,
    signerWalletID: wallet.signerWalletID,
    publicKey: readiness.publicKey,
    role: readiness.role,
    walletVersion: readiness.walletVersion,
    baselineVersion: readiness.baselineVersion,
    policyVersion: readiness.policyVersion,
    policyHash: readiness.policyHash,
    networkVersion: readiness.networkVersion,
    networkHash: readiness.networkHash ?? "",
    ready: readiness.ready === true,
  });
}

function verifyLogicalWalletState(spec, layout) {
  return Object.freeze(
    registeredSignerWallets(spec).map((wallet) =>
      invokeOperatorWalletReadiness(spec, layout, wallet),
    ),
  );
}

function protectedLocalGatewayHealthMatches(payload, statusCode, expectedVersion) {
  return (
    statusCode === 200 &&
    payload?.version === expectedVersion &&
    new Set(["managed-package", "packaged-runtime"]).has(payload?.runtimeSource)
  );
}

async function probeGatewayHealth(spec, timeoutMs = 2_000) {
  return await new Promise((resolve) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port: spec.gatewayPort,
        path: "/healthz",
        timeout: timeoutMs,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const payload = JSON.parse(body);
            resolve({
              ok: protectedLocalGatewayHealthMatches(
                payload,
                response.statusCode,
                spec.releaseVersion,
              ),
              detail: `status=${response.statusCode ?? "unknown"} version=${payload?.version ?? "unknown"} runtimeSource=${payload?.runtimeSource ?? "unknown"}`,
            });
          } catch (error) {
            resolve({ ok: false, detail: `invalid health payload: ${error.message}` });
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Gateway health probe timed out")));
    request.on("error", (error) => resolve({ ok: false, detail: error.message }));
  });
}

async function verifyGatewayHealth(spec, timeoutMs = 120_000) {
  const cliEntrypoint = path.join(spec.runtimeDir, "fased.mjs");
  if (!fs.existsSync(cliEntrypoint)) {
    fail("protected Local application runtime has no CLI entrypoint");
  }
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "Gateway health endpoint was unavailable";
  while (Date.now() < deadline) {
    const result = await probeGatewayHealth(spec);
    if (result.ok) {
      return;
    }
    lastDetail = result.detail;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(
    `protected Local Gateway health did not match ${spec.releaseVersion} on 127.0.0.1:${spec.gatewayPort} within ${timeoutMs}ms (${lastDetail})`,
  );
}

async function removeLegacySignerMaterial(legacy) {
  for (const candidate of [
    legacy.stateDbPath,
    legacy.masterKeyPath,
    legacy.auditPath,
    legacy.pidPath,
    legacy.controlSocketPath,
  ]) {
    await fsp.rm(candidate, { force: true });
  }
  await fsyncDirectory(legacy.materialDir).catch((error) => {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  });
}

async function restoreLegacySignerMaterial(transaction) {
  if (!transaction.migrated) {
    return;
  }
  const { legacy, layout, spec } = transaction;
  for (const [source, destination] of [
    [path.join(layout.signerStateDir, "state.db"), legacy.stateDbPath],
    [path.join(layout.signerStateDir, "master.key"), legacy.masterKeyPath],
  ]) {
    await atomicCopy(source, destination, 0o600, {
      uid: spec.operatorUid,
      gid: spec.operatorGid,
    });
  }
  if (fs.existsSync(layout.auditLog)) {
    await atomicCopy(layout.auditLog, legacy.auditPath, 0o600, {
      uid: spec.operatorUid,
      gid: spec.operatorGid,
    });
  }
}

async function restoreLegacyLocalStateBoundary(transaction) {
  const { spec, legacy } = transaction;
  const chown = systemBinary(["/usr/bin/chown", "/bin/chown"], "chown");
  const chmod = systemBinary(["/usr/bin/chmod", "/bin/chmod"], "chmod");
  runSystem(chown, ["-R", `${spec.operatorUid}:${spec.operatorGid}`, spec.stateDir]);
  runSystem(chmod, ["-R", "g-rwx,o-rwx", spec.stateDir]);
  await fsp.chown(spec.stateDir, spec.operatorUid, spec.operatorGid);
  await fsp.chmod(spec.stateDir, 0o700);
  if (fs.existsSync(legacy.materialDir)) {
    await fsp.chown(legacy.materialDir, spec.operatorUid, spec.operatorGid);
    await fsp.chmod(legacy.materialDir, 0o700);
  }
  await protectLegacyMaterial(legacy, spec);
}

async function captureFile(filePath) {
  try {
    const info = await fsp.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      fail(`transaction input is not a safe regular file: ${filePath}`);
    }
    return {
      existed: true,
      content: await fsp.readFile(filePath),
      mode: info.mode & 0o777,
      uid: info.uid,
      gid: info.gid,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { existed: false };
    }
    throw error;
  }
}

async function restoreCapturedFile(filePath, captured) {
  if (!captured.existed) {
    await fsp.rm(filePath, { force: true });
    return;
  }
  await atomicWrite(filePath, captured.content, captured.mode, {
    uid: captured.uid,
    gid: captured.gid,
  });
}

function serializeCapture(captured) {
  return captured.existed
    ? {
        existed: true,
        contentBase64: captured.content.toString("base64"),
        mode: captured.mode,
        uid: captured.uid,
        gid: captured.gid,
      }
    : { existed: false };
}

function captureDirectoryMetadata(directory, expectedUID) {
  const info = fs.lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== expectedUID ||
    (info.mode & 0o022) !== 0
  ) {
    fail("protected Local operator home ownership or mode is unsafe");
  }
  return Object.freeze({
    uid: info.uid,
    gid: info.gid,
    mode: info.mode & 0o777,
  });
}

async function allowGatewayHomeTraversal(spec, configGroup) {
  await fsp.chown(spec.operatorHome, spec.operatorUid, configGroup.gid);
  await fsp.chmod(spec.operatorHome, 0o710);
}

function deserializeCapture(captured) {
  if (captured?.existed !== true) {
    return { existed: false };
  }
  if (
    typeof captured.contentBase64 !== "string" ||
    !Number.isSafeInteger(captured.mode) ||
    !Number.isSafeInteger(captured.uid) ||
    !Number.isSafeInteger(captured.gid)
  ) {
    fail("protected Local bootstrap journal has an invalid file snapshot");
  }
  return {
    existed: true,
    content: Buffer.from(captured.contentBase64, "base64"),
    mode: captured.mode,
    uid: captured.uid,
    gid: captured.gid,
  };
}

async function persistBootstrapTransaction(transaction, phase) {
  const journalPath = path.join(transaction.layout.stateDir, "bootstrap-transaction.json");
  await fsp.mkdir(transaction.layout.stateDir, { recursive: true, mode: 0o755 });
  await fsp.chown(transaction.layout.stateDir, 0, 0);
  await fsp.chmod(transaction.layout.stateDir, 0o755);
  await atomicWrite(
    journalPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        phase,
        instanceId: transaction.layout.instanceId,
        spec: transaction.spec,
        registryPath: transaction.registryPath,
        allocationCreated: transaction.allocationCreated,
        configSnapshot: serializeCapture(transaction.configSnapshot),
        manifestSnapshot: serializeCapture(transaction.manifestSnapshot),
        homeSnapshot: transaction.homeSnapshot,
        groups: transaction.groups,
        users: transaction.users,
        legacyGatewayWasActive: transaction.legacyGatewayWasActive,
        migrated: transaction.migrated === true,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    0o600,
    { uid: 0, gid: 0 },
  );
}

function readBootstrapTransaction(layout, spec, registryPath) {
  const journalPath = path.join(layout.stateDir, "bootstrap-transaction.json");
  let value;
  try {
    value = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (
    value?.schemaVersion !== 1 ||
    typeof value.phase !== "string" ||
    value.instanceId !== layout.instanceId ||
    value.registryPath !== registryPath ||
    value.spec?.operatorUid !== spec.operatorUid ||
    value.spec?.operatorUser !== spec.operatorUser ||
    value.spec?.operatorGid !== spec.operatorGid ||
    value.spec?.operatorHome !== spec.operatorHome ||
    value.spec?.stateDir !== spec.stateDir ||
    value.spec?.runtimeDir !== spec.runtimeDir ||
    value.spec?.nodeBinary !== spec.nodeBinary ||
    value.spec?.releaseVersion !== spec.releaseVersion ||
    value.spec?.releaseCommit !== spec.releaseCommit ||
    value.spec?.updateChannel !== spec.updateChannel ||
    value.spec?.gatewayPort !== spec.gatewayPort ||
    value.spec?.profile !== spec.profile ||
    value.homeSnapshot?.uid !== spec.operatorUid ||
    !Number.isSafeInteger(value.homeSnapshot?.gid) ||
    !Number.isSafeInteger(value.homeSnapshot?.mode)
  ) {
    fail("protected Local bootstrap journal does not match this operator instance");
  }
  const configSnapshot = deserializeCapture(value.configSnapshot);
  const originalConfig = configSnapshot.existed
    ? JSON.parse(configSnapshot.content.toString("utf8"))
    : {};
  return {
    phase: value.phase,
    spec: { ...value.spec, gatewayMode: spec.gatewayMode },
    layout,
    registryPath,
    allocationCreated: value.allocationCreated === true,
    configSnapshot,
    manifestSnapshot: deserializeCapture(value.manifestSnapshot),
    homeSnapshot: value.homeSnapshot,
    groups: value.groups && typeof value.groups === "object" ? value.groups : {},
    users: value.users && typeof value.users === "object" ? value.users : {},
    legacyGatewayWasActive: value.legacyGatewayWasActive === true,
    migrated: value.migrated === true,
    legacy: resolveLegacySignerPaths(spec, originalConfig),
  };
}

function userSystemctl(spec, args, options = {}) {
  const runuser = systemBinary(["/usr/sbin/runuser", "/sbin/runuser"], "runuser");
  const systemctl = systemBinary(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
  const environment = [
    `XDG_RUNTIME_DIR=/run/user/${spec.operatorUid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${spec.operatorUid}/bus`,
  ];
  try {
    return runSystem(runuser, [
      "-u",
      spec.operatorUser,
      "--",
      "/usr/bin/env",
      ...environment,
      systemctl,
      "--user",
      ...args,
    ]);
  } catch (error) {
    if (options.allowUnavailable) {
      return "";
    }
    throw error;
  }
}

function userServiceActive(spec, unit) {
  try {
    userSystemctl(spec, ["is-active", "--quiet", unit]);
    return true;
  } catch {
    return false;
  }
}

async function stopLegacySameUserSigner(spec, legacy) {
  let pid;
  try {
    pid = Number.parseInt((await fsp.readFile(legacy.pidPath, "utf8")).trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    fail("legacy signer PID file is invalid");
  }
  let processInfo;
  try {
    processInfo = await fsp.stat(`/proc/${pid}`);
  } catch (error) {
    if (error?.code === "ENOENT") {
      await fsp.rm(legacy.pidPath, { force: true });
      return false;
    }
    throw error;
  }
  const executable = await fsp.realpath(`/proc/${pid}/exe`);
  if (
    processInfo.uid !== spec.operatorUid ||
    path.basename(executable) !== "fased-signerd" ||
    (!executable.startsWith(`${spec.stateDir}${path.sep}`) &&
      !executable.startsWith(`${spec.operatorHome}${path.sep}`))
  ) {
    fail("legacy signer PID does not identify the operator-owned fased-signerd process");
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      await fsp.rm(legacy.pidPath, { force: true });
      return true;
    }
  }
  fail("legacy signer did not stop before custody migration");
}

function assertFreshAllocationUnclaimed(layout) {
  for (const group of [
    layout.gatewayGroup,
    layout.signerGroup,
    layout.operatorGroup,
    layout.configGroup,
  ]) {
    if (groupRecord(group)) {
      fail(`protected Local service group collision: ${group}`);
    }
  }
  for (const user of [layout.gatewayUser, layout.signerUser]) {
    if (passwdRecord(user)) {
      fail(`protected Local service account collision: ${user}`);
    }
  }
  for (const candidate of [
    layout.runtimeDir,
    `/run/fased-local-controller/${layout.instanceId}`,
    layout.stateDir,
    layout.installDir,
    `/etc/fased/local/${layout.instanceId}`,
    `/etc/systemd/system/${layout.gatewayUnit}`,
    `/etc/systemd/system/${layout.signerUnit}`,
    `/etc/systemd/system/${layout.controllerUnit}`,
    `/usr/local/sbin/fased-local-signer-owner-${layout.instanceId}`,
  ]) {
    if (fs.existsSync(candidate)) {
      fail(`protected Local privileged path collision: ${candidate}`);
    }
  }
}

function removeUserFromGroup(user, group) {
  const gpasswd = systemBinary(["/usr/bin/gpasswd", "/bin/gpasswd"], "gpasswd");
  try {
    runSystem(gpasswd, ["--delete", user, group]);
  } catch {
    // Membership may already have been removed during retry cleanup.
  }
}

function deleteServiceUser(user) {
  const userdel = systemBinary(["/usr/sbin/userdel", "/sbin/userdel"], "userdel");
  try {
    runSystem(userdel, [user]);
  } catch {
    // A partially created identity may already be absent.
  }
}

function deleteGroup(group) {
  const groupdel = systemBinary(["/usr/sbin/groupdel", "/sbin/groupdel"], "groupdel");
  try {
    runSystem(groupdel, [group]);
  } catch {
    // A partially created group may already be absent.
  }
}

async function rollbackBootstrapTransaction(transaction, originalError, options = {}) {
  const failures = [];
  const attempt = async (label, action) => {
    try {
      await action();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const { spec, layout } = transaction;
  const systemctl = systemBinary(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
  await attempt("candidate service stop", async () => {
    for (const unit of [layout.gatewayUnit, layout.signerUnit, layout.controllerUnit]) {
      try {
        runSystem(systemctl, ["disable", "--now", unit]);
      } catch {
        // A unit may not have reached installation.
      }
    }
  });
  await attempt("legacy signer material restore", async () =>
    restoreLegacySignerMaterial(transaction),
  );
  await attempt("legacy Local state boundary restore", async () =>
    restoreLegacyLocalStateBoundary(transaction),
  );
  await attempt("operator config restore", async () =>
    restoreCapturedFile(path.join(spec.stateDir, "fased.json"), transaction.configSnapshot),
  );
  await attempt("managed manifest restore", async () =>
    restoreCapturedFile(path.join(spec.stateDir, "install.json"), transaction.manifestSnapshot),
  );
  await attempt("operator home metadata restore", async () => {
    await fsp.chown(spec.operatorHome, transaction.homeSnapshot.uid, transaction.homeSnapshot.gid);
    await fsp.chmod(spec.operatorHome, transaction.homeSnapshot.mode);
  });
  await attempt("candidate unit removal", async () => {
    for (const unitPath of [
      `/etc/systemd/system/${layout.gatewayUnit}`,
      `/etc/systemd/system/${layout.signerUnit}`,
      `/etc/systemd/system/${layout.controllerUnit}`,
    ]) {
      await fsp.rm(unitPath, { force: true });
    }
    await fsp.rm(`/usr/local/sbin/fased-local-signer-owner-${layout.instanceId}`, {
      force: true,
    });
    await fsp.rm(`/etc/fased/local/${layout.instanceId}`, {
      recursive: true,
      force: true,
    });
    runSystem(systemctl, ["daemon-reload"]);
  });
  if (transaction.allocationCreated) {
    await attempt("candidate state removal", async () => {
      await fsp.rm(layout.installDir, { recursive: true, force: true });
      await fsp.rm(layout.stateDir, { recursive: true, force: true });
      removeProtectedLocalInstance({
        registryPath: transaction.registryPath,
        instanceId: layout.instanceId,
        expectedOwnerUid: 0,
      });
    });
  }
  await attempt("operator group rollback", async () => {
    if (transaction.groups.operator?.created) {
      removeUserFromGroup(spec.operatorUser, layout.operatorGroup);
    }
    if (transaction.groups.config?.created) {
      removeUserFromGroup(spec.operatorUser, layout.configGroup);
    }
  });
  await attempt("service identity rollback", async () => {
    if (transaction.users.gateway?.created) {
      deleteServiceUser(layout.gatewayUser);
    }
    if (transaction.users.signer?.created) {
      deleteServiceUser(layout.signerUser);
    }
    for (const [name, group] of [
      ["gateway", layout.gatewayGroup],
      ["signer", layout.signerGroup],
      ["operator", layout.operatorGroup],
      ["config", layout.configGroup],
    ]) {
      if (transaction.groups[name]?.created) {
        deleteGroup(group);
      }
    }
  });
  if (transaction.legacyGatewayWasActive) {
    await attempt("legacy Gateway restart", async () => {
      userSystemctl(spec, ["enable", "--now", "fased-gateway.service"], {
        allowUnavailable: false,
      });
    });
  }
  if (failures.length > 0) {
    throw new Error(
      `Protected Local bootstrap failed (${originalError.message}) and rollback is incomplete: ${failures.join("; ")}`,
      { cause: originalError },
    );
  }
  await fsp.rm(path.join(layout.stateDir, "bootstrap-transaction.json"), { force: true });
  if (options.returnResult === true) {
    return {
      schemaVersion: 1,
      profile: "protected-local",
      instanceId: layout.instanceId,
      rolledBack: true,
      restored: true,
    };
  }
  throw new Error(
    `Protected Local bootstrap failed and restored the prior Local topology: ${originalError.message}`,
    { cause: originalError },
  );
}

async function activatePreparedBootstrapTransaction(transaction) {
  const { spec, layout } = transaction;
  try {
    const configGroup = groupRecord(layout.configGroup);
    if (!configGroup) {
      fail("protected Local configuration group is missing during activation");
    }
    await shareApplicationState(spec, configGroup, transaction.legacy);
    await updateOperatorConfig(spec, layout, configGroup);
    await waitForSocket(layout.operatorSocket);
    await verifyOperatorCapabilities(spec, layout);
    const wallets = verifyLogicalWalletState(spec, layout);
    const systemctl = systemBinary(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
    runSystem(systemctl, ["restart", layout.gatewayUnit]);
    runSystem(systemctl, ["is-active", "--quiet", layout.gatewayUnit]);
    await verifyGatewayHealth(spec, spec.gatewayHealthTimeoutMs);
    await removeLegacySignerMaterial(transaction.legacy);
    userSystemctl(spec, ["disable", "fased-gateway.service"], { allowUnavailable: true });
    await fsp.rm(path.join(layout.stateDir, "bootstrap-transaction.json"), { force: true });
    await fsyncDirectory(layout.stateDir);
    return {
      schemaVersion: 1,
      profile: "protected-local",
      instanceId: layout.instanceId,
      created: transaction.allocationCreated,
      migrated: transaction.migrated,
      alreadyProtected: false,
      gatewayUnit: layout.gatewayUnit,
      signerUnit: layout.signerUnit,
      controllerUnit: layout.controllerUnit,
      gatewayMode: "activate",
      wallets,
      operatorEnvironment: renderProtectedLocalOperatorEnvironment({
        layout,
        stateDir: spec.stateDir,
      }),
    };
  } catch (error) {
    return await rollbackBootstrapTransaction(
      transaction,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

async function installProtectedLocal(params) {
  if (
    process.platform !== "linux" ||
    typeof process.getuid !== "function" ||
    process.getuid() !== 0
  ) {
    fail("protected Local bootstrap must run as root on Linux");
  }
  const spec = buildProtectedLocalBootstrapSpec(params);
  const sourceRoot = await validateVerifiedReleaseRoot(params.sourceRoot, spec);
  const signerBinary = cleanAbsolute(params.signerBinary, "verified signer binary");
  const rootStore = path.dirname(path.dirname(sourceRoot));
  const expectedSignerBinary = path.join(rootStore, "verified-assets", "fased-signerd");
  if (signerBinary !== expectedSignerBinary) {
    fail("verified signer binary is not bound to the selected attested release bundle");
  }
  const signerInfo = await fsp.lstat(signerBinary);
  if (
    !signerInfo.isFile() ||
    signerInfo.isSymbolicLink() ||
    signerInfo.uid !== 0 ||
    (signerInfo.mode & 0o022) !== 0
  ) {
    fail("verified signer binary must be root-owned and non-writable");
  }
  const marker = Object.fromEntries(
    (await fsp.readFile(path.join(sourceRoot, ".fased-hosting-bundle-verified"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return at > 0 ? [line.slice(0, at), line.slice(at + 1)] : ["", ""];
      }),
  );
  const signerDigest = crypto
    .createHash("sha256")
    .update(await fsp.readFile(signerBinary))
    .digest("hex");
  if (marker.signer_sha256 !== signerDigest) {
    fail("verified signer binary does not match the attested release marker");
  }
  verifySignerReleaseIdentity(signerBinary, spec);
  const nodeBinary = await fsp.realpath(spec.nodeBinary);
  const nodeInfo = await fsp.lstat(nodeBinary);
  if (
    nodeBinary !== spec.nodeBinary ||
    !nodeInfo.isFile() ||
    nodeInfo.isSymbolicLink() ||
    nodeInfo.uid !== 0 ||
    (nodeInfo.mode & 0o022) !== 0
  ) {
    fail("protected Local Node.js runtime must be an exact root-owned system binary");
  }
  const operator = passwdRecord(spec.operatorUser);
  if (
    !operator ||
    operator.uid !== spec.operatorUid ||
    operator.gid !== spec.operatorGid ||
    operator.home !== spec.operatorHome
  ) {
    fail("protected Local operator identity changed before privileged bootstrap");
  }
  const registryPath = "/var/lib/fased-local-registry/instances.json";
  await fsp.mkdir(path.dirname(registryPath), { recursive: true, mode: 0o700 });
  await fsp.chown(path.dirname(registryPath), 0, 0);
  await fsp.chmod(path.dirname(registryPath), 0o700);
  const allocated = loadOrAllocateProtectedLocalInstance({
    registryPath,
    operatorUid: spec.operatorUid,
    operatorUser: spec.operatorUser,
    profile: spec.profile,
    stateDir: spec.stateDir,
    expectedOwnerUid: 0,
  });
  const layout = allocated.layout;
  if (allocated.created) {
    try {
      assertFreshAllocationUnclaimed(layout);
    } catch (error) {
      removeProtectedLocalInstance({
        registryPath,
        instanceId: layout.instanceId,
        expectedOwnerUid: 0,
      });
      throw error;
    }
    await prepareProtectedLocalRootDirectories(layout);
  }
  const interrupted = readBootstrapTransaction(layout, spec, registryPath);
  if (interrupted) {
    if (interrupted.phase === "prepared-awaiting-onboarding") {
      if (spec.gatewayMode === "rollback") {
        const result = await rollbackBootstrapTransaction(
          interrupted,
          new Error("onboarding did not complete"),
          { returnResult: true },
        );
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return result;
      }
      if (spec.gatewayMode === "activate") {
        const result = await activatePreparedBootstrapTransaction(interrupted);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return result;
      }
      await waitForSocket(layout.operatorSocket);
      await verifyOperatorCapabilities(spec, layout);
      const result = {
        schemaVersion: 1,
        profile: "protected-local",
        instanceId: layout.instanceId,
        created: interrupted.allocationCreated,
        migrated: interrupted.migrated,
        prepared: true,
        gatewayMode: "prepare",
        operatorEnvironment: renderProtectedLocalOperatorEnvironment({
          layout,
          stateDir: spec.stateDir,
        }),
      };
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result;
    }
    try {
      const result = await rollbackBootstrapTransaction(
        interrupted,
        new Error("recovering an interrupted protected Local bootstrap"),
        { returnResult: spec.gatewayMode === "rollback" },
      );
      if (spec.gatewayMode === "rollback") {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return result;
      }
    } catch (error) {
      if (/restored the prior Local topology/u.test(String(error?.message ?? ""))) {
        return await installProtectedLocal(params);
      }
      throw error;
    }
  }
  if (spec.gatewayMode === "rollback") {
    fail("protected Local rollback was requested without an active bootstrap transaction");
  }
  if (!allocated.created) {
    const existingConfig = parseConfig(path.join(spec.stateDir, "fased.json"));
    if (
      existingConfig.env?.vars?.FASED_PROTECTED_LOCAL === "1" &&
      existingConfig.env?.vars?.FASED_PROTECTED_LOCAL_INSTANCE === layout.instanceId
    ) {
      const configGroup = groupRecord(layout.configGroup);
      if (!configGroup) {
        fail("protected Local configuration group is missing");
      }
      await shareApplicationState(spec, configGroup, resolveLegacySignerPaths(spec, {}));
      await updateOperatorConfig(spec, layout, configGroup);
      await waitForSocket(layout.operatorSocket);
      await verifyOperatorCapabilities(spec, layout);
      const wallets = verifyLogicalWalletState(spec, layout);
      if (spec.gatewayMode === "activate") {
        const systemctl = systemBinary(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
        runSystem(systemctl, ["restart", layout.gatewayUnit]);
        runSystem(systemctl, ["is-active", "--quiet", layout.gatewayUnit]);
        await verifyGatewayHealth(spec, spec.gatewayHealthTimeoutMs);
      }
      const result = {
        schemaVersion: 1,
        profile: "protected-local",
        instanceId: layout.instanceId,
        created: false,
        migrated: true,
        alreadyProtected: true,
        gatewayUnit: layout.gatewayUnit,
        signerUnit: layout.signerUnit,
        controllerUnit: layout.controllerUnit,
        gatewayMode: spec.gatewayMode,
        wallets,
        operatorEnvironment: renderProtectedLocalOperatorEnvironment({
          layout,
          stateDir: spec.stateDir,
        }),
      };
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result;
    }
    fail(
      "protected Local instance exists without a recoverable bootstrap journal or matching active configuration",
    );
  }
  const transaction = {
    spec,
    layout,
    registryPath,
    allocationCreated: allocated.created,
    configSnapshot: await captureFile(path.join(spec.stateDir, "fased.json")),
    manifestSnapshot: await captureFile(path.join(spec.stateDir, "install.json")),
    homeSnapshot: captureDirectoryMetadata(spec.operatorHome, spec.operatorUid),
    groups: {},
    users: {},
    legacyGatewayWasActive: false,
    migrated: false,
    legacy: null,
  };
  try {
    await persistBootstrapTransaction(transaction, "allocated");
    transaction.groups.gateway = ensureGroup(layout.gatewayGroup);
    transaction.groups.signer = ensureGroup(layout.signerGroup);
    transaction.groups.operator = ensureGroup(layout.operatorGroup);
    transaction.groups.config = ensureGroup(layout.configGroup);
    await persistBootstrapTransaction(transaction, "groups-created");
    transaction.users.gateway = ensureServiceUser(
      layout.gatewayUser,
      transaction.groups.gateway.group,
      layout.stateDir,
    );
    transaction.users.signer = ensureServiceUser(
      layout.signerUser,
      transaction.groups.signer.group,
      layout.signerStateDir,
    );
    await persistBootstrapTransaction(transaction, "users-created");
    addGroups(spec.operatorUser, [layout.operatorGroup, layout.configGroup]);
    addGroups(layout.gatewayUser, [layout.configGroup]);
    addGroups(layout.signerUser, [layout.gatewayGroup, layout.operatorGroup]);
    await allowGatewayHomeTraversal(spec, transaction.groups.config);
    assertPrincipalSeparation(spec, layout);
    const servicePlan = buildProtectedLocalServicePlan({
      instanceId: layout.instanceId,
      operatorUid: spec.operatorUid,
      operatorUser: spec.operatorUser,
      operatorHome: spec.operatorHome,
      appStateDir: spec.stateDir,
      repoDir: layout.applicationCurrentLink,
      gatewayUid: transaction.users.gateway.uid,
      signerUid: transaction.users.signer.uid,
      gatewayGid: transaction.groups.gateway.gid,
      operatorGid: transaction.groups.operator.gid,
      nodeBinary: spec.nodeBinary,
      gatewayPort: spec.gatewayPort,
    });
    const config = parseConfig(path.join(spec.stateDir, "fased.json"));
    const legacy = resolveLegacySignerPaths(spec, config);
    transaction.legacy = legacy;
    transaction.legacyGatewayWasActive = userServiceActive(spec, "fased-gateway.service");
    userSystemctl(spec, ["stop", "fased-gateway.service"], { allowUnavailable: true });
    await stopLegacySameUserSigner(spec, legacy);
    await persistBootstrapTransaction(transaction, "legacy-quiesced");
    await installRootFiles({
      sourceRoot,
      signerBinary,
      spec,
      layout,
      servicePlan,
      signerIdentity: transaction.users.signer,
    });
    const migrated = await copyLegacyMaterial(legacy, layout, transaction.users.signer);
    transaction.migrated = migrated.migrated;
    await shareApplicationState(spec, transaction.groups.config, legacy);
    await persistBootstrapTransaction(transaction, "candidate-installed");
    await updateOperatorConfig(spec, layout, transaction.groups.config);
    await persistBootstrapTransaction(transaction, "application-configured");
    const systemctl = systemBinary(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
    runSystem(systemctl, ["daemon-reload"]);
    runSystem(systemctl, ["enable", layout.controllerUnit, layout.signerUnit, layout.gatewayUnit]);
    runSystem(systemctl, ["restart", layout.controllerUnit]);
    runSystem(systemctl, ["restart", layout.signerUnit]);
    await waitForSocket(layout.operatorSocket);
    await verifyOperatorCapabilities(spec, layout);
    const wallets = verifyLogicalWalletState(spec, layout);
    runSystem(systemctl, ["restart", layout.gatewayUnit]);
    if (spec.gatewayMode === "activate") {
      runSystem(systemctl, ["is-active", "--quiet", layout.gatewayUnit]);
      await verifyGatewayHealth(spec, spec.gatewayHealthTimeoutMs);
      await removeLegacySignerMaterial(legacy);
      userSystemctl(spec, ["disable", "fased-gateway.service"], { allowUnavailable: true });
      await fsp.rm(path.join(layout.stateDir, "bootstrap-transaction.json"), { force: true });
      await fsyncDirectory(layout.stateDir);
    } else {
      await persistBootstrapTransaction(transaction, "prepared-awaiting-onboarding");
    }
    const result = {
      schemaVersion: 1,
      profile: "protected-local",
      instanceId: layout.instanceId,
      created: allocated.created,
      migrated: migrated.migrated,
      gatewayUnit: layout.gatewayUnit,
      signerUnit: layout.signerUnit,
      controllerUnit: layout.controllerUnit,
      gatewayMode: spec.gatewayMode,
      prepared: spec.gatewayMode === "prepare",
      wallets,
      operatorEnvironment: renderProtectedLocalOperatorEnvironment({
        layout,
        stateDir: spec.stateDir,
      }),
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    return await rollbackBootstrapTransaction(
      transaction,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

function parseCLI(argv) {
  if (argv.length === 1 && argv[0] === "--self-check") {
    return { selfCheck: true };
  }
  if (argv[0] !== "install") {
    fail(
      "usage: protected-local-bootstrap.mjs install --source-root PATH --signer-binary PATH --operator-user USER --operator-uid UID --operator-gid GID --operator-home PATH --state-dir PATH --runtime-dir PATH --node-binary PATH --release-version X.Y.Z --release-commit SHA --update-channel stable|beta --profile NAME --gateway-port PORT --gateway-mode prepare|activate|rollback",
    );
  }
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || Object.hasOwn(values, flag)) {
      fail(`invalid or duplicate protected Local bootstrap argument: ${flag ?? ""}`);
    }
    values[flag] = value;
  }
  const required = new Set([
    "--source-root",
    "--signer-binary",
    "--operator-user",
    "--operator-uid",
    "--operator-gid",
    "--operator-home",
    "--state-dir",
    "--runtime-dir",
    "--node-binary",
    "--release-version",
    "--release-commit",
    "--update-channel",
    "--profile",
    "--gateway-port",
    "--gateway-mode",
  ]);
  const supported = new Set([...required, "--gateway-health-timeout-ms"]);
  for (const flag of Object.keys(values)) {
    if (!supported.has(flag)) {
      fail(`unsupported protected Local bootstrap argument: ${flag}`);
    }
  }
  if ([...required].some((flag) => !Object.hasOwn(values, flag))) {
    fail("protected Local bootstrap is missing a required fixed input");
  }
  return {
    sourceRoot: values["--source-root"],
    signerBinary: values["--signer-binary"],
    operatorUser: values["--operator-user"],
    operatorUid: values["--operator-uid"],
    operatorGid: values["--operator-gid"],
    operatorHome: values["--operator-home"],
    stateDir: values["--state-dir"],
    runtimeDir: values["--runtime-dir"],
    nodeBinary: values["--node-binary"],
    releaseVersion: values["--release-version"],
    releaseCommit: values["--release-commit"],
    updateChannel: values["--update-channel"],
    profile: values["--profile"],
    gatewayPort: values["--gateway-port"],
    gatewayMode: values["--gateway-mode"],
    gatewayHealthTimeoutMs: values["--gateway-health-timeout-ms"],
  };
}

async function main() {
  const options = parseCLI(process.argv.slice(2));
  if (options.selfCheck) {
    process.stdout.write('{"schemaVersion":1,"role":"protected-local-bootstrap"}\n');
    return;
  }
  await installProtectedLocal(options);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `protected-local-bootstrap: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

export const __testing = Object.freeze({
  buildProtectedLocalBootstrapSpec,
  hardenOperatorRuntime,
  renderProtectedLocalOperatorEnvironment,
  renderProtectedLocalOwnerWrapper,
  registeredSignerWallets,
  removeLegacySignerMaterial,
  resolveTrustedLegacyRuntimeHardlinks,
  resolveLegacySignerPaths,
  protectedLocalGatewayHealthMatches,
  verifySignerReleaseIdentity,
  buildControllerIdentity,
});
