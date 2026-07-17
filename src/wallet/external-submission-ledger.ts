import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireFileLock, withFileLock } from "../infra/file-lock.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";
import { ensureWalletStateDir } from "./wallet-runtime-config.js";

export type ExternalSubmissionKind =
  | "jupiter-swap"
  | "jupiter-trigger-auth"
  | "jupiter-trigger-create"
  | "jupiter-trigger-cancel";

export type ExternalSubmissionState =
  | "reserved"
  | "prepared"
  | "signed"
  | "submitting"
  | "unknown"
  | "confirmed"
  | "failed";

export type ExternalSubmissionEntry = {
  key: string;
  kind: ExternalSubmissionKind;
  walletId: string;
  intentDigest: string;
  explicitIntentId?: string;
  state: ExternalSubmissionState;
  signerRequestId?: string;
  signerIntentDigest?: string;
  signerSignature?: string;
  externalRequestId?: string;
  transactionDigest?: string;
  reason?: string;
  details?: Record<string, unknown>;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type ExternalSubmissionFile = {
  version: 1;
  entries: ExternalSubmissionEntry[];
};

const STATES = new Set<ExternalSubmissionState>([
  "reserved",
  "prepared",
  "signed",
  "submitting",
  "unknown",
  "confirmed",
  "failed",
]);

const KINDS = new Set<ExternalSubmissionKind>([
  "jupiter-swap",
  "jupiter-trigger-auth",
  "jupiter-trigger-create",
  "jupiter-trigger-cancel",
]);

const TRANSITIONS: Record<ExternalSubmissionState, ReadonlySet<ExternalSubmissionState>> = {
  reserved: new Set(["reserved", "prepared", "submitting", "failed"]),
  prepared: new Set(["prepared", "signed", "unknown", "confirmed", "failed"]),
  signed: new Set(["signed", "submitting", "unknown"]),
  submitting: new Set(["submitting", "prepared", "unknown", "confirmed", "failed"]),
  unknown: new Set(["unknown", "confirmed", "failed"]),
  confirmed: new Set(["confirmed"]),
  failed: new Set(["failed"]),
};

const LEDGER_LOCK_OPTIONS = {
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
    // The second attempt lets acquireFileLock remove a dead owner's stale
    // lock and claim it. A live owner is never evicted, regardless of age.
    retries: 1,
    factor: 1,
    minTimeout: 10,
    maxTimeout: 10,
    randomize: false,
  },
  stale: 30_000,
} as const;

const ACTIVE_EXECUTIONS = resolveProcessScopedMap<true>(
  Symbol.for("fased.wallet.externalSubmission.activeExecutions"),
);
const LEDGER_MUTATION_QUEUES = resolveProcessScopedMap<Promise<void>>(
  Symbol.for("fased.wallet.externalSubmission.mutationQueues"),
);

export async function claimExternalSubmissionExecution(
  keyRaw: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => Promise<void>> {
  const key = keyRaw.trim();
  if (!key || containsControlCharacter(key)) {
    throw new Error("external submission execution key is invalid");
  }
  const executionKey = `${ledgerPath(env)}\0${key}`;
  if (ACTIVE_EXECUTIONS.has(executionKey)) {
    throw new Error(
      `external submission ${key} is already executing; wait for its durable result instead of retrying`,
    );
  }
  ACTIVE_EXECUTIONS.set(executionKey, true);
  const claimTarget = path.join(
    path.dirname(ledgerPath(env)),
    ".external-submission-executions",
    createHash("sha256").update(key).digest("hex"),
  );
  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    lock = await acquireFileLock(claimTarget, EXECUTION_LOCK_OPTIONS);
  } catch (error) {
    ACTIVE_EXECUTIONS.delete(executionKey);
    throw new Error(
      `external submission ${key} is already executing; wait for its durable result instead of retrying`,
      { cause: error },
    );
  }
  let released = false;
  return async () => {
    if (!released) {
      ACTIVE_EXECUTIONS.delete(executionKey);
      released = true;
      await lock.release();
    }
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("external submission intent contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("external submission intent contains an unsupported value");
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) {
      return true;
    }
  }
  return false;
}

export function externalSubmissionIntentDigest(intent: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(intent)).digest("hex")}`;
}

export function createExternalSubmissionKey(params: {
  kind: ExternalSubmissionKind;
  walletId: string;
  intent: unknown;
  explicitIntentId?: string;
}): { key: string; intentDigest: string; explicitIntentId?: string } {
  const walletId = params.walletId.trim();
  if (!walletId) {
    throw new Error("external submission walletId is required");
  }
  const explicitIntentId = params.explicitIntentId?.trim() || undefined;
  if (
    explicitIntentId &&
    (explicitIntentId.length > 160 || containsControlCharacter(explicitIntentId))
  ) {
    throw new Error("external submission intentId is invalid");
  }
  const intentDigest = externalSubmissionIntentDigest(params.intent);
  const keyDigest = createHash("sha256")
    .update(`${params.kind}\0${walletId}\0${intentDigest}\0${explicitIntentId ?? "default"}`)
    .digest("hex");
  return {
    key: `${params.kind}:${keyDigest}`,
    intentDigest,
    ...(explicitIntentId ? { explicitIntentId } : {}),
  };
}

function ledgerPath(env: NodeJS.ProcessEnv): string {
  return path.join(ensureWalletStateDir(env).rootDir, "external-submissions.json");
}

async function withLedgerMutationLock<T>(
  env: NodeJS.ProcessEnv,
  task: () => T | Promise<T>,
): Promise<T> {
  const filePath = ledgerPath(env);
  const previous = LEDGER_MUTATION_QUEUES.get(filePath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const turn = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const queued = previous.then(
    () => turn,
    () => turn,
  );
  LEDGER_MUTATION_QUEUES.set(filePath, queued);
  await previous.catch(() => undefined);
  try {
    return await withFileLock(filePath, LEDGER_LOCK_OPTIONS, async () => await task());
  } finally {
    releaseQueue();
    if (LEDGER_MUTATION_QUEUES.get(filePath) === queued) {
      LEDGER_MUTATION_QUEUES.delete(filePath);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateEntry(value: unknown): ExternalSubmissionEntry {
  if (!isRecord(value)) {
    throw new Error("external submission ledger contains an invalid entry");
  }
  const state = value.state;
  if (
    typeof value.key !== "string" ||
    typeof value.kind !== "string" ||
    !KINDS.has(value.kind as ExternalSubmissionKind) ||
    typeof value.walletId !== "string" ||
    typeof value.intentDigest !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof state !== "string" ||
    !STATES.has(state as ExternalSubmissionState)
  ) {
    throw new Error("external submission ledger contains an invalid entry");
  }
  if (!value.intentDigest.match(/^sha256:[0-9a-f]{64}$/)) {
    throw new Error("external submission ledger contains an invalid intent digest");
  }
  for (const field of [
    "explicitIntentId",
    "signerRequestId",
    "signerIntentDigest",
    "signerSignature",
    "externalRequestId",
    "transactionDigest",
    "reason",
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`external submission ledger contains an invalid ${field}`);
    }
  }
  if (value.details !== undefined && !isRecord(value.details)) {
    throw new Error("external submission ledger contains invalid details");
  }
  if (value.result !== undefined && !isRecord(value.result)) {
    throw new Error("external submission ledger contains an invalid result");
  }
  return value as ExternalSubmissionEntry;
}

function loadLedger(env: NodeJS.ProcessEnv): ExternalSubmissionFile {
  const filePath = ledgerPath(env);
  if (!fs.existsSync(filePath)) {
    return { version: 1, entries: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      "external submission ledger is unreadable; refusing a potentially duplicate transaction",
      {
        cause: error,
      },
    );
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error("external submission ledger has an unsupported format");
  }
  const entries = parsed.entries.map(validateEntry);
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
    throw new Error("external submission ledger contains duplicate idempotency keys");
  }
  return { version: 1, entries };
}

function saveLedger(file: ExternalSubmissionFile, env: NodeJS.ProcessEnv): void {
  const filePath = ledgerPath(env);
  const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
    try {
      const directory = fs.openSync(path.dirname(filePath), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
        throw error;
      }
      // A small set of platforms/filesystems explicitly do not support directory fsync.
    }
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The atomic rename already consumed the temporary file in the normal path.
    }
  }
}

export function getExternalSubmission(params: {
  key: string;
  env?: NodeJS.ProcessEnv;
}): ExternalSubmissionEntry | undefined {
  const file = loadLedger(params.env ?? process.env);
  return file.entries.find((entry) => entry.key === params.key.trim());
}

export function getExternalSubmissionByExplicitIntent(params: {
  kind: ExternalSubmissionKind;
  walletId: string;
  explicitIntentId: string;
  env?: NodeJS.ProcessEnv;
}): ExternalSubmissionEntry | undefined {
  const kind = params.kind;
  const walletId = params.walletId.trim();
  const explicitIntentId = params.explicitIntentId.trim();
  if (!walletId || !explicitIntentId || containsControlCharacter(explicitIntentId)) {
    throw new Error("external submission explicit intent lookup is invalid");
  }
  const file = loadLedger(params.env ?? process.env);
  return file.entries.find(
    (entry) =>
      entry.kind === kind &&
      entry.walletId === walletId &&
      entry.explicitIntentId === explicitIntentId,
  );
}

export async function beginExternalSubmission(params: {
  key: string;
  kind: ExternalSubmissionKind;
  walletId: string;
  intentDigest: string;
  explicitIntentId?: string;
  details?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): Promise<{ entry: ExternalSubmissionEntry; created: boolean }> {
  const env = params.env ?? process.env;
  return await withLedgerMutationLock(env, () => {
    const file = loadLedger(env);
    const key = params.key.trim();
    const walletId = params.walletId.trim();
    const existing = file.entries.find((entry) => entry.key === key);
    if (existing) {
      if (
        existing.kind !== params.kind ||
        existing.walletId !== walletId ||
        existing.intentDigest !== params.intentDigest ||
        (existing.explicitIntentId ?? undefined) !== (params.explicitIntentId?.trim() || undefined)
      ) {
        throw new Error("external submission idempotency key collides with a different intent");
      }
      return { entry: existing, created: false };
    }
    const explicitIntentId = params.explicitIntentId?.trim() || undefined;
    const conflictingExplicitIntent = explicitIntentId
      ? file.entries.find(
          (entry) =>
            entry.kind === params.kind &&
            entry.walletId === walletId &&
            entry.explicitIntentId === explicitIntentId,
        )
      : undefined;
    if (conflictingExplicitIntent) {
      throw new Error(
        "external submission intentId is already bound to a different immutable intent",
      );
    }
    const now = new Date().toISOString();
    const entry: ExternalSubmissionEntry = {
      key,
      kind: params.kind,
      walletId,
      intentDigest: params.intentDigest,
      ...(explicitIntentId ? { explicitIntentId } : {}),
      state: "reserved",
      ...(params.details ? { details: params.details } : {}),
      createdAt: now,
      updatedAt: now,
    };
    file.entries.push(entry);
    saveLedger(file, env);
    return { entry, created: true };
  });
}

export async function updateExternalSubmission(params: {
  key: string;
  expectedStates: ExternalSubmissionState[];
  state: ExternalSubmissionState;
  patch?: Partial<
    Pick<
      ExternalSubmissionEntry,
      | "signerRequestId"
      | "signerIntentDigest"
      | "signerSignature"
      | "externalRequestId"
      | "transactionDigest"
      | "reason"
      | "details"
      | "result"
    >
  >;
  env?: NodeJS.ProcessEnv;
}): Promise<ExternalSubmissionEntry> {
  const env = params.env ?? process.env;
  return await withLedgerMutationLock(env, () => {
    const file = loadLedger(env);
    const entry = file.entries.find((candidate) => candidate.key === params.key.trim());
    if (!entry) {
      throw new Error("external submission ledger entry not found");
    }
    if (!params.expectedStates.includes(entry.state)) {
      throw new Error(
        `external submission ${entry.key} is ${entry.state}; expected ${params.expectedStates.join(" or ")}`,
      );
    }
    if (!TRANSITIONS[entry.state].has(params.state)) {
      throw new Error(
        `external submission cannot transition from ${entry.state} to ${params.state}`,
      );
    }
    Object.assign(entry, params.patch ?? {});
    entry.state = params.state;
    entry.updatedAt = new Date().toISOString();
    saveLedger(file, env);
    return entry;
  });
}

export async function renewConfirmedExternalSubmission(params: {
  key: string;
  details?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): Promise<ExternalSubmissionEntry> {
  const env = params.env ?? process.env;
  return await withLedgerMutationLock(env, () => {
    const file = loadLedger(env);
    const entry = file.entries.find((candidate) => candidate.key === params.key.trim());
    if (!entry || entry.state !== "confirmed") {
      throw new Error("only a confirmed external submission can be renewed");
    }
    const now = new Date().toISOString();
    const renewed: ExternalSubmissionEntry = {
      key: entry.key,
      kind: entry.kind,
      walletId: entry.walletId,
      intentDigest: entry.intentDigest,
      ...(entry.explicitIntentId ? { explicitIntentId: entry.explicitIntentId } : {}),
      state: "reserved",
      ...(params.details ? { details: params.details } : {}),
      createdAt: now,
      updatedAt: now,
    };
    file.entries[file.entries.indexOf(entry)] = renewed;
    saveLedger(file, env);
    return renewed;
  });
}
