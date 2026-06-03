import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { findTaskRecord, markTaskTerminal, updateTaskRecord } from "./task-registry.js";
import type {
  TaskNotifyPolicy,
  TaskAuditFinding,
  TaskRecord,
  TaskStatus,
} from "./task-registry.types.js";

const TASKS_DIR = "tasks";
const FLOWS_FILE = "flows.json";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_STALE_FLOW_MS = 6 * 60 * 60_000;

export type TaskFlowStatus = TaskStatus | "waiting";

export type TaskFlowSyncMode = "workflow" | "task_mirrored";

export type TaskFlowRecord = {
  flowId: string;
  syncMode: TaskFlowSyncMode;
  revision: number;
  status: TaskFlowStatus;
  goal: string;
  notifyPolicy: TaskNotifyPolicy;
  ownerKey?: string;
  agentId?: string;
  sessionKey?: string;
  definitionId?: string;
  sourceId?: string;
  taskIds: string[];
  currentTaskId?: string;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  metadata?: Record<string, unknown>;
};

export type TaskFlowListFilter = {
  agentId?: string;
  status?: TaskFlowStatus | "active" | "terminal" | "all";
  limit?: number;
};

export type TaskFlowListResult = {
  generatedAt: number;
  total: number;
  flows: TaskFlowRecord[];
  summary: {
    total: number;
    active: number;
    terminal: number;
    blocked: number;
    byStatus: Record<string, number>;
  };
};

type TaskFlowStore = {
  version: 1;
  flows: TaskFlowRecord[];
};

let loadedPath: string | null = null;
let cachedStore: TaskFlowStore | null = null;

export function resolveTaskFlowRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), TASKS_DIR, FLOWS_FILE);
}

function defaultStore(): TaskFlowStore {
  return { version: 1, flows: [] };
}

function isValidStatus(status: unknown): status is TaskFlowStatus {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting" ||
    status === "blocked" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "lost" ||
    status === "skipped"
  );
}

function isValidNotifyPolicy(policy: unknown): policy is TaskNotifyPolicy {
  return policy === "silent" || policy === "done_only" || policy === "state_changes";
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function sanitizeFlow(raw: unknown): TaskFlowRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Partial<TaskFlowRecord>;
  if (
    typeof record.flowId !== "string" ||
    !isValidStatus(record.status) ||
    typeof record.goal !== "string" ||
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number"
  ) {
    return null;
  }
  const taskIds = Array.isArray(record.taskIds)
    ? record.taskIds.filter((entry): entry is string => typeof entry === "string" && Boolean(entry))
    : [];
  return {
    flowId: record.flowId,
    syncMode: record.syncMode === "task_mirrored" ? "task_mirrored" : "workflow",
    revision: typeof record.revision === "number" ? Math.max(0, Math.floor(record.revision)) : 0,
    status: record.status,
    goal: record.goal,
    notifyPolicy: isValidNotifyPolicy(record.notifyPolicy) ? record.notifyPolicy : "done_only",
    ownerKey: normalizeOptionalString(record.ownerKey),
    agentId: normalizeOptionalString(record.agentId),
    sessionKey: normalizeOptionalString(record.sessionKey),
    definitionId: normalizeOptionalString(record.definitionId),
    sourceId: normalizeOptionalString(record.sourceId),
    taskIds,
    currentTaskId: normalizeOptionalString(record.currentTaskId),
    currentStep: normalizeOptionalString(record.currentStep),
    blockedTaskId: normalizeOptionalString(record.blockedTaskId),
    blockedSummary: normalizeOptionalString(record.blockedSummary),
    cancelRequestedAt:
      typeof record.cancelRequestedAt === "number" ? record.cancelRequestedAt : undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    endedAt: typeof record.endedAt === "number" ? record.endedAt : undefined,
    metadata: normalizeMetadata(record.metadata),
  };
}

function sanitizeStore(raw: unknown): TaskFlowStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultStore();
  }
  const record = raw as { flows?: unknown };
  const flows = Array.isArray(record.flows)
    ? record.flows
        .map((entry) => sanitizeFlow(entry))
        .filter((entry): entry is TaskFlowRecord => Boolean(entry))
    : [];
  return { version: 1, flows };
}

function loadStore(filePath = resolveTaskFlowRegistryPath()): TaskFlowStore {
  if (cachedStore && loadedPath === filePath) {
    return cachedStore;
  }
  try {
    cachedStore = sanitizeStore(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    cachedStore = defaultStore();
  }
  loadedPath = filePath;
  return cachedStore;
}

function saveStore(store: TaskFlowStore, filePath = resolveTaskFlowRegistryPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
  cachedStore = store;
  loadedPath = filePath;
}

function normalizeId(input: string): string {
  return (
    input
      .trim()
      .replace(/[^a-zA-Z0-9:_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "flow"
  );
}

function taskFlowIdForTask(task: Pick<TaskRecord, "taskId" | "runId" | "taskKind" | "source">) {
  const base = task.runId?.trim() || task.taskId;
  const kind = task.taskKind === "workflow" ? "workflow" : task.source.toLowerCase();
  return normalizeId(`flow:${kind}:${base}`);
}

function metadataString(task: TaskRecord, key: string): string | undefined {
  const value = task.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataRecord(task: TaskRecord, key: string): Record<string, unknown> | undefined {
  const value = task.metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sourceTaskMetadataFromTask(task: TaskRecord): Record<string, unknown> {
  const sourceTask = metadataRecord(task, "sourceTask");
  const sourceTaskId = metadataString(task, "sourceTaskId");
  const sourceTaskRunId = metadataString(task, "sourceTaskRunId");
  const sourceTaskSource = metadataString(task, "sourceTaskSource");
  const sourceTaskRuntime = metadataString(task, "sourceTaskRuntime");
  const sourceTaskKind = metadataString(task, "sourceTaskKind");
  return {
    ...(sourceTask ? { sourceTask } : {}),
    ...(sourceTaskId ? { sourceTaskId } : {}),
    ...(sourceTaskRunId ? { sourceTaskRunId } : {}),
    ...(sourceTaskSource ? { sourceTaskSource } : {}),
    ...(sourceTaskRuntime ? { sourceTaskRuntime } : {}),
    ...(sourceTaskKind ? { sourceTaskKind } : {}),
    ...(task.rootTaskId ? { rootTaskId: task.rootTaskId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.correlationId ? { correlationId: task.correlationId } : {}),
    ...(task.definitionId ? { taskDefinitionId: task.definitionId } : {}),
    ...(task.definitionKind ? { taskDefinitionKind: task.definitionKind } : {}),
    ...(task.workflowRunId ? { workflowRunId: task.workflowRunId } : {}),
    ...(task.workflowNodeId ? { workflowNodeId: task.workflowNodeId } : {}),
  };
}

function isTerminalStatus(status: TaskFlowStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "lost" ||
    status === "skipped" ||
    status === "blocked"
  );
}

function statusFromTask(task: TaskRecord): TaskFlowStatus {
  return task.status;
}

function currentStepFromTask(task: TaskRecord): string | undefined {
  const blocked = task.steps?.find((step) => step.status === "blocked");
  if (blocked) {
    return blocked.label ?? blocked.id;
  }
  const running = task.steps?.find((step) => step.status === "running");
  if (running) {
    return running.label ?? running.id;
  }
  const queued = task.steps?.find((step) => step.status === "queued");
  if (queued && task.status !== "succeeded") {
    return queued.label ?? queued.id;
  }
  const latest = task.steps?.findLast((step) => step.status === "succeeded");
  return latest?.label ?? latest?.id;
}

function taskAgentId(task: TaskRecord): string | undefined {
  return (
    task.agentId ??
    (task.sessionKey ? resolveAgentIdFromSessionKey(task.sessionKey) : undefined) ??
    (task.requesterSessionKey
      ? resolveAgentIdFromSessionKey(task.requesterSessionKey)
      : undefined) ??
    (task.ownerKey ? resolveAgentIdFromSessionKey(task.ownerKey) : undefined)
  );
}

function shouldCreateFlowForTask(task: TaskRecord): boolean {
  return (
    task.taskKind === "workflow" ||
    typeof task.metadata?.flowId === "string" ||
    typeof task.metadata?.workflowDefinitionId === "string"
  );
}

function taskFlowMatchesFilter(flow: TaskFlowRecord, filter: TaskFlowListFilter): boolean {
  if (filter.agentId && flow.agentId !== filter.agentId) {
    return false;
  }
  if (filter.status && filter.status !== "all") {
    if (filter.status === "active") {
      return flow.status === "queued" || flow.status === "running" || flow.status === "waiting";
    }
    if (filter.status === "terminal") {
      return isTerminalStatus(flow.status);
    }
    return flow.status === filter.status;
  }
  return true;
}

function buildTaskFlowListResult(flows: TaskFlowRecord[]): TaskFlowListResult {
  const byStatus: Record<string, number> = {};
  for (const flow of flows) {
    byStatus[flow.status] = (byStatus[flow.status] ?? 0) + 1;
  }
  return {
    generatedAt: Date.now(),
    total: flows.length,
    flows,
    summary: {
      total: flows.length,
      active: flows.filter(
        (flow) =>
          flow.status === "queued" || flow.status === "running" || flow.status === "waiting",
      ).length,
      terminal: flows.filter((flow) => isTerminalStatus(flow.status)).length,
      blocked: flows.filter((flow) => flow.status === "blocked").length,
      byStatus,
    },
  };
}

export function getTaskFlowById(flowId: string): TaskFlowRecord | undefined {
  const key = flowId.trim();
  if (!key) {
    return undefined;
  }
  return loadStore().flows.find((flow) => flow.flowId === key);
}

export function listTaskFlows(filter: TaskFlowListFilter = {}): TaskFlowListResult {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(filter.limit ?? DEFAULT_LIMIT)));
  const flows = loadStore()
    .flows.filter((flow) => taskFlowMatchesFilter(flow, filter))
    .toSorted((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, limit);
  return buildTaskFlowListResult(flows);
}

export function upsertTaskFlowFromTask(
  task: TaskRecord,
  opts: {
    flowId?: string;
    definitionId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): TaskFlowRecord | undefined {
  if (!shouldCreateFlowForTask(task) && !opts.flowId) {
    return undefined;
  }
  const flowId = normalizeId(
    opts.flowId ?? metadataString(task, "flowId") ?? taskFlowIdForTask(task),
  );
  const store = loadStore();
  const existingIndex = store.flows.findIndex((flow) => flow.flowId === flowId);
  const existing = existingIndex >= 0 ? store.flows[existingIndex] : undefined;
  const now = Date.now();
  const status = statusFromTask(task);
  const endedAt = isTerminalStatus(status) ? (task.endedAt ?? task.updatedAt ?? now) : undefined;
  const currentStep = currentStepFromTask(task);
  const definitionId =
    opts.definitionId ??
    task.definitionId ??
    metadataString(task, "workflowDefinitionId") ??
    metadataString(task, "definitionId") ??
    (task.sourceId && task.taskKind === "workflow" ? task.sourceId : undefined);
  const taskIds = Array.from(new Set([...(existing?.taskIds ?? []), task.taskId]));
  const next: TaskFlowRecord = {
    flowId,
    syncMode: task.taskKind === "workflow" ? "workflow" : "task_mirrored",
    revision: existing ? existing.revision + 1 : 0,
    status,
    goal: task.task,
    notifyPolicy: task.notifyPolicy,
    ownerKey: task.ownerKey,
    agentId: taskAgentId(task),
    sessionKey: task.sessionKey,
    definitionId,
    sourceId: task.sourceId,
    taskIds,
    currentTaskId: task.taskId,
    currentStep,
    blockedTaskId: status === "blocked" ? task.taskId : undefined,
    blockedSummary:
      status === "blocked"
        ? (task.terminalSummary ?? task.error ?? task.progressSummary ?? "Workflow is blocked.")
        : undefined,
    cancelRequestedAt: existing?.cancelRequestedAt,
    createdAt: existing?.createdAt ?? task.createdAt,
    updatedAt: task.updatedAt ?? now,
    endedAt,
    metadata: {
      ...existing?.metadata,
      ...opts.metadata,
      runId: task.runId,
      rootTaskId: task.rootTaskId,
      parentTaskId: task.parentTaskId,
      correlationId: task.correlationId,
      definitionId,
      definitionKind: task.definitionKind,
      workflowRunId: task.workflowRunId,
      workflowNodeId: task.workflowNodeId,
      taskKind: task.taskKind,
      source: task.source,
      runtime: task.runtime,
      stepCount: task.steps?.length ?? task.metadata?.stepCount,
      approvalGates: task.metadata?.approvalGates,
      ...sourceTaskMetadataFromTask(task),
    },
  };
  if (existingIndex >= 0) {
    store.flows[existingIndex] = next;
  } else {
    store.flows.push(next);
  }
  saveStore(store);
  return next;
}

export function cancelTaskFlow(flowId: string, reason?: string): TaskFlowRecord | undefined {
  const key = flowId.trim();
  if (!key) {
    return undefined;
  }
  const store = loadStore();
  const index = store.flows.findIndex((flow) => flow.flowId === key);
  if (index < 0) {
    return undefined;
  }
  const current = store.flows[index];
  const now = Date.now();
  for (const taskId of current.taskIds) {
    const task = findTaskRecord(taskId);
    if (task && !isTerminalStatus(task.status)) {
      const updated = markTaskTerminal(task.taskId, {
        status: "cancelled",
        summary: reason ?? "Cancelled from workflow run.",
      });
      if (updated) {
        updateTaskRecord(updated.taskId, (latest) => ({
          metadata: {
            ...latest.metadata,
            flowCancelRequestedAt: now,
            flowCancelReason: reason,
          },
        }));
      }
    }
  }
  const next: TaskFlowRecord = {
    ...current,
    revision: current.revision + 1,
    status: "cancelled",
    cancelRequestedAt: current.cancelRequestedAt ?? now,
    endedAt: now,
    updatedAt: now,
    blockedTaskId: undefined,
    blockedSummary: undefined,
    metadata: {
      ...current.metadata,
      cancelReason: reason,
    },
  };
  store.flows[index] = next;
  saveStore(store);
  return next;
}

function activeFlowForMaintenance(flow: TaskFlowRecord): boolean {
  return flow.status === "queued" || flow.status === "running" || flow.status === "waiting";
}

function flowAgeMs(flow: TaskFlowRecord, now: number): number {
  return now - (flow.updatedAt ?? flow.createdAt);
}

export function auditTaskFlowRegistry(params?: { nowMs?: number; staleFlowMs?: number }): {
  findings: TaskAuditFinding[];
} {
  const now = params?.nowMs ?? Date.now();
  const staleFlowMs = params?.staleFlowMs ?? DEFAULT_STALE_FLOW_MS;
  const findings: TaskAuditFinding[] = [];
  for (const flow of loadStore().flows) {
    if (activeFlowForMaintenance(flow) && flowAgeMs(flow, now) > staleFlowMs) {
      findings.push({
        code: "stale-workflow-run",
        severity: "warn",
        message: `Workflow run ${flow.flowId} has been ${flow.status} for ${Math.round(
          flowAgeMs(flow, now) / 60_000,
        )} minutes.`,
        taskId: flow.flowId,
      });
    }
    if (flow.status === "blocked" && flow.blockedTaskId) {
      const task = findTaskRecord(flow.blockedTaskId);
      if (!task) {
        findings.push({
          code: "workflow-blocked-task-missing",
          severity: "warn",
          message: `Workflow run ${flow.flowId} is blocked by missing task ${flow.blockedTaskId}.`,
          taskId: flow.flowId,
        });
      }
    }
  }
  return { findings };
}

export function runTaskFlowRegistryMaintenance(params?: { nowMs?: number; staleFlowMs?: number }): {
  updated: number;
  findings: TaskAuditFinding[];
} {
  const now = params?.nowMs ?? Date.now();
  const staleFlowMs = params?.staleFlowMs ?? DEFAULT_STALE_FLOW_MS;
  const store = loadStore();
  let updated = 0;
  store.flows = store.flows.map((flow) => {
    if (!activeFlowForMaintenance(flow) || flowAgeMs(flow, now) <= staleFlowMs) {
      return flow;
    }
    updated += 1;
    return {
      ...flow,
      revision: flow.revision + 1,
      status: "lost",
      endedAt: now,
      updatedAt: now,
      metadata: {
        ...flow.metadata,
        maintenanceReason: "stale workflow run marked lost",
      },
    };
  });
  if (updated > 0) {
    saveStore(store);
  }
  return { updated, findings: auditTaskFlowRegistry({ nowMs: now, staleFlowMs }).findings };
}

export function resetTaskFlowRegistryForTests(opts?: {
  flows?: TaskFlowRecord[];
  persist?: boolean;
}): void {
  const store = { version: 1 as const, flows: opts?.flows ? [...opts.flows] : [] };
  cachedStore = store;
  loadedPath = resolveTaskFlowRegistryPath();
  if (opts?.persist !== false) {
    saveStore(store);
  }
}
