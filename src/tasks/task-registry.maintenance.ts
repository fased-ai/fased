import { loadCronStore } from "../cron/store.js";
import { removeCronTaskRunQueueItems } from "../cron/task-run-queue.js";
import { listCronTaskRecords } from "./cron-adapter.js";
import {
  auditTaskFlowRegistry,
  runTaskFlowRegistryMaintenance,
  upsertTaskFlowFromTask,
} from "./task-flow-registry.js";
import { listTaskRecords, updateTaskRecord } from "./task-registry.js";
import type { TaskAuditFinding, TaskRecord } from "./task-registry.types.js";
import { auditTaskWorkflowDefinitions } from "./workflow-definitions.js";

const DEFAULT_STALE_RUNNING_MS = 6 * 60 * 60_000;

function isRunning(task: TaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function runningAgeMs(task: TaskRecord, now: number): number {
  return now - (task.updatedAt ?? task.startedAt ?? task.createdAt);
}

function isTerminal(task: TaskRecord): boolean {
  return !isRunning(task);
}

function deliveryAuditFinding(task: TaskRecord): TaskAuditFinding | undefined {
  if (task.deliveryStatus === "pending" && isTerminal(task)) {
    return {
      code: "missing-delivery-state",
      severity: "warn",
      message: `Task ${task.taskId} ended with pending delivery state.`,
      taskId: task.taskId,
      runId: task.runId,
      source: task.source,
    };
  }
  if (task.deliveryStatus === "delivered" && task.delivery?.error) {
    return {
      code: "delivery-state-conflict",
      severity: "warn",
      message: `Task ${task.taskId} is marked delivered but also has a delivery error.`,
      taskId: task.taskId,
      runId: task.runId,
      source: task.source,
    };
  }
  return undefined;
}

async function liveCronDefinitionIds(storePath?: string): Promise<Set<string>> {
  if (!storePath) {
    return new Set();
  }
  const store = await loadCronStore(storePath);
  return new Set(store.jobs.map((job) => job.id).filter(Boolean));
}

function cronDefinitionId(task: TaskRecord): string {
  return (task.definitionId ?? task.sourceId ?? "").trim();
}

export async function auditTaskRegistry(params?: {
  cronStorePath?: string;
  nowMs?: number;
  staleRunningMs?: number;
}): Promise<{ findings: TaskAuditFinding[] }> {
  const now = params?.nowMs ?? Date.now();
  const staleRunningMs = params?.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS;
  const persistent = listTaskRecords({ limit: 1_000 }).tasks;
  const cron = params?.cronStorePath
    ? await listCronTaskRecords({ storePath: params.cronStorePath })
    : [];
  const liveCronIds = await liveCronDefinitionIds(params?.cronStorePath);
  const tasks = [...persistent, ...cron];
  const findings: TaskAuditFinding[] = [];
  const seenRunIds = new Map<string, TaskRecord>();
  const cronRunIds = new Set(
    cron.map((task) => task.runId).filter((runId): runId is string => Boolean(runId)),
  );

  for (const task of tasks) {
    const deliveryFinding = deliveryAuditFinding(task);
    if (deliveryFinding) {
      findings.push(deliveryFinding);
    }
    if (task.source === "cron" && !cronDefinitionId(task)) {
      findings.push({
        code: "orphaned-cron-run",
        severity: "warn",
        message: `Cron task ${task.taskId} has no scheduled task id.`,
        taskId: task.taskId,
        runId: task.runId,
        source: task.source,
      });
    }
    if (
      task.source === "cron" &&
      cronDefinitionId(task) &&
      params?.cronStorePath &&
      !liveCronIds.has(cronDefinitionId(task))
    ) {
      findings.push({
        code: "orphaned-cron-run",
        severity: "warn",
        message: `Cron task ${task.taskId} references deleted scheduled task ${cronDefinitionId(
          task,
        )}.`,
        taskId: task.taskId,
        runId: task.runId,
        source: task.source,
      });
    }
    if (
      task.source === "cron" &&
      persistent.includes(task) &&
      task.runId &&
      !cronRunIds.has(task.runId)
    ) {
      findings.push({
        code: "orphaned-cron-task",
        severity: "warn",
        message: `Persistent cron task ${task.taskId} is not present in the cron run queue.`,
        taskId: task.taskId,
        runId: task.runId,
        source: task.source,
      });
    }
    if (task.runId) {
      const existing = seenRunIds.get(task.runId);
      if (existing) {
        findings.push({
          code: "duplicate-run-id",
          severity: "warn",
          message: `Task run id ${task.runId} appears in multiple task sources.`,
          taskId: task.taskId,
          runId: task.runId,
          source: task.source,
        });
      } else {
        seenRunIds.set(task.runId, task);
      }
    }
    if (isRunning(task) && runningAgeMs(task, now) > staleRunningMs) {
      findings.push({
        code: "stale-running-task",
        severity: "warn",
        message: `Task ${task.taskId} has been ${task.status} for ${Math.round(
          runningAgeMs(task, now) / 60_000,
        )} minutes.`,
        taskId: task.taskId,
        runId: task.runId,
        source: task.source,
      });
    }
  }

  const flowAudit = auditTaskFlowRegistry({ nowMs: now, staleFlowMs: staleRunningMs });
  const workflowDefinitionAudit = auditTaskWorkflowDefinitions();
  return {
    findings: [...findings, ...flowAudit.findings, ...workflowDefinitionAudit.findings],
  };
}

export async function runTaskRegistryMaintenance(params?: {
  cronStorePath?: string;
  nowMs?: number;
  staleRunningMs?: number;
  cleanupOrphanedCronRuns?: boolean;
}): Promise<{ updated: number; findings: TaskAuditFinding[] }> {
  const now = params?.nowMs ?? Date.now();
  const staleRunningMs = params?.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS;
  let updated = 0;
  for (const task of listTaskRecords({ limit: 1_000 }).tasks) {
    if (isRunning(task) && runningAgeMs(task, now) > staleRunningMs) {
      const next = updateTaskRecord(task.taskId, {
        status: "lost",
        endedAt: now,
        terminalSummary: "Marked lost by task registry maintenance.",
      });
      if (next) {
        upsertTaskFlowFromTask(next);
        updated += 1;
      }
    }
  }
  const flowMaintenance = runTaskFlowRegistryMaintenance({
    nowMs: now,
    staleFlowMs: staleRunningMs,
  });
  updated += flowMaintenance.updated;
  if (params?.cleanupOrphanedCronRuns && params.cronStorePath) {
    const liveCronIds = await liveCronDefinitionIds(params.cronStorePath);
    const orphanedRunIds = (await listCronTaskRecords({ storePath: params.cronStorePath }))
      .filter((task) => task.source === "cron" && !liveCronIds.has(cronDefinitionId(task)))
      .map((task) => task.runId)
      .filter((runId): runId is string => Boolean(runId));
    const removed = await removeCronTaskRunQueueItems({
      storePath: params.cronStorePath,
      runIds: orphanedRunIds,
    });
    updated += removed.removed;
  }
  const audit = await auditTaskRegistry(params);
  return { updated, findings: audit.findings };
}
