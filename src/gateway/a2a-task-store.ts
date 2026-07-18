import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
import { emitDurableCapacityWarning } from "./durable-capacity.js";

export type DurableA2aTaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type DurableA2aPaymentRecovery = {
  status: "refund-required" | "refunded" | "disputed";
  paymentTxRef: string;
  reason: string;
  updatedAt: string;
  refundTxRef?: string;
  approvalRequestId?: string;
};

export type DurableA2aPaymentChallenge = {
  version: 1;
  challengeId: string;
  taskId: string;
  senderHandle: string;
  offerId: string;
  invoiceId: string;
  receiptId: string;
  payerAddress: string;
  payeeAddress: string;
  amount: number;
  currency: string;
  asset: { kind: "native" | "spl-token"; address?: string };
  paymentMemo: string;
  status: "issued" | "claimed";
  issuedAt: string;
  expiresAt: string;
  txRefDigest?: string;
  claimedAt?: string;
};

export type DurableA2aTaskRecord = {
  version: 2;
  taskId: string;
  intentDigest: string;
  accessTokenHash: string;
  senderHandle: string;
  input: unknown;
  marketplacePayment?: unknown;
  status: DurableA2aTaskStatus;
  output?: unknown;
  error?: string;
  settlement?: A2aSettlementResult;
  paymentRecovery?: DurableA2aPaymentRecovery;
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
const MAX_TASKS_PER_SENDER_PER_HOUR = 60;
const MAX_ACTIVE_TASKS_PER_SENDER = 8;
const MAX_RETAINED_TASKS = 5_000;
const MAX_TASK_FILES_ON_DISK = 10_000;
const MAX_PAYMENT_CHALLENGE_FILES = 10_000;
const MAX_PAYMENT_CLAIM_FILES = 100_000;
const TERMINAL_TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const PAYMENT_CHALLENGE_TTL_MS = 10 * 60_000;

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

function senderQuotaLockPath(senderHandle: string, env: NodeJS.ProcessEnv): string {
  const digest = createHash("sha256").update(senderHandle, "utf8").digest("hex");
  return path.join(taskDirectory(env), ".sender-quotas", digest);
}

function taskCapacityLockPath(env: NodeJS.ProcessEnv): string {
  return path.join(taskDirectory(env), ".capacity");
}

function executionLockTarget(taskId: string, env: NodeJS.ProcessEnv): string {
  return path.join(taskDirectory(env), ".executions", taskDigest(taskId));
}

function paymentClaimPath(txRef: string, env: NodeJS.ProcessEnv): string {
  const digest = createHash("sha256").update(txRef, "utf8").digest("hex");
  return path.join(taskDirectory(env), ".payment-claims", `${digest}.json`);
}

function paymentChallengeDirectory(env: NodeJS.ProcessEnv): string {
  return path.join(taskDirectory(env), ".payment-challenges");
}

function paymentChallengePath(taskId: string, env: NodeJS.ProcessEnv): string {
  return path.join(paymentChallengeDirectory(env), `${taskDigest(taskId)}.json`);
}

function paymentChallengeClaimLockPath(env: NodeJS.ProcessEnv): string {
  return path.join(paymentChallengeDirectory(env), ".claims");
}

function paymentClaimDirectory(env: NodeJS.ProcessEnv): string {
  return path.join(taskDirectory(env), ".payment-claims");
}

function paymentReferenceClaimLockPath(env: NodeJS.ProcessEnv): string {
  return path.join(paymentClaimDirectory(env), ".claims");
}

function listJsonLedgerFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
}

function requireJsonLedgerCapacity(directory: string, maximum: number, label: string): void {
  const used = listJsonLedgerFiles(directory).length;
  emitDurableCapacityWarning(label, used, maximum);
  if (used >= maximum) {
    throw new Error(`${label} reached its safe on-disk record limit`);
  }
}

function pruneExpiredPaymentChallenges(env: NodeJS.ProcessEnv, nowMs: number): void {
  const directory = paymentChallengeDirectory(env);
  for (const name of listJsonLedgerFiles(directory)) {
    const filePath = path.join(directory, name);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!isRecord(raw) || typeof raw.taskId !== "string") {
        continue;
      }
      const challenge = validatePaymentChallenge(raw, raw.taskId);
      const expiredUnclaimed =
        challenge.status === "issued" && Date.parse(challenge.expiresAt) < nowMs;
      const claimedAt = challenge.claimedAt ? Date.parse(challenge.claimedAt) : Number.NaN;
      const orphanedClaim =
        challenge.status === "claimed" &&
        !fs.existsSync(taskPath(challenge.taskId, env)) &&
        Number.isFinite(claimedAt) &&
        nowMs - claimedAt > TERMINAL_TASK_RETENTION_MS;
      if (expiredUnclaimed || orphanedClaim) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Corrupt evidence remains in place and consumes capacity. Direct reads fail closed.
    }
  }
}

export function a2aTaskIntentDigest(intent: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(intent)).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidPaymentRecovery(value: unknown): value is DurableA2aPaymentRecovery {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.status === "refund-required" ||
      value.status === "refunded" ||
      value.status === "disputed") &&
    typeof value.paymentTxRef === "string" &&
    value.paymentTxRef.length > 0 &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    typeof value.updatedAt === "string" &&
    (value.refundTxRef === undefined ||
      (typeof value.refundTxRef === "string" && value.refundTxRef.length > 0)) &&
    (value.approvalRequestId === undefined ||
      (typeof value.approvalRequestId === "string" && value.approvalRequestId.length > 0))
  );
}

function validatePaymentChallenge(
  value: unknown,
  expectedTaskId: string,
): DurableA2aPaymentChallenge {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.taskId !== expectedTaskId ||
    typeof value.challengeId !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.challengeId) ||
    typeof value.senderHandle !== "string" ||
    !value.senderHandle.trim() ||
    typeof value.offerId !== "string" ||
    !value.offerId.trim() ||
    typeof value.invoiceId !== "string" ||
    !value.invoiceId.trim() ||
    typeof value.receiptId !== "string" ||
    !value.receiptId.trim() ||
    typeof value.payerAddress !== "string" ||
    !value.payerAddress.trim() ||
    typeof value.payeeAddress !== "string" ||
    !value.payeeAddress.trim() ||
    typeof value.amount !== "number" ||
    !Number.isSafeInteger(value.amount) ||
    value.amount <= 0 ||
    typeof value.currency !== "string" ||
    !value.currency.trim() ||
    !isRecord(value.asset) ||
    (value.asset.kind !== "native" && value.asset.kind !== "spl-token") ||
    (value.asset.address !== undefined && typeof value.asset.address !== "string") ||
    typeof value.paymentMemo !== "string" ||
    !/^fased:a2a-payment:v1:[0-9a-f]{64}$/u.test(value.paymentMemo) ||
    (value.status !== "issued" && value.status !== "claimed") ||
    typeof value.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(value.issuedAt)) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    (value.txRefDigest !== undefined &&
      (typeof value.txRefDigest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(value.txRefDigest))) ||
    (value.claimedAt !== undefined &&
      (typeof value.claimedAt !== "string" || !Number.isFinite(Date.parse(value.claimedAt))))
  ) {
    throw new Error("durable A2A payment challenge contains an invalid record");
  }
  return value as DurableA2aPaymentChallenge;
}

function validateRecord(value: unknown, expectedTaskId: string): DurableA2aTaskRecord {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.taskId !== expectedTaskId ||
    typeof value.intentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.intentDigest) ||
    typeof value.accessTokenHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.accessTokenHash) ||
    typeof value.senderHandle !== "string" ||
    typeof value.status !== "string" ||
    !TASK_STATUSES.has(value.status as DurableA2aTaskStatus) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.error !== undefined && typeof value.error !== "string") ||
    (value.paymentRecovery !== undefined && !isValidPaymentRecovery(value.paymentRecovery))
  ) {
    throw new Error("durable A2A task contains an invalid record");
  }
  return value as DurableA2aTaskRecord;
}

function hashAccessToken(value: string): string {
  return createHash("sha256").update(`fased:a2a-task-access:v1:${value}`, "utf8").digest("hex");
}

function tokensMatch(expectedHash: string, token: string): boolean {
  const actual = Buffer.from(hashAccessToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeNewAccessToken(value: string | undefined): string | null {
  const token = value?.trim() ?? "";
  if (!token) {
    return null;
  }
  if (token.length < 43 || token.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw new Error("caller-provided A2A task access token must be a strong base64url secret");
  }
  return token;
}

function listDurableRecords(env: NodeJS.ProcessEnv): DurableA2aTaskRecord[] {
  const dir = taskDirectory(env);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const records: DurableA2aTaskRecord[] = [];
  const taskFiles = fs.readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  if (taskFiles.length > MAX_TASK_FILES_ON_DISK) {
    throw new Error("A2A task store exceeds its safe on-disk record limit");
  }
  for (const name of taskFiles) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as unknown;
      if (
        raw &&
        typeof raw === "object" &&
        typeof (raw as { taskId?: unknown }).taskId === "string"
      ) {
        records.push(validateRecord(raw, (raw as { taskId: string }).taskId));
      }
    } catch {
      // Corrupt records remain in place and are ignored by quota pruning. Direct access fails closed.
    }
  }
  return records;
}

function enforceSenderQuota(params: { senderHandle: string; env: NodeJS.ProcessEnv }): void {
  const now = Date.now();
  const senderRecords = listDurableRecords(params.env).filter(
    (record) => record.senderHandle === params.senderHandle,
  );
  const recent = senderRecords.filter((record) => now - Date.parse(record.createdAt) < 60 * 60_000);
  if (recent.length >= MAX_TASKS_PER_SENDER_PER_HOUR) {
    throw new Error("A2A sender hourly task quota exceeded");
  }
  const active = senderRecords.filter(
    (record) => record.status === "queued" || record.status === "running",
  );
  if (active.length >= MAX_ACTIVE_TASKS_PER_SENDER) {
    throw new Error("A2A sender active task quota exceeded");
  }
}

function pruneDurableTasks(env: NodeJS.ProcessEnv): void {
  const now = Date.now();
  const terminal = listDurableRecords(env)
    .filter(
      (record) =>
        (record.status === "succeeded" ||
          record.status === "failed" ||
          record.status === "canceled") &&
        record.paymentRecovery?.status !== "refund-required",
    )
    .toSorted((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
  const remove = terminal.filter(
    (record, index) =>
      now - Date.parse(record.updatedAt) > TERMINAL_TASK_RETENTION_MS ||
      terminal.length - index > MAX_RETAINED_TASKS,
  );
  for (const record of remove) {
    try {
      fs.unlinkSync(taskPath(record.taskId, env));
    } catch {
      // Retention cleanup is best effort; task authorization remains fail closed.
    }
  }
}

export function readDurableA2aPaymentChallenge(params: {
  taskId: string;
  env?: NodeJS.ProcessEnv;
}): DurableA2aPaymentChallenge | null {
  const env = params.env ?? process.env;
  const taskId = params.taskId.trim();
  if (!taskId) {
    return null;
  }
  const filePath = paymentChallengePath(taskId, env);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return validatePaymentChallenge(JSON.parse(fs.readFileSync(filePath, "utf8")), taskId);
  } catch (error) {
    throw new Error("durable A2A payment challenge is unreadable", { cause: error });
  }
}

export async function issueDurableA2aPaymentChallenge(params: {
  taskId: string;
  senderHandle: string;
  offerId: string;
  payerAddress: string;
  payeeAddress: string;
  amount: number;
  currency: string;
  asset: { kind: "native" | "spl-token"; address?: string };
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<DurableA2aPaymentChallenge> {
  const env = params.env ?? process.env;
  const taskId = params.taskId.trim();
  const senderHandle = params.senderHandle.trim().toLowerCase();
  if (!taskId || taskId.length > 240 || !senderHandle || !params.offerId.trim()) {
    throw new Error("A2A payment challenge identity is invalid");
  }
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
    throw new Error("A2A payment challenge amount is invalid");
  }
  const filePath = paymentChallengePath(taskId, env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  return await withFileLock(paymentChallengeClaimLockPath(env), LOCK_OPTIONS, async () => {
    return await withFileLock(filePath, LOCK_OPTIONS, async () => {
      const existing = readDurableA2aPaymentChallenge({ taskId, env });
      const nowMs = params.nowMs ?? Date.now();
      if (existing && Date.parse(existing.expiresAt) >= nowMs) {
        if (
          existing.senderHandle !== senderHandle ||
          existing.offerId !== params.offerId.trim() ||
          existing.payerAddress !== params.payerAddress.trim() ||
          existing.payeeAddress !== params.payeeAddress.trim() ||
          existing.amount !== params.amount ||
          existing.currency !== params.currency.trim().toUpperCase() ||
          canonicalJson(existing.asset) !== canonicalJson(params.asset)
        ) {
          throw new Error("A2A taskId is already bound to different payment terms");
        }
        return existing;
      }
      if (existing?.status === "claimed") {
        throw new Error("claimed A2A payment challenge cannot be replaced");
      }
      pruneExpiredPaymentChallenges(env, nowMs);
      if (!existing) {
        requireJsonLedgerCapacity(
          paymentChallengeDirectory(env),
          MAX_PAYMENT_CHALLENGE_FILES,
          "A2A payment challenge store",
        );
      }
      const challengeId = randomBytes(32).toString("hex");
      const issuedAt = new Date(nowMs).toISOString();
      const record: DurableA2aPaymentChallenge = {
        version: 1,
        challengeId,
        taskId,
        senderHandle,
        offerId: params.offerId.trim(),
        invoiceId: `invoice-${challengeId.slice(0, 32)}`,
        receiptId: `receipt-${challengeId.slice(32)}`,
        payerAddress: params.payerAddress.trim(),
        payeeAddress: params.payeeAddress.trim(),
        amount: params.amount,
        currency: params.currency.trim().toUpperCase(),
        asset: params.asset,
        paymentMemo: `fased:a2a-payment:v1:${challengeId}`,
        status: "issued",
        issuedAt,
        expiresAt: new Date(nowMs + PAYMENT_CHALLENGE_TTL_MS).toISOString(),
      };
      writeWalletStateFileAtomically(filePath, serializeWalletState(record));
      return record;
    });
  });
}

export async function claimDurableA2aPaymentChallenge(params: {
  taskId: string;
  challengeId: string;
  senderHandle: string;
  payerAddress: string;
  txRef: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DurableA2aPaymentChallenge> {
  const env = params.env ?? process.env;
  const taskId = params.taskId.trim();
  const txRefDigest = `sha256:${createHash("sha256").update(params.txRef.trim(), "utf8").digest("hex")}`;
  return await withFileLock(paymentChallengeClaimLockPath(env), LOCK_OPTIONS, async () => {
    const challenge = readDurableA2aPaymentChallenge({ taskId, env });
    if (
      !challenge ||
      challenge.challengeId !== params.challengeId.trim() ||
      challenge.senderHandle !== params.senderHandle.trim().toLowerCase() ||
      challenge.payerAddress !== params.payerAddress.trim()
    ) {
      throw new Error("A2A payment challenge identity does not match the verified settlement");
    }
    const challengeFiles = fs.existsSync(paymentChallengeDirectory(env))
      ? fs
          .readdirSync(paymentChallengeDirectory(env))
          .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      : [];
    for (const name of challengeFiles) {
      const raw = JSON.parse(
        fs.readFileSync(path.join(paymentChallengeDirectory(env), name), "utf8"),
      ) as unknown;
      if (isRecord(raw) && raw.txRefDigest === txRefDigest && raw.taskId !== taskId) {
        throw new Error("payment transaction was already claimed by a different A2A task");
      }
    }
    if (challenge.status === "claimed") {
      if (challenge.txRefDigest !== txRefDigest) {
        throw new Error("A2A payment challenge was already claimed by a different transaction");
      }
      return challenge;
    }
    const claimed: DurableA2aPaymentChallenge = {
      ...challenge,
      status: "claimed",
      txRefDigest,
      claimedAt: new Date().toISOString(),
    };
    writeWalletStateFileAtomically(
      paymentChallengePath(taskId, env),
      serializeWalletState(claimed),
    );
    return claimed;
  });
}

export function authorizeDurableA2aTask(params: {
  taskId: string;
  accessToken: string;
  env?: NodeJS.ProcessEnv;
}): DurableA2aTaskRecord | null {
  const record = readDurableA2aTask({ taskId: params.taskId, env: params.env });
  const token = params.accessToken.trim();
  if (!record || !token || !tokensMatch(record.accessTokenHash, token)) {
    return null;
  }
  return record;
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

export async function claimDurableA2aPaymentReference(params: {
  taskId: string;
  txRef: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = params.env ?? process.env;
  const taskId = params.taskId.trim();
  const txRef = params.txRef.trim();
  if (!taskId || !txRef) {
    throw new Error("A2A payment claim requires taskId and txRef");
  }
  const claimPath = paymentClaimPath(txRef, env);
  await withFileLock(paymentReferenceClaimLockPath(env), LOCK_OPTIONS, async () => {
    await withFileLock(claimPath, LOCK_OPTIONS, async () => {
      if (fs.existsSync(claimPath)) {
        const existing = JSON.parse(fs.readFileSync(claimPath, "utf8")) as unknown;
        if (!isRecord(existing) || existing.taskId !== taskId) {
          throw new Error("payment transaction was already claimed by a different A2A task");
        }
        return;
      }
      const claimDir = path.dirname(claimPath);
      fs.mkdirSync(claimDir, { recursive: true, mode: 0o700 });
      requireJsonLedgerCapacity(
        claimDir,
        MAX_PAYMENT_CLAIM_FILES,
        "A2A payment transaction claim store",
      );
      writeWalletStateFileAtomically(
        claimPath,
        serializeWalletState({
          version: 1,
          taskId,
          txRefDigest: `sha256:${createHash("sha256").update(txRef, "utf8").digest("hex")}`,
          createdAt: new Date().toISOString(),
        }),
      );
    });
  });
}

export async function reserveDurableA2aTask(params: {
  taskId: string;
  senderHandle: string;
  input: unknown;
  marketplacePayment?: unknown;
  accessToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ record: DurableA2aTaskRecord; created: boolean; accessToken?: string }> {
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
  const senderHandle = params.senderHandle.trim();
  return await withFileLock(taskCapacityLockPath(env), LOCK_OPTIONS, async () => {
    pruneDurableTasks(env);
    return await withFileLock(senderQuotaLockPath(senderHandle, env), LOCK_OPTIONS, async () => {
      return await withFileLock(taskPath(taskId, env), LOCK_OPTIONS, async () => {
        const existing = readDurableA2aTask({ taskId, env });
        if (existing) {
          if (existing.intentDigest !== intentDigest) {
            throw new Error("A2A taskId is already bound to a different immutable task intent");
          }
          if (!params.accessToken || !tokensMatch(existing.accessTokenHash, params.accessToken)) {
            throw new Error("A2A taskId already exists and requires its task access token");
          }
          return { record: existing, created: false };
        }
        enforceSenderQuota({ senderHandle, env });
        requireJsonLedgerCapacity(taskDirectory(env), MAX_TASK_FILES_ON_DISK, "A2A task store");
        const now = new Date().toISOString();
        const accessToken =
          normalizeNewAccessToken(params.accessToken) ?? randomBytes(32).toString("base64url");
        const record: DurableA2aTaskRecord = {
          version: 2,
          taskId,
          intentDigest,
          accessTokenHash: hashAccessToken(accessToken),
          senderHandle,
          input: params.input,
          ...(params.marketplacePayment !== undefined
            ? { marketplacePayment: params.marketplacePayment }
            : {}),
          status: "queued",
          createdAt: now,
          updatedAt: now,
        };
        writeRecord(record, env);
        return { record, created: true, accessToken };
      });
    });
  });
}

export async function updateDurableA2aTask(params: {
  taskId: string;
  expectedStatuses?: DurableA2aTaskStatus[];
  status?: DurableA2aTaskStatus;
  output?: unknown;
  error?: string;
  settlement?: A2aSettlementResult;
  paymentRecovery?: DurableA2aPaymentRecovery;
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
    if (params.paymentRecovery !== undefined) {
      record.paymentRecovery = params.paymentRecovery;
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
