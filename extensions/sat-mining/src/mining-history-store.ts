import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  parseSatAuditArtifactsBytes,
  parseSatRuntimeSummaryBytes,
  SAT_ACTION_HISTORY_RECENT_TAIL_LIMIT,
  SAT_SQLITE_ARCHIVED_FAILURE_LIMIT,
  type SatRuntimeSummary,
} from "./audit-store.js";
import type {
  SatMiningHistoryWindow,
  SatMiningRecentAction,
  SatPlannerCycleRecord,
  SatPlannerOutcomeMemory,
} from "./audit-store.js";
import {
  classifySatHistoryGenerationAccess,
  type SatHistoryGenerationAccess,
} from "./generation-policy.js";
import {
  assertSatMiningStateIdentity,
  normalizeSatMiningStateIdentity,
  type SatMiningStateIdentity,
} from "./state-identity.js";
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
import { parseSatSubmissionRecordsBytes } from "./submission-ledger.js";

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
  /** File-backed compatibility inputs are parsed only from pinned archived
   * bytes inside the activation transaction. */
  fileInputs?: {
    runtimePath?: string;
    auditPath?: string;
    submissionPath?: string;
  };
  runtimeRecentActions?: readonly SatMiningRecentAction[];
  runtimePlannerOutcomes?: readonly SatPlannerOutcomeMemory[];
  runtimePlannerCycles?: readonly SatPlannerCycleRecord[];
  operationalState?: SatMiningOperationalState | null;
  auditArtifacts?: readonly unknown[];
  submissionRecords?: readonly unknown[];
};

type MaterializedMigrationInput = SatMiningHistoryMigrationInput & {
  runtimeSummary?: SatRuntimeSummary;
};

export type SatMiningOperationalState = {
  archivedFailures?: readonly SatMiningRecentAction[];
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

/** Conservative rolling limits. They deliberately retain several years of
 * normal cycle activity and never evict records tied to live recovery. */
export type SatMiningHistoryRetentionPolicy = {
  maxActions: number;
  maxOutcomes: number;
  maxPlannerCycles: number;
  maxAuditArtifacts: number;
};

export type SatMiningHistoryRetentionReceipt = {
  walletId: string;
  scopeKey: string;
  prunedActions: number;
  prunedOutcomes: number;
  prunedPlannerCycles: number;
  prunedAuditArtifacts: number;
  protectedCycleCount: number;
  historyRevision: number;
};

const DEFAULT_MINING_HISTORY_RETENTION: Readonly<SatMiningHistoryRetentionPolicy> = {
  maxActions: 16_384,
  maxOutcomes: 8_192,
  maxPlannerCycles: 8_192,
  maxAuditArtifacts: 4_096,
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
  /**
   * Compatibility input for callers/tests which already own an in-memory
   * snapshot. Runtime callers should use migrationFactory so an activated
   * SQLite ledger never touches stale legacy state again.
   */
  migration?: SatMiningHistoryMigrationInput;
  migrationFactory?: () => Promise<SatMiningHistoryMigrationInput | undefined>;
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
  return unboundMigrationScope(normalized);
}

function unboundMigrationScope(scope: SatMiningHistoryScope): SatMiningHistoryScope {
  const normalized = normalizeScope(scope);
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

const MIGRATION_ACTIVATION_PREFIX = "migration-activation:";

function migrationActivationKey(scope: SatMiningHistoryScope): string {
  return `${MIGRATION_ACTIVATION_PREFIX}${scopeKey(scope)}:schema-${String(MINING_HISTORY_SCHEMA_VERSION)}`;
}

function migrationActivationValue(scope: SatMiningHistoryScope): string {
  return canonicalJson({
    schemaVersion: MINING_HISTORY_SCHEMA_VERSION,
    scopeKey: scopeKey(scope),
  });
}

/**
 * A database becomes the authoritative runtime only after this marker commits
 * beside its imported data. A marker for another scope/schema is never a
 * reason to read old JSON again: that would mix two Wallet/network histories.
 */
function hasValidMigrationActivation(db: DatabaseSync, scope: SatMiningHistoryScope): boolean {
  const rows = db
    .prepare("SELECT key, value FROM mining_meta WHERE key LIKE ? ORDER BY key ASC")
    .all(`${MIGRATION_ACTIVATION_PREFIX}%`) as SqlRow[];
  if (rows.length === 0) {
    return false;
  }
  const key = migrationActivationKey(scope);
  const expected = migrationActivationValue(scope);
  if (rows.length !== 1 || String(rows[0]?.key) !== key || String(rows[0]?.value) !== expected) {
    throw new Error("Mining history migration activation marker is malformed or mismatched");
  }
  return true;
}

function writeMigrationActivation(db: DatabaseSync, scope: SatMiningHistoryScope): void {
  db.prepare("INSERT INTO mining_meta(key, value) VALUES(?, ?)").run(
    migrationActivationKey(scope),
    migrationActivationValue(scope),
  );
}

function readActivatedScopeId(db: DatabaseSync): number {
  const rows = db
    .prepare("SELECT key FROM mining_meta WHERE key LIKE ? ORDER BY key ASC")
    .all(`${MIGRATION_ACTIVATION_PREFIX}%`) as SqlRow[];
  const match =
    rows.length === 1
      ? new RegExp(
          `^${MIGRATION_ACTIVATION_PREFIX}([a-f0-9]{64}):schema-${String(MINING_HISTORY_SCHEMA_VERSION)}$`,
          "u",
        ).exec(String(rows[0]?.key ?? ""))
      : null;
  if (!match) {
    throw new Error("Mining history migration activation marker is malformed or mismatched");
  }
  const row = db.prepare("SELECT id FROM history_scope WHERE scope_key=?").get(match[1]) as
    | SqlRow
    | undefined;
  const scopeId = Number(row?.id);
  if (!Number.isSafeInteger(scopeId) || scopeId <= 0) {
    throw new Error("Mining history activated scope is missing");
  }
  return scopeId;
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

function normalizeSqliteArchivedFailures(
  value: readonly unknown[] | undefined,
): SatMiningRecentAction[] {
  return (value ?? [])
    .filter(isSatMiningRecentAction)
    .toSorted((left, right) => {
      const byTime = Date.parse(right.at) - Date.parse(left.at);
      if (byTime !== 0) {
        return byTime;
      }
      return canonicalJson(left).localeCompare(canonicalJson(right));
    })
    .slice(0, SAT_SQLITE_ARCHIVED_FAILURE_LIMIT);
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

type PinnedLegacySource = {
  sourcePath: string;
  handle: fs.FileHandle;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  sha256: string;
};

function assertPinnedLegacySource(
  stat: { isFile: () => boolean; nlink: number; dev: number; ino: number; size: number },
  sourcePath: string,
  expected?: Pick<PinnedLegacySource, "dev" | "ino" | "size">,
): void {
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Unsafe Mining legacy source: ${sourcePath}`);
  }
  if (
    expected &&
    (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size !== expected.size)
  ) {
    throw new Error(`Mining legacy source changed during archival: ${sourcePath}`);
  }
}

async function hashPinnedLegacySource(
  handle: fs.FileHandle,
  size: number,
  sourcePath: string,
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - offset),
      offset,
    );
    if (bytesRead <= 0) {
      throw new Error(`Mining legacy source changed during archival: ${sourcePath}`);
    }
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

async function openPinnedLegacySource(sourcePath: string): Promise<PinnedLegacySource | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Unsafe Mining legacy source: ${sourcePath}`);
    }
    throw error;
  }
  try {
    const initial = await handle.stat();
    assertPinnedLegacySource(initial, sourcePath);
    const digest = await hashPinnedLegacySource(handle, initial.size, sourcePath);
    const final = await handle.stat();
    assertPinnedLegacySource(final, sourcePath, initial);
    return {
      sourcePath,
      handle,
      dev: initial.dev,
      ino: initial.ino,
      size: initial.size,
      mtimeMs: Math.floor(initial.mtimeMs),
      sha256: digest,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function copyPinnedLegacySource(
  source: PinnedLegacySource,
  destinationPath: string,
): Promise<void> {
  const destination = await fs.open(destinationPath, "wx", 0o440);
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < source.size) {
      const { bytesRead } = await source.handle.read(
        buffer,
        0,
        Math.min(buffer.length, source.size - offset),
        offset,
      );
      if (bytesRead <= 0) {
        throw new Error(`Mining legacy source changed during archival: ${source.sourcePath}`);
      }
      await destination.write(buffer, 0, bytesRead, offset);
      offset += bytesRead;
    }
    await destination.sync();
    const final = await source.handle.stat();
    assertPinnedLegacySource(final, source.sourcePath, source);
  } finally {
    await destination.close();
  }
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

async function readRegularArchiveFile(filePath: string): Promise<{
  bytes: Buffer;
  digest: string;
  stat: { dev: number; ino: number; size: number };
}> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1) {
      throw new Error(`Unsafe Mining legacy archive file: ${filePath}`);
    }
    const bytes = await handle.readFile();
    const final = await handle.stat();
    if (
      !final.isFile() ||
      final.nlink !== 1 ||
      final.dev !== initial.dev ||
      final.ino !== initial.ino ||
      final.size !== initial.size
    ) {
      throw new Error(`Mining legacy archive file changed while reading: ${filePath}`);
    }
    return { bytes, digest: sha256(bytes.toString("utf8")), stat: initial };
  } finally {
    await handle.close();
  }
}

async function archiveLegacySources(
  databasePath: string,
  migration: SatMiningHistoryMigrationInput | undefined,
): Promise<{
  manifestPath: string;
  manifestBytes: Buffer;
  manifestMember: PinnedArchiveMember;
} | null> {
  const selectedPaths = [
    ...(migration?.sources ?? []).map((source) => source.path),
    ...(migration?.preservePaths ?? []),
    migration?.fileInputs?.runtimePath,
    migration?.fileInputs?.auditPath,
    migration?.fileInputs?.submissionPath,
  ];
  const uniquePaths = [
    ...new Set(
      selectedPaths
        .filter((entry): entry is string => Boolean(entry))
        .map((entry) => path.resolve(entry)),
    ),
  ];
  const records: PinnedLegacySource[] = [];
  try {
    for (const sourcePath of uniquePaths) {
      const source = await openPinnedLegacySource(sourcePath);
      if (source) {
        records.push(source);
      }
    }
    if (records.length === 0) {
      return null;
    }
    const archiveRecords = records.map(({ handle: _handle, ...record }) => record);
    const archiveDigest = sha256(canonicalJson(archiveRecords));
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
      const openedManifest = await readRegularArchiveFile(manifestPath);
      const manifest = JSON.parse(openedManifest.bytes.toString("utf8")) as {
        archiveDigest?: unknown;
        sources?: Array<{
          sourcePath?: unknown;
          sha256?: unknown;
          archiveName?: unknown;
          archiveDev?: unknown;
          archiveIno?: unknown;
          archiveSize?: unknown;
        }>;
      };
      if (
        manifest.archiveDigest !== `sha256:${archiveDigest}` ||
        !Array.isArray(manifest.sources) ||
        manifest.sources.length !== archiveRecords.length
      ) {
        throw new Error(
          `Mining legacy archive manifest does not bind current inputs: ${manifestPath}`,
        );
      }
      for (const [index, record] of archiveRecords.entries()) {
        const archived = manifest.sources[index];
        const archiveName = String(archived?.archiveName ?? "");
        const archivedPath = path.join(archiveDir, archiveName);
        const archivedFile = await fs.lstat(archivedPath).catch(() => null);
        if (
          archived?.sourcePath !== record.sourcePath ||
          archived?.sha256 !== record.sha256 ||
          !/^\d{3}-[^/]+$/u.test(archiveName) ||
          !Number.isSafeInteger(archived?.archiveDev) ||
          !Number.isSafeInteger(archived?.archiveIno) ||
          !Number.isSafeInteger(archived?.archiveSize) ||
          !archivedFile?.isFile() ||
          archivedFile.isSymbolicLink() ||
          archivedFile.nlink !== 1 ||
          archivedFile.dev !== archived.archiveDev ||
          archivedFile.ino !== archived.archiveIno ||
          archivedFile.size !== archived.archiveSize ||
          (await readRegularArchiveFile(archivedPath)).digest !== record.sha256
        ) {
          throw new Error(`Mining legacy archive verification failed: ${manifestPath}`);
        }
      }
      return {
        manifestPath,
        manifestBytes: openedManifest.bytes,
        manifestMember: {
          path: manifestPath,
          digest: openedManifest.digest,
          dev: openedManifest.stat.dev,
          ino: openedManifest.stat.ino,
          size: openedManifest.stat.size,
        },
      };
    }
    const available = await fs.statfs(path.dirname(databasePath)).catch(() => null);
    const requiredBytes = archiveRecords.reduce((sum, record) => sum + record.size, 0);
    const availableBytes = available ? Number(available.bavail) * Number(available.bsize) : null;
    if (availableBytes != null && availableBytes < requiredBytes + 64 * 1024 * 1024) {
      throw new Error(
        `Insufficient disk space to preserve Mining legacy history (${requiredBytes} bytes required)`,
      );
    }
    const archiveParent = path.dirname(archiveDir);
    await fs.mkdir(archiveParent, { recursive: true, mode: 0o750 });
    const stagingDir = `${archiveDir}.staging-${randomUUID()}`;
    await fs.mkdir(stagingDir, { mode: 0o750 });
    try {
      const archived = [];
      for (const [index, record] of archiveRecords.entries()) {
        const source = records[index]!;
        const destinationName = `${String(index).padStart(3, "0")}-${path.basename(record.sourcePath)}`;
        const destinationPath = path.join(stagingDir, destinationName);
        await copyPinnedLegacySource(source, destinationPath);
        const archivedDigest = (await readRegularArchiveFile(destinationPath)).digest;
        if (archivedDigest !== record.sha256) {
          throw new Error(`Mining legacy archive digest mismatch: ${record.sourcePath}`);
        }
        const archivedStat = await fs.lstat(destinationPath);
        if (!archivedStat.isFile() || archivedStat.isSymbolicLink() || archivedStat.nlink !== 1) {
          throw new Error(`Unsafe Mining legacy archive member: ${destinationPath}`);
        }
        archived.push({
          ...record,
          archiveName: destinationName,
          archiveDev: archivedStat.dev,
          archiveIno: archivedStat.ino,
          archiveSize: archivedStat.size,
        });
      }
      const manifest = {
        schemaVersion: 1,
        archiveDigest: `sha256:${archiveDigest}`,
        createdAt: new Date().toISOString(),
        sources: archived,
      };
      const stagingManifest = path.join(stagingDir, "manifest.json");
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await fs.writeFile(stagingManifest, manifestBytes, {
        mode: 0o440,
        flag: "wx",
      });
      const manifestHandle = await fs.open(stagingManifest, "r");
      let manifestMember: PinnedArchiveMember;
      try {
        await manifestHandle.sync();
        const stat = await manifestHandle.stat();
        if (!stat.isFile() || stat.nlink !== 1) {
          throw new Error(`Unsafe Mining legacy archive manifest: ${stagingManifest}`);
        }
        manifestMember = {
          path: manifestPath,
          digest: sha256(manifestBytes.toString("utf8")),
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
        };
      } finally {
        await manifestHandle.close();
      }
      await fsyncDirectory(stagingDir);
      await fs.rename(stagingDir, archiveDir);
      await fsyncDirectory(archiveParent);
      return { manifestPath, manifestBytes, manifestMember: manifestMember! };
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  } finally {
    await Promise.all(records.map(async (record) => await record.handle.close().catch(() => {})));
  }
}

type PinnedArchiveMember = {
  path: string;
  digest: string;
  dev: number;
  ino: number;
  size: number;
};

type PreparedLegacyArchive = {
  manifestPath: string;
  manifestDigest: string;
  manifestBytes: Buffer;
  manifestMember: PinnedArchiveMember;
  archivedSources: Map<string, PinnedArchiveMember>;
} | null;

function assertPinnedRegularFile(
  stat: { isFile: () => boolean; nlink: number; dev: number; ino: number; size: number },
  sourcePath: string,
  expected?: Pick<PinnedArchiveMember, "dev" | "ino" | "size">,
): void {
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Unsafe Mining archived source: ${sourcePath}`);
  }
  if (
    expected &&
    (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size !== expected.size)
  ) {
    throw new Error(`Mining archived source changed before import: ${sourcePath}`);
  }
}

/** Reads one pinned descriptor exactly once. The path only labels provenance:
 * createReadStream consumes the already-open fd and never reopens that path. */
async function readPinnedArchiveFile(
  member: PinnedArchiveMember,
): Promise<{ bytes: Buffer; digest: string }> {
  const handle = await fs.open(member.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = await handle.stat();
    assertPinnedRegularFile(initial, member.path, member);
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    const stream = createReadStream(member.path, {
      fd: handle.fd,
      autoClose: false,
      start: 0,
    });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      chunks.push(bytes);
    }
    const digest = hash.digest("hex");
    const final = await handle.stat();
    assertPinnedRegularFile(final, member.path, member);
    if (digest !== member.digest) {
      throw new Error(`Mining archived source digest changed before import: ${member.path}`);
    }
    return { bytes: Buffer.concat(chunks), digest };
  } finally {
    await handle.close();
  }
}

async function prepareLegacyArchive(
  databasePath: string,
  migration: SatMiningHistoryMigrationInput | undefined,
): Promise<PreparedLegacyArchive> {
  const publication = await archiveLegacySources(databasePath, migration);
  if (!publication) {
    return null;
  }
  const { manifestPath, manifestBytes, manifestMember } = publication;
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    sources: Array<{
      sourcePath: string;
      sha256: string;
      archiveName: string;
      archiveDev: number;
      archiveIno: number;
      archiveSize: number;
    }>;
  };
  const archivedSources = new Map<string, PinnedArchiveMember>();
  for (const source of manifest.sources) {
    const archivedPath = path.join(path.dirname(manifestPath), source.archiveName);
    if (
      !Number.isSafeInteger(source.archiveDev) ||
      !Number.isSafeInteger(source.archiveIno) ||
      !Number.isSafeInteger(source.archiveSize)
    ) {
      throw new Error(`Unsafe Mining archived source: ${archivedPath}`);
    }
    archivedSources.set(path.resolve(source.sourcePath), {
      path: archivedPath,
      digest: source.sha256,
      dev: source.archiveDev,
      ino: source.archiveIno,
      size: source.archiveSize,
    });
  }
  return {
    manifestPath,
    manifestDigest: `sha256:${sha256(manifestBytes.toString("utf8"))}`,
    manifestBytes,
    manifestMember: { ...manifestMember, digest: sha256(manifestBytes.toString("utf8")) },
    archivedSources,
  };
}

async function verifyPinnedArchiveManifest(archive: PreparedLegacyArchive): Promise<void> {
  if (!archive) {
    return;
  }
  const verified = await readPinnedArchiveFile(archive.manifestMember);
  if (!verified.bytes.equals(archive.manifestBytes)) {
    throw new Error(
      `Mining legacy archive manifest changed before import: ${archive.manifestPath}`,
    );
  }
}

async function readArchivedMigrationInput(
  archive: PreparedLegacyArchive,
  sourcePath: string | undefined,
): Promise<Buffer | null> {
  if (!sourcePath) {
    return null;
  }
  const member = archive?.archivedSources.get(path.resolve(sourcePath));
  return member ? (await readPinnedArchiveFile(member)).bytes : null;
}

function runtimeSummaryToOperationalState(summary: SatRuntimeSummary): SatMiningOperationalState {
  return {
    archivedFailures: summary.archivedFailures,
    pendingPlannerCycles: summary.pendingPlannerCycles,
    roundExecution: summary.roundExecution,
    claimBacklog: summary.claimBacklog,
    settlementPageParticipants: summary.settlementPageParticipants,
    settlementPageLookupTables: summary.settlementPageLookupTables,
    workers: summary.workers as Record<string, unknown>,
    runtimeMeta: {
      lastKnownStatus: summary.lastKnownStatus,
      chainTime: summary.chainTime,
      currentRunStartedAt: summary.currentRunStartedAt,
      runStartSolBalanceLamports: summary.runStartSolBalanceLamports,
      runStartSatBalanceRaw: summary.runStartSatBalanceRaw,
      enabledWanted: summary.enabledWanted,
      lastAction: summary.lastAction,
      lastActionTxHash: summary.lastActionTxHash,
      lastFailure: summary.lastFailure,
    },
  };
}

async function materializeArchivedMigrationInput(
  migration: SatMiningHistoryMigrationInput | undefined,
  archive: PreparedLegacyArchive,
): Promise<MaterializedMigrationInput | undefined> {
  if (!migration) {
    return undefined;
  }
  const [runtimeBytes, auditBytes, submissionBytes] = await Promise.all([
    readArchivedMigrationInput(archive, migration.fileInputs?.runtimePath),
    readArchivedMigrationInput(archive, migration.fileInputs?.auditPath),
    readArchivedMigrationInput(archive, migration.fileInputs?.submissionPath),
  ]);
  const runtimeSummary = runtimeBytes ? parseSatRuntimeSummaryBytes(runtimeBytes) : undefined;
  return {
    ...migration,
    runtimeSummary,
    runtimeRecentActions: runtimeSummary?.recentActions ?? migration.runtimeRecentActions,
    runtimePlannerOutcomes: runtimeSummary?.plannerHistory ?? migration.runtimePlannerOutcomes,
    runtimePlannerCycles: runtimeSummary?.plannerCycles ?? migration.runtimePlannerCycles,
    operationalState: runtimeSummary
      ? runtimeSummaryToOperationalState(runtimeSummary)
      : migration.operationalState,
    auditArtifacts: auditBytes ? parseSatAuditArtifactsBytes(auditBytes) : migration.auditArtifacts,
    submissionRecords: submissionBytes
      ? parseSatSubmissionRecordsBytes(submissionBytes, migration.fileInputs?.submissionPath)
      : migration.submissionRecords,
  };
}

function bindLegacyArchiveReceipt(db: DatabaseSync, archive: PreparedLegacyArchive): void {
  if (!archive) {
    return;
  }
  const key = `legacy-archive-receipt:${archive.manifestDigest}`;
  const value = canonicalJson({
    manifestPath: archive.manifestPath,
    manifestDigest: archive.manifestDigest,
  });
  const existing = db.prepare("SELECT value FROM mining_meta WHERE key=?").get(key) as
    | SqlRow
    | undefined;
  if (existing) {
    if (String(existing.value) !== value) {
      throw new Error(`Mining legacy archive receipt mismatch: ${archive.manifestPath}`);
    }
    return;
  }
  db.prepare("INSERT INTO mining_meta(key, value) VALUES(?, ?)").run(key, value);
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

const SQLITE_FAMILY_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

async function removeUniqueStagingFamily(stagingPath: string): Promise<void> {
  for (const suffix of SQLITE_FAMILY_SUFFIXES) {
    const candidate = `${stagingPath}${suffix}`;
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat) {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Unsafe Mining SQLite staging residue: ${candidate}`);
    }
    await fs.unlink(candidate);
  }
}

async function publishFreshHistoryDatabase(
  stagingPath: string,
  databasePath: string,
): Promise<void> {
  const handle = await fs.open(stagingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Unsafe Mining SQLite staging database: ${stagingPath}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (const suffix of SQLITE_FAMILY_SUFFIXES.slice(1)) {
    const candidate = `${stagingPath}${suffix}`;
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat) {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 0) {
      throw new Error(`Unsafe Mining SQLite staging sidecar: ${candidate}`);
    }
    await fs.unlink(candidate);
  }
  await fs.chmod(stagingPath, 0o660);
  await fs.rename(stagingPath, databasePath);
  await fsyncDirectory(path.dirname(databasePath));
}

function assertCheckpointComplete(row: SqlRow, context: string): void {
  const busy = Number(row.busy);
  const log = Number(row.log);
  const checkpointed = Number(row.checkpointed);
  if (
    !Number.isSafeInteger(busy) ||
    !Number.isSafeInteger(log) ||
    !Number.isSafeInteger(checkpointed) ||
    busy !== 0 ||
    log < 0 ||
    checkpointed < 0 ||
    checkpointed !== log
  ) {
    throw new Error(
      `${context} (busy=${String(row.busy)}, log=${String(row.log)}, checkpointed=${String(row.checkpointed)})`,
    );
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
  provenancePath = source.path,
  archived?: PinnedArchiveMember,
): Promise<void> {
  if (!archived) {
    throw new Error(`Mining migration source was not archived: ${provenancePath}`);
  }
  const existing = db
    .prepare("SELECT source_sha256 FROM migration_source WHERE source_label=?")
    .get(source.label) as SqlRow | undefined;
  const { bytes, digest } = await readPinnedArchiveFile(archived);
  if (existing && String(existing.source_sha256) === digest) {
    return;
  }

  const actionStatement = actionInsertStatement(db);
  const outcomeStatement = outcomeInsertStatement(db);
  let validRecords = 0;
  let duplicateRecords = 0;
  let malformedRecords = 0;
  let lineNumber = 0;
  let byteOffset = 0;
  let oldestAtMs: number | null = null;
  let newestAtMs: number | null = null;
  const rawLines = bytes.toString("utf8").split(/\r?\n/u);
  for (const line of rawLines) {
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
        sourcePath: provenancePath,
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
        sourcePath: provenancePath,
        lineNumber,
        byteOffset: lineByteOffset,
        record: trimmed,
        reason: `invalid-${source.kind}-record`,
      });
      continue;
    }
    validRecords += 1;
    duplicateRecords += inserted ? 0 : 1;
    if (validRecords % MINING_HISTORY_IMPORT_BATCH_SIZE === 0) {
      await immediate();
    }
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
    provenancePath,
    source.kind,
    archived.size,
    0,
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
  const runtimeMeta = {
    ...(state.runtimeMeta ?? {}),
    archivedFailures: normalizeSqliteArchivedFailures(state.archivedFailures),
  };
  for (const [key, value] of Object.entries(runtimeMeta).toSorted(([a], [b]) =>
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
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error("Mining audit artifact is invalid");
    }
    const updatedAt = String((artifact as Record<string, unknown>).updatedAt ?? "").trim();
    const updatedAtMs = Date.parse(updatedAt);
    if (!updatedAt || !Number.isFinite(updatedAtMs)) {
      throw new Error("Mining audit artifact updatedAt is invalid");
    }
    const payload = canonicalJson(artifact);
    statement.run(
      scopeId,
      stateKey(artifact, ["roundKey", "artifactId", "id"], index),
      `sha256:${sha256(payload)}`,
      payload,
      updatedAtMs,
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
  replaceOperationalStateRows(db, scopeId, input?.operationalState);
  upsertAuditArtifactRows(db, scopeId, input?.auditArtifacts ?? []);
  upsertSubmissionRows(db, scopeId, input?.submissionRecords ?? []);
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
  private lifecycleFenced = false;
  private closed = false;

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
      const countersFor = (): ImportCounters => ({
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
      });
      const loadMigrationInput = async (): Promise<SatMiningHistoryMigrationInput | undefined> =>
        params.migration ?? (await params.migrationFactory?.());
      const importMigration = async (
        db: DatabaseSync,
        migration: SatMiningHistoryMigrationInput | undefined,
        archive: PreparedLegacyArchive,
        counters: ImportCounters,
      ): Promise<void> => {
        await verifyPinnedArchiveManifest(archive);
        const inputs = await materializeArchivedMigrationInput(migration, archive);
        const scopeId = ensureScope(db, normalizedScope);
        const migrationScopeId = ensureScope(db, migrationScope(normalizedScope));
        const unboundOperationalScopeId = ensureScope(db, unboundMigrationScope(normalizedScope));
        for (const source of inputs?.sources ?? []) {
          const archived = archive?.archivedSources.get(path.resolve(source.path));
          // The index always declares the legacy topology. Missing optional
          // files have no archived descriptor and therefore no import; an
          // existing source can never reach here without its pinned archive.
          if (!archived) {
            continue;
          }
          await importNdjsonSource(db, migrationScopeId, source, counters, source.path, archived);
        }
        importRuntimeRecords(db, migrationScopeId, inputs, counters);
        // Wallet-only JSON has no cluster/program/generation proof. Preserve
        // it under the explicit legacy scope; never reinterpret commitments,
        // recovery state, or claims as belonging to the requested deployment.
        importOperationalRecords(db, unboundOperationalScopeId, inputs);
        bindLegacyArchiveReceipt(db, archive);
        writeMigrationActivation(db, normalizedScope);
      };
      if (!existing) {
        const migration = await loadMigrationInput();
        // Archive before opening the transaction so the legacy topology stays
        // authoritative until the complete SQLite activation can commit.
        const archive = await prepareLegacyArchive(databasePath, migration);
        const stagingPath = `${databasePath}.migrating-${randomUUID()}`;
        let stagingDb: DatabaseSync | null = null;
        try {
          const db = new DatabaseSync(stagingPath);
          stagingDb = db;
          applyDatabasePragmas(db);
          createSchema(db);
          db.exec("BEGIN IMMEDIATE");
          const counters = countersFor();
          await importMigration(db, migration, archive, counters);
          incrementHistoryRevision(db);
          const integrityRow = db.prepare("PRAGMA integrity_check").get() as SqlRow;
          const integrity = String(Object.values(integrityRow)[0] ?? "");
          if (integrity !== "ok") {
            throw new Error(`Mining history integrity check failed: ${integrity || "unknown"}`);
          }
          db.exec("COMMIT");
          assertCheckpointComplete(
            db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as SqlRow,
            "Mining fresh-history WAL checkpoint failed",
          );
          db.close();
          stagingDb = null;
          await publishFreshHistoryDatabase(stagingPath, databasePath);
          receipt = {
            schemaVersion: MINING_HISTORY_SCHEMA_VERSION,
            ...counters,
            archiveManifestPath: archive?.manifestPath ?? null,
            integrity,
          };
        } catch (error) {
          try {
            stagingDb?.exec("ROLLBACK");
          } catch {
            // The transaction may already have been committed or rolled back.
          }
          stagingDb?.close();
          await removeUniqueStagingFamily(stagingPath).catch(() => {});
          throw error;
        }
      } else {
        const migrationDb = new DatabaseSync(databasePath);
        try {
          applyDatabasePragmas(migrationDb);
          migrateExistingSchema(migrationDb);
          createSchema(migrationDb);
          if (!hasValidMigrationActivation(migrationDb, normalizedScope)) {
            const migration = await loadMigrationInput();
            const archive = await prepareLegacyArchive(databasePath, migration);
            migrationDb.exec("BEGIN IMMEDIATE");
            const counters = countersFor();
            await importMigration(migrationDb, migration, archive, counters);
            incrementHistoryRevision(migrationDb);
            const integrityRow = migrationDb.prepare("PRAGMA integrity_check").get() as SqlRow;
            const integrity = String(Object.values(integrityRow)[0] ?? "");
            if (integrity !== "ok") {
              throw new Error(`Mining history integrity check failed: ${integrity || "unknown"}`);
            }
            migrationDb.exec("COMMIT");
            assertCheckpointComplete(
              migrationDb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as SqlRow,
              "Mining existing-history WAL checkpoint failed",
            );
            receipt = {
              schemaVersion: MINING_HISTORY_SCHEMA_VERSION,
              ...counters,
              archiveManifestPath: archive?.manifestPath ?? null,
              integrity,
            };
          }
        } catch (error) {
          try {
            migrationDb.exec("ROLLBACK");
          } catch {
            // The transaction may already have been committed before a later
            // checkpoint error; preserve that original error.
          }
          throw error;
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
        : undefined;
      const scopeId = params.scopeKey ? Number(row?.id) : readActivatedScopeId(db);
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

  get stateIdentity(): SatMiningStateIdentity {
    return normalizeSatMiningStateIdentity({
      cluster: this.scope.network as SatMiningStateIdentity["cluster"],
      programId: this.scope.programId ?? "",
      protocolGeneration: this.scope.protocolVersion ?? "",
      walletId: this.scope.walletId,
    });
  }

  private assertSubmissionStateIdentity(identity: SatMiningStateIdentity): void {
    assertSatMiningStateIdentity(this.stateIdentity, identity);
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

  listGenerationScopes(activeProtocolVersion: string): Array<{
    scopeKey: string;
    scope: SatMiningHistoryScope;
    access: SatHistoryGenerationAccess;
  }> {
    return this.listScopes().map((entry) => ({
      ...entry,
      access: classifySatHistoryGenerationAccess({
        network: entry.scope.network,
        protocolVersion: entry.scope.protocolVersion,
        activeProtocolVersion,
      }),
    }));
  }

  getRevision(): number {
    return getHistoryRevision(this.db);
  }

  async rebindScope(scope: SatMiningHistoryScope): Promise<void> {
    await this.enqueueWrite(() => {
      const normalized = normalizeScope(scope);
      // A rebind changes the exact scope that is allowed to suppress legacy
      // migration input. Rotate the sole marker with the scope row or leave
      // both unchanged if any part of the transaction fails.
      if (!hasValidMigrationActivation(this.db, this.scope)) {
        throw new Error("Mining history cannot rebind without a valid activation marker");
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const nextScopeId = ensureScope(this.db, normalized);
        this.db
          .prepare("DELETE FROM mining_meta WHERE key LIKE ?")
          .run(`${MIGRATION_ACTIVATION_PREFIX}%`);
        writeMigrationActivation(this.db, normalized);
        this.db.exec("COMMIT");
        this.scopeId = nextScopeId;
        this.scope = normalized;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
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
    const runtimeMeta = Object.fromEntries(
      (
        this.db
          .prepare(
            `SELECT meta_key, payload_json FROM runtime_meta
              WHERE scope_id=? ORDER BY meta_key ASC`,
          )
          .all(this.scopeId) as SqlRow[]
      ).map((row) => [String(row.meta_key), JSON.parse(String(row.payload_json))]),
    );
    const archivedFailures = normalizeSqliteArchivedFailures(
      Array.isArray(runtimeMeta.archivedFailures) ? runtimeMeta.archivedFailures : [],
    );
    delete runtimeMeta.archivedFailures;
    return {
      archivedFailures,
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
      runtimeMeta,
    };
  }

  /** Reconstruct the plugin startup snapshot exclusively from the active
   * SQLite scope. This is the post-activation replacement for runtime JSON. */
  readRuntimeSummary(): SatRuntimeSummary {
    const operational = this.readOperationalState();
    const runtimeMeta = operational.runtimeMeta ?? {};
    return {
      recentActions: this.readRecentActions(SAT_ACTION_HISTORY_RECENT_TAIL_LIMIT),
      archivedFailures: [...(operational.archivedFailures ?? [])],
      plannerHistory: this.readRecentPlannerOutcomes(4096),
      plannerCycles: this.readRecentPlannerCycles(4096),
      pendingPlannerCycles: [
        ...(operational.pendingPlannerCycles ?? []),
      ] as SatRuntimeSummary["pendingPlannerCycles"],
      roundExecution: [
        ...(operational.roundExecution ?? []),
      ] as SatRuntimeSummary["roundExecution"],
      claimBacklog: [...(operational.claimBacklog ?? [])] as SatRuntimeSummary["claimBacklog"],
      settlementPageParticipants: [
        ...(operational.settlementPageParticipants ?? []),
      ] as SatRuntimeSummary["settlementPageParticipants"],
      settlementPageLookupTables: [
        ...(operational.settlementPageLookupTables ?? []),
      ] as SatRuntimeSummary["settlementPageLookupTables"],
      workers: (operational.workers ?? {}) as SatRuntimeSummary["workers"],
      lastKnownStatus:
        (runtimeMeta.lastKnownStatus as SatRuntimeSummary["lastKnownStatus"]) ?? null,
      chainTime: (runtimeMeta.chainTime as SatRuntimeSummary["chainTime"]) ?? null,
      currentRunStartedAt:
        (runtimeMeta.currentRunStartedAt as SatRuntimeSummary["currentRunStartedAt"]) ?? null,
      runStartSolBalanceLamports:
        (runtimeMeta.runStartSolBalanceLamports as SatRuntimeSummary["runStartSolBalanceLamports"]) ??
        null,
      runStartSatBalanceRaw:
        (runtimeMeta.runStartSatBalanceRaw as SatRuntimeSummary["runStartSatBalanceRaw"]) ?? null,
      enabledWanted: runtimeMeta.enabledWanted === true,
      lastAction: (runtimeMeta.lastAction as SatRuntimeSummary["lastAction"]) ?? null,
      lastActionTxHash:
        (runtimeMeta.lastActionTxHash as SatRuntimeSummary["lastActionTxHash"]) ?? null,
      lastFailure: (runtimeMeta.lastFailure as SatRuntimeSummary["lastFailure"]) ?? null,
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
    this.assertSubmissionStateIdentity(params);
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
    this.assertSubmissionStateIdentity(params);
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
    this.assertSubmissionStateIdentity(params);
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
    this.assertSubmissionStateIdentity(params);
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

  /**
   * Transactionally bound rolling retention. Operational/recovery and live
   * submission cycles are excluded before any row is eligible. The anchor
   * records the terminal digest of each retired prefix so the retained chain
   * remains honestly verifiable instead of pretending it starts at genesis.
   */
  async enforceRetention(
    policy: Partial<SatMiningHistoryRetentionPolicy> = {},
  ): Promise<SatMiningHistoryRetentionReceipt> {
    const limits: SatMiningHistoryRetentionPolicy = {
      maxActions: normalizeRetentionLimit(
        policy.maxActions,
        DEFAULT_MINING_HISTORY_RETENTION.maxActions,
      ),
      maxOutcomes: normalizeRetentionLimit(
        policy.maxOutcomes,
        DEFAULT_MINING_HISTORY_RETENTION.maxOutcomes,
      ),
      maxPlannerCycles: normalizeRetentionLimit(
        policy.maxPlannerCycles,
        DEFAULT_MINING_HISTORY_RETENTION.maxPlannerCycles,
      ),
      maxAuditArtifacts: normalizeRetentionLimit(
        policy.maxAuditArtifacts,
        DEFAULT_MINING_HISTORY_RETENTION.maxAuditArtifacts,
      ),
    };
    let receipt!: SatMiningHistoryRetentionReceipt;
    await this.enqueueWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const protectedCycles = this.readProtectedCycleIds();
        const prune = (
          table: "mining_event" | "planner_outcome" | "planner_cycle",
          maxRows: number,
          kind: "actions" | "outcomes" | "planner-cycles",
        ): number => {
          const rows = this.db
            .prepare(
              `SELECT sequence, cycle_id, event_digest FROM ${table}
                WHERE scope_id=? ORDER BY sequence ASC`,
            )
            .all(this.scopeId) as SqlRow[];
          const required = Math.max(0, rows.length - maxRows);
          const firstProtected = rows.findIndex(
            (row) => row.cycle_id != null && protectedCycles.has(Number(row.cycle_id)),
          );
          // Retire only an oldest contiguous prefix. A protected record fences
          // the prefix even when it prevents meeting the nominal bound.
          const allowedPrefix = firstProtected < 0 ? rows : rows.slice(0, firstProtected);
          const retired = allowedPrefix.slice(0, required);
          if (retired.length === 0) {
            return 0;
          }
          const sequences = retired.map((row) => Number(row.sequence));
          const terminal = String(retired.at(-1)?.event_digest ?? "");
          this.db
            .prepare(
              "INSERT INTO mining_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            )
            .run(
              `retention-anchor:${this.scopeId}:${kind}`,
              canonicalJson({
                retiredCount: sequences.length,
                terminalDigest: terminal,
                retainedAt: new Date().toISOString(),
              }),
            );
          this.db
            .prepare(
              `DELETE FROM ${table} WHERE sequence IN (${sequences.map(() => "?").join(",")})`,
            )
            .run(...sequences);
          return sequences.length;
        };
        const prunedActions = prune("mining_event", limits.maxActions, "actions");
        const prunedOutcomes = prune("planner_outcome", limits.maxOutcomes, "outcomes");
        const prunedPlannerCycles = prune(
          "planner_cycle",
          limits.maxPlannerCycles,
          "planner-cycles",
        );
        const auditRows = this.db
          .prepare(
            `SELECT artifact_key, payload_json FROM audit_artifact
              WHERE scope_id=? ORDER BY updated_at_ms ASC, artifact_key ASC`,
          )
          .all(this.scopeId) as SqlRow[];
        const auditRequired = Math.max(0, auditRows.length - limits.maxAuditArtifacts);
        const retiredAudit = auditRows
          .filter((row) => !this.auditArtifactIsProtected(row, protectedCycles))
          .slice(0, auditRequired);
        if (retiredAudit.length > 0) {
          this.db
            .prepare(
              `DELETE FROM audit_artifact WHERE scope_id=? AND artifact_key IN (${retiredAudit
                .map(() => "?")
                .join(",")})`,
            )
            .run(this.scopeId, ...retiredAudit.map((row) => String(row.artifact_key)));
        }
        const prunedAuditArtifacts = retiredAudit.length;
        const historyRevision =
          prunedActions || prunedOutcomes || prunedPlannerCycles || prunedAuditArtifacts
            ? incrementHistoryRevision(this.db)
            : getHistoryRevision(this.db);
        receipt = {
          walletId: this.scope.walletId,
          scopeKey: this.getScopeKey(),
          prunedActions,
          prunedOutcomes,
          prunedPlannerCycles,
          prunedAuditArtifacts,
          protectedCycleCount: protectedCycles.size,
          historyRevision,
        };
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
    return receipt;
  }

  async enforceDefaultRetentionIfNeeded(): Promise<SatMiningHistoryRetentionReceipt | null> {
    if (this.readOnly || this.lifecycleFenced || this.closed) {
      return null;
    }
    const counts = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM mining_event WHERE scope_id=?) AS actions,
           (SELECT COUNT(*) FROM planner_outcome WHERE scope_id=?) AS outcomes,
           (SELECT COUNT(*) FROM planner_cycle WHERE scope_id=?) AS planner_cycles`,
      )
      .get(this.scopeId, this.scopeId, this.scopeId) as SqlRow;
    const auditCount = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS count FROM audit_artifact WHERE scope_id=?")
          .get(this.scopeId) as SqlRow
      ).count,
    );
    if (
      Number(counts.actions) <= DEFAULT_MINING_HISTORY_RETENTION.maxActions &&
      Number(counts.outcomes) <= DEFAULT_MINING_HISTORY_RETENTION.maxOutcomes &&
      Number(counts.planner_cycles) <= DEFAULT_MINING_HISTORY_RETENTION.maxPlannerCycles &&
      auditCount <= DEFAULT_MINING_HISTORY_RETENTION.maxAuditArtifacts
    ) {
      return null;
    }
    return await this.enforceRetention();
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

  /** Fence late writers, drain the exact queued chain, then make the WAL
   * snapshot-safe. This is intentionally separate from ordinary close. */
  async checkpointAndCloseForLifecycle(): Promise<void> {
    if (this.readOnly || this.closed) {
      return;
    }
    this.lifecycleFenced = true;
    let failure: unknown;
    try {
      await this.writeChain;
      const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as SqlRow;
      const busy = Number(row.busy);
      const log = Number(row.log);
      const checkpointed = Number(row.checkpointed);
      if (
        !Number.isSafeInteger(busy) ||
        !Number.isSafeInteger(log) ||
        !Number.isSafeInteger(checkpointed) ||
        busy !== 0 ||
        log < 0 ||
        checkpointed < 0 ||
        checkpointed !== log
      ) {
        throw new Error(
          `Mining lifecycle WAL checkpoint failed (busy=${String(row.busy)}, log=${String(row.log)}, checkpointed=${String(row.checkpointed)})`,
        );
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        this.db.close();
        this.closed = true;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      throw failure;
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
    if (!this.readOnly && !this.closed) {
      this.checkpoint();
    }
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
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
    if (this.lifecycleFenced || this.closed) {
      throw new Error("Mining history store is fenced for lifecycle checkpoint");
    }
    const next = this.writeChain.catch(() => {}).then(operation);
    this.writeChain = next.then(() => undefined).catch(() => undefined);
    return await next;
  }

  private readProtectedCycleIds(): Set<number> {
    const protectedCycles = new Set<number>();
    const addFromPayload = (payload: unknown) => {
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit);
        } else if (value && typeof value === "object") {
          for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
            if (key === "cycleId" && typeof nested === "number" && Number.isSafeInteger(nested)) {
              protectedCycles.add(nested);
            }
            visit(nested);
          }
        }
      };
      visit(payload);
    };
    for (const table of [
      "round_execution",
      "pending_planner_cycle",
      "claim_backlog",
      "settlement_state",
    ]) {
      for (const row of this.db
        .prepare(`SELECT payload_json FROM ${table} WHERE scope_id=?`)
        .all(this.scopeId) as SqlRow[]) {
        addFromPayload(JSON.parse(String(row.payload_json)) as unknown);
      }
    }
    for (const row of this.db
      .prepare("SELECT state, payload_json FROM submission_record WHERE scope_id=?")
      .all(this.scopeId) as SqlRow[]) {
      if (!["confirmed", "failed", "rejected"].includes(String(row.state))) {
        const record = normalizeSatSubmissionRecord(
          JSON.parse(String(row.payload_json)) as unknown,
        );
        if (!record) {
          throw new Error("Mining retention cannot classify a live submission record");
        }
        const cycleId = submissionRecordCycleId(record);
        if (cycleId == null) {
          throw new Error(
            `Mining retention cannot classify live submission cycle ${record.requestId}`,
          );
        }
        protectedCycles.add(cycleId);
      }
    }
    return protectedCycles;
  }

  private auditArtifactIsProtected(row: SqlRow, protectedCycles: ReadonlySet<number>): boolean {
    const keyCycle = Number(String(row.artifact_key).split(":", 1)[0]);
    if (Number.isSafeInteger(keyCycle) && protectedCycles.has(keyCycle)) {
      return true;
    }
    const values = new Set<number>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === "object") {
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
          if (key === "cycleId" && typeof nested === "number" && Number.isSafeInteger(nested)) {
            values.add(nested);
          }
          visit(nested);
        }
      }
    };
    visit(JSON.parse(String(row.payload_json)) as unknown);
    return [...values].some((cycleId) => protectedCycles.has(cycleId));
  }
}

function submissionRecordCycleId(record: SatSubmissionRecord): number | null {
  const cycleIds = new Set<number>();
  for (const [value, pattern] of [
    [record.workflowId, /(?:^|:)cycle:(\d+)(?:$|:)/gu],
    [
      record.operationKey,
      /(?:^|:)(?:commitCycle|revealCycle|submitCycle|closeCycle|claimCycle):(\d+)(?:$|:)/gu,
    ],
  ] as const) {
    for (const match of value.matchAll(pattern)) {
      const candidate = Number(match[1]);
      if (!Number.isSafeInteger(candidate) || candidate < 0) {
        return null;
      }
      cycleIds.add(candidate);
    }
  }
  return cycleIds.size === 1 ? [...cycleIds][0]! : null;
}

function normalizeRetentionLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Mining history retention limit must be a positive safe integer");
  }
  return value;
}

export function resolveSatMiningHistoryDatabasePath(
  stateDir: string,
  walletStateKey: string,
): string {
  return path.join(stateDir, "sat-mining", "wallets", walletStateKey, "mining.sqlite");
}
