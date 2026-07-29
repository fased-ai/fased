#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SUPERVISOR_SCHEMA_VERSION = 1;
const SUPERVISOR_PROTOCOL_VERSION = 1;
const CONTROLLER_PROTOCOL_VERSION = 2;
const RELEASE_REPOSITORY = "fased-ai/fased";
const RELEASE_WORKFLOW = "fased-ai/fased/.github/workflows/hosted-runtime-release.yml";
const RELEASE_BASE = "https://github.com/fased-ai/fased/releases/download";
const TRUST_METADATA_NAME = "fased-lifecycle-trust-v1.json";
const TRUST_METADATA_BUNDLE_NAME = `${TRUST_METADATA_NAME}.attestation.json`;
const SUPERVISOR_NAME = "fased-lifecycle-supervisor.mjs";
const CONTROLLER_SERVER_NAME = "fased-host-updater.mjs";
const CONTROLLER_CLIENT_NAME = "fased-host-updaterctl.mjs";
const MAX_REQUEST_BYTES = 4096;
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20 * 60_000;
const MAX_METADATA_VALIDITY_MS = 400 * 24 * 60 * 60 * 1000;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const INSTANCE_ID_PATTERN = /^[a-f0-9]{16}$/u;
const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROLLER_OPERATIONS = new Set([
  "prepareRelease",
  "activateRelease",
  "authorizeGatewayRelease",
  "gateGatewayRelease",
  "restartGateway",
  "commitRelease",
  "rollbackRelease",
]);

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .join(",") !== [...keys].toSorted((left, right) => left.localeCompare(right)).join(",")
  ) {
    fail(`${label} contains unsupported or missing fields`);
  }
}

function parsePositiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseVersion(value) {
  const version = String(value ?? "")
    .trim()
    .replace(/^v/u, "");
  if (!VERSION_PATTERN.test(version)) {
    fail("version must be one exact semantic release version");
  }
  return version;
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
    return match
      ? { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [] }
      : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) {
    return null;
  }
  for (let index = 0; index < a.core.length; index += 1) {
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
    const ln = /^\d+$/u.test(l);
    const rn = /^\d+$/u.test(r);
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

function platformIdentity(arch = process.arch) {
  if (arch === "x64") {
    return "linux-x64";
  }
  if (arch === "arm64") {
    return "linux-arm64";
  }
  fail(`unsupported lifecycle supervisor architecture: ${arch}`);
}

function lifecyclePaths(profile, instanceId = null) {
  if (profile === "hosting") {
    return Object.freeze({
      profile,
      publicSocketPath: "/run/fased-host-updater/request.sock",
      privateSocketPath: "/run/fased-host-controller/controller.sock",
      stateDir: "/var/lib/fased-host-updater",
      supervisorStateDir: "/var/lib/fased-host-updater/supervisor",
      releasesDir: "/opt/fased/host-controller/releases",
      currentLink: "/opt/fased/host-controller/current",
      controllerVersionPath: "/var/lib/fased-host-updater/supervisor/controller-version.json",
      rollbackFloorPath: "/var/lib/fased-host-updater/supervisor/rollback-floor",
      channelPath: "/etc/fased/host-updater-channel",
      supervisorPath: "/opt/fased/host-controller/supervisor/fased-lifecycle-supervisor.mjs",
      controllerUnit: "fased-host-controller.service",
      supervisorUnit: "fased-host-updater.service",
    });
  }
  if (profile !== "protected-local" || !INSTANCE_ID_PATTERN.test(instanceId || "")) {
    fail("lifecycle supervisor profile or Protected Local instance is invalid");
  }
  const runtime = `/run/fased-local-controller/${instanceId}`;
  const state = `/var/lib/fased-local/${instanceId}/controller`;
  const install = `/opt/fased/local/${instanceId}`;
  return Object.freeze({
    profile,
    instanceId,
    publicSocketPath: `${runtime}/request.sock`,
    privateSocketPath: `/run/fased-local-controller-worker/${instanceId}/controller.sock`,
    stateDir: state,
    supervisorStateDir: `${state}/supervisor`,
    releasesDir: `${install}/controller/releases`,
    currentLink: `${install}/controller/current`,
    controllerVersionPath: `${state}/supervisor/controller-version.json`,
    rollbackFloorPath: `${state}/supervisor/rollback-floor`,
    channelPath: `/etc/fased/local/${instanceId}/update-channel`,
    supervisorPath: `${install}/supervisor/fased-lifecycle-supervisor.mjs`,
    controllerUnit: `fased-local-controller-worker-${instanceId}.service`,
    supervisorUnit: `fased-local-controller-${instanceId}.service`,
  });
}

export function parseSupervisorConfiguration(argv = process.argv.slice(2)) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      fail("lifecycle supervisor arguments must be unique --name value pairs");
    }
    values.set(key, value);
  }
  const allowed = new Set([
    "--profile",
    "--protected-local-instance",
    "--operator-uid",
    "--operator-gid",
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      fail(`unsupported lifecycle supervisor argument: ${key}`);
    }
  }
  const profile = values.get("--profile");
  if (!new Set(["hosting", "protected-local"]).has(profile)) {
    fail("--profile must be hosting or protected-local");
  }
  const instanceId = values.get("--protected-local-instance") ?? null;
  if (
    (profile === "hosting" && instanceId !== null) ||
    (profile === "protected-local" && !INSTANCE_ID_PATTERN.test(instanceId || ""))
  ) {
    fail("lifecycle supervisor instance selector does not match its profile");
  }
  return Object.freeze({
    profile,
    instanceId,
    operatorUid: parsePositiveId(values.get("--operator-uid"), "operator UID"),
    operatorGid: parsePositiveId(values.get("--operator-gid"), "operator GID"),
    paths: lifecyclePaths(profile, instanceId),
  });
}

export function parseSupervisorRequest(value) {
  exactKeys(
    value,
    ["schemaVersion", "op", "transactionId", "version"],
    "lifecycle supervisor request",
  );
  if (value.schemaVersion !== 2) {
    fail("unsupported lifecycle supervisor request schema");
  }
  const op = String(value.op ?? "");
  if (op !== "updateController" && !CONTROLLER_OPERATIONS.has(op)) {
    fail("unsupported lifecycle supervisor operation");
  }
  const transactionId = String(value.transactionId ?? "")
    .trim()
    .toLowerCase();
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    fail("lifecycle supervisor transactionId must be a UUIDv4");
  }
  return Object.freeze({
    schemaVersion: 2,
    op,
    transactionId,
    version: parseVersion(value.version),
  });
}

export function parseLifecycleTrustMetadata(
  value,
  { expectedVersion, channel, platform = platformIdentity(), now = Date.now() },
) {
  exactKeys(
    value,
    ["schemaVersion", "role", "release", "validity", "policy", "targets"],
    "lifecycle trust metadata",
  );
  exactKeys(value.release, ["version", "tag", "commit"], "lifecycle release identity");
  exactKeys(value.validity, ["issuedAt", "expiresAt"], "lifecycle metadata validity");
  exactKeys(
    value.policy,
    ["channels", "platforms", "supervisorProtocol", "controllerProtocol"],
    "lifecycle metadata policy",
  );
  exactKeys(
    value.targets,
    ["supervisor", "controllerServer", "controllerClient"],
    "lifecycle metadata targets",
  );
  for (const [role, target] of Object.entries(value.targets)) {
    exactKeys(target, ["asset", "sha256"], `lifecycle ${role} target`);
  }
  const version = parseVersion(value.release.version);
  const issuedAt = Date.parse(value.validity.issuedAt);
  const expiresAt = Date.parse(value.validity.expiresAt);
  const expectedAssets = {
    supervisor: SUPERVISOR_NAME,
    controllerServer: CONTROLLER_SERVER_NAME,
    controllerClient: CONTROLLER_CLIENT_NAME,
  };
  const expectedChannels = version.includes("-") ? ["beta"] : ["beta", "stable"];
  const expectedPlatforms = ["linux-arm64", "linux-x64"];
  if (
    value.schemaVersion !== SUPERVISOR_SCHEMA_VERSION ||
    value.role !== "fased-lifecycle-targets" ||
    version !== expectedVersion ||
    value.release.tag !== `v${version}` ||
    !COMMIT_PATTERN.test(value.release.commit || "") ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    new Date(issuedAt).toISOString() !== value.validity.issuedAt ||
    new Date(expiresAt).toISOString() !== value.validity.expiresAt ||
    issuedAt >= expiresAt ||
    expiresAt - issuedAt > MAX_METADATA_VALIDITY_MS ||
    now > expiresAt ||
    now < issuedAt ||
    JSON.stringify(value.policy.channels) !== JSON.stringify(expectedChannels) ||
    !value.policy.channels.includes(channel) ||
    JSON.stringify(value.policy.platforms) !== JSON.stringify(expectedPlatforms) ||
    !value.policy.platforms.includes(platform) ||
    value.policy.supervisorProtocol !== SUPERVISOR_PROTOCOL_VERSION ||
    value.policy.controllerProtocol !== CONTROLLER_PROTOCOL_VERSION
  ) {
    fail("lifecycle trust metadata is stale, incompatible, or mismatched");
  }
  for (const [role, expectedAsset] of Object.entries(expectedAssets)) {
    const target = value.targets[role];
    if (target.asset !== expectedAsset || !DIGEST_PATTERN.test(target.sha256 || "")) {
      fail(`lifecycle ${role} target identity is invalid`);
    }
  }
  return Object.freeze(value);
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(targetPath, content, mode = 0o600) {
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

async function atomicCopy(sourcePath, targetPath, mode = 0o755) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o755 });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(temporaryPath, mode);
  const handle = await fsp.open(temporaryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporaryPath, targetPath);
  await fsyncDirectory(path.dirname(targetPath));
}

async function atomicSymlink(target, linkPath) {
  await fsp.mkdir(path.dirname(linkPath), { recursive: true, mode: 0o755 });
  try {
    const existing = await fsp.lstat(linkPath);
    if (!existing.isSymbolicLink()) {
      fail("controller current path must remain a root-managed symlink");
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

async function sha256(filePath) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    fail(`official lifecycle release download failed (${response.status})`);
  }
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_DOWNLOAD_BYTES) {
    fail("official lifecycle release asset exceeds its fixed size limit");
  }
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(
        received > MAX_DOWNLOAD_BYTES
          ? new Error("official lifecycle release asset exceeds its fixed size limit")
          : null,
        chunk,
      );
    },
  });
  await pipeline(response.body, limiter, fs.createWriteStream(destination, { mode: 0o600 }));
}

async function fixedExecutable(candidates, label) {
  for (const candidate of candidates) {
    try {
      const resolved = await fsp.realpath(candidate);
      const info = await fsp.stat(resolved);
      if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        continue;
      }
      await fsp.access(resolved, fs.constants.X_OK);
      return resolved;
    } catch {
      // Try the next fixed system path.
    }
  }
  fail(`${label} is unavailable from a root-controlled system path`);
}

async function verifyMetadata(metadataPath, bundlePath, version, stateDir) {
  const gh = await fixedExecutable(["/usr/bin/gh", "/usr/local/bin/gh"], "GitHub CLI");
  await execFileAsync(
    gh,
    [
      "attestation",
      "verify",
      metadataPath,
      "--repo",
      RELEASE_REPOSITORY,
      "--bundle",
      bundlePath,
      "--signer-workflow",
      RELEASE_WORKFLOW,
      "--source-ref",
      `refs/tags/v${version}`,
      "--deny-self-hosted-runners",
    ],
    {
      env: {
        HOME: stateDir,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        GH_PROMPT_DISABLED: "1",
      },
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

async function selfCheckController(assetPath, role, stateDir) {
  const { stdout } = await execFileAsync(process.execPath, [assetPath, "--self-check"], {
    env: { HOME: stateDir, PATH: "/usr/local/bin:/usr/bin:/bin" },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const value = JSON.parse(stdout);
  exactKeys(
    value,
    ["schemaVersion", "protocolVersion", "role"],
    `lifecycle controller ${role} self-check`,
  );
  if (value.schemaVersion !== 1 || value.protocolVersion !== 2 || value.role !== role) {
    fail(`lifecycle controller ${role} self-check is incompatible`);
  }
}

async function readChannel(channelPath) {
  const channel = (await fsp.readFile(channelPath, "utf8")).trim();
  if (!new Set(["stable", "beta"]).has(channel)) {
    fail("lifecycle update channel is invalid");
  }
  return channel;
}

async function readRollbackFloor(paths) {
  try {
    return parseVersion(await fsp.readFile(paths.rollbackFloorPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readControllerIdentity(paths) {
  try {
    const value = JSON.parse(await fsp.readFile(paths.controllerVersionPath, "utf8"));
    exactKeys(
      value,
      ["schemaVersion", "version", "serverSha256", "clientSha256"],
      "controller identity",
    );
    const version = parseVersion(value.version);
    if (
      value.schemaVersion !== 1 ||
      !DIGEST_PATTERN.test(value.serverSha256 || "") ||
      !DIGEST_PATTERN.test(value.clientSha256 || "")
    ) {
      fail("controller identity is malformed");
    }
    return Object.freeze({ ...value, version });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function controllerGenerationDigests(generationRoot, expectedRootUid = 0) {
  const info = await fsp.lstat(generationRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail("controller generation must be one real directory");
  }
  const entries = await fsp.readdir(generationRoot);
  if (
    entries.toSorted().join(",") !==
    [CONTROLLER_CLIENT_NAME, CONTROLLER_SERVER_NAME].toSorted().join(",")
  ) {
    fail("controller generation contains unsupported files");
  }
  const result = {};
  for (const [role, asset] of [
    ["serverSha256", CONTROLLER_SERVER_NAME],
    ["clientSha256", CONTROLLER_CLIENT_NAME],
  ]) {
    const candidate = path.join(generationRoot, asset);
    const candidateInfo = await fsp.lstat(candidate);
    if (
      !candidateInfo.isFile() ||
      candidateInfo.isSymbolicLink() ||
      candidateInfo.nlink !== 1 ||
      candidateInfo.uid !== expectedRootUid ||
      (candidateInfo.mode & 0o022) !== 0
    ) {
      fail("controller generation target is not root-owned and immutable");
    }
    result[role] = await sha256(candidate);
  }
  return result;
}

async function currentControllerMatches(paths, identity) {
  try {
    const target = await fsp.realpath(paths.currentLink);
    const expected = path.join(paths.releasesDir, `v${identity.version}`);
    if (target !== expected) {
      return false;
    }
    const digests = await controllerGenerationDigests(target);
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

async function durableReceipt(paths, request, result) {
  const receipt = {
    schemaVersion: 1,
    transactionId: request.transactionId,
    operation: request.op,
    version: request.version,
    outcome: result.outcome,
    controllerChanged: result.controllerChanged === true,
    recordedAt: new Date().toISOString(),
  };
  await atomicWrite(
    path.join(paths.supervisorStateDir, "receipts", `${request.transactionId}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    0o600,
  );
}

export async function stageTrustedController(request, context) {
  const { paths } = context;
  const channel = await context.readChannel(paths.channelPath);
  const floor = await context.readRollbackFloor(paths);
  if (floor && compareVersions(request.version, floor) === -1) {
    fail(`controller release v${request.version} is below rollback floor v${floor}`);
  }
  const existing = await context.readControllerIdentity(paths);
  if (existing && compareVersions(existing.version, request.version) === 1) {
    fail(`refusing controller downgrade from ${existing.version} to ${request.version}`);
  }
  if (
    existing?.version === request.version &&
    (await context.currentControllerMatches(paths, existing))
  ) {
    return { changed: false, identity: existing };
  }

  await Promise.all([
    fsp.mkdir(paths.supervisorStateDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(paths.releasesDir, { recursive: true, mode: 0o755 }),
  ]);
  const downloadRoot = await fsp.mkdtemp(
    path.join(paths.supervisorStateDir, `.download-${request.version}-`),
  );
  const releaseUrl = `${RELEASE_BASE}/v${request.version}`;
  const metadataPath = path.join(downloadRoot, TRUST_METADATA_NAME);
  const bundlePath = path.join(downloadRoot, TRUST_METADATA_BUNDLE_NAME);
  const serverPath = path.join(downloadRoot, CONTROLLER_SERVER_NAME);
  const clientPath = path.join(downloadRoot, CONTROLLER_CLIENT_NAME);
  let stagingGeneration = null;
  try {
    await Promise.all([
      context.download(`${releaseUrl}/${TRUST_METADATA_NAME}`, metadataPath),
      context.download(`${releaseUrl}/${TRUST_METADATA_BUNDLE_NAME}`, bundlePath),
    ]);
    await context.verifyMetadata(
      metadataPath,
      bundlePath,
      request.version,
      paths.supervisorStateDir,
    );
    const metadata = parseLifecycleTrustMetadata(
      JSON.parse(await fsp.readFile(metadataPath, "utf8")),
      {
        expectedVersion: request.version,
        channel,
        platform: context.platform,
        now: context.now(),
      },
    );
    const installedSupervisorDigest = await sha256(paths.supervisorPath);
    if (installedSupervisorDigest !== metadata.targets.supervisor.sha256) {
      fail("installed lifecycle supervisor is not the immutable metadata-bound target");
    }
    await Promise.all([
      context.download(`${releaseUrl}/${metadata.targets.controllerServer.asset}`, serverPath),
      context.download(`${releaseUrl}/${metadata.targets.controllerClient.asset}`, clientPath),
    ]);
    const [serverSha256, clientSha256] = await Promise.all([
      sha256(serverPath),
      sha256(clientPath),
    ]);
    if (
      serverSha256 !== metadata.targets.controllerServer.sha256 ||
      clientSha256 !== metadata.targets.controllerClient.sha256
    ) {
      fail("downloaded lifecycle controller does not match immutable trust metadata");
    }
    await Promise.all([
      context.selfCheckController(serverPath, "server", paths.supervisorStateDir),
      context.selfCheckController(clientPath, "client", paths.supervisorStateDir),
    ]);
    const identity = {
      schemaVersion: 1,
      version: request.version,
      serverSha256,
      clientSha256,
    };
    const generationRoot = path.join(paths.releasesDir, `v${request.version}`);
    try {
      const digests = await controllerGenerationDigests(generationRoot, context.rootUid);
      if (digests.serverSha256 !== serverSha256 || digests.clientSha256 !== clientSha256) {
        fail(`controller generation v${request.version} is not immutable`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      stagingGeneration = await fsp.mkdtemp(
        path.join(paths.releasesDir, `.generation-${request.version}-`),
      );
      await Promise.all([
        atomicCopy(serverPath, path.join(stagingGeneration, CONTROLLER_SERVER_NAME)),
        atomicCopy(clientPath, path.join(stagingGeneration, CONTROLLER_CLIENT_NAME)),
      ]);
      await fsp.chown(stagingGeneration, context.rootUid, context.rootGid);
      await fsp.chmod(stagingGeneration, 0o755);
      await fsyncDirectory(stagingGeneration);
      await fsp.rename(stagingGeneration, generationRoot);
      stagingGeneration = null;
      await fsyncDirectory(paths.releasesDir);
    }
    let previousGeneration = null;
    try {
      previousGeneration = await fsp.realpath(paths.currentLink);
      const releasesRoot = path.resolve(paths.releasesDir);
      if (
        path.dirname(previousGeneration) !== releasesRoot ||
        !/^v[0-9A-Za-z.-]+$/u.test(path.basename(previousGeneration))
      ) {
        fail("controller current symlink escapes its fixed releases directory");
      }
      await controllerGenerationDigests(previousGeneration, context.rootUid);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await atomicSymlink(generationRoot, paths.currentLink);
    await atomicWrite(paths.controllerVersionPath, `${JSON.stringify(identity, null, 2)}\n`, 0o600);
    return {
      changed: previousGeneration !== generationRoot,
      identity,
      previousGeneration,
      previousIdentity: existing,
    };
  } finally {
    await Promise.all([
      fsp.rm(downloadRoot, { recursive: true, force: true }),
      stagingGeneration
        ? fsp.rm(stagingGeneration, { recursive: true, force: true })
        : Promise.resolve(),
    ]);
  }
}

async function restoreControllerSelection(paths, staged) {
  if (staged.previousGeneration) {
    await atomicSymlink(staged.previousGeneration, paths.currentLink);
  } else {
    await fsp.rm(paths.currentLink, { force: true });
    await fsyncDirectory(path.dirname(paths.currentLink));
  }
  if (staged.previousIdentity) {
    await atomicWrite(
      paths.controllerVersionPath,
      `${JSON.stringify(staged.previousIdentity, null, 2)}\n`,
      0o600,
    );
  } else {
    await fsp.rm(paths.controllerVersionPath, { force: true });
    await fsyncDirectory(path.dirname(paths.controllerVersionPath));
  }
}

async function systemctl(...args) {
  const binary = await fixedExecutable(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
  await execFileAsync(binary, args, {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function unitPath(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(" ", "\\x20");
}

function passwdRecord(uid) {
  const matches = fs
    .readFileSync("/etc/passwd", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(":"))
    .filter((fields) => Number(fields[2]) === uid);
  if (matches.length !== 1) {
    fail("lifecycle operator UID does not resolve to one system account");
  }
  const fields = matches[0];
  const user = fields[0];
  const home = fields[5];
  if (
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,30}$/u.test(user) ||
    user === "root" ||
    !path.isAbsolute(home) ||
    path.resolve(home) !== home
  ) {
    fail("lifecycle operator account or home is unsafe");
  }
  return Object.freeze({ user, home });
}

function protectedLocalStateDir(configuration, operator) {
  const registryPath = "/var/lib/fased-local-registry/instances.json";
  const info = fs.lstatSync(registryPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== 0 ||
    (info.mode & 0o177) !== 0
  ) {
    fail("Protected Local registry is not a root-owned immutable input");
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.instances)) {
    fail("Protected Local registry schema is unsupported");
  }
  const matches = registry.instances.filter(
    (entry) =>
      entry?.instanceId === configuration.instanceId &&
      entry?.operatorUid === configuration.operatorUid &&
      entry?.operatorUser === operator.user,
  );
  if (matches.length !== 1) {
    fail("Protected Local registry does not bind this supervisor instance");
  }
  const stateDir = String(matches[0].stateDir ?? "");
  if (
    !path.isAbsolute(stateDir) ||
    path.resolve(stateDir) !== stateDir ||
    (stateDir !== operator.home && !stateDir.startsWith(`${operator.home}${path.sep}`))
  ) {
    fail("Protected Local application state is outside its declared operator home");
  }
  return stateDir;
}

function renderBoundaryUnits(configuration, nodeBinary) {
  const { paths } = configuration;
  const operator = passwdRecord(configuration.operatorUid);
  const appStateDir =
    configuration.profile === "hosting"
      ? path.join(operator.home, ".fased")
      : protectedLocalStateDir(configuration, operator);
  const controllerExec =
    configuration.profile === "hosting"
      ? `${unitPath(nodeBinary)} /opt/fased/host-controller/current/fased-host-updater.mjs --supervised --socket-path /run/fased-host-controller/controller.sock --socket-uid 0 --socket-gid 0`
      : `${unitPath(nodeBinary)} /opt/fased/local/${configuration.instanceId}/controller/current/fased-host-updater.mjs --protected-local-instance ${configuration.instanceId} --supervised --socket-path /run/fased-local-controller-worker/${configuration.instanceId}/controller.sock --socket-uid 0 --socket-gid 0`;
  const controllerRuntime =
    configuration.profile === "hosting"
      ? "fased-host-controller"
      : `fased-local-controller-worker/${configuration.instanceId}`;
  const controllerState =
    configuration.profile === "hosting"
      ? "fased-host-updater"
      : `fased-local/${configuration.instanceId}/controller`;
  const controllerWrites =
    configuration.profile === "hosting"
      ? `/opt/fased/host-controller/releases /opt/fased/signer /var/lib/fased-host-updater /var/lib/fased-signer-update-gate /var/lib/fased-signerd /run/fased-host-controller /etc/systemd/system ${unitPath(appStateDir)}`
      : `/opt/fased/local/${configuration.instanceId}/application /opt/fased/local/${configuration.instanceId}/signer /var/lib/fased-local/${configuration.instanceId}/signer /var/lib/fased-local/${configuration.instanceId}/controller ${unitPath(appStateDir)} /run/fased-local-controller-worker/${configuration.instanceId} /etc/systemd/system`;
  const controllerReadOnly =
    configuration.profile === "hosting"
      ? `/opt/fased/host-controller/supervisor /var/lib/fased-host-updater/supervisor ${unitPath(path.join("/etc/systemd/system", paths.supervisorUnit))}`
      : `/opt/fased/local/${configuration.instanceId}/supervisor /var/lib/fased-local/${configuration.instanceId}/controller/supervisor ${unitPath(path.join("/etc/systemd/system", paths.supervisorUnit))}`;
  const controller = `[Unit]
Description=Fased target lifecycle controller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
RuntimeDirectory=${controllerRuntime}
RuntimeDirectoryMode=0711
StateDirectory=${controllerState}
StateDirectoryMode=0711
UMask=0077
Environment=HOME=${unitPath(paths.stateDir)}
ExecStart=${controllerExec}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=read-only
ProtectSystem=strict
ReadWritePaths=${controllerWrites}
ReadOnlyPaths=${controllerReadOnly}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
LockPersonality=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
`;
  const supervisorRuntime =
    configuration.profile === "hosting"
      ? "fased-host-updater"
      : `fased-local-controller/${configuration.instanceId}`;
  const supervisorWrites =
    configuration.profile === "hosting"
      ? "/opt/fased/host-controller /var/lib/fased-host-updater/supervisor /run/fased-host-updater"
      : `/opt/fased/local/${configuration.instanceId}/controller /var/lib/fased-local/${configuration.instanceId}/controller/supervisor /run/fased-local-controller/${configuration.instanceId}`;
  const supervisorReadOnly =
    configuration.profile === "hosting"
      ? "/opt/fased/host-controller/supervisor"
      : `/opt/fased/local/${configuration.instanceId}/supervisor`;
  const instanceArgs =
    configuration.profile === "protected-local"
      ? ` --protected-local-instance ${configuration.instanceId}`
      : "";
  const supervisor = `[Unit]
Description=Fased stable lifecycle supervisor
After=${paths.controllerUnit} network-online.target
Wants=${paths.controllerUnit} network-online.target

[Service]
Type=simple
User=root
Group=root
RuntimeDirectory=${supervisorRuntime}
RuntimeDirectoryMode=0711
UMask=0177
Environment=HOME=${unitPath(paths.supervisorStateDir)}
ExecStart=${unitPath(nodeBinary)} ${unitPath(paths.supervisorPath)} --profile ${configuration.profile}${instanceArgs} --operator-uid ${configuration.operatorUid} --operator-gid ${configuration.operatorGid}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${supervisorWrites}
ReadOnlyPaths=${supervisorReadOnly}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
CapabilityBoundingSet=CAP_CHOWN
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
`;
  return Object.freeze({
    controller: {
      path: path.join("/etc/systemd/system", paths.controllerUnit),
      content: controller,
    },
    supervisor: {
      path: path.join("/etc/systemd/system", paths.supervisorUnit),
      content: supervisor,
    },
  });
}

async function captureFile(filePath) {
  try {
    const info = await fsp.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0) {
      fail(`lifecycle unit input is unsafe: ${filePath}`);
    }
    return {
      exists: true,
      content: await fsp.readFile(filePath),
      mode: info.mode & 0o777,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

async function restoreCapturedFile(filePath, captured) {
  if (!captured.exists) {
    await fsp.rm(filePath, { force: true });
    return;
  }
  await atomicWrite(filePath, captured.content, captured.mode);
}

export async function installSupervisorBoundary(configuration) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    fail("lifecycle supervisor bootstrap must run as root");
  }
  const supervisorRealPath = await fsp.realpath(configuration.paths.supervisorPath);
  const selfRealPath = await fsp.realpath(fileURLToPath(import.meta.url));
  const supervisorInfo = await fsp.lstat(supervisorRealPath);
  if (
    supervisorRealPath !== selfRealPath ||
    !supervisorInfo.isFile() ||
    supervisorInfo.isSymbolicLink() ||
    supervisorInfo.uid !== 0 ||
    supervisorInfo.nlink !== 1 ||
    (supervisorInfo.mode & 0o022) !== 0
  ) {
    fail("stable lifecycle supervisor bootstrap is not executing its fixed root-owned target");
  }
  const nodeBinary = await fsp.realpath(process.execPath);
  const nodeInfo = await fsp.stat(nodeBinary);
  if (!nodeInfo.isFile() || nodeInfo.uid !== 0 || (nodeInfo.mode & 0o022) !== 0) {
    fail("lifecycle supervisor requires one root-controlled system Node.js runtime");
  }
  const units = renderBoundaryUnits(configuration, nodeBinary);
  const snapshots = new Map();
  for (const unit of Object.values(units)) {
    snapshots.set(unit.path, await captureFile(unit.path));
  }
  try {
    for (const unit of Object.values(units)) {
      await atomicWrite(unit.path, unit.content, 0o644);
    }
    await systemctl("daemon-reload");
    await systemctl("enable", "--now", configuration.paths.controllerUnit);
    await systemctl("enable", configuration.paths.supervisorUnit);
    await atomicWrite(
      path.join(configuration.paths.supervisorStateDir, "boundary.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          profile: configuration.profile,
          instanceId: configuration.instanceId,
          supervisorProtocol: SUPERVISOR_PROTOCOL_VERSION,
          controllerProtocol: CONTROLLER_PROTOCOL_VERSION,
          operatorUid: configuration.operatorUid,
          operatorGid: configuration.operatorGid,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      0o600,
    );
  } catch (error) {
    for (const [filePath, snapshot] of snapshots) {
      await restoreCapturedFile(filePath, snapshot);
    }
    await systemctl("daemon-reload").catch(() => undefined);
    throw error;
  }
  return {
    schemaVersion: 1,
    profile: configuration.profile,
    instanceId: configuration.instanceId,
    supervisorUnit: configuration.paths.supervisorUnit,
    controllerUnit: configuration.paths.controllerUnit,
  };
}

async function waitForControllerSocket(socketPath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await fsp.lstat(socketPath);
      if (info.isSocket() && !info.isSymbolicLink()) {
        return;
      }
    } catch {
      // The fixed worker service is still restarting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("replaceable lifecycle controller did not create its private socket");
}

function createContext(configuration, overrides = {}) {
  return {
    configuration,
    paths: configuration.paths,
    rootUid: overrides.rootUid ?? (typeof process.geteuid === "function" ? process.geteuid() : 0),
    rootGid: overrides.rootGid ?? (typeof process.getegid === "function" ? process.getegid() : 0),
    platform: overrides.platform ?? platformIdentity(),
    now: overrides.now ?? (() => Date.now()),
    readChannel: overrides.readChannel ?? readChannel,
    readRollbackFloor: overrides.readRollbackFloor ?? readRollbackFloor,
    readControllerIdentity: overrides.readControllerIdentity ?? readControllerIdentity,
    currentControllerMatches: overrides.currentControllerMatches ?? currentControllerMatches,
    download: overrides.download ?? download,
    verifyMetadata: overrides.verifyMetadata ?? verifyMetadata,
    selfCheckController: overrides.selfCheckController ?? selfCheckController,
    stageTrustedController: overrides.stageTrustedController ?? stageTrustedController,
    restoreControllerSelection: overrides.restoreControllerSelection ?? restoreControllerSelection,
    probeControllerIdentity: overrides.probeControllerIdentity ?? probeControllerIdentity,
    restartController:
      overrides.restartController ??
      (async () => await systemctl("restart", configuration.paths.controllerUnit)),
    waitForController:
      overrides.waitForController ??
      (async () => await waitForControllerSocket(configuration.paths.privateSocketPath)),
  };
}

async function requestController(request, context) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: context.paths.privateSocketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS);
    let body = "";
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_REQUEST_BYTES) {
        rejectOnce(new Error("replaceable lifecycle controller response is too large"));
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0 || settled) {
        return;
      }
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (
          response?.transactionId !== request.transactionId ||
          response?.version !== request.version ||
          typeof response?.ok !== "boolean"
        ) {
          rejectOnce(new Error("replaceable lifecycle controller returned a mismatched response"));
          return;
        }
        settled = true;
        socket.destroy();
        resolve(response);
      } catch (error) {
        rejectOnce(
          new Error(`replaceable lifecycle controller returned invalid JSON: ${error.message}`),
        );
      }
    });
    socket.once("timeout", () =>
      rejectOnce(new Error(`replaceable lifecycle controller timed out during ${request.op}`)),
    );
    socket.once("error", rejectOnce);
    socket.once("close", () => {
      if (!settled) {
        rejectOnce(new Error("replaceable lifecycle controller closed before responding"));
      }
    });
  });
}

async function probeControllerIdentity(request, context) {
  const response = await requestController(
    {
      ...request,
      op: "controllerStatus",
    },
    context,
  );
  if (
    !response.ok ||
    response.controllerVersion !== request.version ||
    !TRANSACTION_ID_PATTERN.test(response.controllerInstanceId || "")
  ) {
    fail("replaceable lifecycle controller is not running the verified target");
  }
  return response.controllerInstanceId;
}

async function handleSupervisorRequest(request, context, state) {
  if (request.op === "updateController") {
    const priorInstanceId = state.controllerInstanceId;
    const staged = await context.stageTrustedController(request, context);
    let restarted = staged.changed;
    try {
      if (staged.changed) {
        await context.restartController();
        await context.waitForController();
      }
      try {
        state.controllerInstanceId = await context.probeControllerIdentity(request, context);
      } catch (error) {
        if (staged.changed) {
          throw error;
        }
        restarted = true;
        await context.restartController();
        await context.waitForController();
        state.controllerInstanceId = await context.probeControllerIdentity(request, context);
      }
    } catch (error) {
      if (staged.changed) {
        await context.restoreControllerSelection(context.paths, staged);
        await context.restartController();
        await context.waitForController();
      }
      await durableReceipt(context.paths, request, {
        outcome: staged.changed ? "rolled-back" : "failed",
        controllerChanged: false,
      });
      throw new Error(
        staged.changed
          ? `controller promotion failed and was restored: ${error.message}`
          : `controller verification failed: ${error.message}`,
        { cause: error },
      );
    }
    await durableReceipt(context.paths, request, {
      outcome: "verified",
      controllerChanged: restarted,
    });
    return {
      ok: true,
      transactionId: request.transactionId,
      version: request.version,
      controllerChanged: restarted,
      controllerInstanceId: restarted ? priorInstanceId : state.controllerInstanceId,
    };
  }

  const response = await requestController(request, context);
  if (response.ok && request.op === "commitRelease") {
    await atomicWrite(context.paths.rollbackFloorPath, `${request.version}\n`, 0o600);
  }
  if (request.op === "commitRelease" || request.op === "rollbackRelease") {
    await durableReceipt(context.paths, request, {
      outcome: response.ok
        ? request.op === "commitRelease"
          ? "committed"
          : "rolled-back"
        : "failed",
      controllerChanged: false,
    });
  }
  return response;
}

function writeResponse(socket, payload) {
  socket.end(`${JSON.stringify(payload)}\n`);
}

export async function startSupervisor(options = {}) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    fail("lifecycle supervisor must run as root");
  }
  const configuration = options.configuration ?? parseSupervisorConfiguration();
  const context = options.context ?? createContext(configuration);
  const state = { controllerInstanceId: randomUUID() };
  await fsp.mkdir(path.dirname(context.paths.publicSocketPath), {
    recursive: true,
    mode: 0o711,
  });
  await fsp.mkdir(context.paths.supervisorStateDir, { recursive: true, mode: 0o700 });
  await context.waitForController();
  await fsp.rm(context.paths.publicSocketPath, { force: true });
  process.umask(0o177);
  let queue = Promise.resolve();
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS);
    let body = "";
    let handled = false;
    const failRequest = (message) => {
      if (!handled) {
        handled = true;
        writeResponse(socket, { ok: false, error: message });
      }
    };
    socket.on("timeout", () => failRequest("lifecycle supervisor request timed out"));
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      if (handled) {
        return;
      }
      body += chunk;
      if (body.length > MAX_REQUEST_BYTES) {
        failRequest("lifecycle supervisor request is too large");
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) {
        return;
      }
      handled = true;
      let request;
      try {
        request = parseSupervisorRequest(JSON.parse(body.slice(0, newline)));
      } catch (error) {
        writeResponse(socket, { ok: false, error: error.message });
        return;
      }
      const operation = queue.then(() => handleSupervisorRequest(request, context, state));
      queue = operation.catch(() => undefined);
      void operation.then(
        (result) => writeResponse(socket, result),
        (error) =>
          writeResponse(socket, {
            ok: false,
            transactionId: request.transactionId,
            version: request.version,
            error: error.message,
          }),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(context.paths.publicSocketPath, resolve);
  });
  await fsp.chown(
    context.paths.publicSocketPath,
    configuration.operatorUid,
    configuration.operatorGid,
  );
  await fsp.chmod(context.paths.publicSocketPath, 0o600);
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(context.paths.publicSocketPath, { force: true });
  };
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  return { server, close, context };
}

async function main() {
  if (process.argv[2] === "--self-check") {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: SUPERVISOR_SCHEMA_VERSION,
        protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
        role: "lifecycle-supervisor",
      })}\n`,
    );
    return;
  }
  if (process.argv[2] === "bootstrap-boundary") {
    const result = await installSupervisorBoundary(
      parseSupervisorConfiguration(process.argv.slice(3)),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const running = await startSupervisor({
    configuration: parseSupervisorConfiguration(process.argv.slice(2)),
  });
  await new Promise((resolve, reject) => {
    running.server.once("close", resolve);
    running.server.once("error", reject);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`fased-lifecycle-supervisor: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export const __testing = Object.freeze({
  CONTROLLER_CLIENT_NAME,
  CONTROLLER_SERVER_NAME,
  SUPERVISOR_NAME,
  TRUST_METADATA_NAME,
  compareVersions,
  createContext,
  handleSupervisorRequest,
  lifecyclePaths,
  platformIdentity,
  renderBoundaryUnits,
  restoreControllerSelection,
});
