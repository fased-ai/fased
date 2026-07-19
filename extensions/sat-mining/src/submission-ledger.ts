import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir, withFileLock, type FileLockOptions } from "fased/plugin-sdk/sat-runtime";

export type SatSubmissionSignerState =
  | "prepared"
  | "reserved"
  | "broadcast"
  | "confirmed"
  | "failed"
  | "unknown";

export type SatSubmissionLease = {
  owner: string;
  pid: number;
  acquiredAt: string;
  expiresAt: string;
};

export type SatSubmissionRecord = {
  requestId: string;
  workflowId: string;
  operationKey: string;
  intentDigest: string;
  walletId: string;
  action: string;
  state: SatSubmissionSignerState;
  signature?: string;
  error?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lease?: SatSubmissionLease;
};

type SatSubmissionLedgerFile = {
  version: 1;
  records: Record<string, SatSubmissionRecord>;
};

export type SatSubmissionClaim = {
  record: SatSubmissionRecord;
  created: boolean;
  claimed: boolean;
  owner: string;
};

const DEFAULT_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 120,
    factor: 1.15,
    minTimeout: 10,
    maxTimeout: 100,
    randomize: true,
  },
  stale: 120_000,
};

const localLedgerWriteChains = new Map<string, Promise<void>>();

async function withSatSubmissionLedgerLock<T>(
  filePath: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = localLedgerWriteChains.get(filePath) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const localGate = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const current = previous.catch(() => undefined).then(async () => await localGate);
  localLedgerWriteChains.set(filePath, current);
  await previous.catch(() => undefined);
  try {
    return await withFileLock(filePath, DEFAULT_LOCK_OPTIONS, task);
  } finally {
    releaseLocal();
    void current.finally(() => {
      if (localLedgerWriteChains.get(filePath) === current) {
        localLedgerWriteChains.delete(filePath);
      }
    });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

export function digestSatSubmissionIntent(value: unknown): string {
  return `sha256:${sha256(JSON.stringify(canonicalize(value)))}`;
}

export function buildSatSubmissionOperationKey(intent: {
  action?: unknown;
  keys?: unknown;
  instructions?: unknown;
  lookupTable?: unknown;
}): string {
  const action =
    typeof intent.action === "string" && intent.action.trim() ? intent.action.trim() : "sat";
  const accountShape = Array.isArray(intent.instructions)
    ? intent.instructions.map((instruction) => {
        const candidate = instruction as { action?: unknown; keys?: unknown };
        return { action: candidate.action, keys: candidate.keys };
      })
    : (intent.keys ?? intent.lookupTable);
  return `${action}:${sha256(JSON.stringify(canonicalize(accountShape))).slice(0, 24)}`;
}

function normalizeStateKey(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
  return normalized || "unattached";
}

export function resolveSatSubmissionLedgerPath(params: {
  walletId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = params.env ?? process.env;
  return path.join(
    resolveStateDir(env),
    "sat-mining",
    "wallets",
    normalizeStateKey(params.walletId),
    "submission-ledger.json",
  );
}

function emptyLedger(): SatSubmissionLedgerFile {
  return { version: 1, records: {} };
}

function normalizeRecord(value: unknown): SatSubmissionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<SatSubmissionRecord>;
  if (
    typeof record.requestId !== "string" ||
    typeof record.workflowId !== "string" ||
    typeof record.operationKey !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(record.intentDigest ?? "")) ||
    typeof record.walletId !== "string" ||
    typeof record.action !== "string" ||
    !["prepared", "reserved", "broadcast", "confirmed", "failed", "unknown"].includes(
      String(record.state ?? ""),
    )
  ) {
    return null;
  }
  return record as SatSubmissionRecord;
}

async function readLedger(filePath: string): Promise<SatSubmissionLedgerFile> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(filePath, "utf8"),
    ) as Partial<SatSubmissionLedgerFile>;
    if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") {
      throw new Error(`invalid SAT submission ledger format at ${filePath}`);
    }
    const records: Record<string, SatSubmissionRecord> = {};
    for (const [requestId, raw] of Object.entries(parsed.records)) {
      const record = normalizeRecord(raw);
      if (!record || record.requestId !== requestId) {
        throw new Error(`invalid SAT submission ledger record ${requestId}`);
      }
      records[requestId] = record;
    }
    return { version: 1, records };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyLedger();
    }
    throw error;
  }
}

async function writeLedger(filePath: string, ledger: SatSubmissionLedgerFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tempPath, filePath);
    const directory = await fs.open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function leaseDurationMs(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.FASED_SAT_SUBMISSION_LEASE_MS ?? "");
  if (Number.isFinite(configured) && configured >= 50 && configured <= 300_000) {
    return Math.floor(configured);
  }
  return 60_000;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function leaseIsLive(lease: SatSubmissionLease | undefined, now = Date.now()): boolean {
  if (!lease || Date.parse(lease.expiresAt) <= now) {
    return false;
  }
  return lease.pid === process.pid || isPidAlive(lease.pid);
}

function assertStateTransition(
  requestId: string,
  current: SatSubmissionSignerState,
  next: SatSubmissionSignerState,
): void {
  const allowed: Record<SatSubmissionSignerState, ReadonlySet<SatSubmissionSignerState>> = {
    prepared: new Set(["prepared", "reserved", "broadcast", "confirmed", "failed", "unknown"]),
    reserved: new Set(["reserved", "broadcast", "confirmed", "failed", "unknown"]),
    broadcast: new Set(["broadcast", "confirmed", "failed", "unknown"]),
    unknown: new Set(["broadcast", "confirmed", "failed", "unknown"]),
    confirmed: new Set(["confirmed"]),
    failed: new Set(["failed"]),
  };
  if (!allowed[current].has(next)) {
    throw new Error(`SAT submission ${requestId} cannot move from ${current} back to ${next}`);
  }
}

export function buildSatSubmissionRequestId(params: {
  walletId: string;
  workflowId: string;
  operationKey: string;
}): string {
  const digest = sha256(
    JSON.stringify([
      "fased-sat-submission-v1",
      params.walletId,
      params.workflowId,
      params.operationKey,
    ]),
  );
  return `sat-v2-${digest.slice(0, 48)}`;
}

export async function claimSatSubmission(params: {
  walletId: string;
  workflowId: string;
  operationKey: string;
  intentDigest: string;
  action: string;
  allowFailedRetry?: boolean;
  env?: NodeJS.ProcessEnv;
  owner?: string;
}): Promise<SatSubmissionClaim> {
  const env = params.env ?? process.env;
  const filePath = resolveSatSubmissionLedgerPath({ walletId: params.walletId, env });
  const owner = params.owner ?? `${process.pid}:${randomUUID()}`;
  return await withSatSubmissionLedgerLock(filePath, async () => {
    const ledger = await readLedger(filePath);
    let operationKey = params.operationKey;
    let requestId = buildSatSubmissionRequestId({ ...params, operationKey });
    if (params.allowFailedRetry) {
      for (let retry = 1; retry <= 32; retry += 1) {
        const prior = ledger.records[requestId];
        if (!prior || prior.state !== "failed") {
          break;
        }
        operationKey = `${params.operationKey}:retry:${retry}`;
        requestId = buildSatSubmissionRequestId({ ...params, operationKey });
        if (retry === 32 && ledger.records[requestId]?.state === "failed") {
          throw new Error("SAT submission exhausted its safe pre-broadcast retry limit");
        }
      }
    }
    const existing = ledger.records[requestId];
    if (existing) {
      if (
        existing.intentDigest !== params.intentDigest ||
        existing.walletId !== params.walletId ||
        existing.workflowId !== params.workflowId ||
        existing.operationKey !== operationKey
      ) {
        throw new Error(
          `SAT idempotency collision for ${requestId}: the workflow key is already bound to a different immutable intent digest`,
        );
      }
      if (leaseIsLive(existing.lease) && existing.lease?.owner !== owner) {
        return { record: existing, created: false, claimed: false, owner };
      }
      const now = new Date().toISOString();
      existing.lease = {
        owner,
        pid: process.pid,
        acquiredAt: now,
        expiresAt: new Date(Date.now() + leaseDurationMs(env)).toISOString(),
      };
      existing.attempts += 1;
      existing.updatedAt = now;
      await writeLedger(filePath, ledger);
      return { record: existing, created: false, claimed: true, owner };
    }
    const now = new Date().toISOString();
    const record: SatSubmissionRecord = {
      requestId,
      workflowId: params.workflowId,
      operationKey,
      intentDigest: params.intentDigest,
      walletId: params.walletId,
      action: params.action,
      state: "prepared",
      attempts: 1,
      createdAt: now,
      updatedAt: now,
      lease: {
        owner,
        pid: process.pid,
        acquiredAt: now,
        expiresAt: new Date(Date.now() + leaseDurationMs(env)).toISOString(),
      },
    };
    ledger.records[requestId] = record;
    await writeLedger(filePath, ledger);
    return { record, created: true, claimed: true, owner };
  });
}

export async function readSatSubmission(params: {
  walletId: string;
  requestId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SatSubmissionRecord | null> {
  const filePath = resolveSatSubmissionLedgerPath(params);
  return await withSatSubmissionLedgerLock(filePath, async () => {
    const ledger = await readLedger(filePath);
    return ledger.records[params.requestId] ?? null;
  });
}

export async function updateSatSubmission(params: {
  walletId: string;
  requestId: string;
  intentDigest: string;
  state: SatSubmissionSignerState;
  signature?: string;
  error?: string;
  owner?: string;
  releaseLease?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<SatSubmissionRecord> {
  const filePath = resolveSatSubmissionLedgerPath(params);
  return await withSatSubmissionLedgerLock(filePath, async () => {
    const ledger = await readLedger(filePath);
    const record = ledger.records[params.requestId];
    if (!record) {
      throw new Error(`SAT submission ${params.requestId} is missing from its durable ledger`);
    }
    if (record.intentDigest !== params.intentDigest) {
      throw new Error(`SAT submission ${params.requestId} intent digest changed during execution`);
    }
    if (params.owner && record.lease?.owner !== params.owner) {
      throw new Error(
        `SAT submission ${params.requestId} lease ownership changed during execution`,
      );
    }
    if (record.signature && params.signature && record.signature !== params.signature) {
      throw new Error(
        `SAT submission ${params.requestId} returned a different transaction signature`,
      );
    }
    assertStateTransition(params.requestId, record.state, params.state);
    record.state = params.state;
    if (params.signature !== undefined) {
      record.signature = params.signature;
    }
    if (params.error !== undefined) {
      record.error = params.error;
    } else if (params.state === "confirmed") {
      delete record.error;
    }
    if (params.releaseLease) {
      delete record.lease;
    }
    record.updatedAt = new Date().toISOString();
    await writeLedger(filePath, ledger);
    return record;
  });
}

export async function waitForSatSubmissionLease(params: {
  walletId: string;
  requestId: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<SatSubmissionRecord> {
  const timeoutAt = Date.now() + Math.max(100, params.timeoutMs ?? 65_000);
  for (;;) {
    const record = await readSatSubmission(params);
    if (!record) {
      throw new Error(`SAT submission ${params.requestId} disappeared while waiting for its lease`);
    }
    if (!leaseIsLive(record.lease)) {
      return record;
    }
    if (Date.now() >= timeoutAt) {
      throw new Error(
        `SAT submission ${params.requestId} is already executing in another process; retry the same idempotency key`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
