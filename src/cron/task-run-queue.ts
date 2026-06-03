import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../infra/file-lock.js";
import type {
  CronJob,
  CronRunStatus,
  CronTaskGraphRepairReplay,
  CronTaskRunCheckpointTrigger,
  CronTaskWorkflowGraph,
  CronTaskWorkflowGraphNodeKind,
  CronUsageSummary,
} from "./types.js";

export type CronTaskRunQueueStatus =
  | "queued"
  | "running"
  | "ok"
  | "error"
  | "skipped"
  | "blocked"
  | "canceled"
  | "recovered";

export type CronTaskRunQueueStepStatus =
  | "queued"
  | "running"
  | "ok"
  | "error"
  | "skipped"
  | "blocked"
  | "canceled"
  | "recovered";

export type CronTaskRunQueueStepRetryPolicy = {
  maxAttempts: number;
  retryDelayMs: number;
  backoffMultiplier: number;
  retryOn: "error" | "lease-expired" | "error-or-lease-expired";
};

export type CronTaskRunQueueStepResumeState = {
  resumable: boolean;
  reason: string;
  checkpointKeys: string[];
  updatedAtMs: number;
};

export type CronTaskRunQueueStep = {
  id: string;
  kind?: "phase" | "graph-node";
  graphNodeId?: string;
  graphNodeKind?: CronTaskWorkflowGraphNodeKind;
  graphNodeLabel?: string;
  graphNodeDependsOn?: string[];
  graphNodeOptional?: boolean;
  graphNodeSourceRole?: string;
  graphNodeSourcePriority?: number;
  graphNodeSourceFreshness?: string;
  graphNodeSourceExpectedOutputType?: string;
  graphNodeTrustedSourceId?: string;
  status: CronTaskRunQueueStepStatus;
  attempt: number;
  maxAttempts: number;
  retryPolicy?: CronTaskRunQueueStepRetryPolicy;
  nextRetryAtMs?: number;
  resume?: CronTaskRunQueueStepResumeState;
  createdAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  leaseOwner?: string;
  leaseExpiresAtMs?: number;
  checkpoint?: Record<string, unknown>;
  error?: string;
};

export type CronTaskRunQueueItem = {
  runId: string;
  jobId: string;
  jobName: string;
  agentId?: string;
  sessionKey?: string;
  trigger: CronTaskRunCheckpointTrigger;
  status: CronTaskRunQueueStatus;
  createdAtMs: number;
  updatedAtMs: number;
  queuedAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  cancelRequestedAtMs?: number;
  recoveredAtMs?: number;
  error?: string;
  skipReason?: string;
  graphRevision?: number;
  parentRevision?: number;
  repairRevision?: number;
  repairReplay?: CronTaskGraphRepairReplay;
  result?: {
    status: CronRunStatus;
    summary?: string;
    error?: string;
    delivered?: boolean;
    sessionId?: string;
    sessionKey?: string;
    model?: string;
    provider?: string;
    usage?: CronUsageSummary;
  };
  steps: CronTaskRunQueueStep[];
};

export type CronTaskRunQueueStore = {
  version: 1;
  runs: CronTaskRunQueueItem[];
};

export type CronTaskRunQueueWorkerSummary = {
  workerId: string;
  running: number;
  expired: number;
  runIds: string[];
  nextLeaseExpiresAtMs?: number;
  lastLeaseAtMs?: number;
};

export type CronTaskRunQueueActiveRunSummary = {
  runId: string;
  jobId: string;
  jobName: string;
  agentId?: string;
  sessionKey?: string;
  status: CronTaskRunQueueStatus;
  stepId: string;
  attempt: number;
  maxAttempts: number;
  retryPolicy?: CronTaskRunQueueStepRetryPolicy;
  nextRetryAtMs?: number;
  resume?: CronTaskRunQueueStepResumeState;
  leaseOwner?: string;
  leaseExpiresAtMs?: number;
  leaseExpired: boolean;
  queuedAtMs: number;
  startedAtMs?: number;
  updatedAtMs: number;
};

export type CronTaskRunQueueRecentRunSummary = {
  runId: string;
  jobId: string;
  jobName: string;
  agentId?: string;
  sessionKey?: string;
  status: CronTaskRunQueueStatus;
  error?: string;
  resultStatus?: CronRunStatus;
  queuedAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  updatedAtMs: number;
};

export type CronTaskRunQueueSummary = {
  path: string;
  total: number;
  queued: number;
  running: number;
  terminal: number;
  cancelRequested: number;
  expiredLeases: number;
  byStatus: Record<CronTaskRunQueueStatus, number>;
  workers: CronTaskRunQueueWorkerSummary[];
  activeRuns: CronTaskRunQueueActiveRunSummary[];
  recentRuns: CronTaskRunQueueRecentRunSummary[];
};

export type CronTaskRunQueueControlResult =
  | { ok: true; run: CronTaskRunQueueItem; message: string }
  | { ok: false; reason: string; run?: CronTaskRunQueueItem };

const QUEUE_DIR = "task-runs";
const QUEUE_FILE = "queue.json";
const DEFAULT_STEP_MAX_ATTEMPTS = 1;
const DEFAULT_EXECUTE_STEP_MAX_ATTEMPTS = 3;
const DEFAULT_EXECUTE_STEP_RETRY_DELAY_MS = 1_000;
const MAX_STEP_RETRY_DELAY_MS = 5 * 60_000;
export const CRON_TASK_RUN_QUEUE_WORKER_STEP_ID = "run-tool-or-model";
export const CRON_TASK_RUN_QUEUE_COLLECT_STEP_ID = "collect";
export const CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID = "plan-analysis";
export const CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID = "synthesize";
export const CRON_TASK_RUN_QUEUE_GRAPH_STEP_PREFIX = "graph:";
const LEGACY_WORKER_STEP_ID = "execute";
const PHASE_STEP_IDS = [
  "reserve",
  "preflight",
  "prepare-session",
  CRON_TASK_RUN_QUEUE_COLLECT_STEP_ID,
  CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID,
  CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
  CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID,
  "evaluate",
  "deliver",
  "finalize",
] as const;
const RESETTABLE_PHASE_STEP_IDS = PHASE_STEP_IDS.filter((stepId) => stepId !== "reserve");
const TERMINAL_STATUSES = new Set<CronTaskRunQueueStatus>([
  "ok",
  "error",
  "skipped",
  "blocked",
  "canceled",
  "recovered",
]);
const QUEUE_STATUSES: CronTaskRunQueueStatus[] = [
  "queued",
  "running",
  "ok",
  "error",
  "skipped",
  "blocked",
  "canceled",
  "recovered",
];
const QUEUE_FILE_LOCK_OPTIONS = {
  retries: {
    retries: 80,
    factor: 1.15,
    minTimeout: 10,
    maxTimeout: 100,
    randomize: true,
  },
  stale: 60_000,
};

const queueLocks = new Map<string, Promise<unknown>>();

export function resolveCronTaskRunQueuePath(params: { storePath: string }) {
  const storePath = path.resolve(params.storePath);
  return path.join(path.dirname(storePath), QUEUE_DIR, QUEUE_FILE);
}

function defaultRetryPolicyForStepId(stepId: string): CronTaskRunQueueStepRetryPolicy {
  if (stepId.startsWith(CRON_TASK_RUN_QUEUE_GRAPH_STEP_PREFIX)) {
    return {
      maxAttempts: 3,
      retryDelayMs: DEFAULT_EXECUTE_STEP_RETRY_DELAY_MS,
      backoffMultiplier: 2,
      retryOn: "error-or-lease-expired",
    };
  }
  if (stepId === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID || stepId === LEGACY_WORKER_STEP_ID) {
    return {
      maxAttempts: DEFAULT_EXECUTE_STEP_MAX_ATTEMPTS,
      retryDelayMs: DEFAULT_EXECUTE_STEP_RETRY_DELAY_MS,
      backoffMultiplier: 2,
      retryOn: "error-or-lease-expired",
    };
  }
  if (
    stepId === "deliver" ||
    stepId === CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID ||
    stepId === CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID
  ) {
    return {
      maxAttempts: 3,
      retryDelayMs: DEFAULT_EXECUTE_STEP_RETRY_DELAY_MS,
      backoffMultiplier: 2,
      retryOn: "error-or-lease-expired",
    };
  }
  if (stepId === CRON_TASK_RUN_QUEUE_COLLECT_STEP_ID) {
    return {
      maxAttempts: 3,
      retryDelayMs: DEFAULT_EXECUTE_STEP_RETRY_DELAY_MS,
      backoffMultiplier: 2,
      retryOn: "error-or-lease-expired",
    };
  }
  return {
    maxAttempts: DEFAULT_STEP_MAX_ATTEMPTS,
    retryDelayMs: 0,
    backoffMultiplier: 1,
    retryOn: "error",
  };
}

export function cronTaskRunQueueGraphStepId(nodeId: string) {
  return `${CRON_TASK_RUN_QUEUE_GRAPH_STEP_PREFIX}${nodeId.trim()}`;
}

export function cronTaskRunQueueGraphNodeIdFromStepId(stepId: string) {
  return stepId.startsWith(CRON_TASK_RUN_QUEUE_GRAPH_STEP_PREFIX)
    ? stepId.slice(CRON_TASK_RUN_QUEUE_GRAPH_STEP_PREFIX.length)
    : undefined;
}

function checkpointKeys(checkpoint?: Record<string, unknown>) {
  return checkpoint ? Object.keys(checkpoint).filter((key) => key.trim()) : [];
}

function resumeStateForStep(
  step: Pick<CronTaskRunQueueStep, "checkpoint" | "id">,
  nowMs: number,
  reason?: string,
): CronTaskRunQueueStepResumeState {
  const keys = checkpointKeys(step.checkpoint);
  return {
    resumable: keys.length > 0,
    reason:
      reason ??
      (keys.length > 0
        ? "Checkpoint data is available for the next worker lease."
        : "No checkpoint data has been recorded for this step."),
    checkpointKeys: keys,
    updatedAtMs: nowMs,
  };
}

function normalizeStepPolicy(
  step: CronTaskRunQueueStep,
  stepId = step.id,
): CronTaskRunQueueStepRetryPolicy {
  const fallback = defaultRetryPolicyForStepId(stepId);
  const maxAttempts =
    Number.isFinite(step.retryPolicy?.maxAttempts) && (step.retryPolicy?.maxAttempts ?? 0) > 0
      ? Math.floor(step.retryPolicy?.maxAttempts ?? fallback.maxAttempts)
      : Number.isFinite(step.maxAttempts) && step.maxAttempts > 0
        ? Math.floor(step.maxAttempts)
        : fallback.maxAttempts;
  const retryDelayMs =
    Number.isFinite(step.retryPolicy?.retryDelayMs) && (step.retryPolicy?.retryDelayMs ?? 0) >= 0
      ? Math.floor(step.retryPolicy?.retryDelayMs ?? fallback.retryDelayMs)
      : fallback.retryDelayMs;
  const backoffMultiplier =
    Number.isFinite(step.retryPolicy?.backoffMultiplier) &&
    (step.retryPolicy?.backoffMultiplier ?? 0) >= 1
      ? (step.retryPolicy?.backoffMultiplier ?? fallback.backoffMultiplier)
      : fallback.backoffMultiplier;
  const retryOn = step.retryPolicy?.retryOn ?? fallback.retryOn;
  const policy = { maxAttempts, retryDelayMs, backoffMultiplier, retryOn };
  step.retryPolicy = policy;
  step.maxAttempts = maxAttempts;
  return policy;
}

function stepRetryDelayMs(step: CronTaskRunQueueStep) {
  const policy = normalizeStepPolicy(step);
  const base = Math.max(0, Math.floor(policy.retryDelayMs));
  if (base <= 0 || step.attempt <= 1) {
    return 0;
  }
  const attemptIndex = Math.max(0, step.attempt - 2);
  const multiplier = Math.max(1, policy.backoffMultiplier);
  return Math.min(MAX_STEP_RETRY_DELAY_MS, Math.round(base * multiplier ** attemptIndex));
}

function stepCanRetryAfterError(step: CronTaskRunQueueStep, nowMs: number) {
  const policy = normalizeStepPolicy(step);
  const retryAllowed = policy.retryOn === "error" || policy.retryOn === "error-or-lease-expired";
  if (!retryAllowed || step.status !== "error" || step.attempt >= policy.maxAttempts) {
    return false;
  }
  return typeof step.nextRetryAtMs !== "number" || step.nextRetryAtMs <= nowMs;
}

function stepCanResumeExpiredLease(step: CronTaskRunQueueStep, nowMs: number) {
  const policy = normalizeStepPolicy(step);
  const retryAllowed =
    policy.retryOn === "lease-expired" || policy.retryOn === "error-or-lease-expired";
  return (
    retryAllowed &&
    step.status === "running" &&
    (step.leaseExpiresAtMs ?? Infinity) <= nowMs &&
    step.attempt < policy.maxAttempts
  );
}

function defaultPhaseStep(stepId: (typeof PHASE_STEP_IDS)[number], nowMs: number) {
  const retryPolicy = defaultRetryPolicyForStepId(stepId);
  const isReserve = stepId === "reserve";
  const isNonResumable = isReserve || stepId === "finalize";
  return {
    id: stepId,
    kind: "phase",
    status: isReserve ? "ok" : "queued",
    attempt: isReserve ? 1 : 0,
    maxAttempts: retryPolicy.maxAttempts,
    retryPolicy,
    createdAtMs: nowMs,
    ...(isReserve ? { startedAtMs: nowMs, completedAtMs: nowMs } : {}),
    resume: resumeStateForStep(
      { id: stepId },
      nowMs,
      isNonResumable ? `${stepId} step does not resume.` : undefined,
    ),
  } satisfies CronTaskRunQueueStep;
}

function defaultGraphNodeSteps(job: CronJob, nowMs: number): CronTaskRunQueueStep[] {
  const nodes = job.executionPolicy?.planner?.graph?.nodes ?? [];
  return nodes.map((node) => {
    const stepId = cronTaskRunQueueGraphStepId(node.id);
    const retryPolicy = defaultRetryPolicyForStepId(stepId);
    return {
      id: stepId,
      kind: "graph-node",
      graphNodeId: node.id,
      graphNodeKind: node.kind,
      graphNodeLabel: node.label,
      graphNodeDependsOn: node.dependsOn ? [...node.dependsOn] : undefined,
      graphNodeOptional: node.optional,
      graphNodeSourceRole: node.sourceRole,
      graphNodeSourcePriority: node.sourcePriority,
      graphNodeSourceFreshness: node.sourceFreshness,
      graphNodeSourceExpectedOutputType: node.sourceExpectedOutputType,
      graphNodeTrustedSourceId: node.trustedSourceId,
      status: "queued",
      attempt: 0,
      maxAttempts: retryPolicy.maxAttempts,
      retryPolicy,
      createdAtMs: nowMs,
      checkpoint: {
        phase: "graph-node",
        graphNodeId: node.id,
        graphNodeKind: node.kind,
        graphNodeLabel: node.label,
        graphNodeOptional: node.optional,
        graphNodeSourceRole: node.sourceRole,
        graphNodeSourcePriority: node.sourcePriority,
        graphNodeSourceFreshness: node.sourceFreshness,
        graphNodeSourceExpectedOutputType: node.sourceExpectedOutputType,
        graphNodeTrustedSourceId: node.trustedSourceId,
      },
      resume: resumeStateForStep(
        {
          id: stepId,
          checkpoint: {
            graphNodeId: node.id,
            graphNodeKind: node.kind,
            graphNodeLabel: node.label,
          },
        },
        nowMs,
        "Graph node step is waiting for dependencies.",
      ),
    } satisfies CronTaskRunQueueStep;
  });
}

function defaultSteps(job: CronJob, nowMs: number): CronTaskRunQueueStep[] {
  const phaseSteps = PHASE_STEP_IDS.map((stepId) => defaultPhaseStep(stepId, nowMs));
  const graphSteps = defaultGraphNodeSteps(job, nowMs);
  if (graphSteps.length === 0) {
    return phaseSteps;
  }
  const collectIndex = phaseSteps.findIndex(
    (step) => step.id === CRON_TASK_RUN_QUEUE_COLLECT_STEP_ID,
  );
  if (collectIndex < 0) {
    return [...graphSteps, ...phaseSteps];
  }
  return [
    ...phaseSteps.slice(0, collectIndex + 1),
    ...graphSteps,
    ...phaseSteps.slice(collectIndex + 1),
  ];
}

function positiveInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function graphRevision(graph: CronTaskWorkflowGraph | undefined, fallback = 1) {
  return positiveInteger(graph?.graphRevision, fallback);
}

function graphNodeDescendantsInclusive(graph: CronTaskWorkflowGraph, seedNodeIds: string[]) {
  const affected = new Set(seedNodeIds.filter(Boolean));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (affected.has(node.id)) {
        continue;
      }
      if ((node.dependsOn ?? []).some((dependency) => affected.has(dependency))) {
        affected.add(node.id);
        changed = true;
      }
    }
  }
  return affected;
}

function previousRunForRepairReplay(
  store: CronTaskRunQueueStore,
  job: CronJob,
): CronTaskRunQueueItem | undefined {
  const parentRunId =
    job.state.lastRunCheckpoint?.runId ?? job.state.lastGraphRepairReplay?.parentRunId;
  if (!parentRunId) {
    return undefined;
  }
  return store.runs.find((run) => run.runId === parentRunId);
}

function applyRepairReplayToSteps(params: {
  steps: CronTaskRunQueueStep[];
  job: CronJob;
  previousRun: CronTaskRunQueueItem;
  runId: string;
  nowMs: number;
}): CronTaskGraphRepairReplay | undefined {
  const graph = params.job.executionPolicy?.planner?.graph;
  const repairs = (params.job.state.lastGraphRepairs ?? []).filter((repair) => repair.applied);
  if (!graph || repairs.length === 0) {
    return undefined;
  }

  const repairNodeIds = repairs.map((repair) => repair.nodeId).filter(Boolean);
  if (repairNodeIds.length === 0) {
    return undefined;
  }
  const invalidated = graphNodeDescendantsInclusive(graph, repairNodeIds);
  const reusedNodeIds: string[] = [];
  const invalidatedNodeIds: string[] = [];
  const requeuedNodeIds: string[] = [];
  const previousGraphSteps = new Map(
    params.previousRun.steps
      .filter((step) => step.graphNodeId && (step.status === "ok" || step.status === "skipped"))
      .map((step) => [step.graphNodeId as string, step]),
  );
  const currentGraphRevision = graphRevision(graph);
  const parentRevision = positiveInteger(
    graph.parentRevision,
    Math.max(1, currentGraphRevision - 1),
  );
  const repairRevision = positiveInteger(
    graph.repairRevision,
    positiveInteger(params.job.state.repairRevision, 1),
  );

  for (const step of params.steps) {
    if (!step.graphNodeId) {
      continue;
    }
    if (!invalidated.has(step.graphNodeId)) {
      const previous = previousGraphSteps.get(step.graphNodeId);
      if (!previous?.checkpoint) {
        continue;
      }
      reusedNodeIds.push(step.graphNodeId);
      step.status = previous.status;
      step.attempt = 0;
      step.startedAtMs = params.nowMs;
      step.completedAtMs = params.nowMs;
      step.checkpoint = {
        ...previous.checkpoint,
        reusedFromRunId: params.previousRun.runId,
        reusedAtMs: params.nowMs,
        graphRevision: currentGraphRevision,
        parentRevision,
        repairRevision,
      };
      step.resume = resumeStateForStep(
        step,
        params.nowMs,
        "Checkpoint reused from the parent run because this graph node was not affected by repair.",
      );
      continue;
    }
    invalidatedNodeIds.push(step.graphNodeId);
    requeuedNodeIds.push(step.graphNodeId);
    step.checkpoint = {
      ...step.checkpoint,
      invalidatedByRepair: true,
      invalidatedFromRunId: params.previousRun.runId,
      graphRevision: currentGraphRevision,
      parentRevision,
      repairRevision,
      repairNode: repairNodeIds.includes(step.graphNodeId) ? true : undefined,
    };
    step.resume = resumeStateForStep(
      step,
      params.nowMs,
      "Checkpoint invalidated by graph repair; this node will run again.",
    );
  }

  return {
    runId: params.runId,
    parentRunId: params.previousRun.runId,
    graphRevision: currentGraphRevision,
    parentRevision,
    repairRevision,
    repairAttempt: positiveInteger(params.job.state.graphRepairAttempts, 1),
    maxRepairAttempts: 2,
    repairedAtMs: params.nowMs,
    reusedNodeIds,
    invalidatedNodeIds,
    requeuedNodeIds,
    reason: repairs.map((repair) => repair.applyReason ?? repair.reason).join("; "),
  };
}

function normalizeQueueStore(raw: unknown): CronTaskRunQueueStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { version: 1, runs: [] };
  }
  const obj = raw as Record<string, unknown>;
  const runs = Array.isArray(obj.runs) ? obj.runs : [];
  return {
    version: 1,
    runs: runs.filter((run): run is CronTaskRunQueueItem => {
      return Boolean(
        run &&
        typeof run === "object" &&
        !Array.isArray(run) &&
        typeof (run as Record<string, unknown>).runId === "string" &&
        typeof (run as Record<string, unknown>).jobId === "string",
      );
    }),
  };
}

async function loadQueueStore(filePath: string): Promise<CronTaskRunQueueStore> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return normalizeQueueStore(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, runs: [] };
    }
    throw err;
  }
}

async function saveQueueStore(filePath: string, store: CronTaskRunQueueStore) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tmp, filePath);
}

async function updateQueueStore<T>(
  filePath: string,
  update: (store: CronTaskRunQueueStore) => T | Promise<T>,
): Promise<T> {
  const resolved = path.resolve(filePath);
  const prev = queueLocks.get(resolved) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = prev.catch(() => undefined).then(() => current);
  queueLocks.set(resolved, next);
  await prev.catch(() => undefined);
  try {
    return await withFileLock(resolved, QUEUE_FILE_LOCK_OPTIONS, async () => {
      const store = await loadQueueStore(resolved);
      const result = await update(store);
      await saveQueueStore(resolved, store);
      return result;
    });
  } finally {
    release();
    if (queueLocks.get(resolved) === next) {
      queueLocks.delete(resolved);
    }
  }
}

function findRun(store: CronTaskRunQueueStore, runId: string) {
  return store.runs.find((run) => run.runId === runId);
}

function findOrCreateStep(run: CronTaskRunQueueItem, stepId: string, nowMs: number) {
  let step = run.steps.find((entry) => entry.id === stepId);
  if (!step) {
    const retryPolicy = defaultRetryPolicyForStepId(stepId);
    step = {
      id: stepId,
      status: "queued",
      attempt: 0,
      maxAttempts: retryPolicy.maxAttempts,
      retryPolicy,
      createdAtMs: nowMs,
      resume: resumeStateForStep({ id: stepId }, nowMs),
    };
    run.steps.push(step);
  } else {
    normalizeStepPolicy(step, stepId);
    step.resume ??= resumeStateForStep(step, nowMs);
  }
  return step;
}

function findOrCreateWorkerStep(run: CronTaskRunQueueItem, nowMs: number) {
  const legacy = run.steps.find((entry) => entry.id === LEGACY_WORKER_STEP_ID);
  if (legacy) {
    normalizeStepPolicy(legacy, LEGACY_WORKER_STEP_ID);
    legacy.resume ??= resumeStateForStep(legacy, nowMs);
    return legacy;
  }
  return findOrCreateStep(run, CRON_TASK_RUN_QUEUE_WORKER_STEP_ID, nowMs);
}

function stepIsRunnable(step: CronTaskRunQueueStep, nowMs: number) {
  const policy = normalizeStepPolicy(step);
  const leaseExpired = stepCanResumeExpiredLease(step, nowMs);
  const retryableError = stepCanRetryAfterError(step, nowMs);
  if (step.status !== "queued" && !leaseExpired && !retryableError) {
    return false;
  }
  if (step.status === "queued" && typeof step.nextRetryAtMs === "number") {
    if (step.nextRetryAtMs > nowMs) {
      return false;
    }
  }
  return step.attempt < policy.maxAttempts || leaseExpired;
}

function graphNodeSteps(run: CronTaskRunQueueItem) {
  return run.steps.filter((step) => step.kind === "graph-node" || Boolean(step.graphNodeId));
}

function graphNodeIsComplete(step: CronTaskRunQueueStep) {
  return step.status === "ok" || step.status === "skipped";
}

function graphNodeDependenciesMet(run: CronTaskRunQueueItem, step: CronTaskRunQueueStep) {
  const dependsOn = step.graphNodeDependsOn ?? [];
  return dependsOn.every((nodeId) => {
    const dependency = run.steps.find((entry) => entry.graphNodeId === nodeId);
    return dependency ? graphNodeIsComplete(dependency) : false;
  });
}

function graphNodesComplete(run: CronTaskRunQueueItem) {
  const steps = graphNodeSteps(run);
  return steps.length > 0 && steps.every(graphNodeIsComplete);
}

function findRunnableGraphNodeStep(run: CronTaskRunQueueItem, nowMs: number) {
  const steps = graphNodeSteps(run);
  if (steps.length === 0) {
    return undefined;
  }
  const active = steps.find(
    (step) => step.status === "running" && !stepCanResumeExpiredLease(step, nowMs),
  );
  if (active) {
    return undefined;
  }
  return steps.find((step) => stepIsRunnable(step, nowMs) && graphNodeDependenciesMet(run, step));
}

function findRunnableQueueStep(run: CronTaskRunQueueItem, nowMs: number) {
  const workerStep = findOrCreateWorkerStep(run, nowMs);
  if (run.skipReason) {
    return workerStep;
  }
  const workerLeaseExpired = stepCanResumeExpiredLease(workerStep, nowMs);
  if (workerStep.status === "running" && !workerLeaseExpired) {
    return undefined;
  }
  if (stepIsRunnable(workerStep, nowMs) && workerStep.attempt > 0) {
    return workerStep;
  }
  const collectStep = findOrCreateStep(run, CRON_TASK_RUN_QUEUE_COLLECT_STEP_ID, nowMs);
  if (stepIsRunnable(collectStep, nowMs)) {
    return collectStep;
  }
  if (collectStep.status !== "ok" && collectStep.status !== "skipped") {
    return undefined;
  }
  const graphStep = findRunnableGraphNodeStep(run, nowMs);
  if (graphStep) {
    return graphStep;
  }
  if (graphNodeSteps(run).length > 0 && !graphNodesComplete(run)) {
    return undefined;
  }
  const planAnalysisStep = findOrCreateStep(run, CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID, nowMs);
  if (stepIsRunnable(planAnalysisStep, nowMs)) {
    return planAnalysisStep;
  }
  if (planAnalysisStep.status !== "ok" && planAnalysisStep.status !== "skipped") {
    return undefined;
  }
  if (stepIsRunnable(workerStep, nowMs)) {
    return workerStep;
  }
  if (workerStep.status !== "ok") {
    return undefined;
  }

  const synthesizeStep = findOrCreateStep(run, CRON_TASK_RUN_QUEUE_SYNTHESIZE_STEP_ID, nowMs);
  if (stepIsRunnable(synthesizeStep, nowMs)) {
    return synthesizeStep;
  }
  if (synthesizeStep.status !== "ok" && synthesizeStep.status !== "skipped") {
    return undefined;
  }

  const evaluateStep = findOrCreateStep(run, "evaluate", nowMs);
  if (evaluateStep.status !== "ok" && evaluateStep.status !== "skipped") {
    return undefined;
  }

  const deliverStep = findOrCreateStep(run, "deliver", nowMs);
  if (stepIsRunnable(deliverStep, nowMs)) {
    return deliverStep;
  }
  return undefined;
}

function resetStepForRetry(
  step: CronTaskRunQueueStep,
  nowMs: number,
  reason?: string,
  preserveCheckpoint = false,
) {
  normalizeStepPolicy(step);
  step.status = "queued";
  step.attempt = 0;
  step.startedAtMs = undefined;
  step.completedAtMs = undefined;
  step.leaseOwner = undefined;
  step.leaseExpiresAtMs = undefined;
  step.nextRetryAtMs = undefined;
  step.error = undefined;
  if (!preserveCheckpoint) {
    step.checkpoint = undefined;
  } else if (reason) {
    step.checkpoint = { ...step.checkpoint, retryReason: reason, retriedAtMs: nowMs };
  }
  step.resume = resumeStateForStep(
    step,
    nowMs,
    preserveCheckpoint && checkpointKeys(step.checkpoint).length > 0
      ? "Manual retry queued with existing checkpoint data."
      : "Manual retry queued from the beginning.",
  );
}

export async function enqueueCronTaskRunQueueItem(params: {
  storePath: string;
  job: CronJob;
  runId: string;
  trigger: CronTaskRunCheckpointTrigger;
  nowMs: number;
  skipReason?: string;
}) {
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  await updateQueueStore(filePath, (store) => {
    const existing = findRun(store, params.runId);
    if (existing) {
      existing.updatedAtMs = params.nowMs;
      existing.status = existing.status === "queued" ? "queued" : existing.status;
      existing.skipReason = params.skipReason;
      return existing;
    }
    const item: CronTaskRunQueueItem = {
      runId: params.runId,
      jobId: params.job.id,
      jobName: params.job.name,
      agentId: params.job.agentId,
      sessionKey: params.job.sessionKey,
      trigger: params.trigger,
      status: "queued",
      createdAtMs: params.nowMs,
      updatedAtMs: params.nowMs,
      queuedAtMs: params.nowMs,
      skipReason: params.skipReason,
      steps: defaultSteps(params.job, params.nowMs),
    };
    const graph = params.job.executionPolicy?.planner?.graph;
    if (graph?.graphRevision) {
      item.graphRevision = graph.graphRevision;
    }
    if (graph?.parentRevision) {
      item.parentRevision = graph.parentRevision;
    }
    if (graph?.repairRevision) {
      item.repairRevision = graph.repairRevision;
    }
    const previousRun = previousRunForRepairReplay(store, params.job);
    if (previousRun) {
      const repairReplay = applyRepairReplayToSteps({
        steps: item.steps,
        job: params.job,
        previousRun,
        runId: params.runId,
        nowMs: params.nowMs,
      });
      if (repairReplay) {
        item.repairReplay = repairReplay;
      }
    }
    store.runs.push(item);
    return item;
  });
}

export async function startCronTaskRunQueueStep(params: {
  storePath: string;
  runId: string;
  stepId: string;
  nowMs: number;
  leaseMs: number;
  leaseOwner?: string;
  checkpoint?: Record<string, unknown>;
}) {
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  await updateQueueStore(filePath, (store) => {
    const run = findRun(store, params.runId);
    if (!run || run.cancelRequestedAtMs) {
      return;
    }
    run.status = "running";
    run.startedAtMs ??= params.nowMs;
    run.updatedAtMs = params.nowMs;
    const step = findOrCreateStep(run, params.stepId, params.nowMs);
    step.status = "running";
    step.attempt += 1;
    step.startedAtMs = params.nowMs;
    step.completedAtMs = undefined;
    step.leaseOwner = params.leaseOwner ?? "local";
    step.leaseExpiresAtMs = params.nowMs + Math.max(1_000, Math.floor(params.leaseMs));
    step.nextRetryAtMs = undefined;
    step.error = undefined;
    step.checkpoint = params.checkpoint
      ? { ...step.checkpoint, ...params.checkpoint }
      : step.checkpoint;
    step.resume = resumeStateForStep(step, params.nowMs);
  });
}

export type CronTaskRunQueueLease = {
  runId: string;
  jobId: string;
  stepId: string;
  trigger: CronTaskRunCheckpointTrigger;
  attempt: number;
  skipReason?: string;
  checkpoint?: Record<string, unknown>;
};

export async function leaseCronTaskRunQueueExecuteSteps(params: {
  storePath: string;
  nowMs: number;
  leaseMs: number;
  leaseOwner?: string;
  runIds?: ReadonlySet<string>;
  maxRuns: number;
}): Promise<CronTaskRunQueueLease[]> {
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  return await updateQueueStore(filePath, (store) => {
    const leases: CronTaskRunQueueLease[] = [];
    for (const run of store.runs) {
      if (leases.length >= Math.max(1, Math.floor(params.maxRuns))) {
        break;
      }
      if (params.runIds && !params.runIds.has(run.runId)) {
        continue;
      }
      if (run.cancelRequestedAtMs || run.status === "canceled") {
        run.status = "canceled";
        run.completedAtMs ??= params.nowMs;
        run.updatedAtMs = params.nowMs;
        continue;
      }
      if (run.status !== "queued" && run.status !== "running") {
        continue;
      }
      const step = findRunnableQueueStep(run, params.nowMs);
      if (!step) {
        continue;
      }
      run.status = "running";
      run.startedAtMs ??= params.nowMs;
      run.updatedAtMs = params.nowMs;
      step.status = "running";
      step.attempt += 1;
      step.startedAtMs = params.nowMs;
      step.completedAtMs = undefined;
      step.leaseOwner = params.leaseOwner ?? "local-worker";
      step.leaseExpiresAtMs = params.nowMs + Math.max(1_000, Math.floor(params.leaseMs));
      step.nextRetryAtMs = undefined;
      step.error = undefined;
      step.resume = resumeStateForStep(
        step,
        params.nowMs,
        checkpointKeys(step.checkpoint).length > 0
          ? "Worker lease resumed with checkpoint data."
          : "Worker lease started without checkpoint data.",
      );
      leases.push({
        runId: run.runId,
        jobId: run.jobId,
        stepId: step.id,
        trigger: run.trigger,
        attempt: step.attempt,
        skipReason: run.skipReason,
        checkpoint: step.checkpoint,
      });
    }
    return leases;
  });
}

export async function retryCronTaskRunQueueExecuteStep(params: {
  storePath: string;
  runId: string;
  nowMs: number;
  error: string;
  checkpoint?: Record<string, unknown>;
}): Promise<"retry" | "terminal"> {
  return await retryCronTaskRunQueueStep({
    ...params,
    stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
  });
}

export async function retryCronTaskRunQueueStep(params: {
  storePath: string;
  runId: string;
  stepId: string;
  nowMs: number;
  error: string;
  checkpoint?: Record<string, unknown>;
}): Promise<"retry" | "terminal"> {
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  return await updateQueueStore(filePath, (store) => {
    const run = findRun(store, params.runId);
    if (!run) {
      return "terminal";
    }
    if (run.status === "canceled" || run.cancelRequestedAtMs) {
      return "terminal";
    }
    const step =
      params.stepId === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID ||
      params.stepId === LEGACY_WORKER_STEP_ID
        ? findOrCreateWorkerStep(run, params.nowMs)
        : findOrCreateStep(run, params.stepId, params.nowMs);
    step.error = params.error;
    step.completedAtMs = params.nowMs;
    step.leaseOwner = undefined;
    step.leaseExpiresAtMs = undefined;
    if (params.checkpoint) {
      step.checkpoint = { ...step.checkpoint, ...params.checkpoint };
    }
    step.resume = resumeStateForStep(step, params.nowMs, "Failure checkpoint saved for retry.");
    run.updatedAtMs = params.nowMs;
    const policy = normalizeStepPolicy(step);
    if (step.attempt < policy.maxAttempts && !run.cancelRequestedAtMs) {
      const delayMs = stepRetryDelayMs(step);
      step.nextRetryAtMs = params.nowMs + delayMs;
      step.status = "queued";
      run.status = "queued";
      run.error = params.error;
      return "retry";
    }
    step.nextRetryAtMs = undefined;
    step.status = "error";
    run.status = "error";
    run.completedAtMs = params.nowMs;
    run.error = params.error;
    return "terminal";
  });
}

export async function checkpointCronTaskRunQueueStep(params: {
  storePath: string;
  runId: string;
  stepId: string;
  nowMs: number;
  leaseMs?: number;
  checkpoint: Record<string, unknown>;
}) {
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  await updateQueueStore(filePath, (store) => {
    const run = findRun(store, params.runId);
    if (!run) {
      return;
    }
    if (run.status === "canceled" || run.cancelRequestedAtMs) {
      return;
    }
    const step = findOrCreateStep(run, params.stepId, params.nowMs);
    step.checkpoint = { ...step.checkpoint, ...params.checkpoint };
    step.resume = resumeStateForStep(step, params.nowMs, "Checkpoint recorded for resume.");
    if (step.status === "running" && typeof params.leaseMs === "number") {
      step.leaseExpiresAtMs = params.nowMs + Math.max(1_000, Math.floor(params.leaseMs));
    }
    run.updatedAtMs = params.nowMs;
  });
}

export async function completeCronTaskRunQueueStep(params: {
  storePath: string;
  runId: string;
  stepId: string;
  nowMs: number;
  status: CronTaskRunQueueStepStatus;
  error?: string;
  checkpoint?: Record<string, unknown>;
}) {
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  await updateQueueStore(filePath, (store) => {
    const run = findRun(store, params.runId);
    if (!run) {
      return;
    }
    if (run.status === "canceled" || run.cancelRequestedAtMs) {
      return;
    }
    const step = findOrCreateStep(run, params.stepId, params.nowMs);
    step.status = params.status;
    step.completedAtMs = params.nowMs;
    step.leaseOwner = undefined;
    step.leaseExpiresAtMs = undefined;
    step.nextRetryAtMs = undefined;
    step.error = params.error;
    if (params.checkpoint) {
      step.checkpoint = { ...step.checkpoint, ...params.checkpoint };
    }
    step.resume = resumeStateForStep(
      step,
      params.nowMs,
      params.status === "ok"
        ? "Step completed; checkpoint retained for audit."
        : "Step completed with checkpoint data retained.",
    );
    run.updatedAtMs = params.nowMs;
  });
}

export async function finishCronTaskRunQueueItem(params: {
  storePath: string;
  runId: string;
  nowMs: number;
  status: CronTaskRunQueueStatus;
  error?: string;
  result?: CronTaskRunQueueItem["result"];
}) {
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  await updateQueueStore(filePath, (store) => {
    const run = findRun(store, params.runId);
    if (!run) {
      return;
    }
    if (run.status === "canceled" || run.cancelRequestedAtMs) {
      return;
    }
    run.status = params.status;
    run.completedAtMs = params.nowMs;
    run.updatedAtMs = params.nowMs;
    run.error = params.error;
    run.result = params.result;
    const finalize = findOrCreateStep(run, "finalize", params.nowMs);
    finalize.status = params.status === "ok" ? "ok" : params.status;
    finalize.attempt = Math.max(1, finalize.attempt);
    finalize.startedAtMs ??= params.nowMs;
    finalize.completedAtMs = params.nowMs;
    finalize.nextRetryAtMs = undefined;
    finalize.resume = resumeStateForStep(finalize, params.nowMs, "Finalize step completed.");
  });
}

export async function cancelCronTaskRunQueueItem(params: {
  storePath: string;
  runId: string;
  nowMs: number;
  reason?: string;
}): Promise<CronTaskRunQueueControlResult> {
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  return await updateQueueStore(filePath, (store) => {
    const run = findRun(store, params.runId);
    if (!run || run.status === "ok" || run.status === "error") {
      return {
        ok: false,
        reason: run ? `Run is already terminal: ${run.status}.` : "Run not found.",
        ...(run ? { run } : {}),
      };
    }
    run.status = "canceled";
    run.cancelRequestedAtMs = params.nowMs;
    run.completedAtMs = params.nowMs;
    run.updatedAtMs = params.nowMs;
    run.error = params.reason;
    for (const step of run.steps) {
      if (step.status === "queued" || step.status === "running") {
        step.status = "canceled";
        step.completedAtMs = params.nowMs;
        step.leaseOwner = undefined;
        step.leaseExpiresAtMs = undefined;
        step.nextRetryAtMs = undefined;
        step.error = params.reason;
        step.resume = resumeStateForStep(step, params.nowMs, "Run was canceled.");
      }
    }
    return { ok: true, run, message: "Run canceled." };
  });
}

export async function retryCronTaskRunQueueItem(params: {
  storePath: string;
  runId: string;
  nowMs: number;
  reason?: string;
}): Promise<CronTaskRunQueueControlResult> {
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  return await updateQueueStore(filePath, (store) => {
    const run = findRun(store, params.runId);
    if (!run) {
      return { ok: false, reason: "Run not found." };
    }
    if (run.status === "queued" || run.status === "running") {
      return { ok: false, run, reason: `Run is already ${run.status}.` };
    }
    if (run.status === "ok") {
      return { ok: false, run, reason: "Run already completed successfully." };
    }
    run.status = "queued";
    run.updatedAtMs = params.nowMs;
    run.completedAtMs = undefined;
    run.cancelRequestedAtMs = undefined;
    run.recoveredAtMs = undefined;
    run.error = undefined;
    run.result = undefined;
    run.skipReason = undefined;
    for (const stepId of RESETTABLE_PHASE_STEP_IDS) {
      const step = findOrCreateStep(run, stepId, params.nowMs);
      resetStepForRetry(
        step,
        params.nowMs,
        params.reason,
        stepId === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
      );
    }
    for (const step of graphNodeSteps(run)) {
      resetStepForRetry(step, params.nowMs, params.reason, false);
    }
    const legacyExecute = run.steps.find((step) => step.id === LEGACY_WORKER_STEP_ID);
    if (legacyExecute) {
      resetStepForRetry(legacyExecute, params.nowMs, params.reason, true);
    }
    return { ok: true, run, message: "Run queued for retry." };
  });
}

export async function clearExpiredCronTaskRunQueueLease(params: {
  storePath: string;
  runId: string;
  nowMs: number;
  reason?: string;
}): Promise<CronTaskRunQueueControlResult> {
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  return await updateQueueStore(filePath, (store) => {
    const run = findRun(store, params.runId);
    if (!run) {
      return { ok: false, reason: "Run not found." };
    }
    const expiredSteps = run.steps.filter(
      (step) => step.status === "running" && (step.leaseExpiresAtMs ?? Infinity) <= params.nowMs,
    );
    if (expiredSteps.length === 0) {
      return { ok: false, run, reason: "Run has no expired lease." };
    }
    const requeueableSteps = expiredSteps.filter((step) => {
      const policy = normalizeStepPolicy(step);
      return step.attempt < policy.maxAttempts;
    });
    if (requeueableSteps.length === 0) {
      return { ok: false, run, reason: "Expired lease has exhausted its retry policy." };
    }
    run.status = "queued";
    run.updatedAtMs = params.nowMs;
    run.completedAtMs = undefined;
    run.recoveredAtMs = undefined;
    run.error = params.reason;
    for (const step of requeueableSteps) {
      step.status = "queued";
      step.completedAtMs = undefined;
      step.leaseOwner = undefined;
      step.leaseExpiresAtMs = undefined;
      step.nextRetryAtMs = undefined;
      step.error = params.reason;
      step.checkpoint = { ...step.checkpoint, clearedLeaseAtMs: params.nowMs };
      step.resume = resumeStateForStep(
        step,
        params.nowMs,
        checkpointKeys(step.checkpoint).length > 0
          ? "Expired lease cleared; next worker can resume from checkpoint."
          : "Expired lease cleared; no checkpoint data is available.",
      );
    }
    return { ok: true, run, message: "Expired lease cleared." };
  });
}

export async function recoverCronTaskRunQueueItem(params: {
  storePath: string;
  runId: string;
  nowMs: number;
  reason: string;
}) {
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  await updateQueueStore(filePath, (store) => {
    const run = findRun(store, params.runId);
    if (!run || run.status === "ok" || run.status === "error") {
      return;
    }
    run.status = "recovered";
    run.recoveredAtMs = params.nowMs;
    run.completedAtMs = params.nowMs;
    run.updatedAtMs = params.nowMs;
    run.error = params.reason;
    for (const step of run.steps) {
      if (step.status === "queued" || step.status === "running") {
        step.status = "recovered";
        step.completedAtMs = params.nowMs;
        step.leaseOwner = undefined;
        step.leaseExpiresAtMs = undefined;
        step.nextRetryAtMs = undefined;
        step.error = params.reason;
        step.resume = resumeStateForStep(step, params.nowMs, "Run was marked recovered.");
      }
    }
  });
}

export async function recoverExpiredCronTaskRunQueueLeases(params: {
  storePath: string;
  nowMs: number;
  reason: string;
}) {
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  await updateQueueStore(filePath, (store) => {
    for (const run of store.runs) {
      if (run.status !== "running") {
        continue;
      }
      const expiredSteps = run.steps.filter(
        (step) => step.status === "running" && (step.leaseExpiresAtMs ?? Infinity) <= params.nowMs,
      );
      if (expiredSteps.length === 0) {
        continue;
      }
      const requeueableSteps = expiredSteps.filter((step) =>
        stepCanResumeExpiredLease(step, params.nowMs),
      );
      if (requeueableSteps.length > 0) {
        run.status = "queued";
        run.updatedAtMs = params.nowMs;
        run.error = params.reason;
        for (const step of requeueableSteps) {
          const delayMs = stepRetryDelayMs(step);
          step.status = "queued";
          step.completedAtMs = undefined;
          step.leaseOwner = undefined;
          step.leaseExpiresAtMs = undefined;
          step.nextRetryAtMs = params.nowMs + delayMs;
          step.error = params.reason;
          step.checkpoint = { ...step.checkpoint, leaseExpiredAtMs: params.nowMs };
          step.resume = resumeStateForStep(
            step,
            params.nowMs,
            checkpointKeys(step.checkpoint).length > 0
              ? "Expired lease requeued with checkpoint data."
              : "Expired lease requeued without checkpoint data.",
          );
        }
        continue;
      }
      run.status = "recovered";
      run.recoveredAtMs = params.nowMs;
      run.completedAtMs = params.nowMs;
      run.updatedAtMs = params.nowMs;
      run.error = params.reason;
      for (const step of expiredSteps) {
        step.status = "recovered";
        step.completedAtMs = params.nowMs;
        step.leaseOwner = undefined;
        step.leaseExpiresAtMs = undefined;
        step.nextRetryAtMs = undefined;
        step.error = params.reason;
        step.resume = resumeStateForStep(step, params.nowMs, "Expired lease was recovered.");
      }
    }
  });
}

export async function readCronTaskRunQueue(params: {
  storePath: string;
}): Promise<CronTaskRunQueueStore> {
  return await loadQueueStore(resolveCronTaskRunQueuePath({ storePath: params.storePath }));
}

export async function removeCronTaskRunQueueItems(params: {
  storePath: string;
  runIds: string[];
}): Promise<{ removed: number }> {
  const wanted = new Set(params.runIds.map((runId) => runId.trim()).filter(Boolean));
  if (wanted.size === 0) {
    return { removed: 0 };
  }
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  return await updateQueueStore(filePath, (store) => {
    const before = store.runs.length;
    store.runs = store.runs.filter((run) => !wanted.has(run.runId));
    return { removed: before - store.runs.length };
  });
}

export async function summarizeCronTaskRunQueue(params: {
  storePath: string;
  nowMs: number;
}): Promise<CronTaskRunQueueSummary> {
  const filePath = resolveCronTaskRunQueuePath({ storePath: params.storePath });
  const store = await loadQueueStore(filePath);
  const byStatus = Object.fromEntries(QUEUE_STATUSES.map((status) => [status, 0])) as Record<
    CronTaskRunQueueStatus,
    number
  >;
  const workers = new Map<string, CronTaskRunQueueWorkerSummary>();
  const activeRuns: CronTaskRunQueueActiveRunSummary[] = [];
  const recentRuns: CronTaskRunQueueRecentRunSummary[] = [];
  let cancelRequested = 0;
  let expiredLeases = 0;

  for (const run of store.runs) {
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
    if (run.cancelRequestedAtMs) {
      cancelRequested += 1;
    }
    for (const step of run.steps) {
      normalizeStepPolicy(step);
      if (step.status !== "running") {
        continue;
      }
      const leaseExpired = (step.leaseExpiresAtMs ?? Infinity) <= params.nowMs;
      if (leaseExpired) {
        expiredLeases += 1;
      }
      const workerId = step.leaseOwner?.trim();
      if (workerId) {
        const worker =
          workers.get(workerId) ??
          ({
            workerId,
            running: 0,
            expired: 0,
            runIds: [],
          } satisfies CronTaskRunQueueWorkerSummary);
        worker.running += 1;
        if (leaseExpired) {
          worker.expired += 1;
        }
        if (!worker.runIds.includes(run.runId)) {
          worker.runIds.push(run.runId);
        }
        if (typeof step.leaseExpiresAtMs === "number") {
          worker.nextLeaseExpiresAtMs =
            typeof worker.nextLeaseExpiresAtMs === "number"
              ? Math.min(worker.nextLeaseExpiresAtMs, step.leaseExpiresAtMs)
              : step.leaseExpiresAtMs;
        }
        if (typeof step.startedAtMs === "number") {
          worker.lastLeaseAtMs =
            typeof worker.lastLeaseAtMs === "number"
              ? Math.max(worker.lastLeaseAtMs, step.startedAtMs)
              : step.startedAtMs;
        }
        workers.set(workerId, worker);
      }
      activeRuns.push({
        runId: run.runId,
        jobId: run.jobId,
        jobName: run.jobName,
        agentId: run.agentId,
        sessionKey: run.sessionKey,
        status: run.status,
        stepId: step.id,
        attempt: step.attempt,
        maxAttempts: step.maxAttempts,
        retryPolicy: step.retryPolicy,
        nextRetryAtMs: step.nextRetryAtMs,
        resume: step.resume,
        leaseOwner: step.leaseOwner,
        leaseExpiresAtMs: step.leaseExpiresAtMs,
        leaseExpired,
        queuedAtMs: run.queuedAtMs,
        startedAtMs: run.startedAtMs,
        updatedAtMs: run.updatedAtMs,
      });
    }
    recentRuns.push({
      runId: run.runId,
      jobId: run.jobId,
      jobName: run.jobName,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
      status: run.status,
      error: run.error,
      resultStatus: run.result?.status,
      queuedAtMs: run.queuedAtMs,
      startedAtMs: run.startedAtMs,
      completedAtMs: run.completedAtMs,
      updatedAtMs: run.updatedAtMs,
    });
  }

  const queued = byStatus.queued;
  const running = byStatus.running;
  const terminal = QUEUE_STATUSES.filter((status) => TERMINAL_STATUSES.has(status)).reduce(
    (sum, status) => sum + byStatus[status],
    0,
  );

  return {
    path: filePath,
    total: store.runs.length,
    queued,
    running,
    terminal,
    cancelRequested,
    expiredLeases,
    byStatus,
    workers: Array.from(workers.values()).toSorted((a, b) => a.workerId.localeCompare(b.workerId)),
    activeRuns: activeRuns.toSorted((a, b) => b.updatedAtMs - a.updatedAtMs),
    recentRuns: recentRuns.toSorted((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, 50),
  };
}
