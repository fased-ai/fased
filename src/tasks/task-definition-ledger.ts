import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  initializeTaskLedger,
  openTaskLedgerStore,
  type TaskDefinitionCollection,
  type TaskDefinitionRecord,
  type TaskLedgerStore,
} from "./task-ledger-store.js";
import {
  resolveTaskLedgerPath,
  resolveTaskRegistryPath,
  sanitizeTaskRegistryStore,
} from "./task-registry.js";

const TASKS_DIR = "tasks";

export type DefinitionCollectionAdapter<T> = {
  collection: TaskDefinitionCollection;
  legacyFileName: string;
  sanitizeLegacy: (raw: unknown) => T[];
  identity: (record: T) => { scopeKey: string; recordId: string; updatedAt: number };
};

let loadedLedgerPath: string | null = null;
let cachedLedger: TaskLedgerStore | null = null;

function closeCachedLedger(): void {
  try {
    cachedLedger?.close();
  } finally {
    cachedLedger = null;
    loadedLedgerPath = null;
  }
}

function checkpointAndCloseCachedLedgerForLifecycle(): void {
  try {
    cachedLedger?.checkpointAndCloseForLifecycle();
  } finally {
    cachedLedger = null;
    loadedLedgerPath = null;
  }
}

/** Close the definition handle after its WAL has been checkpointed. */
export function closeTaskDefinitionLedgerForLifecycle(): void {
  checkpointAndCloseCachedLedgerForLifecycle();
}

function ledger(): TaskLedgerStore {
  const databasePath = resolveTaskLedgerPath();
  if (cachedLedger && loadedLedgerPath === databasePath) {
    return cachedLedger;
  }
  closeCachedLedger();
  initializeTaskLedger({
    databasePath,
    legacyPath: resolveTaskRegistryPath(),
    sanitizeLegacy: (raw) => sanitizeTaskRegistryStore(raw).tasks,
  });
  cachedLedger = openTaskLedgerStore(databasePath);
  loadedLedgerPath = databasePath;
  return cachedLedger;
}

function legacyPath(adapter: DefinitionCollectionAdapter<unknown>): string {
  return path.join(resolveStateDir(), TASKS_DIR, adapter.legacyFileName);
}

function importedRecords<T>(
  adapter: DefinitionCollectionAdapter<T>,
  records: T[],
): TaskDefinitionRecord<T>[] {
  return records.map((record) => {
    const identity = adapter.identity(record);
    return { collection: adapter.collection, ...identity, record };
  });
}

/**
 * Imports one legacy collection exactly once. The marker is checked before any
 * legacy-file read so post-import operational calls never dual-read JSON.
 */
export function ensureTaskDefinitionCollection<T>(adapter: DefinitionCollectionAdapter<T>): void {
  const store = ledger();
  if (store.isDefinitionCollectionImported(adapter.collection)) {
    return;
  }
  const filePath = legacyPath(adapter as DefinitionCollectionAdapter<unknown>);
  let records: T[] = [];
  try {
    const bytes = fs.readFileSync(filePath, "utf8");
    records = adapter.sanitizeLegacy(JSON.parse(bytes));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      records = [];
    } else {
      throw new Error(
        `Task definition legacy import failed: ${adapter.legacyFileName} is malformed`,
        {
          cause: err,
        },
      );
    }
  }
  store.importDefinitionCollection(adapter.collection, importedRecords(adapter, records));
}

export function listTaskDefinitionRecords<T>(
  adapter: DefinitionCollectionAdapter<T>,
): TaskDefinitionRecord<T>[] {
  ensureTaskDefinitionCollection(adapter);
  return ledger().listDefinitionRecords<T>(adapter.collection);
}

export function updateTaskDefinitionRecord<T>(
  adapter: DefinitionCollectionAdapter<T>,
  scopeKey: string,
  recordId: string,
  update: (current: T | undefined) => T | undefined,
): T | undefined {
  ensureTaskDefinitionCollection(adapter);
  return ledger().updateDefinitionRecord(
    adapter.collection,
    scopeKey,
    recordId,
    update,
    (record) => adapter.identity(record).updatedAt,
  );
}

export function replaceTaskDefinitionCollection<T>(
  adapter: DefinitionCollectionAdapter<T>,
  records: T[],
): void {
  ensureTaskDefinitionCollection(adapter);
  ledger().replaceDefinitionCollection(adapter.collection, importedRecords(adapter, records));
}

/** Test reset hooks close a path-bound handle so a changed FASED_STATE_DIR cannot leak state. */
export function resetTaskDefinitionLedgerForTests(): void {
  closeCachedLedger();
}
