import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireFileLock, withFileLock } from "../infra/file-lock.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";
import { serializeWalletState, writeWalletStateFileAtomically } from "./wallet-atomic-state.js";
import { ensureWalletStateDir } from "./wallet-runtime-config.js";

export type WalletSendExecutionState =
  | "reserved"
  | "approval_pending"
  | "executing"
  | "unknown"
  | "executed"
  | "failed";

export type WalletSendExecutionResult = {
  chain: "solana";
  txHash: string;
  signer?: string;
  metadata?: Record<string, unknown>;
};

export type WalletSendExecutionEntry = {
  executionIntentId: string;
  intentDigest: string;
  requestId: string;
  walletId: string;
  providerId: string;
  state: WalletSendExecutionState;
  approvalRequestId?: string;
  signature?: string;
  reason?: string;
  result?: WalletSendExecutionResult;
  createdAt: string;
  updatedAt: string;
};

type WalletSendExecutionFile = {
  version: 1;
  entries: WalletSendExecutionEntry[];
};

const STATES = new Set<WalletSendExecutionState>([
  "reserved",
  "approval_pending",
  "executing",
  "unknown",
  "executed",
  "failed",
]);

const TRANSITIONS: Record<WalletSendExecutionState, ReadonlySet<WalletSendExecutionState>> = {
  reserved: new Set(["reserved", "approval_pending", "executing", "unknown", "failed"]),
  approval_pending: new Set(["approval_pending", "executed", "unknown", "failed"]),
  executing: new Set(["executing", "unknown", "executed", "failed"]),
  unknown: new Set(["unknown", "executed", "failed"]),
  executed: new Set(["executed"]),
  failed: new Set(["failed"]),
};

const MUTATION_LOCK_OPTIONS = {
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

const MUTATION_QUEUES = resolveProcessScopedMap<Promise<void>>(
  Symbol.for("fased.wallet.sendExecution.mutationQueues"),
);
const ACTIVE_EXECUTIONS = resolveProcessScopedMap<true>(
  Symbol.for("fased.wallet.sendExecution.activeExecutions"),
);

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) {
      return true;
    }
  }
  return false;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("wallet send intent contains a non-finite number");
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
  throw new Error("wallet send intent contains an unsupported value");
}

export function walletSendIntentDigest(intent: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(intent)).digest("hex")}`;
}

export function walletSendRequestId(executionIntentId: string): string {
  const normalized = executionIntentId.trim();
  if (!normalized || normalized.length > 240 || containsControlCharacter(normalized)) {
    throw new Error("wallet send executionIntentId is invalid");
  }
  return `wallet-send-${createHash("sha256").update(normalized).digest("hex")}`;
}

function ledgerPath(env: NodeJS.ProcessEnv): string {
  return path.join(ensureWalletStateDir(env).rootDir, "wallet-send-executions.json");
}

function executionLockTarget(executionIntentId: string, env: NodeJS.ProcessEnv): string {
  return path.join(
    path.dirname(ledgerPath(env)),
    ".wallet-send-executions",
    createHash("sha256").update(executionIntentId).digest("hex"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateResult(value: unknown): WalletSendExecutionResult | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.chain !== "solana" ||
    typeof value.txHash !== "string" ||
    !value.txHash.trim() ||
    (value.signer !== undefined && typeof value.signer !== "string") ||
    (value.metadata !== undefined && !isRecord(value.metadata))
  ) {
    throw new Error("wallet send execution ledger contains an invalid result");
  }
  return value as WalletSendExecutionResult;
}

function validateEntry(value: unknown): WalletSendExecutionEntry {
  if (!isRecord(value)) {
    throw new Error("wallet send execution ledger contains an invalid entry");
  }
  if (
    typeof value.executionIntentId !== "string" ||
    !value.executionIntentId.trim() ||
    typeof value.intentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.intentDigest) ||
    typeof value.requestId !== "string" ||
    !value.requestId.trim() ||
    typeof value.walletId !== "string" ||
    !value.walletId.trim() ||
    typeof value.providerId !== "string" ||
    !value.providerId.trim() ||
    typeof value.state !== "string" ||
    !STATES.has(value.state as WalletSendExecutionState) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("wallet send execution ledger contains an invalid entry");
  }
  for (const field of ["approvalRequestId", "signature", "reason"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`wallet send execution ledger contains an invalid ${field}`);
    }
  }
  const expectedRequestId = walletSendRequestId(value.executionIntentId);
  if (value.requestId !== expectedRequestId) {
    throw new Error("wallet send execution ledger contains a mismatched request ID");
  }
  const result = validateResult(value.result);
  if (
    value.state === "executed" &&
    (!result || typeof value.signature !== "string" || value.signature !== result.txHash)
  ) {
    throw new Error("wallet send execution ledger contains an incomplete executed result");
  }
  return value as WalletSendExecutionEntry;
}

function loadLedger(env: NodeJS.ProcessEnv): WalletSendExecutionFile {
  const filePath = ledgerPath(env);
  if (!fs.existsSync(filePath)) {
    return { version: 1, entries: [] };
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as Partial<WalletSendExecutionFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error("unsupported shape");
    }
    const entries = parsed.entries.map(validateEntry);
    if (
      new Set(entries.map((entry) => entry.executionIntentId)).size !== entries.length ||
      new Set(entries.map((entry) => entry.requestId)).size !== entries.length
    ) {
      throw new Error("duplicate execution identity");
    }
    return { version: 1, entries };
  } catch (error) {
    throw new Error("wallet send execution ledger is unreadable; refusing to reset it", {
      cause: error,
    });
  }
}

function saveLedger(file: WalletSendExecutionFile, env: NodeJS.ProcessEnv): void {
  writeWalletStateFileAtomically(ledgerPath(env), serializeWalletState(file));
}

async function withMutationLock<T>(env: NodeJS.ProcessEnv, task: () => T | Promise<T>): Promise<T> {
  const filePath = ledgerPath(env);
  const previous = MUTATION_QUEUES.get(filePath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const turn = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const queued = previous.then(
    () => turn,
    () => turn,
  );
  MUTATION_QUEUES.set(filePath, queued);
  await previous.catch(() => undefined);
  try {
    return await withFileLock(filePath, MUTATION_LOCK_OPTIONS, async () => await task());
  } finally {
    releaseQueue();
    if (MUTATION_QUEUES.get(filePath) === queued) {
      MUTATION_QUEUES.delete(filePath);
    }
  }
}

export function getWalletSendExecution(params: {
  executionIntentId: string;
  env?: NodeJS.ProcessEnv;
}): WalletSendExecutionEntry | undefined {
  const executionIntentId = params.executionIntentId.trim();
  if (!executionIntentId) {
    return undefined;
  }
  return loadLedger(params.env ?? process.env).entries.find(
    (entry) => entry.executionIntentId === executionIntentId,
  );
}

export async function beginWalletSendExecution(params: {
  executionIntentId: string;
  intentDigest: string;
  walletId: string;
  providerId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ entry: WalletSendExecutionEntry; created: boolean }> {
  const env = params.env ?? process.env;
  const executionIntentId = params.executionIntentId.trim();
  const walletId = params.walletId.trim();
  const providerId = params.providerId.trim();
  const requestId = walletSendRequestId(executionIntentId);
  if (!walletId || !providerId || !/^sha256:[0-9a-f]{64}$/u.test(params.intentDigest)) {
    throw new Error("wallet send execution identity is incomplete");
  }
  return await withMutationLock(env, () => {
    const file = loadLedger(env);
    const existing = file.entries.find((entry) => entry.executionIntentId === executionIntentId);
    if (existing) {
      if (
        existing.intentDigest !== params.intentDigest ||
        existing.walletId !== walletId ||
        existing.providerId !== providerId ||
        existing.requestId !== requestId
      ) {
        throw new Error(
          "wallet send executionIntentId is already bound to a different immutable intent",
        );
      }
      return { entry: existing, created: false };
    }
    const now = new Date().toISOString();
    const entry: WalletSendExecutionEntry = {
      executionIntentId,
      intentDigest: params.intentDigest,
      requestId,
      walletId,
      providerId,
      state: "reserved",
      createdAt: now,
      updatedAt: now,
    };
    file.entries.push(entry);
    saveLedger(file, env);
    return { entry, created: true };
  });
}

export async function updateWalletSendExecution(params: {
  executionIntentId: string;
  expectedStates: WalletSendExecutionState[];
  state: WalletSendExecutionState;
  patch?: Partial<
    Pick<WalletSendExecutionEntry, "approvalRequestId" | "signature" | "reason" | "result">
  >;
  env?: NodeJS.ProcessEnv;
}): Promise<WalletSendExecutionEntry> {
  const env = params.env ?? process.env;
  return await withMutationLock(env, () => {
    const file = loadLedger(env);
    const entry = file.entries.find(
      (candidate) => candidate.executionIntentId === params.executionIntentId.trim(),
    );
    if (!entry) {
      throw new Error("wallet send execution entry not found");
    }
    if (!params.expectedStates.includes(entry.state)) {
      throw new Error(
        `wallet send execution is ${entry.state}; expected ${params.expectedStates.join(" or ")}`,
      );
    }
    if (!TRANSITIONS[entry.state].has(params.state)) {
      throw new Error(
        `wallet send execution cannot transition from ${entry.state} to ${params.state}`,
      );
    }
    Object.assign(entry, params.patch ?? {});
    entry.state = params.state;
    entry.updatedAt = new Date().toISOString();
    saveLedger(file, env);
    return entry;
  });
}

export async function claimWalletSendExecution(
  executionIntentIdRaw: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => Promise<void>> {
  const executionIntentId = executionIntentIdRaw.trim();
  walletSendRequestId(executionIntentId);
  const executionKey = `${ledgerPath(env)}\0${executionIntentId}`;
  if (ACTIVE_EXECUTIONS.has(executionKey)) {
    throw new Error("wallet send execution is already in progress");
  }
  ACTIVE_EXECUTIONS.set(executionKey, true);
  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    lock = await acquireFileLock(
      executionLockTarget(executionIntentId, env),
      EXECUTION_LOCK_OPTIONS,
    );
  } catch (error) {
    ACTIVE_EXECUTIONS.delete(executionKey);
    throw new Error("wallet send execution is already in progress", { cause: error });
  }
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    ACTIVE_EXECUTIONS.delete(executionKey);
    await lock.release();
  };
}
