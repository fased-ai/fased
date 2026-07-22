#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const socketPath = process.env.FASED_HOST_UPDATER_SOCKET || "/run/fased-host-updater/request.sock";
const statePath =
  process.env.FASED_HOST_UPDATERCTL_STATE || "/var/lib/fased-host-updater/ctl-transaction.json";
const transactionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (process.argv[2] === "--self-check") {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, protocolVersion: 2, role: "client" })}\n`,
  );
  process.exit(0);
}
const version = String(process.argv[2] ?? "")
  .trim()
  .replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
  throw new Error("an exact signer release version is required");
}
const mode = process.argv[3] || "--full";
if (
  !new Set(["--full", "--prepare-only", "--activate-only", "--commit-only", "--rollback-only"]).has(
    mode,
  )
) {
  throw new Error(`unsupported signer updater control mode: ${mode}`);
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function loadOrCreateTransactionId() {
  try {
    const saved = JSON.parse(await fsp.readFile(statePath, "utf8"));
    if (saved.version !== version || !transactionPattern.test(saved.transactionId || "")) {
      throw new Error(
        `another root signer update transaction is unfinished (${saved.version || "unknown"}); re-run its repair before v${version}`,
      );
    }
    return saved.transactionId.toLowerCase();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const transactionId = randomUUID();
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
  return transactionId;
}

async function clearTransactionId() {
  await fsp.rm(statePath, { force: true });
  await fsyncDirectory(path.dirname(statePath));
}

const transactionId = await loadOrCreateTransactionId();

async function request(op) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(20 * 60_000);
    let body = "";
    let settled = false;
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ schemaVersion: 2, op, transactionId, version })}\n`);
    });
    socket.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline < 0 || settled) {
        return;
      }
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (
          !response?.ok ||
          response.transactionId !== transactionId ||
          response.version !== version
        ) {
          fail(new Error(response?.error || `host updater rejected ${op}`));
          return;
        }
        settled = true;
        socket.destroy();
        resolve(response);
      } catch (error) {
        fail(new Error(`host updater returned invalid JSON: ${error.message}`, { cause: error }));
      }
    });
    socket.once("timeout", () => fail(new Error(`host updater timed out during ${op}`)));
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) {
        fail(new Error(`host updater closed before ${op} completed`));
      }
    });
  });
}

function retryableConnectionError(error) {
  return (
    new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]).has(error?.code) ||
    /closed before|timed out/i.test(error?.message || "")
  );
}

async function requestWithRetry(op, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request(op);
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

async function ensureTargetController() {
  const first = await requestWithRetry("updateController", 120);
  if (first.controllerChanged !== true) {
    return;
  }
  const previousInstance = first.controllerInstanceId;
  if (!transactionPattern.test(previousInstance || "")) {
    throw new Error("root updater omitted its controller process identity");
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const current = await requestWithRetry("updateController");
      if (
        current.controllerChanged !== true &&
        transactionPattern.test(current.controllerInstanceId || "") &&
        current.controllerInstanceId !== previousInstance
      ) {
        return;
      }
    } catch {
      // systemd is replacing the verified root-controller process.
    }
  }
  throw new Error("verified root updater controller did not restart into the target release");
}

let activated = false;
try {
  if (mode === "--rollback-only") {
    const rolledBack = await requestWithRetry("rollbackRelease", 120);
    await clearTransactionId();
    process.stdout.write(`${JSON.stringify(rolledBack)}\n`);
  } else if (mode === "--commit-only") {
    activated = true;
    const committed = await requestWithRetry("commitRelease", 120);
    await clearTransactionId();
    process.stdout.write(`${JSON.stringify(committed)}\n`);
  } else {
    await ensureTargetController();
    const prepared = await requestWithRetry("prepareRelease", 120);
    if (mode === "--prepare-only") {
      process.stdout.write(`${JSON.stringify(prepared)}\n`);
    } else {
      const active = await requestWithRetry("activateRelease");
      activated = true;
      if (mode === "--activate-only") {
        process.stdout.write(`${JSON.stringify(active)}\n`);
      } else {
        const committed = await requestWithRetry("commitRelease");
        await clearTransactionId();
        process.stdout.write(`${JSON.stringify(committed)}\n`);
      }
    }
  }
} catch (error) {
  if (!activated) {
    try {
      await requestWithRetry("rollbackRelease");
      await clearTransactionId();
    } catch {
      // Keep the durable transaction ID so the next root repair can resume safely.
    }
  }
  throw error;
}
