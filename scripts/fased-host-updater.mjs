#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const SOCKET_PATH = "/run/fased-host-updater/request.sock";
const STATE_DIR = "/var/lib/fased-host-updater";
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
const JOURNAL_SCHEMA_VERSION = 1;
const PROTOCOL_SCHEMA_VERSION = 2;
const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSACTION_OPERATIONS = new Set([
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
  "From a VPS provider console or a root SSH session, run:",
  "curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --repair-hosting",
  "The current Gateway, signer, wallets, and persistent state were left unchanged.",
].join(" ");

const DEFAULT_PATHS = Object.freeze({
  socketPath: SOCKET_PATH,
  stateDir: STATE_DIR,
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

async function verifyReleaseAsset(assetPath, version, stateDir) {
  const gh = await fixedExecutable(["/usr/bin/gh", "/usr/local/bin/gh"], "GitHub CLI");
  await execFileAsync(
    gh,
    [
      "attestation",
      "verify",
      assetPath,
      "--repo",
      RELEASE_REPOSITORY,
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

async function verifyAdjacentChecksum(assetPath, checksumPath, assetName) {
  const checksum = await fsp.readFile(checksumPath, "utf8");
  const expected = checksum
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1]?.replace(/^\*/, "") === assetName)?.[0]
    ?.toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("official signer checksum entry is missing");
  }
  if ((await sha256(assetPath)) !== expected) {
    throw new Error("official signer checksum mismatch");
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

function assertSignerV2Health(response) {
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
}

export async function probeSignerV2() {
  const response = await new Promise((resolve, reject) => {
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
  assertSignerV2Health(response);
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

async function startSignerService({ requireV2 }) {
  await systemctl("start", "fased-signerd.service");
  await systemctl("is-active", "--quiet", "fased-signerd.service");
  if (!requireV2) {
    return;
  }
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await probeSignerV2();
      return;
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
    value.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    !TRANSACTION_PHASES.has(value.phase)
  ) {
    throw new Error("host updater transaction journal is invalid");
  }
  return {
    ...value,
    transactionId: parseTransactionId(value.transactionId),
    version: parseReleaseVersion(value.version),
    previousVersion:
      value.previousVersion == null ? null : parseReleaseVersion(value.previousVersion),
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
  const assetName = `fased-signerd-linux-${arch}`;
  const releaseUrl = `${RELEASE_BASE}/v${version}`;
  await fsp.mkdir(context.paths.stateDir, { recursive: true, mode: 0o700 });
  const staging = await fsp.mkdtemp(path.join(context.paths.stateDir, `.download-${version}-`));
  const assetPath = path.join(staging, assetName);
  const checksumsPath = path.join(staging, "fased-signerd-checksums.txt");
  try {
    await Promise.all([
      download(`${releaseUrl}/${assetName}`, assetPath),
      download(`${releaseUrl}/fased-signerd-checksums.txt`, checksumsPath),
    ]);
    await verifyAdjacentChecksum(assetPath, checksumsPath, assetName);
    await verifyReleaseAsset(assetPath, version, context.paths.stateDir);
    await fsp.rm(candidatePath, { force: true });
    await atomicCopyFileDurable(assetPath, candidatePath, { mode: 0o755 });
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

function createTransactionContext(overrides = {}) {
  const paths = { ...DEFAULT_PATHS, ...overrides.paths };
  return {
    paths,
    assertReleaseAllowed:
      overrides.assertReleaseAllowed ??
      (async (version) => await assertReleaseChannelAllowed(version, paths.channelPath)),
    stageCandidate:
      overrides.stageCandidate ??
      (async (version, candidatePath, context) =>
        await stageOfficialCandidate(version, candidatePath, context)),
    stopSigner: overrides.stopSigner ?? stopSignerService,
    startSignerV2:
      overrides.startSignerV2 ?? (async () => await startSignerService({ requireV2: true })),
    startPreviousSigner:
      overrides.startPreviousSigner ??
      (async ({ requireV2 = false } = {}) => await startSignerService({ requireV2 })),
    reloadUnits: overrides.reloadUnits ?? (async () => await systemctl("daemon-reload")),
    startGateway:
      overrides.startGateway ?? (async () => await systemctl("start", "fased-gateway.service")),
    probeSigner: overrides.probeSigner ?? probeSignerV2,
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
    };
  }

  const currentVersion = await readVersionFile(context.paths.versionPath);
  if (currentVersion && compareVersions(currentVersion, request.version) === 1) {
    throw new Error(`refusing signer downgrade from ${currentVersion} to ${request.version}`);
  }

  let changed = true;
  if (currentVersion === request.version) {
    try {
      await fsp.access(context.paths.signerPath, fs.constants.X_OK);
      await context.probeSigner();
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
      await context.stageCandidate(request.version, txPaths.candidatePath, context);
    }
    journal = await writeJournal(context, {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId: request.transactionId,
      version: request.version,
      previousVersion: currentVersion,
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
    await context.startSignerV2();
    await atomicWriteFileDurable(context.paths.versionPath, `${journal.version}\n`, 0o600);
    journal = await writeJournal(context, { ...journal, phase: "active" });
    return {
      transactionId: journal.transactionId,
      version: journal.version,
      phase: journal.phase,
      changed: true,
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

function writeResponse(socket, payload) {
  socket.end(`${JSON.stringify(payload)}\n`);
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
      void operation.then(
        (result) => writeResponse(socket, { ok: true, ...result }),
        (error) => writeResponse(socket, { ok: false, error: error.message }),
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
  await startServer();
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
  releaseAllowedForChannel,
  releaseArchitecture,
  rollbackSignerRelease,
  transactionPaths,
  writeJournal,
};
