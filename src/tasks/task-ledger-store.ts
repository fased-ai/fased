import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";

const SCHEMA_VERSION = 3;
const BUSY_TIMEOUT_MS = 5_000;
const WAL_AUTOCHECKPOINT_PAGES = 256;
const EMPTY_LOCK_GRACE_MS = 30_000;
const LOCK_OWNER_FILE = "owner.json";

type TaskRow = { task_json: string };
type DefinitionRow = { record_json: string };
type CronQueueRow = { run_json: string };
type CronQueueStoredRow = {
  run_id: string;
  job_id: string;
  status: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  run_json: string;
};

const CRON_QUEUE_IMPORT_MARKER = "cron_task_run_queue_import";
const CRON_QUEUE_TERMINAL_STATUSES = new Set([
  "ok",
  "error",
  "skipped",
  "blocked",
  "canceled",
  "recovered",
]);
const CRON_QUEUE_TERMINAL_HISTORY_LIMIT = 500;

export type TaskDefinitionCollection = "task_flow" | "standing_order" | "workflow_definition";

export type TaskDefinitionRecord<T> = {
  collection: TaskDefinitionCollection;
  scopeKey: string;
  recordId: string;
  updatedAt: number;
  record: T;
};

export type TaskLedgerInitialization = {
  databasePath: string;
  legacyPath: string;
  sanitizeLegacy: (raw: unknown) => TaskRecord[];
};

/** The indexed fields are deliberately duplicated from the exact queue JSON. */
export type TaskLedgerCronQueueRun = {
  runId: string;
  jobId: string;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
};

function sqliteFamilyPaths(databasePath: string): string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
}

function closeQuietly(db: DatabaseSync | undefined): void {
  try {
    db?.close();
  } catch {
    // Preserve the original bootstrap error.
  }
}

function removeSqliteFamily(databasePath: string): void {
  for (const candidate of sqliteFamilyPaths(databasePath)) {
    fs.rmSync(candidate, { force: true });
  }
}

function lockOwnerPath(lockPath: string): string {
  return path.join(lockPath, LOCK_OWNER_FILE);
}

function temporaryLedgerPaths(databasePath: string): string[] {
  const directory = path.dirname(databasePath);
  const prefix = `.${path.basename(databasePath)}.`;
  try {
    return fs
      .readdirSync(directory)
      .filter(
        (name) =>
          name.startsWith(prefix) &&
          (name.endsWith(".tmp") || name.endsWith(".tmp-wal") || name.endsWith(".tmp-shm")),
      )
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function ownerIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    return code === "EPERM";
  }
}

function recoverStaleInitializerLock(databasePath: string, lockPath: string): void {
  const directory = path.dirname(databasePath);
  const ownerPath = lockOwnerPath(lockPath);
  let ownerPid: number | undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as { pid?: unknown };
    ownerPid = typeof raw.pid === "number" ? raw.pid : undefined;
  } catch {
    // A crash between mkdir and durable owner metadata is recovered only after a grace period.
  }
  if (ownerPid !== undefined && ownerIsAlive(ownerPid)) {
    throw new Error("Task ledger initialization is already in progress");
  }
  if (ownerPid === undefined) {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age < EMPTY_LOCK_GRACE_MS) {
      throw new Error("Task ledger initialization is already in progress");
    }
  }
  for (const candidate of temporaryLedgerPaths(databasePath)) {
    fs.rmSync(candidate, { force: true });
  }
  fs.rmSync(ownerPath, { force: true });
  fs.rmdirSync(lockPath);
  fsyncDirectory(directory);
}

function acquireInitializerLock(databasePath: string): boolean {
  const directory = path.dirname(databasePath);
  const lockPath = `${databasePath}.init-lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let created = false;
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      created = true;
      const ownerPath = lockOwnerPath(lockPath);
      fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      fs.chmodSync(ownerPath, 0o600);
      fsyncFile(ownerPath);
      fsyncDirectory(directory);
      return true;
    } catch (err) {
      if (created) {
        fs.rmSync(lockOwnerPath(lockPath), { force: true });
        fs.rmdirSync(lockPath);
        fsyncDirectory(directory);
        throw err;
      }
      if (fs.existsSync(databasePath)) {
        return false;
      }
      if (!fs.existsSync(lockPath) || attempt > 0) {
        throw new Error("Task ledger initialization is already in progress", { cause: err });
      }
      recoverStaleInitializerLock(databasePath, lockPath);
    }
  }
  throw new Error("Task ledger initialization is already in progress");
}

function releaseInitializerLock(databasePath: string): void {
  const lockPath = `${databasePath}.init-lock`;
  fs.rmSync(lockOwnerPath(lockPath), { force: true });
  fs.rmdirSync(lockPath);
  fsyncDirectory(path.dirname(databasePath));
}

function secureSqliteFamily(databasePath: string): void {
  for (const candidate of sqliteFamilyPaths(databasePath)) {
    if (fs.existsSync(candidate)) {
      fs.chmodSync(candidate, 0o600);
    }
  }
}

function configureDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  db.exec(`PRAGMA wal_autocheckpoint=${WAL_AUTOCHECKPOINT_PAGES}`);
}

function existingSchemaVersion(db: DatabaseSync): number {
  const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (userVersion.user_version > SCHEMA_VERSION) {
    throw new Error(
      `Task ledger schema ${userVersion.user_version} is newer than supported schema ${SCHEMA_VERSION}`,
    );
  }
  const meta = db
    .prepare("SELECT value FROM task_ledger_meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  const metaVersion = meta ? Number(meta.value) : Number.NaN;
  if (
    userVersion.user_version !== metaVersion ||
    (userVersion.user_version !== 1 &&
      userVersion.user_version !== 2 &&
      userVersion.user_version !== 3)
  ) {
    throw new Error("Task ledger schema is missing, corrupt, or unsupported");
  }
  const tasksTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_ledger_tasks'")
    .get();
  if (!tasksTable) {
    throw new Error("Task ledger tasks table is missing");
  }
  if (userVersion.user_version >= 2) {
    const definitionsTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_ledger_definitions'",
      )
      .get();
    if (!definitionsTable) {
      throw new Error("Task ledger definitions table is missing");
    }
  }
  if (userVersion.user_version === 3) {
    const queueTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_ledger_cron_queue'",
      )
      .get();
    if (!queueTable) {
      throw new Error("Task ledger cron queue table is missing");
    }
  }
  return userVersion.user_version;
}

function upgradeSchemaV1ToV2(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE task_ledger_definitions (
        collection_kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        record_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (collection_kind, scope_key, record_id)
      );
      CREATE INDEX task_ledger_definitions_collection_scope_updated_idx
        ON task_ledger_definitions(collection_kind, scope_key, updated_at DESC, record_id);
      CREATE INDEX task_ledger_definitions_collection_updated_idx
        ON task_ledger_definitions(collection_kind, updated_at DESC, record_id);
    `);
    db.prepare("UPDATE task_ledger_meta SET value = ? WHERE key = 'schema_version'").run("2");
    db.exec("PRAGMA user_version=2");
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may not have been opened successfully.
    }
    throw err;
  }
}

function upgradeSchemaV2ToV3(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE task_ledger_cron_queue (
        run_id TEXT PRIMARY KEY NOT NULL,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        run_json TEXT NOT NULL
      );
      CREATE INDEX task_ledger_cron_queue_status_recency_idx
        ON task_ledger_cron_queue(status, completed_at DESC, updated_at DESC, run_id);
      CREATE INDEX task_ledger_cron_queue_job_recency_idx
        ON task_ledger_cron_queue(job_id, updated_at DESC, run_id);
    `);
    db.prepare("UPDATE task_ledger_meta SET value = ? WHERE key = 'schema_version'").run("3");
    db.exec("PRAGMA user_version=3");
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may not have been opened successfully.
    }
    throw err;
  }
}

function initializeSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE task_ledger_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE task_ledger_tasks (
        task_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT UNIQUE,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        agent_id TEXT,
        requester_session_key TEXT,
        session_key TEXT,
        owner_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        task_json TEXT NOT NULL
      );
      CREATE INDEX task_ledger_tasks_updated_at_idx
        ON task_ledger_tasks(updated_at DESC, created_at DESC);
      CREATE INDEX task_ledger_tasks_source_status_idx
        ON task_ledger_tasks(source, status, updated_at DESC);
      CREATE INDEX task_ledger_tasks_agent_id_idx
        ON task_ledger_tasks(agent_id, updated_at DESC);
      CREATE INDEX task_ledger_tasks_session_keys_idx
        ON task_ledger_tasks(requester_session_key, session_key, owner_key, updated_at DESC);
      CREATE TABLE task_ledger_definitions (
        collection_kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        record_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (collection_kind, scope_key, record_id)
      );
      CREATE INDEX task_ledger_definitions_collection_scope_updated_idx
        ON task_ledger_definitions(collection_kind, scope_key, updated_at DESC, record_id);
      CREATE INDEX task_ledger_definitions_collection_updated_idx
        ON task_ledger_definitions(collection_kind, updated_at DESC, record_id);
      CREATE TABLE task_ledger_cron_queue (
        run_id TEXT PRIMARY KEY NOT NULL,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        run_json TEXT NOT NULL
      );
      CREATE INDEX task_ledger_cron_queue_status_recency_idx
        ON task_ledger_cron_queue(status, completed_at DESC, updated_at DESC, run_id);
      CREATE INDEX task_ledger_cron_queue_job_recency_idx
        ON task_ledger_cron_queue(job_id, updated_at DESC, run_id);
    `);
    db.prepare("INSERT INTO task_ledger_meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may not have been opened successfully.
    }
    throw err;
  }
}

function recordToParams(record: TaskRecord) {
  return {
    taskId: record.taskId,
    runId: record.runId ?? null,
    source: record.source,
    status: record.status,
    agentId: record.agentId ?? null,
    requesterSessionKey: record.requesterSessionKey ?? null,
    sessionKey: record.sessionKey ?? null,
    ownerKey: record.ownerKey ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt ?? record.createdAt,
    taskJson: JSON.stringify(record),
  };
}

function parseRow(row: TaskRow | undefined): TaskRecord | undefined {
  if (!row) {
    return undefined;
  }
  try {
    return JSON.parse(row.task_json) as TaskRecord;
  } catch (err) {
    throw new Error("Task ledger contains invalid task JSON", { cause: err });
  }
}

export class TaskLedgerStore {
  private readonly db: DatabaseSync;
  readonly databasePath: string;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(databasePath);
    try {
      const schemaVersion = existingSchemaVersion(this.db);
      if (schemaVersion === 1) {
        upgradeSchemaV1ToV2(this.db);
      }
      if (schemaVersion <= 2) {
        upgradeSchemaV2ToV3(this.db);
      }
      configureDatabase(this.db);
      secureSqliteFamily(this.databasePath);
    } catch (err) {
      closeQuietly(this.db);
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  list(): TaskRecord[] {
    return (this.db.prepare("SELECT task_json FROM task_ledger_tasks").all() as TaskRow[]).map(
      (row) => {
        const record = parseRow(row);
        if (!record) {
          throw new Error("Task ledger returned an empty task row");
        }
        return record;
      },
    );
  }

  find(taskIdOrRunId: string): TaskRecord | undefined {
    return parseRow(
      this.db
        .prepare(
          "SELECT task_json FROM task_ledger_tasks WHERE task_id = ? OR run_id = ? ORDER BY task_id = ? DESC LIMIT 1",
        )
        .get(taskIdOrRunId, taskIdOrRunId, taskIdOrRunId) as TaskRow | undefined,
    );
  }

  upsert(
    record: TaskRecord,
    mergeExisting: (existing: TaskRecord, incoming: TaskRecord) => TaskRecord,
  ): TaskRecord {
    return this.withWriteTransaction(() => {
      const byTaskId = this.findByTaskId(record.taskId);
      const byRunId = record.runId ? this.findByRunId(record.runId) : undefined;
      if (byTaskId && byRunId && byTaskId.taskId !== byRunId.taskId) {
        throw new Error("Task ledger identity collision between taskId and runId");
      }
      const existing = byTaskId ?? byRunId;
      const next = existing ? mergeExisting(existing, record) : record;
      this.write(next, existing?.taskId);
      return next;
    });
  }

  update(
    taskIdOrRunId: string,
    update: (current: TaskRecord) => TaskRecord | undefined | null,
  ): TaskRecord | undefined {
    return this.withWriteTransaction(() => {
      const current = this.find(taskIdOrRunId);
      if (!current) {
        return undefined;
      }
      const next = update(current);
      if (!next) {
        return current;
      }
      this.write(next, current.taskId);
      return next;
    });
  }

  replaceAll(records: TaskRecord[]): void {
    this.withWriteTransaction(() => {
      this.db.exec("DELETE FROM task_ledger_tasks");
      for (const record of records) {
        this.write(record);
      }
    });
  }

  /**
   * Read the cron queue in its stable insertion order. Queue JSON is parsed only
   * after the durable import marker exists; callers use ensureCronQueueImported
   * for the one-time legacy transition.
   */
  listCronTaskRuns<T extends TaskLedgerCronQueueRun>(): T[] {
    return (
      this.db
        .prepare("SELECT run_json FROM task_ledger_cron_queue ORDER BY rowid ASC")
        .all() as CronQueueRow[]
    ).map((row) => this.parseCronQueueRow<T>(row));
  }

  isCronTaskRunQueueImported(): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM task_ledger_meta WHERE key = ?").get(CRON_QUEUE_IMPORT_MARKER),
    );
  }

  /**
   * Atomically checks the marker, reads legacy state at most once, records its
   * sanitized runs, bounds terminal history, and only then commits the marker.
   */
  ensureCronTaskRunQueueImported<T extends TaskLedgerCronQueueRun>(loadLegacy: () => T[]): void {
    this.withWriteTransaction(() => {
      if (this.isCronTaskRunQueueImported()) {
        return;
      }
      const runs = loadLegacy();
      this.persistCronTaskRuns(runs);
      this.db
        .prepare("INSERT INTO task_ledger_meta (key, value) VALUES (?, '1')")
        .run(CRON_QUEUE_IMPORT_MARKER);
    });
  }

  /** Every queue mutation has one BEGIN IMMEDIATE authority across handles. */
  updateCronTaskRunQueue<T extends TaskLedgerCronQueueRun, R>(update: (runs: T[]) => R): R {
    return this.withWriteTransaction(() => {
      const runs = this.listCronTaskRuns<T>();
      const result = update(runs);
      this.persistCronTaskRuns(runs);
      return result;
    });
  }

  isDefinitionCollectionImported(collection: TaskDefinitionCollection): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM task_ledger_meta WHERE key = ?")
        .get(`definition_import:${collection}`),
    );
  }

  listDefinitionRecords<T>(collection: TaskDefinitionCollection): TaskDefinitionRecord<T>[] {
    return (
      this.db
        .prepare(
          "SELECT collection_kind, scope_key, record_id, updated_at, record_json FROM task_ledger_definitions WHERE collection_kind = ?",
        )
        .all(collection) as Array<{
        collection_kind: TaskDefinitionCollection;
        scope_key: string;
        record_id: string;
        updated_at: number;
        record_json: string;
      }>
    ).map((row) => ({
      collection: row.collection_kind,
      scopeKey: row.scope_key,
      recordId: row.record_id,
      updatedAt: row.updated_at,
      record: this.parseDefinitionRow<T>(row),
    }));
  }

  updateDefinitionRecord<T>(
    collection: TaskDefinitionCollection,
    scopeKey: string,
    recordId: string,
    update: (current: T | undefined) => T | undefined,
    updatedAt: (record: T) => number,
  ): T | undefined {
    return this.withWriteTransaction(() => {
      const row = this.db
        .prepare(
          "SELECT record_json FROM task_ledger_definitions WHERE collection_kind = ? AND scope_key = ? AND record_id = ?",
        )
        .get(collection, scopeKey, recordId) as DefinitionRow | undefined;
      const next = update(row ? this.parseDefinitionRow<T>(row) : undefined);
      if (next === undefined) {
        if (row) {
          this.db
            .prepare(
              "DELETE FROM task_ledger_definitions WHERE collection_kind = ? AND scope_key = ? AND record_id = ?",
            )
            .run(collection, scopeKey, recordId);
        }
        return undefined;
      }
      this.writeDefinitionRecord(collection, scopeKey, recordId, next, updatedAt(next));
      return next;
    });
  }

  replaceDefinitionCollection<T>(
    collection: TaskDefinitionCollection,
    records: TaskDefinitionRecord<T>[],
  ): void {
    this.withWriteTransaction(() => {
      this.db
        .prepare("DELETE FROM task_ledger_definitions WHERE collection_kind = ?")
        .run(collection);
      for (const entry of records) {
        this.writeDefinitionRecord(
          collection,
          entry.scopeKey,
          entry.recordId,
          entry.record,
          entry.updatedAt,
        );
      }
    });
  }

  importDefinitionCollection<T>(
    collection: TaskDefinitionCollection,
    records: TaskDefinitionRecord<T>[],
  ): void {
    this.withWriteTransaction(() => {
      const marker = `definition_import:${collection}`;
      if (this.db.prepare("SELECT 1 FROM task_ledger_meta WHERE key = ?").get(marker)) {
        return;
      }
      for (const entry of records) {
        this.writeDefinitionRecord(
          collection,
          entry.scopeKey,
          entry.recordId,
          entry.record,
          entry.updatedAt,
        );
      }
      this.db.prepare("INSERT INTO task_ledger_meta (key, value) VALUES (?, '1')").run(marker);
    });
  }

  private withWriteTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      secureSqliteFamily(this.databasePath);
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Keep the original write error.
      }
      throw err;
    }
  }

  private findByTaskId(taskId: string): TaskRecord | undefined {
    return parseRow(
      this.db.prepare("SELECT task_json FROM task_ledger_tasks WHERE task_id = ?").get(taskId) as
        | TaskRow
        | undefined,
    );
  }

  private parseDefinitionRow<T>(row: DefinitionRow): T {
    try {
      return JSON.parse(row.record_json) as T;
    } catch (err) {
      throw new Error("Task ledger contains invalid definition JSON", { cause: err });
    }
  }

  private parseCronQueueRow<T extends TaskLedgerCronQueueRun>(row: CronQueueRow): T {
    try {
      const run = JSON.parse(row.run_json) as T;
      if (!run || typeof run.runId !== "string" || typeof run.jobId !== "string") {
        throw new Error("Cron queue row has no valid run identity");
      }
      return run;
    } catch (err) {
      throw new Error("Task ledger contains invalid cron queue JSON", { cause: err });
    }
  }

  private persistCronTaskRuns<T extends TaskLedgerCronQueueRun>(runs: T[]): void {
    const seen = new Set<string>();
    for (const run of runs) {
      if (
        !run.runId.trim() ||
        !run.jobId.trim() ||
        !run.status.trim() ||
        !Number.isFinite(run.createdAtMs) ||
        !Number.isFinite(run.updatedAtMs) ||
        seen.has(run.runId)
      ) {
        throw new Error("Task ledger cron queue mutation has an invalid or duplicate run");
      }
      seen.add(run.runId);
    }
    const terminalRuns = runs
      .filter((run) => CRON_QUEUE_TERMINAL_STATUSES.has(run.status))
      .toSorted((left, right) => {
        const leftRecency = left.completedAtMs ?? left.updatedAtMs;
        const rightRecency = right.completedAtMs ?? right.updatedAtMs;
        return (
          rightRecency - leftRecency ||
          right.updatedAtMs - left.updatedAtMs ||
          left.runId.localeCompare(right.runId)
        );
      });
    const retainedTerminalIds = new Set(
      terminalRuns.slice(0, CRON_QUEUE_TERMINAL_HISTORY_LIMIT).map((run) => run.runId),
    );
    const retainedRuns = runs.filter(
      (run) => !CRON_QUEUE_TERMINAL_STATUSES.has(run.status) || retainedTerminalIds.has(run.runId),
    );
    const existingRows = new Map(
      (
        this.db
          .prepare(
            "SELECT run_id, job_id, status, created_at, updated_at, completed_at, run_json FROM task_ledger_cron_queue",
          )
          .all() as CronQueueStoredRow[]
      ).map((row) => [row.run_id, row]),
    );
    const write = this.db.prepare(`
      INSERT INTO task_ledger_cron_queue (
        run_id, job_id, status, created_at, updated_at, completed_at, run_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        job_id = excluded.job_id,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        run_json = excluded.run_json
    `);
    for (const run of retainedRuns) {
      const completedAt = run.completedAtMs ?? null;
      const runJson = JSON.stringify(run);
      const existing = existingRows.get(run.runId);
      if (
        existing &&
        existing.job_id === run.jobId &&
        existing.status === run.status &&
        existing.created_at === run.createdAtMs &&
        existing.updated_at === run.updatedAtMs &&
        existing.completed_at === completedAt &&
        existing.run_json === runJson
      ) {
        existingRows.delete(run.runId);
        continue;
      }
      write.run(
        run.runId,
        run.jobId,
        run.status,
        run.createdAtMs,
        run.updatedAtMs,
        completedAt,
        runJson,
      );
      existingRows.delete(run.runId);
    }
    const remove = this.db.prepare("DELETE FROM task_ledger_cron_queue WHERE run_id = ?");
    for (const runId of existingRows.keys()) {
      remove.run(runId);
    }
  }

  private writeDefinitionRecord<T>(
    collection: TaskDefinitionCollection,
    scopeKey: string,
    recordId: string,
    record: T,
    updatedAt: number,
  ): void {
    this.db
      .prepare(`
        INSERT INTO task_ledger_definitions (
          collection_kind, scope_key, record_id, updated_at, record_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(collection_kind, scope_key, record_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          record_json = excluded.record_json
      `)
      .run(collection, scopeKey, recordId, updatedAt, JSON.stringify(record));
  }

  private findByRunId(runId: string): TaskRecord | undefined {
    return parseRow(
      this.db.prepare("SELECT task_json FROM task_ledger_tasks WHERE run_id = ?").get(runId) as
        | TaskRow
        | undefined,
    );
  }

  private write(record: TaskRecord, previousTaskId = record.taskId): void {
    const taskIdCollision = this.findByTaskId(record.taskId);
    if (taskIdCollision && taskIdCollision.taskId !== previousTaskId) {
      throw new Error("Task ledger taskId conflicts with a different record");
    }
    const runIdCollision = record.runId ? this.findByRunId(record.runId) : undefined;
    if (runIdCollision && runIdCollision.taskId !== previousTaskId) {
      throw new Error("Task ledger runId conflicts with a different record");
    }
    if (previousTaskId !== record.taskId) {
      this.db.prepare("DELETE FROM task_ledger_tasks WHERE task_id = ?").run(previousTaskId);
    }
    const params = recordToParams(record);
    this.db
      .prepare(`
        INSERT INTO task_ledger_tasks (
          task_id, run_id, source, status, agent_id, requester_session_key, session_key,
          owner_key, created_at, updated_at, task_json
        ) VALUES (
          $taskId, $runId, $source, $status, $agentId, $requesterSessionKey, $sessionKey,
          $ownerKey, $createdAt, $updatedAt, $taskJson
        ) ON CONFLICT(task_id) DO UPDATE SET
          run_id = excluded.run_id,
          source = excluded.source,
          status = excluded.status,
          agent_id = excluded.agent_id,
          requester_session_key = excluded.requester_session_key,
          session_key = excluded.session_key,
          owner_key = excluded.owner_key,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          task_json = excluded.task_json
      `)
      .run(params);
  }
}

export function openTaskLedgerStore(databasePath: string): TaskLedgerStore {
  return new TaskLedgerStore(databasePath);
}

/** Create and atomically publish the first ledger; existing ledgers are never rewritten here. */
export function initializeTaskLedger(input: TaskLedgerInitialization): void {
  const databasePath = input.databasePath;
  if (fs.existsSync(databasePath)) {
    return;
  }
  const directory = path.dirname(databasePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  let lockHeld = false;
  let tempPath: string | undefined;
  let db: DatabaseSync | undefined;
  try {
    lockHeld = acquireInitializerLock(databasePath);
    if (!lockHeld) {
      return;
    }
    if (fs.existsSync(databasePath)) {
      return;
    }
    let legacy: TaskRecord[] = [];
    if (fs.existsSync(input.legacyPath)) {
      const legacyBytes = fs.readFileSync(input.legacyPath, "utf8");
      try {
        legacy = input.sanitizeLegacy(JSON.parse(legacyBytes));
      } catch (err) {
        throw new Error("Task ledger legacy import failed: tasks.json is malformed", {
          cause: err,
        });
      }
    }
    tempPath = path.join(
      directory,
      `.${path.basename(databasePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(tempPath);
    configureDatabase(db);
    initializeSchema(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      const insert = db.prepare(`
        INSERT INTO task_ledger_tasks (
          task_id, run_id, source, status, agent_id, requester_session_key, session_key,
          owner_key, created_at, updated_at, task_json
        ) VALUES (
          $taskId, $runId, $source, $status, $agentId, $requesterSessionKey, $sessionKey,
          $ownerKey, $createdAt, $updatedAt, $taskJson
        )
      `);
      for (const record of legacy) {
        insert.run(recordToParams(record));
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The insertion transaction may not have started.
      }
      throw err;
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    db = undefined;
    secureSqliteFamily(tempPath);
    fsyncFile(tempPath);
    if (fs.existsSync(databasePath)) {
      throw new Error("Task ledger appeared during initialization");
    }
    fs.renameSync(tempPath, databasePath);
    tempPath = undefined;
    secureSqliteFamily(databasePath);
    fsyncDirectory(directory);
  } finally {
    closeQuietly(db);
    if (tempPath) {
      removeSqliteFamily(tempPath);
    }
    if (lockHeld) {
      releaseInitializerLock(databasePath);
    }
  }
}
