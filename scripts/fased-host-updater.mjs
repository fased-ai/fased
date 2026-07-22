#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  return {
    release: signerRelease,
    artifact,
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
        (!network.configured || /^sha256:[a-f0-9]{64}$/.test(network?.hash || "")),
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

async function readSignerV2Health() {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: "/run/fased-signerd/app.sock" });
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

export async function probeSignerV2(expectedRelease) {
  const response = await readSignerV2Health();
  return assertSignerV2Health(response, expectedRelease);
}

async function probeSignerStateV2(expectedRelease) {
  const response = await readSignerV2Health();
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

async function stopSignerService() {
  await systemctl("stop", "fased-signerd.service");
}

async function startSignerService({ requireV2, expectedRelease }) {
  await systemctl("start", "fased-signerd.service");
  await systemctl("is-active", "--quiet", "fased-signerd.service");
  if (!requireV2) {
    return;
  }
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await probeSignerStateV2(expectedRelease);
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

function validateJournal(value) {
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
    changed: value.changed === true,
  };
}

async function readJournal(context) {
  try {
    return validateJournal(JSON.parse(await fsp.readFile(context.paths.journalPath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJournal(context, journal) {
  const next = validateJournal({
    ...journal,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  });
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
    return {
      release: selected.release,
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

function createTransactionContext(overrides = {}) {
  const paths = { ...DEFAULT_PATHS, ...overrides.paths };
  const context = {
    paths,
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
    stopSigner: overrides.stopSigner ?? stopSignerService,
    startSignerV2:
      overrides.startSignerV2 ??
      (async ({ expectedRelease } = {}) =>
        await startSignerService({ requireV2: true, expectedRelease })),
    startPreviousSigner:
      overrides.startPreviousSigner ??
      (async ({ requireV2 = false } = {}) => await startSignerService({ requireV2 })),
    reloadUnits: overrides.reloadUnits ?? (async () => await systemctl("daemon-reload")),
    startGateway:
      overrides.startGateway ?? (async () => await systemctl("start", "fased-gateway.service")),
    probeSigner: overrides.probeSigner ?? probeSignerV2,
    probeSignerState:
      overrides.probeSignerState ??
      (overrides.probeSigner
        ? async () => ({ release: await overrides.probeSigner(), invariant: null })
        : probeSignerStateV2),
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
  try {
    await fsp.mkdir(txPaths.transactionDir, { recursive: true, mode: 0o700 });
    const signerUnit = await fileMetadata(context.paths.signerUnitPath);
    if (signerUnit.existed) {
      await atomicCopyFileDurable(context.paths.signerUnitPath, txPaths.signerUnitSnapshotPath, {
        mode: signerUnit.mode,
      });
    }
    if (changed) {
      const staged = await context.stageCandidate(request.version, txPaths.candidatePath, context);
      release = parseSignerReleaseIdentity(staged?.release || staged, request.version);
      releaseBinding = staged?.binding || null;
      if (!releaseBinding) {
        throw new Error("signer candidate omitted its attested unified release binding");
      }
    }
    journal = await writeJournal(context, {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId: request.transactionId,
      version: request.version,
      previousVersion: currentVersion,
      release,
      releaseBinding,
      controllerChanged: controller.changed === true,
      previousSignerInvariant,
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
    await cleanupTransactionFiles(context, journal.transactionId);
    await removeJournal(context);
    if (!preserveGatewayGate) {
      await removeUpdateGates(context);
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
    await removeGatewayGate(context);
    try {
      await context.startGateway();
    } catch (error) {
      if (!/not found|not loaded|no such file/i.test(error?.message || "")) {
        throw error;
      }
    }
  } catch (error) {
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
  return {
    transactionId: journal.transactionId,
    version: journal.version,
    phase: journal.phase,
    changed: journal.changed,
    release: journal.release,
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
    await removeGatewayGate(context);
  } else {
    await writeUpdateGates(context, journal);
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

export async function startServer() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("hosted signer updater must run as root");
  }
  const gidIndex = process.argv.indexOf("--socket-gid");
  const socketGid = gidIndex >= 0 ? Number(process.argv[gidIndex + 1]) : Number.NaN;
  if (!Number.isSafeInteger(socketGid) || socketGid <= 0) {
    throw new Error("--socket-gid must be a positive numeric group id");
  }
  const context = createTransactionContext();
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
  await fsp.chmod(context.paths.socketPath, 0o660);
  await fsp.chown(context.paths.socketPath, 0, socketGid);
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(context.paths.socketPath, { force: true });
  };
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  return { server, close };
}

const isMain = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
  : false;
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
  prepareSignerRelease,
  readJournal,
  recoverInterruptedTransaction,
  releaseAttestationVerifyArgs,
  releaseAllowedForChannel,
  releaseArchitecture,
  rollbackSignerRelease,
  stageOfficialControllerRelease,
  stageOfficialCandidate,
  transactionPaths,
  updateControllerRelease,
  writeJournal,
};
