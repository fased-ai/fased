import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { acquireFileLock, withFileLock } from "../infra/file-lock.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";
import {
  serializeWalletState,
  writeWalletStateFileAtomically,
} from "../wallet/wallet-atomic-state.js";
import type { A2aSettlementResult } from "./a2a-settlement.js";

export type DurableA2aTaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type DurableA2aTaskRecord = {
  version: 1;
  taskId: string;
  intentDigest: string;
  senderHandle: string;
  input: unknown;
  marketplacePayment?: unknown;
  status: DurableA2aTaskStatus;
  output?: unknown;
  error?: string;
  settlement?: A2aSettlementResult;
  createdAt: string;
  updatedAt: string;
};

const TASK_STATUSES = new Set<DurableA2aTaskStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
const LOCK_OPTIONS = {
  retries: {
    retries: 100,
    factor: 1.15,
    minTimeout: 10,
    maxTimeout: 200,
    randomize: true,
  },
  stale: 30_000,
} as const;
const EXECUTION_LOCK_OPTIONS = {
  retries: {
    retries: 1,
    factor: 1,
    minTimeout: 10,
    maxTimeout: 10,
    randomize: false,
  },
  stale: 30_000,
} as const;
const ACTIVE_EXECUTIONS = resolveProcessScopedMap<true>(
  Symbol.for("fased.gateway.a2aTask.activeExecutions"),
);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("A2A task intent contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("A2A task intent contains an unsupported value");
}

function taskDigest(taskId: string): string {
  return createHash("sha256").update(taskId).digest("hex");
}

function taskDirectory(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "federation", "a2a-tasks");
}

function taskPath(taskId: string, env: NodeJS.ProcessEnv): string {
  return path.join(taskDirectory(env), `${taskDigest(taskId)}.json`);
}

function executionLockTarget(taskId: string, env: NodeJS.ProcessEnv): string {
  return path.join(taskDirectory(env), ".executions", taskDigest(taskId));
}

export function a2aTaskIntentDigest(intent: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(intent)).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateRecord(value: unknown, expectedTaskId: string): DurableA2aTaskRecord {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.taskId !== expectedTaskId ||
    typeof value.intentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.intentDigest) ||
    typeof value.senderHandle !== "string" ||
    typeof value.status !== "string" ||
    !TASK_STATUSES.has(value.status as DurableA2aTaskStatus) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.error !== undefined && typeof value.error !== "string")
  ) {
    throw new Error("durable A2A task contains an invalid record");
  }
  return value as DurableA2aTaskRecord;
}

export function readDurableA2aTask(params: {
  taskId: string;
  env?: NodeJS.ProcessEnv;
}): DurableA2aTaskRecord | null {
  const taskId = params.taskId.trim();
  if (!taskId) {
    return null;
  }
  const filePath = taskPath(taskId, params.env ?? process.env);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return validateRecord(JSON.parse(fs.readFileSync(filePath, "utf8")), taskId);
  } catch (error) {
    throw new Error("durable A2A task is unreadable; refusing to replace it", { cause: error });
  }
}

function writeRecord(record: DurableA2aTaskRecord, env: NodeJS.ProcessEnv): void {
  fs.mkdirSync(taskDirectory(env), { recursive: true, mode: 0o700 });
  writeWalletStateFileAtomically(taskPath(record.taskId, env), serializeWalletState(record));
}

export async function reserveDurableA2aTask(params: {
  taskId: string;
  senderHandle: string;
  input: unknown;
  marketplacePayment?: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<{ record: DurableA2aTaskRecord; created: boolean }> {
  const env = params.env ?? process.env;
  const taskId = params.taskId.trim();
  if (!taskId || taskId.length > 240) {
    throw new Error("A2A taskId is invalid");
  }
  const intentDigest = a2aTaskIntentDigest({
    taskId,
    senderHandle: params.senderHandle.trim(),
    input: params.input,
    marketplacePayment: params.marketplacePayment,
  });
  fs.mkdirSync(taskDirectory(env), { recursive: true, mode: 0o700 });
  return await withFileLock(taskPath(taskId, env), LOCK_OPTIONS, async () => {
    const existing = readDurableA2aTask({ taskId, env });
    if (existing) {
      if (existing.intentDigest !== intentDigest) {
        throw new Error("A2A taskId is already bound to a different immutable task intent");
      }
      return { record: existing, created: false };
    }
    const now = new Date().toISOString();
    const record: DurableA2aTaskRecord = {
      version: 1,
      taskId,
      intentDigest,
      senderHandle: params.senderHandle.trim(),
      input: params.input,
      ...(params.marketplacePayment !== undefined
        ? { marketplacePayment: params.marketplacePayment }
        : {}),
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    writeRecord(record, env);
    return { record, created: true };
  });
}

export async function updateDurableA2aTask(params: {
  taskId: string;
  expectedStatuses?: DurableA2aTaskStatus[];
  status?: DurableA2aTaskStatus;
  output?: unknown;
  error?: string;
  settlement?: A2aSettlementResult;
  env?: NodeJS.ProcessEnv;
}): Promise<DurableA2aTaskRecord> {
  const env = params.env ?? process.env;
  const taskId = params.taskId.trim();
  return await withFileLock(taskPath(taskId, env), LOCK_OPTIONS, async () => {
    const record = readDurableA2aTask({ taskId, env });
    if (!record) {
      throw new Error("durable A2A task does not exist");
    }
    if (params.expectedStatuses && !params.expectedStatuses.includes(record.status)) {
      throw new Error(
        `durable A2A task is ${record.status}; expected ${params.expectedStatuses.join(" or ")}`,
      );
    }
    if (params.status) {
      record.status = params.status;
    }
    if (params.output !== undefined) {
      record.output = params.output;
    }
    if (params.error !== undefined) {
      record.error = params.error;
    }
    if (params.settlement !== undefined) {
      record.settlement = params.settlement;
    }
    record.updatedAt = new Date().toISOString();
    writeRecord(record, env);
    return record;
  });
}

export async function claimDurableA2aTaskExecution(params: {
  taskId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<(() => Promise<void>) | null> {
  const env = params.env ?? process.env;
  const taskId = params.taskId.trim();
  const key = `${taskDirectory(env)}\0${taskId}`;
  if (ACTIVE_EXECUTIONS.has(key)) {
    return null;
  }
  ACTIVE_EXECUTIONS.set(key, true);
  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    lock = await acquireFileLock(executionLockTarget(taskId, env), EXECUTION_LOCK_OPTIONS);
  } catch {
    ACTIVE_EXECUTIONS.delete(key);
    return null;
  }
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    ACTIVE_EXECUTIONS.delete(key);
    await lock.release();
  };
}
