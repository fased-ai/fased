import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { initializeTaskLedger, openTaskLedgerStore } from "./task-ledger-store.js";
import {
  createTaskRecord,
  listAllTaskRecords,
  resetTaskRegistryForTests,
  resolveTaskLedgerPath,
  resolveTaskRegistryPath,
  updateTaskRecord,
} from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

let stateDir: string;
let temporaryStateDir: string;
let previousStateDir: string | undefined;

function task(taskId: string, runId = `run-${taskId}`): TaskRecord {
  return {
    taskId,
    runId,
    source: "cron",
    runtime: "cron",
    task: taskId,
    status: "queued",
    deliveryStatus: "not_applicable",
    notifyPolicy: "done_only",
    createdAt: 10,
    updatedAt: 10,
  };
}

function temporaryLedgerPaths(ledgerPath: string): string[] {
  const prefix = `.${path.basename(ledgerPath)}.`;
  return fs
    .readdirSync(path.dirname(ledgerPath))
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        (name.endsWith(".tmp") || name.endsWith(".tmp-wal") || name.endsWith(".tmp-shm")),
    );
}

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  temporaryStateDir = await mkdtemp(path.join(os.tmpdir(), "fased-task-ledger-store-"));
  process.env.FASED_STATE_DIR = temporaryStateDir;
  resetTaskRegistryForTests({ persist: true });
  stateDir = path.join(temporaryStateDir, "ledger-case");
  process.env.FASED_STATE_DIR = stateDir;
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  resetTaskRegistryForTests({ persist: false });
  await rm(temporaryStateDir, { recursive: true, force: true });
});

describe("task ledger store", () => {
  it("imports valid legacy records once without changing legacy bytes", async () => {
    const legacyPath = resolveTaskRegistryPath();
    const ledgerPath = resolveTaskLedgerPath();
    const legacyBytes = Buffer.from(
      '{\n  "version": 1,\n  "tasks": [\n    {"taskId":"legacy","source":"cron","runtime":"cron","task":"legacy","status":"queued","createdAt":1}\n  ]\n}\n',
    );
    fs.rmSync(ledgerPath, { force: true });
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, legacyBytes);

    expect(listAllTaskRecords().map((entry) => entry.taskId)).toEqual(["legacy"]);
    expect(fs.readFileSync(legacyPath)).toEqual(legacyBytes);
    expect(fs.statSync(ledgerPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(ledgerPath)).mode & 0o777).toBe(0o700);
    for (const sidecar of [`${ledgerPath}-wal`, `${ledgerPath}-shm`]) {
      if (fs.existsSync(sidecar)) {
        expect(fs.statSync(sidecar).mode & 0o777).toBe(0o600);
      }
    }
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      expect(
        (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      ).toBe("wal");
    } finally {
      db.close();
    }

    await writeFile(legacyPath, '{"version":1,"tasks":[]}\n');
    expect(listAllTaskRecords().map((entry) => entry.taskId)).toEqual(["legacy"]);
  });

  it("leaves malformed legacy bytes and no final database on import failure", async () => {
    const legacyPath = resolveTaskRegistryPath();
    const ledgerPath = resolveTaskLedgerPath();
    fs.rmSync(ledgerPath, { force: true });
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const malformed = Buffer.from('{"tasks":');
    await writeFile(legacyPath, malformed);

    expect(() => listAllTaskRecords()).toThrow("legacy import failed");
    expect(fs.existsSync(ledgerPath)).toBe(false);
    expect(fs.existsSync(`${ledgerPath}.init-lock`)).toBe(false);
    expect(temporaryLedgerPaths(ledgerPath)).toEqual([]);
    expect(fs.readFileSync(legacyPath)).toEqual(malformed);
  });

  it("recovers a dead initializer lock and its temporary family before importing once", async () => {
    const legacyPath = resolveTaskRegistryPath();
    const ledgerPath = resolveTaskLedgerPath();
    const directory = path.dirname(ledgerPath);
    const legacyBytes = Buffer.from(
      '{"version":1,"tasks":[{"taskId":"recovered","source":"cron","runtime":"cron","task":"recovered","status":"queued","createdAt":1}]}\n',
    );
    fs.mkdirSync(directory, { recursive: true });
    await writeFile(legacyPath, legacyBytes);
    const tempPath = path.join(directory, `.${path.basename(ledgerPath)}.dead.tmp`);
    fs.writeFileSync(tempPath, "stale database");
    fs.writeFileSync(`${tempPath}-wal`, "stale wal");
    fs.writeFileSync(`${tempPath}-shm`, "stale shm");
    const lockPath = `${ledgerPath}.init-lock`;
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ pid: 999_999_999 }));

    expect(listAllTaskRecords().map((entry) => entry.taskId)).toEqual(["recovered"]);
    expect(fs.readFileSync(legacyPath)).toEqual(legacyBytes);
    expect(fs.existsSync(ledgerPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(temporaryLedgerPaths(ledgerPath)).toEqual([]);
    await writeFile(legacyPath, '{"version":1,"tasks":[]}\n');
    expect(listAllTaskRecords().map((entry) => entry.taskId)).toEqual(["recovered"]);
  });

  it("fails closed before mutation for a newer schema", () => {
    const ledgerPath = resolveTaskLedgerPath();
    createTaskRecord({
      source: "cron",
      runtime: "cron",
      task: "creates ledger",
      status: "queued",
    });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(ledgerPath);
    try {
      db.exec("UPDATE task_ledger_meta SET value = '4' WHERE key = 'schema_version'");
      db.exec("PRAGMA user_version=4");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    const before = fs.readFileSync(ledgerPath);

    expect(() => openTaskLedgerStore(ledgerPath)).toThrow("newer than supported");
    expect(fs.readFileSync(ledgerPath)).toEqual(before);
  });

  it("fails closed before mutation when a v3 definitions table is missing", () => {
    const ledgerPath = resolveTaskLedgerPath();
    createTaskRecord({
      source: "cron",
      runtime: "cron",
      task: "creates ledger",
      status: "queued",
    });
    resetTaskRegistryForTests({ persist: false });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(ledgerPath);
    try {
      db.exec("DROP INDEX task_ledger_definitions_collection_scope_updated_idx");
      db.exec("DROP INDEX task_ledger_definitions_collection_updated_idx");
      db.exec("DROP TABLE task_ledger_definitions");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    const before = fs.readFileSync(ledgerPath);

    expect(() => openTaskLedgerStore(ledgerPath)).toThrow("definitions table is missing");
    expect(fs.readFileSync(ledgerPath)).toEqual(before);
  });

  it("fails closed before mutation when a v3 cron queue table is missing", () => {
    const ledgerPath = resolveTaskLedgerPath();
    createTaskRecord({
      source: "cron",
      runtime: "cron",
      task: "creates ledger",
      status: "queued",
    });
    resetTaskRegistryForTests({ persist: false });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(ledgerPath);
    try {
      db.exec("DROP INDEX task_ledger_cron_queue_status_recency_idx");
      db.exec("DROP INDEX task_ledger_cron_queue_job_recency_idx");
      db.exec("DROP TABLE task_ledger_cron_queue");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    const before = fs.readFileSync(ledgerPath);

    expect(() => openTaskLedgerStore(ledgerPath)).toThrow("cron queue table is missing");
    expect(fs.readFileSync(ledgerPath)).toEqual(before);
  });

  it("prevents lost records across independently opened handles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-task-ledger-handles-"));
    const databasePath = path.join(root, "tasks", "task-ledger.sqlite");
    const legacyPath = path.join(root, "tasks", "tasks.json");
    try {
      initializeTaskLedger({ databasePath, legacyPath, sanitizeLegacy: () => [] });
      const first = openTaskLedgerStore(databasePath);
      const second = openTaskLedgerStore(databasePath);
      try {
        first.upsert(task("one"), (_existing, incoming) => incoming);
        second.upsert(task("two"), (_existing, incoming) => incoming);
        expect(
          first
            .list()
            .map((entry) => entry.taskId)
            .toSorted(),
        ).toEqual(["one", "two"]);
      } finally {
        first.close();
        second.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes cron queue writes across independently opened handles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-task-ledger-queue-handles-"));
    const databasePath = path.join(root, "tasks", "task-ledger.sqlite");
    const legacyPath = path.join(root, "tasks", "tasks.json");
    try {
      initializeTaskLedger({ databasePath, legacyPath, sanitizeLegacy: () => [] });
      const first = openTaskLedgerStore(databasePath);
      const second = openTaskLedgerStore(databasePath);
      try {
        first.ensureCronTaskRunQueueImported(() => []);
        first.updateCronTaskRunQueue((runs) => {
          runs.push({
            runId: "queue-one",
            jobId: "job-one",
            status: "queued",
            createdAtMs: 1,
            updatedAtMs: 1,
          });
        });
        second.updateCronTaskRunQueue((runs) => {
          runs.push({
            runId: "queue-two",
            jobId: "job-two",
            status: "queued",
            createdAtMs: 2,
            updatedAtMs: 2,
          });
        });
        expect(first.listCronTaskRuns().map((run) => run.runId)).toEqual([
          "queue-one",
          "queue-two",
        ]);
      } finally {
        first.close();
        second.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not update unchanged queue rows during a different run mutation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-task-ledger-queue-delta-"));
    const databasePath = path.join(root, "tasks", "task-ledger.sqlite");
    const legacyPath = path.join(root, "tasks", "tasks.json");
    try {
      initializeTaskLedger({ databasePath, legacyPath, sanitizeLegacy: () => [] });
      const store = openTaskLedgerStore(databasePath);
      try {
        store.ensureCronTaskRunQueueImported(() => []);
        store.updateCronTaskRunQueue((runs) => {
          runs.push(
            {
              runId: "unchanged-first",
              jobId: "job-first",
              status: "queued",
              createdAtMs: 1,
              updatedAtMs: 1,
            },
            {
              runId: "changed-second",
              jobId: "job-second",
              status: "queued",
              createdAtMs: 2,
              updatedAtMs: 2,
            },
          );
        });
        const { DatabaseSync } = requireNodeSqlite();
        const db = new DatabaseSync(databasePath);
        try {
          db.exec(`
            CREATE TRIGGER reject_unchanged_first_update
            BEFORE UPDATE ON task_ledger_cron_queue
            WHEN OLD.run_id = 'unchanged-first'
            BEGIN
              SELECT RAISE(ABORT, 'unchanged first row was updated');
            END;
          `);
        } finally {
          db.close();
        }
        store.updateCronTaskRunQueue((runs) => {
          const second = runs.find((run) => run.runId === "changed-second");
          if (second) {
            second.updatedAtMs = 3;
          }
        });
        expect(store.listCronTaskRuns()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ runId: "unchanged-first", updatedAtMs: 1 }),
            expect.objectContaining({ runId: "changed-second", updatedAtMs: 3 }),
          ]),
        );
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("upgrades v2 to v3 without changing task or definition JSON columns", () => {
    const ledgerPath = resolveTaskLedgerPath();
    createTaskRecord({
      taskId: "v2-task",
      source: "cron",
      runtime: "cron",
      task: "preserved task",
      status: "queued",
    });
    resetTaskRegistryForTests({ persist: false });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(ledgerPath);
    let taskRows: { task_json: string }[];
    let definitionRows: { record_json: string }[];
    try {
      db.exec(
        "INSERT INTO task_ledger_definitions (collection_kind, scope_key, record_id, updated_at, record_json) VALUES ('task_flow', 'scope', 'record', 1, '{\"preserved\":true}')",
      );
      taskRows = db.prepare("SELECT task_json FROM task_ledger_tasks ORDER BY task_id").all() as {
        task_json: string;
      }[];
      definitionRows = db
        .prepare("SELECT record_json FROM task_ledger_definitions ORDER BY record_id")
        .all() as { record_json: string }[];
      db.exec("DROP INDEX task_ledger_cron_queue_status_recency_idx");
      db.exec("DROP INDEX task_ledger_cron_queue_job_recency_idx");
      db.exec("DROP TABLE task_ledger_cron_queue");
      db.exec("UPDATE task_ledger_meta SET value = '2' WHERE key = 'schema_version'");
      db.exec("PRAGMA user_version=2");
    } finally {
      db.close();
    }

    openTaskLedgerStore(ledgerPath).close();
    const verified = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      expect(
        verified.prepare("SELECT task_json FROM task_ledger_tasks ORDER BY task_id").all(),
      ).toEqual(taskRows!);
      expect(
        verified
          .prepare("SELECT record_json FROM task_ledger_definitions ORDER BY record_id")
          .all(),
      ).toEqual(definitionRows!);
      expect(
        verified.prepare("SELECT value FROM task_ledger_meta WHERE key = 'schema_version'").get(),
      ).toEqual({ value: "3" });
    } finally {
      verified.close();
    }
  });

  it("rejects a conflicting v2 queue table without relabeling or changing JSON rows", () => {
    const ledgerPath = resolveTaskLedgerPath();
    createTaskRecord({
      taskId: "v2-conflict-task",
      source: "cron",
      runtime: "cron",
      task: "preserved task",
      status: "queued",
    });
    resetTaskRegistryForTests({ persist: false });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(ledgerPath);
    let taskRows: { task_json: string }[];
    let definitionRows: { record_json: string }[];
    try {
      db.exec(
        "INSERT INTO task_ledger_definitions (collection_kind, scope_key, record_id, updated_at, record_json) VALUES ('task_flow', 'scope', 'record', 1, '{\"preserved\":true}')",
      );
      taskRows = db.prepare("SELECT task_json FROM task_ledger_tasks ORDER BY task_id").all() as {
        task_json: string;
      }[];
      definitionRows = db
        .prepare("SELECT record_json FROM task_ledger_definitions ORDER BY record_id")
        .all() as { record_json: string }[];
      db.exec("DROP TABLE task_ledger_cron_queue");
      db.exec("CREATE TABLE task_ledger_cron_queue (run_id TEXT PRIMARY KEY NOT NULL)");
      db.exec("UPDATE task_ledger_meta SET value = '2' WHERE key = 'schema_version'");
      db.exec("PRAGMA user_version=2");
    } finally {
      db.close();
    }

    expect(() => openTaskLedgerStore(ledgerPath)).toThrow("already exists");
    const verified = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      expect(
        verified.prepare("SELECT task_json FROM task_ledger_tasks ORDER BY task_id").all(),
      ).toEqual(taskRows!);
      expect(
        verified
          .prepare("SELECT record_json FROM task_ledger_definitions ORDER BY record_id")
          .all(),
      ).toEqual(definitionRows!);
      expect(
        verified.prepare("SELECT value FROM task_ledger_meta WHERE key = 'schema_version'").get(),
      ).toEqual({ value: "2" });
      expect(
        (verified.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(2);
    } finally {
      verified.close();
    }
  });

  it("upgrades v1 through v3 transactionally without changing existing task rows", () => {
    const ledgerPath = resolveTaskLedgerPath();
    createTaskRecord({
      taskId: "v1-task",
      source: "cron",
      runtime: "cron",
      task: "preserved",
      status: "queued",
    });
    resetTaskRegistryForTests({ persist: false });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(ledgerPath);
    let before: { task_json: string }[];
    try {
      before = db.prepare("SELECT task_json FROM task_ledger_tasks ORDER BY task_id").all() as {
        task_json: string;
      }[];
      db.exec("DROP INDEX task_ledger_definitions_collection_scope_updated_idx");
      db.exec("DROP INDEX task_ledger_definitions_collection_updated_idx");
      db.exec("DROP TABLE task_ledger_definitions");
      db.exec("DROP TABLE task_ledger_cron_queue");
      db.exec("UPDATE task_ledger_meta SET value = '1' WHERE key = 'schema_version'");
      db.exec("PRAGMA user_version=1");
    } finally {
      db.close();
    }

    const upgraded = openTaskLedgerStore(ledgerPath);
    try {
      expect(upgraded.list()).toEqual([expect.objectContaining({ taskId: "v1-task" })]);
    } finally {
      upgraded.close();
    }
    const verified = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      expect(
        verified.prepare("SELECT task_json FROM task_ledger_tasks ORDER BY task_id").all(),
      ).toEqual(before!);
      expect(
        verified.prepare("SELECT value FROM task_ledger_meta WHERE key = 'schema_version'").get(),
      ).toEqual({ value: "3" });
      expect(
        verified
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_ledger_cron_queue'",
          )
          .get(),
      ).toEqual({ name: "task_ledger_cron_queue" });
    } finally {
      verified.close();
    }
  });

  it("keeps taskId and runId idempotency through the registry", () => {
    const first = createTaskRecord({
      source: "cron",
      runtime: "cron",
      task: "first",
      status: "queued",
      runId: "same-run",
    });
    const second = createTaskRecord({
      source: "cron",
      runtime: "cron",
      task: "updated",
      status: "running",
      runId: "same-run",
    });
    expect(second.taskId).toBe(first.taskId);
    expect(listAllTaskRecords()).toHaveLength(1);
    expect(listAllTaskRecords()[0]?.task).toBe("updated");
  });

  it("retargets a matched runId and patch identity without retaining the old row", () => {
    createTaskRecord({
      taskId: "original-task",
      source: "cron",
      runtime: "cron",
      task: "original",
      status: "queued",
      runId: "shared-run",
    });
    const retargeted = createTaskRecord({
      taskId: "replacement-task",
      source: "cron",
      runtime: "cron",
      task: "replacement",
      status: "running",
      runId: "shared-run",
    });
    expect(retargeted.taskId).toBe("replacement-task");
    expect(listAllTaskRecords().map((entry) => entry.taskId)).toEqual(["replacement-task"]);

    const patched = updateTaskRecord("replacement-task", {
      taskId: "patched-task",
      runId: "patched-run",
    });
    expect(patched?.taskId).toBe("patched-task");
    expect(listAllTaskRecords().map((entry) => entry.taskId)).toEqual(["patched-task"]);
  });
});
