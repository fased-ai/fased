import {
  readCronTaskRunQueue,
  type CronTaskRunQueueItem,
  type CronTaskRunQueueStep,
} from "../cron/task-run-queue.js";
import type { TaskRecord, TaskRegistryStep, TaskStatus } from "./task-registry.types.js";

function mapCronStatus(status: CronTaskRunQueueItem["status"]): TaskStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "ok":
      return "succeeded";
    case "error":
      return "failed";
    case "canceled":
      return "cancelled";
    case "blocked":
      return "blocked";
    case "skipped":
      return "skipped";
    case "recovered":
      return "succeeded";
    default:
      return "failed";
  }
}

function mapStepStatus(status: CronTaskRunQueueStep["status"]): TaskRegistryStep["status"] {
  switch (status) {
    case "ok":
    case "recovered":
      return "succeeded";
    case "error":
      return "failed";
    case "canceled":
      return "cancelled";
    case "queued":
    case "running":
    case "skipped":
    case "blocked":
      return status;
    default:
      return "failed";
  }
}

function splitModelRef(provider?: string, model?: string): { provider?: string; model?: string } {
  const providerValue = provider?.trim();
  const modelValue = model?.trim();
  if (providerValue || modelValue) {
    return {
      ...(providerValue ? { provider: providerValue } : {}),
      ...(modelValue ? { model: modelValue } : {}),
    };
  }
  return {};
}

function coordinationEvidenceFromUnknown(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is Record<string, unknown> => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const record = entry as Record<string, unknown>;
    return typeof record.agentId === "string" && typeof record.status === "string";
  });
}

function coordinationEvidenceString(entry: Record<string, unknown>, key: string): string {
  const value = entry[key];
  return typeof value === "string" ? value : "";
}

function coordinationEvidenceForRun(run: CronTaskRunQueueItem): Array<Record<string, unknown>> {
  const evidence = run.steps.flatMap((step) =>
    coordinationEvidenceFromUnknown(
      (step.checkpoint as { coordinationEvidence?: unknown } | undefined)?.coordinationEvidence,
    ),
  );
  const seen = new Set<string>();
  return evidence.filter((entry) => {
    const key = [
      coordinationEvidenceString(entry, "agentId"),
      coordinationEvidenceString(entry, "status"),
      coordinationEvidenceString(entry, "childSessionKey"),
      coordinationEvidenceString(entry, "runId"),
      coordinationEvidenceString(entry, "summary"),
      coordinationEvidenceString(entry, "error"),
    ].join("\u0000");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function cronRunToTaskRecord(run: CronTaskRunQueueItem): TaskRecord {
  const status = mapCronStatus(run.status);
  const deliveryStatus =
    run.result?.delivered === true
      ? "delivered"
      : run.result?.delivered === false
        ? "not_delivered"
        : "not_applicable";
  const model = splitModelRef(run.result?.provider, run.result?.model);
  const coordinationEvidence = coordinationEvidenceForRun(run);
  return {
    taskId: `cron:${run.runId}`,
    runId: run.runId,
    source: "cron",
    runtime: "cron",
    taskKind: "scheduled-task",
    sourceId: run.jobId,
    rootTaskId: `cron:${run.runId}`,
    correlationId: `cron:${run.runId}`,
    definitionId: run.jobId,
    definitionKind: "task",
    requesterSessionKey: run.sessionKey,
    ownerKey: run.sessionKey ?? (run.agentId ? `agent:${run.agentId}` : undefined),
    agentId: run.agentId,
    sessionKey: run.sessionKey,
    task: run.jobName || run.jobId,
    status,
    deliveryStatus,
    notifyPolicy: "done_only",
    createdAt: run.createdAtMs,
    startedAt: run.startedAtMs,
    endedAt: run.completedAtMs,
    updatedAt: run.updatedAtMs,
    progressSummary:
      run.status === "running"
        ? (run.steps.find((step) => step.status === "running")?.graphNodeLabel ??
          run.steps.find((step) => step.status === "running")?.id ??
          "Running")
        : undefined,
    terminalSummary: run.result?.summary,
    error: run.error ?? run.result?.error,
    scopeKind: run.sessionKey ? "session" : "agent",
    ...model,
    usage: run.result?.usage
      ? {
          inputTokens: run.result.usage.input_tokens,
          outputTokens: run.result.usage.output_tokens,
          totalTokens: run.result.usage.total_tokens,
          cacheReadTokens: run.result.usage.cache_read_tokens,
          cacheWriteTokens: run.result.usage.cache_write_tokens,
        }
      : undefined,
    steps: run.steps.map((step) => ({
      id: step.id,
      label: step.graphNodeLabel ?? step.graphNodeId,
      status: mapStepStatus(step.status),
      attempt: step.attempt,
      maxAttempts: step.maxAttempts,
      startedAt: step.startedAtMs,
      endedAt: step.completedAtMs,
      updatedAt: step.completedAtMs ?? step.startedAtMs ?? step.createdAtMs,
      error: step.error,
    })),
    metadata: {
      trigger: run.trigger,
      graphRevision: run.graphRevision,
      cancelRequestedAtMs: run.cancelRequestedAtMs,
      recoveredAtMs: run.recoveredAtMs,
      ...(coordinationEvidence.length > 0 ? { coordinationEvidence } : {}),
    },
  };
}

export async function listCronTaskRecords(params: { storePath: string }): Promise<TaskRecord[]> {
  try {
    const queue = await readCronTaskRunQueue({ storePath: params.storePath });
    return queue.runs.map(cronRunToTaskRecord);
  } catch {
    return [];
  }
}
