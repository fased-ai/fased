import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { createTaskRecord, markTaskTerminal, updateTaskRecord } from "./task-registry.js";
import type {
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRuntime,
  TaskScopeKind,
  TaskSource,
  TaskStatus,
} from "./task-registry.types.js";

function compactRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mergeMetadata(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!current && !patch) {
    return undefined;
  }
  return compactRecord({
    ...current,
    ...patch,
  });
}

function sourceForRuntime(runtime: TaskRuntime): TaskSource {
  switch (runtime) {
    case "cron":
      return "cron";
    case "webhook":
      return "webhook";
    case "channel":
      return "channel";
    case "cli":
      return "CLI";
    case "media":
      return "media";
    case "wallet":
      return "wallet";
    case "marketplace":
      return "marketplace";
    case "mining":
      return "mining";
    case "subagent":
    case "acp":
      return "subagent";
    default:
      return "CLI";
  }
}

function normalizeTerminalStatus(status: unknown): Exclude<TaskStatus, "queued" | "running"> {
  if (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "lost" ||
    status === "skipped" ||
    status === "blocked"
  ) {
    return status;
  }
  return "failed";
}

export function createRunningTaskRun(params: {
  runtime: TaskRuntime;
  sourceId?: string;
  ownerKey?: string;
  scopeKind?: TaskScopeKind;
  channel?: string;
  requesterOrigin?: unknown;
  requesterSessionKey?: string;
  childSessionKey?: string;
  sessionKey?: string;
  agentId?: string;
  runId: string;
  rootTaskId?: string;
  parentTaskId?: string;
  correlationId?: string;
  definitionId?: string;
  definitionKind?: TaskRecord["definitionKind"];
  workflowRunId?: string;
  workflowNodeId?: string;
  label?: string;
  task: string;
  deliveryStatus?: TaskDeliveryStatus;
  notifyPolicy?: TaskNotifyPolicy;
  startedAt?: number;
  lastEventAt?: number;
  taskKind?: string;
  model?: string;
  provider?: string;
  loadedSkills?: string[];
  loadedTools?: string[];
  memoryScope?: string;
  delivery?: TaskRecord["delivery"];
  metadata?: Record<string, unknown>;
}): TaskRecord {
  const source = sourceForRuntime(params.runtime);
  const sessionKey = params.sessionKey ?? params.childSessionKey;
  const requesterSessionKey = params.requesterSessionKey ?? params.ownerKey;
  const ownerKey = params.ownerKey ?? requesterSessionKey ?? sessionKey;
  const startedAt = params.startedAt ?? Date.now();
  const metadata = mergeMetadata(params.metadata, {
    requesterOrigin: params.requesterOrigin,
    childSessionKey: params.childSessionKey,
  });
  return createTaskRecord({
    taskId: `${source}:${params.runId}`,
    runId: params.runId,
    source,
    runtime: params.runtime,
    taskKind: params.taskKind ?? (params.runtime === "acp" ? "acp-spawn" : params.runtime),
    sourceId: params.sourceId,
    rootTaskId: params.rootTaskId,
    parentTaskId: params.parentTaskId,
    correlationId: params.correlationId,
    definitionId: params.definitionId,
    definitionKind: params.definitionKind,
    workflowRunId: params.workflowRunId,
    workflowNodeId: params.workflowNodeId,
    requesterSessionKey,
    ownerKey,
    agentId: params.agentId ?? (ownerKey ? resolveAgentIdFromSessionKey(ownerKey) : undefined),
    sessionKey,
    channel: params.channel,
    task: params.label?.trim() || params.task,
    status: "running",
    deliveryStatus: params.deliveryStatus ?? "pending",
    notifyPolicy:
      params.notifyPolicy ?? (params.deliveryStatus === "not_applicable" ? "silent" : "done_only"),
    createdAt: startedAt,
    startedAt,
    updatedAt: params.lastEventAt ?? startedAt,
    progressSummary: "Running",
    scopeKind: params.scopeKind ?? (sessionKey || requesterSessionKey ? "session" : "system"),
    model: params.model,
    provider: params.provider,
    loadedSkills: params.loadedSkills,
    loadedTools: params.loadedTools,
    memoryScope: params.memoryScope,
    delivery: params.delivery,
    metadata,
  });
}

export function recordTaskRunAccountingByRunId(params: {
  runId: string;
  model?: string;
  provider?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  loadedSkills?: string[];
  loadedTools?: string[];
  memoryScope?: string;
  toolCount?: number;
  deliveryStatus?: TaskDeliveryStatus;
  delivery?: TaskRecord["delivery"];
  metadata?: Record<string, unknown>;
}): TaskRecord | undefined {
  return updateTaskRecord(params.runId, (task) => ({
    model: params.model ?? task.model,
    provider: params.provider ?? task.provider,
    loadedSkills: params.loadedSkills ?? task.loadedSkills,
    loadedTools: params.loadedTools ?? task.loadedTools,
    memoryScope: params.memoryScope ?? task.memoryScope,
    toolCount: params.toolCount ?? task.toolCount,
    deliveryStatus: params.deliveryStatus ?? task.deliveryStatus,
    delivery: params.delivery ?? task.delivery,
    usage: params.usage
      ? {
          inputTokens: params.usage.input,
          outputTokens: params.usage.output,
          cacheReadTokens: params.usage.cacheRead,
          cacheWriteTokens: params.usage.cacheWrite,
          totalTokens: params.usage.total,
        }
      : task.usage,
    metadata: mergeMetadata(task.metadata, params.metadata),
  }));
}

export function recordTaskRunProgressByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  agentId?: string;
  sourceId?: string;
  channel?: string;
  deliveryStatus?: TaskDeliveryStatus;
  delivery?: TaskRecord["delivery"];
  lastEventAt?: number;
  eventSummary?: string;
  metadata?: Record<string, unknown>;
}): TaskRecord | undefined {
  return updateTaskRecord(params.runId, (task) => ({
    runtime: params.runtime ?? task.runtime,
    sessionKey: params.sessionKey ?? task.sessionKey,
    agentId: params.agentId ?? task.agentId,
    sourceId: params.sourceId ?? task.sourceId,
    channel: params.channel ?? task.channel,
    deliveryStatus: params.deliveryStatus ?? task.deliveryStatus,
    delivery: params.delivery ?? task.delivery,
    status: task.status === "queued" ? "running" : task.status,
    progressSummary: params.eventSummary ?? task.progressSummary,
    metadata: mergeMetadata(task.metadata, params.metadata),
    updatedAt: params.lastEventAt ?? Date.now(),
  }));
}

export function completeTaskRunByRunId(params: {
  runId: string;
  summary?: string;
  deliveryStatus?: TaskDeliveryStatus;
  delivery?: TaskRecord["delivery"];
}): TaskRecord | undefined {
  return markTaskTerminal(params.runId, {
    status: "succeeded",
    summary: params.summary,
    deliveryStatus: params.deliveryStatus ?? "delivered",
    delivery: params.delivery,
  });
}

export function failTaskRunByRunId(params: {
  runId: string;
  status?: Exclude<TaskStatus, "queued" | "running">;
  summary?: string;
  error?: string;
  deliveryStatus?: TaskDeliveryStatus;
  delivery?: TaskRecord["delivery"];
}): TaskRecord | undefined {
  return markTaskTerminal(params.runId, {
    status: normalizeTerminalStatus(params.status),
    summary: params.summary,
    error: params.error,
    deliveryStatus: params.deliveryStatus ?? "not_delivered",
    delivery: params.delivery,
  });
}

export function setDetachedTaskDeliveryStatusByRunId(params: {
  runId: string;
  deliveryStatus: TaskDeliveryStatus;
  delivery?: TaskRecord["delivery"];
}): TaskRecord | undefined {
  return updateTaskRecord(params.runId, {
    deliveryStatus: params.deliveryStatus,
    ...(params.delivery ? { delivery: params.delivery } : {}),
  });
}
