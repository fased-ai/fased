import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
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
import {
  assertSatSubmissionStateTransition,
  buildSatSubmissionRequestId,
  normalizeSatSubmissionRecord,
  satSubmissionLeaseDurationMs,
  satSubmissionLeaseIsLive,
  type SatSubmissionClaim,
  type SatSubmissionClaimParams,
  type SatSubmissionLedgerAdapter,
  type SatSubmissionReadAllParams,
  type SatSubmissionReadParams,
  type SatSubmissionRecord,
  type SatSubmissionUpdateParams,
} from "./submission-ledger.js";

const MINING_HISTORY_SCHEMA_VERSION = 2;
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
  preservePaths?: readonly string[];
  runtimeRecentActions?: readonly SatMiningRecentAction[];
  runtimePlannerOutcomes?: readonly SatPlannerOutcomeMemory[];
  runtimePlannerCycles?: readonly SatPlannerCycleRecord[];
  operationalState?: SatMiningOperationalState | null;
  auditArtifacts?: readonly unknown[];
  submissionRecords?: readonly unknown[];
};

export type SatMiningOperationalState = {
  pendingPlannerCycles?: readonly unknown[];
  roundExecution?: readonly unknown[];
  claimBacklog?: readonly unknown[];
  settlementPageParticipants?: readonly unknown[];
  settlementPageLookupTables?: readonly unknown[];
  workers?: Record<string, unknown>;
  runtimeMeta?: Record<string, unknown>;
};

export type SatMiningHistoryDeletionRequest = {
  kinds: readonly ("actions" | "outcomes" | "planner-cycles")[];
  fromAt?: string | null;
  toAt?: string | null;
};

export type SatMiningHistoryDeletionReceipt = {
  walletId: string;
  scopeKey: string;
  deletedActions: number;
  deletedOutcomes: number;
  deletedPlannerCycles: number;
  fromAt: string | null;
  toAt: string | null;
  historyRevision: number;
  deletedAt: string;
};

export type SatMiningDiskStatus = {
  databaseBytes: number;
  walBytes: number;
  availableBytes: number | null;
  warning: "none" | "low" | "critical";
  optionalCapitalCommitmentsAllowed: boolean;
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
  conflictRecords: number;
  quarantinedRecords: number;
  archiveManifestPath: string | null;
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
  conflictRecords: number;
  quarantinedRecords: number;
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

function migrationScope(scope: SatMiningHistoryScope): SatMiningHistoryScope {
  const normalized = normalizeScope(scope);
  const provable =
    normalized.network !== "legacy-unknown" &&
    Boolean(normalized.programId) &&
    Boolean(normalized.mintAddress);
  if (provable) {
    return normalized;
  }
  return {
    walletId: normalized.walletId,
    authority: null,
    providerId: normalized.providerId,
    network: "legacy-unknown",
    genesisHash: null,
    programId: null,
    mintAddress: null,
    mintProgramId: null,
    manifestDigest: null,
    protocolVersion: "legacy-unknown",
  };
}

function scopeKey(scope: SatMiningHistoryScope): string {
  return sha256(canonicalJson(normalizeScope(scope)));
}

function bindingKey(scope: SatMiningHistoryScope): string {
  return sha256(
    canonicalJson({
      walletId: scope.walletId,
      authority: normalizeNullable(scope.authority),
      providerId: normalizeNullable(scope.providerId),
    }),
  );
}

function chainScopeKey(scope: SatMiningHistoryScope): string {
  return sha256(
    canonicalJson({
      network: scope.network,
      genesisHash: normalizeNullable(scope.genesisHash),
      programId: normalizeNullable(scope.programId),
      mintAddress: normalizeNullable(scope.mintAddress),
      mintProgramId: normalizeNullable(scope.mintProgramId),
      manifestDigest: normalizeNullable(scope.manifestDigest),
      protocolVersion: normalizeNullable(scope.protocolVersion),
    }),
  );
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

    CREATE TABLE IF NOT EXISTS wallet_binding (
      id INTEGER PRIMARY KEY,
      binding_key TEXT NOT NULL UNIQUE,
      wallet_id TEXT NOT NULL,
      authority TEXT,
      provider_id TEXT,
      first_seen_ms INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS chain_scope (
      id INTEGER PRIMARY KEY,
      scope_key TEXT NOT NULL UNIQUE,
      network TEXT NOT NULL,
      genesis_hash TEXT,
      program_id TEXT,
      mint_address TEXT,
      mint_program_id TEXT,
      manifest_digest TEXT,
      protocol_version TEXT,
      first_seen_ms INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS history_scope (
      id INTEGER PRIMARY KEY,
      scope_key TEXT NOT NULL UNIQUE,
      binding_id INTEGER REFERENCES wallet_binding(id),
      chain_scope_id INTEGER REFERENCES chain_scope(id),
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
      logical_key TEXT NOT NULL,
      previous_digest TEXT,
      event_digest TEXT NOT NULL,
      source_label TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS mining_event_scope_time
      ON mining_event(scope_id, occurred_at_ms DESC, sequence DESC);
    CREATE INDEX IF NOT EXISTS mining_event_scope_cycle
      ON mining_event(scope_id, cycle_id, occurred_at_ms DESC);
    CREATE INDEX IF NOT EXISTS mining_event_scope_logical
      ON mining_event(scope_id, logical_key, sequence ASC);

    CREATE TABLE IF NOT EXISTS planner_outcome (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      cycle_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      event_digest TEXT NOT NULL,
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
      revision INTEGER NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      event_digest TEXT NOT NULL,
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
      oldest_at_ms INTEGER,
      newest_at_ms INTEGER,
      scope_key TEXT NOT NULL,
      imported_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS corruption_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_label TEXT NOT NULL,
      source_path TEXT NOT NULL,
      line_number INTEGER,
      byte_offset INTEGER,
      record_sha256 TEXT NOT NULL,
      record_text TEXT NOT NULL,
      reason TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS migration_conflict (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      record_kind TEXT NOT NULL,
      logical_key TEXT NOT NULL,
      prior_event_id TEXT NOT NULL,
      conflicting_event_id TEXT NOT NULL,
      source_label TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      UNIQUE(record_kind, logical_key, conflicting_event_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS round_execution (
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      state_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(scope_id, state_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS pending_planner_cycle (
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      state_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(scope_id, state_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS claim_backlog (
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      state_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(scope_id, state_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS settlement_state (
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      state_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(scope_id, state_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS worker_state (
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      worker_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(scope_id, worker_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS runtime_meta (
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      meta_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(scope_id, meta_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS audit_artifact (
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      artifact_key TEXT NOT NULL,
      artifact_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(scope_id, artifact_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS submission_record (
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      request_id TEXT NOT NULL,
      intent_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(scope_id, request_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS submission_transition (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      request_id TEXT NOT NULL,
      transition_kind TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      transition_digest TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_submission_transition_scope_request
      ON submission_transition(scope_id, request_id, sequence);

    CREATE TABLE IF NOT EXISTS history_deletion_receipt (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id INTEGER NOT NULL REFERENCES history_scope(id),
      request_digest TEXT NOT NULL UNIQUE,
      deleted_actions INTEGER NOT NULL,
      deleted_outcomes INTEGER NOT NULL,
      deleted_planner_cycles INTEGER NOT NULL,
      from_at_ms INTEGER,
      to_at_ms INTEGER,
      deleted_at_ms INTEGER NOT NULL
    ) STRICT;
  `);
  const schemaStatement = db.prepare(
    "INSERT INTO mining_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO NOTHING",
  );
  schemaStatement.run(String(MINING_HISTORY_SCHEMA_VERSION));
  db.prepare(
    "INSERT INTO mining_meta(key, value) VALUES('history_revision', '0') ON CONFLICT(key) DO NOTHING",
  ).run();
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(table),
  );
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  if (!tableExists(db, table)) {
    return new Set();
  }
  return new Set(
    (db.prepare(`PRAGMA table_info("${table}")`).all() as SqlRow[]).map((row) => String(row.name)),
  );
}

function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  declaration: string,
): void {
  if (!tableColumns(db, table).has(column)) {
    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${declaration}`);
  }
}

function rebuildHistoryChains(db: DatabaseSync): void {
  const actionRows = db
    .prepare(
      `SELECT sequence, event_id, scope_id, payload_json
         FROM mining_event
        ORDER BY scope_id ASC, sequence ASC`,
    )
    .all() as SqlRow[];
  const actionHeads = new Map<number, string | null>();
  const updateAction = db.prepare(
    `UPDATE mining_event
        SET logical_key=?, previous_digest=?, event_digest=?
      WHERE sequence=?`,
  );
  for (const row of actionRows) {
    const scopeId = Number(row.scope_id);
    const payloadJson = String(row.payload_json);
    const parsed = JSON.parse(payloadJson) as unknown;
    const logicalKey = isSatMiningRecentAction(parsed)
      ? actionLogicalKey(parsed)
      : sha256(payloadJson);
    const previous = actionHeads.get(scopeId) ?? null;
    const eventDigest = nextHistoryDigest(
      "action",
      scopeId,
      previous,
      String(row.event_id),
      payloadJson,
    );
    updateAction.run(logicalKey, previous, eventDigest, Number(row.sequence));
    actionHeads.set(scopeId, eventDigest);
  }
  for (const [scopeId, digest] of actionHeads) {
    if (digest) {
      writeHistoryHead(db, scopeId, "action", digest);
    }
  }

  const rebuildPlanner = (
    table: "planner_outcome" | "planner_cycle",
    kind: "outcome" | "planner-cycle",
  ) => {
    const rows = db
      .prepare(
        `SELECT sequence, event_id, scope_id, cycle_id, payload_json
           FROM "${table}"
          ORDER BY scope_id ASC, sequence ASC`,
      )
      .all() as SqlRow[];
    const heads = new Map<number, string | null>();
    const revisions = new Map<string, number>();
    const update = db.prepare(`UPDATE "${table}" SET revision=?, event_digest=? WHERE sequence=?`);
    for (const row of rows) {
      const scopeId = Number(row.scope_id);
      const revisionKey = `${scopeId}:${Number(row.cycle_id)}`;
      const revision = (revisions.get(revisionKey) ?? 0) + 1;
      const previous = heads.get(scopeId) ?? null;
      const eventDigest = nextHistoryDigest(
        kind,
        scopeId,
        previous,
        String(row.event_id),
        String(row.payload_json),
      );
      update.run(revision, eventDigest, Number(row.sequence));
      revisions.set(revisionKey, revision);
      heads.set(scopeId, eventDigest);
    }
    for (const [scopeId, digest] of heads) {
      if (digest) {
        writeHistoryHead(db, scopeId, kind, digest);
      }
    }
  };
  rebuildPlanner("planner_outcome", "outcome");
  rebuildPlanner("planner_cycle", "planner-cycle");
}

function migrateExistingSchema(db: DatabaseSync): void {
  if (!tableExists(db, "mining_meta")) {
    return;
  }
  const schemaRow = db.prepare("SELECT value FROM mining_meta WHERE key='schema_version'").get() as
    | SqlRow
    | undefined;
  const schemaVersion = Number(schemaRow?.value ?? 1);
  if (schemaVersion === MINING_HISTORY_SCHEMA_VERSION) {
    return;
  }
  if (schemaVersion !== 1) {
    throw new Error(`Mining history schema ${schemaVersion || "unknown"} is unsupported`);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    addColumnIfMissing(db, "history_scope", "binding_id", "INTEGER");
    addColumnIfMissing(db, "history_scope", "chain_scope_id", "INTEGER");
    addColumnIfMissing(db, "mining_event", "logical_key", "TEXT");
    addColumnIfMissing(db, "mining_event", "previous_digest", "TEXT");
    addColumnIfMissing(db, "mining_event", "event_digest", "TEXT");
    addColumnIfMissing(db, "planner_outcome", "revision", "INTEGER");
    addColumnIfMissing(db, "planner_outcome", "event_digest", "TEXT");
    addColumnIfMissing(db, "planner_cycle", "revision", "INTEGER");
    addColumnIfMissing(db, "planner_cycle", "event_digest", "TEXT");
    addColumnIfMissing(db, "migration_source", "oldest_at_ms", "INTEGER");
    addColumnIfMissing(db, "migration_source", "newest_at_ms", "INTEGER");
    addColumnIfMissing(db, "migration_source", "scope_key", "TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing(db, "corruption_record", "record_text", "TEXT NOT NULL DEFAULT ''");
    createSchema(db);
    const scopes = db.prepare("SELECT id FROM history_scope ORDER BY id ASC").all() as SqlRow[];
    for (const row of scopes) {
      const id = Number(row.id);
      const selected = readScope(db, id);
      const walletKey = bindingKey(selected);
      const deploymentKey = chainScopeKey(selected);
      const now = Date.now();
      db.prepare(
        `INSERT INTO wallet_binding(
           binding_key, wallet_id, authority, provider_id, first_seen_ms, last_seen_ms
         ) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(binding_key) DO UPDATE SET last_seen_ms=excluded.last_seen_ms`,
      ).run(
        walletKey,
        selected.walletId,
        selected.authority ?? null,
        selected.providerId ?? null,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO chain_scope(
           scope_key, network, genesis_hash, program_id, mint_address,
           mint_program_id, manifest_digest, protocol_version, first_seen_ms,
           last_seen_ms
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET last_seen_ms=excluded.last_seen_ms`,
      ).run(
        deploymentKey,
        selected.network,
        selected.genesisHash ?? null,
        selected.programId ?? null,
        selected.mintAddress ?? null,
        selected.mintProgramId ?? null,
        selected.manifestDigest ?? null,
        selected.protocolVersion ?? null,
        now,
        now,
      );
      const wallet = db
        .prepare("SELECT id FROM wallet_binding WHERE binding_key=?")
        .get(walletKey) as SqlRow;
      const deployment = db
        .prepare("SELECT id FROM chain_scope WHERE scope_key=?")
        .get(deploymentKey) as SqlRow;
      db.prepare("UPDATE history_scope SET binding_id=?, chain_scope_id=? WHERE id=?").run(
        Number(wallet.id),
        Number(deployment.id),
        id,
      );
    }
    rebuildHistoryChains(db);
    db.prepare("UPDATE mining_meta SET value=? WHERE key='schema_version'").run(
      String(MINING_HISTORY_SCHEMA_VERSION),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
  const now = Date.now();
  const walletBindingKey = bindingKey(scope);
  db.prepare(
    `INSERT INTO wallet_binding(
       binding_key, wallet_id, authority, provider_id, first_seen_ms, last_seen_ms
     ) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(binding_key) DO UPDATE SET last_seen_ms=excluded.last_seen_ms`,
  ).run(
    walletBindingKey,
    scope.walletId,
    scope.authority ?? null,
    scope.providerId ?? null,
    now,
    now,
  );
  const walletBinding = db
    .prepare("SELECT id FROM wallet_binding WHERE binding_key=?")
    .get(walletBindingKey) as SqlRow | undefined;
  const bindingId = Number(walletBinding?.id);
  if (!Number.isSafeInteger(bindingId) || bindingId <= 0) {
    throw new Error("Failed to resolve Mining Wallet binding");
  }
  const deploymentKey = chainScopeKey(scope);
  db.prepare(
    `INSERT INTO chain_scope(
       scope_key, network, genesis_hash, program_id, mint_address,
       mint_program_id, manifest_digest, protocol_version, first_seen_ms,
       last_seen_ms
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_key) DO UPDATE SET last_seen_ms=excluded.last_seen_ms`,
  ).run(
    deploymentKey,
    scope.network,
    scope.genesisHash ?? null,
    scope.programId ?? null,
    scope.mintAddress ?? null,
    scope.mintProgramId ?? null,
    scope.manifestDigest ?? null,
    scope.protocolVersion ?? null,
    now,
    now,
  );
  const chainScope = db
    .prepare("SELECT id FROM chain_scope WHERE scope_key=?")
    .get(deploymentKey) as SqlRow | undefined;
  const chainScopeId = Number(chainScope?.id);
  if (!Number.isSafeInteger(chainScopeId) || chainScopeId <= 0) {
    throw new Error("Failed to resolve Mining chain scope");
  }
  db.prepare(
    `INSERT INTO history_scope(
       scope_key, binding_id, chain_scope_id, wallet_id, authority, provider_id,
       network, genesis_hash, program_id, mint_address, mint_program_id,
       manifest_digest, protocol_version, created_at_ms
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_key) DO NOTHING`,
  ).run(
    key,
    bindingId,
    chainScopeId,
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
    now,
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

function actionLogicalKey(entry: SatMiningRecentAction): string {
  return sha256(
    canonicalJson({
      at: entry.at,
      action: entry.action,
      cycleId: entry.cycleId ?? null,
      txHash: entry.txHash ?? null,
      status: entry.status,
    }),
  );
}

function historyHeadKey(scopeId: number, kind: "action" | "outcome" | "planner-cycle"): string {
  return `history_head:${scopeId}:${kind}`;
}

function readHistoryHead(
  db: DatabaseSync,
  scopeId: number,
  kind: "action" | "outcome" | "planner-cycle",
): string | null {
  const row = db
    .prepare("SELECT value FROM mining_meta WHERE key=?")
    .get(historyHeadKey(scopeId, kind)) as SqlRow | undefined;
  return normalizeNullable(row?.value);
}

function writeHistoryHead(
  db: DatabaseSync,
  scopeId: number,
  kind: "action" | "outcome" | "planner-cycle",
  digest: string,
): void {
  db.prepare(
    `INSERT INTO mining_meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(historyHeadKey(scopeId, kind), digest);
}

function nextHistoryDigest(
  kind: "action" | "outcome" | "planner-cycle",
  scopeId: number,
  previousDigest: string | null,
  eventId: string,
  payloadJson: string,
): string {
  return `sha256:${sha256(
    canonicalJson({
      kind,
      scopeId,
      previousDigest,
      eventId,
      payloadSha256: sha256(payloadJson),
    }),
  )}`;
}

function insertAction(
  db: DatabaseSync,
  statement: StatementSync,
  scopeId: number,
  entry: SatMiningRecentAction,
  sourceLabel: string,
): boolean {
  const eventId = actionEventId(scopeId, entry);
  const payloadJson = canonicalJson(entry);
  const previousDigest = readHistoryHead(db, scopeId, "action");
  const eventDigest = nextHistoryDigest("action", scopeId, previousDigest, eventId, payloadJson);
  const result = statement.run(
    eventId,
    scopeId,
    Date.parse(entry.at),
    entry.action,
    entry.cycleId ?? null,
    entry.txHash ?? null,
    entry.status,
    entry.complete == null ? null : entry.complete ? 1 : 0,
    entry.message ?? null,
    actionLogicalKey(entry),
    previousDigest,
    eventDigest,
    sourceLabel,
    payloadJson,
  );
  const changed = Number(result.changes) > 0;
  if (changed) {
    writeHistoryHead(db, scopeId, "action", eventDigest);
  }
  return changed;
}

function insertOutcome(
  db: DatabaseSync,
  statement: StatementSync,
  scopeId: number,
  entry: SatPlannerOutcomeMemory,
  sourceLabel: string,
): boolean {
  const eventId = plannerOutcomeEventId(scopeId, entry);
  const payloadJson = canonicalJson(entry);
  const previousDigest = readHistoryHead(db, scopeId, "outcome");
  const eventDigest = nextHistoryDigest("outcome", scopeId, previousDigest, eventId, payloadJson);
  const revisionRow = db
    .prepare(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM planner_outcome WHERE scope_id=? AND cycle_id=?",
    )
    .get(scopeId, entry.cycleId) as SqlRow;
  const revision = Number(revisionRow.revision ?? 0) + 1;
  const result = statement.run(
    eventId,
    scopeId,
    entry.cycleId,
    revision,
    Date.parse(entry.recordedAt),
    eventDigest,
    sourceLabel,
    payloadJson,
  );
  const changed = Number(result.changes) > 0;
  if (changed) {
    writeHistoryHead(db, scopeId, "outcome", eventDigest);
  }
  return changed;
}

function insertPlannerCycle(
  db: DatabaseSync,
  statement: StatementSync,
  scopeId: number,
  entry: SatPlannerCycleRecord,
  sourceLabel: string,
): boolean {
  const eventId = plannerCycleEventId(scopeId, entry);
  const payloadJson = canonicalJson(entry);
  const previousDigest = readHistoryHead(db, scopeId, "planner-cycle");
  const eventDigest = nextHistoryDigest(
    "planner-cycle",
    scopeId,
    previousDigest,
    eventId,
    payloadJson,
  );
  const revisionRow = db
    .prepare(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM planner_cycle WHERE scope_id=? AND cycle_id=?",
    )
    .get(scopeId, entry.cycleId) as SqlRow;
  const revision = Number(revisionRow.revision ?? 0) + 1;
  const result = statement.run(
    eventId,
    scopeId,
    entry.cycleId,
    revision,
    Date.parse(entry.recordedAt),
    eventDigest,
    sourceLabel,
    payloadJson,
  );
  const changed = Number(result.changes) > 0;
  if (changed) {
    writeHistoryHead(db, scopeId, "planner-cycle", eventDigest);
  }
  return changed;
}

function actionInsertStatement(db: DatabaseSync): StatementSync {
  return db.prepare(
    `INSERT INTO mining_event(
       event_id, scope_id, occurred_at_ms, action, cycle_id, tx_hash, status,
       complete, message, logical_key, previous_digest, event_digest,
       source_label, payload_json
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO NOTHING`,
  );
}

function outcomeInsertStatement(db: DatabaseSync): StatementSync {
  return db.prepare(
    `INSERT INTO planner_outcome(
       event_id, scope_id, cycle_id, revision, recorded_at_ms, event_digest,
       source_label, payload_json
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO NOTHING`,
  );
}

function plannerCycleInsertStatement(db: DatabaseSync): StatementSync {
  return db.prepare(
    `INSERT INTO planner_cycle(
       event_id, scope_id, cycle_id, revision, recorded_at_ms, event_digest,
       source_label, payload_json
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
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

async function copyFileStreaming(sourcePath: string, destinationPath: string): Promise<void> {
  const source = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const destination = await fs.open(destinationPath, "wx", 0o440);
  try {
    const stat = await source.stat();
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      );
      if (bytesRead <= 0) {
        throw new Error(`Mining legacy source changed during archival: ${sourcePath}`);
      }
      await destination.write(buffer, 0, bytesRead, offset);
      offset += bytesRead;
    }
    await destination.sync();
  } finally {
    await Promise.all([source.close(), destination.close()]);
  }
}

async function archiveLegacySources(
  databasePath: string,
  migration: SatMiningHistoryMigrationInput | undefined,
): Promise<string | null> {
  const selectedPaths = [
    ...(migration?.sources ?? []).map((source) => source.path),
    ...(migration?.preservePaths ?? []),
  ];
  const uniquePaths = [...new Set(selectedPaths.map((entry) => path.resolve(entry)))];
  const records = [];
  for (const sourcePath of uniquePaths) {
    const stat = await fs.lstat(sourcePath).catch(() => null);
    if (!stat) {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Unsafe Mining legacy source: ${sourcePath}`);
    }
    records.push({
      sourcePath,
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      sha256: await streamSha256(sourcePath),
    });
  }
  if (records.length === 0) {
    return null;
  }
  const archiveDigest = sha256(canonicalJson(records));
  const archiveDir = path.join(
    path.dirname(databasePath),
    "legacy-archive",
    `migration-${archiveDigest}`,
  );
  const manifestPath = path.join(archiveDir, "manifest.json");
  const existingManifest = await fs.lstat(manifestPath).catch(() => null);
  if (existingManifest) {
    if (!existingManifest.isFile() || existingManifest.isSymbolicLink()) {
      throw new Error(`Unsafe Mining legacy archive manifest: ${manifestPath}`);
    }
    return manifestPath;
  }
  const available = await fs.statfs(path.dirname(databasePath)).catch(() => null);
  const requiredBytes = records.reduce((sum, record) => sum + record.size, 0);
  const availableBytes = available ? Number(available.bavail) * Number(available.bsize) : null;
  if (availableBytes != null && availableBytes < requiredBytes + 64 * 1024 * 1024) {
    throw new Error(
      `Insufficient disk space to preserve Mining legacy history (${requiredBytes} bytes required)`,
    );
  }
  await fs.mkdir(archiveDir, { recursive: true, mode: 0o750 });
  const archived = [];
  for (const [index, record] of records.entries()) {
    const destinationName = `${String(index).padStart(3, "0")}-${path.basename(record.sourcePath)}`;
    const destinationPath = path.join(archiveDir, destinationName);
    try {
      await fs.copyFile(
        record.sourcePath,
        destinationPath,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      );
      await fs.chmod(destinationPath, 0o440);
      const handle = await fs.open(destinationPath, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw error;
      }
      await fs.rm(destinationPath, { force: true }).catch(() => {});
      await copyFileStreaming(record.sourcePath, destinationPath);
    }
    const archivedDigest = await streamSha256(destinationPath);
    if (archivedDigest !== record.sha256) {
      throw new Error(`Mining legacy archive digest mismatch: ${record.sourcePath}`);
    }
    archived.push({ ...record, archiveName: destinationName });
  }
  const manifest = {
    schemaVersion: 1,
    archiveDigest: `sha256:${archiveDigest}`,
    createdAt: new Date().toISOString(),
    sources: archived,
  };
  const temporaryManifest = `${manifestPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o440,
    flag: "wx",
  });
  const manifestHandle = await fs.open(temporaryManifest, "r");
  try {
    await manifestHandle.sync();
  } finally {
    await manifestHandle.close();
  }
  await fs.rename(temporaryManifest, manifestPath);
  await fsyncDirectory(archiveDir);
  await fsyncDirectory(path.dirname(archiveDir));
  return manifestPath;
}

const STALE_MINING_TEMP_PATTERN =
  /^(?:runtime-store|audit-store|planner-history|action-history|submission-ledger)(?:\.[A-Za-z0-9._-]+)?\.\d+\.\d+\.tmp$/u;

async function quarantineStaleMiningTemps(databasePath: string): Promise<number> {
  const walletDir = path.dirname(databasePath);
  const quarantineDir = path.join(walletDir, "corruption-quarantine");
  let quarantined = 0;
  for (const name of await fs.readdir(walletDir).catch(() => [])) {
    if (!STALE_MINING_TEMP_PATTERN.test(name)) {
      continue;
    }
    const candidate = path.join(walletDir, name);
    const stat = await fs.lstat(candidate);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      Date.now() - stat.mtimeMs < MINING_HISTORY_MIGRATION_LOCK_STALE_MS
    ) {
      continue;
    }
    await fs.mkdir(quarantineDir, { recursive: true, mode: 0o750 });
    const destination = path.join(
      quarantineDir,
      `${name}.${sha256(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`).slice(0, 16)}`,
    );
    await fs.rename(candidate, destination);
    quarantined += 1;
  }
  if (quarantined > 0) {
    await fsyncDirectory(quarantineDir);
    await fsyncDirectory(walletDir);
  }
  return quarantined;
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
       record_text, reason, observed_at_ms
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.sourceLabel,
    params.sourcePath,
    params.lineNumber ?? null,
    params.byteOffset ?? null,
    sha256(params.record),
    params.record,
    params.reason,
    Date.now(),
  );
}

function recordActionConflict(
  db: DatabaseSync,
  scopeId: number,
  entry: SatMiningRecentAction,
  sourceLabel: string,
): boolean {
  const logicalKey = actionLogicalKey(entry);
  const conflictingEventId = actionEventId(scopeId, entry);
  const prior = db
    .prepare(
      `SELECT event_id
         FROM mining_event
        WHERE scope_id=? AND logical_key=? AND event_id<>?
        ORDER BY sequence ASC
        LIMIT 1`,
    )
    .get(scopeId, logicalKey, conflictingEventId) as SqlRow | undefined;
  if (!prior) {
    return false;
  }
  const result = db
    .prepare(
      `INSERT INTO migration_conflict(
         scope_id, record_kind, logical_key, prior_event_id,
         conflicting_event_id, source_label, observed_at_ms
       ) VALUES(?, 'action', ?, ?, ?, ?, ?)
       ON CONFLICT(record_kind, logical_key, conflicting_event_id) DO NOTHING`,
    )
    .run(scopeId, logicalKey, String(prior.event_id), conflictingEventId, sourceLabel, Date.now());
  return Number(result.changes) > 0;
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
  let byteOffset = 0;
  let oldestAtMs: number | null = null;
  let newestAtMs: number | null = null;
  let batchCount = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for await (const line of lines) {
      lineNumber += 1;
      const trimmed = line.trim();
      const lineByteOffset = byteOffset;
      byteOffset += Buffer.byteLength(line, "utf8") + 1;
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
          byteOffset: lineByteOffset,
          record: trimmed,
          reason: "invalid-json",
        });
        continue;
      }

      let inserted = false;
      if (source.kind === "action" && isSatMiningRecentAction(parsed)) {
        if (recordActionConflict(db, scopeId, parsed, source.label)) {
          counters.conflictRecords += 1;
        }
        inserted = insertAction(db, actionStatement, scopeId, parsed, source.label);
        counters.importedActions += inserted ? 1 : 0;
        counters.duplicateActions += inserted ? 0 : 1;
        const atMs = Date.parse(parsed.at);
        oldestAtMs = oldestAtMs == null ? atMs : Math.min(oldestAtMs, atMs);
        newestAtMs = newestAtMs == null ? atMs : Math.max(newestAtMs, atMs);
      } else if (source.kind === "planner" && isSatPlannerOutcome(parsed)) {
        inserted = insertOutcome(db, outcomeStatement, scopeId, parsed, source.label);
        counters.importedOutcomes += inserted ? 1 : 0;
        counters.duplicateOutcomes += inserted ? 0 : 1;
        const atMs = Date.parse(parsed.recordedAt);
        oldestAtMs = oldestAtMs == null ? atMs : Math.min(oldestAtMs, atMs);
        newestAtMs = newestAtMs == null ? atMs : Math.max(newestAtMs, atMs);
      } else {
        malformedRecords += 1;
        counters.malformedRecords += 1;
        recordCorruption(db, {
          sourceLabel: source.label,
          sourcePath: source.path,
          lineNumber,
          byteOffset: lineByteOffset,
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
        batchCount = 0;
        await immediate();
        db.exec("BEGIN IMMEDIATE");
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
       oldest_at_ms, newest_at_ms, scope_key, imported_at_ms
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_label) DO UPDATE SET
       source_path=excluded.source_path,
       source_kind=excluded.source_kind,
       source_size=excluded.source_size,
       source_mtime_ms=excluded.source_mtime_ms,
       source_sha256=excluded.source_sha256,
       valid_records=excluded.valid_records,
       duplicate_records=excluded.duplicate_records,
       malformed_records=excluded.malformed_records,
       oldest_at_ms=excluded.oldest_at_ms,
       newest_at_ms=excluded.newest_at_ms,
       scope_key=excluded.scope_key,
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
    oldestAtMs,
    newestAtMs,
    String(
      (
        db.prepare("SELECT scope_key FROM history_scope WHERE id=?").get(scopeId) as
          | SqlRow
          | undefined
      )?.scope_key ?? "",
    ),
    Date.now(),
  );
  counters.sourceCount += 1;
  counters.quarantinedRecords += malformedRecords;
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
      const inserted = insertAction(
        db,
        actionStatement,
        scopeId,
        entry,
        "runtime-store:recentActions",
      );
      counters.importedActions += inserted ? 1 : 0;
      counters.duplicateActions += inserted ? 0 : 1;
    }
    for (const entry of input?.runtimePlannerOutcomes ?? []) {
      if (!isSatPlannerOutcome(entry)) {
        counters.malformedRecords += 1;
        continue;
      }
      const inserted = insertOutcome(
        db,
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
        db,
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

function stateKey(entry: unknown, keys: readonly string[], fallbackIndex: number): string {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    for (const key of keys) {
      const value = (entry as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        return String(value);
      }
    }
  }
  return `record-${fallbackIndex}-${sha256(canonicalJson(entry)).slice(0, 24)}`;
}

function replaceJsonRows(
  db: DatabaseSync,
  table: "round_execution" | "pending_planner_cycle" | "claim_backlog" | "settlement_state",
  scopeId: number,
  entries: readonly unknown[],
  keyFields: readonly string[],
): void {
  db.prepare(`DELETE FROM ${table} WHERE scope_id=?`).run(scopeId);
  const statement = db.prepare(
    `INSERT INTO ${table}(scope_id, state_key, payload_json, updated_at_ms)
     VALUES(?, ?, ?, ?)`,
  );
  const now = Date.now();
  entries.forEach((entry, index) => {
    statement.run(scopeId, stateKey(entry, keyFields, index), canonicalJson(entry), now);
  });
}

function replaceOperationalStateRows(
  db: DatabaseSync,
  scopeId: number,
  state: SatMiningOperationalState | null | undefined,
): void {
  if (!state) {
    return;
  }
  replaceJsonRows(db, "round_execution", scopeId, state.roundExecution ?? [], ["roundKey"]);
  replaceJsonRows(db, "pending_planner_cycle", scopeId, state.pendingPlannerCycles ?? [], [
    "cycleId",
  ]);
  replaceJsonRows(db, "claim_backlog", scopeId, state.claimBacklog ?? [], ["cycleId"]);
  replaceJsonRows(
    db,
    "settlement_state",
    scopeId,
    [
      ...(state.settlementPageParticipants ?? []).map((entry) => ({
        stateKey: `participants:${stateKey(entry, ["cacheKey"], 0)}`,
        kind: "participants",
        ...(entry && typeof entry === "object" ? entry : { value: entry }),
      })),
      ...(state.settlementPageLookupTables ?? []).map((entry) => ({
        stateKey: `lookup-table:${stateKey(entry, ["cacheKey"], 0)}`,
        kind: "lookup-table",
        ...(entry && typeof entry === "object" ? entry : { value: entry }),
      })),
    ],
    ["stateKey"],
  );
  db.prepare("DELETE FROM worker_state WHERE scope_id=?").run(scopeId);
  const workerStatement = db.prepare(
    `INSERT INTO worker_state(scope_id, worker_key, payload_json, updated_at_ms)
     VALUES(?, ?, ?, ?)`,
  );
  for (const [key, value] of Object.entries(state.workers ?? {}).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    workerStatement.run(scopeId, key, canonicalJson(value), Date.now());
  }
  db.prepare("DELETE FROM runtime_meta WHERE scope_id=?").run(scopeId);
  const metaStatement = db.prepare(
    `INSERT INTO runtime_meta(scope_id, meta_key, payload_json, updated_at_ms)
     VALUES(?, ?, ?, ?)`,
  );
  for (const [key, value] of Object.entries(state.runtimeMeta ?? {}).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    metaStatement.run(scopeId, key, canonicalJson(value), Date.now());
  }
}

function upsertAuditArtifactRows(
  db: DatabaseSync,
  scopeId: number,
  artifacts: readonly unknown[],
): void {
  const statement = db.prepare(
    `INSERT INTO audit_artifact(
       scope_id, artifact_key, artifact_digest, payload_json, updated_at_ms
     ) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(scope_id, artifact_key) DO UPDATE SET
       artifact_digest=excluded.artifact_digest,
       payload_json=excluded.payload_json,
       updated_at_ms=excluded.updated_at_ms`,
  );
  artifacts.forEach((artifact, index) => {
    const payload = canonicalJson(artifact);
    statement.run(
      scopeId,
      stateKey(artifact, ["roundKey", "artifactId", "id"], index),
      `sha256:${sha256(payload)}`,
      payload,
      Date.now(),
    );
  });
}

function upsertSubmissionRows(
  db: DatabaseSync,
  scopeId: number,
  records: readonly unknown[],
): void {
  const statement = db.prepare(
    `INSERT INTO submission_record(
       scope_id, request_id, intent_digest, state, payload_json, updated_at_ms
     ) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_id, request_id) DO NOTHING`,
  );
  records.forEach((record, index) => {
    const candidate =
      record && typeof record === "object" && !Array.isArray(record)
        ? (record as Record<string, unknown>)
        : {};
    const requestId = stateKey(record, ["requestId"], index);
    const intentDigest = String(candidate.intentDigest ?? "");
    const state = String(candidate.state ?? "unknown");
    statement.run(scopeId, requestId, intentDigest, state, canonicalJson(record), Date.now());
  });
}

function readSubmissionRecordRow(row: SqlRow | undefined): SatSubmissionRecord | null {
  if (!row) {
    return null;
  }
  const parsed = normalizeSatSubmissionRecord(JSON.parse(String(row.payload_json)) as unknown);
  if (!parsed) {
    throw new Error(`Corrupt Mining submission record ${String(row.request_id ?? "unknown")}`);
  }
  return parsed;
}

function writeSubmissionRecord(
  db: DatabaseSync,
  scopeId: number,
  record: SatSubmissionRecord,
): void {
  db.prepare(
    `INSERT INTO submission_record(
       scope_id, request_id, intent_digest, state, payload_json, updated_at_ms
     ) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_id, request_id) DO UPDATE SET
       intent_digest=excluded.intent_digest,
       state=excluded.state,
       payload_json=excluded.payload_json,
       updated_at_ms=excluded.updated_at_ms`,
  ).run(
    scopeId,
    record.requestId,
    record.intentDigest,
    record.state,
    canonicalJson(record),
    Date.parse(record.updatedAt),
  );
}

function appendSubmissionTransition(
  db: DatabaseSync,
  params: {
    scopeId: number;
    record: SatSubmissionRecord;
    transitionKind: "claim" | "update";
    fromState: string | null;
  },
): void {
  const payloadJson = canonicalJson(params.record);
  const transitionDigest = `sha256:${sha256(
    canonicalJson({
      scopeId: params.scopeId,
      requestId: params.record.requestId,
      transitionKind: params.transitionKind,
      fromState: params.fromState,
      toState: params.record.state,
      payloadSha256: sha256(payloadJson),
    }),
  )}`;
  db.prepare(
    `INSERT INTO submission_transition(
       scope_id, request_id, transition_kind, from_state, to_state,
       transition_digest, payload_json, occurred_at_ms
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(transition_digest) DO NOTHING`,
  ).run(
    params.scopeId,
    params.record.requestId,
    params.transitionKind,
    params.fromState,
    params.record.state,
    transitionDigest,
    payloadJson,
    Date.parse(params.record.updatedAt),
  );
}

function importOperationalRecords(
  db: DatabaseSync,
  scopeId: number,
  input: SatMiningHistoryMigrationInput | undefined,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    replaceOperationalStateRows(db, scopeId, input?.operationalState);
    upsertAuditArtifactRows(db, scopeId, input?.auditArtifacts ?? []);
    upsertSubmissionRows(db, scopeId, input?.submissionRecords ?? []);
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
  rangeStartMs: number | null,
  rangeEndMs: number | null = null,
): HistoryTimeBounds {
  const conditions = [];
  const args = [scopeId];
  if (rangeStartMs != null) {
    conditions.push(`${timeColumn}>=?`);
    args.push(rangeStartMs);
  }
  if (rangeEndMs != null) {
    conditions.push(`${timeColumn}<=?`);
    args.push(rangeEndMs);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count, MIN(${timeColumn}) AS oldest_at_ms,
              MAX(${timeColumn}) AS newest_at_ms
         FROM ${table}
        WHERE scope_id=?${conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : ""}`,
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
  rangeStartMs: number | null,
  rangeEndMs: number | null = null,
): HistoryTimeBounds {
  const conditions = [];
  const args = [scopeId];
  if (rangeStartMs != null) {
    conditions.push("recorded_at_ms>=?");
    args.push(rangeStartMs);
  }
  if (rangeEndMs != null) {
    conditions.push("recorded_at_ms<=?");
    args.push(rangeEndMs);
  }
  const row = db
    .prepare(
      `WITH ranked AS (
         SELECT recorded_at_ms,
                ROW_NUMBER() OVER (
                  PARTITION BY cycle_id
                  ORDER BY recorded_at_ms DESC, sequence DESC
                ) AS rank
           FROM planner_outcome
          WHERE scope_id=?${conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : ""}
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

export class SatMiningHistoryStore implements SatSubmissionLedgerAdapter {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private scope: SatMiningHistoryScope;
  private scopeId: number;
  private readonly readOnly: boolean;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    databasePath: string,
    db: DatabaseSync,
    scope: SatMiningHistoryScope,
    scopeId: number,
    readOnly = false,
  ) {
    this.databasePath = databasePath;
    this.db = db;
    this.scope = scope;
    this.scopeId = scopeId;
    this.readOnly = readOnly;
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
      const quarantinedTemps = await quarantineStaleMiningTemps(databasePath);
      if (!existing) {
        const stagingPath = `${databasePath}.migrating`;
        try {
          await fs.rm(stagingPath, { force: true });
          const db = new DatabaseSync(stagingPath);
          applyDatabasePragmas(db);
          createSchema(db);
          const scopeId = ensureScope(db, normalizedScope);
          const migrationScopeId = ensureScope(db, migrationScope(normalizedScope));
          const counters: ImportCounters = {
            importedActions: 0,
            duplicateActions: 0,
            importedOutcomes: 0,
            duplicateOutcomes: 0,
            importedPlannerCycles: 0,
            duplicatePlannerCycles: 0,
            malformedRecords: 0,
            sourceCount: 0,
            conflictRecords: 0,
            quarantinedRecords: quarantinedTemps,
          };
          for (const source of params.migration?.sources ?? []) {
            await importNdjsonSource(db, migrationScopeId, source, counters);
          }
          importRuntimeRecords(db, migrationScopeId, params.migration, counters);
          importOperationalRecords(db, scopeId, params.migration);
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
          const archiveManifestPath = await archiveLegacySources(databasePath, params.migration);
          receipt = {
            schemaVersion: MINING_HISTORY_SCHEMA_VERSION,
            ...counters,
            archiveManifestPath,
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
          migrateExistingSchema(migrationDb);
          createSchema(migrationDb);
          const scopeId = ensureScope(migrationDb, normalizedScope);
          const migrationScopeId = ensureScope(migrationDb, migrationScope(normalizedScope));
          const counters: ImportCounters = {
            importedActions: 0,
            duplicateActions: 0,
            importedOutcomes: 0,
            duplicateOutcomes: 0,
            importedPlannerCycles: 0,
            duplicatePlannerCycles: 0,
            malformedRecords: 0,
            sourceCount: 0,
            conflictRecords: 0,
            quarantinedRecords: quarantinedTemps,
          };
          for (const source of params.migration?.sources ?? []) {
            await importNdjsonSource(migrationDb, migrationScopeId, source, counters);
          }
          importRuntimeRecords(migrationDb, migrationScopeId, params.migration, counters);
          importOperationalRecords(migrationDb, scopeId, params.migration);
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
            const archiveManifestPath = await archiveLegacySources(databasePath, params.migration);
            receipt = {
              schemaVersion: MINING_HISTORY_SCHEMA_VERSION,
              ...counters,
              archiveManifestPath,
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
    migrateExistingSchema(db);
    createSchema(db);
    const scopeId = ensureScope(db, normalizedScope);
    return {
      store: new SatMiningHistoryStore(databasePath, db, normalizedScope, scopeId),
      migration: receipt,
    };
  }

  static async openReadOnly(params: {
    databasePath: string;
    scopeKey?: string | null;
  }): Promise<SatMiningHistoryStore> {
    const databasePath = path.resolve(params.databasePath);
    const stat = await fs.lstat(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Unsafe Mining history database path: ${databasePath}`);
    }
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      db.exec(
        "PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;",
      );
      const schema = Number(
        (
          db.prepare("SELECT value FROM mining_meta WHERE key='schema_version'").get() as
            | SqlRow
            | undefined
        )?.value ?? 0,
      );
      if (schema !== MINING_HISTORY_SCHEMA_VERSION) {
        throw new Error(`Mining history schema ${schema || "unknown"} is unsupported`);
      }
      const row = params.scopeKey
        ? (db.prepare("SELECT id FROM history_scope WHERE scope_key=?").get(params.scopeKey) as
            | SqlRow
            | undefined)
        : (db
            .prepare("SELECT id FROM history_scope ORDER BY created_at_ms DESC, id DESC LIMIT 1")
            .get() as SqlRow | undefined);
      const scopeId = Number(row?.id);
      if (!Number.isSafeInteger(scopeId) || scopeId <= 0) {
        throw new Error("Mining history has no readable scope");
      }
      return new SatMiningHistoryStore(databasePath, db, readScope(db, scopeId), scopeId, true);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  getScope(): SatMiningHistoryScope {
    return { ...this.scope };
  }

  get walletId(): string {
    return this.scope.walletId;
  }

  getScopeKey(): string {
    return scopeKey(this.scope);
  }

  listScopes(): Array<{ scopeKey: string; scope: SatMiningHistoryScope }> {
    return (
      this.db
        .prepare("SELECT id, scope_key FROM history_scope ORDER BY created_at_ms ASC, id ASC")
        .all() as SqlRow[]
    ).map((row) => ({
      scopeKey: String(row.scope_key),
      scope: readScope(this.db, Number(row.id)),
    }));
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
          changed = insertAction(this.db, statement, this.scopeId, entry, sourceLabel) || changed;
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
        if (insertOutcome(this.db, statement, this.scopeId, entry, sourceLabel)) {
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
        if (insertPlannerCycle(this.db, statement, this.scopeId, entry, sourceLabel)) {
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
    fromAt?: string | null;
    toAt?: string | null;
    limit?: number;
    cursor?: string | null;
    scopeKey?: string | null;
  }): SatMiningActionPage {
    const selected = this.resolveScopeSelection(params?.scopeKey);
    const window = params?.window ?? "all";
    const requestedFromMs = params?.fromAt ? Date.parse(params.fromAt) : null;
    const requestedToMs = params?.toAt ? Date.parse(params.toAt) : null;
    if (
      (requestedFromMs != null && !Number.isFinite(requestedFromMs)) ||
      (requestedToMs != null && !Number.isFinite(requestedToMs)) ||
      (requestedFromMs != null && requestedToMs != null && requestedFromMs > requestedToMs)
    ) {
      throw new Error("Mining action history range is invalid");
    }
    const windowStartMs = requestedFromMs ?? historyWindowStartMs(window);
    const cursor = decodeActionCursor(params?.cursor);
    const limit = Math.max(
      1,
      Math.min(MINING_HISTORY_ACTION_PAGE_MAX, Math.floor(params?.limit ?? 100)),
    );
    const conditions = ["scope_id=?"];
    const args: Array<string | number> = [selected.scopeId];
    if (windowStartMs != null) {
      conditions.push("occurred_at_ms>=?");
      args.push(windowStartMs);
    }
    if (requestedToMs != null) {
      conditions.push("occurred_at_ms<=?");
      args.push(requestedToMs);
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
      selected.scopeId,
      "occurred_at_ms",
      windowStartMs,
      requestedToMs,
    );
    const total = readTimeBounds(this.db, "mining_event", selected.scopeId, "occurred_at_ms", null);
    const last = selectedRows.at(-1);
    return {
      walletId: selected.scope.walletId,
      scope: selected.scope,
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
    fromAt?: string | null;
    toAt?: string | null;
    limit?: number;
    cursor?: string | null;
    scopeKey?: string | null;
  }): SatMiningOutcomePage {
    const selected = this.resolveScopeSelection(params?.scopeKey);
    const window = params?.window ?? "all";
    const requestedFromMs = params?.fromAt ? Date.parse(params.fromAt) : null;
    const requestedToMs = params?.toAt ? Date.parse(params.toAt) : null;
    if (
      (requestedFromMs != null && !Number.isFinite(requestedFromMs)) ||
      (requestedToMs != null && !Number.isFinite(requestedToMs)) ||
      (requestedFromMs != null && requestedToMs != null && requestedFromMs > requestedToMs)
    ) {
      throw new Error("Mining outcome history range is invalid");
    }
    const windowStartMs = requestedFromMs ?? historyWindowStartMs(window);
    const cursor = decodeOutcomeCursor(params?.cursor);
    const limit = Math.max(
      1,
      Math.min(MINING_HISTORY_OUTCOME_PAGE_MAX, Math.floor(params?.limit ?? 100)),
    );
    const conditions = ["scope_id=?"];
    const args: Array<string | number> = [selected.scopeId];
    if (windowStartMs != null) {
      conditions.push("recorded_at_ms>=?");
      args.push(windowStartMs);
    }
    if (requestedToMs != null) {
      conditions.push("recorded_at_ms<=?");
      args.push(requestedToMs);
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
    const bounds = readOutcomeTimeBounds(this.db, selected.scopeId, windowStartMs, requestedToMs);
    const total = readOutcomeTimeBounds(this.db, selected.scopeId, null);
    const last = selectedRows.at(-1);
    return {
      walletId: selected.scope.walletId,
      scope: selected.scope,
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
    scopeKey?: string | null;
  }): SatMiningHistorySeries {
    const selected = this.resolveScopeSelection(params.scopeKey);
    const windowStartMs = historyWindowStartMs(params.window);
    const maxPoints = Math.max(1, Math.min(2048, Math.floor(params.maxPoints)));
    const bounds = readOutcomeTimeBounds(this.db, selected.scopeId, windowStartMs);
    const total = readOutcomeTimeBounds(this.db, selected.scopeId, null);
    if (bounds.count === 0) {
      return {
        walletId: selected.scope.walletId,
        scope: selected.scope,
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
    const conditionArgs: Array<string | number> = [selected.scopeId];
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
      walletId: selected.scope.walletId,
      scope: selected.scope,
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

  async replaceOperationalState(state: SatMiningOperationalState): Promise<void> {
    await this.enqueueWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        replaceOperationalStateRows(this.db, this.scopeId, state);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  readOperationalState(): SatMiningOperationalState {
    const rows = (
      table: "round_execution" | "pending_planner_cycle" | "claim_backlog" | "settlement_state",
    ): unknown[] =>
      (
        this.db
          .prepare(
            `SELECT payload_json FROM ${table}
              WHERE scope_id=?
              ORDER BY state_key ASC`,
          )
          .all(this.scopeId) as SqlRow[]
      ).map((row) => JSON.parse(String(row.payload_json)) as unknown);
    const settlement = rows("settlement_state") as Array<Record<string, unknown>>;
    return {
      roundExecution: rows("round_execution"),
      pendingPlannerCycles: rows("pending_planner_cycle"),
      claimBacklog: rows("claim_backlog"),
      settlementPageParticipants: settlement.filter((entry) => entry.kind === "participants"),
      settlementPageLookupTables: settlement.filter((entry) => entry.kind === "lookup-table"),
      workers: Object.fromEntries(
        (
          this.db
            .prepare(
              `SELECT worker_key, payload_json FROM worker_state
                WHERE scope_id=? ORDER BY worker_key ASC`,
            )
            .all(this.scopeId) as SqlRow[]
        ).map((row) => [String(row.worker_key), JSON.parse(String(row.payload_json))]),
      ),
      runtimeMeta: Object.fromEntries(
        (
          this.db
            .prepare(
              `SELECT meta_key, payload_json FROM runtime_meta
                WHERE scope_id=? ORDER BY meta_key ASC`,
            )
            .all(this.scopeId) as SqlRow[]
        ).map((row) => [String(row.meta_key), JSON.parse(String(row.payload_json))]),
      ),
    };
  }

  async replaceAuditArtifacts(artifacts: readonly unknown[]): Promise<void> {
    await this.enqueueWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("DELETE FROM audit_artifact WHERE scope_id=?").run(this.scopeId);
        upsertAuditArtifactRows(this.db, this.scopeId, artifacts);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  readAuditArtifacts(): unknown[] {
    return (
      this.db
        .prepare(
          `SELECT payload_json FROM audit_artifact
            WHERE scope_id=? ORDER BY artifact_key ASC`,
        )
        .all(this.scopeId) as SqlRow[]
    ).map((row) => JSON.parse(String(row.payload_json)) as unknown);
  }

  async upsertSubmissionRecords(records: readonly unknown[]): Promise<void> {
    await this.enqueueWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        upsertSubmissionRows(this.db, this.scopeId, records);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async claim(params: SatSubmissionClaimParams): Promise<SatSubmissionClaim> {
    if (params.walletId !== this.walletId) {
      throw new Error(
        `Mining submission ledger is bound to ${this.walletId}, not ${params.walletId}`,
      );
    }
    return await this.enqueueWrite(() => {
      const env = params.env ?? process.env;
      const owner = params.owner ?? `${process.pid}:${randomUUID()}`;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        let operationKey = params.operationKey;
        let requestId = buildSatSubmissionRequestId({ ...params, operationKey });
        if (params.allowFailedRetry) {
          for (let retry = 1; retry <= 32; retry += 1) {
            const prior = readSubmissionRecordRow(
              this.db
                .prepare(
                  `SELECT request_id, payload_json
                     FROM submission_record
                    WHERE scope_id=? AND request_id=?`,
                )
                .get(this.scopeId, requestId) as SqlRow | undefined,
            );
            if (!prior || prior.state !== "failed") {
              break;
            }
            operationKey = `${params.operationKey}:retry:${retry}`;
            requestId = buildSatSubmissionRequestId({ ...params, operationKey });
            if (retry === 32) {
              const exhausted = readSubmissionRecordRow(
                this.db
                  .prepare(
                    `SELECT request_id, payload_json
                       FROM submission_record
                      WHERE scope_id=? AND request_id=?`,
                  )
                  .get(this.scopeId, requestId) as SqlRow | undefined,
              );
              if (exhausted?.state === "failed") {
                throw new Error("SAT submission exhausted its safe pre-broadcast retry limit");
              }
            }
          }
        }
        const existing = readSubmissionRecordRow(
          this.db
            .prepare(
              `SELECT request_id, payload_json
                 FROM submission_record
                WHERE scope_id=? AND request_id=?`,
            )
            .get(this.scopeId, requestId) as SqlRow | undefined,
        );
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
          if (satSubmissionLeaseIsLive(existing.lease) && existing.lease?.owner !== owner) {
            this.db.exec("COMMIT");
            return { record: existing, created: false, claimed: false, owner };
          }
          const fromState = existing.state;
          const now = new Date().toISOString();
          existing.lease = {
            owner,
            pid: process.pid,
            acquiredAt: now,
            expiresAt: new Date(Date.now() + satSubmissionLeaseDurationMs(env)).toISOString(),
          };
          existing.attempts += 1;
          existing.updatedAt = now;
          writeSubmissionRecord(this.db, this.scopeId, existing);
          appendSubmissionTransition(this.db, {
            scopeId: this.scopeId,
            record: existing,
            transitionKind: "claim",
            fromState,
          });
          this.db.exec("COMMIT");
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
            expiresAt: new Date(Date.now() + satSubmissionLeaseDurationMs(env)).toISOString(),
          },
        };
        writeSubmissionRecord(this.db, this.scopeId, record);
        appendSubmissionTransition(this.db, {
          scopeId: this.scopeId,
          record,
          transitionKind: "claim",
          fromState: null,
        });
        this.db.exec("COMMIT");
        return { record, created: true, claimed: true, owner };
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async read(params: SatSubmissionReadParams): Promise<SatSubmissionRecord | null> {
    if (params.walletId !== this.walletId) {
      throw new Error(
        `Mining submission ledger is bound to ${this.walletId}, not ${params.walletId}`,
      );
    }
    await this.flush();
    return readSubmissionRecordRow(
      this.db
        .prepare(
          `SELECT request_id, payload_json
             FROM submission_record
            WHERE scope_id=? AND request_id=?`,
        )
        .get(this.scopeId, params.requestId) as SqlRow | undefined,
    );
  }

  async readAll(params: SatSubmissionReadAllParams): Promise<SatSubmissionRecord[]> {
    if (params.walletId !== this.walletId) {
      throw new Error(
        `Mining submission ledger is bound to ${this.walletId}, not ${params.walletId}`,
      );
    }
    await this.flush();
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM submission_record WHERE scope_id=?")
      .get(this.scopeId) as SqlRow;
    const count = Number(countRow.count ?? 0);
    if (count > 10_000) {
      throw new Error(
        `Mining submission ledger contains ${count} records; unbounded whole-ledger reads are disabled`,
      );
    }
    return (
      this.db
        .prepare(
          `SELECT request_id, payload_json
             FROM submission_record
            WHERE scope_id=?
            ORDER BY request_id ASC`,
        )
        .all(this.scopeId) as SqlRow[]
    ).map((row) => {
      const record = readSubmissionRecordRow(row);
      if (!record) {
        throw new Error(`Corrupt Mining submission record ${String(row.request_id)}`);
      }
      return record;
    });
  }

  async update(params: SatSubmissionUpdateParams): Promise<SatSubmissionRecord> {
    if (params.walletId !== this.walletId) {
      throw new Error(
        `Mining submission ledger is bound to ${this.walletId}, not ${params.walletId}`,
      );
    }
    return await this.enqueueWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const record = readSubmissionRecordRow(
          this.db
            .prepare(
              `SELECT request_id, payload_json
                 FROM submission_record
                WHERE scope_id=? AND request_id=?`,
            )
            .get(this.scopeId, params.requestId) as SqlRow | undefined,
        );
        if (!record) {
          throw new Error(`SAT submission ${params.requestId} is missing from its durable ledger`);
        }
        if (record.intentDigest !== params.intentDigest) {
          throw new Error(
            `SAT submission ${params.requestId} intent digest changed during execution`,
          );
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
        const fromState = record.state;
        assertSatSubmissionStateTransition(params.requestId, record.state, params.state);
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
        writeSubmissionRecord(this.db, this.scopeId, record);
        appendSubmissionTransition(this.db, {
          scopeId: this.scopeId,
          record,
          transitionKind: "update",
          fromState,
        });
        this.db.exec("COMMIT");
        return record;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async deleteHistory(
    request: SatMiningHistoryDeletionRequest,
  ): Promise<SatMiningHistoryDeletionReceipt> {
    const kinds = [...new Set(request.kinds)];
    if (
      kinds.length === 0 ||
      kinds.some((kind) => !["actions", "outcomes", "planner-cycles"].includes(kind))
    ) {
      throw new Error("Mining history deletion requires explicit record kinds");
    }
    const fromAtMs = request.fromAt ? Date.parse(request.fromAt) : null;
    const toAtMs = request.toAt ? Date.parse(request.toAt) : null;
    if (
      (fromAtMs != null && !Number.isFinite(fromAtMs)) ||
      (toAtMs != null && !Number.isFinite(toAtMs)) ||
      (fromAtMs != null && toAtMs != null && fromAtMs > toAtMs)
    ) {
      throw new Error("Mining history deletion range is invalid");
    }
    let receipt!: SatMiningHistoryDeletionReceipt;
    await this.enqueueWrite(() => {
      const remove = (
        table: "mining_event" | "planner_outcome" | "planner_cycle",
        timeColumn: "occurred_at_ms" | "recorded_at_ms",
      ): number => {
        const conditions = ["scope_id=?"];
        const args: Array<number> = [this.scopeId];
        if (fromAtMs != null) {
          conditions.push(`${timeColumn}>=?`);
          args.push(fromAtMs);
        }
        if (toAtMs != null) {
          conditions.push(`${timeColumn}<=?`);
          args.push(toAtMs);
        }
        return Number(
          this.db.prepare(`DELETE FROM ${table} WHERE ${conditions.join(" AND ")}`).run(...args)
            .changes,
        );
      };
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const deletedActions = kinds.includes("actions")
          ? remove("mining_event", "occurred_at_ms")
          : 0;
        const deletedOutcomes = kinds.includes("outcomes")
          ? remove("planner_outcome", "recorded_at_ms")
          : 0;
        const deletedPlannerCycles = kinds.includes("planner-cycles")
          ? remove("planner_cycle", "recorded_at_ms")
          : 0;
        const deletedAt = new Date().toISOString();
        const requestDigest = sha256(
          canonicalJson({
            scopeKey: this.getScopeKey(),
            kinds,
            fromAtMs,
            toAtMs,
            deletedAt,
          }),
        );
        this.db
          .prepare(
            `INSERT INTO history_deletion_receipt(
               scope_id, request_digest, deleted_actions, deleted_outcomes,
               deleted_planner_cycles, from_at_ms, to_at_ms, deleted_at_ms
             ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.scopeId,
            requestDigest,
            deletedActions,
            deletedOutcomes,
            deletedPlannerCycles,
            fromAtMs,
            toAtMs,
            Date.parse(deletedAt),
          );
        const historyRevision = incrementHistoryRevision(this.db);
        receipt = {
          walletId: this.scope.walletId,
          scopeKey: this.getScopeKey(),
          deletedActions,
          deletedOutcomes,
          deletedPlannerCycles,
          fromAt: isoOrNull(fromAtMs),
          toAt: isoOrNull(toAtMs),
          historyRevision,
          deletedAt,
        };
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
    return receipt;
  }

  async clearHistory(): Promise<void> {
    await this.deleteHistory({
      kinds: ["actions", "outcomes", "planner-cycles"],
    });
  }

  async diskStatus(): Promise<SatMiningDiskStatus> {
    const [database, wal, filesystem] = await Promise.all([
      fs.stat(this.databasePath),
      fs.stat(`${this.databasePath}-wal`).catch(() => null),
      fs.statfs(path.dirname(this.databasePath)).catch(() => null),
    ]);
    const availableBytes = filesystem ? Number(filesystem.bavail) * Number(filesystem.bsize) : null;
    const warning =
      availableBytes == null
        ? "none"
        : availableBytes < 256 * 1024 * 1024
          ? "critical"
          : availableBytes < 1024 * 1024 * 1024
            ? "low"
            : "none";
    return {
      databaseBytes: database.size,
      walBytes: wal?.size ?? 0,
      availableBytes,
      warning,
      optionalCapitalCommitmentsAllowed: warning !== "critical",
    };
  }

  queryPlans(): { actions: string; outcomes: string } {
    const actions = this.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT sequence FROM mining_event
          WHERE scope_id=?
          ORDER BY occurred_at_ms DESC, sequence DESC LIMIT 100`,
      )
      .all(this.scopeId)
      .map((row) => Object.values(row as SqlRow).join(" "))
      .join("\n");
    const outcomes = this.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT sequence FROM planner_outcome
          WHERE scope_id=?
          ORDER BY recorded_at_ms DESC, cycle_id DESC, sequence DESC LIMIT 100`,
      )
      .all(this.scopeId)
      .map((row) => Object.values(row as SqlRow).join(" "))
      .join("\n");
    return { actions, outcomes };
  }

  checkpoint(): void {
    if (!this.readOnly) {
      this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    }
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  integrityCheck(): string {
    const row = this.db.prepare("PRAGMA integrity_check").get() as SqlRow;
    return String(Object.values(row)[0] ?? "");
  }

  close(): void {
    if (!this.readOnly) {
      this.checkpoint();
    }
    this.db.close();
  }

  private resolveScopeSelection(requestedScopeKey?: string | null): {
    scopeId: number;
    scope: SatMiningHistoryScope;
  } {
    if (!requestedScopeKey || requestedScopeKey === this.getScopeKey()) {
      return { scopeId: this.scopeId, scope: this.getScope() };
    }
    if (!/^[a-f0-9]{64}$/u.test(requestedScopeKey)) {
      throw new Error("Mining history scope key is invalid");
    }
    const row = this.db
      .prepare("SELECT id FROM history_scope WHERE scope_key=?")
      .get(requestedScopeKey) as SqlRow | undefined;
    const selectedId = Number(row?.id);
    if (!Number.isSafeInteger(selectedId) || selectedId <= 0) {
      throw new Error("Mining history scope is not registered for this Wallet");
    }
    return { scopeId: selectedId, scope: readScope(this.db, selectedId) };
  }

  private async enqueueWrite<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.readOnly) {
      throw new Error("Mining history store is read-only");
    }
    const next = this.writeChain.catch(() => {}).then(operation);
    this.writeChain = next.then(() => undefined);
    return await next;
  }
}

export function resolveSatMiningHistoryDatabasePath(
  stateDir: string,
  walletStateKey: string,
): string {
  return path.join(stateDir, "sat-mining", "wallets", walletStateKey, "mining.sqlite");
}
