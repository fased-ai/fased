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
      db.exec("UPDATE task_ledger_meta SET value = '2' WHERE key = 'schema_version'");
      db.exec("PRAGMA user_version=2");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    const before = fs.readFileSync(ledgerPath);

    expect(() => openTaskLedgerStore(ledgerPath)).toThrow("newer than supported");
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
