import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export const TASK_LEDGER_QUIESCE_SCHEMA = 1;
export const TASK_LEDGER_QUIESCE_CAPABILITY_FILE = ".task-ledger-quiesce-capability-v1.json";
export const TASK_LEDGER_QUIESCE_REQUEST_FILE = ".task-ledger-quiesce-request-v1.json";
export const TASK_LEDGER_QUIESCE_ACK_FILE = ".task-ledger-quiesce-ack-v1.json";

type QuiesceEnvelope = {
  schema: number;
  transactionId: string;
  nonce: string;
};

function tasksDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "tasks");
}

function canonicalJson(value: object): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function safeRead(pathname: string): Buffer | undefined {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o007) !== 0 ||
    (before.mode & 0o111) !== 0 ||
    before.size > 4096
  ) {
    throw new Error("Task-ledger quiesce file is unsafe");
  }
  const data = fs.readFileSync(pathname);
  const after = fs.lstatSync(pathname);
  if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size) {
    throw new Error("Task-ledger quiesce file changed while reading");
  }
  return data;
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeAtomicNew(pathname: string, data: Buffer): void {
  const directory = path.dirname(pathname);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (safeRead(pathname) !== undefined) {
    throw new Error("Task-ledger quiesce file collision");
  }
  const temporary = path.join(
    directory,
    `.${path.basename(pathname)}.${process.pid}.${Date.now()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // link(2) publishes only when the destination does not exist. Unlike a
    // rename after a pre-check, it cannot replace an ACK or marker another
    // writer created in the small publication window.
    fs.linkSync(temporary, pathname);
    fs.unlinkSync(temporary);
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    fs.rmSync(temporary, { force: true });
  }
}

function parseRequest(data: Buffer): QuiesceEnvelope {
  let request: QuiesceEnvelope;
  try {
    request = JSON.parse(data.toString("utf8")) as QuiesceEnvelope;
  } catch (error) {
    throw new Error("Task-ledger quiesce request is invalid", { cause: error });
  }
  if (
    request.schema !== TASK_LEDGER_QUIESCE_SCHEMA ||
    typeof request.transactionId !== "string" ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(request.transactionId) ||
    typeof request.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.nonce) ||
    !data.equals(canonicalJson(request))
  ) {
    throw new Error("Task-ledger quiesce request is not canonical");
  }
  return request;
}

/** Write the persistent version-neutral capability marker before Gateway is ready. */
export function ensureTaskLedgerQuiesceCapability(env: NodeJS.ProcessEnv = process.env): void {
  const pathname = path.join(tasksDirectory(env), TASK_LEDGER_QUIESCE_CAPABILITY_FILE);
  const marker = canonicalJson({
    schema: TASK_LEDGER_QUIESCE_SCHEMA,
    capability: "task-ledger-quiesce-v1",
  });
  const existing = safeRead(pathname);
  if (existing === undefined) {
    writeAtomicNew(pathname, marker);
    return;
  }
  if (!existing.equals(marker)) {
    throw new Error("Task-ledger quiesce capability collision");
  }
}

/** Acknowledge only an exact, transaction-bound request after ledger closure. */
export function acknowledgeTaskLedgerQuiesceRequest(env: NodeJS.ProcessEnv = process.env): boolean {
  const directory = tasksDirectory(env);
  const request = safeRead(path.join(directory, TASK_LEDGER_QUIESCE_REQUEST_FILE));
  if (request === undefined) {
    return false;
  }
  const parsed = parseRequest(request);
  writeAtomicNew(path.join(directory, TASK_LEDGER_QUIESCE_ACK_FILE), canonicalJson(parsed));
  return true;
}
