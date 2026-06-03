import {
  readCronRunLogEntriesPage,
  resolveCronRunLogPath,
  type CronRunLogEntry,
} from "./run-log.js";
import {
  readCronTaskRunQueue,
  type CronTaskRunQueueItem,
  type CronTaskRunQueueStepResumeState,
  type CronTaskRunQueueStepRetryPolicy,
  type CronTaskRunQueueStep,
  type CronTaskRunQueueStepStatus,
  type CronTaskRunQueueStatus,
} from "./task-run-queue.js";
import type {
  CronJob,
  CronRunPolicyTelemetry,
  CronRunStatus,
  CronTaskRepairRecoveryAction,
  CronTaskGraphRepairReplay,
  CronTaskSourceRole,
  CronTaskWorkflowGraph,
} from "./types.js";

export type CronTaskRunDetailControls = {
  canCancel: boolean;
  canRetry: boolean;
  canClearStaleLease: boolean;
};

export type CronTaskRunDetailExecution = {
  source?: "model" | "direct-tool" | "direct-text" | "queue";
  adapter?: string;
  modelUsed?: boolean;
  model?: string;
  modelSource?: string;
  provider?: string;
  deliveryStatus?: string;
  delivered?: boolean;
  summary?: string;
  error?: string;
  durationMs?: number;
  usage?: CronRunLogEntry["usage"];
};

export type CronTaskRunRepairRecommendation = {
  action: CronTaskRepairRecoveryAction;
  label: string;
  reason: string;
  priority: "primary" | "secondary";
  sourceNodeId?: string;
  setupPath?: string;
  setupCommand?: string;
  requiresInput?: "trusted_source";
};

export type CronTaskRunStepControlAction = "cancel" | "retry" | "clear-stale";

export type CronTaskRunStepControl =
  | {
      available: true;
      action: CronTaskRunStepControlAction;
      label: string;
      reason: string;
    }
  | {
      available: false;
      label: string;
      reason: string;
    };

export type CronTaskRunStepDetail = {
  id: string;
  status: CronTaskRunQueueStepStatus;
  attempt: number;
  maxAttempts: number;
  retryPolicy?: CronTaskRunQueueStepRetryPolicy;
  nextRetryAtMs?: number;
  resume?: CronTaskRunQueueStepResumeState;
  createdAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  durationMs?: number;
  leaseOwner?: string;
  leaseExpiresAtMs?: number;
  leaseExpired: boolean;
  leaseRemainingMs?: number;
  checkpoint?: Record<string, unknown>;
  error?: string;
  control: CronTaskRunStepControl;
};

export type CronTaskRunDetail = {
  runId: string;
  jobId: string;
  jobName: string;
  agentId?: string;
  sessionKey?: string;
  status: CronTaskRunQueueStatus | CronRunStatus | "unknown";
  trigger?: string;
  queuedAtMs?: number;
  startedAtMs?: number;
  completedAtMs?: number;
  updatedAtMs?: number;
  error?: string;
  queueRun?: CronTaskRunQueueItem;
  job?: CronJob;
  logEntry?: CronRunLogEntry;
  activeStep?: CronTaskRunQueueStep;
  stepDetails: CronTaskRunStepDetail[];
  leaseExpired: boolean;
  controls: CronTaskRunDetailControls;
  recommendedRepairActions?: CronTaskRunRepairRecommendation[];
  execution: CronTaskRunDetailExecution;
  workflowGraph?: CronTaskWorkflowGraph;
  repairReplay?: CronTaskGraphRepairReplay;
  transcriptPath?: string;
};

const TERMINAL_QUEUE_STATUSES = new Set<CronTaskRunQueueStatus>([
  "ok",
  "error",
  "skipped",
  "blocked",
  "canceled",
  "recovered",
]);

function jobIdForRun(runId: string, queueRun?: CronTaskRunQueueItem, jobs?: CronJob[]) {
  if (queueRun?.jobId) {
    return queueRun.jobId;
  }
  for (const job of jobs ?? []) {
    if (job.state?.lastRunCheckpoint?.runId === runId) {
      return job.id;
    }
  }
  return undefined;
}

async function findLogEntry(params: {
  storePath: string;
  runId: string;
  jobId?: string;
  jobs?: CronJob[];
}) {
  const jobIds = params.jobId
    ? [params.jobId]
    : Array.from(new Set((params.jobs ?? []).map((job) => job.id).filter(Boolean)));
  for (const jobId of jobIds) {
    const page = await readCronRunLogEntriesPage(
      resolveCronRunLogPath({ storePath: params.storePath, jobId }),
      {
        jobId,
        limit: 200,
        status: "all",
        sortDir: "desc",
      },
    );
    const match = page.entries.find((entry) => entry.policy?.runCheckpoint?.runId === params.runId);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function activeStepForRun(run?: CronTaskRunQueueItem) {
  return run?.steps.find((step) => step.status === "running");
}

function controlsForRun(params: {
  run?: CronTaskRunQueueItem;
  activeStep?: CronTaskRunQueueStep;
  leaseExpired: boolean;
}): CronTaskRunDetailControls {
  const run = params.run;
  if (!run) {
    return {
      canCancel: false,
      canRetry: false,
      canClearStaleLease: false,
    };
  }
  return {
    canCancel: !TERMINAL_QUEUE_STATUSES.has(run.status),
    canRetry: TERMINAL_QUEUE_STATUSES.has(run.status) && run.status !== "ok",
    canClearStaleLease: Boolean(params.activeStep && params.leaseExpired),
  };
}

function isTerminalStepStatus(status: CronTaskRunQueueStepStatus): boolean {
  return TERMINAL_QUEUE_STATUSES.has(status);
}

function stepControlForRun(params: {
  run?: CronTaskRunQueueItem;
  step: CronTaskRunQueueStep;
  controls: CronTaskRunDetailControls;
  leaseExpired: boolean;
  nowMs: number;
}): CronTaskRunStepControl {
  const { run, step, controls, leaseExpired, nowMs } = params;
  const maxAttempts = step.retryPolicy?.maxAttempts ?? step.maxAttempts;
  if (!run) {
    return {
      available: false,
      label: "No queue control",
      reason: "This run is only available from historical log data.",
    };
  }
  if (step.status === "running" && leaseExpired && controls.canClearStaleLease) {
    if (step.attempt >= maxAttempts) {
      return {
        available: false,
        label: "Retry exhausted",
        reason: "This step lease expired after using its retry policy.",
      };
    }
    return {
      available: true,
      action: "clear-stale",
      label: "Clear stale lease",
      reason: "This running step lease expired; clear it to requeue the run.",
    };
  }
  if (
    step.status === "queued" &&
    typeof step.nextRetryAtMs === "number" &&
    step.nextRetryAtMs > nowMs
  ) {
    return {
      available: false,
      label: "Retry pending",
      reason: `This step will retry after ${new Date(step.nextRetryAtMs).toISOString()}.`,
    };
  }
  if ((step.status === "queued" || step.status === "running") && controls.canCancel) {
    return {
      available: true,
      action: "cancel",
      label: "Cancel run",
      reason: "This step is not terminal; canceling stops the whole run.",
    };
  }
  if (isTerminalStepStatus(step.status) && step.status !== "ok" && controls.canRetry) {
    return {
      available: true,
      action: "retry",
      label: "Retry run",
      reason: "Retry requeues the run from the task queue.",
    };
  }
  if (step.status === "ok") {
    return {
      available: false,
      label: "Step complete",
      reason: "This step completed successfully.",
    };
  }
  if (step.status === "queued") {
    return {
      available: false,
      label: "Waiting",
      reason: "This step is waiting for earlier task work to finish.",
    };
  }
  return {
    available: false,
    label: "No step action",
    reason: "No queue action is available for this step.",
  };
}

function stepDetailsForRun(params: {
  run?: CronTaskRunQueueItem;
  controls: CronTaskRunDetailControls;
  nowMs: number;
}): CronTaskRunStepDetail[] {
  const { run, controls, nowMs } = params;
  return (run?.steps ?? []).map((step) => {
    const leaseExpired =
      step.status === "running" &&
      typeof step.leaseExpiresAtMs === "number" &&
      step.leaseExpiresAtMs <= nowMs;
    const leaseRemainingMs =
      step.status === "running" && typeof step.leaseExpiresAtMs === "number"
        ? step.leaseExpiresAtMs - nowMs
        : undefined;
    const durationMs =
      typeof step.startedAtMs === "number" && typeof step.completedAtMs === "number"
        ? Math.max(0, step.completedAtMs - step.startedAtMs)
        : undefined;
    return {
      id: step.id,
      status: step.status,
      attempt: step.attempt,
      maxAttempts: step.maxAttempts,
      retryPolicy: step.retryPolicy,
      nextRetryAtMs: step.nextRetryAtMs,
      resume: step.resume,
      createdAtMs: step.createdAtMs,
      startedAtMs: step.startedAtMs,
      completedAtMs: step.completedAtMs,
      durationMs,
      leaseOwner: step.leaseOwner,
      leaseExpiresAtMs: step.leaseExpiresAtMs,
      leaseExpired,
      leaseRemainingMs,
      checkpoint: step.checkpoint,
      error: step.error,
      control: stepControlForRun({ run, step, controls, leaseExpired, nowMs }),
    };
  });
}

function executionForRun(params: {
  queueRun?: CronTaskRunQueueItem;
  logEntry?: CronRunLogEntry;
}): CronTaskRunDetailExecution {
  const entry = params.logEntry;
  const queueResult = params.queueRun?.result;
  return {
    source: entry?.policy?.resultSource ?? (params.queueRun ? "queue" : undefined),
    adapter: entry?.policy?.resultAdapter,
    modelUsed: entry?.policy?.modelUsed,
    model: entry?.model ?? queueResult?.model,
    modelSource: entry?.policy?.modelSource,
    provider: entry?.provider ?? queueResult?.provider,
    deliveryStatus: entry?.deliveryStatus,
    delivered: entry?.delivered ?? queueResult?.delivered,
    summary: entry?.summary ?? queueResult?.summary,
    error: entry?.error ?? queueResult?.error ?? params.queueRun?.error,
    durationMs: entry?.durationMs,
    usage: entry?.usage ?? queueResult?.usage,
  };
}

function checkpointWorkflowGraph(value: unknown): CronTaskWorkflowGraph | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const graph = value as Partial<CronTaskWorkflowGraph>;
  return graph.version === 1 &&
    typeof graph.entryNodeId === "string" &&
    Array.isArray(graph.terminalNodeIds) &&
    Array.isArray(graph.nodes)
    ? (graph as CronTaskWorkflowGraph)
    : undefined;
}

function workflowGraphForRun(params: {
  queueRun?: CronTaskRunQueueItem;
  logEntry?: CronRunLogEntry;
  job?: CronJob;
}): CronTaskWorkflowGraph | undefined {
  if (params.logEntry?.policy?.planner?.graph) {
    return params.logEntry.policy.planner.graph;
  }
  if (params.job?.executionPolicy?.planner?.graph) {
    return params.job.executionPolicy.planner.graph;
  }
  for (const step of params.queueRun?.steps ?? []) {
    const graph = checkpointWorkflowGraph(step.checkpoint?.workflowGraph);
    if (graph) {
      return graph;
    }
  }
  return undefined;
}

type CronSourceQualitySource = NonNullable<
  NonNullable<CronRunPolicyTelemetry["sourceQuality"]>["sources"]
>[number];

function sourceQualityDetails(logEntry?: CronRunLogEntry): CronSourceQualitySource[] {
  return logEntry?.policy?.sourceQuality?.sources ?? [];
}

function sourceIsBad(source: CronSourceQualitySource) {
  if (source.status && source.status !== "ok") {
    return true;
  }
  if (typeof source.score === "number" && source.score < 0.5) {
    return true;
  }
  return false;
}

function sourceRoleRank(role?: CronTaskSourceRole) {
  switch (role) {
    case "primary":
      return 0;
    case "verification":
      return 1;
    case "enrichment":
      return 2;
    default:
      return 3;
  }
}

function firstBadSource(
  logEntry: CronRunLogEntry | undefined,
  predicate?: (source: CronSourceQualitySource) => boolean,
) {
  return sourceQualityDetails(logEntry)
    .filter((source) => sourceIsBad(source) && (!predicate || predicate(source)))
    .toSorted((a, b) => {
      const roleDelta = sourceRoleRank(a.role) - sourceRoleRank(b.role);
      if (roleDelta !== 0) {
        return roleDelta;
      }
      return (a.score ?? 0) - (b.score ?? 0);
    })[0];
}

function hasGraphRepair(job?: CronJob) {
  return Boolean(job?.state?.lastGraphRepair || job?.state?.lastGraphRepairs?.length);
}

function defaultSourceNodeForRecommendation(params: {
  job?: CronJob;
  logEntry?: CronRunLogEntry;
  preferOptional?: boolean;
}) {
  const bad = firstBadSource(params.logEntry, (source) =>
    params.preferOptional
      ? source.optional === true || source.role === "enrichment"
      : source.required !== false && source.optional !== true,
  );
  return (
    params.job?.state?.lastGraphRepairStop?.sourceNodeId ??
    params.job?.state?.lastGraphRepair?.replacesNodeId ??
    params.job?.state?.lastGraphRepair?.nodeId ??
    bad?.id
  );
}

function repairSetupFallback(job?: CronJob) {
  const setupPath = job?.state?.needsAccess?.setupPath;
  const service = job?.state?.needsAccess?.service;
  if (setupPath) {
    return setupPath;
  }
  if (service === "model_provider") {
    return "/providers";
  }
  if (service === "wallet") {
    return "/wallet";
  }
  if (service === "channel_delivery") {
    return "/channels";
  }
  if (service === "skills") {
    return "/skills";
  }
  return "/services";
}

function repairRecommendationKey(recommendation: CronTaskRunRepairRecommendation) {
  return `${recommendation.action}:${recommendation.sourceNodeId ?? ""}`;
}

function repairRecommendationsForRun(params: {
  job?: CronJob;
  logEntry?: CronRunLogEntry;
}): CronTaskRunRepairRecommendation[] {
  const { job, logEntry } = params;
  if (!job) {
    return [];
  }
  const recommendations: CronTaskRunRepairRecommendation[] = [];
  const add = (recommendation: CronTaskRunRepairRecommendation) => {
    const key = repairRecommendationKey(recommendation);
    if (recommendations.some((entry) => repairRecommendationKey(entry) === key)) {
      return;
    }
    recommendations.push(recommendation);
  };
  const sourceNodeId = defaultSourceNodeForRecommendation({ job, logEntry });
  const optionalSourceNodeId = defaultSourceNodeForRecommendation({
    job,
    logEntry,
    preferOptional: true,
  });
  const stop = job.state?.lastGraphRepairStop;
  const needsAccess = job.state?.needsAccess;

  if (needsAccess || stop?.code === "source_access_missing") {
    add({
      action: "configure_source",
      label: "Configure source",
      reason: needsAccess?.reason ?? stop?.reason ?? "The task needs source or service access.",
      priority: "primary",
      setupPath: repairSetupFallback(job),
      setupCommand: needsAccess?.setupCommand,
    });
  }

  switch (stop?.code) {
    case "repair_limit_reached":
      add({
        action: "add_trusted_source",
        label: "Add trusted source",
        reason: "Automatic source repair hit its limit; add a source the task can trust.",
        priority: recommendations.length === 0 ? "primary" : "secondary",
        requiresInput: "trusted_source",
      });
      if (sourceNodeId) {
        add({
          action: "stop_source_path",
          label: "Stop source path",
          reason: "Stop the source path that keeps exhausting repair attempts.",
          priority: "secondary",
          sourceNodeId,
        });
      }
      break;
    case "needs_user_source":
    case "insufficient_sources":
    case "conflicting_sources":
      add({
        action: "add_trusted_source",
        label: "Add trusted source",
        reason: stop.reason,
        priority: recommendations.length === 0 ? "primary" : "secondary",
        requiresInput: "trusted_source",
      });
      break;
  }

  const requiredBadSource = firstBadSource(
    logEntry,
    (source) => source.required !== false && source.optional !== true,
  );
  if (requiredBadSource || hasGraphRepair(job)) {
    add({
      action: "retry_replacement",
      label: "Retry with replacement",
      reason: requiredBadSource
        ? "A required source was weak or unavailable; retry using the repaired graph."
        : "A replacement source graph is available for this task.",
      priority: recommendations.length === 0 ? "primary" : "secondary",
      sourceNodeId: requiredBadSource?.id ?? sourceNodeId,
    });
  }

  const optionalBadSource = firstBadSource(
    logEntry,
    (source) => source.optional === true || source.role === "enrichment",
  );
  if (optionalBadSource || stop?.sourceRole === "enrichment") {
    add({
      action: "stop_source_path",
      label: "Stop source path",
      reason: optionalBadSource?.trustedSourceId
        ? "An optional trusted source is repeatedly weak; stop using that path for this task."
        : "An optional source path is weak; stop it so it does not keep dragging down runs.",
      priority: recommendations.length === 0 ? "primary" : "secondary",
      sourceNodeId: optionalBadSource?.id ?? optionalSourceNodeId ?? sourceNodeId,
    });
  }

  if (
    recommendations.length > 0 &&
    !recommendations.some((entry) => entry.action === "add_trusted_source")
  ) {
    add({
      action: "add_trusted_source",
      label: "Add trusted source",
      reason: "If you know a better source, add it to guide the next run.",
      priority: "secondary",
      requiresInput: "trusted_source",
    });
  }

  return recommendations;
}

function repairReplayForRun(params: {
  job?: CronJob;
  queueRun?: CronTaskRunQueueItem;
  runId: string;
}): CronTaskGraphRepairReplay | undefined {
  if (params.queueRun?.repairReplay) {
    return params.queueRun.repairReplay;
  }
  const replay = params.job?.state?.lastGraphRepairReplay;
  if (!replay) {
    return undefined;
  }
  if (replay.parentRunId) {
    return replay.parentRunId === params.runId ? replay : undefined;
  }
  const lastRunId = params.job?.state?.lastRunCheckpoint?.runId;
  if (lastRunId && lastRunId !== params.runId) {
    return undefined;
  }
  return replay;
}

export async function readCronTaskRunDetail(params: {
  storePath: string;
  runId: string;
  nowMs: number;
  jobs?: CronJob[];
}): Promise<CronTaskRunDetail | null> {
  const runId = params.runId.trim();
  if (!runId) {
    return null;
  }
  const queue = await readCronTaskRunQueue({ storePath: params.storePath });
  const queueRun = queue.runs.find((run) => run.runId === runId);
  const jobId = jobIdForRun(runId, queueRun, params.jobs);
  const logEntry = await findLogEntry({
    storePath: params.storePath,
    runId,
    jobId,
    jobs: params.jobs,
  });
  const resolvedJobId = queueRun?.jobId ?? logEntry?.jobId ?? jobId;
  if (!resolvedJobId) {
    return null;
  }
  const job = params.jobs?.find((candidate) => candidate.id === resolvedJobId);
  const activeStep = activeStepForRun(queueRun);
  const leaseExpired = Boolean(
    activeStep &&
    typeof activeStep.leaseExpiresAtMs === "number" &&
    activeStep.leaseExpiresAtMs <= params.nowMs,
  );
  const controls = controlsForRun({ run: queueRun, activeStep, leaseExpired });
  const sessionKey =
    logEntry?.sessionKey ?? queueRun?.result?.sessionKey ?? queueRun?.sessionKey ?? job?.sessionKey;
  return {
    runId,
    jobId: resolvedJobId,
    jobName: queueRun?.jobName ?? job?.name ?? "Task run",
    agentId: queueRun?.agentId ?? job?.agentId,
    sessionKey,
    status: queueRun?.status ?? logEntry?.status ?? "unknown",
    trigger: queueRun?.trigger ?? logEntry?.policy?.runCheckpoint?.trigger,
    queuedAtMs: queueRun?.queuedAtMs,
    startedAtMs: queueRun?.startedAtMs ?? logEntry?.policy?.runCheckpoint?.startedAtMs,
    completedAtMs: queueRun?.completedAtMs ?? logEntry?.policy?.runCheckpoint?.completedAtMs,
    updatedAtMs: queueRun?.updatedAtMs ?? logEntry?.ts,
    error: queueRun?.error ?? logEntry?.error,
    queueRun,
    job,
    logEntry,
    activeStep,
    stepDetails: stepDetailsForRun({ run: queueRun, controls, nowMs: params.nowMs }),
    leaseExpired,
    controls,
    recommendedRepairActions: repairRecommendationsForRun({ job, logEntry }),
    execution: executionForRun({ queueRun, logEntry }),
    workflowGraph: workflowGraphForRun({ queueRun, logEntry, job }),
    repairReplay: repairReplayForRun({ job, queueRun, runId }),
    transcriptPath: sessionKey ? `/chat?session=${encodeURIComponent(sessionKey)}` : undefined,
  };
}
