import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { detectCronTaskAccessBlockFromRun } from "../access-block.js";
import { resolveCronDeliveryPlan } from "../delivery.js";
import type { CronTaskGraphContextItem } from "../graph-context.js";
import {
  appendCronRunLog,
  resolveCronRunLogPath,
  resolveCronRunLogPruneOptions,
  type CronRunLogEntry,
} from "../run-log.js";
import { sweepCronRunSessions } from "../session-reaper.js";
import { recordAdaptiveRoutingRun } from "../task-adaptive-routing.js";
import { evaluateTaskRunForEscalation } from "../task-evaluator.js";
import { applySourceGraphRepairToPolicy, stopSourcePathInPolicy } from "../task-planner.js";
import {
  CRON_TASK_RUN_QUEUE_COLLECT_STEP_ID,
  CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID,
  CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID,
  CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
  completeCronTaskRunQueueStep,
  cronTaskRunQueueGraphNodeIdFromStepId,
  cronTaskRunQueueGraphStepId,
  enqueueCronTaskRunQueueItem,
  finishCronTaskRunQueueItem,
  leaseCronTaskRunQueueExecuteSteps,
  readCronTaskRunQueue,
  recoverExpiredCronTaskRunQueueLeases,
  retryCronTaskRunQueueExecuteStep,
  retryCronTaskRunQueueStep,
  startCronTaskRunQueueStep,
} from "../task-run-queue.js";
import { recordTrustedSourceOutcome } from "../trusted-sources.js";
import type {
  CronDeliveryStatus,
  CronJob,
  CronRunOutcome,
  CronRunPolicyTelemetry,
  CronRunStatus,
  CronRunTelemetry,
  CronTaskCoordinationEvidence,
  CronTaskGraphRepairReplay,
  CronTaskSourceAuthority,
  CronTaskSourceQualityBand,
  CronTaskWorkflowGraphNode,
} from "../types.js";
import {
  computeJobNextRunAtMs,
  hasScheduledNextRunAtMs,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
  reserveCronJobRunBudget,
  resolveJobPayloadTextForMain,
} from "./jobs.js";
import { locked } from "./locked.js";
import {
  completeCronJobRunLease,
  hasActiveCronJobRun,
  reserveCronJobRunLease,
  resolveCronJobRunLeaseMs,
} from "./run-lease.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";
import { DEFAULT_JOB_TIMEOUT_MS, resolveCronJobTimeoutMs } from "./timeout-policy.js";

export { DEFAULT_JOB_TIMEOUT_MS } from "./timeout-policy.js";

const MAX_TIMER_DELAY_MS = 60_000;

/**
 * Minimum gap between consecutive fires of the same cron job.  This is a
 * safety net that prevents spin-loops when `computeJobNextRunAtMs` returns
 * a value within the same second as the just-completed run.  The guard
 * is intentionally generous (2 s) so it never masks a legitimate schedule
 * but always breaks an infinite re-trigger cycle.  (See #17821)
 */
const MIN_REFIRE_GAP_MS = 2_000;

function mapRunStatusToQueueStatus(status: CronRunStatus) {
  return status;
}

export type TimedCronRunOutcome = CronRunOutcome &
  CronRunTelemetry & {
    jobId: string;
    runId?: string;
    delivered?: boolean;
    deliveryAttempted?: boolean;
    startedAt: number;
    endedAt: number;
  };

type QueueExecutionResult = CronRunOutcome &
  CronRunTelemetry & {
    delivered?: boolean;
    deliveryAttempted?: boolean;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringFromCheckpoint(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanFromCheckpoint(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberFromCheckpoint(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayFromCheckpoint(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function sourceRoleFromCheckpoint(value: unknown) {
  return value === "primary" || value === "verification" || value === "enrichment"
    ? value
    : undefined;
}

function sourceFreshnessFromCheckpoint(value: unknown) {
  return value === "static" || value === "runtime" || value === "live" ? value : undefined;
}

function sourceAuthorityFromCheckpoint(value: unknown): CronTaskSourceAuthority | undefined {
  return value === "runtime" ||
    value === "direct" ||
    value === "live" ||
    value === "generic" ||
    value === "unknown"
    ? value
    : undefined;
}

function sourceQualityBandFromCheckpoint(value: unknown): CronTaskSourceQualityBand | undefined {
  return value === "high" || value === "medium" || value === "low" || value === "unavailable"
    ? value
    : undefined;
}

function sourceVerificationStatusFromCheckpoint(value: unknown) {
  return value === "compatible" ||
    value === "insufficient_evidence" ||
    value === "conflict_suspected"
    ? value
    : undefined;
}

function statusFromCheckpoint(value: unknown): CronRunStatus {
  return value === "ok" || value === "error" || value === "skipped" || value === "blocked"
    ? value
    : "error";
}

function executionResultFromCheckpoint(checkpoint?: Record<string, unknown>): QueueExecutionResult {
  const policy = isRecord(checkpoint?.policy)
    ? (checkpoint.policy as CronRunTelemetry["policy"])
    : undefined;
  const usage = isRecord(checkpoint?.usage)
    ? (checkpoint.usage as CronRunTelemetry["usage"])
    : undefined;
  return {
    status: statusFromCheckpoint(checkpoint?.resultStatus ?? checkpoint?.status),
    error: stringFromCheckpoint(checkpoint?.error),
    summary: stringFromCheckpoint(checkpoint?.summary),
    outputText: stringFromCheckpoint(checkpoint?.outputText),
    sessionId: stringFromCheckpoint(checkpoint?.sessionId),
    sessionKey: stringFromCheckpoint(checkpoint?.sessionKey),
    model: stringFromCheckpoint(checkpoint?.model),
    provider: stringFromCheckpoint(checkpoint?.provider),
    usage,
    policy,
    delivered: booleanFromCheckpoint(checkpoint?.delivered),
    deliveryAttempted: booleanFromCheckpoint(checkpoint?.deliveryAttempted),
  };
}

function plannedWorkflowSteps(job: CronJob) {
  return job.executionPolicy?.planner?.steps?.map((step) => ({
    id: step.id,
    label: step.label,
    description: step.description,
    usesModel: step.usesModel,
    usesTool: step.usesTool,
    retryable: step.retryable,
    checkpointKeys: step.checkpointKeys,
    substeps: step.substeps?.map((substep) => ({
      id: substep.id,
      label: substep.label,
      description: substep.description,
      usesModel: substep.usesModel,
      usesTool: substep.usesTool,
      retryable: substep.retryable,
      checkpointKeys: substep.checkpointKeys,
    })),
  }));
}

function plannedAnalyzeStep(job: CronJob) {
  return plannedWorkflowSteps(job)?.find((step) => step.id === "analyze");
}

function plannedWorkflowGraph(job: CronJob) {
  const graph = job.executionPolicy?.planner?.graph;
  return graph
    ? {
        version: graph.version,
        graphRevision: graph.graphRevision,
        parentRevision: graph.parentRevision,
        repairRevision: graph.repairRevision,
        entryNodeId: graph.entryNodeId,
        terminalNodeIds: [...graph.terminalNodeIds],
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          label: node.label,
          kind: node.kind,
          description: node.description,
          dependsOn: node.dependsOn ? [...node.dependsOn] : undefined,
          optional: node.optional,
          sourceRole: node.sourceRole,
          sourcePriority: node.sourcePriority,
          sourceFreshness: node.sourceFreshness,
          sourceExpectedOutputType: node.sourceExpectedOutputType,
          usesModel: node.usesModel,
          usesTool: node.usesTool,
          retryable: node.retryable,
          checkpointKeys: node.checkpointKeys,
        })),
      }
    : undefined;
}

function graphNodeForStepId(job: CronJob, stepId: string) {
  const nodeId = cronTaskRunQueueGraphNodeIdFromStepId(stepId);
  return nodeId
    ? job.executionPolicy?.planner?.graph?.nodes.find((node) => node.id === nodeId)
    : undefined;
}

function graphNodeMappedQueueStep(node: NonNullable<ReturnType<typeof graphNodeForStepId>>) {
  if (node.id === "source-merge") {
    return CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID;
  }
  return node.kind === "model"
    ? CRON_TASK_RUN_QUEUE_WORKER_STEP_ID
    : node.kind === "synthesize"
      ? CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID
      : node.kind === "deliver"
        ? "deliver"
        : node.kind === "validation"
          ? "evaluate"
          : node.kind === "collect"
            ? CRON_TASK_RUN_QUEUE_COLLECT_STEP_ID
            : CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID;
}

function graphRepairSourceKey(repair: { nodeId: string; replacesNodeId?: string }) {
  return repair.replacesNodeId ?? repair.nodeId;
}

function graphRepairSourceRole(
  policy: CronRunTelemetry["policy"] | CronRunPolicyTelemetry | undefined,
  repair: { nodeId: string; replacesNodeId?: string },
) {
  const sourceId = graphRepairSourceKey(repair);
  return policy?.sourceQuality?.sources?.find((entry) => entry.id === sourceId)?.role;
}

function incrementRepairCount(
  counts: Record<string, number> | undefined,
  key: string | undefined,
): Record<string, number> | undefined {
  if (!key) {
    return counts;
  }
  return { ...counts, [key]: Math.max(0, Math.floor(counts?.[key] ?? 0)) + 1 };
}

function applyAutoStopSourcePaths(params: {
  job: CronJob;
  sourceNodeIds: string[];
  runId?: string;
  nowMs: number;
}) {
  const stopped: string[] = [];
  const reasons: string[] = [];
  let graphRevision: number | undefined;
  let parentRevision: number | undefined;
  let repairRevision: number | undefined;
  for (const sourceNodeId of params.sourceNodeIds) {
    const result = stopSourcePathInPolicy(params.job.executionPolicy, sourceNodeId);
    reasons.push(result.reason);
    if (!result.applied) {
      continue;
    }
    stopped.push(sourceNodeId);
    graphRevision = result.graphRevision ?? graphRevision;
    parentRevision = result.parentRevision ?? parentRevision;
    repairRevision = result.repairRevision ?? repairRevision;
    params.job.state.graphRepairSourceAttempts = incrementRepairCount(
      params.job.state.graphRepairSourceAttempts,
      sourceNodeId,
    );
  }
  if (stopped.length === 0) {
    return;
  }
  const repairAttempt = (params.job.state.graphRepairAttempts ?? 0) + 1;
  params.job.state.graphRepairAttempts = repairAttempt;
  params.job.state.graphRevision = graphRevision ?? params.job.state.graphRevision;
  params.job.state.repairRevision = repairRevision ?? params.job.state.repairRevision;
  const replay: CronTaskGraphRepairReplay = {
    graphRevision: graphRevision ?? params.job.state.graphRevision ?? 1,
    repairRevision: repairRevision ?? params.job.state.repairRevision ?? 1,
    repairAttempt,
    maxRepairAttempts: 2,
    repairedAtMs: params.nowMs,
    reusedNodeIds: [],
    invalidatedNodeIds: stopped,
    requeuedNodeIds: [],
    reason: `auto-stopped source path${stopped.length === 1 ? "" : "s"}: ${reasons.join("; ")}`,
    ...(params.runId ? { parentRunId: params.runId } : {}),
  };
  if (parentRevision !== undefined) {
    replay.parentRevision = parentRevision;
  }
  params.job.state.lastGraphRepairReplay = replay;
}

function graphExecutionNodeKind(job: CronJob) {
  const executionMode = job.executionPolicy?.executionMode;
  const plannerStrategy = job.executionPolicy?.planner?.strategy;
  if (executionMode === "no-model" || plannerStrategy === "no-model") {
    return "synthesize";
  }
  if (executionMode === "skill-only" || plannerStrategy === "skill-only") {
    return "tool";
  }
  return "model";
}

function graphNodeRunsTaskCore(
  job: CronJob,
  node: NonNullable<ReturnType<typeof graphNodeForStepId>>,
) {
  return node.kind === graphExecutionNodeKind(job);
}

function formatAbortReason(reason: unknown): string {
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }
  if (reason instanceof Error && reason.message.trim()) {
    if (reason.name === "AbortError" && reason.message === "This operation was aborted") {
      return timeoutErrorMessage();
    }
    return reason.message.trim();
  }
  return timeoutErrorMessage();
}

export function abortActiveCronTaskRun(
  state: CronServiceState,
  runId: string,
  reason = "Canceled by user.",
): boolean {
  const controller = state.activeRunAbortControllers.get(runId);
  if (!controller || controller.signal.aborted) {
    return false;
  }
  controller.abort(reason);
  return true;
}

export async function executeJobCoreWithTimeout(
  state: CronServiceState,
  job: CronJob,
  opts: {
    runId?: string;
    deferDelivery?: boolean;
    graphContext?: CronTaskGraphContextItem[];
  } = {},
): Promise<Awaited<ReturnType<typeof executeJobCore>>> {
  const jobTimeoutMs = resolveCronJobTimeoutMs(job);
  if (typeof jobTimeoutMs !== "number" && !opts.runId) {
    return await executeJobCore(state, job, undefined, {
      deferDelivery: opts.deferDelivery,
      graphContext: opts.graphContext,
    });
  }

  const runAbortController = new AbortController();
  let timeoutId: NodeJS.Timeout | undefined;
  const runId = opts.runId?.trim();
  if (runId) {
    state.activeRunAbortControllers.set(runId, runAbortController);
  }
  try {
    const runPromise = executeJobCore(state, job, runAbortController.signal, {
      deferDelivery: opts.deferDelivery,
      graphContext: opts.graphContext,
    });
    if (typeof jobTimeoutMs !== "number") {
      return await runPromise;
    }
    return await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          runAbortController.abort(timeoutErrorMessage());
          reject(new Error(timeoutErrorMessage()));
        }, jobTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (runId && state.activeRunAbortControllers.get(runId) === runAbortController) {
      state.activeRunAbortControllers.delete(runId);
    }
  }
}

function resolveRunConcurrency(state: CronServiceState): number {
  const raw = state.deps.cronConfig?.maxConcurrentRuns;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 1;
  }
  return Math.max(1, Math.floor(raw));
}
function timeoutErrorMessage(): string {
  return "cron: job execution timed out";
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.name === "AbortError" || err.message === timeoutErrorMessage();
}
/**
 * Exponential backoff delays (in ms) indexed by consecutive error count.
 * After the last entry the delay stays constant.
 */
const ERROR_BACKOFF_SCHEDULE_MS = [
  30_000, // 1st error  →  30 s
  60_000, // 2nd error  →   1 min
  5 * 60_000, // 3rd error  →   5 min
  15 * 60_000, // 4th error  →  15 min
  60 * 60_000, // 5th+ error →  60 min
];

function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_SCHEDULE_MS.length - 1);
  return ERROR_BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
}

function resolveDeliveryStatus(params: { job: CronJob; delivered?: boolean }): CronDeliveryStatus {
  if (params.delivered === true) {
    return "delivered";
  }
  if (params.delivered === false) {
    return "not-delivered";
  }
  return resolveCronDeliveryPlan(params.job).requested ? "unknown" : "not-requested";
}

/**
 * Apply the result of a job execution to the job's state.
 * Handles consecutive error tracking, exponential backoff, one-shot disable,
 * and nextRunAtMs computation. Returns `true` if the job should be deleted.
 */
export function applyJobResult(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: CronRunStatus;
    error?: string;
    summary?: string;
    outputText?: string;
    delivered?: boolean;
    sessionId?: string;
    sessionKey?: string;
    runId?: string;
    policy?: CronRunTelemetry["policy"];
    model?: string;
    provider?: string;
    usage?: CronRunTelemetry["usage"];
    startedAt: number;
    endedAt: number;
  },
): boolean {
  const detectedAccessBlock = detectCronTaskAccessBlockFromRun({
    error: result.error,
    summary: result.summary,
    outputText: result.outputText,
    detectedAtMs: result.endedAt,
  });
  const deliveryRequested = resolveCronDeliveryPlan(job).requested;
  const accessBlock =
    detectedAccessBlock?.code === "channel_delivery_unavailable" && !deliveryRequested
      ? undefined
      : detectedAccessBlock;
  const effectiveStatus: CronRunStatus = accessBlock ? "blocked" : result.status;
  const effectiveError = accessBlock ? accessBlock.reason : result.error;
  const effectiveSummary = accessBlock ? `Blocked: ${accessBlock.reason}` : result.summary;

  completeCronJobRunLease(job, result.endedAt);
  job.state.lastRunAtMs = result.startedAt;
  job.state.lastRunStatus = effectiveStatus;
  job.state.lastStatus = effectiveStatus;
  job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt);
  job.state.lastRunSessionId = result.sessionId;
  job.state.lastRunSessionKey = result.sessionKey;
  job.state.lastError = effectiveError;
  job.state.lastDelivered = result.delivered;
  const deliveryStatus = resolveDeliveryStatus({ job, delivered: result.delivered });
  job.state.lastDeliveryStatus = deliveryStatus;
  job.state.lastDeliveryError =
    deliveryStatus === "not-delivered" && effectiveError ? effectiveError : undefined;
  job.state.lastRunResultSource = result.policy?.resultSource;
  job.state.lastRunResultAdapter = result.policy?.resultAdapter;
  job.state.lastRunModelUsed = result.policy?.modelUsed;
  job.state.lastRunModelSource = result.policy?.modelSource;
  job.updatedAtMs = result.endedAt;

  // Track consecutive errors for backoff / auto-disable.
  if (effectiveStatus === "error") {
    job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
  } else {
    job.state.consecutiveErrors = 0;
  }
  job.state.totalRuns = (job.state.totalRuns ?? 0) + 1;
  if (effectiveStatus === "ok") {
    job.state.successfulRuns = (job.state.successfulRuns ?? 0) + 1;
  }
  if (accessBlock) {
    job.enabled = false;
    job.state.needsAccess = accessBlock;
    job.state.stopReason = `needsAccess:${accessBlock.code}`;
    job.state.pendingEscalation = undefined;
    job.state.nextRunAtMs = undefined;
    return false;
  }
  if (effectiveStatus === "ok") {
    job.state.needsAccess = undefined;
    job.state.lastGraphRepairStop = undefined;
    if (job.state.stopReason?.startsWith("needsAccess:")) {
      job.state.stopReason = undefined;
    }
  }

  const shouldDelete =
    job.schedule.kind === "at" && job.deleteAfterRun === true && effectiveStatus === "ok";
  const evaluation = evaluateTaskRunForEscalation({
    job,
    result: {
      ...result,
      status: effectiveStatus,
      summary: effectiveSummary,
      policy: result.policy,
    },
    nowMs: result.endedAt,
  });
  if (evaluation) {
    job.state.lastEvaluatorDecision = evaluation.decision;
    if (evaluation.state) {
      Object.assign(job.state, evaluation.state);
    }
    const graphRepairs =
      evaluation.graphRepairs ?? (evaluation.graphRepair ? [evaluation.graphRepair] : undefined);
    if (graphRepairs?.length) {
      const appliedRepairs = graphRepairs.map((graphRepair) => {
        const repair = applySourceGraphRepairToPolicy(job.executionPolicy, graphRepair);
        const appliedRepair = {
          ...graphRepair,
          applied: repair.applied,
          applyReason: repair.reason,
        };
        if (repair.graphRevision) {
          appliedRepair.graphRevision = repair.graphRevision;
        }
        if (repair.parentRevision) {
          appliedRepair.parentRevision = repair.parentRevision;
        }
        if (repair.repairRevision) {
          appliedRepair.repairRevision = repair.repairRevision;
        }
        return appliedRepair;
      });
      job.state.lastGraphRepairs = appliedRepairs;
      job.state.lastGraphRepair = appliedRepairs[0];
      const lastApplied = appliedRepairs.toReversed().find((repair) => repair.applied);
      if (lastApplied?.graphRevision && lastApplied.repairRevision) {
        const graphRepairAttempts = (job.state.graphRepairAttempts ?? 0) + 1;
        job.state.graphRevision = lastApplied.graphRevision;
        job.state.repairRevision = lastApplied.repairRevision;
        job.state.graphRepairAttempts = graphRepairAttempts;
        for (const repair of appliedRepairs.filter((entry) => entry.applied)) {
          const sourceKey = graphRepairSourceKey(repair);
          job.state.graphRepairSourceAttempts = incrementRepairCount(
            job.state.graphRepairSourceAttempts,
            sourceKey,
          );
          const sourceRole = graphRepairSourceRole(result.policy, repair);
          job.state.graphRepairRoleAttempts = incrementRepairCount(
            job.state.graphRepairRoleAttempts,
            sourceRole,
          ) as CronJob["state"]["graphRepairRoleAttempts"];
        }
        const repairReplay: CronTaskGraphRepairReplay = {
          graphRevision: lastApplied.graphRevision,
          repairRevision: lastApplied.repairRevision,
          repairAttempt: graphRepairAttempts,
          maxRepairAttempts: 2,
          repairedAtMs: result.endedAt,
          reusedNodeIds: [],
          invalidatedNodeIds: [],
          requeuedNodeIds: [],
          reason: appliedRepairs.map((repair) => repair.applyReason ?? repair.reason).join("; "),
        };
        if (result.runId) {
          repairReplay.parentRunId = result.runId;
        }
        if (lastApplied.parentRevision) {
          repairReplay.parentRevision = lastApplied.parentRevision;
        }
        job.state.lastGraphRepairReplay = repairReplay;
      }
    }
    if (evaluation.autoStopSourceNodeIds?.length) {
      applyAutoStopSourcePaths({
        job,
        sourceNodeIds: evaluation.autoStopSourceNodeIds,
        runId: result.runId,
        nowMs: result.endedAt,
      });
    }
    if (evaluation.clearPending) {
      job.state.pendingEscalation = undefined;
    }
  }
  const adaptiveDecision = recordAdaptiveRoutingRun({
    job,
    result: {
      status: effectiveStatus,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      model: result.model,
      provider: result.provider,
      usage: result.usage,
      policy: result.policy,
      deliveryStatus,
    },
  });
  const stopReason =
    evaluation?.pendingEscalation ||
    evaluation?.pendingCoordination ||
    evaluation?.refireSoon ||
    adaptiveDecision?.route === "agent-evidence"
      ? undefined
      : (evaluation?.disable?.stopReason ??
        resolveTaskStopReason(job, {
          ...result,
          status: effectiveStatus,
          summary: effectiveSummary,
        }));
  if (evaluation?.pendingEscalation && !stopReason) {
    job.state.pendingEscalation = evaluation.pendingEscalation;
    job.state.evaluatorEscalationRuns = (job.state.evaluatorEscalationRuns ?? 0) + 1;
    job.state.stopReason = undefined;
    job.state.nextRunAtMs = result.endedAt + MIN_REFIRE_GAP_MS;
    return false;
  }
  if (evaluation?.pendingCoordination && !stopReason) {
    job.state.pendingCoordination = evaluation.pendingCoordination;
    job.state.evaluatorCoordinationRuns = (job.state.evaluatorCoordinationRuns ?? 0) + 1;
    job.state.stopReason = undefined;
    job.state.nextRunAtMs = result.endedAt + MIN_REFIRE_GAP_MS;
    return false;
  }
  if (evaluation?.refireSoon && !stopReason) {
    job.state.stopReason = undefined;
    job.state.nextRunAtMs = result.endedAt + MIN_REFIRE_GAP_MS;
    return false;
  }
  if (stopReason) {
    job.enabled = false;
    job.state.stopReason = stopReason;
    job.state.nextRunAtMs = undefined;
  }

  if (!shouldDelete && !stopReason) {
    if (job.schedule.kind === "at") {
      // One-shot jobs are always disabled after ANY terminal status
      // (ok, error, or skipped). This prevents tight-loop rescheduling
      // when computeJobNextRunAtMs returns the past atMs value (#11452).
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      if (effectiveStatus === "error") {
        state.deps.log.warn(
          {
            jobId: job.id,
            jobName: job.name,
            consecutiveErrors: job.state.consecutiveErrors,
            error: effectiveError,
          },
          "cron: disabling one-shot job after error",
        );
      }
    } else if (effectiveStatus === "error" && job.enabled) {
      // Apply exponential backoff for errored jobs to prevent retry storms.
      const backoff = errorBackoffMs(job.state.consecutiveErrors ?? 1);
      const normalNext = computeJobNextRunAtMs(job, result.endedAt);
      const backoffNext = result.endedAt + backoff;
      // Use whichever is later: the natural next run or the backoff delay.
      job.state.nextRunAtMs =
        normalNext !== undefined ? Math.max(normalNext, backoffNext) : backoffNext;
      state.deps.log.info(
        {
          jobId: job.id,
          consecutiveErrors: job.state.consecutiveErrors,
          backoffMs: backoff,
          nextRunAtMs: job.state.nextRunAtMs,
        },
        "cron: applying error backoff",
      );
    } else if (job.enabled) {
      const naturalNext = computeJobNextRunAtMs(job, result.endedAt);
      if (job.schedule.kind === "cron") {
        // Safety net: ensure the next fire is at least MIN_REFIRE_GAP_MS
        // after the current run ended.  Prevents spin-loops when the
        // schedule computation lands in the same second due to
        // timezone/croner edge cases (see #17821).
        const minNext = result.endedAt + MIN_REFIRE_GAP_MS;
        job.state.nextRunAtMs =
          naturalNext !== undefined ? Math.max(naturalNext, minNext) : minNext;
      } else {
        job.state.nextRunAtMs = naturalNext;
      }
    } else {
      job.state.nextRunAtMs = undefined;
    }
  }

  return shouldDelete;
}

function normalizeStopText(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function outputMatchesStopMarkers(params: {
  markers?: string[];
  summary?: string;
  outputText?: string;
}): string | undefined {
  if (!params.markers?.length) {
    return undefined;
  }
  const text = normalizeStopText([params.summary, params.outputText].filter(Boolean).join("\n"));
  if (!text) {
    return undefined;
  }
  return params.markers.find((marker) => {
    const normalized = normalizeStopText(marker);
    return normalized.length > 0 && text.includes(normalized);
  });
}

function outputMatchesSemanticSuccess(params: {
  successCriteria?: string;
  summary?: string;
  outputText?: string;
}): boolean {
  const criteria = normalizeStopText(params.successCriteria);
  if (!criteria) {
    return false;
  }
  const text = normalizeStopText([params.summary, params.outputText].filter(Boolean).join("\n"));
  if (!text) {
    return false;
  }
  const negative = [
    "not complete",
    "not completed",
    "incomplete",
    "needs deeper analysis",
    "needs further analysis",
    "failed",
    "blocked",
    "missing",
    "unable to",
  ];
  if (negative.some((marker) => text.includes(marker))) {
    return false;
  }
  return [
    "success criteria met",
    "goal complete",
    "task complete",
    "completed successfully",
    "done",
    "no further action",
    "no deeper analysis required",
    criteria,
  ].some((marker) => marker.length > 0 && text.includes(marker));
}

function resolveTaskStopReason(
  job: CronJob,
  result: {
    status: CronRunStatus;
    summary?: string;
    outputText?: string;
  },
): string | undefined {
  const stop = job.executionPolicy?.stop;
  if (!stop) {
    return undefined;
  }
  const totalRuns = job.state.totalRuns ?? 0;
  const successfulRuns = job.state.successfulRuns ?? 0;
  if (typeof stop.maxTotalRuns === "number" && totalRuns >= stop.maxTotalRuns) {
    return `maxTotalRuns:${stop.maxTotalRuns}`;
  }
  if (
    result.status === "ok" &&
    typeof stop.maxSuccessfulRuns === "number" &&
    successfulRuns >= stop.maxSuccessfulRuns
  ) {
    return `maxSuccessfulRuns:${stop.maxSuccessfulRuns}`;
  }
  if (result.status !== "ok") {
    return undefined;
  }
  const matchedMarker = outputMatchesStopMarkers({
    markers: stop.outputIncludes,
    summary: result.summary,
    outputText: result.outputText,
  });
  if (matchedMarker) {
    return `outputIncludes:${matchedMarker}`;
  }
  if (
    outputMatchesSemanticSuccess({
      successCriteria: job.executionPolicy?.successCriteria,
      summary: result.summary,
      outputText: result.outputText,
    })
  ) {
    return "successCriteria";
  }
  if (stop.onSuccess === true) {
    return "onSuccess";
  }
  return undefined;
}

async function applyOutcomeToStoredJob(
  state: CronServiceState,
  result: TimedCronRunOutcome,
): Promise<void> {
  const store = state.store;
  if (!store) {
    return;
  }
  const jobs = store.jobs;
  const job = jobs.find((entry) => entry.id === result.jobId);
  if (!job) {
    return;
  }

  const shouldDelete = applyJobResult(state, job, {
    status: result.status,
    error: result.error,
    summary: result.summary,
    outputText: result.outputText,
    delivered: result.delivered,
    sessionId: result.sessionId,
    sessionKey: result.sessionKey,
    policy: result.policy,
    model: result.model,
    provider: result.provider,
    usage: result.usage,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
  });

  await emitJobFinished(state, job, withEvaluatorPolicy(job, result), result.startedAt);

  if (shouldDelete) {
    store.jobs = jobs.filter((entry) => entry.id !== job.id);
    emit(state, { jobId: job.id, action: "removed" });
  }
}

export function withEvaluatorPolicy<T extends CronRunTelemetry>(job: CronJob, result: T): T {
  const evaluator = job.state.lastEvaluatorDecision;
  const adaptive = job.state.adaptiveRouting?.lastDecision;
  const runCheckpoint = job.state.lastRunCheckpoint;
  if (!evaluator && !adaptive && !runCheckpoint) {
    return result;
  }
  return {
    ...result,
    policy: {
      ...result.policy,
      ...(evaluator ? { evaluator } : {}),
      ...(adaptive ? { adaptive } : {}),
      ...(runCheckpoint ? { runCheckpoint } : {}),
    },
  };
}

export function armTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
  if (!state.deps.cronEnabled) {
    state.deps.log.debug({}, "cron: armTimer skipped - scheduler disabled");
    return;
  }
  const nextAt = nextWakeAtMs(state);
  if (!nextAt) {
    const jobCount = state.store?.jobs.length ?? 0;
    const enabledCount = state.store?.jobs.filter((j) => j.enabled).length ?? 0;
    const withNextRun =
      state.store?.jobs.filter((j) => j.enabled && hasScheduledNextRunAtMs(j.state.nextRunAtMs))
        .length ?? 0;
    state.deps.log.debug(
      { jobCount, enabledCount, withNextRun },
      "cron: armTimer skipped - no jobs with nextRunAtMs",
    );
    return;
  }
  const now = state.deps.nowMs();
  const delay = Math.max(nextAt - now, 0);
  // Wake at least once a minute to avoid schedule drift and recover quickly
  // when the process was paused or wall-clock time jumps.
  const clampedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);
  // Intentionally avoid an `async` timer callback:
  // Vitest's fake-timer helpers can await async callbacks, which would block
  // tests that simulate long-running jobs. Runtime behavior is unchanged.
  state.timer = setTimeout(() => {
    void onTimer(state).catch((err) => {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    });
  }, clampedDelay);
  state.deps.log.debug(
    { nextAt, delayMs: clampedDelay, clamped: delay > MAX_TIMER_DELAY_MS },
    "cron: timer armed",
  );
}

function armRunningRecheckTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    void onTimer(state).catch((err) => {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    });
  }, MAX_TIMER_DELAY_MS);
}

async function completeLeasedQueuePhase(params: {
  state: CronServiceState;
  runId: string;
  stepId: string;
  status: CronRunStatus;
  checkpoint?: Record<string, unknown>;
  error?: string;
}) {
  const startedAt = params.state.deps.nowMs();
  await startCronTaskRunQueueStep({
    storePath: params.state.deps.storePath,
    runId: params.runId,
    stepId: params.stepId,
    nowMs: startedAt,
    leaseMs: 1_000,
    leaseOwner: "gateway-phase",
    checkpoint: { phase: params.stepId, ...params.checkpoint },
  });
  await completeCronTaskRunQueueStep({
    storePath: params.state.deps.storePath,
    runId: params.runId,
    stepId: params.stepId,
    nowMs: params.state.deps.nowMs(),
    status: params.status,
    error: params.error,
    checkpoint: { phase: params.stepId, ...params.checkpoint },
  });
}

async function readQueueRunStepCheckpoint(params: {
  state: CronServiceState;
  runId: string;
  stepId: string;
}): Promise<Record<string, unknown> | undefined> {
  const queue = await readCronTaskRunQueue({ storePath: params.state.deps.storePath });
  const run = queue.runs.find((entry) => entry.runId === params.runId);
  const step = run?.steps.find((entry) => entry.id === params.stepId);
  return step?.checkpoint;
}

async function readGraphExecutionCheckpoint(params: {
  state: CronServiceState;
  job: CronJob;
  runId: string;
}): Promise<
  | {
      stepId: string;
      graphNodeId?: string;
      graphNodeKind?: string;
      checkpoint: Record<string, unknown>;
    }
  | undefined
> {
  const queue = await readCronTaskRunQueue({ storePath: params.state.deps.storePath });
  const run = queue.runs.find((entry) => entry.runId === params.runId);
  if (!run) {
    return undefined;
  }
  const preferredKind = graphExecutionNodeKind(params.job);
  const candidates = run.steps.filter((step) => {
    return (
      step.kind === "graph-node" &&
      step.status === "ok" &&
      step.checkpoint?.graphNodeExecuted === true &&
      isRecord(step.checkpoint)
    );
  });
  const preferred =
    candidates.find((step) => step.graphNodeKind === preferredKind) ?? candidates[0];
  if (!preferred?.checkpoint || !isRecord(preferred.checkpoint)) {
    return undefined;
  }
  return {
    stepId: preferred.id,
    graphNodeId: preferred.graphNodeId,
    graphNodeKind: preferred.graphNodeKind,
    checkpoint: preferred.checkpoint,
  };
}

async function readGraphDataContext(params: {
  state: CronServiceState;
  runId: string;
}): Promise<CronTaskGraphContextItem[]> {
  const queue = await readCronTaskRunQueue({ storePath: params.state.deps.storePath });
  const run = queue.runs.find((entry) => entry.runId === params.runId);
  if (!run) {
    return [];
  }
  return run.steps
    .filter((step) => {
      return (
        step.kind === "graph-node" &&
        step.status !== "queued" &&
        isRecord(step.checkpoint) &&
        step.checkpoint.graphDataNodeExecuted === true
      );
    })
    .map((step) => {
      const checkpoint = step.checkpoint ?? {};
      const base: CronTaskGraphContextItem = {
        nodeId: stringFromCheckpoint(checkpoint.graphNodeId) ?? step.graphNodeId ?? step.id,
        nodeKind: step.graphNodeKind,
        label: stringFromCheckpoint(checkpoint.graphNodeLabel) ?? step.graphNodeLabel,
        optional: booleanFromCheckpoint(checkpoint.graphNodeOptional),
        sourceRole:
          sourceRoleFromCheckpoint(checkpoint.graphNodeSourceRole) ??
          sourceRoleFromCheckpoint(step.graphNodeSourceRole),
        sourcePriority:
          numberFromCheckpoint(checkpoint.graphNodeSourcePriority) ??
          numberFromCheckpoint(step.graphNodeSourcePriority),
        sourceFreshness:
          sourceFreshnessFromCheckpoint(checkpoint.graphNodeSourceFreshness) ??
          sourceFreshnessFromCheckpoint(step.graphNodeSourceFreshness),
        sourceExpectedOutputType:
          stringFromCheckpoint(checkpoint.graphNodeSourceExpectedOutputType) ??
          stringFromCheckpoint(step.graphNodeSourceExpectedOutputType),
        trustedSourceId:
          stringFromCheckpoint(checkpoint.graphNodeTrustedSourceId) ??
          stringFromCheckpoint(step.graphNodeTrustedSourceId),
        toolName: stringFromCheckpoint(checkpoint.toolName),
        status: statusFromCheckpoint(checkpoint.resultStatus ?? step.status),
        summary: stringFromCheckpoint(checkpoint.summary),
        outputText: stringFromCheckpoint(checkpoint.outputText),
        error: stringFromCheckpoint(checkpoint.error ?? step.error),
        sourceQualityScore: numberFromCheckpoint(checkpoint.sourceQualityScore),
        sourceQualityBand: sourceQualityBandFromCheckpoint(checkpoint.sourceQualityBand),
        sourceAuthority: sourceAuthorityFromCheckpoint(checkpoint.sourceAuthority),
        sourceQualityRationale: stringArrayFromCheckpoint(checkpoint.sourceQualityRationale),
        verificationStatus: sourceVerificationStatusFromCheckpoint(checkpoint.verificationStatus),
        sourceConflictCount: Array.isArray(checkpoint.conflicts)
          ? checkpoint.conflicts.length
          : undefined,
        needsReview: booleanFromCheckpoint(checkpoint.needsReview),
        evaluatorSignal: stringFromCheckpoint(checkpoint.evaluatorSignal),
        coordinationEvidence: Array.isArray(checkpoint.coordinationEvidence)
          ? (checkpoint.coordinationEvidence as CronTaskGraphContextItem["coordinationEvidence"])
          : undefined,
      };
      if (base.sourceQualityScore === undefined || base.sourceQualityBand === undefined) {
        const quality = scoreSourceQuality(base);
        return {
          ...base,
          sourceQualityScore: base.sourceQualityScore ?? quality.score,
          sourceQualityBand: base.sourceQualityBand ?? quality.band,
          sourceAuthority: base.sourceAuthority ?? quality.authority,
          sourceQualityRationale: base.sourceQualityRationale ?? quality.rationale,
        };
      }
      return base;
    });
}

function graphContextCheckpoint(context: CronTaskGraphContextItem[]) {
  return context.map((entry) => ({
    nodeId: entry.nodeId,
    nodeKind: entry.nodeKind,
    label: entry.label,
    optional: entry.optional,
    sourceRole: entry.sourceRole,
    sourcePriority: entry.sourcePriority,
    sourceFreshness: entry.sourceFreshness,
    sourceExpectedOutputType: entry.sourceExpectedOutputType,
    trustedSourceId: entry.trustedSourceId,
    toolName: entry.toolName,
    status: entry.status,
    summary: entry.summary,
    outputText: entry.outputText,
    error: entry.error,
    sourceQualityScore: entry.sourceQualityScore,
    sourceQualityBand: entry.sourceQualityBand,
    sourceAuthority: entry.sourceAuthority,
    sourceQualityRationale: entry.sourceQualityRationale,
    verificationStatus: entry.verificationStatus,
    sourceConflictCount: entry.sourceConflictCount,
    needsReview: entry.needsReview,
    evaluatorSignal: entry.evaluatorSignal,
    coordinationEvidence: entry.coordinationEvidence,
  }));
}

function isSourceFetchNodeId(value: string | undefined): boolean {
  return value === "source-fetch" || Boolean(value?.startsWith("source-fetch-"));
}

function compactText(value: string | undefined, maxChars = 2_000): string | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function clampSourceQualityScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function sourceQualityBand(score: number): CronTaskSourceQualityBand {
  if (score <= 0) {
    return "unavailable";
  }
  if (score >= 0.75) {
    return "high";
  }
  if (score >= 0.5) {
    return "medium";
  }
  return "low";
}

function sourceAuthorityForTool(params: {
  nodeId?: string;
  toolName?: string;
}): CronTaskSourceAuthority {
  const tool = params.toolName?.trim();
  if (tool === "gateway" || tool === "wallet" || tool === "mining" || tool === "offers") {
    return "runtime";
  }
  if (tool === "web_fetch") {
    return "direct";
  }
  if (tool === "web_search") {
    return "live";
  }
  if (params.nodeId?.startsWith("source-fetch-")) {
    return "generic";
  }
  return "unknown";
}

function scoreSourceQuality(entry: {
  nodeId?: string;
  toolName?: string;
  status?: CronRunStatus;
  optional?: boolean;
  sourceRole?: CronTaskGraphContextItem["sourceRole"];
  sourcePriority?: number;
  sourceFreshness?: CronTaskGraphContextItem["sourceFreshness"];
}): {
  score: number;
  band: CronTaskSourceQualityBand;
  authority: CronTaskSourceAuthority;
  rationale: string[];
} {
  const authority = sourceAuthorityForTool({ nodeId: entry.nodeId, toolName: entry.toolName });
  if (entry.status !== "ok") {
    return {
      score: 0,
      band: "unavailable",
      authority,
      rationale: ["source unavailable"],
    };
  }

  const rationale: string[] = ["source returned ok"];
  let score = 0.35;

  if (entry.sourceRole === "primary") {
    score += 0.14;
    rationale.push("primary source");
  } else if (entry.sourceRole === "verification") {
    score += 0.12;
    rationale.push("verification source");
  } else if (entry.sourceRole === "enrichment") {
    score += 0.04;
    rationale.push("enrichment source");
  }

  if (authority === "runtime") {
    score += 0.24;
    rationale.push("runtime state source");
  } else if (authority === "direct") {
    score += 0.2;
    rationale.push("direct target source");
  } else if (authority === "live") {
    score += 0.16;
    rationale.push("live source");
  } else if (authority === "generic") {
    score += 0.08;
    rationale.push("generic source handler");
  }

  if (entry.sourceFreshness === "live" || entry.sourceFreshness === "runtime") {
    score += 0.14;
    rationale.push(`${entry.sourceFreshness} freshness`);
  } else if (entry.sourceFreshness === "static") {
    score += 0.08;
    rationale.push("static snapshot");
  }

  if (typeof entry.sourcePriority === "number" && Number.isFinite(entry.sourcePriority)) {
    const priorityBonus = Math.max(0, Math.min(0.1, (100 - entry.sourcePriority) / 1_000));
    score += priorityBonus;
    rationale.push(`priority ${entry.sourcePriority}`);
  }

  if (entry.optional !== true) {
    score += 0.05;
    rationale.push("required source");
  }

  const normalized = clampSourceQualityScore(score);
  return {
    score: normalized,
    band: sourceQualityBand(normalized),
    authority,
    rationale,
  };
}

async function recordTrustedSourceGraphOutcome(params: {
  state: CronServiceState;
  node: CronTaskWorkflowGraphNode;
  nowMs: number;
  status: CronRunStatus;
  quality?: {
    score: number;
    band: CronTaskSourceQualityBand;
  };
  error?: string;
}) {
  if (!params.state.store) {
    return;
  }
  const updated = recordTrustedSourceOutcome(params.state.store, {
    trustedSourceId: params.node.trustedSourceId,
    nowMs: params.nowMs,
    status: params.status,
    qualityScore: params.quality?.score,
    qualityBand: params.quality?.band,
    error: params.error,
  });
  if (updated) {
    await persist(params.state);
  }
}

function coordinationEvidenceFromContext(
  context: CronTaskGraphContextItem[],
): CronTaskCoordinationEvidence[] {
  const seen = new Set<string>();
  const evidence: CronTaskCoordinationEvidence[] = [];
  for (const entry of context) {
    for (const item of entry.coordinationEvidence ?? []) {
      const key = [
        item.agentId,
        item.mode,
        item.status,
        item.childSessionKey,
        item.runId,
        item.createdAtMs,
      ].join(":");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      evidence.push(item);
    }
  }
  return evidence;
}

function summarizeCoordinationEvidence(evidence: CronTaskCoordinationEvidence[]) {
  const realEvidence = evidence.filter((entry) => entry.agentId && entry.agentId !== "none");
  const completed = realEvidence.filter((entry) => entry.status === "completed");
  const needsApproval = realEvidence.filter((entry) => entry.status === "needs_approval");
  const failed = realEvidence.filter(
    (entry) => entry.status === "error" || entry.status === "forbidden",
  );
  const accepted = realEvidence.filter((entry) => entry.status === "accepted");
  return {
    total: realEvidence.length,
    completed: completed.length,
    accepted: accepted.length,
    needsApproval: needsApproval.length,
    failed: failed.length,
    agents: Array.from(new Set(realEvidence.map((entry) => entry.agentId))),
  };
}

function formatCoordinationEvidenceForResult(evidence: CronTaskCoordinationEvidence[]) {
  const filtered = evidence.filter((entry) => entry.agentId && entry.agentId !== "none");
  if (filtered.length === 0) {
    return "";
  }
  return [
    "Task-room evidence considered:",
    ...filtered.map((entry) => {
      const run = entry.runId ? ` · run ${entry.runId}` : "";
      const session = entry.childSessionKey ? ` · session ${entry.childSessionKey}` : "";
      const body = compactText(entry.outputText ?? entry.summary ?? entry.error, 700);
      return `- ${entry.agentId}: ${entry.status}${session}${run}${body ? `\n  ${body}` : ""}`;
    }),
  ].join("\n");
}

function mergeCoordinationIntoSynthesis(params: {
  checkpoint: Record<string, unknown>;
  graphContext: CronTaskGraphContextItem[];
}) {
  const evidence = coordinationEvidenceFromContext(params.graphContext);
  const summary = summarizeCoordinationEvidence(evidence);
  if (summary.total === 0) {
    return params.checkpoint;
  }
  const evidenceText = formatCoordinationEvidenceForResult(evidence);
  const baseOutput = stringFromCheckpoint(params.checkpoint.outputText);
  const baseSummary = stringFromCheckpoint(params.checkpoint.summary);
  const coordinationSummary = `Task-room evidence: ${summary.completed}/${summary.total} completed${summary.needsApproval ? `, ${summary.needsApproval} awaiting approval` : ""}${summary.failed ? `, ${summary.failed} failed` : ""}.`;
  const policy =
    params.checkpoint.policy && typeof params.checkpoint.policy === "object"
      ? {
          ...(params.checkpoint.policy as Record<string, unknown>),
          coordination: {
            total: summary.total,
            completed: summary.completed,
            needsApproval: summary.needsApproval,
            failed: summary.failed,
            agents: summary.agents,
          },
        }
      : undefined;
  return {
    ...params.checkpoint,
    ...(policy ? { policy } : {}),
    coordinationEvidence: evidence,
    taskRoomEvidenceSummary: coordinationSummary,
    summary: [baseSummary, coordinationSummary].filter(Boolean).join(" "),
    outputText: [baseOutput, evidenceText].filter(Boolean).join("\n\n"),
  };
}

function buildCoordinationValidationCheckpoint(params: {
  context: CronTaskGraphContextItem[];
  nowMs: number;
}) {
  const evidence = coordinationEvidenceFromContext(params.context);
  const summary = summarizeCoordinationEvidence(evidence);
  if (summary.total === 0) {
    return undefined;
  }
  const action =
    summary.needsApproval > 0
      ? "needs_access"
      : summary.failed > 0 && summary.completed === 0
        ? "stop"
        : summary.completed > 0
          ? "none"
          : "request_sources";
  const reason =
    action === "needs_access"
      ? "Coordination is waiting for approval before helper Agents can be consulted."
      : action === "stop"
        ? "No selected coordination Agent completed successfully."
        : action === "request_sources"
          ? "Coordination did not produce usable task-room evidence yet."
          : `Task-room evidence from ${summary.completed} Agent${summary.completed === 1 ? "" : "s"} is ready for synthesis.`;
  return {
    coordinationEvidence: evidence,
    taskRoomEvidenceSummary: reason,
    evaluator: {
      source: "heuristic" as const,
      action,
      reason,
      signal:
        action === "needs_access"
          ? "coordination_needs_approval"
          : action === "stop"
            ? "coordination_failed"
            : action === "request_sources"
              ? "coordination_missing"
              : "coordination_ready",
    },
    evaluatorSignal:
      action === "none"
        ? "coordination_ready"
        : action === "needs_access"
          ? "coordination_needs_approval"
          : action === "stop"
            ? "coordination_failed"
            : "coordination_missing",
    summary: reason,
    outputText: formatCoordinationEvidenceForResult(evidence),
    endedAtMs: params.nowMs,
  };
}

function buildSourceMergeCheckpoint(params: {
  context: CronTaskGraphContextItem[];
  nowMs: number;
}) {
  const sources = params.context.filter((entry) => isSourceFetchNodeId(entry.nodeId));
  const normalized = sources.map((entry) => {
    const status = entry.status ?? "error";
    const text = compactText(entry.outputText ?? entry.summary ?? entry.error);
    const quality =
      entry.sourceQualityScore !== undefined && entry.sourceQualityBand
        ? {
            score: entry.sourceQualityScore,
            band: entry.sourceQualityBand,
            authority:
              entry.sourceAuthority ??
              sourceAuthorityForTool({ nodeId: entry.nodeId, toolName: entry.toolName }),
            rationale: entry.sourceQualityRationale ?? [],
          }
        : scoreSourceQuality(entry);
    return {
      id: entry.nodeId,
      label: entry.label ?? entry.nodeId,
      toolName: entry.toolName,
      optional: entry.optional === true,
      required: entry.optional !== true,
      role: entry.sourceRole ?? (entry.optional === true ? "enrichment" : "primary"),
      priority: entry.sourcePriority,
      freshness: entry.sourceFreshness,
      expectedOutputType: entry.sourceExpectedOutputType,
      status,
      qualityScore: quality.score,
      qualityBand: quality.band,
      authority: quality.authority,
      qualityRationale: quality.rationale,
      confidence: status === "ok" ? "observed" : "unavailable",
      summary: compactText(entry.summary, 500),
      excerpt: compactText(text, 2_000),
      error: compactText(entry.error, 500),
    };
  });
  const required = normalized.filter((entry) => entry.required);
  const optional = normalized.filter((entry) => entry.optional);
  const verification = normalized.filter((entry) => entry.role === "verification");
  const ok = normalized.filter((entry) => entry.status === "ok");
  const unavailable = normalized.filter((entry) => entry.status !== "ok");
  const bestSource = normalized.reduce<(typeof normalized)[number] | undefined>(
    (current, entry) => {
      if (entry.status !== "ok") {
        return current;
      }
      if (!current || entry.qualityScore > current.qualityScore) {
        return entry;
      }
      return current;
    },
    undefined,
  );
  const lowQuality = normalized.filter(
    (entry) => entry.status === "ok" && entry.qualityScore < 0.5,
  );
  const lines = normalized.map((entry) => {
    const requiredLabel = entry.required ? "required" : "optional";
    const tool = entry.toolName ? ` · ${entry.toolName}` : "";
    const role = entry.role ? ` · ${entry.role}` : "";
    const quality = ` · quality ${entry.qualityBand} ${entry.qualityScore.toFixed(2)} · ${entry.authority}`;
    const body = entry.excerpt ?? entry.error ?? entry.summary ?? "";
    return `- ${entry.label}${tool}${role} · ${requiredLabel} · ${entry.status}${quality}${body ? `\n  ${body}` : ""}`;
  });
  const summary = `Source merge: ${ok.length}/${normalized.length} sources ready (${required.length} required, ${optional.length} optional).${bestSource ? ` Best source: ${bestSource.id} (${bestSource.qualityScore.toFixed(2)} ${bestSource.qualityBand}).` : ""}`;
  const outputText =
    lines.length > 0
      ? `Merged source bundle\n${lines.join("\n")}`
      : "Merged source bundle\n- no source outputs were available";
  return {
    sourceBundle: {
      generatedAtMs: params.nowMs,
      total: normalized.length,
      ok: ok.length,
      unavailable: unavailable.length,
      required: required.length,
      optional: optional.length,
      verification: verification.length,
      conflicts: [],
      quality: {
        bestSourceId: bestSource?.id,
        bestScore: bestSource?.qualityScore,
        lowQuality: lowQuality.length,
        unavailable: unavailable.length,
      },
      sources: normalized,
    },
    summary,
    outputText,
  };
}

const SOURCE_EVIDENCE_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "source",
  "status",
]);

function normalizedEvidenceTokens(value: string | undefined): Set<string> {
  const text = value?.toLowerCase() ?? "";
  return new Set(
    text
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9._:-]+/g, " ")
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 3)
      .filter((entry) => !SOURCE_EVIDENCE_STOP_WORDS.has(entry)),
  );
}

function tokenOverlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.min(left.size, right.size);
}

function sourceEvidenceText(entry: CronTaskGraphContextItem): string {
  return [entry.summary, entry.outputText, entry.error].filter(Boolean).join("\n").trim();
}

function keyValuePairs(value: string): Map<string, string> {
  const pairs = new Map<string, string>();
  const pattern = /\b([a-z][a-z0-9_-]{2,24})\s*[:=]\s*([a-z0-9_.-]{2,40})\b/gi;
  for (const match of value.matchAll(pattern)) {
    const key = match[1]?.toLowerCase();
    const pairValue = match[2]?.toLowerCase();
    if (key && pairValue) {
      pairs.set(key, pairValue);
    }
  }
  return pairs;
}

const SOURCE_CONFLICT_PAIRS: Array<[string, string]> = [
  ["green", "red"],
  ["ok", "error"],
  ["healthy", "unhealthy"],
  ["available", "unavailable"],
  ["enabled", "disabled"],
  ["active", "inactive"],
  ["pass", "fail"],
  ["passed", "failed"],
  ["true", "false"],
  ["yes", "no"],
  ["up", "down"],
  ["increase", "decrease"],
  ["increased", "decreased"],
  ["bullish", "bearish"],
  ["calm", "volatile"],
  ["safe", "risk"],
];

function hasConflictTerms(leftText: string, rightText: string): string | undefined {
  const left = normalizedEvidenceTokens(leftText);
  const right = normalizedEvidenceTokens(rightText);
  for (const [a, b] of SOURCE_CONFLICT_PAIRS) {
    if ((left.has(a) && right.has(b)) || (left.has(b) && right.has(a))) {
      return `${a}/${b}`;
    }
  }
  const leftPairs = keyValuePairs(leftText);
  const rightPairs = keyValuePairs(rightText);
  for (const [key, leftValue] of leftPairs) {
    const rightValue = rightPairs.get(key);
    if (rightValue && rightValue !== leftValue) {
      return `${key}: ${leftValue} vs ${rightValue}`;
    }
  }
  return undefined;
}

function buildSourceVerifyCheckpoint(params: {
  context: CronTaskGraphContextItem[];
  nowMs: number;
}) {
  const sources = params.context.filter((entry) => isSourceFetchNodeId(entry.nodeId));
  const primary = sources.filter(
    (entry) => entry.sourceRole === "primary" && entry.status === "ok",
  );
  const verification = sources.filter(
    (entry) => entry.sourceRole === "verification" && entry.status === "ok",
  );
  const conflicts: Array<{
    primarySourceId: string;
    verificationSourceId: string;
    reason: string;
    primaryQualityScore?: number;
    verificationQualityScore?: number;
    primaryExcerpt?: string;
    verificationExcerpt?: string;
  }> = [];
  let compatiblePairs = 0;
  for (const primarySource of primary) {
    const primaryText = sourceEvidenceText(primarySource);
    const primaryTokens = normalizedEvidenceTokens(primaryText);
    for (const verificationSource of verification) {
      const verificationText = sourceEvidenceText(verificationSource);
      const conflictReason = hasConflictTerms(primaryText, verificationText);
      if (conflictReason) {
        conflicts.push({
          primarySourceId: primarySource.nodeId,
          verificationSourceId: verificationSource.nodeId,
          reason: conflictReason,
          primaryQualityScore: primarySource.sourceQualityScore,
          verificationQualityScore: verificationSource.sourceQualityScore,
          primaryExcerpt: compactText(primaryText, 500),
          verificationExcerpt: compactText(verificationText, 500),
        });
        continue;
      }
      const ratio = tokenOverlapRatio(primaryTokens, normalizedEvidenceTokens(verificationText));
      if (ratio >= 0.35) {
        compatiblePairs += 1;
      }
    }
  }
  const verificationStatus =
    verification.length === 0 || primary.length === 0
      ? "insufficient_evidence"
      : conflicts.length > 0
        ? "conflict_suspected"
        : compatiblePairs > 0
          ? "compatible"
          : "insufficient_evidence";
  const needsReview = verificationStatus === "conflict_suspected";
  const summary =
    verificationStatus === "conflict_suspected"
      ? `Source verification: conflict suspected (${conflicts.length} issue${conflicts.length === 1 ? "" : "s"}).`
      : verificationStatus === "compatible"
        ? "Source verification: compatible."
        : "Source verification: insufficient evidence.";
  const conflictLines = conflicts.map((conflict) => {
    const quality =
      typeof conflict.primaryQualityScore === "number" ||
      typeof conflict.verificationQualityScore === "number"
        ? ` · quality ${conflict.primaryQualityScore?.toFixed(2) ?? "n/a"} vs ${conflict.verificationQualityScore?.toFixed(2) ?? "n/a"}`
        : "";
    return `- ${conflict.primarySourceId} vs ${conflict.verificationSourceId}: ${conflict.reason}${quality}`;
  });
  const outputText = [
    summary,
    `Primary sources: ${primary.length}`,
    `Verification sources: ${verification.length}`,
    conflictLines.length > 0 ? `Conflicts\n${conflictLines.join("\n")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    verification: {
      generatedAtMs: params.nowMs,
      status: verificationStatus,
      needsReview,
      primarySources: primary.map((entry) => entry.nodeId),
      verificationSources: verification.map((entry) => entry.nodeId),
      sourceQuality: {
        primaryAverage:
          primary.length > 0
            ? clampSourceQualityScore(
                primary.reduce((sum, entry) => sum + (entry.sourceQualityScore ?? 0), 0) /
                  primary.length,
              )
            : undefined,
        verificationAverage:
          verification.length > 0
            ? clampSourceQualityScore(
                verification.reduce((sum, entry) => sum + (entry.sourceQualityScore ?? 0), 0) /
                  verification.length,
              )
            : undefined,
      },
      compatiblePairs,
      conflicts,
    },
    summary,
    outputText,
  };
}

async function completeCompatibilityPlanAnalysisStep(params: {
  state: CronServiceState;
  job: CronJob;
  runId: string;
}) {
  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  await completeCronTaskRunQueueStep({
    storePath: params.state.deps.storePath,
    runId: params.runId,
    stepId: CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID,
    nowMs: params.state.deps.nowMs(),
    status: "ok",
    checkpoint: {
      phase: CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID,
      workflowStep: plannedAnalyzeStep(params.job),
      workflowGraph: plannedWorkflowGraph(params.job),
      executionMode: params.job.executionPolicy?.executionMode,
      memoryScope: params.job.executionPolicy?.memoryScope,
      skillScope: params.job.executionPolicy?.skillScope,
      allowedSkills: params.job.executionPolicy?.allowedSkills,
      skillAction: params.job.executionPolicy?.skillAction,
      modelPolicy: params.job.executionPolicy?.modelPolicy,
      budget: params.job.executionPolicy?.budget,
      evaluator: params.job.executionPolicy?.evaluator,
      pendingEscalation: params.job.state.pendingEscalation,
      deliveryRequested: deliveryPlan.requested,
      deliveryChannel: deliveryPlan.channel,
      deliveryTarget: deliveryPlan.to,
      replayedFromGraph: true,
    },
  });
}

async function completeCompatibilitySynthesizeStepFromCheckpoint(params: {
  state: CronServiceState;
  job: CronJob;
  runId: string;
  checkpoint: Record<string, unknown>;
  sourceGraphStepId?: string;
  sourceGraphNodeId?: string;
}) {
  const result = executionResultFromCheckpoint(params.checkpoint);
  const executionStartedAt = numberFromCheckpoint(params.checkpoint.startedAtMs);
  const executionEndedAt = numberFromCheckpoint(params.checkpoint.endedAtMs);
  await completeCronTaskRunQueueStep({
    storePath: params.state.deps.storePath,
    runId: params.runId,
    stepId: CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID,
    nowMs: params.state.deps.nowMs(),
    status: "ok",
    checkpoint: {
      ...params.checkpoint,
      phase: CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID,
      startedAtMs: executionStartedAt,
      endedAtMs: executionEndedAt,
      workflowStep: plannedAnalyzeStep(params.job),
      workflowGraph: plannedWorkflowGraph(params.job),
      resultStatus: result.status,
      error: result.error,
      summary: result.summary,
      outputText: result.outputText,
      sessionId: result.sessionId,
      sessionKey: result.sessionKey,
      model: result.model,
      provider: result.provider,
      usage: result.usage,
      policy: result.policy,
      delivered: result.delivered,
      deliveryAttempted: result.deliveryAttempted,
      replayedFromGraphStepId: params.sourceGraphStepId,
      replayedFromGraphNodeId: params.sourceGraphNodeId,
    },
  });
}

async function completeCompatibilityEvaluateStepFromCheckpoint(params: {
  state: CronServiceState;
  job: CronJob;
  runId: string;
  checkpoint: Record<string, unknown>;
  sourceGraphStepId?: string;
  sourceGraphNodeId?: string;
}) {
  const result = executionResultFromCheckpoint(params.checkpoint);
  const checkpointEvidence = Array.isArray(params.checkpoint.coordinationEvidence)
    ? summarizeCoordinationEvidence(
        params.checkpoint.coordinationEvidence as CronTaskCoordinationEvidence[],
      )
    : undefined;
  const coordination =
    result.policy?.coordination ??
    (
      params.checkpoint.policy as
        | { coordination?: CronRunPolicyTelemetry["coordination"] }
        | undefined
    )?.coordination ??
    (checkpointEvidence && checkpointEvidence.total > 0
      ? {
          total: checkpointEvidence.total,
          completed: checkpointEvidence.completed,
          needsApproval: checkpointEvidence.needsApproval,
          failed: checkpointEvidence.failed,
          agents: checkpointEvidence.agents,
        }
      : undefined);
  const coordinationEvaluatorAction =
    coordination && coordination.total > 0
      ? coordination.needsApproval > 0
        ? "needs_access"
        : coordination.failed > 0 && coordination.completed === 0
          ? "stop"
          : coordination.completed > 0
            ? "none"
            : "request_sources"
      : undefined;
  await completeLeasedQueuePhase({
    state: params.state,
    runId: params.runId,
    stepId: "evaluate",
    status: "ok",
    checkpoint: {
      resultStatus: result.status,
      error: result.error,
      evaluator:
        (params.checkpoint.evaluator as { action?: string } | undefined)?.action ??
        result.policy?.evaluator?.action ??
        coordinationEvaluatorAction,
      taskRoomEvidenceSummary: stringFromCheckpoint(params.checkpoint.taskRoomEvidenceSummary),
      coordinationEvidence: Array.isArray(params.checkpoint.coordinationEvidence)
        ? params.checkpoint.coordinationEvidence
        : undefined,
      planner: result.policy?.planner?.strategy,
      workflowStep: params.job.executionPolicy?.planner?.steps?.find(
        (step) => step.id === "evaluate",
      ),
      replayedFromGraphStepId: params.sourceGraphStepId,
      replayedFromGraphNodeId: params.sourceGraphNodeId,
    },
  });
}

async function executeLeasedDeliveryStep(params: {
  state: CronServiceState;
  job: CronJob;
  lease: {
    runId: string;
    jobId: string;
    stepId?: string;
    trigger: "schedule" | "startup" | "manual";
    skipReason?: string;
    checkpoint?: Record<string, unknown>;
  };
  startedAt: number;
  deliveryStepId?: string;
  checkpointPhase?: string;
  graphCheckpoint?: Record<string, unknown>;
}): Promise<TimedCronRunOutcome | undefined> {
  const { state, job, lease, startedAt } = params;
  const deliveryStepId = params.deliveryStepId ?? "deliver";
  const checkpointPhase = params.checkpointPhase ?? "deliver";
  const deliveryPlan = resolveCronDeliveryPlan(job);
  const checkpoint =
    params.graphCheckpoint ??
    (await readQueueRunStepCheckpoint({
      state,
      runId: lease.runId,
      stepId: CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID,
    })) ??
    (await readQueueRunStepCheckpoint({
      state,
      runId: lease.runId,
      stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
    })) ??
    (await readQueueRunStepCheckpoint({
      state,
      runId: lease.runId,
      stepId: "execute",
    })) ??
    lease.checkpoint;
  const executionResult = executionResultFromCheckpoint(checkpoint);
  const executionStartedAt = numberFromCheckpoint(checkpoint?.startedAtMs) ?? startedAt;
  const executionEndedAt = numberFromCheckpoint(checkpoint?.endedAtMs);
  const finish = async (
    result: QueueExecutionResult,
    deliverStatus: "ok" | "error" | "skipped" | "blocked",
    error?: string,
  ) => {
    const endedAt = state.deps.nowMs();
    await completeCronTaskRunQueueStep({
      storePath: state.deps.storePath,
      runId: lease.runId,
      stepId: deliveryStepId,
      nowMs: endedAt,
      status: deliverStatus,
      error,
      checkpoint: {
        ...params.graphCheckpoint,
        phase: checkpointPhase,
        deliveryRequested: deliveryPlan.requested,
        deliveryChannel: deliveryPlan.channel,
        deliveryTarget: deliveryPlan.to,
        delivered: result.delivered,
        deliveryAttempted: result.deliveryAttempted,
        status: result.status,
        error: result.error,
      },
    });
    if (deliveryStepId !== "deliver") {
      await completeCronTaskRunQueueStep({
        storePath: state.deps.storePath,
        runId: lease.runId,
        stepId: "deliver",
        nowMs: endedAt,
        status: deliverStatus,
        error,
        checkpoint: {
          phase: "deliver",
          deliveryRequested: deliveryPlan.requested,
          deliveryChannel: deliveryPlan.channel,
          deliveryTarget: deliveryPlan.to,
          delivered: result.delivered,
          deliveryAttempted: result.deliveryAttempted,
          status: result.status,
          error: result.error,
          replayedFromGraphStepId: deliveryStepId,
          replayedFromGraphNodeId: params.graphCheckpoint?.graphNodeId,
        },
      });
    }
    await finishCronTaskRunQueueItem({
      storePath: state.deps.storePath,
      runId: lease.runId,
      nowMs: endedAt,
      status: mapRunStatusToQueueStatus(result.status),
      error: result.error,
      result: {
        status: result.status,
        summary: result.summary,
        error: result.error,
        delivered: result.delivered,
        sessionId: result.sessionId,
        sessionKey: result.sessionKey,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
      },
    });
    return {
      jobId: job.id,
      runId: lease.runId,
      ...result,
      startedAt: executionStartedAt,
      endedAt: executionEndedAt ?? endedAt,
    };
  };

  if (!deliveryPlan.requested || executionResult.status !== "ok") {
    return await finish(
      {
        ...executionResult,
        delivered: executionResult.delivered,
        deliveryAttempted: executionResult.deliveryAttempted,
      },
      deliveryPlan.requested ? "skipped" : "skipped",
      deliveryPlan.requested ? executionResult.error : undefined,
    );
  }

  if (!state.deps.deliverIsolatedAgentJobResult) {
    return await finish(
      executionResult,
      executionResult.delivered === true ? "ok" : "blocked",
      executionResult.delivered === true ? undefined : executionResult.error,
    );
  }

  try {
    const deliveryResult = await state.deps.deliverIsolatedAgentJobResult({
      job,
      runId: lease.runId,
      result: executionResult,
    });
    const deliverStatus =
      deliveryResult.delivered === true
        ? "ok"
        : deliveryResult.status === "error"
          ? "error"
          : "blocked";
    if (deliverStatus === "error") {
      const endedAt = state.deps.nowMs();
      const retry = await retryCronTaskRunQueueStep({
        storePath: state.deps.storePath,
        runId: lease.runId,
        stepId: deliveryStepId,
        nowMs: endedAt,
        error: deliveryResult.error ?? "Task delivery failed.",
        checkpoint: {
          ...lease.checkpoint,
          phase: checkpointPhase,
          delivered: deliveryResult.delivered,
          deliveryAttempted: deliveryResult.deliveryAttempted,
          status: deliveryResult.status,
          error: deliveryResult.error,
        },
      });
      if (retry === "retry") {
        state.deps.log.warn(
          { jobId: job.id, jobName: job.name, runId: lease.runId },
          `cron: delivery step failed, retry queued: ${deliveryResult.error ?? "delivery failed"}`,
        );
        return undefined;
      }
    }
    return await finish(
      {
        ...executionResult,
        ...deliveryResult,
      },
      deliverStatus,
      deliverStatus === "ok" ? undefined : deliveryResult.error,
    );
  } catch (err) {
    const errorText = isAbortError(err) ? timeoutErrorMessage() : String(err);
    const endedAt = state.deps.nowMs();
    if (!isAbortError(err)) {
      const retry = await retryCronTaskRunQueueStep({
        storePath: state.deps.storePath,
        runId: lease.runId,
        stepId: deliveryStepId,
        nowMs: endedAt,
        error: errorText,
        checkpoint: { ...lease.checkpoint, phase: checkpointPhase },
      });
      if (retry === "retry") {
        state.deps.log.warn(
          { jobId: job.id, jobName: job.name, runId: lease.runId },
          `cron: delivery step failed, retry queued: ${errorText}`,
        );
        return undefined;
      }
    }
    return await finish(
      {
        ...executionResult,
        status: "error",
        error: errorText,
        delivered: false,
        deliveryAttempted: true,
      },
      "error",
      errorText,
    );
  }
}

async function completeLeasedWorkerStepFromGraphCheckpoint(params: {
  state: CronServiceState;
  job: CronJob;
  lease: {
    runId: string;
    jobId: string;
    stepId?: string;
    trigger: "schedule" | "startup" | "manual";
    skipReason?: string;
    checkpoint?: Record<string, unknown>;
  };
}): Promise<boolean> {
  const graphExecution = await readGraphExecutionCheckpoint({
    state: params.state,
    job: params.job,
    runId: params.lease.runId,
  });
  if (!graphExecution) {
    return false;
  }
  await completeCronTaskRunQueueStep({
    storePath: params.state.deps.storePath,
    runId: params.lease.runId,
    stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
    nowMs: params.state.deps.nowMs(),
    status: "ok",
    checkpoint: {
      ...graphExecution.checkpoint,
      phase: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
      replayedFromGraphStepId: graphExecution.stepId,
      replayedFromGraphNodeId: graphExecution.graphNodeId,
      replayedFromGraphNodeKind: graphExecution.graphNodeKind,
    },
  });
  return true;
}

async function executeLeasedSynthesizeStep(params: {
  state: CronServiceState;
  job: CronJob;
  lease: {
    runId: string;
    jobId: string;
    stepId?: string;
    trigger: "schedule" | "startup" | "manual";
    skipReason?: string;
    checkpoint?: Record<string, unknown>;
  };
  startedAt: number;
}): Promise<TimedCronRunOutcome | undefined> {
  const { state, job, lease, startedAt } = params;
  const deliveryPlan = resolveCronDeliveryPlan(job);
  const workerCheckpoint =
    (await readQueueRunStepCheckpoint({
      state,
      runId: lease.runId,
      stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
    })) ??
    (await readQueueRunStepCheckpoint({
      state,
      runId: lease.runId,
      stepId: "execute",
    })) ??
    lease.checkpoint;
  const result = executionResultFromCheckpoint(workerCheckpoint);
  const executionStartedAt = numberFromCheckpoint(workerCheckpoint?.startedAtMs) ?? startedAt;
  const executionEndedAt = numberFromCheckpoint(workerCheckpoint?.endedAtMs);
  const endedAt = state.deps.nowMs();

  await completeCronTaskRunQueueStep({
    storePath: state.deps.storePath,
    runId: lease.runId,
    stepId: CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID,
    nowMs: endedAt,
    status: "ok",
    checkpoint: {
      ...workerCheckpoint,
      phase: CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID,
      startedAtMs: executionStartedAt,
      endedAtMs: executionEndedAt,
      workflowStep: plannedAnalyzeStep(job),
      workflowGraph: plannedWorkflowGraph(job),
      resultStatus: result.status,
      error: result.error,
      summary: result.summary,
      outputText: result.outputText,
      sessionId: result.sessionId,
      sessionKey: result.sessionKey,
      model: result.model,
      provider: result.provider,
      usage: result.usage,
      policy: result.policy,
      delivered: result.delivered,
      deliveryAttempted: result.deliveryAttempted,
    },
  });

  await completeLeasedQueuePhase({
    state,
    runId: lease.runId,
    stepId: "evaluate",
    status: "ok",
    checkpoint: {
      resultStatus: result.status,
      error: result.error,
      evaluator: result.policy?.evaluator?.action,
      planner: result.policy?.planner?.strategy,
      workflowStep: job.executionPolicy?.planner?.steps?.find((step) => step.id === "evaluate"),
    },
  });

  const deferDelivery = deliveryPlan.requested && Boolean(state.deps.deliverIsolatedAgentJobResult);
  if (deferDelivery) {
    return undefined;
  }

  await completeLeasedQueuePhase({
    state,
    runId: lease.runId,
    stepId: "deliver",
    status: !deliveryPlan.requested
      ? "skipped"
      : result.delivered === true
        ? "ok"
        : result.status === "error"
          ? "error"
          : "blocked",
    error: result.delivered === true || !deliveryPlan.requested ? undefined : result.error,
    checkpoint: {
      deliveryRequested: deliveryPlan.requested,
      deliveryChannel: deliveryPlan.channel,
      deliveryTarget: deliveryPlan.to,
      delivered: result.delivered,
      deliveryAttempted: result.deliveryAttempted,
    },
  });
  await finishCronTaskRunQueueItem({
    storePath: state.deps.storePath,
    runId: lease.runId,
    nowMs: endedAt,
    status: mapRunStatusToQueueStatus(result.status),
    error: result.error,
    result: {
      status: result.status,
      summary: result.summary,
      error: result.error,
      delivered: result.delivered,
      sessionId: result.sessionId,
      sessionKey: result.sessionKey,
      model: result.model,
      provider: result.provider,
      usage: result.usage,
    },
  });
  return {
    jobId: job.id,
    runId: lease.runId,
    ...result,
    startedAt: executionStartedAt,
    endedAt: executionEndedAt ?? endedAt,
  };
}

async function executeLeasedGraphNodeStep(params: {
  state: CronServiceState;
  job: CronJob;
  lease: {
    runId: string;
    jobId: string;
    stepId?: string;
    trigger: "schedule" | "startup" | "manual";
    skipReason?: string;
    checkpoint?: Record<string, unknown>;
  };
  startedAt: number;
}): Promise<TimedCronRunOutcome | undefined> {
  const { state, job, lease, startedAt } = params;
  const stepId = lease.stepId ?? "";
  const node = graphNodeForStepId(job, stepId);
  if (!node) {
    throw new Error(`Unknown task graph node step: ${stepId}`);
  }
  const workflowGraph = plannedWorkflowGraph(job);
  if (graphNodeRunsTaskCore(job, node)) {
    const deliveryPlan = resolveCronDeliveryPlan(job);
    const deferDelivery =
      deliveryPlan.requested && Boolean(state.deps.deliverIsolatedAgentJobResult);
    const graphContext = await readGraphDataContext({ state, runId: lease.runId });
    emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });
    const result = await executeJobCoreWithTimeout(state, job, {
      runId: lease.runId,
      deferDelivery,
      graphContext,
    });
    const endedAt = state.deps.nowMs();
    const graphResultCheckpoint = {
      ...lease.checkpoint,
      phase: "graph-node",
      graphNodeExecuted: true,
      graphNodeId: node.id,
      graphNodeKind: node.kind,
      graphNodeLabel: node.label,
      graphNodeDependsOn: node.dependsOn,
      graphNodeOptional: node.optional,
      graphNodeSourceRole: node.sourceRole,
      graphNodeSourcePriority: node.sourcePriority,
      graphNodeSourceFreshness: node.sourceFreshness,
      graphNodeSourceExpectedOutputType: node.sourceExpectedOutputType,
      graphNodeUsesModel: node.usesModel,
      graphNodeUsesTool: node.usesTool,
      workflowGraph,
      mappedQueueStep: graphNodeMappedQueueStep(node),
      graphContext: graphContextCheckpoint(graphContext),
      startedAtMs: startedAt,
      endedAtMs: endedAt,
      resultStatus: result.status,
      error: result.error,
      summary: result.summary,
      outputText: result.outputText,
      sessionId: result.sessionId,
      sessionKey: result.sessionKey,
      model: result.model,
      provider: result.provider,
      usage: result.usage,
      policy: result.policy,
      delivered: result.delivered,
      deliveryAttempted: result.deliveryAttempted,
    };
    if (result.status !== "ok") {
      const errorText =
        result.error ??
        result.summary ??
        `Task graph node ${node.label || node.id} finished with status ${result.status}.`;
      if (result.status === "error") {
        const retry = await retryCronTaskRunQueueStep({
          storePath: state.deps.storePath,
          runId: lease.runId,
          stepId,
          nowMs: endedAt,
          error: errorText,
          checkpoint: graphResultCheckpoint,
        });
        if (retry === "retry") {
          state.deps.log.warn(
            { jobId: job.id, jobName: job.name, runId: lease.runId, stepId },
            `cron: graph node failed, retry queued: ${errorText}`,
          );
          return undefined;
        }
      }
      const downstreamStatus =
        result.status === "blocked" || result.status === "skipped" ? result.status : "error";
      await completeCronTaskRunQueueStep({
        storePath: state.deps.storePath,
        runId: lease.runId,
        stepId,
        nowMs: endedAt,
        status: mapRunStatusToQueueStatus(result.status),
        error: errorText,
        checkpoint: graphResultCheckpoint,
      });
      await completeLeasedQueuePhase({
        state,
        runId: lease.runId,
        stepId: CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID,
        status: "skipped",
        error: errorText,
        checkpoint: { reason: errorText, sourceGraphStepId: stepId, sourceGraphNodeId: node.id },
      });
      await completeLeasedQueuePhase({
        state,
        runId: lease.runId,
        stepId: CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID,
        status: "skipped",
        error: errorText,
        checkpoint: { reason: errorText, sourceGraphStepId: stepId, sourceGraphNodeId: node.id },
      });
      await completeLeasedQueuePhase({
        state,
        runId: lease.runId,
        stepId: "evaluate",
        status: downstreamStatus,
        error: errorText,
        checkpoint: {
          reason: errorText,
          resultStatus: result.status,
          planner: result.policy?.planner?.strategy,
          sourceGraphStepId: stepId,
          sourceGraphNodeId: node.id,
        },
      });
      await completeLeasedQueuePhase({
        state,
        runId: lease.runId,
        stepId: "deliver",
        status: "skipped",
        error: errorText,
        checkpoint: {
          reason: errorText,
          deliveryRequested: deliveryPlan.requested,
          deliveryChannel: deliveryPlan.channel,
          deliveryTarget: deliveryPlan.to,
          sourceGraphStepId: stepId,
          sourceGraphNodeId: node.id,
        },
      });
      await finishCronTaskRunQueueItem({
        storePath: state.deps.storePath,
        runId: lease.runId,
        nowMs: endedAt,
        status: mapRunStatusToQueueStatus(result.status),
        error: errorText,
        result: {
          status: result.status,
          summary: result.summary,
          error: errorText,
          delivered: result.delivered,
          sessionId: result.sessionId,
          sessionKey: result.sessionKey,
          model: result.model,
          provider: result.provider,
          usage: result.usage,
        },
      });
      return {
        jobId: job.id,
        runId: lease.runId,
        ...result,
        error: errorText,
        startedAt,
        endedAt,
      };
    }
    await completeCronTaskRunQueueStep({
      storePath: state.deps.storePath,
      runId: lease.runId,
      stepId,
      nowMs: endedAt,
      status: "ok",
      checkpoint: graphResultCheckpoint,
    });
    const executionCheckpoint = await readGraphExecutionCheckpoint({
      state,
      job,
      runId: lease.runId,
    });
    if (executionCheckpoint) {
      await completeCompatibilityPlanAnalysisStep({ state, job, runId: lease.runId });
      await completeLeasedWorkerStepFromGraphCheckpoint({ state, job, lease });
      if (node.kind === "synthesize") {
        await completeCompatibilitySynthesizeStepFromCheckpoint({
          state,
          job,
          runId: lease.runId,
          checkpoint: executionCheckpoint.checkpoint,
          sourceGraphStepId: executionCheckpoint.stepId,
          sourceGraphNodeId: executionCheckpoint.graphNodeId,
        });
        await completeCompatibilityEvaluateStepFromCheckpoint({
          state,
          job,
          runId: lease.runId,
          checkpoint: executionCheckpoint.checkpoint,
          sourceGraphStepId: executionCheckpoint.stepId,
          sourceGraphNodeId: executionCheckpoint.graphNodeId,
        });
      }
    }
    return undefined;
  }
  const executionCheckpoint = await readGraphExecutionCheckpoint({
    state,
    job,
    runId: lease.runId,
  });
  if ((node.kind === "tool" || node.kind === "coordination") && state.deps.runGraphNodeHandler) {
    const graphContext = await readGraphDataContext({ state, runId: lease.runId });
    const runAbortController = new AbortController();
    state.activeRunAbortControllers.set(lease.runId, runAbortController);
    let result;
    try {
      result = await state.deps.runGraphNodeHandler({
        job,
        message: job.payload.kind === "agentTurn" ? job.payload.message : job.name,
        runId: lease.runId,
        nodeId: node.id,
        nodeKind: node.kind,
        graphContext,
        abortSignal: runAbortController.signal,
      });
    } finally {
      if (state.activeRunAbortControllers.get(lease.runId) === runAbortController) {
        state.activeRunAbortControllers.delete(lease.runId);
      }
    }
    const resultSourceQuality = isSourceFetchNodeId(node.id)
      ? scoreSourceQuality({
          nodeId: node.id,
          toolName: result.toolName,
          status: result.status,
          optional: node.optional,
          sourceRole: node.sourceRole,
          sourcePriority: node.sourcePriority,
          sourceFreshness: node.sourceFreshness,
        })
      : undefined;
    if ((result.status === "error" || result.status === "blocked") && node.optional === true) {
      const nowMs = state.deps.nowMs();
      await recordTrustedSourceGraphOutcome({
        state,
        node,
        nowMs,
        status: result.status,
        quality: resultSourceQuality,
        error: result.error,
      });
      await completeCronTaskRunQueueStep({
        storePath: state.deps.storePath,
        runId: lease.runId,
        stepId,
        nowMs,
        status: "skipped",
        error: result.error,
        checkpoint: {
          ...lease.checkpoint,
          phase: "graph-node",
          graphDataNodeExecuted: true,
          graphNodeId: node.id,
          graphNodeKind: node.kind,
          graphNodeLabel: node.label,
          graphNodeDependsOn: node.dependsOn,
          graphNodeOptional: node.optional,
          graphNodeSourceRole: node.sourceRole,
          graphNodeSourcePriority: node.sourcePriority,
          graphNodeSourceFreshness: node.sourceFreshness,
          graphNodeSourceExpectedOutputType: node.sourceExpectedOutputType,
          graphNodeUsesModel: node.usesModel,
          graphNodeUsesTool: node.usesTool,
          workflowGraph,
          mappedQueueStep: graphNodeMappedQueueStep(node),
          sourceGraphStepId: executionCheckpoint?.stepId,
          sourceGraphNodeId: executionCheckpoint?.graphNodeId,
          graphContext: graphContextCheckpoint(graphContext),
          optionalSourceFailed: true,
          startedAtMs: startedAt,
          endedAtMs: nowMs,
          resultStatus: result.status,
          error: result.error,
          summary: result.summary ?? result.error ?? `Optional source ${node.id} unavailable.`,
          outputText: result.outputText,
          toolName: result.toolName,
          toolInput: result.toolInput,
          sourceQualityScore: resultSourceQuality?.score,
          sourceQualityBand: resultSourceQuality?.band,
          sourceAuthority: resultSourceQuality?.authority,
          sourceQualityRationale: resultSourceQuality?.rationale,
          coordinationEvidence: result.coordinationEvidence,
        },
      });
      return undefined;
    }
    if (result.status === "error" || result.status === "blocked") {
      await recordTrustedSourceGraphOutcome({
        state,
        node,
        nowMs: state.deps.nowMs(),
        status: result.status,
        quality: resultSourceQuality,
        error: result.error,
      });
      throw new Error(result.error ?? result.summary ?? `Task graph node failed: ${node.id}`);
    }
    const nowMs = state.deps.nowMs();
    await recordTrustedSourceGraphOutcome({
      state,
      node,
      nowMs,
      status: result.status,
      quality: resultSourceQuality,
      error: result.error,
    });
    await completeCronTaskRunQueueStep({
      storePath: state.deps.storePath,
      runId: lease.runId,
      stepId,
      nowMs,
      status: result.status,
      checkpoint: {
        ...lease.checkpoint,
        phase: "graph-node",
        graphDataNodeExecuted: true,
        graphNodeId: node.id,
        graphNodeKind: node.kind,
        graphNodeLabel: node.label,
        graphNodeDependsOn: node.dependsOn,
        graphNodeOptional: node.optional,
        graphNodeSourceRole: node.sourceRole,
        graphNodeSourcePriority: node.sourcePriority,
        graphNodeSourceFreshness: node.sourceFreshness,
        graphNodeSourceExpectedOutputType: node.sourceExpectedOutputType,
        graphNodeUsesModel: node.usesModel,
        graphNodeUsesTool: node.usesTool,
        workflowGraph,
        mappedQueueStep: graphNodeMappedQueueStep(node),
        sourceGraphStepId: executionCheckpoint?.stepId,
        sourceGraphNodeId: executionCheckpoint?.graphNodeId,
        graphContext: graphContextCheckpoint(graphContext),
        startedAtMs: startedAt,
        endedAtMs: nowMs,
        resultStatus: result.status,
        error: result.error,
        summary: result.summary,
        outputText: result.outputText,
        toolName: result.toolName,
        toolInput: result.toolInput,
        sourceQualityScore: resultSourceQuality?.score,
        sourceQualityBand: resultSourceQuality?.band,
        sourceAuthority: resultSourceQuality?.authority,
        sourceQualityRationale: resultSourceQuality?.rationale,
        coordinationEvidence: result.coordinationEvidence,
      },
    });
    if (node.kind === "coordination" && result.coordinationEvidence) {
      job.state.lastCoordinationEvidence = result.coordinationEvidence;
      if (result.coordinationEvidence.some((entry) => entry.status === "completed")) {
        job.state.pendingCoordination = undefined;
      }
    }
    return undefined;
  }
  if (node.id === "source-merge") {
    const graphContext = await readGraphDataContext({ state, runId: lease.runId });
    const nowMs = state.deps.nowMs();
    const sourceMerge = buildSourceMergeCheckpoint({ context: graphContext, nowMs });
    await completeCronTaskRunQueueStep({
      storePath: state.deps.storePath,
      runId: lease.runId,
      stepId,
      nowMs,
      status: "ok",
      checkpoint: {
        ...lease.checkpoint,
        phase: "graph-node",
        graphDataNodeExecuted: true,
        graphSourceMergeExecuted: true,
        graphNodeId: node.id,
        graphNodeKind: node.kind,
        graphNodeLabel: node.label,
        graphNodeDependsOn: node.dependsOn,
        graphNodeOptional: node.optional,
        graphNodeSourceRole: node.sourceRole,
        graphNodeSourcePriority: node.sourcePriority,
        graphNodeSourceFreshness: node.sourceFreshness,
        graphNodeSourceExpectedOutputType: node.sourceExpectedOutputType,
        graphNodeUsesModel: node.usesModel,
        graphNodeUsesTool: node.usesTool,
        workflowGraph,
        mappedQueueStep: graphNodeMappedQueueStep(node),
        sourceGraphStepId: executionCheckpoint?.stepId,
        sourceGraphNodeId: executionCheckpoint?.graphNodeId,
        graphContext: graphContextCheckpoint(graphContext),
        startedAtMs: startedAt,
        endedAtMs: nowMs,
        resultStatus: "ok",
        summary: sourceMerge.summary,
        outputText: sourceMerge.outputText,
        sourceBundle: sourceMerge.sourceBundle,
      },
    });
    return undefined;
  }
  if (node.id === "source-verify") {
    const graphContext = await readGraphDataContext({ state, runId: lease.runId });
    const nowMs = state.deps.nowMs();
    const sourceVerify = buildSourceVerifyCheckpoint({ context: graphContext, nowMs });
    await completeCronTaskRunQueueStep({
      storePath: state.deps.storePath,
      runId: lease.runId,
      stepId,
      nowMs,
      status: "ok",
      checkpoint: {
        ...lease.checkpoint,
        phase: "graph-node",
        graphDataNodeExecuted: true,
        graphSourceVerifyExecuted: true,
        graphNodeId: node.id,
        graphNodeKind: node.kind,
        graphNodeLabel: node.label,
        graphNodeDependsOn: node.dependsOn,
        graphNodeOptional: node.optional,
        graphNodeSourceRole: node.sourceRole,
        graphNodeSourcePriority: node.sourcePriority,
        graphNodeSourceFreshness: node.sourceFreshness,
        graphNodeSourceExpectedOutputType: node.sourceExpectedOutputType,
        graphNodeUsesModel: node.usesModel,
        graphNodeUsesTool: node.usesTool,
        workflowGraph,
        mappedQueueStep: graphNodeMappedQueueStep(node),
        sourceGraphStepId: executionCheckpoint?.stepId,
        sourceGraphNodeId: executionCheckpoint?.graphNodeId,
        graphContext: graphContextCheckpoint(graphContext),
        startedAtMs: startedAt,
        endedAtMs: nowMs,
        resultStatus: "ok",
        summary: sourceVerify.summary,
        outputText: sourceVerify.outputText,
        verificationStatus: sourceVerify.verification.status,
        needsReview: sourceVerify.verification.needsReview,
        conflicts: sourceVerify.verification.conflicts,
        verification: sourceVerify.verification,
        evaluatorSignal:
          sourceVerify.verification.status === "conflict_suspected" ? "source_conflict" : undefined,
      },
    });
    return undefined;
  }
  if (node.kind === "deliver") {
    const deliverySource =
      (await readQueueRunStepCheckpoint({
        state,
        runId: lease.runId,
        stepId: CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID,
      })) ??
      executionCheckpoint?.checkpoint ??
      lease.checkpoint;
    return await executeLeasedDeliveryStep({
      state,
      job,
      lease,
      startedAt,
      deliveryStepId: stepId,
      checkpointPhase: "graph-node",
      graphCheckpoint: {
        ...deliverySource,
        phase: "graph-node",
        graphNodeId: node.id,
        graphNodeKind: node.kind,
        graphNodeLabel: node.label,
        graphNodeDependsOn: node.dependsOn,
        graphNodeOptional: node.optional,
        graphNodeSourceRole: node.sourceRole,
        graphNodeSourcePriority: node.sourcePriority,
        graphNodeSourceFreshness: node.sourceFreshness,
        graphNodeSourceExpectedOutputType: node.sourceExpectedOutputType,
        graphNodeUsesModel: node.usesModel,
        graphNodeUsesTool: node.usesTool,
        workflowGraph,
        mappedQueueStep: graphNodeMappedQueueStep(node),
        sourceGraphStepId: executionCheckpoint?.stepId,
        sourceGraphNodeId: executionCheckpoint?.graphNodeId,
      },
    });
  }
  const nowMs = state.deps.nowMs();
  const graphContext =
    node.kind === "validation" || node.kind === "synthesize"
      ? await readGraphDataContext({ state, runId: lease.runId })
      : [];
  const coordinationValidation =
    node.kind === "validation"
      ? buildCoordinationValidationCheckpoint({ context: graphContext, nowMs })
      : undefined;
  const synthesisSource =
    node.kind === "synthesize" && executionCheckpoint
      ? mergeCoordinationIntoSynthesis({
          checkpoint: executionCheckpoint.checkpoint,
          graphContext,
        })
      : executionCheckpoint?.checkpoint;
  const graphCheckpoint = {
    ...lease.checkpoint,
    phase: "graph-node",
    graphNodeId: node.id,
    graphNodeKind: node.kind,
    graphNodeLabel: node.label,
    graphNodeDependsOn: node.dependsOn,
    graphNodeOptional: node.optional,
    graphNodeSourceRole: node.sourceRole,
    graphNodeSourcePriority: node.sourcePriority,
    graphNodeSourceFreshness: node.sourceFreshness,
    graphNodeSourceExpectedOutputType: node.sourceExpectedOutputType,
    graphNodeUsesModel: node.usesModel,
    graphNodeUsesTool: node.usesTool,
    workflowGraph,
    mappedQueueStep: graphNodeMappedQueueStep(node),
    sourceGraphStepId: executionCheckpoint?.stepId,
    sourceGraphNodeId: executionCheckpoint?.graphNodeId,
    graphContext: graphContextCheckpoint(graphContext),
    resultStatus: coordinationValidation?.evaluator
      ? "ok"
      : executionCheckpoint?.checkpoint.resultStatus,
    error: executionCheckpoint?.checkpoint.error,
    summary:
      node.kind === "synthesize"
        ? synthesisSource?.summary
        : node.kind === "validation"
          ? coordinationValidation?.summary
          : undefined,
    outputText:
      node.kind === "synthesize"
        ? synthesisSource?.outputText
        : node.kind === "validation"
          ? coordinationValidation?.outputText
          : undefined,
    coordinationEvidence:
      coordinationValidation?.coordinationEvidence ?? synthesisSource?.coordinationEvidence,
    taskRoomEvidenceSummary:
      coordinationValidation?.taskRoomEvidenceSummary ?? synthesisSource?.taskRoomEvidenceSummary,
    evaluator: coordinationValidation?.evaluator,
    evaluatorSignal: coordinationValidation?.evaluatorSignal,
  };
  await completeCronTaskRunQueueStep({
    storePath: state.deps.storePath,
    runId: lease.runId,
    stepId,
    nowMs,
    status: "ok",
    checkpoint: graphCheckpoint,
  });
  if (executionCheckpoint && node.kind === "validation") {
    await completeCompatibilityPlanAnalysisStep({ state, job, runId: lease.runId });
    await completeLeasedWorkerStepFromGraphCheckpoint({ state, job, lease });
    if (!workflowGraph?.nodes.some((entry) => entry.kind === "synthesize")) {
      await completeCompatibilitySynthesizeStepFromCheckpoint({
        state,
        job,
        runId: lease.runId,
        checkpoint: executionCheckpoint.checkpoint,
        sourceGraphStepId: executionCheckpoint.stepId,
        sourceGraphNodeId: executionCheckpoint.graphNodeId,
      });
    }
    await completeCompatibilityEvaluateStepFromCheckpoint({
      state,
      job,
      runId: lease.runId,
      checkpoint: graphCheckpoint,
      sourceGraphStepId: stepId,
      sourceGraphNodeId: node.id,
    });
  }
  if (executionCheckpoint && node.kind === "synthesize") {
    await completeCompatibilitySynthesizeStepFromCheckpoint({
      state,
      job,
      runId: lease.runId,
      checkpoint: synthesisSource ?? executionCheckpoint.checkpoint,
      sourceGraphStepId: stepId,
      sourceGraphNodeId: node.id,
    });
  }
  return undefined;
}

async function executeLeasedQueueRun(
  state: CronServiceState,
  lease: {
    runId: string;
    jobId: string;
    stepId?: string;
    trigger: "schedule" | "startup" | "manual";
    skipReason?: string;
    checkpoint?: Record<string, unknown>;
  },
): Promise<TimedCronRunOutcome | undefined> {
  const prepared = await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const job = state.store?.jobs.find((entry) => entry.id === lease.jobId);
    if (!job || job.state.activeRun?.runId !== lease.runId) {
      return undefined;
    }
    return JSON.parse(JSON.stringify(job)) as CronJob;
  });
  if (!prepared) {
    return undefined;
  }

  const job = prepared;
  const startedAt = state.deps.nowMs();
  const workerStepId = lease.stepId ?? CRON_TASK_RUN_QUEUE_WORKER_STEP_ID;
  if (lease.skipReason) {
    emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });
    const endedAt = state.deps.nowMs();
    await completeLeasedQueuePhase({
      state,
      runId: lease.runId,
      stepId: "preflight",
      status: "skipped",
      error: lease.skipReason,
      checkpoint: { reason: lease.skipReason },
    });
    await completeLeasedQueuePhase({
      state,
      runId: lease.runId,
      stepId: "prepare-session",
      status: "skipped",
      error: lease.skipReason,
      checkpoint: { reason: lease.skipReason },
    });
    await completeCronTaskRunQueueStep({
      storePath: state.deps.storePath,
      runId: lease.runId,
      stepId: workerStepId,
      nowMs: endedAt,
      status: "skipped",
      error: lease.skipReason,
      checkpoint: { ...lease.checkpoint, phase: workerStepId, reason: lease.skipReason },
    });
    await completeLeasedQueuePhase({
      state,
      runId: lease.runId,
      stepId: CRON_TASK_RUN_QUEUE_COLLECT_STEP_ID,
      status: "skipped",
      error: lease.skipReason,
      checkpoint: { reason: lease.skipReason },
    });
    for (const node of job.executionPolicy?.planner?.graph?.nodes ?? []) {
      await completeCronTaskRunQueueStep({
        storePath: state.deps.storePath,
        runId: lease.runId,
        stepId: cronTaskRunQueueGraphStepId(node.id),
        nowMs: endedAt,
        status: "skipped",
        error: lease.skipReason,
        checkpoint: {
          phase: "graph-node",
          reason: lease.skipReason,
          graphNodeId: node.id,
          graphNodeKind: node.kind,
          graphNodeLabel: node.label,
        },
      });
    }
    await completeLeasedQueuePhase({
      state,
      runId: lease.runId,
      stepId: CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID,
      status: "skipped",
      error: lease.skipReason,
      checkpoint: { reason: lease.skipReason },
    });
    await completeLeasedQueuePhase({
      state,
      runId: lease.runId,
      stepId: CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID,
      status: "skipped",
      error: lease.skipReason,
      checkpoint: { reason: lease.skipReason },
    });
    await completeLeasedQueuePhase({
      state,
      runId: lease.runId,
      stepId: "evaluate",
      status: "skipped",
      error: lease.skipReason,
      checkpoint: { reason: lease.skipReason },
    });
    await completeLeasedQueuePhase({
      state,
      runId: lease.runId,
      stepId: "deliver",
      status: "skipped",
      error: lease.skipReason,
      checkpoint: { reason: lease.skipReason },
    });
    await finishCronTaskRunQueueItem({
      storePath: state.deps.storePath,
      runId: lease.runId,
      nowMs: endedAt,
      status: "skipped",
      error: lease.skipReason,
      result: { status: "skipped", error: lease.skipReason },
    });
    return {
      jobId: job.id,
      runId: lease.runId,
      status: "skipped",
      error: lease.skipReason,
      startedAt,
      endedAt,
    };
  }
  if (workerStepId === "deliver") {
    emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });
    return await executeLeasedDeliveryStep({ state, job, lease, startedAt });
  }

  try {
    const deliveryPlan = resolveCronDeliveryPlan(job);
    if (workerStepId.startsWith("graph:")) {
      return await executeLeasedGraphNodeStep({ state, job, lease, startedAt });
    }
    if (workerStepId === CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID) {
      return await executeLeasedSynthesizeStep({ state, job, lease, startedAt });
    }
    if (workerStepId === CRON_TASK_RUN_QUEUE_COLLECT_STEP_ID) {
      await completeLeasedQueuePhase({
        state,
        runId: lease.runId,
        stepId: "preflight",
        status: "ok",
        checkpoint: {
          jobId: job.id,
          trigger: lease.trigger,
          executionMode: job.executionPolicy?.executionMode,
        },
      });
      await completeLeasedQueuePhase({
        state,
        runId: lease.runId,
        stepId: "prepare-session",
        status: "ok",
        checkpoint: {
          agentId: job.agentId,
          sessionKey: job.sessionKey,
          sessionTarget: job.sessionTarget,
          deliveryRequested: deliveryPlan.requested,
          deliveryChannel: deliveryPlan.channel,
        },
      });
      await completeCronTaskRunQueueStep({
        storePath: state.deps.storePath,
        runId: lease.runId,
        stepId: CRON_TASK_RUN_QUEUE_COLLECT_STEP_ID,
        nowMs: state.deps.nowMs(),
        status: "ok",
        checkpoint: {
          phase: "collect",
          planner: job.executionPolicy?.planner?.strategy,
          workflowSteps: plannedWorkflowSteps(job),
          workflowGraph: plannedWorkflowGraph(job),
          executionMode: job.executionPolicy?.executionMode,
          memoryScope: job.executionPolicy?.memoryScope,
          skillScope: job.executionPolicy?.skillScope,
          allowedSkills: job.executionPolicy?.allowedSkills,
          skillAction: job.executionPolicy?.skillAction,
          deliveryRequested: deliveryPlan.requested,
          deliveryChannel: deliveryPlan.channel,
          deliveryTarget: deliveryPlan.to,
        },
      });
      return undefined;
    }
    if (workerStepId === CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID) {
      await completeCronTaskRunQueueStep({
        storePath: state.deps.storePath,
        runId: lease.runId,
        stepId: CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID,
        nowMs: state.deps.nowMs(),
        status: "ok",
        checkpoint: {
          phase: CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID,
          workflowStep: plannedAnalyzeStep(job),
          workflowGraph: plannedWorkflowGraph(job),
          executionMode: job.executionPolicy?.executionMode,
          memoryScope: job.executionPolicy?.memoryScope,
          skillScope: job.executionPolicy?.skillScope,
          allowedSkills: job.executionPolicy?.allowedSkills,
          skillAction: job.executionPolicy?.skillAction,
          modelPolicy: job.executionPolicy?.modelPolicy,
          budget: job.executionPolicy?.budget,
          evaluator: job.executionPolicy?.evaluator,
          pendingEscalation: job.state.pendingEscalation,
          deliveryRequested: deliveryPlan.requested,
          deliveryChannel: deliveryPlan.channel,
          deliveryTarget: deliveryPlan.to,
        },
      });
      return undefined;
    }
    if (
      workerStepId === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID &&
      (await completeLeasedWorkerStepFromGraphCheckpoint({ state, job, lease }))
    ) {
      return undefined;
    }
    const deferDelivery =
      deliveryPlan.requested && Boolean(state.deps.deliverIsolatedAgentJobResult);
    const resultPromise = executeJobCoreWithTimeout(state, job, {
      runId: lease.runId,
      deferDelivery,
    });
    emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });
    const result = await resultPromise;
    const endedAt = state.deps.nowMs();
    await completeCronTaskRunQueueStep({
      storePath: state.deps.storePath,
      runId: lease.runId,
      stepId: workerStepId,
      nowMs: endedAt,
      status: "ok",
      checkpoint: {
        ...lease.checkpoint,
        phase: workerStepId,
        startedAtMs: startedAt,
        endedAtMs: endedAt,
        resultStatus: result.status,
        error: result.error,
        summary: result.summary,
        outputText: result.outputText,
        sessionId: result.sessionId,
        sessionKey: result.sessionKey,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
        policy: result.policy,
        delivered: result.delivered,
        deliveryAttempted: result.deliveryAttempted,
      },
    });
    return undefined;
  } catch (err) {
    const abortFailure = isAbortError(err);
    const errorText = abortFailure ? timeoutErrorMessage() : String(err);
    const endedAt = state.deps.nowMs();
    if (!abortFailure) {
      const retry =
        workerStepId === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID
          ? await retryCronTaskRunQueueExecuteStep({
              storePath: state.deps.storePath,
              runId: lease.runId,
              nowMs: endedAt,
              error: errorText,
              checkpoint: { ...lease.checkpoint, phase: workerStepId },
            })
          : await retryCronTaskRunQueueStep({
              storePath: state.deps.storePath,
              runId: lease.runId,
              stepId: workerStepId,
              nowMs: endedAt,
              error: errorText,
              checkpoint: { ...lease.checkpoint, phase: workerStepId },
            });
      if (retry === "retry") {
        state.deps.log.warn(
          { jobId: job.id, jobName: job.name, runId: lease.runId },
          `cron: worker step failed, retry queued: ${errorText}`,
        );
        return undefined;
      }
    }
    if (workerStepId !== CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID) {
      await completeLeasedQueuePhase({
        state,
        runId: lease.runId,
        stepId: CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID,
        status: "skipped",
        error: errorText,
        checkpoint: { reason: errorText },
      });
    }
    await completeLeasedQueuePhase({
      state,
      runId: lease.runId,
      stepId: "evaluate",
      status: "error",
      error: errorText,
      checkpoint: { reason: errorText },
    });
    await completeLeasedQueuePhase({
      state,
      runId: lease.runId,
      stepId: "deliver",
      status: "skipped",
      error: errorText,
      checkpoint: { reason: errorText },
    });
    await finishCronTaskRunQueueItem({
      storePath: state.deps.storePath,
      runId: lease.runId,
      nowMs: endedAt,
      status: "error",
      error: errorText,
      result: { status: "error", error: errorText },
    });
    state.deps.log.warn(
      { jobId: job.id, jobName: job.name, runId: lease.runId },
      `cron: worker step failed: ${errorText}`,
    );
    return {
      jobId: job.id,
      runId: lease.runId,
      status: "error",
      error: errorText,
      startedAt,
      endedAt,
    };
  }
}

export async function processQueuedCronTaskRuns(
  state: CronServiceState,
  opts: { runIds?: ReadonlySet<string>; maxRuns: number; leaseOwner?: string },
): Promise<TimedCronRunOutcome[]> {
  const outcomes: TimedCronRunOutcome[] = [];
  const maxAttempts = Math.max(1, Math.floor(opts.maxRuns)) * 20;
  let attempts = 0;
  while (attempts < maxAttempts && outcomes.length < opts.maxRuns) {
    const leases = await leaseCronTaskRunQueueExecuteSteps({
      storePath: state.deps.storePath,
      nowMs: state.deps.nowMs(),
      leaseMs: resolveCronJobRunLeaseMs(undefined),
      leaseOwner: opts.leaseOwner ?? "local-worker",
      runIds: opts.runIds,
      maxRuns: Math.max(1, opts.maxRuns - outcomes.length),
    });
    if (leases.length === 0) {
      break;
    }
    attempts += leases.length;
    const concurrency = Math.min(resolveRunConcurrency(state), leases.length);
    const results: Array<TimedCronRunOutcome | undefined> = Array.from({ length: leases.length });
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= leases.length) {
          return;
        }
        const lease = leases[index];
        if (!lease) {
          return;
        }
        results[index] = await executeLeasedQueueRun(state, lease);
      }
    });
    await Promise.all(workers);
    for (const result of results) {
      if (result) {
        outcomes.push(result);
      }
    }
  }
  return outcomes;
}

export async function processAndApplyQueuedCronTaskRuns(
  state: CronServiceState,
  opts: { runIds?: ReadonlySet<string>; maxRuns: number; leaseOwner?: string },
): Promise<TimedCronRunOutcome[]> {
  const outcomes = await processQueuedCronTaskRuns(state, opts);
  if (outcomes.length === 0) {
    return outcomes;
  }

  const queue = await readCronTaskRunQueue({ storePath: state.deps.storePath });
  const canceledRunIds = new Set(
    queue.runs
      .filter((run) => run.status === "canceled" || run.cancelRequestedAtMs)
      .map((run) => run.runId),
  );

  await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    if (!state.store) {
      return;
    }

    for (const outcome of outcomes) {
      if (outcome.runId && canceledRunIds.has(outcome.runId)) {
        continue;
      }
      await applyOutcomeToStoredJob(state, outcome);
    }

    recomputeNextRunsForMaintenance(state);
    await persist(state);
  });

  return outcomes;
}

export async function onTimer(state: CronServiceState) {
  if (state.running) {
    // Re-arm the timer so the scheduler keeps ticking even when a job is
    // still executing.  Without this, a long-running job (e.g. an agentTurn
    // exceeding MAX_TIMER_DELAY_MS) causes the clamped 60 s timer to fire
    // while `running` is true.  The early return then leaves no timer set,
    // silently killing the scheduler until the next gateway restart.
    //
    // We use MAX_TIMER_DELAY_MS as a fixed re-check interval to avoid a
    // zero-delay hot-loop when past-due jobs are waiting for the current
    // execution to finish.
    // See: https://github.com/fased-ai/agent/issues/12025
    armRunningRecheckTimer(state);
    return;
  }
  state.running = true;
  // Keep a watchdog timer armed while a tick is executing. If execution hangs
  // (for example in a provider call), the scheduler still wakes to re-check.
  armRunningRecheckTimer(state);
  try {
    await recoverExpiredCronTaskRunQueueLeases({
      storePath: state.deps.storePath,
      nowMs: state.deps.nowMs(),
      reason: "Recovered expired task run queue lease.",
    });

    const queuedRunIds = await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      const due = findDueJobs(state);

      if (due.length === 0) {
        // Use maintenance-only recompute to avoid advancing past-due nextRunAtMs
        // values without execution. This prevents jobs from being silently skipped
        // when the timer wakes up but findDueJobs returns empty (see #13992).
        const changed = recomputeNextRunsForMaintenance(state);
        if (changed) {
          await persist(state);
        }
        return [];
      }

      const now = state.deps.nowMs();
      const runIds: string[] = [];
      for (const job of due) {
        const checkpoint = reserveCronJobRunLease(job, now, {
          trigger: "schedule",
          leaseMs: resolveCronJobRunLeaseMs(resolveCronJobTimeoutMs(job)),
        });
        job.state.lastError = undefined;
        const budgetSkip = reserveCronJobRunBudget(job, now);
        await enqueueCronTaskRunQueueItem({
          storePath: state.deps.storePath,
          job,
          runId: checkpoint.runId,
          trigger: checkpoint.trigger,
          nowMs: now,
          skipReason: budgetSkip,
        });
        runIds.push(checkpoint.runId);
      }
      await persist(state);

      return runIds;
    });

    if (queuedRunIds.length > 0) {
      await processAndApplyQueuedCronTaskRuns(state, {
        runIds: new Set(queuedRunIds),
        maxRuns: queuedRunIds.length,
      });
    }
    // Piggyback session reaper on timer tick (self-throttled to every 5 min).
    const storePaths = new Set<string>();
    if (state.deps.resolveSessionStorePath) {
      const defaultAgentId = state.deps.defaultAgentId ?? DEFAULT_AGENT_ID;
      if (state.store?.jobs?.length) {
        for (const job of state.store.jobs) {
          const agentId =
            typeof job.agentId === "string" && job.agentId.trim() ? job.agentId : defaultAgentId;
          storePaths.add(state.deps.resolveSessionStorePath(agentId));
        }
      } else {
        storePaths.add(state.deps.resolveSessionStorePath(defaultAgentId));
      }
    } else if (state.deps.sessionStorePath) {
      storePaths.add(state.deps.sessionStorePath);
    }

    if (storePaths.size > 0) {
      const nowMs = state.deps.nowMs();
      for (const storePath of storePaths) {
        try {
          await sweepCronRunSessions({
            cronConfig: state.deps.cronConfig,
            sessionStorePath: storePath,
            nowMs,
            log: state.deps.log,
          });
        } catch (err) {
          state.deps.log.warn({ err: String(err), storePath }, "cron: session reaper sweep failed");
        }
      }
    }
  } finally {
    state.running = false;
    armTimer(state);
  }
}

function findDueJobs(state: CronServiceState): CronJob[] {
  if (!state.store) {
    return [];
  }
  const now = state.deps.nowMs();
  return collectRunnableJobs(state, now);
}

function isRunnableJob(params: {
  job: CronJob;
  nowMs: number;
  skipJobIds?: ReadonlySet<string>;
  skipAtIfAlreadyRan?: boolean;
}): boolean {
  const { job, nowMs } = params;
  if (!job.state) {
    job.state = {};
  }
  if (!job.enabled) {
    return false;
  }
  if (params.skipJobIds?.has(job.id)) {
    return false;
  }
  if (hasActiveCronJobRun(job)) {
    return false;
  }
  if (params.skipAtIfAlreadyRan && job.schedule.kind === "at" && job.state.lastStatus) {
    // Any terminal status (ok, error, skipped) means the job already ran at least once.
    // Don't re-fire it on restart — applyJobResult disables one-shot jobs, but guard
    // here defensively (#13845).
    return false;
  }
  const next = job.state.nextRunAtMs;
  return hasScheduledNextRunAtMs(next) && nowMs >= next;
}

function collectRunnableJobs(
  state: CronServiceState,
  nowMs: number,
  opts?: { skipJobIds?: ReadonlySet<string>; skipAtIfAlreadyRan?: boolean },
): CronJob[] {
  if (!state.store) {
    return [];
  }
  return state.store.jobs.filter((job) =>
    isRunnableJob({
      job,
      nowMs,
      skipJobIds: opts?.skipJobIds,
      skipAtIfAlreadyRan: opts?.skipAtIfAlreadyRan,
    }),
  );
}

export async function runMissedJobs(
  state: CronServiceState,
  opts?: { skipJobIds?: ReadonlySet<string> },
) {
  const queuedRunIds = await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    if (!state.store) {
      return [] as string[];
    }
    const now = state.deps.nowMs();
    const skipJobIds = opts?.skipJobIds;
    const missed = collectRunnableJobs(state, now, { skipJobIds, skipAtIfAlreadyRan: true });
    if (missed.length === 0) {
      return [] as string[];
    }
    state.deps.log.info(
      { count: missed.length, jobIds: missed.map((j) => j.id) },
      "cron: running missed jobs after restart",
    );
    const runIds: string[] = [];
    for (const job of missed) {
      const checkpoint = reserveCronJobRunLease(job, now, {
        trigger: "startup",
        leaseMs: resolveCronJobRunLeaseMs(resolveCronJobTimeoutMs(job)),
      });
      job.state.lastError = undefined;
      const budgetSkip = reserveCronJobRunBudget(job, now);
      await enqueueCronTaskRunQueueItem({
        storePath: state.deps.storePath,
        job,
        runId: checkpoint.runId,
        trigger: checkpoint.trigger,
        nowMs: now,
        skipReason: budgetSkip,
      });
      runIds.push(checkpoint.runId);
    }
    await persist(state);
    return runIds;
  });

  if (queuedRunIds.length === 0) {
    return;
  }

  await processAndApplyQueuedCronTaskRuns(state, {
    runIds: new Set(queuedRunIds),
    maxRuns: queuedRunIds.length,
  });
}

export async function runDueJobs(state: CronServiceState) {
  if (!state.store) {
    return;
  }
  const now = state.deps.nowMs();
  const due = collectRunnableJobs(state, now);
  for (const job of due) {
    await executeJob(state, job, now, { forced: false });
  }
}

export async function executeJobCore(
  state: CronServiceState,
  job: CronJob,
  abortSignal?: AbortSignal,
  opts: { deferDelivery?: boolean; graphContext?: CronTaskGraphContextItem[] } = {},
): Promise<
  CronRunOutcome & CronRunTelemetry & { delivered?: boolean; deliveryAttempted?: boolean }
> {
  const resolveAbortError = () => ({
    status: "error" as const,
    error: formatAbortReason(abortSignal?.reason),
  });
  const waitWithAbort = async (ms: number) => {
    if (!abortSignal) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return;
    }
    if (abortSignal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  };

  if (abortSignal?.aborted) {
    return resolveAbortError();
  }
  if (job.sessionTarget === "main") {
    const text = resolveJobPayloadTextForMain(job);
    if (!text) {
      const kind = job.payload.kind;
      return {
        status: "skipped",
        error:
          kind === "systemEvent"
            ? "main job requires non-empty systemEvent text"
            : 'main job requires payload.kind="systemEvent"',
      };
    }
    state.deps.enqueueSystemEvent(text, {
      agentId: job.agentId,
      sessionKey: job.sessionKey,
      contextKey: `cron:${job.id}`,
    });
    if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
      const reason = `cron:${job.id}`;
      const maxWaitMs = state.deps.wakeNowHeartbeatBusyMaxWaitMs ?? 2 * 60_000;
      const retryDelayMs = state.deps.wakeNowHeartbeatBusyRetryDelayMs ?? 250;
      const waitStartedAt = state.deps.nowMs();

      let heartbeatResult: HeartbeatRunResult;
      for (;;) {
        if (abortSignal?.aborted) {
          return resolveAbortError();
        }
        heartbeatResult = await state.deps.runHeartbeatOnce({
          reason,
          agentId: job.agentId,
          sessionKey: job.sessionKey,
        });
        if (
          heartbeatResult.status !== "skipped" ||
          heartbeatResult.reason !== "requests-in-flight"
        ) {
          break;
        }
        if (abortSignal?.aborted) {
          return resolveAbortError();
        }
        if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
          if (abortSignal?.aborted) {
            return resolveAbortError();
          }
          state.deps.requestHeartbeatNow({
            reason,
            agentId: job.agentId,
            sessionKey: job.sessionKey,
          });
          return { status: "ok", summary: text };
        }
        await waitWithAbort(retryDelayMs);
      }

      if (heartbeatResult.status === "ran") {
        return { status: "ok", summary: text };
      } else if (heartbeatResult.status === "skipped") {
        return { status: "skipped", error: heartbeatResult.reason, summary: text };
      } else {
        return { status: "error", error: heartbeatResult.reason, summary: text };
      }
    } else {
      if (abortSignal?.aborted) {
        return resolveAbortError();
      }
      state.deps.requestHeartbeatNow({
        reason: `cron:${job.id}`,
        agentId: job.agentId,
        sessionKey: job.sessionKey,
      });
      return { status: "ok", summary: text };
    }
  }

  if (job.payload.kind !== "agentTurn") {
    return { status: "skipped", error: "isolated job requires payload.kind=agentTurn" };
  }
  if (abortSignal?.aborted) {
    return resolveAbortError();
  }

  const res = await state.deps.runIsolatedAgentJob({
    job,
    message: job.payload.message,
    abortSignal,
    deferDelivery: opts.deferDelivery,
    graphContext: opts.graphContext,
  });

  if (abortSignal?.aborted) {
    return { status: "error", error: formatAbortReason(abortSignal.reason) };
  }

  // Post a short summary back to the main session only when announce
  // delivery was requested and we are confident no outbound delivery path
  // ran. If delivery was attempted but final ack is uncertain, suppress the
  // main summary to avoid duplicate user-facing sends.
  // See: https://github.com/fased-ai/agent/issues/15692
  const summaryText = res.summary?.trim();
  const deliveryPlan = resolveCronDeliveryPlan(job);
  const suppressMainSummary =
    res.status === "error" && res.errorKind === "delivery-target" && deliveryPlan.requested;
  if (
    summaryText &&
    deliveryPlan.requested &&
    opts.deferDelivery !== true &&
    !res.delivered &&
    res.deliveryAttempted !== true &&
    !suppressMainSummary
  ) {
    const prefix = "Cron";
    const label =
      res.status === "error" ? `${prefix} (error): ${summaryText}` : `${prefix}: ${summaryText}`;
    state.deps.enqueueSystemEvent(label, {
      agentId: job.agentId,
      sessionKey: job.sessionKey,
      contextKey: `cron:${job.id}`,
    });
    if (job.wakeMode === "now") {
      state.deps.requestHeartbeatNow({
        reason: `cron:${job.id}`,
        agentId: job.agentId,
        sessionKey: job.sessionKey,
      });
    }
  }

  return {
    status: res.status,
    error: res.error,
    summary: res.summary,
    outputText: res.outputText,
    delivered: res.delivered,
    deliveryAttempted: res.deliveryAttempted,
    sessionId: res.sessionId,
    sessionKey: res.sessionKey,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
    policy: res.policy,
  };
}

/**
 * Execute a job. This version is used by the `run` command and other
 * places that need the full execution with state updates.
 */
export async function executeJob(
  state: CronServiceState,
  job: CronJob,
  _nowMs: number,
  _opts: { forced: boolean },
) {
  if (!job.state) {
    job.state = {};
  }
  const startedAt = state.deps.nowMs();
  const checkpoint = reserveCronJobRunLease(job, startedAt, {
    trigger: "schedule",
    leaseMs: resolveCronJobRunLeaseMs(resolveCronJobTimeoutMs(job)),
  });
  await enqueueCronTaskRunQueueItem({
    storePath: state.deps.storePath,
    job,
    runId: checkpoint.runId,
    trigger: checkpoint.trigger,
    nowMs: startedAt,
    skipReason: reserveCronJobRunBudget(job, startedAt),
  });
  job.state.lastError = undefined;
  await persist(state);

  const results = await processQueuedCronTaskRuns(state, {
    runIds: new Set([checkpoint.runId]),
    maxRuns: 1,
  });
  const coreResult = results.find((result) => result.jobId === job.id);
  if (!coreResult) {
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

  await emitJobFinished(state, job, withEvaluatorPolicy(job, coreResult), startedAt);

  if (shouldDelete && state.store) {
    state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
    emit(state, { jobId: job.id, action: "removed" });
  }
}

async function emitJobFinished(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: CronRunStatus;
    delivered?: boolean;
  } & CronRunOutcome &
    CronRunTelemetry,
  runAtMs: number,
) {
  const status = job.state.lastRunStatus ?? result.status;
  const accessReason = job.state.needsAccess?.reason;
  const error =
    status === "blocked" ? (accessReason ?? job.state.lastError ?? result.error) : result.error;
  const summary =
    status === "blocked" ? `Blocked: ${accessReason ?? error ?? "needs access"}` : result.summary;
  const event: CronEvent = {
    jobId: job.id,
    action: "finished",
    status,
    error,
    summary,
    delivered: result.delivered,
    deliveryStatus: job.state.lastDeliveryStatus,
    deliveryError: job.state.lastDeliveryError,
    sessionId: result.sessionId,
    sessionKey: result.sessionKey,
    runAtMs,
    durationMs: job.state.lastDurationMs,
    nextRunAtMs: job.state.nextRunAtMs,
    model: result.model,
    provider: result.provider,
    usage: result.usage,
    policy: result.policy,
  };
  emit(state, event);
  const runLogPath = resolveCronRunLogPath({ storePath: state.deps.storePath, jobId: job.id });
  const prune = resolveCronRunLogPruneOptions(state.deps.cronConfig?.runLog);
  const logEntry: CronRunLogEntry = { ts: state.deps.nowMs(), ...event, action: "finished" };
  await appendCronRunLog(runLogPath, logEntry, prune).catch((err) => {
    state.deps.log.warn({ err, jobId: job.id }, "failed to append cron run log");
  });
}

export function wake(
  state: CronServiceState,
  opts: { mode: "now" | "next-heartbeat"; text: string },
) {
  const text = opts.text.trim();
  if (!text) {
    return { ok: false } as const;
  }
  state.deps.enqueueSystemEvent(text);
  if (opts.mode === "now") {
    state.deps.requestHeartbeatNow({ reason: "wake" });
  }
  return { ok: true } as const;
}

export function stopTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
}

export function emit(state: CronServiceState, evt: CronEvent) {
  try {
    state.deps.onEvent?.(evt);
  } catch {
    /* ignore */
  }
}
