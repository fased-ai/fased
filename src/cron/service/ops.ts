import { detectCronTaskStaticAccessBlock } from "../access-block.js";
import {
  appendCronRunLog,
  resolveCronRunLogPath,
  resolveCronRunLogPruneOptions,
} from "../run-log.js";
import { planTaskExecutionPolicy, stopSourcePathInPolicy } from "../task-planner.js";
import {
  cancelCronTaskRunQueueItem,
  clearExpiredCronTaskRunQueueLease,
  enqueueCronTaskRunQueueItem,
  readCronTaskRunQueue,
  recoverCronTaskRunQueueItem,
  recoverExpiredCronTaskRunQueueLeases,
  retryCronTaskRunQueueItem,
  summarizeCronTaskRunQueue,
} from "../task-run-queue.js";
import {
  createTrustedSourceForJob,
  listTrustedSources,
  mergeTrustedSources,
  removeTrustedSource,
  setTrustedSourceActive,
  upsertTrustedSource,
} from "../trusted-sources.js";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronTaskSourceListFilters,
  CronTaskSourceListResult,
  CronTaskSourceRemoveResult,
  CronTaskSourceUpdateResult,
  CronTaskRepairRecoveryAction,
  CronTaskRepairRecoveryResult,
} from "../types.js";
import {
  applyJobPatch,
  computeJobNextRunAtMs,
  createJob,
  findJobOrThrow,
  hasScheduledNextRunAtMs,
  isJobDue,
  nextWakeAtMs,
  recomputeNextRuns,
  recomputeNextRunsForMaintenance,
  reserveCronJobRunBudget,
} from "./jobs.js";
import { locked } from "./locked.js";
import {
  discardCronJobRunLease,
  hasActiveCronJobRun,
  recoverCronJobRunLease,
  reserveCronJobRunLease,
  resolveCronJobRunLeaseMs,
} from "./run-lease.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { ensureLoaded, persist, warnIfDisabled } from "./store.js";
import { resolveCronJobTimeoutMs } from "./timeout-policy.js";
import {
  applyJobResult,
  armTimer,
  abortActiveCronTaskRun,
  emit,
  processAndApplyQueuedCronTaskRuns,
  processQueuedCronTaskRuns,
  runMissedJobs,
  stopTimer,
  wake,
  withEvaluatorPolicy,
} from "./timer.js";

function applyNeedsAccessPreflight(state: CronServiceState, job: CronJob): boolean {
  const now = state.deps.nowMs();
  const block = detectCronTaskStaticAccessBlock(job, now) ?? state.deps.preflightJobAccess?.(job);
  if (!block) {
    return false;
  }
  job.enabled = false;
  discardCronJobRunLease(job);
  job.state.nextRunAtMs = undefined;
  job.state.lastRunStatus = "blocked";
  job.state.lastStatus = "blocked";
  job.state.lastError = block.reason;
  job.state.stopReason = `needsAccess:${block.code}`;
  job.state.needsAccess = {
    ...block,
    source: block.source ?? "preflight",
    detectedAtMs: block.detectedAtMs ?? now,
  };
  return true;
}

function clearNeedsAccessPreflightBlock(job: CronJob) {
  job.state.needsAccess = undefined;
  if (job.state.stopReason?.startsWith("needsAccess:")) {
    job.state.stopReason = undefined;
  }
  job.state.lastError = undefined;
}

async function appendFinishedRunLog(
  state: CronServiceState,
  event: CronEvent & { action: "finished" },
) {
  const runLogPath = resolveCronRunLogPath({ storePath: state.deps.storePath, jobId: event.jobId });
  const prune = resolveCronRunLogPruneOptions(state.deps.cronConfig?.runLog);
  await appendCronRunLog(runLogPath, { ts: state.deps.nowMs(), ...event }, prune).catch((err) => {
    state.deps.log.warn({ err, jobId: event.jobId }, "failed to append cron run log");
  });
}

type CronJobsEnabledFilter = "all" | "enabled" | "disabled";
type CronJobsSortBy = "nextRunAtMs" | "updatedAtMs" | "name";
type CronSortDir = "asc" | "desc";

export type CronListPageOptions = {
  includeDisabled?: boolean;
  limit?: number;
  offset?: number;
  query?: string;
  enabled?: CronJobsEnabledFilter;
  sortBy?: CronJobsSortBy;
  sortDir?: CronSortDir;
};

export type CronListPageResult = {
  jobs: ReturnType<typeof sortJobs>;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};

export type CronQueueControlAction = "cancel" | "retry" | "clear-stale";

export type CronQueueControlResult =
  | {
      ok: true;
      action: CronQueueControlAction;
      runId: string;
      jobId: string;
      message: string;
      aborted?: boolean;
      processed?: number;
    }
  | {
      ok: false;
      action: CronQueueControlAction;
      runId: string;
      reason: string;
    };

function markQueueRunActiveOnJob(params: {
  job: CronJob;
  runId: string;
  trigger: "schedule" | "startup" | "manual";
  nowMs: number;
}) {
  const leaseMs = resolveCronJobRunLeaseMs(resolveCronJobTimeoutMs(params.job));
  params.job.state.runningAtMs = params.nowMs;
  params.job.state.activeRun = {
    runId: params.runId,
    phase: "running",
    trigger: params.trigger,
    attempt: (params.job.state.totalRuns ?? 0) + 1,
    startedAtMs: params.nowMs,
    heartbeatAtMs: params.nowMs,
    leaseExpiresAtMs: params.nowMs + leaseMs,
  };
  params.job.state.lastError = undefined;
  params.job.updatedAtMs = params.nowMs;
}
function mergeManualRunSnapshotAfterReload(params: {
  state: CronServiceState;
  jobId: string;
  snapshot: {
    enabled: boolean;
    updatedAtMs: number;
    state: CronJob["state"];
  } | null;
  removed: boolean;
}) {
  if (!params.state.store) {
    return;
  }
  if (params.removed) {
    params.state.store.jobs = params.state.store.jobs.filter((job) => job.id !== params.jobId);
    return;
  }
  if (!params.snapshot) {
    return;
  }
  const reloaded = params.state.store.jobs.find((job) => job.id === params.jobId);
  if (!reloaded) {
    return;
  }
  reloaded.enabled = params.snapshot.enabled;
  reloaded.updatedAtMs = params.snapshot.updatedAtMs;
  reloaded.state = params.snapshot.state;
}

async function ensureLoadedForRead(state: CronServiceState) {
  await ensureLoaded(state, { skipRecompute: true });
  if (!state.store) {
    return;
  }
  // Use the maintenance-only version so that read-only operations never
  // advance a past-due nextRunAtMs without executing the job (#16156).
  const changed = recomputeNextRunsForMaintenance(state);
  if (changed) {
    await persist(state);
  }
}

export async function start(state: CronServiceState) {
  if (!state.deps.cronEnabled) {
    state.deps.log.info({ enabled: false }, "cron: disabled");
    return;
  }

  const startupInterruptedJobIds = new Set<string>();
  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    const jobs = state.store?.jobs ?? [];
    for (const job of jobs) {
      if (hasActiveCronJobRun(job)) {
        const runId = job.state.activeRun?.runId;
        state.deps.log.warn(
          {
            jobId: job.id,
            runningAtMs: job.state.runningAtMs,
            runId,
          },
          "cron: recovered interrupted task run on startup",
        );
        recoverCronJobRunLease(
          job,
          state.deps.nowMs(),
          "Recovered interrupted task run on startup.",
        );
        if (runId) {
          await recoverCronTaskRunQueueItem({
            storePath: state.deps.storePath,
            runId,
            nowMs: state.deps.nowMs(),
            reason: "Recovered interrupted task run on startup.",
          });
        }
        startupInterruptedJobIds.add(job.id);
      }
    }
    await persist(state);
  });

  await runMissedJobs(state, { skipJobIds: startupInterruptedJobIds });

  await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    recomputeNextRuns(state);
    await persist(state);
    armTimer(state);
    state.deps.log.info(
      {
        enabled: true,
        jobs: state.store?.jobs.length ?? 0,
        nextWakeAtMs: nextWakeAtMs(state) ?? null,
      },
      "cron: started",
    );
  });
}

export function stop(state: CronServiceState) {
  stopTimer(state);
}

/**
 * Managed Gateway shutdown boundary. Unlike ordinary stop(), this permanently
 * rejects timer ingress for the instance and waits for an already-running tick
 * to finish all queue/ledger writes before state capture may continue.
 */
export async function stopAndDrainForLifecycle(
  state: CronServiceState,
  timeoutMs = 30_000,
): Promise<void> {
  state.lifecycleStopping = true;
  stopTimer(state);
  const active = state.activeTimerDrain;
  if (!active) {
    return;
  }
  const timeout = Math.max(1, Math.floor(timeoutMs));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`cron lifecycle drain timed out after ${timeout}ms`));
    }, timeout);
    void active.then(
      () => {
        clearTimeout(timer);
        if (state.activeTimerFailure !== null) {
          reject(state.activeTimerFailure);
          return;
        }
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function status(state: CronServiceState) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    const queue = await summarizeCronTaskRunQueue({
      storePath: state.deps.storePath,
      nowMs: state.deps.nowMs(),
    });
    return {
      enabled: state.deps.cronEnabled,
      storePath: state.deps.storePath,
      jobs: state.store?.jobs.length ?? 0,
      nextWakeAtMs: state.deps.cronEnabled ? (nextWakeAtMs(state) ?? null) : null,
      queue,
    };
  });
}

export async function list(state: CronServiceState, opts?: { includeDisabled?: boolean }) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    const includeDisabled = opts?.includeDisabled === true;
    const jobs = (state.store?.jobs ?? []).filter((j) => includeDisabled || j.enabled);
    return jobs.toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
  });
}

function resolveEnabledFilter(opts?: CronListPageOptions): CronJobsEnabledFilter {
  if (opts?.enabled === "all" || opts?.enabled === "enabled" || opts?.enabled === "disabled") {
    return opts.enabled;
  }
  return opts?.includeDisabled ? "all" : "enabled";
}

function sortJobs(jobs: CronJob[], sortBy: CronJobsSortBy, sortDir: CronSortDir) {
  const dir = sortDir === "desc" ? -1 : 1;
  return jobs.toSorted((a, b) => {
    let cmp = 0;
    if (sortBy === "name") {
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    } else if (sortBy === "updatedAtMs") {
      cmp = a.updatedAtMs - b.updatedAtMs;
    } else {
      const aNext = a.state.nextRunAtMs;
      const bNext = b.state.nextRunAtMs;
      if (typeof aNext === "number" && typeof bNext === "number") {
        cmp = aNext - bNext;
      } else if (typeof aNext === "number") {
        cmp = -1;
      } else if (typeof bNext === "number") {
        cmp = 1;
      } else {
        cmp = 0;
      }
    }
    if (cmp !== 0) {
      return cmp * dir;
    }
    return a.id.localeCompare(b.id);
  });
}

export async function listPage(state: CronServiceState, opts?: CronListPageOptions) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    const query = opts?.query?.trim().toLowerCase() ?? "";
    const enabledFilter = resolveEnabledFilter(opts);
    const sortBy = opts?.sortBy ?? "nextRunAtMs";
    const sortDir = opts?.sortDir ?? "asc";
    const source = state.store?.jobs ?? [];
    const filtered = source.filter((job) => {
      if (enabledFilter === "enabled" && !job.enabled) {
        return false;
      }
      if (enabledFilter === "disabled" && job.enabled) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [job.name, job.description ?? "", job.agentId ?? ""].join(" ").toLowerCase();
      return haystack.includes(query);
    });
    const sorted = sortJobs(filtered, sortBy, sortDir);
    const total = sorted.length;
    const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
    const defaultLimit = total === 0 ? 50 : total;
    const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? defaultLimit)));
    const jobs = sorted.slice(offset, offset + limit);
    const nextOffset = offset + jobs.length;
    return {
      jobs,
      total,
      offset,
      limit,
      hasMore: nextOffset < total,
      nextOffset: nextOffset < total ? nextOffset : null,
    } satisfies CronListPageResult;
  });
}

function jobPayloadText(job: CronJob): string {
  return job.payload.kind === "agentTurn" ? job.payload.message : job.payload.text;
}

function replanJobAfterTrustedSourceChange(job: CronJob) {
  if (!job.executionPolicy) {
    return;
  }
  job.executionPolicy = planTaskExecutionPolicy({
    name: job.name,
    message: jobPayloadText(job),
    policy: job.executionPolicy,
  });
}

function setTrustedSourceActiveOnJobs(jobs: CronJob[], sourceId: string, active: boolean) {
  for (const job of jobs) {
    const sources = job.executionPolicy?.trustedSources;
    if (!sources?.some((source) => source.id === sourceId)) {
      continue;
    }
    job.executionPolicy = {
      ...job.executionPolicy,
      trustedSources: sources.map((source) =>
        source.id === sourceId
          ? {
              ...source,
              active,
            }
          : source,
      ),
    };
    replanJobAfterTrustedSourceChange(job);
  }
}

function removeTrustedSourceFromJobs(jobs: CronJob[], sourceId: string) {
  for (const job of jobs) {
    const sources = job.executionPolicy?.trustedSources;
    if (!sources?.some((source) => source.id === sourceId)) {
      continue;
    }
    const remainingSources = sources.filter((source) => source.id !== sourceId);
    job.executionPolicy = {
      ...job.executionPolicy,
      trustedSources: remainingSources.length > 0 ? remainingSources : undefined,
    };
    replanJobAfterTrustedSourceChange(job);
  }
}

export async function sourcesList(
  state: CronServiceState,
  opts?: CronTaskSourceListFilters,
): Promise<CronTaskSourceListResult> {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    const sources = state.store ? listTrustedSources(state.store, opts) : [];
    return { sources, total: sources.length };
  });
}

export async function sourcesUpdate(
  state: CronServiceState,
  id: string,
  patch: { active?: boolean },
): Promise<CronTaskSourceUpdateResult> {
  return await locked(state, async () => {
    warnIfDisabled(state, "sources.update");
    await ensureLoaded(state, { skipRecompute: true });
    if (!state.store) {
      return { ok: false, reason: "Task store is not loaded." };
    }
    const active = patch.active;
    if (typeof active !== "boolean") {
      return { ok: false, reason: "Source update requires active=true or active=false." };
    }
    const source = setTrustedSourceActive(state.store, id, active, state.deps.nowMs());
    if (!source) {
      return { ok: false, reason: `Trusted source not found: ${id}` };
    }
    setTrustedSourceActiveOnJobs(state.store.jobs, id, active);
    await persist(state);
    return { ok: true, source };
  });
}

export async function sourcesRemove(
  state: CronServiceState,
  id: string,
): Promise<CronTaskSourceRemoveResult> {
  return await locked(state, async () => {
    warnIfDisabled(state, "sources.remove");
    await ensureLoaded(state, { skipRecompute: true });
    if (!state.store) {
      return { ok: false, id, removed: false, reason: "Task store is not loaded." };
    }
    const removed = removeTrustedSource(state.store, id);
    if (!removed) {
      return { ok: false, id, removed: false, reason: `Trusted source not found: ${id}` };
    }
    removeTrustedSourceFromJobs(state.store.jobs, id);
    await persist(state);
    return { ok: true, id, removed: true };
  });
}

export async function add(state: CronServiceState, input: CronJobCreate) {
  return await locked(state, async () => {
    warnIfDisabled(state, "add");
    await ensureLoaded(state);
    const job = createJob(state, input);
    applyNeedsAccessPreflight(state, job);
    state.store?.jobs.push(job);

    // Defensive: recompute all next-run times to ensure consistency
    recomputeNextRuns(state);

    await persist(state);
    armTimer(state);

    state.deps.log.info(
      {
        jobId: job.id,
        jobName: job.name,
        nextRunAtMs: job.state.nextRunAtMs,
        schedulerNextWakeAtMs: nextWakeAtMs(state) ?? null,
        timerArmed: state.timer !== null,
        cronEnabled: state.deps.cronEnabled,
      },
      "cron: job added",
    );

    emit(state, {
      jobId: job.id,
      action: "added",
      nextRunAtMs: job.state.nextRunAtMs,
    });
    return job;
  });
}

export async function update(state: CronServiceState, id: string, patch: CronJobPatch) {
  return await locked(state, async () => {
    warnIfDisabled(state, "update");
    await ensureLoaded(state, { skipRecompute: true });
    const job = findJobOrThrow(state, id);
    const now = state.deps.nowMs();
    applyJobPatch(job, patch);
    const accessBlocked = applyNeedsAccessPreflight(state, job);
    if (patch.enabled === true && !accessBlocked) {
      clearNeedsAccessPreflightBlock(job);
    }
    if (job.schedule.kind === "every") {
      const anchor = job.schedule.anchorMs;
      if (typeof anchor !== "number" || !Number.isFinite(anchor)) {
        const patchSchedule = patch.schedule;
        const fallbackAnchorMs =
          patchSchedule?.kind === "every"
            ? now
            : typeof job.createdAtMs === "number" && Number.isFinite(job.createdAtMs)
              ? job.createdAtMs
              : now;
        job.schedule = {
          ...job.schedule,
          anchorMs: Math.max(0, Math.floor(fallbackAnchorMs)),
        };
      }
    }
    const scheduleChanged = patch.schedule !== undefined;
    const enabledChanged = patch.enabled !== undefined;

    job.updatedAtMs = now;
    if (scheduleChanged || enabledChanged) {
      if (job.enabled) {
        job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
      } else {
        job.state.nextRunAtMs = undefined;
        discardCronJobRunLease(job);
      }
    } else if (job.enabled) {
      // Non-schedule edits should not mutate other jobs, but still repair a
      // missing/corrupt nextRunAtMs for the updated job.
      if (!hasScheduledNextRunAtMs(job.state.nextRunAtMs)) {
        job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
      }
    }

    await persist(state);
    armTimer(state);
    emit(state, {
      jobId: id,
      action: "updated",
      nextRunAtMs: job.state.nextRunAtMs,
    });
    return job;
  });
}

function payloadTextForTrustedSource(job: CronJob) {
  return job.payload.kind === "agentTurn" ? job.payload.message : job.payload.text;
}

function setPayloadTextForTrustedSource(job: CronJob, text: string) {
  if (job.payload.kind === "agentTurn") {
    job.payload.message = text;
  } else {
    job.payload.text = text;
  }
}

function defaultSourceNodeForRecovery(job: CronJob): string | undefined {
  return (
    job.state.lastGraphRepairStop?.sourceNodeId ??
    job.state.lastGraphRepair?.replacesNodeId ??
    job.state.lastGraphRepair?.nodeId
  );
}

function clearSourceRepairBlock(job: CronJob) {
  job.state.lastGraphRepairStop = undefined;
  job.state.evaluatorSourceRetryRuns = undefined;
  job.state.graphRepairAttempts = undefined;
  job.state.graphRepairSourceAttempts = undefined;
  job.state.graphRepairRoleAttempts = undefined;
  job.state.lastError = undefined;
  job.state.needsAccess = undefined;
  if (
    job.state.stopReason?.startsWith("needsSources:") ||
    job.state.stopReason?.startsWith("needsAccess:")
  ) {
    job.state.stopReason = undefined;
  }
}

function repairSetupHint(job: CronJob): {
  setupPath?: string;
  setupCommand?: string;
  message: string;
} {
  if (job.state.needsAccess?.setupPath || job.state.needsAccess?.setupCommand) {
    return {
      setupPath: job.state.needsAccess.setupPath,
      setupCommand: job.state.needsAccess.setupCommand,
      message: job.state.needsAccess.reason,
    };
  }
  const sourceNodeId = defaultSourceNodeForRecovery(job) ?? "";
  if (sourceNodeId.includes("gateway")) {
    return {
      setupPath: "/providers",
      message: "Open Providers and repair provider catalog/auth access.",
    };
  }
  if (sourceNodeId.includes("wallet")) {
    return { setupPath: "/wallet", message: "Open Wallet and repair wallet access." };
  }
  if (sourceNodeId.includes("web-search") || job.state.stopReason?.includes("source")) {
    return {
      setupPath: "/services#service-web-search",
      setupCommand: "fased configure --section web",
      message: "Open Services and configure search/source access, or add a trusted source.",
    };
  }
  return {
    setupPath: "/services",
    message: "Open Services, add a trusted source, or change task source policy.",
  };
}

function enableRecoveredTask(state: CronServiceState, job: CronJob, now: number) {
  const accessBlocked = applyNeedsAccessPreflight(state, job);
  if (accessBlocked) {
    return;
  }
  job.enabled = true;
  job.state.nextRunAtMs = now;
}

export async function repair(
  state: CronServiceState,
  id: string,
  params: {
    action: CronTaskRepairRecoveryAction;
    source?: string;
    sourceNodeId?: string;
  },
): Promise<CronTaskRepairRecoveryResult> {
  return await locked(state, async () => {
    warnIfDisabled(state, "repair");
    await ensureLoaded(state, { skipRecompute: true });
    const job = findJobOrThrow(state, id);
    const now = state.deps.nowMs();
    const hint = repairSetupHint(job);

    if (params.action === "configure_source") {
      return {
        ok: true,
        action: params.action,
        job,
        message: hint.message,
        setupPath: hint.setupPath,
        setupCommand: hint.setupCommand,
      };
    }

    if (params.action === "add_trusted_source") {
      const source = params.source?.trim();
      if (!source) {
        return {
          ok: false,
          action: params.action,
          reason: "Add trusted source requires source text or a source URL.",
          job,
        };
      }
      const trustedSource = createTrustedSourceForJob({ job, source, nowMs: now });
      const current = payloadTextForTrustedSource(job);
      setPayloadTextForTrustedSource(job, `${current.trim()}\n\nTrusted source:\n${source}`);
      const savedTrustedSource = state.store
        ? upsertTrustedSource(state.store, trustedSource)
        : trustedSource;
      applyJobPatch(job, {
        payload: job.payload,
        executionPolicy: {
          ...job.executionPolicy,
          trustedSources: mergeTrustedSources(job.executionPolicy?.trustedSources, [
            savedTrustedSource,
          ]),
        },
      });
      clearSourceRepairBlock(job);
      enableRecoveredTask(state, job, now);
      job.updatedAtMs = now;
      await persist(state);
      armTimer(state);
      emit(state, { jobId: id, action: "updated", nextRunAtMs: job.state.nextRunAtMs });
      return {
        ok: true,
        action: params.action,
        job,
        message: "Trusted source added. Task will retry from the updated source context.",
      };
    }

    if (params.action === "stop_source_path") {
      const sourceNodeId = params.sourceNodeId?.trim() || defaultSourceNodeForRecovery(job);
      if (!sourceNodeId) {
        return {
          ok: false,
          action: params.action,
          reason:
            "No source path is available to stop. Open the run detail or add a trusted source.",
          job,
        };
      }
      const stopped = stopSourcePathInPolicy(job.executionPolicy, sourceNodeId);
      if (!stopped.applied) {
        return { ok: false, action: params.action, reason: stopped.reason, job };
      }
      job.state.lastGraphRepairReplay = {
        graphRevision: stopped.graphRevision ?? job.state.graphRevision ?? 1,
        parentRevision: stopped.parentRevision,
        repairRevision: stopped.repairRevision ?? job.state.repairRevision ?? 1,
        repairAttempt: Math.max(1, (job.state.graphRepairAttempts ?? 0) + 1),
        maxRepairAttempts: 2,
        repairedAtMs: now,
        reusedNodeIds: [],
        invalidatedNodeIds: [sourceNodeId],
        requeuedNodeIds: [],
        reason: stopped.reason,
      };
      job.state.graphRevision = stopped.graphRevision ?? job.state.graphRevision;
      job.state.repairRevision = stopped.repairRevision ?? job.state.repairRevision;
      clearSourceRepairBlock(job);
      enableRecoveredTask(state, job, now);
      job.updatedAtMs = now;
      await persist(state);
      armTimer(state);
      emit(state, { jobId: id, action: "updated", nextRunAtMs: job.state.nextRunAtMs });
      return {
        ok: true,
        action: params.action,
        job,
        message: stopped.reason,
      };
    }

    clearSourceRepairBlock(job);
    enableRecoveredTask(state, job, now);
    job.updatedAtMs = now;
    await persist(state);
    armTimer(state);
    emit(state, { jobId: id, action: "updated", nextRunAtMs: job.state.nextRunAtMs });
    return {
      ok: true,
      action: params.action,
      job,
      message: "Task repair state cleared. Task will retry with the current replacement graph.",
    };
  });
}

export async function remove(state: CronServiceState, id: string) {
  return await locked(state, async () => {
    warnIfDisabled(state, "remove");
    await ensureLoaded(state);
    const before = state.store?.jobs.length ?? 0;
    if (!state.store) {
      return { ok: false, removed: false } as const;
    }
    state.store.jobs = state.store.jobs.filter((j) => j.id !== id);
    const removed = (state.store.jobs.length ?? 0) !== before;
    await persist(state);
    armTimer(state);
    if (removed) {
      emit(state, { jobId: id, action: "removed" });
    }
    return { ok: true, removed } as const;
  });
}

export async function run(state: CronServiceState, id: string, mode?: "due" | "force") {
  const prepared = await locked(state, async () => {
    warnIfDisabled(state, "run");
    await ensureLoaded(state, { skipRecompute: true });
    const job = findJobOrThrow(state, id);
    if (hasActiveCronJobRun(job)) {
      return { ok: true, ran: false, reason: "already-running" as const };
    }
    const now = state.deps.nowMs();
    const due = isJobDue(job, now, { forced: mode === "force" });
    if (!due) {
      return { ok: true, ran: false, reason: "not-due" as const };
    }
    const accessBlocked = applyNeedsAccessPreflight(state, job);
    if (accessBlocked) {
      await persist(state);
      emit(state, {
        jobId: job.id,
        action: "blocked",
        nextRunAtMs: job.state.nextRunAtMs,
      });
      return { ok: true, ran: false, reason: "needs-access" as const };
    }
    clearNeedsAccessPreflightBlock(job);

    // Reserve this run under lock, then execute outside lock so read ops
    // (`list`, `status`) stay responsive while the run is in progress.
    const checkpoint = reserveCronJobRunLease(job, now, {
      trigger: "manual",
      leaseMs: resolveCronJobRunLeaseMs(resolveCronJobTimeoutMs(job)),
    });
    await enqueueCronTaskRunQueueItem({
      storePath: state.deps.storePath,
      job,
      runId: checkpoint.runId,
      trigger: checkpoint.trigger,
      nowMs: now,
      skipReason: reserveCronJobRunBudget(job, now),
    });
    job.state.lastError = undefined;
    // Persist the running marker before releasing lock so timer ticks that
    // force-reload from disk cannot start the same job concurrently.
    await persist(state);
    return {
      ok: true,
      ran: true,
      jobId: job.id,
      runId: checkpoint.runId,
    } as const;
  });

  if (!prepared.ran) {
    return prepared;
  }
  if (!prepared.runId) {
    return { ok: false } as const;
  }
  const jobId = prepared.jobId;
  const results = await processQueuedCronTaskRuns(state, {
    runIds: new Set([prepared.runId]),
    maxRuns: 1,
  });
  const coreResult = results.find((result) => result.jobId === jobId);
  if (!coreResult) {
    const queueAfterRun = await readCronTaskRunQueue({ storePath: state.deps.storePath });
    const runAfter = queueAfterRun.runs.find((entry) => entry.runId === prepared.runId);
    if (runAfter?.status === "queued" || runAfter?.status === "running") {
      return {
        ok: true,
        ran: false,
        reason: runAfter.status,
        runId: prepared.runId,
        detail: runAfter.error,
      } as const;
    }
    if (runAfter?.status === "blocked" || runAfter?.status === "error") {
      return {
        ok: true,
        ran: false,
        reason: runAfter.status,
        runId: prepared.runId,
        detail: runAfter.error,
      } as const;
    }
    return { ok: false } as const;
  }
  const queueAfterRun = await readCronTaskRunQueue({ storePath: state.deps.storePath });
  const runAfter = queueAfterRun.runs.find((entry) => entry.runId === prepared.runId);
  if (runAfter?.status === "canceled" || runAfter?.cancelRequestedAtMs) {
    return { ok: true, ran: true } as const;
  }

  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    const job = state.store?.jobs.find((entry) => entry.id === jobId);
    if (!job) {
      return;
    }

    const shouldDelete = applyJobResult(state, job, {
      status: coreResult.status,
      error: coreResult.error,
      summary: coreResult.summary,
      outputText: coreResult.outputText,
      delivered: coreResult.delivered,
      sessionId: coreResult.sessionId,
      sessionKey: coreResult.sessionKey,
      policy: coreResult.policy,
      model: coreResult.model,
      provider: coreResult.provider,
      usage: coreResult.usage,
      startedAt: coreResult.startedAt,
      endedAt: coreResult.endedAt,
    });

    const telemetry = withEvaluatorPolicy(job, coreResult);
    const emittedStatus = job.state.lastRunStatus ?? coreResult.status;
    const accessReason = job.state.needsAccess?.reason;
    const emittedError =
      emittedStatus === "blocked"
        ? (accessReason ?? job.state.lastError ?? coreResult.error)
        : coreResult.error;
    const emittedSummary =
      emittedStatus === "blocked"
        ? `Blocked: ${accessReason ?? emittedError ?? "needs access"}`
        : coreResult.summary;
    const event: CronEvent & { action: "finished" } = {
      jobId: job.id,
      action: "finished",
      status: emittedStatus,
      error: emittedError,
      summary: emittedSummary,
      delivered: coreResult.delivered,
      deliveryStatus: job.state.lastDeliveryStatus,
      deliveryError: job.state.lastDeliveryError,
      sessionId: coreResult.sessionId,
      sessionKey: coreResult.sessionKey,
      runAtMs: coreResult.startedAt,
      durationMs: job.state.lastDurationMs,
      nextRunAtMs: job.state.nextRunAtMs,
      model: telemetry.model,
      provider: telemetry.provider,
      usage: telemetry.usage,
      policy: telemetry.policy,
    };
    emit(state, event);
    await appendFinishedRunLog(state, event);

    if (shouldDelete && state.store) {
      state.store.jobs = state.store.jobs.filter((entry) => entry.id !== job.id);
      emit(state, { jobId: job.id, action: "removed" });
    }

    // Manual runs should not advance other due jobs without executing them.
    // Use maintenance-only recompute to repair missing values while
    // preserving existing past-due nextRunAtMs entries for future timer ticks.
    const postRunSnapshot = shouldDelete
      ? null
      : {
          enabled: job.enabled,
          updatedAtMs: job.updatedAtMs,
          state: structuredClone(job.state),
        };
    const postRunRemoved = shouldDelete;
    // Isolated Telegram send can persist target writeback directly to disk.
    // Reload before final persist so manual `cron run` keeps those changes.
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    mergeManualRunSnapshotAfterReload({
      state,
      jobId,
      snapshot: postRunSnapshot,
      removed: postRunRemoved,
    });
    recomputeNextRunsForMaintenance(state);
    await persist(state);
    armTimer(state);
  });

  return { ok: true, ran: true } as const;
}

export async function queueCancel(
  state: CronServiceState,
  runId: string,
  reason?: string,
): Promise<CronQueueControlResult> {
  const now = state.deps.nowMs();
  const result = await cancelCronTaskRunQueueItem({
    storePath: state.deps.storePath,
    runId,
    nowMs: now,
    reason: reason ?? "Canceled by user.",
  });
  if (!result.ok) {
    return { ok: false, action: "cancel", runId, reason: result.reason };
  }
  const cancelReason = reason ?? "Canceled by user.";
  const aborted = abortActiveCronTaskRun(state, runId, cancelReason);

  await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const job = state.store?.jobs.find((entry) => entry.id === result.run.jobId);
    if (!job) {
      return;
    }
    if (job.state.activeRun?.runId === runId || job.state.runningAtMs) {
      discardCronJobRunLease(job);
      job.state.lastRunAtMs = result.run.startedAtMs ?? result.run.queuedAtMs;
      job.state.lastRunStatus = "skipped";
      job.state.lastStatus = "skipped";
      job.state.lastError = cancelReason;
      job.updatedAtMs = now;
      recomputeNextRunsForMaintenance(state);
      await persist(state);
      armTimer(state);
    }
  });

  return {
    ok: true,
    action: "cancel",
    runId,
    jobId: result.run.jobId,
    message: aborted ? `${result.message} Active local execution aborted.` : result.message,
    aborted,
  };
}

async function findQueueRunForControl(state: CronServiceState, runId: string) {
  const queue = await readCronTaskRunQueue({ storePath: state.deps.storePath });
  return queue.runs.find((run) => run.runId === runId);
}

export async function queueRetry(
  state: CronServiceState,
  runId: string,
  reason?: string,
): Promise<CronQueueControlResult> {
  const existing = await findQueueRunForControl(state, runId);
  if (!existing) {
    return { ok: false, action: "retry", runId, reason: "Run not found." };
  }
  const activeConflict = await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const job = state.store?.jobs.find((entry) => entry.id === existing.jobId);
    if (!job) {
      return "Task not found.";
    }
    if (job.state.activeRun && job.state.activeRun.runId !== runId) {
      return `Task already has active run ${job.state.activeRun.runId}.`;
    }
    return null;
  });
  if (activeConflict) {
    return { ok: false, action: "retry", runId, reason: activeConflict };
  }

  const now = state.deps.nowMs();
  const result = await retryCronTaskRunQueueItem({
    storePath: state.deps.storePath,
    runId,
    nowMs: now,
    reason: reason ?? "Retried by user.",
  });
  if (!result.ok) {
    return { ok: false, action: "retry", runId, reason: result.reason };
  }

  await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const job = state.store?.jobs.find((entry) => entry.id === result.run.jobId);
    if (!job) {
      return;
    }
    markQueueRunActiveOnJob({
      job,
      runId,
      trigger: result.run.trigger,
      nowMs: now,
    });
    await persist(state);
  });

  const outcomes = await processAndApplyQueuedCronTaskRuns(state, {
    runIds: new Set([runId]),
    maxRuns: 1,
    leaseOwner: "queue-retry",
  });
  return {
    ok: true,
    action: "retry",
    runId,
    jobId: result.run.jobId,
    message: result.message,
    processed: outcomes.length,
  };
}

export async function queueClearStale(
  state: CronServiceState,
  runId: string,
  reason?: string,
): Promise<CronQueueControlResult> {
  const now = state.deps.nowMs();
  const result = await clearExpiredCronTaskRunQueueLease({
    storePath: state.deps.storePath,
    runId,
    nowMs: now,
    reason: reason ?? "Stale lease cleared by user.",
  });
  if (!result.ok) {
    return { ok: false, action: "clear-stale", runId, reason: result.reason };
  }

  await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const job = state.store?.jobs.find((entry) => entry.id === result.run.jobId);
    if (!job) {
      return;
    }
    markQueueRunActiveOnJob({
      job,
      runId,
      trigger: result.run.trigger,
      nowMs: now,
    });
    await persist(state);
  });

  const outcomes = await processAndApplyQueuedCronTaskRuns(state, {
    runIds: new Set([runId]),
    maxRuns: 1,
    leaseOwner: "queue-clear-stale",
  });
  return {
    ok: true,
    action: "clear-stale",
    runId,
    jobId: result.run.jobId,
    message: result.message,
    processed: outcomes.length,
  };
}

export function wakeNow(
  state: CronServiceState,
  opts: { mode: "now" | "next-heartbeat"; text: string },
) {
  return wake(state, opts);
}

export async function work(
  state: CronServiceState,
  opts?: { maxRuns?: number; leaseOwner?: string },
) {
  warnIfDisabled(state, "worker");
  await recoverExpiredCronTaskRunQueueLeases({
    storePath: state.deps.storePath,
    nowMs: state.deps.nowMs(),
    reason: "Recovered expired task run queue lease.",
  });
  const maxRuns = Math.max(1, Math.floor(opts?.maxRuns ?? 1));
  const outcomes = await processAndApplyQueuedCronTaskRuns(state, {
    maxRuns,
    leaseOwner: opts?.leaseOwner,
  });
  return {
    ok: true as const,
    processed: outcomes.length,
    outcomes: outcomes.map((outcome) => ({
      jobId: outcome.jobId,
      status: outcome.status,
      error: outcome.error,
      sessionId: outcome.sessionId,
      sessionKey: outcome.sessionKey,
      delivered: outcome.delivered,
      startedAt: outcome.startedAt,
      endedAt: outcome.endedAt,
      model: outcome.model,
      provider: outcome.provider,
      policy: outcome.policy,
    })),
  };
}
