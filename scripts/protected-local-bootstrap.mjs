#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
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
    input: options.input,
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
  const existingToken =
    typeof config.gateway?.auth?.token === "string" ? config.gateway.auth.token.trim() : "";
  const gatewayToken =
    existingToken && existingToken.length <= 4096
      ? existingToken
      : crypto.randomBytes(32).toString("hex");
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
    gateway: {
      ...config.gateway,
      mode: "local",
      bind: "loopback",
      port: spec.gatewayPort,
      auth: {
        ...config.gateway?.auth,
        mode: "token",
        token: gatewayToken,
      },
    },
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
  grantOperatorApplicationStateAccess(spec);
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
  const controllerIdentity = buildControllerIdentity(spec.releaseVersion, serverBytes, clientBytes);
  await atomicWrite(
    path.join(layout.controllerStateDir, "controller-version.json"),
    `${JSON.stringify(controllerIdentity, null, 2)}\n`,
    0o600,
    { uid: 0, gid: 0 },
  );
  await atomicWrite(
    path.join(layout.supervisorStateDir, "controller-version.json"),
    `${JSON.stringify(controllerIdentity, null, 2)}\n`,
    0o600,
    { uid: 0, gid: 0 },
  );
  await atomicWrite(
    path.join(layout.supervisorStateDir, "rollback-floor"),
    `${spec.releaseVersion}\n`,
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

async function inspectInstalledPluginTree(pluginRoot, spec) {
  const canonicalRoot = await fsp.realpath(pluginRoot);
  const extensionsRoot = path.join(spec.stateDir, "extensions");
  assertPathBelow(extensionsRoot, canonicalRoot, "protected Local plugin");
  const rootInfo = await fsp.lstat(canonicalRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail(`protected Local plugin root is unsafe: ${pluginRoot}`);
  }
  const pending = [canonicalRoot];
  const entries = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    const candidate = pending.pop();
    const info = await fsp.lstat(candidate);
    entries.push({ candidate, info });
    if (entries.length > 200_000) {
      fail(`protected Local plugin tree is too large: ${pluginRoot}`);
    }
    if (info.isSymbolicLink()) {
      const target = await fsp.realpath(candidate);
      const relative = path.relative(canonicalRoot, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        fail(`protected Local plugin symlink escapes its root: ${candidate}`);
      }
      continue;
    }
    if (info.isDirectory()) {
      for (const child of await fsp.readdir(candidate)) {
        pending.push(path.join(candidate, child));
      }
      continue;
    }
    if (!info.isFile() || info.nlink !== 1) {
      fail(`protected Local plugin contains an unsafe entry: ${candidate}`);
    }
    totalBytes += info.size;
    if (totalBytes > 2 * 1024 * 1024 * 1024) {
      fail(`protected Local plugin tree exceeds the size limit: ${pluginRoot}`);
    }
  }
  return { canonicalRoot, entries };
}

async function hardenInstalledPlugins(spec) {
  const config = parseConfig(path.join(spec.stateDir, "fased.json"));
  const installs = config.plugins?.installs ?? {};
  const extensionsRoot = path.join(spec.stateDir, "extensions");
  const trees = [];
  for (const [pluginId, install] of Object.entries(installs).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(pluginId)) {
      fail(`configured plugin ID is unsafe: ${pluginId}`);
    }
    const installPath = String(install?.installPath ?? "").trim();
    if (!installPath || !fs.existsSync(installPath)) {
      fail(`configured plugin ${pluginId} has no installed runtime to migrate`);
    }
    if (install?.source !== "npm" || !String(install?.integrity ?? "").trim()) {
      fail(
        `configured plugin ${pluginId} is not a pinned npm installation and cannot enter Protected Local`,
      );
    }
    const expectedPath = path.join(extensionsRoot, pluginId);
    if (path.resolve(installPath) !== expectedPath) {
      fail(`configured plugin ${pluginId} is outside the managed extensions directory`);
    }
    const packageManifest = parseConfig(path.join(installPath, "package.json"));
    if (!String(packageManifest.name ?? "").trim() || packageManifest.version !== install.version) {
      fail(`configured plugin ${pluginId} does not match its recorded package identity`);
    }
    trees.push(await inspectInstalledPluginTree(installPath, spec));
  }
  if (trees.length === 0) {
    return;
  }
  for (const tree of trees) {
    for (const { candidate, info } of tree.entries.toReversed()) {
      if (info.isSymbolicLink()) {
        await fsp.lchown(candidate, 0, 0);
      } else {
        await fsp.chown(candidate, 0, 0);
        await fsp.chmod(candidate, info.isDirectory() ? 0o755 : info.mode & 0o111 ? 0o755 : 0o644);
      }
    }
  }
  await fsp.chown(extensionsRoot, 0, 0);
  await fsp.chmod(extensionsRoot, 0o755);
}

async function shareApplicationState(spec, configGroup, legacy) {
  const trustedHardlinks = await resolveTrustedLegacyRuntimeHardlinks(spec);
  await fsp.mkdir(spec.stateDir, { recursive: true, mode: 0o2770 });
  const chown = systemBinary(["/usr/bin/chown", "/bin/chown"], "chown");
  const chmod = systemBinary(["/usr/bin/chmod", "/bin/chmod"], "chmod");
  const find = systemBinary(["/usr/bin/find", "/bin/find"], "find");
  runSystem(chown, ["-R", `${spec.operatorUid}:${configGroup.gid}`, spec.stateDir]);
  runSystem(chmod, ["-R", "g+rwX,o-rwx", spec.stateDir]);
  runSystem(find, [spec.stateDir, "-type", "d", "-exec", chmod, "g+s", "{}", "+"]);
  for (const protectedRuntimePath of [
    path.join(spec.stateDir, "runtime"),
    path.join(spec.stateDir, "updater"),
    path.join(spec.stateDir, "bin"),
  ]) {
    await hardenOperatorRuntime(protectedRuntimePath, spec, new Set(), trustedHardlinks);
  }
  await hardenInstalledPlugins(spec);
  await protectLegacyMaterial(legacy, spec);
}

const PROTECTED_LOCAL_OPERATOR_ONLY_STATE = new Set([
  "backups",
  "bin",
  "extensions",
  "install-cache",
  "runtime",
  "signer-update",
  "source-paired-update",
  "updater",
]);

function grantOperatorApplicationStateAccess(spec) {
  const setfacl = systemBinary(["/usr/bin/setfacl", "/bin/setfacl"], "setfacl");
  const find = systemBinary(["/usr/bin/find", "/bin/find"], "find");
  const operatorEntry = `user:${spec.operatorUid}`;
  runSystem(setfacl, ["--modify", `${operatorEntry}:rwx,group::rwx`, "--", spec.stateDir]);
  runSystem(setfacl, [
    "--modify",
    `default:${operatorEntry}:rwx,default:group::rwx`,
    "--",
    spec.stateDir,
  ]);
  for (const name of fs
    .readdirSync(spec.stateDir)
    .filter((entry) => !PROTECTED_LOCAL_OPERATOR_ONLY_STATE.has(entry))) {
    const sharedRoot = path.join(spec.stateDir, name);
    runSystem(find, [
      "-P",
      sharedRoot,
      "-xdev",
      "-type",
      "d",
      "-exec",
      setfacl,
      "--modify",
      `${operatorEntry}:rwx,group::rwx,default:${operatorEntry}:rwx,default:group::rwx`,
      "--",
      "{}",
      "+",
    ]);
    runSystem(find, [
      "-P",
      sharedRoot,
      "-xdev",
      "-type",
      "f",
      "-exec",
      setfacl,
      "--modify",
      `${operatorEntry}:rw-,group::rw-`,
      "--",
      "{}",
      "+",
    ]);
  }
  for (const directory of sharedApplicationStateDirectoriesForAclVerification(spec)) {
    const entries = aclEntryMap(captureDirectoryAcl(directory));
    if (
      entries.get(`user:${spec.operatorUid}:`) !== "rwx" ||
      entries.get(`default:user:${spec.operatorUid}:`) !== "rwx" ||
      entries.get("group::") !== "rwx" ||
      entries.get("default:group::") !== "rwx"
    ) {
      fail(`protected Local operator ACL did not converge: ${directory}`);
    }
  }
  const configEntries = aclEntryMap(captureDirectoryAcl(path.join(spec.stateDir, "fased.json")));
  if (
    !new Set(["rw-", "rwx"]).has(configEntries.get(`user:${spec.operatorUid}:`)) ||
    !new Set(["rw-", "rwx"]).has(configEntries.get("group::"))
  ) {
    fail("protected Local operator cannot read and update application configuration");
  }
}

function sharedApplicationStateDirectoriesForAclVerification(spec) {
  const directories = [spec.stateDir];
  for (const name of ["identity", "wallet", "federation"]) {
    const directory = path.join(spec.stateDir, name);
    let stat;
    try {
      stat = fs.lstatSync(directory);
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(`protected Local shared application state is not a directory: ${directory}`);
    }
    directories.push(directory);
  }
  return directories;
}

async function installRootFiles(params) {
  const { sourceRoot, spec, layout, servicePlan, signerIdentity } = params;
  await fsp.mkdir(path.dirname(layout.signerBinary), { recursive: true, mode: 0o755 });
  await fsp.mkdir(path.dirname(layout.supervisorBinary), {
    recursive: true,
    mode: 0o755,
  });
  for (const directory of [
    layout.installDir,
    path.dirname(layout.signerBinary),
    path.dirname(layout.supervisorBinary),
  ]) {
    await fsp.chown(directory, 0, 0);
    await fsp.chmod(directory, 0o755);
  }
  await atomicCopy(
    path.join(sourceRoot, "scripts", "fased-lifecycle-supervisor.mjs"),
    layout.supervisorBinary,
    0o755,
    { uid: 0, gid: 0 },
  );
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
    activate: false,
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
  const channelDirectory = await prepareProtectedLocalChannelDirectory(layout);
  const channelPath = path.join(channelDirectory, "update-channel");
  await atomicWrite(channelPath, `${spec.updateChannel}\n`, 0o644, { uid: 0, gid: 0 });
  await fsp.mkdir(layout.signerStateDir, { recursive: true, mode: 0o700 });
  await fsp.chown(layout.signerStateDir, signerIdentity.uid, signerIdentity.gid);
  await fsp.chmod(layout.signerStateDir, 0o700);
  await fsp.mkdir(layout.controllerStateDir, { recursive: true, mode: 0o711 });
  await fsp.chown(layout.controllerStateDir, 0, 0);
  await fsp.chmod(layout.controllerStateDir, 0o711);
  await fsp.mkdir(layout.supervisorStateDir, { recursive: true, mode: 0o700 });
  await fsp.chown(layout.supervisorStateDir, 0, 0);
  await fsp.chmod(layout.supervisorStateDir, 0o700);
}

async function prepareProtectedLocalChannelDirectory(layout, options = {}) {
  const root = options.root ?? "/etc/fased/local";
  const expectedOwnerUid = options.expectedOwnerUid ?? 0;
  const directory = path.join(root, layout.instanceId);
  await fsp.mkdir(directory, { recursive: true, mode: 0o755 });
  const info = await fsp.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== expectedOwnerUid) {
    fail(`protected Local update-channel directory is unsafe: ${directory}`);
  }
  await fsp.chmod(directory, 0o755);
  return directory;
}

export function buildProtectedLocalLifecycleApplyCommand(spec, layout, options = {}) {
  return Object.freeze({
    executable:
      options.runuserPath ?? systemBinary(["/usr/sbin/runuser", "/sbin/runuser"], "runuser"),
    args: Object.freeze([
      "-u",
      spec.operatorUser,
      "--",
      "/usr/bin/env",
      "-i",
      `HOME=${spec.operatorHome}`,
      `USER=${spec.operatorUser}`,
      `LOGNAME=${spec.operatorUser}`,
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      `FASED_HOST_UPDATER_SOCKET=/run/fased-local-controller/${layout.instanceId}/request.sock`,
      `FASED_HOST_UPDATERCTL_STATE=${path.join(
        spec.stateDir,
        "protected-local-controller-transaction.json",
      )}`,
      spec.nodeBinary,
      path.join(layout.installDir, "controller", "current", "fased-host-updaterctl.mjs"),
      spec.releaseVersion,
      "--apply",
    ]),
  });
}

async function transitionExistingSupervisorBoundary(sourceRoot, spec, layout) {
  const targetSupervisor = path.join(sourceRoot, "scripts", "fased-lifecycle-supervisor.mjs");
  const targetDigest = crypto
    .createHash("sha256")
    .update(await fsp.readFile(targetSupervisor))
    .digest("hex");
  let installedDigest = null;
  try {
    const installedInfo = await fsp.lstat(layout.supervisorBinary);
    if (
      !installedInfo.isFile() ||
      installedInfo.isSymbolicLink() ||
      installedInfo.nlink !== 1 ||
      installedInfo.uid !== 0 ||
      (installedInfo.mode & 0o022) !== 0
    ) {
      fail("installed protected Local supervisor is not a protected root-owned file");
    }
    installedDigest = crypto
      .createHash("sha256")
      .update(await fsp.readFile(layout.supervisorBinary))
      .digest("hex");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const operatorGroup = groupRecord(layout.operatorGroup);
  if (!operatorGroup) {
    fail("protected Local operator group is missing during supervisor transition");
  }
  const systemctl = systemBinary(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
  const snapshots = new Map(
    await Promise.all(
      [
        layout.supervisorBinary,
        path.join("/etc/systemd/system", layout.controllerUnit),
        path.join("/etc/systemd/system", layout.supervisorUnit),
        path.join(layout.supervisorStateDir, "boundary.json"),
      ].map(async (filePath) => [filePath, await captureFile(filePath)]),
    ),
  );
  try {
    runSystem(systemctl, ["stop", layout.supervisorUnit]);
    if (targetDigest !== installedDigest) {
      await atomicCopy(targetSupervisor, layout.supervisorBinary, 0o755, { uid: 0, gid: 0 });
    }
    const bootstrapOutput = runSystem(spec.nodeBinary, [
      layout.supervisorBinary,
      "bootstrap-boundary",
      "--profile",
      "protected-local",
      "--protected-local-instance",
      layout.instanceId,
      "--operator-uid",
      String(spec.operatorUid),
      "--operator-gid",
      String(operatorGroup.gid),
    ]);
    const receipt = JSON.parse(bootstrapOutput);
    if (
      receipt?.schemaVersion !== 1 ||
      receipt.profile !== "protected-local" ||
      receipt.instanceId !== layout.instanceId ||
      receipt.supervisorUnit !== layout.supervisorUnit ||
      receipt.controllerUnit !== layout.controllerUnit
    ) {
      fail("protected Local target supervisor returned a mismatched boundary receipt");
    }
    runSystem(systemctl, ["restart", layout.supervisorUnit]);
    await waitForSocket(`/run/fased-local-controller/${layout.instanceId}/request.sock`, 60_000);
    return targetDigest !== installedDigest;
  } catch (error) {
    const rollbackFailures = [];
    try {
      runSystem(systemctl, ["stop", layout.supervisorUnit], { timeout: 30_000 });
    } catch (rollbackError) {
      rollbackFailures.push(
        `stop target supervisor: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    for (const [filePath, snapshot] of snapshots) {
      try {
        await restoreCapturedFile(filePath, snapshot);
      } catch (rollbackError) {
        rollbackFailures.push(
          `restore ${String(filePath)}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    try {
      runSystem(systemctl, ["daemon-reload"]);
    } catch (rollbackError) {
      rollbackFailures.push(
        `reload prior units: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    for (const unit of [layout.controllerUnit, layout.supervisorUnit]) {
      try {
        runSystem(systemctl, ["restart", unit]);
      } catch (rollbackError) {
        rollbackFailures.push(
          `restart ${unit}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    try {
      await waitForSocket(`/run/fased-local-controller/${layout.instanceId}/request.sock`, 60_000);
    } catch (rollbackError) {
      rollbackFailures.push(
        `restore supervisor socket: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    if (rollbackFailures.length > 0) {
      throw new Error(
        `protected Local supervisor transition failed and rollback is incomplete: ${error.message}; ${rollbackFailures.join("; ")}`,
        { cause: error },
      );
    }
    throw new Error(
      `protected Local supervisor transition failed and was restored: ${error.message}`,
      {
        cause: error,
      },
    );
  }
}

function validateProtectedLocalLifecycleResult(result, spec) {
  const supportedApplicationAdapters = new Set([
    "managed-install-absent",
    "managed-install-v1-to-v2",
    "managed-install-v2",
  ]);
  if (
    result?.version !== spec.releaseVersion ||
    result?.phase !== "committed" ||
    result?.migration?.schemaVersion !== 1 ||
    result?.migration?.profile !== "protected-local" ||
    result?.migration?.serviceTopology !== "protected-local-system-v1" ||
    !supportedApplicationAdapters.has(result?.migration?.adapters?.application)
  ) {
    fail("protected Local lifecycle did not commit a supported topology transaction");
  }
  return result;
}

function applyProtectedLocalLifecycle(spec, layout) {
  const command = buildProtectedLocalLifecycleApplyCommand(spec, layout);
  const output = runSystem(command.executable, command.args, { timeout: 20 * 60_000 });
  let result;
  try {
    result = JSON.parse(output);
  } catch (error) {
    fail(`protected Local lifecycle returned invalid JSON: ${error.message}`);
  }
  return validateProtectedLocalLifecycleResult(result, spec);
}

function verifyGatewayRuntimeAccess(layout) {
  const runuser = systemBinary(["/usr/sbin/runuser", "/sbin/runuser"], "runuser");
  const test = systemBinary(["/usr/bin/test", "/bin/test"], "test");
  const checks = [
    ["-x", layout.applicationCurrentLink],
    ["-r", path.join(layout.applicationCurrentLink, "package.json")],
    ["-x", path.join(layout.applicationCurrentLink, "scripts", "start-managed.sh")],
    ["-x", path.join(layout.installDir, "gateway-launch")],
  ];
  try {
    for (const [operator, target] of checks) {
      runSystem(runuser, ["-u", layout.gatewayUser, "--", test, operator, target], {
        timeout: 10_000,
      });
    }
  } catch {
    fail("protected Local Gateway cannot traverse its root-controlled application runtime");
  }
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

function protectedLocalGatewayHealthMatches(payload, statusCode, expectedVersion, expectedPid) {
  return (
    statusCode === 200 &&
    payload?.version === expectedVersion &&
    new Set(["managed-package", "packaged-runtime"]).has(payload?.runtimeSource) &&
    (!expectedPid || payload?.pid === expectedPid)
  );
}

async function probeGatewayHealth(
  spec,
  expectedPid,
  timeoutMs = 2_000,
  expectedVersion = spec.releaseVersion,
) {
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
            const matches = protectedLocalGatewayHealthMatches(
              payload,
              response.statusCode,
              expectedVersion,
              expectedPid,
            );
            resolve({
              ok: matches,
              conflict: !matches,
              version: typeof payload?.version === "string" ? payload.version : "",
              runtimeSource:
                typeof payload?.runtimeSource === "string" ? payload.runtimeSource : "",
              pid: Number.isSafeInteger(payload?.pid) && payload.pid > 1 ? payload.pid : undefined,
              detail: `status=${response.statusCode ?? "unknown"} version=${payload?.version ?? "unknown"} runtimeSource=${payload?.runtimeSource ?? "unknown"} pid=${payload?.pid ?? "unknown"}`,
            });
          } catch (error) {
            resolve({
              ok: false,
              conflict: true,
              version: "",
              runtimeSource: "",
              detail: `invalid health payload: ${error.message}`,
            });
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Gateway health probe timed out")));
    request.on("error", (error) =>
      resolve({
        ok: false,
        conflict: !new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]).has(error?.code),
        version: "",
        runtimeSource: "",
        detail: error.message,
      }),
    );
  });
}

async function gatewayPortIsFree(spec) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      resolve({ free: false, detail: error?.code ?? error.message });
    });
    server.listen(
      {
        host: "127.0.0.1",
        port: spec.gatewayPort,
        exclusive: true,
      },
      () => {
        server.close((error) => {
          resolve({ free: !error, detail: error?.code ?? error?.message ?? "free" });
        });
      },
    );
  });
}

async function waitForGatewayPortFree(spec, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "occupied";
  while (Date.now() < deadline) {
    const result = await gatewayPortIsFree(spec);
    if (result.free) {
      return;
    }
    lastDetail = result.detail;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fail(
    `legacy Local Gateway port 127.0.0.1:${spec.gatewayPort} remained occupied after fencing (${lastDetail})`,
  );
}

function readGatewayServiceState(layout) {
  const systemctl = systemBinary(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
  const properties = parseSystemdProperties(
    runSystem(systemctl, [
      "show",
      layout.gatewayUnit,
      "--property=ActiveState",
      "--property=SubState",
      "--property=MainPID",
      "--property=NRestarts",
      "--property=ExecMainStatus",
      "--property=Result",
      "--no-pager",
    ]),
  );
  return {
    activeState: properties.ActiveState || "unknown",
    subState: properties.SubState || "unknown",
    mainPid: Number.parseInt(properties.MainPID || "0", 10),
    restarts: Number.parseInt(properties.NRestarts || "0", 10),
    execMainStatus: Number.parseInt(properties.ExecMainStatus || "0", 10),
    result: properties.Result || "unknown",
  };
}

function readProcessUid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return null;
  }
  try {
    const match = fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/mu);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function gatewayFailureJournal(layout) {
  try {
    const journalctl = systemBinary(["/usr/bin/journalctl", "/bin/journalctl"], "journalctl");
    return runSystem(journalctl, [
      "-u",
      layout.gatewayUnit,
      "-n",
      "30",
      "--no-pager",
      "--output=short",
    ]).trim();
  } catch {
    return "";
  }
}

async function verifyGatewayHealth(spec, layout, timeoutMs = 120_000) {
  const cliEntrypoint = path.join(layout.applicationCurrentLink, "fased.mjs");
  if (!fs.existsSync(cliEntrypoint)) {
    fail("protected Local application runtime has no CLI entrypoint");
  }
  const gatewayIdentity =
    passwdRecord(layout.gatewayUser) ??
    fail("protected Local Gateway service identity is unavailable");
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "Gateway health endpoint was unavailable";
  let observedPid = 0;
  let baselineRestarts;
  while (Date.now() < deadline) {
    const service = readGatewayServiceState(layout);
    baselineRestarts ??= service.restarts;
    if (
      service.activeState === "failed" ||
      service.result === "exit-code" ||
      (service.activeState === "inactive" && service.execMainStatus !== 0) ||
      service.restarts > baselineRestarts
    ) {
      const journal = gatewayFailureJournal(layout);
      fail(
        `protected Local Gateway service failed before health verification (active=${service.activeState} sub=${service.subState} status=${service.execMainStatus} restarts=${service.restarts})${journal ? `\n${journal}` : ""}`,
      );
    }
    if (Number.isSafeInteger(service.mainPid) && service.mainPid > 1) {
      observedPid = service.mainPid;
    }
    const processUid = readProcessUid(observedPid);
    const result = await probeGatewayHealth(spec, observedPid || undefined);
    if (result.ok) {
      if (service.activeState !== "active" || observedPid <= 1) {
        fail(
          `protected Local Gateway health was served outside the active target unit (active=${service.activeState} pid=${observedPid})`,
        );
      }
      if (processUid !== gatewayIdentity.uid) {
        fail(
          `protected Local Gateway health-serving PID ${observedPid} has UID ${processUid ?? "unknown"}, expected ${gatewayIdentity.uid}`,
        );
      }
      return;
    }
    lastDetail =
      processUid === null || processUid === gatewayIdentity.uid
        ? result.detail
        : `${result.detail}; service PID ${observedPid} is still transitioning from UID ${processUid}`;
    if (result.conflict) {
      fail(
        `protected Local Gateway port 127.0.0.1:${spec.gatewayPort} is owned by a non-target service (${lastDetail})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(
    `protected Local Gateway service health did not match ${spec.releaseVersion} on 127.0.0.1:${spec.gatewayPort} within ${timeoutMs}ms (${lastDetail})`,
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

async function authorizeGatewayActivation(layout) {
  await atomicWrite(
    path.join(layout.controllerStateDir, "gateway-activation-ready"),
    `${new Date().toISOString()}\n`,
    0o600,
    { uid: 0, gid: 0 },
  );
}

function verifyGatewayLaunchInputs(spec, layout) {
  const runuser = systemBinary(["/usr/sbin/runuser", "/sbin/runuser"], "runuser");
  const test = systemBinary(["/usr/bin/test", "/bin/test"], "test");
  for (const [label, predicate, candidate] of [
    ["activation marker", "-s", path.join(layout.controllerStateDir, "gateway-activation-ready")],
    ["configuration", "-r", path.join(spec.stateDir, "fased.json")],
  ]) {
    try {
      runSystem(runuser, ["-u", layout.gatewayUser, "--", test, predicate, candidate], {
        timeout: 10_000,
      });
    } catch {
      fail(`protected Local Gateway cannot read its ${label}`);
    }
  }
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

async function restoreLegacyOperatorRuntimeModes(spec) {
  const trustedHardlinks = await resolveTrustedLegacyRuntimeHardlinks(spec);
  for (const protectedRuntimePath of [
    path.join(spec.stateDir, "runtime"),
    path.join(spec.stateDir, "updater"),
    path.join(spec.stateDir, "bin"),
  ]) {
    await hardenOperatorRuntime(protectedRuntimePath, spec, new Set(), trustedHardlinks);
  }
}

async function restoreLegacyLocalStateBoundary(transaction) {
  const { spec, legacy } = transaction;
  const chown = systemBinary(["/usr/bin/chown", "/bin/chown"], "chown");
  const chmod = systemBinary(["/usr/bin/chmod", "/bin/chmod"], "chmod");
  runSystem(chown, ["-R", `${spec.operatorUid}:${spec.operatorGid}`, spec.stateDir]);
  runSystem(chmod, ["-R", "g-rwx,o-rwx", spec.stateDir]);
  await restoreLegacyOperatorRuntimeModes(spec);
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

function parseDirectoryAcl(output) {
  const entries = [];
  const seen = new Set();
  for (const rawLine of String(output).split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const entry = trimmed.replace(/\s+#effective:[rwx-]{3}$/u, "");
    if (
      !/^(?:default:)?(?:user|group|mask|other):(?:[0-9]+)?:[rwx-]{3}$/u.test(entry) ||
      seen.has(entry)
    ) {
      fail("protected Local operator home has an unsupported access ACL");
    }
    seen.add(entry);
    entries.push(entry);
  }
  for (const required of ["user::", "group::", "other::"]) {
    if (!entries.some((entry) => entry.startsWith(required))) {
      fail("protected Local operator home access ACL is incomplete");
    }
  }
  if (entries.length > 512) {
    fail("protected Local operator home access ACL is unexpectedly large");
  }
  return Object.freeze({ entries: Object.freeze(entries) });
}

function deserializeDirectoryAcl(value) {
  if (
    !value ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    value.entries.length > 512 ||
    value.entries.some(
      (entry) =>
        typeof entry !== "string" ||
        !/^(?:default:)?(?:user|group|mask|other):(?:[0-9]+)?:[rwx-]{3}$/u.test(entry),
    ) ||
    new Set(value.entries).size !== value.entries.length
  ) {
    fail("protected Local bootstrap journal has an invalid operator home ACL snapshot");
  }
  return Object.freeze({ entries: Object.freeze([...value.entries]) });
}

function aclEntryMap(snapshot) {
  return new Map(
    snapshot.entries.map((entry) => {
      const separator = entry.lastIndexOf(":");
      return [entry.slice(0, separator + 1), entry.slice(separator + 1)];
    }),
  );
}

function captureDirectoryAcl(directory) {
  const getfacl = systemBinary(["/usr/bin/getfacl", "/bin/getfacl"], "getfacl");
  return parseDirectoryAcl(
    runSystem(getfacl, ["--omit-header", "--absolute-names", "--numeric", "--", directory], {
      timeout: 10_000,
    }),
  );
}

function directoryAclSnapshotsEqual(actual, expected) {
  const actualMap = aclEntryMap(actual);
  const expectedMap = aclEntryMap(expected);
  return (
    actualMap.size === expectedMap.size &&
    [...expectedMap].every(([key, permissions]) => actualMap.get(key) === permissions)
  );
}

function assertDirectoryAclEquals(actual, expected, label) {
  if (!directoryAclSnapshotsEqual(actual, expected)) {
    fail(`protected Local operator home ACL ${label}`);
  }
}

function assertGatewayAclGrant(original, updated, gatewayUid) {
  const originalMap = aclEntryMap(original);
  const updatedMap = aclEntryMap(updated);
  const gatewayKey = `user:${gatewayUid}:`;
  if (updatedMap.get(gatewayKey) !== "--x") {
    fail("protected Local Gateway did not receive exact operator-home traversal");
  }
  for (const [key, permissions] of originalMap) {
    if (updatedMap.get(key) !== permissions) {
      fail("protected Local operator home ACL changed an existing entry");
    }
  }
  const allowedNewKeys = new Set([gatewayKey]);
  if (!originalMap.has("mask::")) {
    allowedNewKeys.add("mask::");
  }
  for (const key of updatedMap.keys()) {
    if (!originalMap.has(key) && !allowedNewKeys.has(key)) {
      fail("protected Local operator home ACL gained an unexpected entry");
    }
  }
}

function gatewayAclGrantState(original, current, gatewayUid) {
  if (directoryAclSnapshotsEqual(current, original)) {
    return "missing";
  }
  assertGatewayAclGrant(original, current, gatewayUid);
  return "granted";
}

function grantGatewayHomeTraversal(transaction) {
  const { spec, layout } = transaction;
  const gatewayUid = transaction.users.gateway?.uid;
  if (!Number.isSafeInteger(gatewayUid) || gatewayUid <= 0) {
    fail("protected Local Gateway identity is missing before ACL authorization");
  }
  const original = transaction.homeAclSnapshot;
  const current = captureDirectoryAcl(spec.operatorHome);
  const originalMap = aclEntryMap(original);
  const gatewayKey = `user:${gatewayUid}:`;
  if (originalMap.has(gatewayKey)) {
    fail("protected Local Gateway UID collides with an existing operator-home ACL entry");
  }
  const mask = originalMap.get("mask::");
  if (mask !== undefined && !mask.endsWith("x")) {
    fail("protected Local operator home ACL mask blocks isolated Gateway traversal");
  }
  if (
    mask === undefined &&
    [...originalMap.keys()].some(
      (key) =>
        !key.startsWith("default:") &&
        ((key.startsWith("user:") && key !== "user::") ||
          (key.startsWith("group:") && key !== "group::")),
    )
  ) {
    fail("protected Local operator home ACL has named entries without an access mask");
  }
  if (gatewayAclGrantState(original, current, gatewayUid) === "missing") {
    const setfacl = systemBinary(["/usr/bin/setfacl", "/bin/setfacl"], "setfacl");
    const args = [];
    if (mask !== undefined) {
      args.push("--no-mask");
    }
    args.push("--modify", `user:${gatewayUid}:--x`, "--", spec.operatorHome);
    runSystem(setfacl, args, { timeout: 10_000 });
    assertGatewayAclGrant(original, captureDirectoryAcl(spec.operatorHome), gatewayUid);
  }

  const runuser = systemBinary(["/usr/sbin/runuser", "/sbin/runuser"], "runuser");
  const test = systemBinary(["/usr/bin/test", "/bin/test"], "test");
  try {
    runSystem(runuser, ["-u", layout.gatewayUser, "--", test, "-x", spec.operatorHome], {
      timeout: 10_000,
    });
  } catch {
    fail("protected Local Gateway cannot traverse the operator home");
  }
}

async function restoreGatewayHomeTraversal(transaction) {
  const { spec } = transaction;
  const original = transaction.homeAclSnapshot;
  const gatewayUid = transaction.users.gateway?.uid;
  const setfacl = systemBinary(["/usr/bin/setfacl", "/bin/setfacl"], "setfacl");
  if (Number.isSafeInteger(gatewayUid) && gatewayUid > 0) {
    const currentMap = aclEntryMap(captureDirectoryAcl(spec.operatorHome));
    if (currentMap.has(`user:${gatewayUid}:`)) {
      runSystem(setfacl, ["--no-mask", "--remove", `user:${gatewayUid}`, "--", spec.operatorHome], {
        timeout: 10_000,
      });
    }
  }
  const originalMap = aclEntryMap(original);
  const currentMap = aclEntryMap(captureDirectoryAcl(spec.operatorHome));
  if (!originalMap.has("mask::") && currentMap.has("mask::")) {
    runSystem(setfacl, ["--remove", "mask", "--", spec.operatorHome], {
      timeout: 10_000,
    });
  }
  await fsp.chown(spec.operatorHome, transaction.homeSnapshot.uid, transaction.homeSnapshot.gid);
  await fsp.chmod(spec.operatorHome, transaction.homeSnapshot.mode);
  const originalMask = originalMap.get("mask::");
  if (typeof originalMask === "string") {
    runSystem(
      setfacl,
      ["--no-mask", "--modify", `mask::${originalMask}`, "--", spec.operatorHome],
      { timeout: 10_000 },
    );
  }
  assertDirectoryAclEquals(
    captureDirectoryAcl(spec.operatorHome),
    original,
    "was not restored exactly",
  );
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
        homeAclSnapshot: transaction.homeAclSnapshot,
        groups: transaction.groups,
        users: transaction.users,
        legacyGatewayWasActive: transaction.legacyGatewayWasActive,
        legacyGatewayState: transaction.legacyGatewayState
          ? {
              ...transaction.legacyGatewayState,
              dropInSnapshot: serializeCapture(transaction.legacyGatewayState.dropInSnapshot),
            }
          : null,
        migrated: transaction.migrated === true,
        lifecycleCommitted: transaction.lifecycleCommitted === true,
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
    !Number.isSafeInteger(value.homeSnapshot?.mode) ||
    !value.homeAclSnapshot
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
    homeAclSnapshot: deserializeDirectoryAcl(value.homeAclSnapshot),
    groups: value.groups && typeof value.groups === "object" ? value.groups : {},
    users: value.users && typeof value.users === "object" ? value.users : {},
    legacyGatewayWasActive: value.legacyGatewayWasActive === true,
    legacyGatewayState:
      value.legacyGatewayState && typeof value.legacyGatewayState === "object"
        ? {
            busAvailable: value.legacyGatewayState.busAvailable === true,
            exists: value.legacyGatewayState.exists === true,
            active: value.legacyGatewayState.active === true,
            unitFileState:
              typeof value.legacyGatewayState.unitFileState === "string"
                ? value.legacyGatewayState.unitFileState
                : "disabled",
            releaseVersion:
              typeof value.legacyGatewayState.releaseVersion === "string"
                ? value.legacyGatewayState.releaseVersion
                : "",
            dropInSnapshot: deserializeCapture(value.legacyGatewayState.dropInSnapshot),
          }
        : null,
    migrated: value.migrated === true,
    lifecycleCommitted: value.lifecycleCommitted === true,
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

function parseSystemdProperties(output) {
  return Object.fromEntries(
    String(output)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function legacyGatewayUnitCandidates(spec) {
  return [
    path.join(spec.operatorHome, ".config", "systemd", "user", "fased-gateway.service"),
    "/etc/systemd/user/fased-gateway.service",
    "/usr/lib/systemd/user/fased-gateway.service",
    "/lib/systemd/user/fased-gateway.service",
  ];
}

function legacyInstallReferencesUserGateway(spec) {
  const manifest = parseConfig(path.join(spec.stateDir, "install.json"));
  return (
    manifest.service?.name === "fased-gateway.service" ||
    manifest.service?.scope === "user" ||
    manifest.profile === "local"
  );
}

function isRestorableLegacyGatewayUnitFileState(value) {
  return new Set(["enabled", "disabled", "static", "indirect", "masked"]).has(value);
}

function legacyGatewaySuppressionPaths(spec, layout) {
  const directory = path.join(
    spec.operatorHome,
    ".config",
    "systemd",
    "user",
    "fased-gateway.service.d",
  );
  return Object.freeze({
    directory,
    dropIn: path.join(directory, "90-fased-protected-local.conf"),
    activeMarker: path.join(layout.controllerStateDir, "protected-local-active"),
  });
}

function isValidLegacyGatewayReleaseHealth(health) {
  return (
    RELEASE_PATTERN.test(health?.version ?? "") &&
    new Set(["managed-package", "packaged-runtime"]).has(health?.runtimeSource)
  );
}

function legacyGatewayWasServing(properties, health) {
  const serviceClaimsRunning = new Set(["active", "activating", "reloading"]).has(
    properties?.ActiveState ?? "",
  );
  const releaseHealthy = isValidLegacyGatewayReleaseHealth(health);
  if (serviceClaimsRunning && !releaseHealthy) {
    fail(`legacy Local Gateway has no exact healthy release identity (${health?.detail})`);
  }
  return releaseHealthy;
}

async function waitForLegacyGatewayReleaseHealth(
  spec,
  {
    timeoutMs = 30_000,
    probe = probeGatewayHealth,
    wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    now = Date.now,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let health = await probe(spec);
  while (!isValidLegacyGatewayReleaseHealth(health) && !health?.conflict && now() < deadline) {
    await wait(100);
    health = await probe(spec);
  }
  return health;
}

async function captureLegacyGatewayState(spec, layout) {
  const paths = legacyGatewaySuppressionPaths(spec, layout);
  const dropInSnapshot = await captureFile(paths.dropIn);
  try {
    userSystemctl(spec, ["show-environment"]);
  } catch {
    if (
      legacyInstallReferencesUserGateway(spec) ||
      legacyGatewayUnitCandidates(spec).some((candidate) => fs.existsSync(candidate))
    ) {
      fail("legacy Local Gateway exists but its user systemd manager is unavailable");
    }
    return {
      busAvailable: false,
      exists: false,
      active: false,
      unitFileState: "not-found",
      dropInSnapshot,
    };
  }
  let properties;
  try {
    properties = parseSystemdProperties(
      userSystemctl(spec, [
        "show",
        "fased-gateway.service",
        "--property=LoadState",
        "--property=ActiveState",
        "--property=UnitFileState",
      ]),
    );
  } catch {
    return {
      busAvailable: true,
      exists: false,
      active: false,
      unitFileState: "not-found",
      dropInSnapshot,
    };
  }
  let health = await probeGatewayHealth(spec, undefined, 1_500);
  if (
    !isValidLegacyGatewayReleaseHealth(health) &&
    new Set(["active", "activating", "reloading"]).has(properties.ActiveState)
  ) {
    health = await waitForLegacyGatewayReleaseHealth(spec);
  }
  const active = legacyGatewayWasServing(properties, health);
  const state = {
    busAvailable: true,
    exists: properties.LoadState !== "not-found",
    // Rollback intent follows the exact release that was serving traffic, not
    // one transient systemd ActiveState sample. A reverse dependency can leave
    // the unit activating while the healthy Gateway already owns the listener.
    active,
    unitFileState: properties.UnitFileState || "disabled",
    releaseVersion: active ? health.version : "",
    dropInSnapshot,
  };
  if (state.exists && !isRestorableLegacyGatewayUnitFileState(state.unitFileState)) {
    fail(
      `legacy Local Gateway has unsupported systemd unit-file state: ${state.unitFileState || "unknown"}`,
    );
  }
  return state;
}

async function installLegacyGatewaySuppression(spec, layout) {
  const paths = legacyGatewaySuppressionPaths(spec, layout);
  await ensureOperatorOwnedDirectory(paths.directory, spec);
  await atomicWrite(paths.dropIn, `[Unit]\nConditionPathExists=!${paths.activeMarker}\n`, 0o644, {
    uid: spec.operatorUid,
    gid: spec.operatorGid,
  });
  await atomicWrite(paths.activeMarker, `${new Date().toISOString()}\n`, 0o644, {
    uid: 0,
    gid: 0,
  });
  userSystemctl(spec, ["daemon-reload"]);
}

async function waitForLegacyGatewayInactive(spec, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let activeState = "unknown";
  let inactiveSince = null;
  while (Date.now() < deadline) {
    const properties = parseSystemdProperties(
      userSystemctl(spec, ["show", "fased-gateway.service", "--property=ActiveState"]),
    );
    activeState = properties.ActiveState || "unknown";
    if (new Set(["inactive", "failed"]).has(activeState)) {
      const pendingJobs = userSystemctl(spec, [
        "list-jobs",
        "fased-gateway.service",
        "--no-legend",
        "--plain",
      ]).trim();
      if (!pendingJobs) {
        inactiveSince ??= Date.now();
        if (Date.now() - inactiveSince >= 500) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
    }
    // A reverse dependency can already have queued a start job when the
    // runtime mask is installed. The mask prevents subsequent starts, while
    // this second stop drains that pre-existing job before activation.
    inactiveSince = null;
    if (new Set(["active", "activating", "reloading", "inactive", "failed"]).has(activeState)) {
      // Do not wait on this individual stop job: systemd can report it as
      // canceled when it replaces an already queued reverse-dependency start.
      // The bounded state/job loop below is the authoritative completion
      // check, and the runtime mask prevents a new start from winning.
      userSystemctl(spec, ["stop", "--no-block", "fased-gateway.service"]);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`legacy Local Gateway remained ${activeState} after fencing`);
}

async function fenceLegacyGateway(spec, layout, state) {
  if (state.busAvailable && state.exists) {
    await installLegacyGatewaySuppression(spec, layout);
    // Install the mask before stopping. Combining mask and stop in one
    // systemctl transaction can return "job canceled" when an existing
    // reverse dependency races the stop, even though the mask was installed.
    // The bounded drain below owns the stop and proves the unit stays inactive.
    userSystemctl(spec, ["mask", "--runtime", "--force", "fased-gateway.service"]);
    await waitForLegacyGatewayInactive(spec);
  }
  await waitForGatewayPortFree(spec);
}

async function ensureOperatorOwnedDirectory(directory, spec) {
  assertPathBelow(spec.operatorHome, directory, "legacy Gateway suppression directory");
  const relative = path.relative(spec.operatorHome, directory);
  let current = spec.operatorHome;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await fsp.lstat(current);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== spec.operatorUid ||
        (info.mode & 0o022) !== 0
      ) {
        fail(`legacy Gateway suppression path is unsafe: ${current}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await fsp.mkdir(current, { mode: 0o700 });
      await fsp.chown(current, spec.operatorUid, spec.operatorGid);
      await fsp.chmod(current, 0o700);
    }
  }
}

async function retireLegacyGateway(transaction) {
  const { spec, layout, legacyGatewayState } = transaction;
  if (!legacyGatewayState.busAvailable || !legacyGatewayState.exists) {
    return;
  }
  await installLegacyGatewaySuppression(spec, layout);
  userSystemctl(spec, ["unmask", "--runtime", "fased-gateway.service"]);
  userSystemctl(spec, ["daemon-reload"]);
  userSystemctl(spec, ["disable", "--now", "fased-gateway.service"]);
  const properties = parseSystemdProperties(
    userSystemctl(spec, ["show", "fased-gateway.service", "--property=ActiveState"]),
  );
  if (properties.ActiveState === "active") {
    fail("legacy Local Gateway restarted after protected service activation");
  }
}

function previousLegacyGatewayVersion(transaction) {
  const capturedVersion = String(transaction.legacyGatewayState?.releaseVersion ?? "").trim();
  if (RELEASE_PATTERN.test(capturedVersion)) {
    return capturedVersion;
  }
  if (!transaction.manifestSnapshot?.existed) {
    fail("legacy Local Gateway restore has no previous managed manifest");
  }
  let manifest;
  try {
    manifest = JSON.parse(transaction.manifestSnapshot.content.toString("utf8"));
  } catch {
    fail("legacy Local Gateway restore has an unreadable previous managed manifest");
  }
  const version = String(manifest?.runtime?.activeVersion ?? "").trim();
  if (!RELEASE_PATTERN.test(version)) {
    fail("legacy Local Gateway restore has no exact previous release version");
  }
  return version;
}

function systemdMainPid(properties) {
  const pid = Number.parseInt(String(properties?.MainPID ?? ""), 10);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

async function processOwnsGatewayListener(spec, expectedPid) {
  const expectedPort = Number(spec.gatewayPort);
  if (!Number.isSafeInteger(expectedPort) || expectedPort < 1 || expectedPort > 65_535) {
    return false;
  }
  const socketInodes = new Set();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let content;
    try {
      content = await fsp.readFile(table, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const line of content.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 10 || fields[3] !== "0A") {
        continue;
      }
      const separator = fields[1].lastIndexOf(":");
      const port = Number.parseInt(fields[1].slice(separator + 1), 16);
      if (port === expectedPort && /^\d+$/u.test(fields[9])) {
        socketInodes.add(fields[9]);
      }
    }
  }
  if (socketInodes.size === 0) {
    return false;
  }
  let descriptors;
  try {
    descriptors = await fsp.readdir(`/proc/${expectedPid}/fd`);
  } catch (error) {
    if (new Set(["ENOENT", "EACCES"]).has(error?.code)) {
      return false;
    }
    throw error;
  }
  for (const descriptor of descriptors) {
    try {
      const target = await fsp.readlink(`/proc/${expectedPid}/fd/${descriptor}`);
      const match = /^socket:\[(\d+)\]$/u.exec(target);
      if (match && socketInodes.has(match[1])) {
        return true;
      }
    } catch (error) {
      if (!new Set(["ENOENT", "EACCES"]).has(error?.code)) {
        throw error;
      }
    }
  }
  return false;
}

async function waitForLegacyGatewayRestored(
  transaction,
  timeoutMs = 30_000,
  {
    systemctl = userSystemctl,
    probe = probeGatewayHealth,
    ownsListener = processOwnsGatewayListener,
    wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    now = Date.now,
    stabilityMs = 1_000,
  } = {},
) {
  const { spec } = transaction;
  const expectedVersion = previousLegacyGatewayVersion(transaction);
  const deadline = now() + timeoutMs;
  let lastDetail = "legacy Gateway did not start";
  let stablePid;
  let stableSince;
  while (now() < deadline) {
    let properties = {};
    let pendingJobs = "unknown";
    try {
      properties = parseSystemdProperties(
        systemctl(spec, [
          "show",
          "fased-gateway.service",
          "--property=ActiveState",
          "--property=SubState",
          "--property=Result",
          "--property=MainPID",
        ]),
      );
      pendingJobs = systemctl(spec, [
        "list-jobs",
        "fased-gateway.service",
        "--no-legend",
        "--plain",
      ]).trim();
    } catch (error) {
      lastDetail = error.message;
    }
    const expectedPid = systemdMainPid(properties);
    const health = expectedPid
      ? await probe(spec, undefined, 1_500, expectedVersion)
      : {
          ok: false,
          detail: `user systemd MainPID=${properties.MainPID || "unknown"}`,
        };
    const listenerOwned =
      expectedPid && health.ok
        ? health.pid
          ? health.pid === expectedPid
          : await ownsListener(spec, expectedPid)
        : false;
    const ready =
      properties.ActiveState === "active" &&
      properties.SubState === "running" &&
      expectedPid &&
      health.ok &&
      listenerOwned &&
      pendingJobs === "";
    if (ready) {
      if (stablePid !== expectedPid) {
        stablePid = expectedPid;
        stableSince = now();
      }
      if (now() - stableSince >= stabilityMs) {
        return;
      }
      await wait(100);
      continue;
    }
    stablePid = undefined;
    stableSince = undefined;
    lastDetail = `active=${properties.ActiveState || "unknown"} sub=${properties.SubState || "unknown"} result=${properties.Result || "unknown"} pendingJobs=${pendingJobs || "none"} listenerOwned=${listenerOwned}; ${health.detail}`;
    try {
      systemctl(spec, ["reset-failed", "fased-gateway.service"]);
    } catch {
      // A concurrent reverse dependency may already be replacing the failed job.
    }
    try {
      systemctl(spec, ["start", "--no-block", "fased-gateway.service"]);
    } catch {
      // Poll the unit and exact health below; a concurrent start can supersede this request.
    }
    await wait(250);
  }
  fail(
    `legacy Local Gateway did not restore exact release ${expectedVersion} within ${timeoutMs}ms (${lastDetail})`,
  );
}

async function restoreLegacyGateway(transaction) {
  const { spec, layout, legacyGatewayState } = transaction;
  if (!legacyGatewayState) {
    if (transaction.legacyGatewayWasActive) {
      userSystemctl(spec, ["enable", "--now", "fased-gateway.service"], {
        allowUnavailable: false,
      });
    }
    return;
  }
  if (!legacyGatewayState.busAvailable) {
    return;
  }
  const paths = legacyGatewaySuppressionPaths(spec, layout);
  await waitForGatewayPortFree(spec);
  await restoreCapturedFile(paths.dropIn, legacyGatewayState.dropInSnapshot);
  if (!legacyGatewayState.dropInSnapshot.existed) {
    await fsp.rmdir(paths.directory).catch((error) => {
      if (!new Set(["ENOENT", "ENOTEMPTY"]).has(error?.code)) {
        throw error;
      }
    });
  }
  await fsp.rm(paths.activeMarker, { force: true });
  userSystemctl(spec, ["daemon-reload"]);
  if (!legacyGatewayState.exists) {
    return;
  }
  userSystemctl(spec, ["unmask", "--runtime", "fased-gateway.service"]);
  if (legacyGatewayState.unitFileState.startsWith("enabled")) {
    userSystemctl(spec, ["enable", "fased-gateway.service"]);
  } else if (legacyGatewayState.unitFileState === "disabled") {
    userSystemctl(spec, ["disable", "fased-gateway.service"]);
  }
  if (legacyGatewayState.active) {
    try {
      userSystemctl(spec, ["start", "--no-block", "fased-gateway.service"]);
    } catch {
      // The bounded exact-health loop handles a concurrent reverse-dependency start.
    }
    await waitForLegacyGatewayRestored(transaction);
  } else {
    userSystemctl(spec, ["stop", "fased-gateway.service"]);
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
    `/run/fased-local-controller-worker/${layout.instanceId}`,
    layout.stateDir,
    layout.installDir,
    `/etc/fased/local/${layout.instanceId}`,
    `/etc/systemd/system/${layout.gatewayUnit}`,
    `/etc/systemd/system/${layout.signerUnit}`,
    `/etc/systemd/system/${layout.controllerUnit}`,
    `/etc/systemd/system/${layout.supervisorUnit}`,
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
    for (const unit of [
      layout.gatewayUnit,
      layout.signerUnit,
      layout.supervisorUnit,
      layout.controllerUnit,
    ]) {
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
  await attempt("operator home ACL restore", async () => restoreGatewayHomeTraversal(transaction));
  await attempt("candidate unit removal", async () => {
    for (const unitPath of [
      `/etc/systemd/system/${layout.gatewayUnit}`,
      `/etc/systemd/system/${layout.signerUnit}`,
      `/etc/systemd/system/${layout.controllerUnit}`,
      `/etc/systemd/system/${layout.supervisorUnit}`,
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
  await attempt("legacy Gateway state restore", async () => restoreLegacyGateway(transaction));
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
    if (!transaction.legacyGatewayState) {
      transaction.legacyGatewayState = await captureLegacyGatewayState(spec, layout);
      transaction.legacyGatewayState.active = transaction.legacyGatewayWasActive;
    }
    await persistBootstrapTransaction(transaction, "legacy-gateway-captured");
    await fenceLegacyGateway(spec, layout, transaction.legacyGatewayState);
    await persistBootstrapTransaction(transaction, "prepared-awaiting-onboarding");
    const configGroup = groupRecord(layout.configGroup);
    if (!configGroup) {
      fail("protected Local configuration group is missing during activation");
    }
    grantGatewayHomeTraversal(transaction);
    await shareApplicationState(spec, configGroup, transaction.legacy);
    await updateOperatorConfig(spec, layout, configGroup);
    await waitForSocket(layout.operatorSocket);
    await verifyOperatorCapabilities(spec, layout);
    const wallets = verifyLogicalWalletState(spec, layout);
    const systemctl = systemBinary(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
    await authorizeGatewayActivation(layout);
    verifyGatewayLaunchInputs(spec, layout);
    runSystem(systemctl, ["enable", layout.gatewayUnit]);
    runSystem(systemctl, ["restart", layout.gatewayUnit]);
    await verifyGatewayHealth(spec, layout, spec.gatewayHealthTimeoutMs);
    await retireLegacyGateway(transaction);
    await removeLegacySignerMaterial(transaction.legacy);
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
      supervisorUnit: layout.supervisorUnit,
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

async function completeCommittedBootstrapTransaction(transaction) {
  const { spec, layout } = transaction;
  verifyGatewayRuntimeAccess(layout);
  await waitForSocket(layout.operatorSocket);
  await verifyOperatorCapabilities(spec, layout);
  const wallets = verifyLogicalWalletState(spec, layout);
  await retireLegacyGateway(transaction);
  await removeLegacySignerMaterial(transaction.legacy);
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
    supervisorUnit: layout.supervisorUnit,
    gatewayMode: "activate",
    lifecycleCommitted: true,
    wallets,
    operatorEnvironment: renderProtectedLocalOperatorEnvironment({
      layout,
      stateDir: spec.stateDir,
    }),
  };
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
    if (interrupted.phase === "lifecycle-committed" && interrupted.lifecycleCommitted) {
      const result = await completeCommittedBootstrapTransaction(interrupted);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result;
    }
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
      const runuser = systemBinary(["/usr/sbin/runuser", "/sbin/runuser"], "runuser");
      const test = systemBinary(["/usr/bin/test", "/bin/test"], "test");
      try {
        runSystem(runuser, ["-u", layout.gatewayUser, "--", test, "-x", spec.operatorHome], {
          timeout: 10_000,
        });
      } catch {
        fail("protected Local Gateway cannot traverse the operator home");
      }
      let lifecycle = null;
      if (spec.gatewayMode === "activate") {
        await transitionExistingSupervisorBoundary(sourceRoot, spec, layout);
        await waitForSocket(
          `/run/fased-local-controller/${layout.instanceId}/request.sock`,
          60_000,
        );
        lifecycle = applyProtectedLocalLifecycle(spec, layout);
      }
      await waitForSocket(layout.operatorSocket);
      await verifyOperatorCapabilities(spec, layout);
      const wallets = verifyLogicalWalletState(spec, layout);
      if (spec.gatewayMode === "activate") {
        verifyGatewayLaunchInputs(spec, layout);
        await verifyGatewayHealth(spec, layout, spec.gatewayHealthTimeoutMs);
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
        supervisorUnit: layout.supervisorUnit,
        gatewayMode: spec.gatewayMode,
        lifecycleCommitted: lifecycle?.phase === "committed",
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
    homeAclSnapshot: captureDirectoryAcl(spec.operatorHome),
    groups: {},
    users: {},
    legacyGatewayWasActive: false,
    legacyGatewayState: null,
    migrated: false,
    lifecycleCommitted: false,
    legacy: null,
  };
  try {
    if (spec.gatewayMode !== "activate") {
      fail("new protected Local topology must commit before onboarding");
    }
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
    grantGatewayHomeTraversal(transaction);
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
    transaction.legacyGatewayState = await captureLegacyGatewayState(spec, layout);
    transaction.legacyGatewayWasActive = transaction.legacyGatewayState.active;
    await persistBootstrapTransaction(transaction, "legacy-gateway-captured");
    await fenceLegacyGateway(spec, layout, transaction.legacyGatewayState);
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
    await authorizeGatewayActivation(layout);
    runSystem(systemctl, [
      "enable",
      layout.controllerUnit,
      layout.supervisorUnit,
      layout.signerUnit,
      layout.gatewayUnit,
    ]);
    runSystem(systemctl, ["restart", layout.controllerUnit]);
    runSystem(systemctl, ["restart", layout.supervisorUnit]);
    await waitForSocket(`/run/fased-local-controller/${layout.instanceId}/request.sock`, 60_000);
    applyProtectedLocalLifecycle(spec, layout);
    transaction.lifecycleCommitted = true;
    await persistBootstrapTransaction(transaction, "lifecycle-committed");
    const result = await completeCommittedBootstrapTransaction(transaction);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    if (transaction.lifecycleCommitted) {
      throw new Error(
        `protected Local lifecycle committed, but final bootstrap cleanup is pending: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
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
  buildProtectedLocalLifecycleApplyCommand,
  buildProtectedLocalBootstrapSpec,
  hardenOperatorRuntime,
  hardenInstalledPlugins,
  inspectInstalledPluginTree,
  isRestorableLegacyGatewayUnitFileState,
  gatewayAclGrantState,
  legacyGatewayWasServing,
  legacyInstallReferencesUserGateway,
  parseDirectoryAcl,
  prepareProtectedLocalChannelDirectory,
  renderProtectedLocalOperatorEnvironment,
  renderProtectedLocalOwnerWrapper,
  registeredSignerWallets,
  removeLegacySignerMaterial,
  resolveTrustedLegacyRuntimeHardlinks,
  resolveLegacySignerPaths,
  restoreLegacyOperatorRuntimeModes,
  sharedApplicationStateDirectoriesForAclVerification,
  protectedLocalGatewayHealthMatches,
  processOwnsGatewayListener,
  systemdMainPid,
  waitForLegacyGatewayReleaseHealth,
  waitForLegacyGatewayRestored,
  previousLegacyGatewayVersion,
  validateProtectedLocalLifecycleResult,
  verifySignerReleaseIdentity,
  buildControllerIdentity,
});
