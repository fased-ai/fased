#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SUPERVISOR_REQUEST_SCHEMA_VERSION = 3;
export const SUPERVISOR_CLIENT_PROTOCOL_VERSION = 2;
export const DEFAULT_SUPERVISOR_SOCKET = "/run/fased-host-updater/request.sock";
export const DEFAULT_CLIENT_STATE = "/var/lib/fased-host-updater/ctl-transaction.json";
export const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

const CONTROL_MODES = new Set([
  "--apply",
  "--prepare-only",
  "--activate-only",
  "--commit-only",
  "--rollback-only",
]);
const SUPERVISOR_CLIENT_CAPABILITIES = Object.freeze({
  protocolVersion: SUPERVISOR_CLIENT_PROTOCOL_VERSION,
  requestSchema: SUPERVISOR_REQUEST_SCHEMA_VERSION,
});

function parseReleaseVersion(value) {
  const version = String(value ?? "")
    .trim()
    .replace(/^v/u, "");
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error("an exact signer release version is required");
  }
  return version;
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readClientHint(statePath) {
  try {
    const info = await fsp.lstat(statePath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o177) !== 0) {
      throw new Error("supervisor client transaction hint is unsafe");
    }
    const saved = JSON.parse(await fsp.readFile(statePath, "utf8"));
    if (
      saved?.schemaVersion !== 1 ||
      !RELEASE_VERSION_PATTERN.test(String(saved.version ?? "")) ||
      !TRANSACTION_ID_PATTERN.test(String(saved.transactionId ?? ""))
    ) {
      throw new Error("supervisor client transaction hint is invalid");
    }
    return Object.freeze({
      schemaVersion: 1,
      transactionId: String(saved.transactionId).toLowerCase(),
      version: String(saved.version),
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function persistClientHint(statePath, transactionId, version) {
  await fsp.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fsp.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ schemaVersion: 1, transactionId, version }, null, 2)}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporaryPath, statePath);
  await fsyncDirectory(path.dirname(statePath));
}

async function clearClientHint(statePath) {
  await fsp.rm(statePath, { force: true });
  try {
    await fsyncDirectory(path.dirname(statePath));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function requestSupervisorOperation({
  socketPath = DEFAULT_SUPERVISOR_SOCKET,
  operation,
  transactionId,
  nonce,
  version,
  recoveryDigest = null,
  recoveryControllerVersion = null,
  timeoutMs = 20 * 60_000,
}) {
  const normalizedVersion = parseReleaseVersion(version);
  const normalizedTransactionId = String(transactionId ?? "").toLowerCase();
  const normalizedNonce = String(nonce ?? "").toLowerCase();
  if (!TRANSACTION_ID_PATTERN.test(normalizedTransactionId)) {
    throw new Error("supervisor client transaction ID must be a UUIDv4");
  }
  if (!TRANSACTION_ID_PATTERN.test(normalizedNonce)) {
    throw new Error("supervisor client request nonce must be a UUIDv4");
  }
  const normalizedRecoveryControllerVersion =
    operation === "recoverActive" ? parseReleaseVersion(recoveryControllerVersion) : null;
  if (operation === "recoverActive" && !/^[a-f0-9]{64}$/u.test(String(recoveryDigest ?? ""))) {
    throw new Error("supervisor client recovery digest is invalid");
  }
  if (
    operation !== "updateController" &&
    !new Set([
      "recoveryStatus",
      "recoverActive",
      "applyRelease",
      "prepareRelease",
      "activateRelease",
      "authorizeGatewayRelease",
      "gateGatewayRelease",
      "restartGateway",
      "commitRelease",
      "rollbackRelease",
    ]).has(operation)
  ) {
    throw new Error(`unsupported supervisor operation: ${operation}`);
  }
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    let body = "";
    let settled = false;
    let requestSent = false;
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error && typeof error === "object") {
        error.supervisorRequestSent = requestSent;
      }
      reject(error);
    };
    socket.once("connect", () => {
      requestSent = true;
      socket.write(
        `${JSON.stringify({
          schemaVersion: SUPERVISOR_REQUEST_SCHEMA_VERSION,
          op: operation,
          transactionId: normalizedTransactionId,
          nonce: normalizedNonce,
          version: normalizedVersion,
          clientCapabilities: SUPERVISOR_CLIENT_CAPABILITIES,
          ...(operation === "recoverActive" ? { recoveryDigest } : {}),
          ...(operation === "recoverActive"
            ? { recoveryControllerVersion: normalizedRecoveryControllerVersion }
            : {}),
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        fail(new Error("lifecycle supervisor response exceeded its bound"));
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0 || settled) {
        return;
      }
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (
          !response?.ok ||
          response.transactionId !== normalizedTransactionId ||
          response.version !== normalizedVersion
        ) {
          const error = new Error(response?.error || `lifecycle supervisor rejected ${operation}`);
          error.supervisorRecoveryComplete =
            response?.transactionId === normalizedTransactionId &&
            response?.version === normalizedVersion &&
            response?.recoveryComplete === true;
          fail(error);
          return;
        }
        settled = true;
        socket.destroy();
        resolve(response);
      } catch (error) {
        fail(
          new Error(`lifecycle supervisor returned invalid JSON: ${error.message}`, {
            cause: error,
          }),
        );
      }
    });
    socket.once("timeout", () =>
      fail(new Error(`lifecycle supervisor timed out during ${operation}`)),
    );
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) {
        fail(new Error(`lifecycle supervisor closed before ${operation} completed`));
      }
    });
  });
}

function retryableConnectionError(error) {
  return (
    new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]).has(error?.code) ||
    /closed before|timed out/iu.test(error?.message || "")
  );
}

export async function requestSupervisorOperationWithRetry(params, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await requestSupervisorOperation(params);
    } catch (error) {
      lastError = error;
      if (!retryableConnectionError(error) || attempt + 1 >= attempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

export async function ensureSupervisorTargetController(params, overrides = {}) {
  const request =
    overrides.request ??
    (async () =>
      await requestSupervisorOperationWithRetry({ ...params, operation: "updateController" }, 120));
  const wait =
    overrides.wait ?? (async () => await new Promise((resolve) => setTimeout(resolve, 500)));
  const first = await request();
  if (first.controllerChanged !== true) {
    return first;
  }
  const previousInstance = first.controllerInstanceId;
  if (!TRANSACTION_ID_PATTERN.test(previousInstance || "")) {
    throw new Error("lifecycle supervisor omitted its controller process identity");
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait();
    try {
      const current = await request();
      if (
        current.controllerChanged !== true &&
        TRANSACTION_ID_PATTERN.test(current.controllerInstanceId || "") &&
        current.controllerInstanceId !== previousInstance
      ) {
        return current;
      }
    } catch {
      // systemd is replacing the verified target-controller process.
    }
  }
  throw new Error("verified lifecycle controller did not restart into the target release");
}

export async function recoverPendingSupervisorTransaction(params, overrides = {}) {
  const request = overrides.request ?? requestSupervisorOperationWithRetry;
  const wait =
    overrides.wait ?? (async () => await new Promise((resolve) => setTimeout(resolve, 500)));
  for (let step = 0; step < 3; step += 1) {
    const status = await request({ ...params, operation: "recoveryStatus" }, 3);
    if (status.recovery?.state === "READY") {
      return status;
    }
    const recovery = status.recovery;
    if (
      recovery?.state !== "RECOVERY_PENDING" ||
      !TRANSACTION_ID_PATTERN.test(recovery.transactionId || "") ||
      !RELEASE_VERSION_PATTERN.test(recovery.targetVersion || "") ||
      !/^[a-f0-9]{64}$/u.test(recovery.journalDigest || "")
    ) {
      throw new Error("lifecycle supervisor reported an unrecoverable protected journal");
    }
    const result = await request(
      {
        socketPath: params.socketPath,
        operation: "recoverActive",
        transactionId: recovery.transactionId,
        nonce: randomUUID().toLowerCase(),
        version: recovery.targetVersion,
        recoveryDigest: recovery.journalDigest,
        recoveryControllerVersion: params.version,
        timeoutMs: params.timeoutMs,
      },
      1,
    );
    if (result.recovery?.state === "READY") {
      return result;
    }
    await wait();
  }
  throw new Error("lifecycle recovery did not converge after its bounded explicit handoff");
}

export async function runSupervisorClient({
  version,
  mode,
  socketPath = DEFAULT_SUPERVISOR_SOCKET,
  statePath = DEFAULT_CLIENT_STATE,
}) {
  const normalizedVersion = parseReleaseVersion(version);
  if (!CONTROL_MODES.has(mode)) {
    throw new Error(`unsupported signer updater control mode: ${mode}`);
  }

  const hint = await readClientHint(statePath);
  // This file is deliberately only a retry hint. A marker for target A must
  // never prevent the root-owned supervisor from recovering A before target B.
  const transactionId =
    hint?.version === normalizedVersion ? hint.transactionId : randomUUID().toLowerCase();
  const nonce = randomUUID().toLowerCase();
  const params = { socketPath, transactionId, nonce, version: normalizedVersion };
  let targetSelected = false;
  let activated = false;
  try {
    await recoverPendingSupervisorTransaction(params);
    if (mode === "--rollback-only") {
      const rolledBack = await requestSupervisorOperationWithRetry(
        { ...params, operation: "rollbackRelease" },
        120,
      );
      await clearClientHint(statePath);
      return rolledBack;
    }
    if (mode === "--commit-only") {
      activated = true;
      const committed = await requestSupervisorOperationWithRetry(
        { ...params, operation: "commitRelease" },
        120,
      );
      await clearClientHint(statePath);
      return committed;
    }

    await ensureSupervisorTargetController(params);
    targetSelected = true;
    await persistClientHint(statePath, transactionId, normalizedVersion);
    if (mode === "--prepare-only") {
      return await requestSupervisorOperationWithRetry(
        { ...params, operation: "prepareRelease" },
        120,
      );
    }
    if (mode === "--apply") {
      activated = true;
      const committed = await requestSupervisorOperationWithRetry(
        { ...params, operation: "applyRelease" },
        120,
      );
      await clearClientHint(statePath);
      return committed;
    }
    activated = true;
    return await requestSupervisorOperationWithRetry({ ...params, operation: "activateRelease" });
  } catch (error) {
    if (targetSelected && error?.supervisorRecoveryComplete === true) {
      // The stable root supervisor has durably restored the previous product
      // generation. Its ledger is authoritative, so the unprivileged retry
      // hint must not survive and falsely advertise an active transaction.
      await clearClientHint(statePath);
    } else if (targetSelected && !activated) {
      try {
        await requestSupervisorOperationWithRetry({ ...params, operation: "rollbackRelease" });
        await clearClientHint(statePath);
      } catch {
        // The root ledger remains authoritative. Retain the hint for diagnostics only.
      }
    }
    throw error;
  }
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

async function main() {
  if (process.argv[2] === "--self-check") {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        protocolVersion: SUPERVISOR_CLIENT_PROTOCOL_VERSION,
        role: "client",
      })}\n`,
    );
    return;
  }
  const result = await runSupervisorClient({
    version: process.argv[2],
    mode: process.argv[3],
    socketPath: process.env.FASED_HOST_UPDATER_SOCKET || DEFAULT_SUPERVISOR_SOCKET,
    statePath: process.env.FASED_HOST_UPDATERCTL_STATE || DEFAULT_CLIENT_STATE,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isMainModule(process.argv[1])) {
  await main();
}
