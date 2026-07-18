import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { WalletProviderId } from "../config/types.wallet.js";
import { withFileLock } from "../infra/file-lock.js";
import {
  serializeWalletState,
  writeWalletStateFileAtomically,
} from "../wallet/wallet-atomic-state.js";
import { emitDurableCapacityWarning } from "./durable-capacity.js";

export type DurableMarketplaceRunStatus =
  | "reserved"
  | "payment_pending"
  | "paid"
  | "task_created"
  | "completed"
  | "failed"
  | "refund_required"
  | "refunded"
  | "disputed"
  | "unknown";

export type DurableMarketplacePreparedRun = {
  handle: string;
  endpoint: string;
  offerId: string;
  walletId: string;
  walletName: string;
  providerId: WalletProviderId;
  walletAddress: string;
  senderHandle: string;
  taskId: string;
  challengeId: string;
  paymentMemo: string;
  invoiceId: string;
  receiptId: string;
  taskAccessToken: string;
  sourceText: string;
  requestedOutput: string;
  summaryStyle: "plain" | "bullets";
  maxSentences: number;
  amount: string;
  currency: string;
  asset: { kind: "native" | "spl-token"; address?: string };
  payeeAddress: string;
  issuedAt: string;
  expiresAt: string;
  settledAt: string;
};

export type DurableMarketplaceRunRecord = {
  version: 1;
  executionIntentId: string;
  intentDigest: string;
  status: DurableMarketplaceRunStatus;
  prepared?: DurableMarketplacePreparedRun;
  txRef?: string;
  payerAddress?: string;
  refundTxRef?: string;
  taskCreatedAt?: string;
  result?: unknown;
  reason?: string;
  createdAt: string;
  updatedAt: string;
};

type DurableMarketplaceRunPatch = Partial<
  Omit<
    DurableMarketplaceRunRecord,
    "version" | "executionIntentId" | "intentDigest" | "status" | "createdAt" | "updatedAt"
  >
>;

export type DurableMarketplaceRunContext = {
  readonly record: DurableMarketplaceRunRecord;
  update: (params: {
    status: DurableMarketplaceRunStatus;
    patch?: DurableMarketplaceRunPatch;
  }) => DurableMarketplaceRunRecord;
};

const STATUSES = new Set<DurableMarketplaceRunStatus>([
  "reserved",
  "payment_pending",
  "paid",
  "task_created",
  "completed",
  "failed",
  "refund_required",
  "refunded",
  "disputed",
  "unknown",
]);

const TRANSITIONS: Record<DurableMarketplaceRunStatus, ReadonlySet<DurableMarketplaceRunStatus>> = {
  reserved: new Set(["reserved", "payment_pending", "failed"]),
  payment_pending: new Set(["payment_pending", "paid", "failed", "unknown"]),
  paid: new Set(["paid", "task_created", "refund_required", "unknown"]),
  task_created: new Set(["task_created", "completed", "refund_required", "unknown"]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  refund_required: new Set(["refund_required", "refunded", "disputed"]),
  refunded: new Set(["refunded"]),
  disputed: new Set(["disputed"]),
  unknown: new Set(["unknown", "paid", "failed"]),
};

const LOCK_OPTIONS = {
  retries: {
    retries: 400,
    factor: 1.15,
    minTimeout: 10,
    maxTimeout: 500,
    randomize: true,
  },
  stale: 120_000,
} as const;
const MAX_RUN_FILES_ON_DISK = 10_000;
const MAX_RETAINED_TERMINAL_RUNS = 5_000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const SECRET_KEY_BYTES = 32;
const REDACTED_TERMINAL_TASK_TOKEN = "terminal-capability-redacted-after-run-completion";

type EncryptedTaskAccessToken = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Marketplace run intent contains a non-finite number");
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
  throw new Error("Marketplace run intent contains an unsupported value");
}

function intentDigest(intent: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(intent)).digest("hex")}`;
}

function validateExecutionIntentId(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 240 ||
    Array.from(normalized).some((character) => character.charCodeAt(0) <= 0x1f)
  ) {
    throw new Error("Marketplace executionIntentId is invalid");
  }
  return normalized;
}

function runDirectory(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "federation", "marketplace-runs");
}

function runPath(executionIntentId: string, env: NodeJS.ProcessEnv): string {
  const digest = createHash("sha256").update(executionIntentId).digest("hex");
  return path.join(runDirectory(env), `${digest}.json`);
}

function retentionLockPath(env: NodeJS.ProcessEnv): string {
  return path.join(runDirectory(env), ".retention");
}

function secretKeyPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "secrets", "marketplace-runs.key");
}

function readOrCreateSecretKey(env: NodeJS.ProcessEnv): Buffer {
  const filePath = secretKeyPath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath)) {
    const key = Buffer.from(fs.readFileSync(filePath, "utf8").trim(), "hex");
    if (key.length !== SECRET_KEY_BYTES) {
      throw new Error("Marketplace run encryption key is invalid");
    }
    return key;
  }
  const key = randomBytes(SECRET_KEY_BYTES);
  fs.writeFileSync(filePath, `${key.toString("hex")}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems that do not implement POSIX modes.
  }
  return key;
}

function encryptTaskAccessToken(params: {
  token: string;
  executionIntentId: string;
  env: NodeJS.ProcessEnv;
}): EncryptedTaskAccessToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", readOrCreateSecretKey(params.env), iv);
  cipher.setAAD(Buffer.from(params.executionIntentId, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(params.token, "utf8")),
    cipher.final(),
  ]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptTaskAccessToken(params: {
  encrypted: unknown;
  executionIntentId: string;
  env: NodeJS.ProcessEnv;
}): string {
  if (
    !isRecord(params.encrypted) ||
    params.encrypted.version !== 1 ||
    params.encrypted.algorithm !== "aes-256-gcm" ||
    typeof params.encrypted.iv !== "string" ||
    typeof params.encrypted.authTag !== "string" ||
    typeof params.encrypted.ciphertext !== "string"
  ) {
    throw new Error("durable Marketplace run has invalid encrypted task access state");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      readOrCreateSecretKey(params.env),
      Buffer.from(params.encrypted.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(params.executionIntentId, "utf8"));
    decipher.setAuthTag(Buffer.from(params.encrypted.authTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(params.encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new Error("durable Marketplace task access token cannot be decrypted", { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validatePrepared(value: unknown): DurableMarketplacePreparedRun | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value.asset)) {
    throw new Error("durable Marketplace run has invalid prepared state");
  }
  const requiredStrings = [
    "handle",
    "endpoint",
    "offerId",
    "walletId",
    "walletName",
    "providerId",
    "walletAddress",
    "senderHandle",
    "taskId",
    "challengeId",
    "paymentMemo",
    "invoiceId",
    "receiptId",
    "taskAccessToken",
    "sourceText",
    "requestedOutput",
    "amount",
    "currency",
    "payeeAddress",
    "issuedAt",
    "expiresAt",
    "settledAt",
  ];
  if (
    requiredStrings.some((field) => typeof value[field] !== "string" || !value[field].trim()) ||
    ![
      "embedded-keystore",
      "local-socket-signer",
      "alchemy",
      "turnkey",
      "wallet-standard",
      "privy",
    ].includes(String(value.providerId)) ||
    !/^[A-Za-z0-9_-]{43,256}$/u.test(String(value.taskAccessToken)) ||
    (value.summaryStyle !== "plain" && value.summaryStyle !== "bullets") ||
    typeof value.maxSentences !== "number" ||
    !Number.isSafeInteger(value.maxSentences) ||
    value.maxSentences < 1 ||
    value.maxSentences > 20 ||
    (value.asset.kind !== "native" && value.asset.kind !== "spl-token") ||
    (value.asset.address !== undefined && typeof value.asset.address !== "string")
  ) {
    throw new Error("durable Marketplace run has invalid prepared fields");
  }
  return value as DurableMarketplacePreparedRun;
}

function validateRecord(value: unknown, executionIntentId: string): DurableMarketplaceRunRecord {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.executionIntentId !== executionIntentId ||
    typeof value.intentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.intentDigest) ||
    typeof value.status !== "string" ||
    !STATUSES.has(value.status as DurableMarketplaceRunStatus) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.txRef !== undefined && typeof value.txRef !== "string") ||
    (value.payerAddress !== undefined && typeof value.payerAddress !== "string") ||
    (value.refundTxRef !== undefined && typeof value.refundTxRef !== "string") ||
    (value.taskCreatedAt !== undefined && typeof value.taskCreatedAt !== "string") ||
    (value.reason !== undefined && typeof value.reason !== "string")
  ) {
    throw new Error("durable Marketplace run contains an invalid record");
  }
  validatePrepared(value.prepared);
  if (
    value.status !== "reserved" &&
    value.status !== "failed" &&
    (!value.prepared || !isRecord(value.prepared))
  ) {
    throw new Error("durable Marketplace run is missing prepared state");
  }
  if (
    (value.status === "paid" ||
      value.status === "task_created" ||
      value.status === "completed" ||
      value.status === "refund_required" ||
      value.status === "refunded" ||
      value.status === "disputed") &&
    (typeof value.txRef !== "string" ||
      !value.txRef.trim() ||
      typeof value.payerAddress !== "string" ||
      !value.payerAddress.trim())
  ) {
    throw new Error("durable Marketplace run is missing its payment result");
  }
  if (value.status === "completed" && value.result === undefined) {
    throw new Error("durable Marketplace run is missing its completed result");
  }
  if (
    value.status === "refunded" &&
    (typeof value.refundTxRef !== "string" || !value.refundTxRef.trim())
  ) {
    throw new Error("durable Marketplace run is missing its refund transaction");
  }
  return value as DurableMarketplaceRunRecord;
}

function readRecord(executionIntentId: string, env: NodeJS.ProcessEnv) {
  const filePath = runPath(executionIntentId, env);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (isRecord(stored) && isRecord(stored.prepared)) {
      const prepared = { ...stored.prepared };
      if (prepared.taskAccessToken === undefined) {
        prepared.taskAccessToken = ["completed", "failed", "refunded", "disputed"].includes(
          String(stored.status),
        )
          ? REDACTED_TERMINAL_TASK_TOKEN
          : decryptTaskAccessToken({
              encrypted: prepared.taskAccessTokenEncrypted,
              executionIntentId,
              env,
            });
      }
      delete prepared.taskAccessTokenEncrypted;
      stored.prepared = prepared;
    }
    return validateRecord(stored, executionIntentId);
  } catch (error) {
    throw new Error("durable Marketplace run is unreadable; refusing to replace it", {
      cause: error,
    });
  }
}

function writeRecord(record: DurableMarketplaceRunRecord, env: NodeJS.ProcessEnv): void {
  fs.mkdirSync(runDirectory(env), { recursive: true, mode: 0o700 });
  const terminal = ["completed", "failed", "refunded", "disputed"].includes(record.status);
  const stored = record.prepared
    ? {
        ...record,
        prepared: {
          ...record.prepared,
          taskAccessToken: undefined,
          taskAccessTokenEncrypted: terminal
            ? undefined
            : encryptTaskAccessToken({
                token: record.prepared.taskAccessToken,
                executionIntentId: record.executionIntentId,
                env,
              }),
          taskAccessTokenRedactedAt: terminal ? record.updatedAt : undefined,
        },
      }
    : record;
  writeWalletStateFileAtomically(
    runPath(record.executionIntentId, env),
    serializeWalletState(stored),
  );
}

function listRunFiles(env: NodeJS.ProcessEnv): string[] {
  const dir = runDirectory(env);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = fs.readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  emitDurableCapacityWarning("Marketplace run store", files.length, MAX_RUN_FILES_ON_DISK);
  if (files.length > MAX_RUN_FILES_ON_DISK) {
    throw new Error("Marketplace run store exceeds its safe on-disk record limit");
  }
  return files;
}

function pruneTerminalRuns(env: NodeJS.ProcessEnv): void {
  const now = Date.now();
  const terminal = listRunFiles(env)
    .map((name) => {
      const filePath = path.join(runDirectory(env), name);
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
        if (
          !isRecord(value) ||
          typeof value.status !== "string" ||
          !["completed", "failed", "refunded", "disputed"].includes(value.status) ||
          typeof value.updatedAt !== "string"
        ) {
          return null;
        }
        return { filePath, updatedAt: Date.parse(value.updatedAt) };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { filePath: string; updatedAt: number } => Boolean(entry))
    .toSorted((left, right) => left.updatedAt - right.updatedAt);
  for (const [index, entry] of terminal.entries()) {
    if (
      now - entry.updatedAt > TERMINAL_RETENTION_MS ||
      terminal.length - index > MAX_RETAINED_TERMINAL_RUNS
    ) {
      try {
        fs.unlinkSync(entry.filePath);
      } catch {
        // Retention is best effort; unreadable live records still fail closed on direct access.
      }
    }
  }
}

export async function withDurableMarketplaceRun<T>(params: {
  executionIntentId: string;
  intent: unknown;
  env?: NodeJS.ProcessEnv;
  run: (context: DurableMarketplaceRunContext) => Promise<T>;
}): Promise<T> {
  const env = params.env ?? process.env;
  const executionIntentId = validateExecutionIntentId(params.executionIntentId);
  const digest = intentDigest(params.intent);
  const filePath = runPath(executionIntentId, env);
  fs.mkdirSync(runDirectory(env), { recursive: true, mode: 0o700 });
  return await withFileLock(filePath, LOCK_OPTIONS, async () => {
    let record = readRecord(executionIntentId, env);
    if (!record) {
      await withFileLock(retentionLockPath(env), LOCK_OPTIONS, async () => {
        record = readRecord(executionIntentId, env);
        if (record) {
          return;
        }
        pruneTerminalRuns(env);
        if (listRunFiles(env).length >= MAX_RUN_FILES_ON_DISK) {
          throw new Error("Marketplace run store reached its safe on-disk record limit");
        }
        const now = new Date().toISOString();
        record = {
          version: 1,
          executionIntentId,
          intentDigest: digest,
          status: "reserved",
          createdAt: now,
          updatedAt: now,
        };
        writeRecord(record, env);
      });
    } else if (record.intentDigest !== digest) {
      throw new Error("Marketplace executionIntentId is bound to a different immutable request");
    }

    if (!record) {
      throw new Error("Marketplace run reservation failed");
    }
    if (record.intentDigest !== digest) {
      throw new Error("Marketplace executionIntentId is bound to a different immutable request");
    }

    const update = (params: {
      status: DurableMarketplaceRunStatus;
      patch?: DurableMarketplaceRunPatch;
    }) => {
      if (!TRANSITIONS[record!.status].has(params.status)) {
        throw new Error(`invalid Marketplace run transition ${record!.status} -> ${params.status}`);
      }
      record = validateRecord(
        {
          ...record,
          ...params.patch,
          status: params.status,
          updatedAt: new Date().toISOString(),
        },
        executionIntentId,
      );
      writeRecord(record, env);
      return record;
    };

    return await params.run({
      get record() {
        return record!;
      },
      update,
    });
  });
}

export function createMarketplaceTaskAccessToken(): string {
  return randomBytes(32).toString("base64url");
}
