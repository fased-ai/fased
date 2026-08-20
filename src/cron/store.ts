import path from "node:path";
import JSON5 from "json5";
import { expandHomePrefix } from "../infra/home-dir.js";
import {
  listTaskDefinitionRecords,
  replaceTaskDefinitionCollection,
  type DefinitionCollectionAdapter,
} from "../tasks/task-definition-ledger.js";
import { CONFIG_DIR } from "../utils.js";
import type { CronStoreFile } from "./types.js";

export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");

export function resolveCronStorePath(storePath?: string) {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return DEFAULT_CRON_STORE_PATH;
}

function sanitizeCronStore(raw: unknown): CronStoreFile {
  const parsedRecord =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const jobs = Array.isArray(parsedRecord.jobs) ? (parsedRecord.jobs as never[]) : [];
  const trustedSources = Array.isArray(parsedRecord.trustedSources)
    ? (parsedRecord.trustedSources.filter(Boolean) as never[])
    : [];
  return {
    version: 1,
    jobs: jobs.filter(Boolean) as never as CronStoreFile["jobs"],
    ...(trustedSources.length > 0
      ? {
          trustedSources: trustedSources as never as NonNullable<CronStoreFile["trustedSources"]>,
        }
      : {}),
  };
}

function cronStateRoot(storePath: string): string {
  const directory = path.dirname(path.resolve(storePath));
  return path.basename(directory) === "cron" ? path.dirname(directory) : directory;
}

function cronStoreUpdatedAt(store: CronStoreFile): number {
  const timestamps = [
    ...store.jobs.map((job) => job.updatedAtMs ?? job.createdAtMs ?? 0),
    ...(store.trustedSources ?? []).map((source) => source.updatedAtMs ?? source.createdAtMs ?? 0),
  ];
  return Math.max(0, ...timestamps);
}

function cronStoreAdapter(storePath: string): DefinitionCollectionAdapter<CronStoreFile> {
  const resolved = path.resolve(storePath);
  const stateRoot = cronStateRoot(resolved);
  return {
    collection: "cron_store",
    legacyFileName: "jobs.json",
    databasePath: () => path.join(stateRoot, "tasks", "task-ledger.sqlite"),
    legacyPath: () => resolved,
    parseLegacy: (bytes) => JSON5.parse(bytes),
    malformedLegacyMessage: `Failed to parse cron store at ${resolved}`,
    sanitizeLegacy: (raw) => [sanitizeCronStore(raw)],
    identity: (record) => ({
      scopeKey: "global",
      recordId: "cron-store",
      updatedAt: cronStoreUpdatedAt(record),
    }),
  };
}

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  return (
    listTaskDefinitionRecords(cronStoreAdapter(storePath))[0]?.record ?? {
      version: 1,
      jobs: [],
    }
  );
}

export async function saveCronStore(storePath: string, store: CronStoreFile) {
  replaceTaskDefinitionCollection(cronStoreAdapter(storePath), [sanitizeCronStore(store)]);
}
