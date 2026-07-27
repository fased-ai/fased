#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RELEASE_BASE = "https://github.com/fased-ai/fased/releases/download";
const RELEASE_REPOSITORY = "fased-ai/fased";
const RELEASE_WORKFLOW = "fased-ai/fased/.github/workflows/hosted-runtime-release.yml";
const RELEASE_MANIFEST_NAME = "fased-hosted-release-v2.json";
const RELEASE_MANIFEST_BUNDLE_NAME = `${RELEASE_MANIFEST_NAME}.attestation.json`;
const SIGNER_ATTESTATION_BUNDLE_NAME = "fased-signerd-release.attestation.json";
const CONTROLLER_SERVER_NAME = "fased-host-updater.mjs";
const CONTROLLER_CLIENT_NAME = "fased-host-updaterctl.mjs";
const CONTROLLER_SERVER_BUNDLE_NAME = `${CONTROLLER_SERVER_NAME}.attestation.json`;
const CONTROLLER_CLIENT_BUNDLE_NAME = `${CONTROLLER_CLIENT_NAME}.attestation.json`;
const CONTROLLER_SELF_CHECK_SCHEMA_VERSION = 1;
const CONTROLLER_PROTOCOL_VERSION = 2;
const SOCKET_PATH = "/run/fased-host-updater/request.sock";
const STATE_DIR = "/var/lib/fased-host-updater";
const CONTROLLER_RELEASES_DIR = "/opt/fased/host-controller/releases";
const CONTROLLER_CURRENT_LINK = "/opt/fased/host-controller/current";
const SIGNER_PATH = "/opt/fased/signer/fased-signerd";
const SIGNER_STATE_DB_PATH = "/var/lib/fased-signerd/state.db";
const SIGNER_UNIT_PATH = "/etc/systemd/system/fased-signerd.service";
const VERSION_PATH = path.join(STATE_DIR, "signer-version");
const CHANNEL_PATH = "/etc/fased/host-updater-channel";
const JOURNAL_PATH = path.join(STATE_DIR, "active-signer-transaction.json");
const ROLLBACK_FLOOR_PATH = path.join(STATE_DIR, "rollback-floor");
const GATEWAY_GATE_PATH = path.join(STATE_DIR, "gateway-update-gate");
const SIGNER_GATE_PATH = "/var/lib/fased-signer-update-gate/active";
const TRANSACTIONS_DIR = path.join(STATE_DIR, "transactions");
const MAX_REQUEST_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 20 * 60_000;
const JOURNAL_SCHEMA_VERSION = 2;
const PROTOCOL_SCHEMA_VERSION = 2;
const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSACTION_OPERATIONS = new Set([
  "updateController",
  "prepareRelease",
  "activateRelease",
  "authorizeGatewayRelease",
  "gateGatewayRelease",
  "restartGateway",
  "commitRelease",
  "rollbackRelease",
]);
const TRANSACTION_PHASES = new Set([
  "prepared",
  "snapshotting",
  "activating",
  "active",
  "gateway-authorized",
  "committing",
  "rolling-back",
  "restored",
]);

export const PRE_V2_HOSTING_MIGRATION_MESSAGE = [
  "This hosted installation needs the one-time signer-v2 security migration before it can update.",
  "From a VPS provider console or a root SSH session, follow the pre-execution verified tagged repair procedure at https://docs.fased.ai/install/vps.",
  "After gh attestation verify succeeds, execute that verified install.sh asset with --repair-hosting --release vX.Y.Z.",
  "Never run /home/app/fased/install.sh with sudo or as root.",
  "The current Gateway, signer, wallets, and persistent state were left unchanged.",
].join(" ");

const DEFAULT_PATHS = Object.freeze({
  socketPath: SOCKET_PATH,
  stateDir: STATE_DIR,
  controllerReleasesDir: CONTROLLER_RELEASES_DIR,
  controllerCurrentLink: CONTROLLER_CURRENT_LINK,
  controllerVersionPath: path.join(STATE_DIR, "controller-version.json"),
  signerPath: SIGNER_PATH,
  signerStateDBPath: SIGNER_STATE_DB_PATH,
  signerUnitPath: SIGNER_UNIT_PATH,
  versionPath: VERSION_PATH,
  channelPath: CHANNEL_PATH,
  journalPath: JOURNAL_PATH,
  rollbackFloorPath: ROLLBACK_FLOOR_PATH,
  gatewayGatePath: GATEWAY_GATE_PATH,
  signerGatePath: SIGNER_GATE_PATH,
  transactionsDir: TRANSACTIONS_DIR,
});

export function protectedLocalControllerConfiguration(instanceId) {
  const normalized = String(instanceId ?? "").trim();
  if (!/^[a-f0-9]{16}$/u.test(normalized)) {
    throw new Error("Protected Local controller instance ID must be 16 lowercase hex characters");
  }
  const runtimeDir = `/run/fased-local/${normalized}`;
  const controllerRuntimeDir = `/run/fased-local-controller/${normalized}`;
  const instanceStateDir = `/var/lib/fased-local/${normalized}`;
  const signerStateDir = `${instanceStateDir}/signer`;
  const controllerStateDir = `${instanceStateDir}/controller`;
  const instanceInstallDir = `/opt/fased/local/${normalized}`;
  const controllerInstallDir = `${instanceInstallDir}/controller`;
  const applicationInstallDir = `${instanceInstallDir}/application`;
  return Object.freeze({
    profile: "protected-local",
    instanceId: normalized,
    signerServiceName: `fased-signerd-${normalized}.service`,
    gatewayServiceName: `fased-gateway-${normalized}.service`,
    signerApplicationSocketPath: `${runtimeDir}/application/app.sock`,
    paths: Object.freeze({
      socketPath: `${controllerRuntimeDir}/request.sock`,
      stateDir: controllerStateDir,
      controllerReleasesDir: `${controllerInstallDir}/releases`,
      controllerCurrentLink: `${controllerInstallDir}/current`,
      controllerVersionPath: `${controllerStateDir}/controller-version.json`,
      applicationReleasesDir: `${applicationInstallDir}/releases`,
      applicationCurrentLink: `${applicationInstallDir}/current`,
      gatewayUnitPath: `/etc/systemd/system/fased-gateway-${normalized}.service`,
      gatewayLauncherPath: `${instanceInstallDir}/gateway-launch`,
      signerPath: `${instanceInstallDir}/signer/fased-signerd`,
      signerStateDBPath: `${signerStateDir}/state.db`,
      signerUnitPath: `/etc/systemd/system/fased-signerd-${normalized}.service`,
      versionPath: `${controllerStateDir}/signer-version`,
      channelPath: `/etc/fased/local/${normalized}/update-channel`,
      journalPath: `${controllerStateDir}/active-signer-transaction.json`,
      rollbackFloorPath: `${controllerStateDir}/rollback-floor`,
      gatewayGatePath: `${controllerStateDir}/gateway-update-gate`,
      signerGatePath: `${controllerStateDir}/signer-update-gate`,
      transactionsDir: `${controllerStateDir}/transactions`,
    }),
  });
}

export function parseReleaseVersion(value) {
  const version = String(value ?? "")
    .trim()
    .replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error("version must be an exact semantic release version");
  }
  return version;
}

function parseTransactionId(value) {
  const transactionId = String(value ?? "").trim();
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new Error("transactionId must be a UUIDv4");
  }
  return transactionId.toLowerCase();
}

export function parseUpdateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request must be an object");
  }
  if (value.schemaVersion === 1) {
    throw new Error(PRE_V2_HOSTING_MIGRATION_MESSAGE);
  }
  const keys = Object.keys(value).toSorted();
  if (keys.join(",") !== "op,schemaVersion,transactionId,version") {
    throw new Error("request contains unsupported fields");
  }
  if (value.schemaVersion !== PROTOCOL_SCHEMA_VERSION || !TRANSACTION_OPERATIONS.has(value.op)) {
    throw new Error("unsupported updater transaction request");
  }
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    op: value.op,
    transactionId: parseTransactionId(value.transactionId),
    version: parseReleaseVersion(value.version),
  };
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    if (!match) {
      return null;
    }
    return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [] };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] < b.core[index] ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const l = a.prerelease[index];
    const r = b.prerelease[index];
    if (l === r) {
      continue;
    }
    if (l === undefined || r === undefined) {
      return l === undefined ? -1 : 1;
    }
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      return Number(l) < Number(r) ? -1 : 1;
    }
    if (ln !== rn) {
      return ln ? -1 : 1;
    }
    return l < r ? -1 : 1;
  }
  return 0;
}

function releaseArchitecture() {
  if (process.platform !== "linux") {
    throw new Error("host updater supports Linux only");
  }
  if (process.arch === "x64") {
    return "amd64";
  }
  if (process.arch === "arm64") {
    return "arm64";
  }
  throw new Error(`unsupported host architecture: ${process.arch}`);
}

async function fixedExecutable(candidates, label) {
  for (const candidate of candidates) {
    try {
      const resolved = await fsp.realpath(candidate);
      const stat = await fsp.stat(resolved);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
        continue;
      }
      await fsp.access(resolved, fs.constants.X_OK);
      return resolved;
    } catch {
      // Try the next root-controlled system path.
    }
  }
  throw new Error(`${label} is not installed in a root-controlled system path`);
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWriteFileDurable(targetPath, content, mode = 0o600) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fsp.open(temporaryPath, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.chmod(temporaryPath, mode);
  await fsp.rename(temporaryPath, targetPath);
  await fsyncDirectory(path.dirname(targetPath));
}

async function atomicCopyFileDurable(sourcePath, targetPath, metadata = {}) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(temporaryPath, metadata.mode ?? 0o600);
  if (Number.isInteger(metadata.uid) && Number.isInteger(metadata.gid)) {
    await fsp.chown(temporaryPath, metadata.uid, metadata.gid);
  }
  const handle = await fsp.open(temporaryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporaryPath, targetPath);
  await fsyncDirectory(path.dirname(targetPath));
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`official release download failed (${response.status})`);
  }
  await pipeline(response.body, fs.createWriteStream(destination, { mode: 0o600 }));
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

function releaseAttestationVerifyArgs(assetPath, version, bundlePath) {
  if (!bundlePath) {
    throw new Error("offline release attestation bundle is required");
  }
  return [
    "attestation",
    "verify",
    assetPath,
    "--repo",
    RELEASE_REPOSITORY,
    "--bundle",
    bundlePath,
    "--signer-workflow",
    RELEASE_WORKFLOW,
    "--source-ref",
    `refs/tags/v${version}`,
    "--deny-self-hosted-runners",
  ];
}

async function verifyReleaseAsset(assetPath, version, stateDir, bundlePath) {
  const gh = await fixedExecutable(["/usr/bin/gh", "/usr/local/bin/gh"], "GitHub CLI");
  await execFileAsync(gh, releaseAttestationVerifyArgs(assetPath, version, bundlePath), {
    env: {
      HOME: stateDir,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      GH_PROMPT_DISABLED: "1",
    },
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function parseControllerIdentity(value, expectedVersion) {
  const version = parseReleaseVersion(value?.version);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "clientSha256,schemaVersion,serverSha256,version" ||
    value.schemaVersion !== CONTROLLER_SELF_CHECK_SCHEMA_VERSION ||
    (expectedVersion && version !== expectedVersion) ||
    !/^[a-f0-9]{64}$/.test(value.serverSha256 || "") ||
    !/^[a-f0-9]{64}$/.test(value.clientSha256 || "")
  ) {
    throw new Error("host updater controller identity is malformed or mismatched");
  }
  return Object.freeze({
    schemaVersion: CONTROLLER_SELF_CHECK_SCHEMA_VERSION,
    version,
    serverSha256: value.serverSha256,
    clientSha256: value.clientSha256,
  });
}

async function readControllerIdentity(paths) {
  try {
    return parseControllerIdentity(
      JSON.parse(await fsp.readFile(paths.controllerVersionPath, "utf8")),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readControllerGenerationDigests(generationRoot) {
  const generationStat = await fsp.lstat(generationRoot);
  if (!generationStat.isDirectory() || generationStat.isSymbolicLink()) {
    throw new Error("host updater controller generation must be a real directory");
  }
  const serverPath = path.join(generationRoot, CONTROLLER_SERVER_NAME);
  const clientPath = path.join(generationRoot, CONTROLLER_CLIENT_NAME);
  const [serverStat, clientStat] = await Promise.all([
    fsp.lstat(serverPath),
    fsp.lstat(clientPath),
  ]);
  if (
    !serverStat.isFile() ||
    serverStat.isSymbolicLink() ||
    !clientStat.isFile() ||
    clientStat.isSymbolicLink()
  ) {
    throw new Error("host updater controller generation must contain regular controller files");
  }
  const [serverSha256, clientSha256] = await Promise.all([sha256(serverPath), sha256(clientPath)]);
  return { serverSha256, clientSha256 };
}

async function currentControllerMatches(paths, identity) {
  try {
    const currentStat = await fsp.lstat(paths.controllerCurrentLink);
    if (!currentStat.isSymbolicLink()) {
      throw new Error("host updater controller current path must be a root-managed symlink");
    }
    const expectedRoot = path.resolve(paths.controllerReleasesDir, `v${identity.version}`);
    const actualRoot = await fsp.realpath(paths.controllerCurrentLink);
    if (actualRoot !== expectedRoot) {
      return false;
    }
    const digests = await readControllerGenerationDigests(actualRoot);
    return (
      digests.serverSha256 === identity.serverSha256 &&
      digests.clientSha256 === identity.clientSha256
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function selfCheckControllerAsset(assetPath, role, stateDir) {
  const { stdout } = await execFileAsync(process.execPath, [assetPath, "--self-check"], {
    env: {
      HOME: stateDir,
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const value = JSON.parse(stdout);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "protocolVersion,role,schemaVersion" ||
    value.schemaVersion !== CONTROLLER_SELF_CHECK_SCHEMA_VERSION ||
    value.protocolVersion !== CONTROLLER_PROTOCOL_VERSION ||
    value.role !== role
  ) {
    throw new Error(`host updater ${role} controller self-check is incompatible`);
  }
}

async function atomicSymlinkDurable(target, linkPath) {
  await fsp.mkdir(path.dirname(linkPath), { recursive: true, mode: 0o755 });
  try {
    const existing = await fsp.lstat(linkPath);
    if (!existing.isSymbolicLink()) {
      throw new Error(`refusing to replace non-symlink controller path: ${linkPath}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const temporaryPath = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsp.symlink(target, temporaryPath, "dir");
    await fsp.rename(temporaryPath, linkPath);
    await fsyncDirectory(path.dirname(linkPath));
  } finally {
    await fsp.rm(temporaryPath, { force: true });
  }
}

async function stageOfficialControllerRelease(version, context) {
  const existingIdentity = await readControllerIdentity(context.paths);
  if (existingIdentity && compareVersions(existingIdentity.version, version) === 1) {
    throw new Error(
      `refusing host updater controller downgrade from ${existingIdentity.version} to ${version}`,
    );
  }
  if (
    existingIdentity?.version === version &&
    (await currentControllerMatches(context.paths, existingIdentity))
  ) {
    return { changed: false, identity: existingIdentity };
  }

  const releaseUrl = `${RELEASE_BASE}/v${version}`;
  await Promise.all([
    fsp.mkdir(context.paths.stateDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(context.paths.controllerReleasesDir, { recursive: true, mode: 0o755 }),
  ]);
  const downloadRoot = await fsp.mkdtemp(
    path.join(context.paths.stateDir, `.controller-download-${version}-`),
  );
  const generationRoot = path.join(context.paths.controllerReleasesDir, `v${version}`);
  let stagingGeneration = null;
  const serverPath = path.join(downloadRoot, CONTROLLER_SERVER_NAME);
  const clientPath = path.join(downloadRoot, CONTROLLER_CLIENT_NAME);
  const serverBundlePath = path.join(downloadRoot, CONTROLLER_SERVER_BUNDLE_NAME);
  const clientBundlePath = path.join(downloadRoot, CONTROLLER_CLIENT_BUNDLE_NAME);
  try {
    await Promise.all([
      context.downloadReleaseAsset(`${releaseUrl}/${CONTROLLER_SERVER_NAME}`, serverPath),
      context.downloadReleaseAsset(`${releaseUrl}/${CONTROLLER_CLIENT_NAME}`, clientPath),
      context.downloadReleaseAsset(
        `${releaseUrl}/${CONTROLLER_SERVER_BUNDLE_NAME}`,
        serverBundlePath,
      ),
      context.downloadReleaseAsset(
        `${releaseUrl}/${CONTROLLER_CLIENT_BUNDLE_NAME}`,
        clientBundlePath,
      ),
    ]);
    await Promise.all([
      context.verifyReleaseAsset(serverPath, version, context.paths.stateDir, serverBundlePath),
      context.verifyReleaseAsset(clientPath, version, context.paths.stateDir, clientBundlePath),
    ]);
    await Promise.all([
      context.selfCheckControllerAsset(serverPath, "server", context.paths.stateDir),
      context.selfCheckControllerAsset(clientPath, "client", context.paths.stateDir),
    ]);
    const identity = Object.freeze({
      schemaVersion: CONTROLLER_SELF_CHECK_SCHEMA_VERSION,
      version,
      serverSha256: await sha256(serverPath),
      clientSha256: await sha256(clientPath),
    });
    stagingGeneration = await fsp.mkdtemp(
      path.join(context.paths.controllerReleasesDir, `.controller-generation-${version}-`),
    );

    let previousGeneration = null;
    try {
      const currentStat = await fsp.lstat(context.paths.controllerCurrentLink);
      if (!currentStat.isSymbolicLink()) {
        throw new Error("host updater controller current path must be a root-managed symlink");
      }
      previousGeneration = await fsp.realpath(context.paths.controllerCurrentLink);
      const releasesRoot = path.resolve(context.paths.controllerReleasesDir);
      if (
        path.dirname(previousGeneration) !== releasesRoot ||
        !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(path.basename(previousGeneration))
      ) {
        throw new Error("host updater controller current symlink escapes the releases directory");
      }
      await readControllerGenerationDigests(previousGeneration);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    try {
      const generationIdentity = await readControllerGenerationDigests(generationRoot);
      if (
        generationIdentity.serverSha256 !== identity.serverSha256 ||
        generationIdentity.clientSha256 !== identity.clientSha256
      ) {
        throw new Error(`host updater controller generation v${version} is not immutable`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await Promise.all([
        atomicCopyFileDurable(serverPath, path.join(stagingGeneration, CONTROLLER_SERVER_NAME), {
          mode: 0o755,
        }),
        atomicCopyFileDurable(clientPath, path.join(stagingGeneration, CONTROLLER_CLIENT_NAME), {
          mode: 0o755,
        }),
      ]);
      await fsp.chmod(stagingGeneration, 0o755);
      await fsyncDirectory(stagingGeneration);
      await fsp.rename(stagingGeneration, generationRoot);
      await fsyncDirectory(context.paths.controllerReleasesDir);
    }

    await atomicSymlinkDurable(generationRoot, context.paths.controllerCurrentLink);
    await atomicWriteFileDurable(
      context.paths.controllerVersionPath,
      `${JSON.stringify(identity, null, 2)}\n`,
      0o600,
    );
    context.controllerRestartRequired = previousGeneration !== generationRoot;

    const keep = new Set([generationRoot, previousGeneration].filter(Boolean));
    for (const entry of await fsp.readdir(context.paths.controllerReleasesDir, {
      withFileTypes: true,
    })) {
      const candidate = path.join(context.paths.controllerReleasesDir, entry.name);
      if (entry.isDirectory() && /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.name)) {
        if (!keep.has(candidate)) {
          await fsp.rm(candidate, { recursive: true, force: true });
        }
      }
    }
    await fsyncDirectory(context.paths.controllerReleasesDir);
    return { changed: context.controllerRestartRequired, identity };
  } finally {
    await Promise.all([
      fsp.rm(downloadRoot, { recursive: true, force: true }),
      stagingGeneration
        ? fsp.rm(stagingGeneration, { recursive: true, force: true })
        : Promise.resolve(),
    ]);
  }
}

async function readVersionFile(filePath) {
  try {
    return parseReleaseVersion(await fsp.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function releaseAllowedForChannel(version, channel) {
  return !version.includes("-") || channel.trim() === "beta";
}

function parseSignerReleaseIdentity(value, expectedVersion) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("signer release identity is missing");
  }
  const keys = Object.keys(value).toSorted();
  if (keys.join(",") !== "buildInputDigest,commit,development,version") {
    throw new Error("signer release identity contains unsupported fields");
  }
  const version = parseReleaseVersion(value.version);
  if (
    (expectedVersion && version !== expectedVersion) ||
    !/^[a-f0-9]{40}$/.test(value.commit || "") ||
    !/^sha256:[a-f0-9]{64}$/.test(value.buildInputDigest || "") ||
    value.development !== false
  ) {
    throw new Error("signer release identity is development, malformed, or mismatched");
  }
  return Object.freeze({
    version,
    commit: value.commit,
    buildInputDigest: value.buildInputDigest,
    development: false,
  });
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

function parseUnifiedHostedSignerRelease(value, expectedVersion, platform) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "application,release,schemaVersion,signer" ||
    value.schemaVersion !== 2
  ) {
    throw new Error("attested unified hosted release manifest schema is invalid");
  }
  const release = value.release;
  if (
    !release ||
    Object.keys(release).toSorted().join(",") !== "commit,tag,version" ||
    release.version !== expectedVersion ||
    release.tag !== `v${expectedVersion}` ||
    !/^[a-f0-9]{40}$/.test(release.commit || "")
  ) {
    throw new Error("attested unified hosted release identity is malformed or mismatched");
  }
  const signer = value.signer;
  if (
    !signer ||
    Object.keys(signer).toSorted().join(",") !==
      "capabilities,capabilitiesDigest,platforms,release" ||
    !/^sha256:[a-f0-9]{64}$/.test(signer.capabilitiesDigest || "") ||
    `sha256:${createHash("sha256").update(canonicalJSON(signer.capabilities)).digest("hex")}` !==
      signer.capabilitiesDigest ||
    signer.capabilities?.protocol?.current !== 2 ||
    signer.capabilities?.protocol?.min !== 2 ||
    signer.capabilities?.protocol?.max !== 2
  ) {
    throw new Error("attested unified signer capability contract is invalid");
  }
  const signerRelease = parseSignerReleaseIdentity(signer.release, expectedVersion);
  if (signerRelease.commit !== release.commit) {
    throw new Error("attested hosted app and signer commits do not match");
  }
  const artifact = signer.platforms?.[platform];
  if (
    !artifact ||
    Object.keys(artifact).toSorted().join(",") !== "asset,sha256" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(artifact.asset || "") ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256 || "")
  ) {
    throw new Error(`attested unified signer release has no valid ${platform} artifact`);
  }
  const applicationArchitecture = platform === "linux-amd64" ? "x64" : "arm64";
  const application = value.application;
  const applicationEntry = application?.linux?.[applicationArchitecture];
  if (
    !application ||
    Object.keys(application).toSorted().join(",") !== "linux" ||
    Object.keys(application.linux ?? {})
      .toSorted()
      .join(",") !== "arm64,x64" ||
    !applicationEntry ||
    Object.keys(applicationEntry).toSorted().join(",") !== "artifact,dependencies" ||
    Object.keys(applicationEntry.artifact ?? {})
      .toSorted()
      .join(",") !== "asset,sha256" ||
    Object.keys(applicationEntry.dependencies ?? {})
      .toSorted()
      .join(",") !== "asset,dependencyHash,sha256" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(applicationEntry.artifact.asset || "") ||
    !/^[a-f0-9]{64}$/.test(applicationEntry.artifact.sha256 || "") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(applicationEntry.dependencies.asset || "") ||
    !/^[a-f0-9]{64}$/.test(applicationEntry.dependencies.sha256 || "") ||
    !/^[a-f0-9]{64}$/.test(applicationEntry.dependencies.dependencyHash || "")
  ) {
    throw new Error(
      `attested unified application release has no valid ${applicationArchitecture} artifact`,
    );
  }
  return {
    release: signerRelease,
    artifact,
    application: applicationEntry,
    binding: {
      releaseCommit: release.commit,
      capabilitiesDigest: signer.capabilitiesDigest,
    },
  };
}

function signerReleaseIdentitiesEqual(left, right) {
  return (
    left?.version === right?.version &&
    left?.commit === right?.commit &&
    left?.buildInputDigest === right?.buildInputDigest &&
    left?.development === false &&
    right?.development === false
  );
}

function signerStateInvariantFromHealth(result) {
  const policies = result?.policies;
  const networks = result?.network?.wallets;
  const webAuthn = result?.webAuthn;
  if (
    !Array.isArray(policies) ||
    !policies.every(
      (policy) =>
        typeof policy?.walletId === "string" &&
        typeof policy?.role === "string" &&
        Number.isSafeInteger(policy?.version) &&
        policy.version > 0 &&
        /^sha256:[a-f0-9]{64}$/.test(policy?.hash || ""),
    ) ||
    typeof result?.network?.ready !== "boolean" ||
    !Array.isArray(networks) ||
    !networks.every(
      (network) =>
        typeof network?.walletId === "string" &&
        typeof network?.configured === "boolean" &&
        Number.isSafeInteger(network?.version) &&
        network.version >= 0 &&
        typeof network?.ready === "boolean" &&
        (!network.configured || /^hmac-sha256:[a-f0-9]{64}$/.test(network?.hash || "")),
    ) ||
    typeof webAuthn?.configured !== "boolean" ||
    !Number.isSafeInteger(webAuthn?.credentialCount) ||
    webAuthn.credentialCount < 0 ||
    !Number.isSafeInteger(webAuthn?.credentialVersion) ||
    webAuthn.credentialVersion < 0 ||
    typeof webAuthn?.ready !== "boolean"
  ) {
    throw new Error("signer health state invariants are malformed");
  }
  return canonicalJSON({
    policies: [...policies].toSorted((left, right) => left.walletId.localeCompare(right.walletId)),
    network: {
      ready: result.network.ready,
      wallets: [...networks].toSorted((left, right) => left.walletId.localeCompare(right.walletId)),
    },
    webAuthn: {
      configured: webAuthn.configured,
      rpId: webAuthn.rpId || "",
      origins: [...(Array.isArray(webAuthn.origins) ? webAuthn.origins : [])].toSorted(
        (left, right) => String(left).localeCompare(String(right)),
      ),
      credentialCount: webAuthn.credentialCount,
      credentialVersion: webAuthn.credentialVersion,
      ready: webAuthn.ready,
    },
  });
}

async function assertReleaseChannelAllowed(version, channelPath) {
  let channel = "stable";
  try {
    const stat = await fsp.lstat(channelPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error(
        "host updater channel file must be root-owned and not writable by group/others",
      );
    }
    channel = await fsp.readFile(channelPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (!releaseAllowedForChannel(version, channel)) {
    throw new Error(
      "prerelease signer updates require root to set /etc/fased/host-updater-channel to beta",
    );
  }
}

function assertSignerV2Health(response, expectedRelease) {
  const protocol = response?.result?.capabilities?.protocol;
  if (
    response?.ok !== true ||
    response?.result?.ready !== true ||
    response?.result?.keystoreType !== "signer-owned-v2" ||
    protocol?.current !== 2 ||
    protocol?.min > 2 ||
    protocol?.max < 2 ||
    !Array.isArray(response?.result?.policies)
  ) {
    throw new Error("signer health did not acknowledge protocol v2 and signer-owned custody");
  }
  const release = parseSignerReleaseIdentity(response.result.release, expectedRelease?.version);
  if (expectedRelease && !signerReleaseIdentitiesEqual(release, expectedRelease)) {
    throw new Error("signer health release identity does not match the attested release manifest");
  }
  signerStateInvariantFromHealth(response.result);
  return release;
}

async function readSignerV2Health(socketPath = "/run/fased-signerd/app.sock") {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(3000);
    let body = "";
    socket.once("connect", () => socket.write(`${JSON.stringify({ op: "health" })}\n`));
    socket.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline < 0) {
        return;
      }
      socket.destroy();
      try {
        resolve(JSON.parse(body.slice(0, newline)));
      } catch {
        reject(new Error("signer health response is invalid"));
      }
    });
    socket.once("timeout", () => reject(new Error("signer health probe timed out")));
    socket.once("error", reject);
  });
}

export async function probeSignerV2(expectedRelease, socketPath) {
  const response = await readSignerV2Health(socketPath);
  return assertSignerV2Health(response, expectedRelease);
}

async function probeSignerStateV2(expectedRelease, socketPath) {
  const response = await readSignerV2Health(socketPath);
  const release = assertSignerV2Health(response, expectedRelease);
  return { release, invariant: signerStateInvariantFromHealth(response.result) };
}

async function systemctl(...args) {
  const binary = await fixedExecutable(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
  return await execFileAsync(binary, args, {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 60_000,
  });
}

async function stopSignerService(serviceName = "fased-signerd.service") {
  await systemctl("stop", serviceName);
}

async function startSignerService({
  requireV2,
  expectedRelease,
  serviceName = "fased-signerd.service",
  socketPath = "/run/fased-signerd/app.sock",
}) {
  await systemctl("start", serviceName);
  await systemctl("is-active", "--quiet", serviceName);
  if (!requireV2) {
    return;
  }
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await probeSignerStateV2(expectedRelease, socketPath);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`signer protocol v2 readiness failed: ${lastError?.message || "unknown error"}`);
}

function transactionPaths(paths, transactionId) {
  const transactionDir = path.join(paths.transactionsDir, transactionId);
  return {
    transactionDir,
    candidatePath: path.join(
      path.dirname(paths.signerPath),
      `.fased-signerd.candidate-${transactionId}`,
    ),
    previousBinaryPath: path.join(transactionDir, "fased-signerd.previous"),
    stateDBSnapshotPath: path.join(transactionDir, "state.db.previous"),
    signerUnitSnapshotPath: path.join(transactionDir, "fased-signerd.service.previous"),
  };
}

const PROTECTED_SERVICE_FILE_MAX_BYTES = 512 * 1024;

function validateProtectedServiceFileCapture(value, label, expectedRootUid) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "contentBase64,gid,mode,sha256,uid" ||
    typeof value.contentBase64 !== "string" ||
    value.contentBase64.length > PROTECTED_SERVICE_FILE_MAX_BYTES * 2 ||
    !Number.isSafeInteger(value.uid) ||
    value.uid !== expectedRootUid ||
    !Number.isSafeInteger(value.gid) ||
    value.gid < 0 ||
    !Number.isSafeInteger(value.mode) ||
    (value.mode & 0o022) !== 0 ||
    (value.mode & ~0o777) !== 0 ||
    !/^[a-f0-9]{64}$/u.test(value.sha256 || "")
  ) {
    throw new Error(`host updater ${label} snapshot is invalid`);
  }
  const content = Buffer.from(value.contentBase64, "base64");
  if (
    content.length === 0 ||
    content.length > PROTECTED_SERVICE_FILE_MAX_BYTES ||
    createHash("sha256").update(content).digest("hex") !== value.sha256
  ) {
    throw new Error(`host updater ${label} snapshot content is invalid`);
  }
  return Object.freeze({ ...value });
}

function validateProtectedServiceBoundary(value, context) {
  if (!context.paths.gatewayUnitPath && !context.paths.gatewayLauncherPath) {
    if (value != null) {
      throw new Error("host updater received a protected service transaction in Hosting mode");
    }
    return null;
  }
  if (
    !context.paths.gatewayUnitPath ||
    !context.paths.gatewayLauncherPath ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "changed,gatewayLauncher,gatewayUnit" ||
    typeof value.changed !== "boolean"
  ) {
    throw new Error("host updater protected service transaction is invalid");
  }
  if (!value.changed) {
    if (value.gatewayUnit !== null || value.gatewayLauncher !== null) {
      throw new Error("host updater unchanged protected service transaction has snapshots");
    }
    return Object.freeze({
      changed: false,
      gatewayUnit: null,
      gatewayLauncher: null,
    });
  }
  return Object.freeze({
    changed: true,
    gatewayUnit: validateProtectedServiceFileCapture(
      value.gatewayUnit,
      "Gateway unit",
      context.rootUid,
    ),
    gatewayLauncher: validateProtectedServiceFileCapture(
      value.gatewayLauncher,
      "Gateway launcher",
      context.rootUid,
    ),
  });
}

async function captureProtectedServiceFile(filePath, label, expectedRootUid) {
  const info = await fsp.lstat(filePath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== expectedRootUid ||
    (info.mode & 0o022) !== 0 ||
    info.size <= 0 ||
    info.size > PROTECTED_SERVICE_FILE_MAX_BYTES
  ) {
    throw new Error(`${label} must be a bounded root-owned non-writable regular file`);
  }
  const content = await fsp.readFile(filePath);
  return Object.freeze({
    contentBase64: content.toString("base64"),
    uid: info.uid,
    gid: info.gid,
    mode: info.mode & 0o777,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}

function replaceExactlyOneLine(content, pattern, replacement, label) {
  const matches = content.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`protected Local ${label} is missing or ambiguous`);
  }
  return content.replace(pattern, replacement);
}

function upsertSystemdEnvironment(content, key, value) {
  const pattern = new RegExp(`^Environment=${key}=.*$`, "gmu");
  const matches = content.match(pattern) || [];
  if (matches.length > 1) {
    throw new Error(`protected Local Gateway unit has duplicate ${key} entries`);
  }
  if (matches.length === 1) {
    return content.replace(pattern, `Environment=${key}=${value}`);
  }
  const anchor = /^Environment=FASED_STATE_DIR=.*$/mu;
  if (!anchor.test(content)) {
    throw new Error("protected Local Gateway unit has no FASED_STATE_DIR");
  }
  return content.replace(anchor, (line) => `${line}\nEnvironment=${key}=${value}`);
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function renderProtectedGatewayLauncher({ applicationRoot, nodeBinary, stateDir, gatewayPort }) {
  const application = shellSingleQuote(applicationRoot);
  const node = shellSingleQuote(nodeBinary);
  const config = shellSingleQuote(path.join(stateDir, "fased.json"));
  const port = String(gatewayPort);
  return `#!/usr/bin/env bash
set -euo pipefail
[[ -s ${config} ]] || {
  echo "protected Local Gateway configuration is unavailable" >&2
  exit 78
}
gateway_entry=""
for candidate in \\
  ${application}/dist/entry.js \\
  ${application}/dist/entry.mjs \\
  ${application}/dist/index.js \\
  ${application}/dist/index.mjs; do
  if [[ -f "$candidate" && ! -L "$candidate" ]]; then
    gateway_entry="$candidate"
    break
  fi
done
[[ -n "$gateway_entry" ]] || {
  echo "protected Local Gateway entrypoint is unavailable" >&2
  exit 78
}
runtime_version="$(${node} -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = process.argv[1];
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const buildVersion = JSON.parse(fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8")).version;
  if (typeof packageVersion !== "string" || !packageVersion.trim() || packageVersion !== buildVersion) {
    process.exit(1);
  }
  process.stdout.write(packageVersion.trim());
' ${application})" || {
  echo "protected Local Gateway release identity is unavailable or inconsistent" >&2
  exit 78
}
export FASED_VERSION="$runtime_version"
exec ${node} \\
  --disable-warning=ExperimentalWarning \\
  --disable-warning=DEP0040 \\
  "$gateway_entry" gateway --allow-unconfigured --force --bind loopback --port ${shellSingleQuote(port)}
`;
}

function protectedServiceDesiredContent(context, boundary) {
  const applicationRoot = context.paths.applicationCurrentLink;
  const nodeBinary = fs.realpathSync(context.protectedNodeBinary);
  const nodeInfo = fs.lstatSync(nodeBinary);
  if (
    !nodeInfo.isFile() ||
    nodeInfo.isSymbolicLink() ||
    nodeInfo.uid !== context.rootUid ||
    (nodeInfo.mode & 0o022) !== 0 ||
    (nodeInfo.mode & 0o111) === 0
  ) {
    throw new Error("protected Local controller Node.js runtime is not root-controlled");
  }
  let gatewayUnit = Buffer.from(boundary.gatewayUnit.contentBase64, "base64").toString("utf8");
  if (
    !gatewayUnit.includes(`Environment=FASED_PROTECTED_LOCAL_INSTANCE=${context.instanceId}`) ||
    !gatewayUnit.includes(`User=fsgw-${context.instanceId}`) ||
    !gatewayUnit.includes("ProtectSystem=strict")
  ) {
    throw new Error("protected Local Gateway unit identity or hardening is invalid");
  }
  gatewayUnit = replaceExactlyOneLine(
    gatewayUnit,
    /^WorkingDirectory=.*$/gmu,
    `WorkingDirectory=${applicationRoot}`,
    "Gateway working directory",
  );
  gatewayUnit = upsertSystemdEnvironment(
    gatewayUnit,
    "FASED_CONFIG_DIR",
    gatewayUnit.match(/^Environment=FASED_STATE_DIR=(.*)$/mu)?.[1] || "",
  );
  gatewayUnit = upsertSystemdEnvironment(
    gatewayUnit,
    "FASED_MANAGED_RUNTIME_ROOT",
    applicationRoot,
  );
  gatewayUnit = upsertSystemdEnvironment(gatewayUnit, "FASED_NODE_BIN", nodeBinary);
  gatewayUnit = upsertSystemdEnvironment(gatewayUnit, "PATH", "/usr/local/bin:/usr/bin:/bin");
  gatewayUnit = upsertSystemdEnvironment(gatewayUnit, "FASED_RUNTIME_SOURCE", "managed-package");

  const gatewayLauncher = Buffer.from(boundary.gatewayLauncher.contentBase64, "base64").toString(
    "utf8",
  );
  if (!gatewayLauncher.startsWith("#!/usr/bin/env bash\nset -euo pipefail\n")) {
    throw new Error("protected Local Gateway launcher is invalid");
  }
  const stateDir = gatewayUnit.match(/^Environment=FASED_STATE_DIR=(.*)$/mu)?.[1] || "";
  const gatewayPort = gatewayUnit.match(/^Environment=FASED_GATEWAY_PORT=(\d+)$/mu)?.[1] || "";
  if (!path.isAbsolute(stateDir) || !/^\d{1,5}$/u.test(gatewayPort)) {
    throw new Error("protected Local Gateway unit is missing its state directory or port");
  }
  const renderedLauncher = renderProtectedGatewayLauncher({
    applicationRoot,
    nodeBinary,
    stateDir,
    gatewayPort,
  });
  return Object.freeze({
    gatewayUnit,
    gatewayLauncher: renderedLauncher,
  });
}

async function stageProtectedServiceBoundary(context) {
  if (!context.paths.gatewayUnitPath && !context.paths.gatewayLauncherPath) {
    return null;
  }
  const gatewayUnit = await captureProtectedServiceFile(
    context.paths.gatewayUnitPath,
    "protected Local Gateway unit",
    context.rootUid,
  );
  const gatewayLauncher = await captureProtectedServiceFile(
    context.paths.gatewayLauncherPath,
    "protected Local Gateway launcher",
    context.rootUid,
  );
  const snapshots = { changed: true, gatewayUnit, gatewayLauncher };
  const desired = protectedServiceDesiredContent(context, snapshots);
  const changed =
    desired.gatewayUnit !== Buffer.from(gatewayUnit.contentBase64, "base64").toString("utf8") ||
    desired.gatewayLauncher !==
      Buffer.from(gatewayLauncher.contentBase64, "base64").toString("utf8");
  return changed
    ? snapshots
    : Object.freeze({ changed: false, gatewayUnit: null, gatewayLauncher: null });
}

async function writeProtectedServiceFile(filePath, content, captured) {
  await atomicWriteFileDurable(filePath, content, captured.mode);
  await fsp.chown(filePath, captured.uid, captured.gid);
}

async function applyProtectedServiceBoundary(context, boundary) {
  if (!boundary?.changed) {
    return;
  }
  const desired = protectedServiceDesiredContent(context, boundary);
  const pairs = [
    [
      context.paths.gatewayUnitPath,
      boundary.gatewayUnit,
      Buffer.from(desired.gatewayUnit),
      "protected Local Gateway unit",
    ],
    [
      context.paths.gatewayLauncherPath,
      boundary.gatewayLauncher,
      Buffer.from(desired.gatewayLauncher),
      "protected Local Gateway launcher",
    ],
  ];
  for (const [filePath, captured, nextContent, label] of pairs) {
    const current = await captureProtectedServiceFile(filePath, label, context.rootUid);
    const desiredDigest = createHash("sha256").update(nextContent).digest("hex");
    if (current.sha256 === desiredDigest) {
      continue;
    }
    if (current.sha256 !== captured.sha256) {
      throw new Error(`${label} changed during the protected release transaction`);
    }
    await writeProtectedServiceFile(filePath, nextContent, captured);
  }
  await context.reloadUnits();
}

async function restoreProtectedServiceBoundary(context, boundary) {
  if (!boundary?.changed) {
    return;
  }
  const desired = protectedServiceDesiredContent(context, boundary);
  const pairs = [
    [
      context.paths.gatewayUnitPath,
      boundary.gatewayUnit,
      Buffer.from(desired.gatewayUnit),
      "protected Local Gateway unit",
    ],
    [
      context.paths.gatewayLauncherPath,
      boundary.gatewayLauncher,
      Buffer.from(desired.gatewayLauncher),
      "protected Local Gateway launcher",
    ],
  ];
  for (const [filePath, captured, desiredContent, label] of pairs) {
    const current = await captureProtectedServiceFile(filePath, label, context.rootUid);
    if (current.sha256 === captured.sha256) {
      continue;
    }
    const desiredDigest = createHash("sha256").update(desiredContent).digest("hex");
    if (current.sha256 !== desiredDigest) {
      throw new Error(`${label} changed while restoring the protected release transaction`);
    }
    await writeProtectedServiceFile(
      filePath,
      Buffer.from(captured.contentBase64, "base64"),
      captured,
    );
  }
  await context.reloadUnits();
}

function validateJournal(value, context) {
  if (
    !value ||
    typeof value !== "object" ||
    !new Set([1, JOURNAL_SCHEMA_VERSION]).has(value.schemaVersion) ||
    !TRANSACTION_PHASES.has(value.phase)
  ) {
    throw new Error("host updater transaction journal is invalid");
  }
  if (
    value.previousSignerInvariant != null &&
    (typeof value.previousSignerInvariant !== "string" ||
      value.previousSignerInvariant.length === 0 ||
      value.previousSignerInvariant.length > 64 * 1024)
  ) {
    throw new Error("host updater previous signer-state invariant is invalid");
  }
  const version = parseReleaseVersion(value.version);
  let application = null;
  if (value.application != null) {
    if (
      !value.application ||
      typeof value.application !== "object" ||
      Array.isArray(value.application) ||
      Object.keys(value.application).toSorted().join(",") !== "changed,previousRoot,targetRoot" ||
      typeof value.application.changed !== "boolean"
    ) {
      throw new Error("host updater protected application transaction is invalid");
    }
    const targetRoot = protectedApplicationReleaseRoot(context.paths, version);
    const previousRoot =
      value.application.previousRoot == null
        ? null
        : path.resolve(String(value.application.previousRoot));
    const releasesRoot = path.resolve(context.paths.applicationReleasesDir ?? "/nonexistent");
    if (
      path.resolve(String(value.application.targetRoot ?? "")) !== targetRoot ||
      (previousRoot !== null && path.dirname(previousRoot) !== releasesRoot)
    ) {
      throw new Error("host updater protected application transaction escaped its release root");
    }
    application = {
      changed: value.application.changed,
      targetRoot,
      previousRoot,
    };
  } else if (context.paths.applicationReleasesDir) {
    throw new Error("host updater protected application transaction is missing");
  }
  const serviceBoundary = validateProtectedServiceBoundary(value.serviceBoundary, context);
  const releaseBinding = value.releaseBinding == null ? null : value.releaseBinding;
  if (
    releaseBinding &&
    (!/^sha256:[a-f0-9]{64}$/.test(releaseBinding.manifestDigest || "") ||
      !/^sha256:[a-f0-9]{64}$/.test(releaseBinding.signerArtifactDigest || "") ||
      !/^sha256:[a-f0-9]{64}$/.test(releaseBinding.capabilitiesDigest || "") ||
      !/^[a-f0-9]{40}$/.test(releaseBinding.releaseCommit || ""))
  ) {
    throw new Error("host updater release-manifest binding is invalid");
  }
  return {
    ...value,
    transactionId: parseTransactionId(value.transactionId),
    version,
    previousVersion:
      value.previousVersion == null ? null : parseReleaseVersion(value.previousVersion),
    release: parseSignerReleaseIdentity(value.release, version),
    releaseBinding,
    application,
    serviceBoundary,
    changed: value.changed === true,
  };
}

async function readJournal(context) {
  try {
    return validateJournal(
      JSON.parse(await fsp.readFile(context.paths.journalPath, "utf8")),
      context,
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJournal(context, journal) {
  const next = validateJournal(
    {
      ...journal,
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    },
    context,
  );
  await atomicWriteFileDurable(
    context.paths.journalPath,
    `${JSON.stringify(next, null, 2)}\n`,
    0o600,
  );
  return next;
}

async function removeJournal(context) {
  await fsp.rm(context.paths.journalPath, { force: true });
  await fsyncDirectory(path.dirname(context.paths.journalPath));
}

async function fileMetadata(filePath) {
  try {
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`transaction source must be a regular non-symlink file: ${filePath}`);
    }
    return { existed: true, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { existed: false };
    }
    throw error;
  }
}

async function cleanupTransactionFiles(context, transactionId) {
  const txPaths = transactionPaths(context.paths, transactionId);
  await fsp.rm(txPaths.candidatePath, { force: true });
  await fsp.rm(txPaths.transactionDir, { recursive: true, force: true });
  await fsyncDirectory(path.dirname(txPaths.candidatePath));
  await fsyncDirectory(context.paths.transactionsDir).catch((error) => {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  });
}

function protectedApplicationReleaseRoot(paths, version) {
  if (!paths.applicationReleasesDir || !paths.applicationCurrentLink) {
    throw new Error("protected application runtime paths are unavailable");
  }
  const releases = path.resolve(paths.applicationReleasesDir);
  const releaseRoot = path.resolve(releases, `v${parseReleaseVersion(version)}`);
  if (path.dirname(releaseRoot) !== releases) {
    throw new Error("protected application release path escaped its root");
  }
  return releaseRoot;
}

async function prepareProtectedApplicationDirectories(paths) {
  if (!paths.applicationReleasesDir || !paths.applicationCurrentLink) {
    throw new Error("protected application runtime paths are unavailable");
  }
  const releasesDir = path.resolve(paths.applicationReleasesDir);
  const applicationDir = path.dirname(releasesDir);
  const currentLink = path.resolve(paths.applicationCurrentLink);
  if (
    path.basename(releasesDir) !== "releases" ||
    currentLink !== path.join(applicationDir, "current")
  ) {
    throw new Error("protected application runtime layout is invalid");
  }
  const ownerUid = process.geteuid();
  const ownerGid = process.getegid();
  for (const directory of [applicationDir, releasesDir]) {
    try {
      await fsp.mkdir(directory, { mode: 0o755 });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
    const info = await fsp.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ownerUid) {
      throw new Error(`protected application runtime directory is unsafe: ${directory}`);
    }
    await fsp.chown(directory, ownerUid, ownerGid);
    await fsp.chmod(directory, 0o755);
  }
}

async function copyProtectedApplicationTree(source, destination) {
  const cp = await fixedExecutable(["/usr/bin/cp", "/bin/cp"], "cp");
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await execFileAsync(cp, ["-a", "--no-preserve=links", source, destination], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function hardenProtectedApplicationTree(root) {
  const ownerUid = process.geteuid();
  const ownerGid = process.getegid();
  const [find, chown, chmod] = await Promise.all([
    fixedExecutable(["/usr/bin/find", "/bin/find"], "find"),
    fixedExecutable(["/usr/bin/chown", "/bin/chown"], "chown"),
    fixedExecutable(["/usr/bin/chmod", "/bin/chmod"], "chmod"),
  ]);
  const common = {
    env: { PATH: "/usr/bin:/bin" },
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  };
  const unsupported = await execFileAsync(
    find,
    [root, "-xdev", "!", "-type", "f", "!", "-type", "d", "!", "-type", "l", "-print", "-quit"],
    common,
  );
  if (unsupported.stdout.trim()) {
    throw new Error(
      `protected application contains an unsupported entry: ${unsupported.stdout.trim()}`,
    );
  }
  const links = await execFileAsync(find, [root, "-xdev", "-type", "l", "-print0"], common);
  for (const candidate of links.stdout.split("\0").filter(Boolean)) {
    const target = await fsp.realpath(candidate);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`protected application contains an escaping symlink: ${candidate}`);
    }
  }
  await execFileAsync(chown, ["-R", `${ownerUid}:${ownerGid}`, root], common);
  await execFileAsync(chmod, ["-R", "a+rX,go-w", root], common);
}

async function verifyProtectedApplicationRuntime(root, version, commit, dependencyHash = null) {
  const canonical = await fsp.realpath(root);
  const [packageValue, buildValue, metadataValue] = await Promise.all([
    fsp.readFile(path.join(canonical, "package.json"), "utf8").then(JSON.parse),
    fsp.readFile(path.join(canonical, "dist", "build-info.json"), "utf8").then(JSON.parse),
    fsp.readFile(path.join(canonical, ".fased-hosted-runtime.json"), "utf8").then(JSON.parse),
  ]);
  if (
    packageValue?.version !== version ||
    buildValue?.version !== version ||
    buildValue?.commit !== commit ||
    metadataValue?.version !== version ||
    metadataValue?.commit !== commit ||
    (dependencyHash && metadataValue?.dependencyHash !== dependencyHash)
  ) {
    throw new Error("protected application runtime identity is mismatched");
  }
  const required = [
    path.join(canonical, "fased.mjs"),
    path.join(canonical, "scripts", "start-managed.sh"),
    path.join(canonical, "node_modules"),
  ];
  const [cli, launcher, dependencies] = await Promise.all(
    required.map((entry) => fsp.lstat(entry)),
  );
  if (
    !cli.isFile() ||
    cli.isSymbolicLink() ||
    !launcher.isFile() ||
    launcher.isSymbolicLink() ||
    !dependencies.isDirectory() ||
    dependencies.isSymbolicLink()
  ) {
    throw new Error("protected application runtime is incomplete");
  }
  return canonical;
}

export async function installProtectedLocalApplicationRuntime(params) {
  const version = parseReleaseVersion(params.version);
  const commit = String(params.commit ?? "").trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("protected application release commit is invalid");
  }
  const releaseRoot = protectedApplicationReleaseRoot(params.paths, version);
  await prepareProtectedApplicationDirectories(params.paths);
  let ready = false;
  try {
    await verifyProtectedApplicationRuntime(releaseRoot, version, commit);
    ready = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (!ready) {
    const staging = `${releaseRoot}.staging-${process.pid}-${Date.now()}`;
    await fsp.rm(staging, { recursive: true, force: true });
    try {
      await copyProtectedApplicationTree(params.sourceRoot, staging);
      if (params.dependencyRoot) {
        await copyProtectedApplicationTree(
          params.dependencyRoot,
          path.join(staging, "node_modules"),
        );
      }
      await hardenProtectedApplicationTree(staging);
      await verifyProtectedApplicationRuntime(staging, version, commit);
      await fsp.rename(staging, releaseRoot);
      await fsyncDirectory(params.paths.applicationReleasesDir);
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
  }
  await atomicSymlinkDurable(releaseRoot, params.paths.applicationCurrentLink);
  return { releaseRoot, previousRoot: null };
}

async function listArchiveEntries(archivePath, allowedRoot) {
  const tar = await fixedExecutable(["/usr/bin/tar", "/bin/tar"], "tar");
  const { stdout } = await execFileAsync(tar, ["-tzf", archivePath], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const raw of stdout.split(/\r?\n/u).filter(Boolean)) {
    const entry = raw.replace(/\/+$/u, "");
    const parts = entry.split("/");
    if (
      !entry ||
      entry.startsWith("/") ||
      entry.includes("\\") ||
      parts[0] !== allowedRoot ||
      parts.some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`protected application archive contains an unsafe path: ${raw}`);
    }
  }
  return tar;
}

async function extractProtectedArchive(archivePath, destination, allowedRoot) {
  const tar = await listArchiveEntries(archivePath, allowedRoot);
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  await execFileAsync(
    tar,
    ["-xzf", archivePath, "-C", destination, "--no-same-owner", "--no-same-permissions"],
    {
      env: { PATH: "/usr/bin:/bin" },
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

async function stageProtectedApplicationRelease({
  version,
  selected,
  releaseUrl,
  manifestBytes,
  staging,
  context,
}) {
  await prepareProtectedApplicationDirectories(context.paths);
  const releaseRoot = protectedApplicationReleaseRoot(context.paths, version);
  let previousRoot = null;
  try {
    previousRoot = await fsp.realpath(context.paths.applicationCurrentLink);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await verifyProtectedApplicationRuntime(
      releaseRoot,
      version,
      selected.release.commit,
      selected.application.dependencies.dependencyHash,
    );
    return { targetRoot: releaseRoot, previousRoot, changed: previousRoot !== releaseRoot };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const appArchive = path.join(staging, selected.application.artifact.asset);
  const dependencyArchive = path.join(staging, selected.application.dependencies.asset);
  await Promise.all([
    context.downloadReleaseAsset(
      `${releaseUrl}/${selected.application.artifact.asset}`,
      appArchive,
    ),
    context.downloadReleaseAsset(
      `${releaseUrl}/${selected.application.dependencies.asset}`,
      dependencyArchive,
    ),
  ]);
  const [appDigest, dependencyDigest] = await Promise.all([
    sha256(appArchive),
    sha256(dependencyArchive),
  ]);
  if (
    appDigest !== selected.application.artifact.sha256 ||
    dependencyDigest !== selected.application.dependencies.sha256
  ) {
    throw new Error("protected application layers do not match the attested release manifest");
  }

  const candidateParent = `${releaseRoot}.staging-${process.pid}-${Date.now()}`;
  await fsp.rm(candidateParent, { recursive: true, force: true });
  try {
    await extractProtectedArchive(appArchive, candidateParent, "package");
    const candidateRoot = path.join(candidateParent, "package");
    await extractProtectedArchive(dependencyArchive, candidateRoot, "node_modules");
    await fsp.writeFile(path.join(candidateRoot, ".fased-hosted-release-v2.json"), manifestBytes, {
      mode: 0o644,
    });
    await hardenProtectedApplicationTree(candidateRoot);
    await verifyProtectedApplicationRuntime(
      candidateRoot,
      version,
      selected.release.commit,
      selected.application.dependencies.dependencyHash,
    );
    await fsp.rename(candidateRoot, releaseRoot);
    await fsyncDirectory(context.paths.applicationReleasesDir);
  } finally {
    await fsp.rm(candidateParent, { recursive: true, force: true });
  }
  return { targetRoot: releaseRoot, previousRoot, changed: previousRoot !== releaseRoot };
}

async function stageOfficialCandidate(version, candidatePath, context) {
  const arch = releaseArchitecture();
  const platform = `linux-${arch}`;
  const releaseUrl = `${RELEASE_BASE}/v${version}`;
  await fsp.mkdir(context.paths.stateDir, { recursive: true, mode: 0o700 });
  const staging = await fsp.mkdtemp(path.join(context.paths.stateDir, `.download-${version}-`));
  const releaseManifestPath = path.join(staging, RELEASE_MANIFEST_NAME);
  const releaseManifestBundlePath = path.join(staging, RELEASE_MANIFEST_BUNDLE_NAME);
  const signerAttestationBundlePath = path.join(staging, SIGNER_ATTESTATION_BUNDLE_NAME);
  try {
    await Promise.all([
      context.downloadReleaseAsset(`${releaseUrl}/${RELEASE_MANIFEST_NAME}`, releaseManifestPath),
      context.downloadReleaseAsset(
        `${releaseUrl}/${RELEASE_MANIFEST_BUNDLE_NAME}`,
        releaseManifestBundlePath,
      ),
    ]);
    await context.verifyReleaseAsset(
      releaseManifestPath,
      version,
      context.paths.stateDir,
      releaseManifestBundlePath,
    );
    const manifestBytes = await fsp.readFile(releaseManifestPath);
    const selected = parseUnifiedHostedSignerRelease(
      JSON.parse(manifestBytes.toString("utf8")),
      version,
      platform,
    );
    const assetPath = path.join(staging, selected.artifact.asset);
    await Promise.all([
      context.downloadReleaseAsset(`${releaseUrl}/${selected.artifact.asset}`, assetPath),
      context.downloadReleaseAsset(
        `${releaseUrl}/${SIGNER_ATTESTATION_BUNDLE_NAME}`,
        signerAttestationBundlePath,
      ),
    ]);
    if ((await sha256(assetPath)) !== selected.artifact.sha256) {
      throw new Error("native signer does not match the attested unified release manifest");
    }
    await context.verifyReleaseAsset(
      assetPath,
      version,
      context.paths.stateDir,
      signerAttestationBundlePath,
    );
    await fsp.rm(candidatePath, { force: true });
    await atomicCopyFileDurable(assetPath, candidatePath, { mode: 0o755 });
    const application = context.paths.applicationReleasesDir
      ? await stageProtectedApplicationRelease({
          version,
          selected,
          releaseUrl,
          manifestBytes,
          staging,
          context,
        })
      : null;
    return {
      release: selected.release,
      application,
      binding: {
        ...selected.binding,
        manifestDigest: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
        signerArtifactDigest: `sha256:${selected.artifact.sha256}`,
      },
    };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

const ROOT_MANAGED_OPERATOR_ONLY_STATE = new Set([
  "backups",
  "bin",
  "extensions",
  "install-cache",
  "runtime",
  "signer-update",
  "source-paired-update",
  "updater",
]);

async function systemAccountRecord(database, name) {
  const getent = await fixedExecutable(["/usr/bin/getent", "/bin/getent"], "getent");
  const { stdout } = await execFileAsync(getent, [database, name], {
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const line = stdout.trim();
  const fields = line.split(":");
  const identityMatches =
    fields[0] === name || (database === "passwd" && /^\d+$/u.test(name) && fields[2] === name);
  if (
    (database === "passwd" && fields.length < 7) ||
    (database === "group" && fields.length < 4) ||
    !identityMatches
  ) {
    throw new Error(`root-managed ${database} identity is malformed`);
  }
  return fields;
}

function exactUnitValue(content, key) {
  const pattern = new RegExp(`^${key}=(.*)$`, "gmu");
  const matches = [...content.matchAll(pattern)];
  if (matches.length !== 1 || !matches[0][1]) {
    throw new Error(`root-managed Gateway unit has an invalid ${key}`);
  }
  return matches[0][1];
}

async function shareRootManagedApplicationEntry(entryPath, configGid) {
  const stat = await fsp.lstat(entryPath);
  if (stat.isSymbolicLink()) {
    await fsp.lchown(entryPath, stat.uid, configGid);
    return;
  }
  if (stat.isDirectory()) {
    const entries = await fsp.readdir(entryPath);
    for (const entry of entries) {
      await shareRootManagedApplicationEntry(path.join(entryPath, entry), configGid);
    }
    await fsp.chown(entryPath, stat.uid, configGid);
    await fsp.chmod(entryPath, 0o2770);
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`root-managed application state contains an unsupported entry: ${entryPath}`);
  }
  if (stat.nlink !== 1) {
    throw new Error(`root-managed application state contains a hard-linked file: ${entryPath}`);
  }
  await fsp.chown(entryPath, stat.uid, configGid);
  await fsp.chmod(entryPath, 0o660 | (stat.mode & 0o110));
}

function rootManagedApplicationIdentity(context, unit) {
  const protectedLocal = Boolean(context.instanceId);
  const gatewayUnitPath = protectedLocal
    ? context.paths.gatewayUnitPath
    : "/etc/systemd/system/fased-gateway.service";
  const gatewayUser = exactUnitValue(unit, "User");
  const stateDir = protectedLocal
    ? exactUnitValue(unit, "Environment=FASED_STATE_DIR")
    : path.join(exactUnitValue(unit, "Environment=HOME"), ".fased");
  const configGroup = protectedLocal ? `fscf-${context.instanceId}` : "fased-config";
  const expectedGatewayUser = protectedLocal ? `fsgw-${context.instanceId}` : "fased-gateway";
  const supplementaryGroups = exactUnitValue(unit, "SupplementaryGroups").split(/\s+/u);
  if (
    gatewayUser !== expectedGatewayUser ||
    !supplementaryGroups.includes(configGroup) ||
    !path.isAbsolute(stateDir) ||
    path.basename(stateDir) !== ".fased" ||
    (!protectedLocal && exactUnitValue(unit, "Environment=FASED_HOST_PROFILE") !== "hosting")
  ) {
    throw new Error("root-managed Gateway application-state identity is invalid");
  }
  return { configGroup, gatewayUnitPath, gatewayUser, protectedLocal, stateDir };
}

async function reconcileProtectedApplicationState(context) {
  const protectedLocal = Boolean(context.instanceId);
  const gatewayUnitPath = protectedLocal
    ? context.paths.gatewayUnitPath
    : "/etc/systemd/system/fased-gateway.service";
  const gatewayUnit = await fileMetadata(gatewayUnitPath);
  if (!gatewayUnit.existed && !protectedLocal) {
    // Fresh Hosting prepares the signer before the root Gateway unit exists.
    // The installer reconciles the state immediately after it creates that unit.
    return { changed: false, pendingGatewayUnit: true };
  }
  if (
    !gatewayUnit.existed ||
    gatewayUnit.uid !== context.rootUid ||
    (gatewayUnit.mode & 0o022) !== 0
  ) {
    throw new Error("root-managed Gateway unit is not root-controlled");
  }
  const unit = await fsp.readFile(gatewayUnitPath, "utf8");
  const identity = rootManagedApplicationIdentity(context, unit);
  const { configGroup, gatewayUser, stateDir } = identity;
  const stateStat = await fsp.lstat(stateDir);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink() || stateStat.uid === context.rootUid) {
    throw new Error("root-managed application state directory is invalid");
  }
  const operatorFields = await systemAccountRecord("passwd", String(stateStat.uid));
  const gatewayFields = await systemAccountRecord("passwd", gatewayUser);
  const groupFields = await systemAccountRecord("group", configGroup);
  const configGid = Number(groupFields[2]);
  const members = new Set(
    String(groupFields[3] || "")
      .split(",")
      .filter(Boolean),
  );
  if (
    !Number.isSafeInteger(configGid) ||
    configGid <= 0 ||
    Number(operatorFields[2]) !== stateStat.uid ||
    !members.has(operatorFields[0]) ||
    !members.has(gatewayFields[0])
  ) {
    throw new Error("root-managed application-state group membership is invalid");
  }
  const entries = await fsp.readdir(stateDir);
  for (const entry of entries) {
    if (ROOT_MANAGED_OPERATOR_ONLY_STATE.has(entry)) {
      continue;
    }
    await shareRootManagedApplicationEntry(path.join(stateDir, entry), configGid);
  }
  await fsp.chown(stateDir, stateStat.uid, configGid);
  await fsp.chmod(stateDir, 0o2770);
  await fsyncDirectory(stateDir);
  return { changed: true, stateDir, configGid };
}

function createTransactionContext(overrides = {}) {
  const paths = { ...DEFAULT_PATHS, ...overrides.paths };
  const signerServiceName = overrides.signerServiceName ?? "fased-signerd.service";
  const gatewayServiceName = overrides.gatewayServiceName ?? "fased-gateway.service";
  const signerApplicationSocketPath =
    overrides.signerApplicationSocketPath ?? "/run/fased-signerd/app.sock";
  const context = {
    paths,
    instanceId: overrides.protectedLocalInstanceId ?? null,
    rootUid: overrides.rootUid ?? (typeof process.geteuid === "function" ? process.geteuid() : 0),
    protectedNodeBinary: overrides.protectedNodeBinary ?? process.execPath,
    controllerInstanceId: overrides.controllerInstanceId ?? randomUUID(),
    controllerRestartRequired: false,
    assertReleaseAllowed:
      overrides.assertReleaseAllowed ??
      (async (version) => await assertReleaseChannelAllowed(version, paths.channelPath)),
    downloadReleaseAsset: overrides.downloadReleaseAsset ?? download,
    verifyReleaseAsset: overrides.verifyReleaseAsset ?? verifyReleaseAsset,
    selfCheckControllerAsset: overrides.selfCheckControllerAsset ?? selfCheckControllerAsset,
    stageControllerRelease:
      overrides.stageControllerRelease ??
      (async (version, transactionContext) =>
        await stageOfficialControllerRelease(version, transactionContext)),
    stageCandidate:
      overrides.stageCandidate ??
      (async (version, candidatePath, context) =>
        await stageOfficialCandidate(version, candidatePath, context)),
    reconcileApplicationState:
      overrides.reconcileApplicationState ??
      (async () => await reconcileProtectedApplicationState(context)),
    stopSigner: overrides.stopSigner ?? (async () => await stopSignerService(signerServiceName)),
    startSignerV2:
      overrides.startSignerV2 ??
      (async ({ expectedRelease } = {}) =>
        await startSignerService({
          requireV2: true,
          expectedRelease,
          serviceName: signerServiceName,
          socketPath: signerApplicationSocketPath,
        })),
    startPreviousSigner:
      overrides.startPreviousSigner ??
      (async ({ requireV2 = false } = {}) =>
        await startSignerService({
          requireV2,
          serviceName: signerServiceName,
          socketPath: signerApplicationSocketPath,
        })),
    reloadUnits: overrides.reloadUnits ?? (async () => await systemctl("daemon-reload")),
    applyServiceBoundary:
      overrides.applyServiceBoundary ??
      (async (boundary) => await applyProtectedServiceBoundary(context, boundary)),
    restoreServiceBoundary:
      overrides.restoreServiceBoundary ??
      (async (boundary) => await restoreProtectedServiceBoundary(context, boundary)),
    startGateway:
      overrides.startGateway ?? (async () => await systemctl("start", gatewayServiceName)),
    stopGateway: overrides.stopGateway ?? (async () => await systemctl("stop", gatewayServiceName)),
    restartGateway:
      overrides.restartGateway ?? (async () => await systemctl("restart", gatewayServiceName)),
    probeSigner:
      overrides.probeSigner ??
      (async (expectedRelease) =>
        await probeSignerV2(expectedRelease, signerApplicationSocketPath)),
    probeSignerState:
      overrides.probeSignerState ??
      (overrides.probeSigner
        ? async () => ({ release: await overrides.probeSigner(), invariant: null })
        : async (expectedRelease) =>
            await probeSignerStateV2(expectedRelease, signerApplicationSocketPath)),
  };
  return context;
}

async function updateControllerRelease(request, context) {
  await context.assertReleaseAllowed(request.version);
  await assertRollbackFloor(context, request.version);
  const active = await readJournal(context);
  if (active) {
    assertMatchingTransaction(active, request);
  }
  const controller = await context.stageControllerRelease(request.version, context);
  return {
    transactionId: request.transactionId,
    version: request.version,
    controllerChanged: controller.changed === true,
    controllerInstanceId: context.controllerInstanceId,
  };
}

async function writeGatewayGate(context, journal) {
  await atomicWriteFileDurable(
    context.paths.gatewayGatePath,
    `${JSON.stringify({ transactionId: journal.transactionId, version: journal.version })}\n`,
    0o644,
  );
}

async function writeSignerGate(context, journal) {
  const directory = path.dirname(context.paths.signerGatePath);
  await fsp.mkdir(directory, { recursive: true, mode: 0o755 });
  const directoryStat = await fsp.lstat(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== process.geteuid() ||
    (directoryStat.mode & 0o022) !== 0
  ) {
    throw new Error(
      "signer update gate directory must be owned by the updater and not writable by group/others",
    );
  }
  await fsp.chmod(directory, 0o755);
  await atomicWriteFileDurable(
    context.paths.signerGatePath,
    `${JSON.stringify({ transactionId: journal.transactionId, version: journal.version })}\n`,
    0o644,
  );
}

async function writeUpdateGates(context, journal) {
  await writeGatewayGate(context, journal);
  await writeSignerGate(context, journal);
}

async function removeGatewayGate(context) {
  await fsp.rm(context.paths.gatewayGatePath, { force: true });
  await fsyncDirectory(path.dirname(context.paths.gatewayGatePath));
}

async function removeSignerGate(context) {
  await fsp.rm(context.paths.signerGatePath, { force: true });
  await fsyncDirectory(path.dirname(context.paths.signerGatePath));
}

async function removeUpdateGates(context) {
  await removeGatewayGate(context);
  await removeSignerGate(context);
}

async function readGatewayGate(context) {
  try {
    const value = JSON.parse(await fsp.readFile(context.paths.gatewayGatePath, "utf8"));
    return {
      transactionId: parseTransactionId(value.transactionId),
      version: parseReleaseVersion(value.version),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new Error("hosted Gateway update gate is invalid", { cause: error });
  }
}

function assertMatchingTransaction(journal, request) {
  if (!journal) {
    throw new Error("host updater transaction does not exist");
  }
  if (journal.transactionId !== request.transactionId || journal.version !== request.version) {
    throw new Error(
      `another hosted signer transaction is active (${journal.transactionId}, v${journal.version})`,
    );
  }
}

async function readRollbackFloor(context) {
  try {
    return parseReleaseVersion(await fsp.readFile(context.paths.rollbackFloorPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new Error("hosted custody rollback floor is invalid; repair it as root before updating", {
      cause: error,
    });
  }
}

async function assertRollbackFloor(context, targetVersion) {
  const floor = await readRollbackFloor(context);
  if (floor && compareVersions(targetVersion, floor) === -1) {
    throw new Error(
      `refusing signer release v${targetVersion}: hosted custody rollback floor is v${floor}`,
    );
  }
  return floor;
}

async function writeInitialRollbackFloor(context, version) {
  const existing = await readRollbackFloor(context);
  if (existing) {
    if (compareVersions(version, existing) === -1) {
      throw new Error(`cannot commit below hosted custody rollback floor v${existing}`);
    }
    return existing;
  }
  await atomicWriteFileDurable(context.paths.rollbackFloorPath, `${version}\n`, 0o600);
  return version;
}

async function prepareSignerRelease(request, context) {
  await context.assertReleaseAllowed(request.version);
  await assertRollbackFloor(context, request.version);
  await context.reconcileApplicationState();
  const active = await readJournal(context);
  if (active) {
    assertMatchingTransaction(active, request);
    if (active.phase !== "gateway-authorized" && active.phase !== "committing") {
      await writeUpdateGates(context, active);
    } else if (active.phase === "gateway-authorized") {
      await writeSignerGate(context, active);
    }
    return {
      transactionId: active.transactionId,
      version: active.version,
      phase: active.phase,
      changed: active.changed,
      release: active.release,
    };
  }

  const currentVersion = await readVersionFile(context.paths.versionPath);
  if (currentVersion && compareVersions(currentVersion, request.version) === 1) {
    throw new Error(`refusing signer downgrade from ${currentVersion} to ${request.version}`);
  }

  const controller = await context.stageControllerRelease(request.version, context);

  let changed = true;
  let release = null;
  let releaseBinding = null;
  let previousSignerInvariant = null;
  let previousSignerState = null;
  if (currentVersion) {
    previousSignerState = await context.probeSignerState();
    parseSignerReleaseIdentity(previousSignerState.release, currentVersion);
    previousSignerInvariant = previousSignerState.invariant;
  }
  if (currentVersion === request.version) {
    try {
      await fsp.access(context.paths.signerPath, fs.constants.X_OK);
      release = parseSignerReleaseIdentity(
        previousSignerState?.release ?? (await context.probeSigner()),
        request.version,
      );
      changed = false;
    } catch {
      changed = true;
    }
  }

  const txPaths = transactionPaths(context.paths, request.transactionId);
  let journal;
  let application = null;
  let serviceBoundary = null;
  try {
    await fsp.mkdir(txPaths.transactionDir, { recursive: true, mode: 0o700 });
    const signerUnit = await fileMetadata(context.paths.signerUnitPath);
    if (signerUnit.existed) {
      await atomicCopyFileDurable(context.paths.signerUnitPath, txPaths.signerUnitSnapshotPath, {
        mode: signerUnit.mode,
      });
    }
    if (changed || context.paths.applicationReleasesDir) {
      const staged = await context.stageCandidate(request.version, txPaths.candidatePath, context);
      const stagedRelease = parseSignerReleaseIdentity(staged?.release || staged, request.version);
      if (release && !signerReleaseIdentitiesEqual(release, stagedRelease)) {
        throw new Error("installed signer and attested application target identities differ");
      }
      release = stagedRelease;
      releaseBinding = staged?.binding || null;
      if (!releaseBinding) {
        throw new Error("signer candidate omitted its attested unified release binding");
      }
      if (context.paths.applicationReleasesDir && !staged?.application) {
        throw new Error("protected Local release omitted its root-controlled application runtime");
      }
      application = staged?.application ?? null;
    }
    serviceBoundary = await stageProtectedServiceBoundary(context);
    journal = await writeJournal(context, {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId: request.transactionId,
      version: request.version,
      previousVersion: currentVersion,
      release,
      releaseBinding,
      controllerChanged: controller.changed === true,
      previousSignerInvariant,
      application,
      serviceBoundary,
      phase: "prepared",
      changed,
      createdAt: new Date().toISOString(),
      previousBinary: null,
      stateDB: null,
      signerUnit,
      rollbackFromPhase: null,
    });
    await writeUpdateGates(context, journal);
  } catch (error) {
    await cleanupTransactionFiles(context, request.transactionId).catch(() => undefined);
    if (journal) {
      await removeJournal(context).catch(() => undefined);
    }
    await removeUpdateGates(context).catch(() => undefined);
    throw error;
  }
  return {
    transactionId: journal.transactionId,
    version: journal.version,
    phase: journal.phase,
    changed: journal.changed,
    controllerChanged: journal.controllerChanged === true,
    release: journal.release,
  };
}

async function restoreSignerUnit(context, journal, txPaths) {
  if (journal.signerUnit?.existed) {
    await fsp.access(txPaths.signerUnitSnapshotPath);
    await atomicCopyFileDurable(txPaths.signerUnitSnapshotPath, context.paths.signerUnitPath, {
      mode: journal.signerUnit.mode || 0o644,
      uid: journal.signerUnit.uid,
      gid: journal.signerUnit.gid,
    });
  } else {
    await fsp.rm(context.paths.signerUnitPath, { force: true });
    await fsyncDirectory(path.dirname(context.paths.signerUnitPath));
  }
  await context.reloadUnits();
}

async function restoreVersionFile(context, previousVersion) {
  if (previousVersion) {
    await atomicWriteFileDurable(context.paths.versionPath, `${previousVersion}\n`, 0o600);
    return;
  }
  await fsp.rm(context.paths.versionPath, { force: true });
  await fsyncDirectory(path.dirname(context.paths.versionPath));
}

async function restoreStateDB(context, journal, txPaths) {
  if (!journal.stateDB || journal.rollbackFromPhase === "snapshotting") {
    return;
  }
  if (journal.stateDB.existed) {
    await fsp.access(txPaths.stateDBSnapshotPath);
    await atomicCopyFileDurable(txPaths.stateDBSnapshotPath, context.paths.signerStateDBPath, {
      mode: journal.stateDB.mode,
      uid: journal.stateDB.uid,
      gid: journal.stateDB.gid,
    });
    return;
  }
  await fsp.rm(context.paths.signerStateDBPath, { force: true });
  await fsyncDirectory(path.dirname(context.paths.signerStateDBPath));
}

async function restorePreviousBinary(context, journal, txPaths) {
  if (journal.previousBinary?.existed) {
    await fsp.access(txPaths.previousBinaryPath);
    await atomicCopyFileDurable(txPaths.previousBinaryPath, context.paths.signerPath, {
      mode: journal.previousBinary.mode || 0o755,
      uid: journal.previousBinary.uid,
      gid: journal.previousBinary.gid,
    });
    return true;
  }
  await fsp.rm(context.paths.signerPath, { force: true });
  await fsyncDirectory(path.dirname(context.paths.signerPath));
  return false;
}

async function selectProtectedApplication(context, releaseRoot) {
  if (!context.paths.applicationCurrentLink) {
    return;
  }
  await prepareProtectedApplicationDirectories(context.paths);
  const expectedParent = path.resolve(context.paths.applicationReleasesDir);
  const selected = path.resolve(releaseRoot);
  if (path.dirname(selected) !== expectedParent) {
    throw new Error("protected application activation escaped its release root");
  }
  const stat = await fsp.lstat(selected);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.geteuid() ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error("protected application activation target is unsafe");
  }
  await atomicSymlinkDurable(selected, context.paths.applicationCurrentLink);
}

async function activateProtectedApplication(context, journal) {
  if (journal.application) {
    await selectProtectedApplication(context, journal.application.targetRoot);
  }
}

async function restoreProtectedApplication(context, journal) {
  if (journal.application) {
    if (journal.application.previousRoot === null) {
      await fsp.rm(context.paths.applicationCurrentLink, { force: true });
      await fsyncDirectory(path.dirname(context.paths.applicationCurrentLink));
    } else {
      await selectProtectedApplication(context, journal.application.previousRoot);
    }
  }
}

async function rollbackSignerRelease(request, context, { preserveGatewayGate = false } = {}) {
  let journal = await readJournal(context);
  if (!journal) {
    if (!preserveGatewayGate) {
      await removeUpdateGates(context);
    }
    return {
      transactionId: request.transactionId,
      version: request.version,
      phase: "rolled-back",
      changed: false,
    };
  }
  assertMatchingTransaction(journal, request);
  await writeUpdateGates(context, journal);
  if (journal.phase === "restored") {
    await restoreProtectedApplication(context, journal);
    await context.restoreServiceBoundary(journal.serviceBoundary);
    await cleanupTransactionFiles(context, journal.transactionId);
    await removeJournal(context);
    if (!preserveGatewayGate) {
      await removeUpdateGates(context);
      try {
        await context.startGateway();
      } catch (error) {
        if (!/not found|not loaded|no such file/i.test(error?.message || "")) {
          throw error;
        }
      }
    }
    return {
      transactionId: journal.transactionId,
      version: journal.version,
      phase: "rolled-back",
      changed: journal.changed,
    };
  }
  const rollbackFromPhase = journal.rollbackFromPhase || journal.phase;
  journal = await writeJournal(context, {
    ...journal,
    phase: "rolling-back",
    rollbackFromPhase,
  });
  const txPaths = transactionPaths(context.paths, journal.transactionId);

  // A host can reboot after prepare while the installer has already replaced
  // the unit. Always quiesce before restoring unit semantics, even though the
  // updater itself does not mutate the live signer during prepare.
  const signerMayNeedRestart = true;
  await context.stopSigner();
  await restoreProtectedApplication(context, journal);
  await context.restoreServiceBoundary(journal.serviceBoundary);
  await restoreSignerUnit(context, journal, txPaths);
  if (journal.changed && rollbackFromPhase !== "prepared") {
    const candidateMayHaveRun = new Set([
      "activating",
      "active",
      "gateway-authorized",
      "committing",
      "rolling-back",
    ]).has(rollbackFromPhase);
    if (candidateMayHaveRun) {
      await restorePreviousBinary(context, journal, txPaths);
      await restoreStateDB(context, journal, txPaths);
      await restoreVersionFile(context, journal.previousVersion);
    }
  }
  if (signerMayNeedRestart && (await fileMetadata(context.paths.signerPath)).existed) {
    await context.startPreviousSigner({ requireV2: Boolean(await readRollbackFloor(context)) });
  }

  journal = await writeJournal(context, { ...journal, phase: "restored" });
  await cleanupTransactionFiles(context, journal.transactionId);
  await removeJournal(context);
  if (!preserveGatewayGate) {
    await removeUpdateGates(context);
    try {
      await context.startGateway();
    } catch (error) {
      if (!/not found|not loaded|no such file/i.test(error?.message || "")) {
        throw error;
      }
    }
  }
  return {
    transactionId: journal.transactionId,
    version: journal.version,
    phase: "rolled-back",
    changed: journal.changed,
  };
}

async function authorizeGatewayRelease(request, context) {
  let journal = await readJournal(context);
  assertMatchingTransaction(journal, request);
  if (journal.phase !== "active" && journal.phase !== "gateway-authorized") {
    throw new Error(`signer transaction cannot authorize Gateway from phase ${journal.phase}`);
  }
  if (journal.phase !== "gateway-authorized") {
    journal = await writeJournal(context, { ...journal, phase: "gateway-authorized" });
  }
  try {
    await writeSignerGate(context, journal);
    await context.applyServiceBoundary(journal.serviceBoundary);
    await activateProtectedApplication(context, journal);
    await removeGatewayGate(context);
    try {
      await context.startGateway();
    } catch (error) {
      if (!/not found|not loaded|no such file/i.test(error?.message || "")) {
        throw error;
      }
    }
  } catch (error) {
    await restoreProtectedApplication(context, journal).catch(() => undefined);
    await context.restoreServiceBoundary(journal.serviceBoundary).catch(() => undefined);
    await writeUpdateGates(context, journal).catch(() => undefined);
    throw error;
  }
  return {
    transactionId: journal.transactionId,
    version: journal.version,
    phase: journal.phase,
    changed: journal.changed,
    release: journal.release,
  };
}

async function gateGatewayRelease(request, context) {
  const journal = await readJournal(context);
  if (!journal) {
    const gate = await readGatewayGate(context);
    if (gate?.transactionId !== request.transactionId || gate?.version !== request.version) {
      throw new Error("host updater transaction does not exist");
    }
    return {
      transactionId: gate.transactionId,
      version: gate.version,
      phase: "rolled-back-gated",
      changed: false,
    };
  }
  assertMatchingTransaction(journal, request);
  if (journal.phase === "committing") {
    throw new Error("cannot gate a Gateway after the signer commit decision");
  }
  await writeUpdateGates(context, journal);
  try {
    await context.stopGateway();
  } catch (error) {
    if (!/not found|not loaded|no such file/i.test(error?.message || "")) {
      throw error;
    }
  }
  return {
    transactionId: journal.transactionId,
    version: journal.version,
    phase: journal.phase,
    changed: journal.changed,
    release: journal.release,
  };
}

async function restartGatewayService(request, context) {
  const journal = await readJournal(context);
  if (journal) {
    throw new Error("cannot restart the Gateway while a hosted release transaction is active");
  }
  const installedVersion = await readVersionFile(context.paths.versionPath);
  if (installedVersion !== request.version) {
    throw new Error(
      `Gateway restart version ${request.version} does not match installed signer ${installedVersion || "unknown"}`,
    );
  }
  await context.restartGateway();
  return {
    transactionId: request.transactionId,
    version: request.version,
    phase: "restarted",
    changed: false,
  };
}

async function activateSignerRelease(request, context) {
  let journal = await readJournal(context);
  assertMatchingTransaction(journal, request);
  if (journal.phase === "active" || journal.phase === "gateway-authorized") {
    return {
      transactionId: journal.transactionId,
      version: journal.version,
      phase: journal.phase,
      changed: journal.changed,
      release: journal.release,
    };
  }
  if (journal.phase !== "prepared") {
    throw new Error(`signer transaction cannot activate from phase ${journal.phase}`);
  }
  if (!journal.changed) {
    journal = await writeJournal(context, { ...journal, phase: "active" });
    return {
      transactionId: journal.transactionId,
      version: journal.version,
      phase: journal.phase,
      changed: false,
      release: journal.release,
    };
  }

  const txPaths = transactionPaths(context.paths, journal.transactionId);
  const previousBinary = await fileMetadata(context.paths.signerPath);
  const stateDB = await fileMetadata(context.paths.signerStateDBPath);
  journal = await writeJournal(context, {
    ...journal,
    phase: "snapshotting",
    previousBinary,
    stateDB,
  });
  try {
    await context.stopSigner();
    if (previousBinary.existed) {
      await atomicCopyFileDurable(context.paths.signerPath, txPaths.previousBinaryPath, {
        mode: previousBinary.mode,
      });
    }
    if (stateDB.existed) {
      await atomicCopyFileDurable(context.paths.signerStateDBPath, txPaths.stateDBSnapshotPath, {
        mode: 0o600,
      });
    }
    journal = await writeJournal(context, { ...journal, phase: "activating" });
    await fsp.rename(txPaths.candidatePath, context.paths.signerPath);
    await fsyncDirectory(path.dirname(context.paths.signerPath));
    const activatedState = await context.startSignerV2({ expectedRelease: journal.release });
    if (
      journal.previousSignerInvariant &&
      activatedState?.invariant !== journal.previousSignerInvariant
    ) {
      throw new Error(
        "activated signer did not preserve exact wallet, policy, network, and WebAuthn state",
      );
    }
    await atomicWriteFileDurable(context.paths.versionPath, `${journal.version}\n`, 0o600);
    journal = await writeJournal(context, { ...journal, phase: "active" });
    return {
      transactionId: journal.transactionId,
      version: journal.version,
      phase: journal.phase,
      changed: true,
      release: journal.release,
    };
  } catch (error) {
    let rollbackError = null;
    try {
      await rollbackSignerRelease(request, context, { preserveGatewayGate: true });
    } catch (caught) {
      rollbackError = caught;
    }
    if (rollbackError) {
      throw new Error(
        `signer activation failed and rollback is incomplete: ${error.message}; rollback error: ${rollbackError.message}`,
        { cause: error },
      );
    }
    throw new Error(`signer activation failed and was rolled back: ${error.message}`, {
      cause: error,
    });
  }
}

async function finishCommit(context, journal) {
  await writeInitialRollbackFloor(context, journal.version);
  await removeUpdateGates(context);
  await cleanupTransactionFiles(context, journal.transactionId);
  await removeJournal(context);
  return {
    transactionId: journal.transactionId,
    version: journal.version,
    phase: "committed",
    changed: journal.changed,
    release: journal.release,
  };
}

async function commitSignerRelease(request, context) {
  let journal = await readJournal(context);
  if (!journal) {
    const installed = await readVersionFile(context.paths.versionPath);
    const floor = await readRollbackFloor(context);
    if (installed === request.version && floor && compareVersions(request.version, floor) >= 0) {
      return {
        transactionId: request.transactionId,
        version: request.version,
        phase: "committed",
        changed: false,
      };
    }
    throw new Error("host updater transaction does not exist");
  }
  assertMatchingTransaction(journal, request);
  if (journal.phase !== "gateway-authorized" && journal.phase !== "committing") {
    throw new Error(`signer transaction cannot commit from phase ${journal.phase}`);
  }
  if (journal.phase !== "committing") {
    journal = await writeJournal(context, { ...journal, phase: "committing" });
  }
  return await finishCommit(context, journal);
}

async function recoverInterruptedTransaction(context) {
  const journal = await readJournal(context);
  if (!journal) {
    return { recovered: false };
  }
  const request = {
    transactionId: journal.transactionId,
    version: journal.version,
  };
  if (journal.phase === "committing") {
    const result = await finishCommit(context, journal);
    return { recovered: true, action: "committed", result };
  }
  if (
    journal.phase === "prepared" ||
    journal.phase === "snapshotting" ||
    journal.phase === "activating" ||
    journal.phase === "rolling-back" ||
    journal.phase === "restored"
  ) {
    const result = await rollbackSignerRelease(request, context, { preserveGatewayGate: true });
    return { recovered: true, action: "rolled-back", result };
  }
  // Active/authorized is a valid target signer awaiting the application coordinator's
  // durable commit/rollback decision. Keep signer mutations gated until that
  // decision; only a Gateway-authorized transaction may run the health probe.
  if (journal.phase === "gateway-authorized") {
    await writeSignerGate(context, journal);
    await context.applyServiceBoundary(journal.serviceBoundary);
    await activateProtectedApplication(context, journal);
    await removeGatewayGate(context);
    await context.startGateway();
  } else {
    await writeUpdateGates(context, journal);
    await context.stopGateway();
  }
  return { recovered: true, action: "pending", phase: journal.phase };
}

async function dispatchUpdateRequest(request, context) {
  switch (request.op) {
    case "updateController":
      return await updateControllerRelease(request, context);
    case "prepareRelease":
      return await prepareSignerRelease(request, context);
    case "activateRelease":
      return await activateSignerRelease(request, context);
    case "authorizeGatewayRelease":
      return await authorizeGatewayRelease(request, context);
    case "gateGatewayRelease":
      return await gateGatewayRelease(request, context);
    case "restartGateway":
      return await restartGatewayService(request, context);
    case "commitRelease":
      return await commitSignerRelease(request, context);
    case "rollbackRelease":
      return await rollbackSignerRelease(request, context);
    default:
      throw new Error("unsupported updater transaction request");
  }
}

function writeResponse(socket, payload, onFlushed) {
  socket.end(`${JSON.stringify(payload)}\n`, onFlushed);
}

function parseServerConfiguration(argv = process.argv.slice(2)) {
  let protectedLocalInstance = null;
  let socketUid = 0;
  let socketGid = Number.NaN;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--socket-gid") {
      socketGid = Number(argv[++index]);
      continue;
    }
    if (argument === "--socket-uid") {
      socketUid = Number(argv[++index]);
      continue;
    }
    if (argument === "--protected-local-instance") {
      protectedLocalInstance = String(argv[++index] ?? "").trim();
      continue;
    }
    throw new Error(`unsupported root updater argument: ${argument}`);
  }
  if (!Number.isSafeInteger(socketGid) || socketGid <= 0) {
    throw new Error("--socket-gid must be a positive numeric group id");
  }
  if (!Number.isSafeInteger(socketUid) || socketUid < 0) {
    throw new Error("--socket-uid must be a non-negative numeric user id");
  }
  if (!protectedLocalInstance && socketUid !== 0) {
    throw new Error("Hosting root updater socket must remain root-owned");
  }
  if (protectedLocalInstance && socketUid === 0) {
    throw new Error("Protected Local root updater socket requires its exact operator user id");
  }
  const selected = protectedLocalInstance
    ? protectedLocalControllerConfiguration(protectedLocalInstance)
    : {
        profile: "hosting",
        paths: DEFAULT_PATHS,
        signerServiceName: "fased-signerd.service",
        gatewayServiceName: "fased-gateway.service",
        signerApplicationSocketPath: "/run/fased-signerd/app.sock",
      };
  return Object.freeze({ ...selected, socketUid, socketGid });
}

export async function startServer(options = {}) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("hosted signer updater must run as root");
  }
  const configuration = options.configuration ?? parseServerConfiguration();
  const context =
    options.context ??
    createTransactionContext({
      paths: configuration.paths,
      protectedLocalInstanceId: configuration.instanceId,
      signerServiceName: configuration.signerServiceName,
      gatewayServiceName: configuration.gatewayServiceName,
      signerApplicationSocketPath: configuration.signerApplicationSocketPath,
    });
  await recoverInterruptedTransaction(context);
  await fsp.mkdir(path.dirname(context.paths.socketPath), { recursive: true, mode: 0o750 });
  await fsp.rm(context.paths.socketPath, { force: true });
  process.umask(0o117);
  let queue = Promise.resolve();
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS);
    let body = "";
    let handled = false;
    const fail = (message) => {
      if (!handled) {
        handled = true;
        writeResponse(socket, { ok: false, error: message });
      }
    };
    socket.on("timeout", () => fail("updater request timed out"));
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      if (handled) {
        return;
      }
      body += chunk;
      if (body.length > MAX_REQUEST_BYTES) {
        fail("updater request is too large");
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) {
        return;
      }
      handled = true;
      let request;
      try {
        request = parseUpdateRequest(JSON.parse(body.slice(0, newline)));
      } catch (error) {
        writeResponse(socket, { ok: false, error: error.message });
        return;
      }
      const operation = queue.then(() => dispatchUpdateRequest(request, context));
      queue = operation.catch(() => undefined);
      const restartController = () => {
        if (!context.controllerRestartRequired) {
          return;
        }
        context.controllerRestartRequired = false;
        server.close(() => {
          process.exitCode = 75;
        });
      };
      void operation.then(
        (result) =>
          writeResponse(
            socket,
            { ok: true, ...result },
            new Set(["updateController", "commitRelease", "rollbackRelease"]).has(request.op)
              ? restartController
              : undefined,
          ),
        (error) => writeResponse(socket, { ok: false, error: error.message }, restartController),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(context.paths.socketPath, resolve);
  });
  await fsp.chown(context.paths.socketPath, configuration.socketUid, configuration.socketGid);
  await fsp.chmod(context.paths.socketPath, configuration.socketUid === 0 ? 0o660 : 0o600);
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(context.paths.socketPath, { force: true });
  };
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  return { server, close };
}

export function isMainModule(entryPath, modulePath = fileURLToPath(import.meta.url)) {
  if (!entryPath) {
    return false;
  }
  try {
    return fs.realpathSync(entryPath) === fs.realpathSync(modulePath);
  } catch {
    return false;
  }
}

const isMain = isMainModule(process.argv[1]);
if (isMain) {
  if (process.argv[2] === "--self-check") {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: CONTROLLER_SELF_CHECK_SCHEMA_VERSION,
        protocolVersion: CONTROLLER_PROTOCOL_VERSION,
        role: "server",
      })}\n`,
    );
  } else {
    await startServer();
  }
}

export const __testing = {
  assertSignerV2Health,
  activateSignerRelease,
  authorizeGatewayRelease,
  commitSignerRelease,
  compareVersions,
  createTransactionContext,
  dispatchUpdateRequest,
  gateGatewayRelease,
  parseServerConfiguration,
  prepareSignerRelease,
  protectedLocalControllerConfiguration,
  reconcileProtectedApplicationState,
  rootManagedApplicationIdentity,
  readJournal,
  recoverInterruptedTransaction,
  releaseAttestationVerifyArgs,
  releaseAllowedForChannel,
  releaseArchitecture,
  restartGatewayService,
  rollbackSignerRelease,
  stageOfficialControllerRelease,
  stageOfficialCandidate,
  transactionPaths,
  updateControllerRelease,
  writeJournal,
};
