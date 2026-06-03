import crypto from "node:crypto";
import type {
  CronJob,
  CronTaskRunCheckpoint,
  CronTaskRunCheckpointSummary,
  CronTaskRunCheckpointTrigger,
} from "../types.js";

const MIN_RUN_LEASE_MS = 60_000;
const RUN_LEASE_GRACE_MS = 5 * 60_000;
const FALLBACK_RUN_LEASE_MS = 2 * 60 * 60_000;

export function resolveCronJobRunLeaseMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return Math.max(MIN_RUN_LEASE_MS, Math.floor(timeoutMs) + RUN_LEASE_GRACE_MS);
  }
  return FALLBACK_RUN_LEASE_MS;
}

export function hasActiveCronJobRun(job: CronJob): boolean {
  return Boolean(job.state.activeRun) || typeof job.state.runningAtMs === "number";
}

export function reserveCronJobRunLease(
  job: CronJob,
  nowMs: number,
  opts: {
    trigger: CronTaskRunCheckpointTrigger;
    leaseMs: number;
  },
): CronTaskRunCheckpoint {
  const checkpoint: CronTaskRunCheckpoint = {
    runId: crypto.randomUUID(),
    phase: "running",
    trigger: opts.trigger,
    attempt: (job.state.totalRuns ?? 0) + 1,
    startedAtMs: nowMs,
    heartbeatAtMs: nowMs,
    leaseExpiresAtMs: nowMs + Math.max(MIN_RUN_LEASE_MS, Math.floor(opts.leaseMs)),
  };
  job.state.runningAtMs = nowMs;
  job.state.activeRun = checkpoint;
  return checkpoint;
}

export function completeCronJobRunLease(
  job: CronJob,
  completedAtMs: number,
): CronTaskRunCheckpointSummary | undefined {
  const activeRun = job.state.activeRun;
  const runningAtMs = job.state.runningAtMs;
  job.state.activeRun = undefined;
  job.state.runningAtMs = undefined;

  if (activeRun) {
    const summary: CronTaskRunCheckpointSummary = {
      ...activeRun,
      phase: "finished",
      completedAtMs,
    };
    job.state.lastRunCheckpoint = summary;
    return summary;
  }

  if (typeof runningAtMs === "number") {
    const summary: CronTaskRunCheckpointSummary = {
      phase: "finished",
      startedAtMs: runningAtMs,
      heartbeatAtMs: runningAtMs,
      completedAtMs,
    };
    job.state.lastRunCheckpoint = summary;
    return summary;
  }

  job.state.lastRunCheckpoint = undefined;
  return undefined;
}

export function discardCronJobRunLease(job: CronJob) {
  job.state.activeRun = undefined;
  job.state.runningAtMs = undefined;
}

export function isCronJobRunLeaseExpired(params: {
  job: CronJob;
  nowMs: number;
  legacyStuckMs: number;
}): boolean {
  const activeRun = params.job.state.activeRun;
  if (activeRun && activeRun.leaseExpiresAtMs <= params.nowMs) {
    return true;
  }
  const runningAtMs = params.job.state.runningAtMs;
  return typeof runningAtMs === "number" && params.nowMs - runningAtMs > params.legacyStuckMs;
}

export function recoverCronJobRunLease(
  job: CronJob,
  nowMs: number,
  reason: string,
): CronTaskRunCheckpointSummary | undefined {
  const activeRun = job.state.activeRun;
  const runningAtMs = job.state.runningAtMs;
  if (!activeRun && typeof runningAtMs !== "number") {
    return undefined;
  }

  const startedAtMs = activeRun?.startedAtMs ?? runningAtMs;
  const heartbeatAtMs = activeRun?.heartbeatAtMs ?? runningAtMs;
  const summary: CronTaskRunCheckpointSummary = {
    ...activeRun,
    phase: "recovered",
    startedAtMs,
    heartbeatAtMs,
    recoveredAtMs: nowMs,
    reason,
  };

  job.state.activeRun = undefined;
  job.state.runningAtMs = undefined;
  job.state.lastRecoveredRun = summary;
  job.state.lastRunCheckpoint = summary;
  job.state.lastRunAtMs = startedAtMs;
  job.state.lastRunStatus = "error";
  job.state.lastStatus = "error";
  job.state.lastDurationMs =
    typeof startedAtMs === "number" ? Math.max(0, nowMs - startedAtMs) : undefined;
  job.state.lastError = reason;
  job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
  job.updatedAtMs = nowMs;
  return summary;
}
