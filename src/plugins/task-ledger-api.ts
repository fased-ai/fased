import { taskRecordBelongsToAgent } from "../tasks/task-owner-access.js";
import { findTaskRecord, updateTaskRecord } from "../tasks/task-registry.js";
import type { TaskRecord, TaskStatus } from "../tasks/task-registry.types.js";

export type PluginTaskProgressStatus = Extract<TaskStatus, "queued" | "running" | "blocked">;

export type PluginTaskEvidence = Record<string, string | number | boolean | null>;

export type PluginTaskProgressInput = {
  pluginId: string;
  taskId: string;
  agentId?: string;
  status?: PluginTaskProgressStatus;
  progressSummary?: string;
  evidence?: PluginTaskEvidence;
};

export type PluginTaskApiResult = { ok: true; task: TaskRecord } | { ok: false; error: string };

function cleanString(value: string | undefined, label: string): PluginTaskApiResult | string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : { ok: false, error: `missing ${label}` };
}

function cleanEvidence(evidence: PluginTaskEvidence | undefined): PluginTaskEvidence | undefined {
  if (!evidence) {
    return undefined;
  }
  const entries = Object.entries(evidence)
    .filter(([key, value]) => key.trim() && value !== undefined)
    .map(([key, value]) => [key.trim().slice(0, 80), value] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function appendRecordList(
  metadata: Record<string, unknown> | undefined,
  key: string,
  entry: Record<string, unknown>,
): Record<string, unknown>[] {
  const current = metadata?.[key];
  const list = Array.isArray(current)
    ? current.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  return [...list.slice(-19), entry];
}

export function recordPluginTaskProgress(input: PluginTaskProgressInput): PluginTaskApiResult {
  const pluginId = cleanString(input.pluginId, "pluginId");
  if (typeof pluginId !== "string") {
    return pluginId;
  }
  const taskId = cleanString(input.taskId, "taskId");
  if (typeof taskId !== "string") {
    return taskId;
  }
  const task = findTaskRecord(taskId);
  if (!task) {
    return { ok: false, error: "task not found" };
  }
  if (!taskRecordBelongsToAgent(task, input.agentId)) {
    return { ok: false, error: "task not found for selected Agent" };
  }
  const evidence = cleanEvidence(input.evidence);
  const now = Date.now();
  const updated = updateTaskRecord(task.taskId, (current) => {
    const metadata = current.metadata ?? {};
    const progressEntry = {
      pluginId,
      at: now,
      ...(input.status ? { status: input.status } : {}),
      ...(input.progressSummary?.trim() ? { summary: input.progressSummary.trim() } : {}),
    };
    const evidenceEntry = evidence
      ? {
          pluginId,
          at: now,
          evidence,
        }
      : undefined;
    return {
      ...(input.status ? { status: input.status } : {}),
      ...(input.progressSummary?.trim()
        ? { progressSummary: input.progressSummary.trim().slice(0, 500) }
        : {}),
      metadata: {
        ...metadata,
        pluginTaskApi: {
          enabled: true,
          lastPluginId: pluginId,
          lastProgressAt: now,
          authority: "progress-and-evidence-only",
          canGrantAccess: false,
          canExecuteWorkflowScripts: false,
        },
        pluginProgress: appendRecordList(metadata, "pluginProgress", progressEntry),
        ...(evidenceEntry
          ? { pluginEvidence: appendRecordList(metadata, "pluginEvidence", evidenceEntry) }
          : {}),
      },
    };
  });
  return updated ? { ok: true, task: updated } : { ok: false, error: "task update failed" };
}
