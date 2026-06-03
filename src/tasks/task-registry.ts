import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type {
  TaskDefinitionKind,
  TaskDeliverySummary,
  TaskDeliveryStatus,
  TaskListResult,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRegistryStore,
  TaskSource,
  TaskStatus,
} from "./task-registry.types.js";

const TASKS_DIR = "tasks";
const TASKS_FILE = "tasks.json";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;

let loadedPath: string | null = null;
let cachedStore: TaskRegistryStore | null = null;

export type TaskRecordInput = Omit<TaskRecord, "taskId" | "createdAt" | "updatedAt"> & {
  taskId?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type TaskListFilter = {
  agentId?: string;
  sessionKey?: string;
  source?: TaskSource | "all";
  status?: TaskStatus | "active" | "terminal" | "all";
  limit?: number;
  offset?: number;
  includeAudit?: boolean;
};

export function resolveTaskRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), TASKS_DIR, TASKS_FILE);
}

function defaultStore(): TaskRegistryStore {
  return { version: 1, tasks: [] };
}

function sanitizeStore(raw: unknown): TaskRegistryStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultStore();
  }
  const record = raw as { tasks?: unknown };
  const tasks = Array.isArray(record.tasks)
    ? record.tasks
        .filter((entry): entry is TaskRecord => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return false;
          }
          const task = entry as Partial<TaskRecord>;
          return (
            typeof task.taskId === "string" &&
            typeof task.task === "string" &&
            typeof task.status === "string" &&
            typeof task.createdAt === "number"
          );
        })
        .map((task) => normalizeRecord(task))
    : [];
  return { version: 1, tasks };
}

function loadStore(filePath = resolveTaskRegistryPath()): TaskRegistryStore {
  if (cachedStore && loadedPath === filePath) {
    return cachedStore;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    cachedStore = sanitizeStore(JSON.parse(raw));
  } catch {
    cachedStore = defaultStore();
  }
  loadedPath = filePath;
  return cachedStore;
}

function saveStore(store: TaskRegistryStore, filePath = resolveTaskRegistryPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
  cachedStore = store;
  loadedPath = filePath;
}

function normalizeTaskId(input: string): string {
  return (
    input
      .trim()
      .replace(/[^a-zA-Z0-9:_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "task"
  );
}

function buildTaskId(input: TaskRecordInput, now: number): string {
  const existing = input.taskId?.trim();
  if (existing) {
    return normalizeTaskId(existing);
  }
  if (input.runId?.trim()) {
    return normalizeTaskId(`${input.source}:${input.runId.trim()}`);
  }
  const base = input.sourceId?.trim() || input.taskKind?.trim() || input.runtime;
  return normalizeTaskId(`${input.source}:${base}:${now}`);
}

function resolveOwnerKey(input: TaskRecordInput): string | undefined {
  return (
    input.ownerKey?.trim() ||
    input.requesterSessionKey?.trim() ||
    input.sessionKey?.trim() ||
    (input.agentId?.trim() ? `agent:${input.agentId.trim()}` : undefined)
  );
}

function readMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeDefinitionKind(value: unknown): TaskDefinitionKind | undefined {
  return value === "task" || value === "trigger" || value === "workflow" || value === "graph"
    ? value
    : undefined;
}

function inferDefinitionKind(input: TaskRecordInput): TaskDefinitionKind | undefined {
  const fromMetadata = normalizeDefinitionKind(input.metadata?.definitionKind);
  if (fromMetadata) {
    return fromMetadata;
  }
  if (input.taskKind === "workflow") {
    return input.metadata?.workflowMode === "graph" || input.metadata?.workflowGraphVersion === 2
      ? "graph"
      : "workflow";
  }
  if (input.source === "webhook") {
    return "trigger";
  }
  if (input.source === "cron" || input.taskKind === "scheduled-task") {
    return "task";
  }
  return undefined;
}

function inferDefinitionId(input: TaskRecordInput): string | undefined {
  return (
    input.definitionId?.trim() ||
    readMetadataString(input.metadata, "workflowDefinitionId") ||
    readMetadataString(input.metadata, "definitionId") ||
    ((input.source === "cron" || input.source === "webhook") && input.sourceId?.trim()
      ? input.sourceId.trim()
      : undefined)
  );
}

function normalizeRecord(input: TaskRecordInput): TaskRecord {
  const now = Date.now();
  const taskId = buildTaskId(input, input.createdAt ?? now);
  const ownerKey = resolveOwnerKey(input);
  const parentTaskId =
    input.parentTaskId?.trim() ??
    readMetadataString(input.metadata, "parentTaskId") ??
    readMetadataString(input.metadata, "sourceTaskId") ??
    readMetadataString(input.metadata, "relatedTaskId");
  const rootTaskId =
    input.rootTaskId?.trim() ??
    readMetadataString(input.metadata, "rootTaskId") ??
    parentTaskId ??
    taskId;
  const correlationId =
    input.correlationId?.trim() ??
    readMetadataString(input.metadata, "correlationId") ??
    rootTaskId;
  const definitionId = inferDefinitionId(input);
  const definitionKind = input.definitionKind ?? inferDefinitionKind(input);
  const workflowRunId =
    input.workflowRunId?.trim() ??
    readMetadataString(input.metadata, "workflowRunId") ??
    (input.taskKind === "workflow" ? (input.runId?.trim() ?? taskId) : undefined);
  const workflowNodeId =
    input.workflowNodeId?.trim() ??
    readMetadataString(input.metadata, "workflowNodeId") ??
    readMetadataString(input.metadata, "blockedNodeId");
  return {
    ...input,
    taskId,
    ownerKey,
    rootTaskId,
    ...(parentTaskId ? { parentTaskId } : {}),
    correlationId,
    ...(definitionId ? { definitionId } : {}),
    ...(definitionKind ? { definitionKind } : {}),
    ...(workflowRunId ? { workflowRunId } : {}),
    ...(workflowNodeId ? { workflowNodeId } : {}),
    scopeKind:
      input.scopeKind ?? (input.sessionKey || input.requesterSessionKey ? "session" : "agent"),
    deliveryStatus: input.deliveryStatus ?? "not_applicable",
    notifyPolicy: input.notifyPolicy ?? "done_only",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

function isTerminalStatus(status: TaskStatus): boolean {
  return !["queued", "running"].includes(status);
}

function taskMatchesFilter(task: TaskRecord, filter: TaskListFilter): boolean {
  if (filter.agentId && task.agentId && task.agentId !== filter.agentId) {
    return false;
  }
  if (filter.agentId && !task.agentId) {
    const keys = [task.requesterSessionKey, task.sessionKey, task.ownerKey].filter(Boolean);
    if (!keys.some((key) => resolveAgentIdFromSessionKey(String(key)) === filter.agentId)) {
      return false;
    }
  }
  if (filter.sessionKey) {
    const sessionKey = filter.sessionKey.trim();
    if (
      task.requesterSessionKey !== sessionKey &&
      task.sessionKey !== sessionKey &&
      task.ownerKey !== sessionKey
    ) {
      return false;
    }
  }
  if (filter.source && filter.source !== "all" && task.source !== filter.source) {
    return false;
  }
  if (filter.status && filter.status !== "all") {
    if (filter.status === "active") {
      return task.status === "queued" || task.status === "running";
    }
    if (filter.status === "terminal") {
      return isTerminalStatus(task.status);
    }
    return task.status === filter.status;
  }
  return true;
}

export function createTaskRecord(input: TaskRecordInput): TaskRecord {
  const record = normalizeRecord(input);
  const store = loadStore();
  const existingIndex = store.tasks.findIndex(
    (task) => task.taskId === record.taskId || (record.runId && task.runId === record.runId),
  );
  if (existingIndex >= 0) {
    store.tasks[existingIndex] = {
      ...store.tasks[existingIndex],
      ...record,
      updatedAt: Date.now(),
    };
  } else {
    store.tasks.push(record);
  }
  saveStore(store);
  return existingIndex >= 0 ? store.tasks[existingIndex] : record;
}

export function upsertTaskRecord(record: TaskRecord): TaskRecord {
  return createTaskRecord(record);
}

export function findTaskRecord(taskIdOrRunId: string): TaskRecord | undefined {
  const key = taskIdOrRunId.trim();
  if (!key) {
    return undefined;
  }
  const store = loadStore();
  return store.tasks.find((task) => task.taskId === key || task.runId === key);
}

export function updateTaskRecord(
  taskIdOrRunId: string,
  patch:
    | Partial<TaskRecord>
    | ((task: TaskRecord) => Partial<TaskRecord> | TaskRecord | undefined | null),
): TaskRecord | undefined {
  const key = taskIdOrRunId.trim();
  if (!key) {
    return undefined;
  }
  const store = loadStore();
  const index = store.tasks.findIndex((task) => task.taskId === key || task.runId === key);
  if (index < 0) {
    return undefined;
  }
  const current = store.tasks[index];
  const nextPatch = typeof patch === "function" ? patch(current) : patch;
  if (!nextPatch) {
    return current;
  }
  const next = normalizeRecord({
    ...current,
    ...nextPatch,
    updatedAt: Date.now(),
  });
  store.tasks[index] = next;
  saveStore(store);
  return next;
}

export function markTaskTerminal(
  taskIdOrRunId: string,
  params: {
    status: Exclude<TaskStatus, "queued" | "running">;
    summary?: string;
    error?: string;
    deliveryStatus?: TaskDeliveryStatus;
    delivery?: TaskDeliverySummary;
  },
): TaskRecord | undefined {
  return updateTaskRecord(taskIdOrRunId, (task) => ({
    status: params.status,
    endedAt: Date.now(),
    terminalSummary: params.summary ?? task.terminalSummary,
    error: params.error ?? task.error,
    deliveryStatus: params.deliveryStatus ?? task.deliveryStatus,
    delivery: params.delivery ?? task.delivery,
  }));
}

export function updateTaskNotifyPolicy(
  taskIdOrRunId: string,
  notifyPolicy: TaskNotifyPolicy,
): TaskRecord | undefined {
  return updateTaskRecord(taskIdOrRunId, { notifyPolicy });
}

export function listTaskRecords(filter: TaskListFilter = {}): TaskListResult {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(filter.limit ?? DEFAULT_LIMIT)));
  const rawOffset = Math.floor(filter.offset ?? 0);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;
  const filteredTasks = loadStore()
    .tasks.filter((task) => taskMatchesFilter(task, filter))
    .toSorted((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  const tasks = filteredTasks.slice(offset, offset + limit);
  const result = buildTaskListResult(tasks);
  const fullSummary = buildTaskListResult(filteredTasks).summary;
  result.total = filteredTasks.length;
  result.summary = fullSummary;
  result.offset = offset;
  result.limit = limit;
  result.nextOffset = offset + tasks.length < filteredTasks.length ? offset + tasks.length : null;
  result.hasMore = result.nextOffset !== null;
  return result;
}

export function buildTaskListResult(tasks: TaskRecord[], generatedAt = Date.now()): TaskListResult {
  const bySource: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const task of tasks) {
    bySource[task.source] = (bySource[task.source] ?? 0) + 1;
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  }
  return {
    generatedAt,
    total: tasks.length,
    tasks,
    summary: {
      total: tasks.length,
      queued: tasks.filter((task) => task.status === "queued").length,
      running: tasks.filter((task) => task.status === "running").length,
      terminal: tasks.filter((task) => isTerminalStatus(task.status)).length,
      failed: tasks.filter((task) => task.status === "failed" || task.status === "timed_out")
        .length,
      lost: tasks.filter((task) => task.status === "lost").length,
      bySource,
      byStatus,
    },
  };
}

export function listAllTaskRecords(): TaskRecord[] {
  return loadStore().tasks.toSorted(
    (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
  );
}

export function resetTaskRegistryForTests(opts?: { tasks?: TaskRecord[]; persist?: boolean }) {
  const store = { version: 1 as const, tasks: opts?.tasks ? [...opts.tasks] : [] };
  cachedStore = store;
  loadedPath = resolveTaskRegistryPath();
  if (opts?.persist !== false) {
    saveStore(store);
  }
}
