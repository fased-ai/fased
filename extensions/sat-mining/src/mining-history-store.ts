import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  SatMiningHistoryWindow,
  SatMiningRecentAction,
  SatPlannerCycleRecord,
  SatPlannerOutcomeMemory,
} from "./audit-store.js";

const MINING_HISTORY_SCHEMA_VERSION = 1;
const MINING_HISTORY_MIGRATION_LOCK_STALE_MS = 30 * 60 * 1000;
const MINING_HISTORY_IMPORT_BATCH_SIZE = 1_000;
const MINING_HISTORY_ACTION_PAGE_MAX = 200;
const MINING_HISTORY_OUTCOME_PAGE_MAX = 500;

type SqlRow = Record<string, unknown>;

export type SatMiningHistoryScope = {
  walletId: string;
  authority?: string | null;
  providerId?: string | null;
  network: string;
  genesisHash?: string | null;
  programId?: string | null;
  mintAddress?: string | null;
  mintProgramId?: string | null;
  manifestDigest?: string | null;
  protocolVersion?: string | null;
};

export type SatMiningHistoryMigrationSource = {
  kind: "action" | "planner";
  path: string;
  label: string;
};

export type SatMiningHistoryMigrationInput = {
  sources?: readonly SatMiningHistoryMigrationSource[];
  runtimeRecentActions?: readonly SatMiningRecentAction[];
  runtimePlannerOutcomes?: readonly SatPlannerOutcomeMemory[];
  runtimePlannerCycles?: readonly SatPlannerCycleRecord[];
};

export type SatMiningActionCursor = {
  occurredAtMs: number;
  sequence: number;
};

export type SatMiningOutcomeCursor = {
  recordedAtMs: number;
  cycleId: number;
  sequence: number;
};

export type SatMiningActionPage = {
  walletId: string;
  scope: SatMiningHistoryScope;
  actions: SatMiningRecentAction[];
  nextCursor: string | null;
  hasMore: boolean;
  matchingCount: number;
  totalStoredCount: number;
  windowStartAt: string | null;
  dataStartAt: string | null;
  dataEndAt: string | null;
  oldestAvailableAt: string | null;
  newestAvailableAt: string | null;
  historyRevision: number;
};

export type SatMiningOutcomePage = {
  walletId: string;
  scope: SatMiningHistoryScope;
  outcomes: SatPlannerOutcomeMemory[];
  nextCursor: string | null;
  hasMore: boolean;
  matchingCount: number;
  totalStoredCount: number;
  windowStartAt: string | null;
  dataStartAt: string | null;
  dataEndAt: string | null;
  oldestAvailableAt: string | null;
  newestAvailableAt: string | null;
  historyRevision: number;
};

export type SatMiningHistorySeries = {
  walletId: string;
  scope: SatMiningHistoryScope;
  outcomes: SatPlannerOutcomeMemory[];
  totalStoredOutcomeCount: number;
  matchingOutcomeCount: number;
  sampled: boolean;
  windowStartAt: string | null;
  dataStartAt: string | null;
  dataEndAt: string | null;
  historyRevision: number;
};

export type SatMiningHistoryMigrationReceipt = {
  schemaVersion: number;
  importedActions: number;
  duplicateActions: number;
  importedOutcomes: number;
  duplicateOutcomes: number;
  importedPlannerCycles: number;
  duplicatePlannerCycles: number;
  malformedRecords: number;
  sourceCount: number;
  integrity: string;
};

type OpenMiningHistoryStoreParams = {
  databasePath: string;
  scope: SatMiningHistoryScope;
  migration?: SatMiningHistoryMigrationInput;
};

type ImportCounters = {
  importedActions: number;
  duplicateActions: number;
  importedOutcomes: number;
  duplicateOutcomes: number;
  importedPlannerCycles: number;
  duplicatePlannerCycles: number;
  malformedRecords: number;
  sourceCount: number;
};

type MigrationLock = {
  path: string;
  handle: fs.FileHandle;
};

type HistoryTimeBounds = {
  count: number;
  oldestAtMs: number | null;
  newestAtMs: number | null;
};

function normalizeNullable(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeScope(scope: SatMiningHistoryScope): SatMiningHistoryScope {
  const walletId = String(scope.walletId ?? "").trim();
  const network = String(scope.network ?? "").trim();
  if (!walletId) {
    throw new Error("Mining history requires a canonical Wallet ID");
  }
  if (!network) {
    throw new Error("Mining history requires a network identity");
  }
  return {
    walletId,
    authority: normalizeNullable(scope.authority),
    providerId: normalizeNullable(scope.providerId),
    network,
    genesisHash: normalizeNullable(scope.genesisHash),
    programId: normalizeNullable(scope.programId),
    mintAddress: normalizeNullable(scope.mintAddress),
    mintProgramId: normalizeNullable(scope.mintProgramId),
    manifestDigest: normalizeNullable(scope.manifestDigest),
    protocolVersion: normalizeNullable(scope.protocolVersion),
  };
}

function scopeKey(scope: SatMiningHistoryScope): string {
  return sha256(canonicalJson(normalizeScope(scope)));
}

function isSatMiningRecentAction(value: unknown): value is SatMiningRecentAction {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SatMiningRecentAction>;
  return (
    typeof candidate.action === "string" &&
    candidate.action.trim().length > 0 &&
    (candidate.cycleId == null ||
      (typeof candidate.cycleId === "number" && Number.isFinite(candidate.cycleId))) &&
    (candidate.txHash == null || typeof candidate.txHash === "string") &&
    (candidate.status === "success" || candidate.status === "failure") &&
    (candidate.complete == null || typeof candidate.complete === "boolean") &&
    Number.isFinite(Date.parse(String(candidate.at ?? "")))
  );
}

function isSatPlannerOutcome(value: unknown): value is SatPlannerOutcomeMemory {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SatPlannerOutcomeMemory>;
  return (
    typeof candidate.cycleId === "number" &&
    Number.isFinite(candidate.cycleId) &&
    typeof candidate.committedLamports === "string" &&
    typeof candidate.totalSatEarnedRaw === "string" &&
    typeof candidate.totalRebateLamports === "string" &&
    typeof candidate.txFeeLamports === "string" &&
    typeof candidate.netLiveCostLamports === "string" &&
    typeof candidate.validParticipation === "boolean" &&
    Number.isFinite(Date.parse(String(candidate.recordedAt ?? "")))
  );
}

function isSatPlannerCycle(value: unknown): value is SatPlannerCycleRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SatPlannerCycleRecord>;
  return (
    typeof candidate.cycleId === "number" &&
    Number.isFinite(candidate.cycleId) &&
    Number.isFinite(Date.parse(String(candidate.recordedAt ?? ""))) &&
    Number.isFinite(Date.parse(String(candidate.decidedAt ?? "")))
  );
}

function historyWindowStartMs(window: SatMiningHistoryWindow): number | null {
  const now = Date.now();
  switch (window) {
    case "1h":
      return now - 60 * 60 * 1000;
    case "24h":
      return now - 24 * 60 * 60 * 1000;
    case "7d":
      return now - 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return now - 30 * 24 * 60 * 60 * 1000;
    case "1y":
      return now - 365 * 24 * 60 * 60 * 1000;
    case "all":
    default:
      return null;
  }
}

function encodeCursor(value: SatMiningActionCursor | SatMiningOutcomeCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeActionCursor(value: string | null | undefined): SatMiningActionCursor | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<SatMiningActionCursor>;
    if (
      typeof parsed.occurredAtMs === "number" &&
      Number.isSafeInteger(parsed.occurredAtMs) &&
      typeof parsed.sequence === "number" &&
      Number.isSafeInteger(parsed.sequence)
    ) {
      return { occurredAtMs: parsed.occurredAtMs, sequence: parsed.sequence };
    }
  } catch {
    // Invalid cursors are rejected below.
  }
  throw new Error("Invalid Mining action cursor");
}

function decodeOutcomeCursor(value: string | null | undefined): SatMiningOutcomeCursor | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<SatMiningOutcomeCursor>;
    if (
      typeof parsed.recordedAtMs === "number" &&
      Number.isSafeInteger(parsed.recordedAtMs) &&
      typeof parsed.cycleId === "number" &&
      Number.isSafeInteger(parsed.cycleId) &&
      typeof parsed.sequence === "number" &&
      Number.isSafeInteger(parsed.sequence)
    ) {
      return {
        recordedAtMs: parsed.recordedAtMs,
        cycleId: parsed.cycleId,
        sequence: parsed.sequence,
      };
    }
  } catch {
    // Invalid cursors are rejected below.
  }
  throw new Error("Invalid Mining outcome cursor");
}

function applyDatabasePragmas(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA trusted_schema=OFF;
    PRAGMA busy_timeout=5000;
    PRAGMA wal_autocheckpoint=1000;
  `);
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mining_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS history_scope (
      id INTEGER PRIMARY KEY,
      scope_key TEXT NOT NULL UNIQUE,
      wallet_id TEXT NOT NULL,
      authority TEXT,
      provider_id TEXT,
      network TEXT NOT NULL,
      genesis_hash TEXT,
      program_id TEXT,
      mint_address TEXT,
      mint_program_id TEXT,
      manifest_digest TEXT,
      protocol_version TEXT,
      created_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS mining_event (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      occurred_at_ms INTEGER NOT NULL,
      action TEXT NOT NULL,
      cycle_id INTEGER,
      tx_hash TEXT,
      status TEXT NOT NULL CHECK(status IN ('success', 'failure')),
      complete INTEGER,
      message TEXT,
      source_label TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS mining_event_scope_time
      ON mining_event(scope_id, occurred_at_ms DESC, sequence DESC);
    CREATE INDEX IF NOT EXISTS mining_event_scope_cycle
      ON mining_event(scope_id, cycle_id, occurred_at_ms DESC);

    CREATE TABLE IF NOT EXISTS planner_outcome (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      cycle_id INTEGER NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      source_label TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS planner_outcome_scope_time
      ON planner_outcome(scope_id, recorded_at_ms DESC, cycle_id DESC, sequence DESC);
    CREATE INDEX IF NOT EXISTS planner_outcome_scope_cycle
      ON planner_outcome(scope_id, cycle_id, recorded_at_ms DESC, sequence DESC);

    CREATE TABLE IF NOT EXISTS planner_cycle (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      cycle_id INTEGER NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      source_label TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS planner_cycle_scope_time
      ON planner_cycle(scope_id, recorded_at_ms DESC, cycle_id DESC, sequence DESC);

    CREATE TABLE IF NOT EXISTS migration_source (
      source_label TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_size INTEGER NOT NULL,
      source_mtime_ms INTEGER NOT NULL,
      source_sha256 TEXT NOT NULL,
      valid_records INTEGER NOT NULL,
      duplicate_records INTEGER NOT NULL,
      malformed_records INTEGER NOT NULL,
      imported_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS corruption_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_label TEXT NOT NULL,
      source_path TEXT NOT NULL,
      line_number INTEGER,
      byte_offset INTEGER,
      record_sha256 TEXT NOT NULL,
      reason TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL
    ) STRICT;
  `);
  const schemaStatement = db.prepare(
    "INSERT INTO mining_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );
  schemaStatement.run(String(MINING_HISTORY_SCHEMA_VERSION));
  db.prepare(
    "INSERT INTO mining_meta(key, value) VALUES('history_revision', '0') ON CONFLICT(key) DO NOTHING",
  ).run();
}

function getHistoryRevision(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM mining_meta WHERE key='history_revision'").get() as
    | SqlRow
    | undefined;
  const revision = Number(row?.value ?? 0);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function incrementHistoryRevision(db: DatabaseSync): number {
  db.prepare(
    "UPDATE mining_meta SET value=CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key='history_revision'",
  ).run();
  return getHistoryRevision(db);
}

function ensureScope(db: DatabaseSync, requestedScope: SatMiningHistoryScope): number {
  const scope = normalizeScope(requestedScope);
  const key = scopeKey(scope);
  db.prepare(
    `INSERT INTO history_scope(
       scope_key, wallet_id, authority, provider_id, network, genesis_hash,
       program_id, mint_address, mint_program_id, manifest_digest,
       protocol_version, created_at_ms
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_key) DO NOTHING`,
  ).run(
    key,
    scope.walletId,
    scope.authority ?? null,
    scope.providerId ?? null,
    scope.network,
    scope.genesisHash ?? null,
    scope.programId ?? null,
    scope.mintAddress ?? null,
    scope.mintProgramId ?? null,
    scope.manifestDigest ?? null,
    scope.protocolVersion ?? null,
    Date.now(),
  );
  const row = db.prepare("SELECT id FROM history_scope WHERE scope_key=?").get(key) as
    | SqlRow
    | undefined;
  const id = Number(row?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Failed to resolve Mining history scope");
  }
  return id;
}

function readScope(db: DatabaseSync, scopeId: number): SatMiningHistoryScope {
  const row = db.prepare("SELECT * FROM history_scope WHERE id=?").get(scopeId) as
    | SqlRow
    | undefined;
  if (!row) {
    throw new Error("Mining history scope is missing");
  }
  return {
    walletId: String(row.wallet_id),
    authority: normalizeNullable(row.authority),
    providerId: normalizeNullable(row.provider_id),
    network: String(row.network),
    genesisHash: normalizeNullable(row.genesis_hash),
    programId: normalizeNullable(row.program_id),
    mintAddress: normalizeNullable(row.mint_address),
    mintProgramId: normalizeNullable(row.mint_program_id),
    manifestDigest: normalizeNullable(row.manifest_digest),
    protocolVersion: normalizeNullable(row.protocol_version),
  };
}

function actionEventId(scopeId: number, entry: SatMiningRecentAction): string {
  return sha256(`action\0${scopeId}\0${canonicalJson(entry)}`);
}

function plannerOutcomeEventId(scopeId: number, entry: SatPlannerOutcomeMemory): string {
  return sha256(`outcome\0${scopeId}\0${canonicalJson(entry)}`);
}

function plannerCycleEventId(scopeId: number, entry: SatPlannerCycleRecord): string {
  return sha256(`cycle\0${scopeId}\0${canonicalJson(entry)}`);
}

function insertAction(
  statement: StatementSync,
  scopeId: number,
  entry: SatMiningRecentAction,
  sourceLabel: string,
): boolean {
  const result = statement.run(
    actionEventId(scopeId, entry),
    scopeId,
    Date.parse(entry.at),
    entry.action,
    entry.cycleId ?? null,
    entry.txHash ?? null,
    entry.status,
    entry.complete == null ? null : entry.complete ? 1 : 0,
    entry.message ?? null,
    sourceLabel,
    canonicalJson(entry),
  );
  return Number(result.changes) > 0;
}

function insertOutcome(
  statement: StatementSync,
  scopeId: number,
  entry: SatPlannerOutcomeMemory,
  sourceLabel: string,
): boolean {
  const result = statement.run(
    plannerOutcomeEventId(scopeId, entry),
    scopeId,
    entry.cycleId,
    Date.parse(entry.recordedAt),
    sourceLabel,
    canonicalJson(entry),
  );
  return Number(result.changes) > 0;
}

function insertPlannerCycle(
  statement: StatementSync,
  scopeId: number,
  entry: SatPlannerCycleRecord,
  sourceLabel: string,
): boolean {
  const result = statement.run(
    plannerCycleEventId(scopeId, entry),
    scopeId,
    entry.cycleId,
    Date.parse(entry.recordedAt),
    sourceLabel,
    canonicalJson(entry),
  );
  return Number(result.changes) > 0;
}

function actionInsertStatement(db: DatabaseSync): StatementSync {
  return db.prepare(
    `INSERT INTO mining_event(
       event_id, scope_id, occurred_at_ms, action, cycle_id, tx_hash, status,
       complete, message, source_label, payload_json
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO NOTHING`,
  );
}

function outcomeInsertStatement(db: DatabaseSync): StatementSync {
  return db.prepare(
    `INSERT INTO planner_outcome(
       event_id, scope_id, cycle_id, recorded_at_ms, source_label, payload_json
     ) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO NOTHING`,
  );
}

function plannerCycleInsertStatement(db: DatabaseSync): StatementSync {
  return db.prepare(
    `INSERT INTO planner_cycle(
       event_id, scope_id, cycle_id, recorded_at_ms, source_label, payload_json
     ) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO NOTHING`,
  );
}

async function streamSha256(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
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

async function acquireMigrationLock(lockPath: string): Promise<MigrationLock> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await handle.sync();
      return { path: lockPath, handle };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) {
        throw error;
      }
      const stat = await fs.lstat(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Unsafe Mining migration lock: ${lockPath}`);
      }
      const raw = await fs.readFile(lockPath, "utf8").catch(() => "");
      let pid = 0;
      try {
        pid = Number((JSON.parse(raw) as { pid?: unknown }).pid ?? 0);
      } catch {
        // Treat an old malformed regular lock as stale only after the age threshold.
      }
      if (Date.now() - stat.mtimeMs < MINING_HISTORY_MIGRATION_LOCK_STALE_MS || isPidAlive(pid)) {
        throw new Error(`Mining history migration is already active: ${lockPath}`);
      }
      await fs.rm(lockPath);
    }
  }
  throw new Error(`Could not acquire Mining migration lock: ${lockPath}`);
}

async function releaseMigrationLock(lock: MigrationLock): Promise<void> {
  await lock.handle.close().catch(() => {});
  await fs.rm(lock.path, { force: true }).catch(() => {});
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function recordCorruption(
  db: DatabaseSync,
  params: {
    sourceLabel: string;
    sourcePath: string;
    lineNumber?: number | null;
    byteOffset?: number | null;
    record: string;
    reason: string;
  },
): void {
  db.prepare(
    `INSERT INTO corruption_record(
       source_label, source_path, line_number, byte_offset, record_sha256,
       reason, observed_at_ms
     ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.sourceLabel,
    params.sourcePath,
    params.lineNumber ?? null,
    params.byteOffset ?? null,
    sha256(params.record),
    params.reason,
    Date.now(),
  );
}

async function importNdjsonSource(
  db: DatabaseSync,
  scopeId: number,
  source: SatMiningHistoryMigrationSource,
  counters: ImportCounters,
): Promise<void> {
  const stat = await fs.stat(source.path).catch(() => null);
  if (!stat?.isFile()) {
    return;
  }
  const existing = db
    .prepare("SELECT source_sha256 FROM migration_source WHERE source_label=?")
    .get(source.label) as SqlRow | undefined;
  const digest = await streamSha256(source.path);
  if (existing && String(existing.source_sha256) === digest) {
    return;
  }

  const actionStatement = actionInsertStatement(db);
  const outcomeStatement = outcomeInsertStatement(db);
  const input = createReadStream(source.path, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let validRecords = 0;
  let duplicateRecords = 0;
  let malformedRecords = 0;
  let lineNumber = 0;
  let batchCount = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for await (const line of lines) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        malformedRecords += 1;
        counters.malformedRecords += 1;
        recordCorruption(db, {
          sourceLabel: source.label,
          sourcePath: source.path,
          lineNumber,
          record: trimmed,
          reason: "invalid-json",
        });
        continue;
      }

      let inserted = false;
      if (source.kind === "action" && isSatMiningRecentAction(parsed)) {
        inserted = insertAction(actionStatement, scopeId, parsed, source.label);
        counters.importedActions += inserted ? 1 : 0;
        counters.duplicateActions += inserted ? 0 : 1;
      } else if (source.kind === "planner" && isSatPlannerOutcome(parsed)) {
        inserted = insertOutcome(outcomeStatement, scopeId, parsed, source.label);
        counters.importedOutcomes += inserted ? 1 : 0;
        counters.duplicateOutcomes += inserted ? 0 : 1;
      } else {
        malformedRecords += 1;
        counters.malformedRecords += 1;
        recordCorruption(db, {
          sourceLabel: source.label,
          sourcePath: source.path,
          lineNumber,
          record: trimmed,
          reason: `invalid-${source.kind}-record`,
        });
        continue;
      }
      validRecords += 1;
      duplicateRecords += inserted ? 0 : 1;
      batchCount += 1;
      if (batchCount >= MINING_HISTORY_IMPORT_BATCH_SIZE) {
        db.exec("COMMIT");
        db.exec("BEGIN IMMEDIATE");
        batchCount = 0;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }

  db.prepare(
    `INSERT INTO migration_source(
       source_label, source_path, source_kind, source_size, source_mtime_ms,
       source_sha256, valid_records, duplicate_records, malformed_records,
       imported_at_ms
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_label) DO UPDATE SET
       source_path=excluded.source_path,
       source_kind=excluded.source_kind,
       source_size=excluded.source_size,
       source_mtime_ms=excluded.source_mtime_ms,
       source_sha256=excluded.source_sha256,
       valid_records=excluded.valid_records,
       duplicate_records=excluded.duplicate_records,
       malformed_records=excluded.malformed_records,
       imported_at_ms=excluded.imported_at_ms`,
  ).run(
    source.label,
    source.path,
    source.kind,
    stat.size,
    Math.floor(stat.mtimeMs),
    digest,
    validRecords,
    duplicateRecords,
    malformedRecords,
    Date.now(),
  );
  counters.sourceCount += 1;
}

function importRuntimeRecords(
  db: DatabaseSync,
  scopeId: number,
  input: SatMiningHistoryMigrationInput | undefined,
  counters: ImportCounters,
): void {
  const actionStatement = actionInsertStatement(db);
  const outcomeStatement = outcomeInsertStatement(db);
  const cycleStatement = plannerCycleInsertStatement(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const entry of input?.runtimeRecentActions ?? []) {
      if (!isSatMiningRecentAction(entry)) {
        counters.malformedRecords += 1;
        continue;
      }
      const inserted = insertAction(actionStatement, scopeId, entry, "runtime-store:recentActions");
      counters.importedActions += inserted ? 1 : 0;
      counters.duplicateActions += inserted ? 0 : 1;
    }
    for (const entry of input?.runtimePlannerOutcomes ?? []) {
      if (!isSatPlannerOutcome(entry)) {
        counters.malformedRecords += 1;
        continue;
      }
      const inserted = insertOutcome(
        outcomeStatement,
        scopeId,
        entry,
        "runtime-store:plannerHistory",
      );
      counters.importedOutcomes += inserted ? 1 : 0;
      counters.duplicateOutcomes += inserted ? 0 : 1;
    }
    for (const entry of input?.runtimePlannerCycles ?? []) {
      if (!isSatPlannerCycle(entry)) {
        counters.malformedRecords += 1;
        continue;
      }
      const inserted = insertPlannerCycle(
        cycleStatement,
        scopeId,
        entry,
        "runtime-store:plannerCycles",
      );
      counters.importedPlannerCycles += inserted ? 1 : 0;
      counters.duplicatePlannerCycles += inserted ? 0 : 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function rowToAction(row: SqlRow): SatMiningRecentAction {
  const parsed = JSON.parse(String(row.payload_json)) as unknown;
  if (!isSatMiningRecentAction(parsed)) {
    throw new Error(`Corrupt Mining action row ${String(row.sequence)}`);
  }
  return parsed;
}

function rowToOutcome(row: SqlRow): SatPlannerOutcomeMemory {
  const parsed = JSON.parse(String(row.payload_json)) as unknown;
  if (!isSatPlannerOutcome(parsed)) {
    throw new Error(`Corrupt Mining outcome row ${String(row.sequence)}`);
  }
  return parsed;
}

function rowToPlannerCycle(row: SqlRow): SatPlannerCycleRecord {
  const parsed = JSON.parse(String(row.payload_json)) as unknown;
  if (!isSatPlannerCycle(parsed)) {
    throw new Error(`Corrupt Mining planner-cycle row ${String(row.sequence)}`);
  }
  return parsed;
}

function readTimeBounds(
  db: DatabaseSync,
  table: "mining_event" | "planner_outcome",
  scopeId: number,
  timeColumn: "occurred_at_ms" | "recorded_at_ms",
  windowStartMs: number | null,
): HistoryTimeBounds {
  const condition = windowStartMs == null ? "" : ` AND ${timeColumn} >= ?`;
  const args = windowStartMs == null ? [scopeId] : [scopeId, windowStartMs];
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count, MIN(${timeColumn}) AS oldest_at_ms,
              MAX(${timeColumn}) AS newest_at_ms
         FROM ${table}
        WHERE scope_id=?${condition}`,
    )
    .get(...args) as SqlRow;
  return {
    count: Number(row.count ?? 0),
    oldestAtMs: row.oldest_at_ms == null ? null : Number(row.oldest_at_ms),
    newestAtMs: row.newest_at_ms == null ? null : Number(row.newest_at_ms),
  };
}

function readOutcomeTimeBounds(
  db: DatabaseSync,
  scopeId: number,
  windowStartMs: number | null,
): HistoryTimeBounds {
  const condition = windowStartMs == null ? "" : " AND recorded_at_ms >= ?";
  const args = windowStartMs == null ? [scopeId] : [scopeId, windowStartMs];
  const row = db
    .prepare(
      `WITH ranked AS (
         SELECT recorded_at_ms,
                ROW_NUMBER() OVER (
                  PARTITION BY cycle_id
                  ORDER BY recorded_at_ms DESC, sequence DESC
                ) AS rank
           FROM planner_outcome
          WHERE scope_id=?${condition}
       )
       SELECT COUNT(*) AS count, MIN(recorded_at_ms) AS oldest_at_ms,
              MAX(recorded_at_ms) AS newest_at_ms
         FROM ranked
        WHERE rank=1`,
    )
    .get(...args) as SqlRow;
  return {
    count: Number(row.count ?? 0),
    oldestAtMs: row.oldest_at_ms == null ? null : Number(row.oldest_at_ms),
    newestAtMs: row.newest_at_ms == null ? null : Number(row.newest_at_ms),
  };
}

function isoOrNull(value: number | null): string | null {
  return value == null || !Number.isFinite(value) ? null : new Date(value).toISOString();
}

export class SatMiningHistoryStore {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private scope: SatMiningHistoryScope;
  private scopeId: number;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    databasePath: string,
    db: DatabaseSync,
    scope: SatMiningHistoryScope,
    scopeId: number,
  ) {
    this.databasePath = databasePath;
    this.db = db;
    this.scope = scope;
    this.scopeId = scopeId;
  }

  static async open(params: OpenMiningHistoryStoreParams): Promise<{
    store: SatMiningHistoryStore;
    migration: SatMiningHistoryMigrationReceipt | null;
  }> {
    const databasePath = path.resolve(params.databasePath);
    const normalizedScope = normalizeScope(params.scope);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const existing = await fs.lstat(databasePath).catch(() => null);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw new Error(`Unsafe Mining history database path: ${databasePath}`);
    }

    let receipt: SatMiningHistoryMigrationReceipt | null = null;
    const lock = await acquireMigrationLock(`${databasePath}.migration.lock`);
    try {
      if (!existing) {
        const stagingPath = `${databasePath}.migrating`;
        try {
          await fs.rm(stagingPath, { force: true });
          const db = new DatabaseSync(stagingPath);
          applyDatabasePragmas(db);
          createSchema(db);
          const scopeId = ensureScope(db, normalizedScope);
          const counters: ImportCounters = {
            importedActions: 0,
            duplicateActions: 0,
            importedOutcomes: 0,
            duplicateOutcomes: 0,
            importedPlannerCycles: 0,
            duplicatePlannerCycles: 0,
            malformedRecords: 0,
            sourceCount: 0,
          };
          for (const source of params.migration?.sources ?? []) {
            await importNdjsonSource(db, scopeId, source, counters);
          }
          importRuntimeRecords(db, scopeId, params.migration, counters);
          incrementHistoryRevision(db);
          const integrityRow = db.prepare("PRAGMA integrity_check").get() as SqlRow;
          const integrity = String(Object.values(integrityRow)[0] ?? "");
          if (integrity !== "ok") {
            throw new Error(`Mining history integrity check failed: ${integrity || "unknown"}`);
          }
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          db.close();
          await fs.chmod(stagingPath, 0o660);
          await fs.rename(stagingPath, databasePath);
          await fsyncDirectory(path.dirname(databasePath));
          receipt = {
            schemaVersion: MINING_HISTORY_SCHEMA_VERSION,
            ...counters,
            integrity,
          };
        } catch (error) {
          await fs.rm(stagingPath, { force: true }).catch(() => {});
          throw error;
        }
      } else {
        const migrationDb = new DatabaseSync(databasePath);
        try {
          applyDatabasePragmas(migrationDb);
          createSchema(migrationDb);
          const scopeId = ensureScope(migrationDb, normalizedScope);
          const counters: ImportCounters = {
            importedActions: 0,
            duplicateActions: 0,
            importedOutcomes: 0,
            duplicateOutcomes: 0,
            importedPlannerCycles: 0,
            duplicatePlannerCycles: 0,
            malformedRecords: 0,
            sourceCount: 0,
          };
          for (const source of params.migration?.sources ?? []) {
            await importNdjsonSource(migrationDb, scopeId, source, counters);
          }
          importRuntimeRecords(migrationDb, scopeId, params.migration, counters);
          const changed =
            counters.importedActions +
              counters.importedOutcomes +
              counters.importedPlannerCycles +
              counters.malformedRecords >
            0;
          if (changed) {
            incrementHistoryRevision(migrationDb);
          }
          const integrityRow = migrationDb.prepare("PRAGMA integrity_check").get() as SqlRow;
          const integrity = String(Object.values(integrityRow)[0] ?? "");
          if (integrity !== "ok") {
            throw new Error(`Mining history integrity check failed: ${integrity || "unknown"}`);
          }
          migrationDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          if (changed || counters.sourceCount > 0) {
            receipt = {
              schemaVersion: MINING_HISTORY_SCHEMA_VERSION,
              ...counters,
              integrity,
            };
          }
        } finally {
          migrationDb.close();
        }
      }
    } finally {
      await releaseMigrationLock(lock);
    }

    const db = new DatabaseSync(databasePath);
    applyDatabasePragmas(db);
    createSchema(db);
    const scopeId = ensureScope(db, normalizedScope);
    return {
      store: new SatMiningHistoryStore(databasePath, db, normalizedScope, scopeId),
      migration: receipt,
    };
  }

  getScope(): SatMiningHistoryScope {
    return { ...this.scope };
  }

  getRevision(): number {
    return getHistoryRevision(this.db);
  }

  async rebindScope(scope: SatMiningHistoryScope): Promise<void> {
    await this.enqueueWrite(() => {
      const normalized = normalizeScope(scope);
      this.scopeId = ensureScope(this.db, normalized);
      this.scope = normalized;
    });
  }

  async appendActions(
    entries: readonly SatMiningRecentAction[],
    sourceLabel = "runtime",
  ): Promise<void> {
    const valid = entries.filter(isSatMiningRecentAction);
    if (valid.length === 0) {
      return;
    }
    await this.enqueueWrite(() => {
      const statement = actionInsertStatement(this.db);
      let changed = false;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const entry of valid) {
          changed = insertAction(statement, this.scopeId, entry, sourceLabel) || changed;
        }
        if (changed) {
          incrementHistoryRevision(this.db);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async appendPlannerOutcome(
    entry: SatPlannerOutcomeMemory,
    sourceLabel = "runtime",
  ): Promise<void> {
    if (!isSatPlannerOutcome(entry)) {
      return;
    }
    await this.enqueueWrite(() => {
      const statement = outcomeInsertStatement(this.db);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (insertOutcome(statement, this.scopeId, entry, sourceLabel)) {
          incrementHistoryRevision(this.db);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async appendPlannerCycle(entry: SatPlannerCycleRecord, sourceLabel = "runtime"): Promise<void> {
    if (!isSatPlannerCycle(entry)) {
      return;
    }
    await this.enqueueWrite(() => {
      const statement = plannerCycleInsertStatement(this.db);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (insertPlannerCycle(statement, this.scopeId, entry, sourceLabel)) {
          incrementHistoryRevision(this.db);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  readRecentActions(limit = 128): SatMiningRecentAction[] {
    const bounded = Math.max(1, Math.min(MINING_HISTORY_ACTION_PAGE_MAX, Math.floor(limit)));
    return (
      this.db
        .prepare(
          `SELECT sequence, payload_json
             FROM mining_event
            WHERE scope_id=?
            ORDER BY occurred_at_ms DESC, sequence DESC
            LIMIT ?`,
        )
        .all(this.scopeId, bounded) as SqlRow[]
    ).map(rowToAction);
  }

  readRecentPlannerOutcomes(limit = 4096): SatPlannerOutcomeMemory[] {
    const bounded = Math.max(1, Math.min(4096, Math.floor(limit)));
    return (
      this.db
        .prepare(
          `WITH ranked AS (
             SELECT sequence, cycle_id, payload_json,
                    ROW_NUMBER() OVER (
                      PARTITION BY cycle_id
                      ORDER BY recorded_at_ms DESC, sequence DESC
                    ) AS rank
               FROM planner_outcome
              WHERE scope_id=?
           )
           SELECT sequence, cycle_id, payload_json
             FROM ranked
            WHERE rank=1
            ORDER BY cycle_id DESC, sequence DESC
            LIMIT ?`,
        )
        .all(this.scopeId, bounded) as SqlRow[]
    ).map(rowToOutcome);
  }

  readRecentPlannerCycles(limit = 4096): SatPlannerCycleRecord[] {
    const bounded = Math.max(1, Math.min(4096, Math.floor(limit)));
    return (
      this.db
        .prepare(
          `WITH ranked AS (
             SELECT sequence, cycle_id, payload_json,
                    ROW_NUMBER() OVER (
                      PARTITION BY cycle_id
                      ORDER BY recorded_at_ms DESC, sequence DESC
                    ) AS rank
               FROM planner_cycle
              WHERE scope_id=?
           )
           SELECT sequence, cycle_id, payload_json
             FROM ranked
            WHERE rank=1
            ORDER BY cycle_id DESC, sequence DESC
            LIMIT ?`,
        )
        .all(this.scopeId, bounded) as SqlRow[]
    ).map(rowToPlannerCycle);
  }

  readCompletedCycleIds(actions: readonly string[]): number[] {
    const selected = [...new Set(actions.map((entry) => entry.trim()).filter(Boolean))];
    if (selected.length === 0) {
      return [];
    }
    const placeholders = selected.map(() => "?").join(", ");
    return (
      this.db
        .prepare(
          `SELECT DISTINCT cycle_id
             FROM mining_event
            WHERE scope_id=? AND status='success' AND cycle_id IS NOT NULL
              AND action IN (${placeholders})
            ORDER BY cycle_id ASC`,
        )
        .all(this.scopeId, ...selected) as SqlRow[]
    )
      .map((row) => Number(row.cycle_id))
      .filter((value) => Number.isSafeInteger(value) && value >= 0);
  }

  queryActions(params?: {
    window?: SatMiningHistoryWindow;
    limit?: number;
    cursor?: string | null;
  }): SatMiningActionPage {
    const window = params?.window ?? "all";
    const windowStartMs = historyWindowStartMs(window);
    const cursor = decodeActionCursor(params?.cursor);
    const limit = Math.max(
      1,
      Math.min(MINING_HISTORY_ACTION_PAGE_MAX, Math.floor(params?.limit ?? 100)),
    );
    const conditions = ["scope_id=?"];
    const args: Array<string | number> = [this.scopeId];
    if (windowStartMs != null) {
      conditions.push("occurred_at_ms>=?");
      args.push(windowStartMs);
    }
    if (cursor) {
      conditions.push("(occurred_at_ms<? OR (occurred_at_ms=? AND sequence<?))");
      args.push(cursor.occurredAtMs, cursor.occurredAtMs, cursor.sequence);
    }
    const rows = this.db
      .prepare(
        `SELECT sequence, occurred_at_ms, payload_json
           FROM mining_event
          WHERE ${conditions.join(" AND ")}
          ORDER BY occurred_at_ms DESC, sequence DESC
          LIMIT ?`,
      )
      .all(...args, limit + 1) as SqlRow[];
    const hasMore = rows.length > limit;
    const selectedRows = rows.slice(0, limit);
    const bounds = readTimeBounds(
      this.db,
      "mining_event",
      this.scopeId,
      "occurred_at_ms",
      windowStartMs,
    );
    const total = readTimeBounds(this.db, "mining_event", this.scopeId, "occurred_at_ms", null);
    const last = selectedRows.at(-1);
    return {
      walletId: this.scope.walletId,
      scope: this.getScope(),
      actions: selectedRows.map(rowToAction),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              occurredAtMs: Number(last.occurred_at_ms),
              sequence: Number(last.sequence),
            })
          : null,
      hasMore,
      matchingCount: bounds.count,
      totalStoredCount: total.count,
      windowStartAt: isoOrNull(windowStartMs),
      dataStartAt: isoOrNull(bounds.oldestAtMs),
      dataEndAt: isoOrNull(bounds.newestAtMs),
      oldestAvailableAt: isoOrNull(total.oldestAtMs),
      newestAvailableAt: isoOrNull(total.newestAtMs),
      historyRevision: this.getRevision(),
    };
  }

  queryOutcomes(params?: {
    window?: SatMiningHistoryWindow;
    limit?: number;
    cursor?: string | null;
  }): SatMiningOutcomePage {
    const window = params?.window ?? "all";
    const windowStartMs = historyWindowStartMs(window);
    const cursor = decodeOutcomeCursor(params?.cursor);
    const limit = Math.max(
      1,
      Math.min(MINING_HISTORY_OUTCOME_PAGE_MAX, Math.floor(params?.limit ?? 100)),
    );
    const conditions = ["scope_id=?"];
    const args: Array<string | number> = [this.scopeId];
    if (windowStartMs != null) {
      conditions.push("recorded_at_ms>=?");
      args.push(windowStartMs);
    }
    if (cursor) {
      conditions.push(
        `(recorded_at_ms<? OR
          (recorded_at_ms=? AND cycle_id<?) OR
          (recorded_at_ms=? AND cycle_id=? AND sequence<?))`,
      );
      args.push(
        cursor.recordedAtMs,
        cursor.recordedAtMs,
        cursor.cycleId,
        cursor.recordedAtMs,
        cursor.cycleId,
        cursor.sequence,
      );
    }
    const rows = this.db
      .prepare(
        `WITH ranked AS (
           SELECT sequence, cycle_id, recorded_at_ms, payload_json,
                  ROW_NUMBER() OVER (
                    PARTITION BY cycle_id
                    ORDER BY recorded_at_ms DESC, sequence DESC
                  ) AS rank
             FROM planner_outcome
            WHERE ${conditions.join(" AND ")}
         )
         SELECT sequence, cycle_id, recorded_at_ms, payload_json
           FROM ranked
          WHERE rank=1
          ORDER BY recorded_at_ms DESC, cycle_id DESC, sequence DESC
          LIMIT ?`,
      )
      .all(...args, limit + 1) as SqlRow[];
    const hasMore = rows.length > limit;
    const selectedRows = rows.slice(0, limit);
    const bounds = readOutcomeTimeBounds(this.db, this.scopeId, windowStartMs);
    const total = readOutcomeTimeBounds(this.db, this.scopeId, null);
    const last = selectedRows.at(-1);
    return {
      walletId: this.scope.walletId,
      scope: this.getScope(),
      outcomes: selectedRows.map(rowToOutcome),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              recordedAtMs: Number(last.recorded_at_ms),
              cycleId: Number(last.cycle_id),
              sequence: Number(last.sequence),
            })
          : null,
      hasMore,
      matchingCount: bounds.count,
      totalStoredCount: total.count,
      windowStartAt: isoOrNull(windowStartMs),
      dataStartAt: isoOrNull(bounds.oldestAtMs),
      dataEndAt: isoOrNull(bounds.newestAtMs),
      oldestAvailableAt: isoOrNull(total.oldestAtMs),
      newestAvailableAt: isoOrNull(total.newestAtMs),
      historyRevision: this.getRevision(),
    };
  }

  querySeries(params: {
    window: SatMiningHistoryWindow;
    maxPoints: number;
  }): SatMiningHistorySeries {
    const windowStartMs = historyWindowStartMs(params.window);
    const maxPoints = Math.max(1, Math.min(2048, Math.floor(params.maxPoints)));
    const bounds = readOutcomeTimeBounds(this.db, this.scopeId, windowStartMs);
    const total = readOutcomeTimeBounds(this.db, this.scopeId, null);
    if (bounds.count === 0) {
      return {
        walletId: this.scope.walletId,
        scope: this.getScope(),
        outcomes: [],
        totalStoredOutcomeCount: total.count,
        matchingOutcomeCount: 0,
        sampled: false,
        windowStartAt: isoOrNull(windowStartMs),
        dataStartAt: null,
        dataEndAt: null,
        historyRevision: this.getRevision(),
      };
    }
    const startMs = bounds.oldestAtMs ?? 0;
    const endMs = bounds.newestAtMs ?? startMs;
    const bucketMs = Math.max(1, Math.ceil((endMs - startMs + 1) / maxPoints));
    const conditions = ["scope_id=?"];
    const conditionArgs: Array<string | number> = [this.scopeId];
    if (windowStartMs != null) {
      conditions.push("recorded_at_ms>=?");
      conditionArgs.push(windowStartMs);
    }
    const rows = this.db
      .prepare(
        `WITH latest AS (
           SELECT sequence, cycle_id, recorded_at_ms, payload_json,
                  ROW_NUMBER() OVER (
                    PARTITION BY cycle_id
                    ORDER BY recorded_at_ms DESC, sequence DESC
                  ) AS rank
             FROM planner_outcome
            WHERE ${conditions.join(" AND ")}
         ),
         bucketed AS (
           SELECT MAX(sequence) AS sequence
             FROM latest
            WHERE rank=1
            GROUP BY CAST((recorded_at_ms - ?) / ? AS INTEGER)
         )
         SELECT latest.sequence, latest.cycle_id, latest.recorded_at_ms,
                latest.payload_json
           FROM latest
           JOIN bucketed ON bucketed.sequence=latest.sequence
          ORDER BY latest.recorded_at_ms DESC, latest.cycle_id DESC`,
      )
      .all(...conditionArgs, startMs, bucketMs) as SqlRow[];
    return {
      walletId: this.scope.walletId,
      scope: this.getScope(),
      outcomes: rows.map(rowToOutcome),
      totalStoredOutcomeCount: total.count,
      matchingOutcomeCount: bounds.count,
      sampled: rows.length < bounds.count,
      windowStartAt: isoOrNull(windowStartMs),
      dataStartAt: isoOrNull(bounds.oldestAtMs),
      dataEndAt: isoOrNull(bounds.newestAtMs),
      historyRevision: this.getRevision(),
    };
  }

  async clearHistory(): Promise<void> {
    await this.enqueueWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("DELETE FROM mining_event WHERE scope_id=?").run(this.scopeId);
        this.db.prepare("DELETE FROM planner_outcome WHERE scope_id=?").run(this.scopeId);
        this.db.prepare("DELETE FROM planner_cycle WHERE scope_id=?").run(this.scopeId);
        incrementHistoryRevision(this.db);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  integrityCheck(): string {
    const row = this.db.prepare("PRAGMA integrity_check").get() as SqlRow;
    return String(Object.values(row)[0] ?? "");
  }

  close(): void {
    this.checkpoint();
    this.db.close();
  }

  private async enqueueWrite(operation: () => void): Promise<void> {
    const next = this.writeChain.catch(() => {}).then(operation);
    this.writeChain = next;
    await next;
  }
}

export function resolveSatMiningHistoryDatabasePath(
  stateDir: string,
  walletStateKey: string,
): string {
  return path.join(stateDir, "sat-mining", "wallets", walletStateKey, "mining.sqlite");
}
