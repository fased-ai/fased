import { choosePlannerModelRef, withTaskCoordinationRequest } from "./task-planner.js";
import type {
  CronDeliveryStatus,
  CronJob,
  CronRunPolicyTelemetry,
  CronRunStatus,
  CronTaskAdaptiveRoute,
  CronTaskAdaptiveRoutingDecision,
  CronTaskAdaptiveRunSample,
  CronTaskPlannerStrategy,
  CronUsageSummary,
} from "./types.js";

const MAX_ADAPTIVE_SAMPLES = 12;
const STABLE_SAMPLE_COUNT = 4;

type AdaptiveRunInput = {
  status: CronRunStatus;
  startedAt: number;
  endedAt: number;
  model?: string;
  provider?: string;
  usage?: CronUsageSummary;
  policy?: CronRunPolicyTelemetry;
  deliveryStatus?: CronDeliveryStatus;
};

function normalizedToolName(job: CronJob): string | undefined {
  const toolName = job.executionPolicy?.skillAction?.toolName?.trim().toLowerCase();
  return toolName || undefined;
}

function currentPlannerStrategy(job: CronJob): CronTaskPlannerStrategy | undefined {
  return job.executionPolicy?.planner?.strategy;
}

function routeFromPlannerStrategy(strategy: CronTaskPlannerStrategy | undefined) {
  if (
    strategy === "agent-default" ||
    strategy === "cheap-model" ||
    strategy === "strong-model" ||
    strategy === "skill-only" ||
    strategy === "no-model"
  ) {
    return strategy;
  }
  return "agent-default";
}

function routeFromRun(job: CronJob, input: AdaptiveRunInput): CronTaskAdaptiveRoute {
  const coordination = input.policy?.coordination;
  if (coordination && coordination.completed > 0) {
    return "agent-evidence";
  }
  if (
    input.policy?.effectiveExecutionMode === "no-model" ||
    input.policy?.resultSource === "direct-text"
  ) {
    return "no-model";
  }
  if (
    input.policy?.effectiveExecutionMode === "skill-only" ||
    input.policy?.resultSource === "direct-tool"
  ) {
    return "skill-only";
  }
  if (
    input.policy?.planner?.strategy === "strong-model" ||
    input.policy?.escalatedBecause ||
    job.state.pendingEscalation
  ) {
    return "strong-model";
  }
  if (input.policy?.planner?.strategy === "cheap-model") {
    return "cheap-model";
  }
  return routeFromPlannerStrategy(currentPlannerStrategy(job));
}

function taskTypeFromRun(job: CronJob, route: CronTaskAdaptiveRoute): string {
  const toolName = normalizedToolName(job);
  if (route === "skill-only" && toolName) {
    return `skill:${toolName}`;
  }
  if (route === "no-model") {
    return "no-model";
  }
  if (route === "agent-evidence") {
    return "agent-evidence";
  }
  return `model:${route}`;
}

function average(values: number[]) {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : undefined;
}

function recent(samples: CronTaskAdaptiveRunSample[], count = 6) {
  return samples.slice(Math.max(0, samples.length - count));
}

function okSamples(samples: CronTaskAdaptiveRunSample[]) {
  return samples.filter((sample) => sample.status === "ok");
}

function failedSamples(samples: CronTaskAdaptiveRunSample[]) {
  return samples.filter((sample) => sample.status === "error" || sample.status === "blocked");
}

function hasSelectedCoordinationAgents(job: CronJob) {
  return (job.executionPolicy?.coordination?.agents ?? []).some((agent) => agent.trim());
}

function coordinationAgents(job: CronJob) {
  return Array.from(
    new Set((job.executionPolicy?.coordination?.agents ?? []).map((agent) => agent.trim())),
  ).filter(Boolean);
}

function evaluatorSuggestsAgentEvidence(job: CronJob) {
  const action = job.state.lastEvaluatorDecision?.action;
  return action === "request_sources" || action === "ask_agent" || action === "stop";
}

function taskHasRecentSourceTrouble(job: CronJob) {
  return Boolean(
    job.state.lastGraphRepairStop ||
    job.state.lastGraphRepairs?.some((repair) => repair.applied === false) ||
    job.state.lastEvaluatorDecision?.signal === "source_conflict",
  );
}

function decision(params: {
  route: CronTaskAdaptiveRoute;
  reason: string;
  confidence?: CronTaskAdaptiveRoutingDecision["confidence"];
  taskType: string;
  samples: CronTaskAdaptiveRunSample[];
  signals?: string[];
  createdAtMs: number;
}): CronTaskAdaptiveRoutingDecision {
  const sampleSize = params.samples.length;
  const successes = okSamples(params.samples).length;
  const failures = failedSamples(params.samples).length;
  const durations = params.samples
    .map((sample) => sample.durationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const tokenCounts = params.samples
    .map((sample) => sample.totalTokens)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    source: "history",
    route: params.route,
    reason: params.reason,
    confidence: params.confidence,
    taskType: params.taskType,
    sampleSize,
    successRate: ratio(successes, sampleSize),
    failureRate: ratio(failures, sampleSize),
    averageDurationMs: average(durations),
    averageTokens: average(tokenCounts),
    signals: params.signals,
    createdAtMs: params.createdAtMs,
  };
}

function chooseAdaptiveDecision(params: {
  job: CronJob;
  samples: CronTaskAdaptiveRunSample[];
  taskType: string;
  nowMs: number;
}): CronTaskAdaptiveRoutingDecision | undefined {
  const { job, samples, taskType, nowMs } = params;
  const window = recent(samples);
  const current = routeFromPlannerStrategy(currentPlannerStrategy(job));
  const successCount = okSamples(window).length;
  const failureCount = failedSamples(window).length;
  const averageTokens = average(
    window
      .map((sample) => sample.totalTokens)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
  );
  const stable = window.length >= STABLE_SAMPLE_COUNT && successCount >= window.length - 1;
  const hasCoordination = hasSelectedCoordinationAgents(job);

  if (
    hasCoordination &&
    window.length >= 2 &&
    (failureCount >= 2 || evaluatorSuggestsAgentEvidence(job) || taskHasRecentSourceTrouble(job))
  ) {
    return decision({
      route: "agent-evidence",
      reason:
        "Recent runs show repeated failure or weak evidence; consult the selected Agent evidence path on the next run.",
      confidence: failureCount >= 2 ? "high" : "medium",
      taskType,
      samples: window,
      signals: ["history:needs-agent-evidence"],
      createdAtMs: nowMs,
    });
  }

  if (normalizedToolName(job) && stable && window.some((sample) => sample.route === "skill-only")) {
    return decision({
      route: "skill-only",
      reason: "Recent deterministic tool runs succeeded; keep this task on the skill-only path.",
      confidence: "high",
      taskType,
      samples: window,
      signals: ["history:skill-stable"],
      createdAtMs: nowMs,
    });
  }

  if (stable && window.every((sample) => sample.route === "no-model")) {
    return decision({
      route: "no-model",
      reason: "Recent direct-text runs succeeded without model calls; keep this task no-model.",
      confidence: "high",
      taskType,
      samples: window,
      signals: ["history:no-model-stable"],
      createdAtMs: nowMs,
    });
  }

  if (
    current === "cheap-model" &&
    ((job.state.evaluatorEscalationRuns ?? 0) >= 2 ||
      window.filter((sample) => sample.route === "strong-model").length >= 2)
  ) {
    return decision({
      route: "strong-model",
      reason:
        "Cheap checks repeatedly escalated; start the next run on the stronger model path instead of paying for two passes.",
      confidence: "medium",
      taskType,
      samples: window,
      signals: ["history:cheap-escalated"],
      createdAtMs: nowMs,
    });
  }

  if (
    (current === "agent-default" || current === "strong-model") &&
    stable &&
    (averageTokens === undefined || averageTokens <= 1_500) &&
    !taskHasRecentSourceTrouble(job)
  ) {
    return decision({
      route: "cheap-model",
      reason:
        "Recent model runs were stable and lightweight; try the cheaper check path on the next run.",
      confidence: current === "agent-default" ? "medium" : "low",
      taskType,
      samples: window,
      signals: ["history:stable-low-cost"],
      createdAtMs: nowMs,
    });
  }

  if (current !== "agent-default" && window.length >= 2) {
    return decision({
      route: current,
      reason: "Recent run history supports keeping the current task route.",
      confidence: "low",
      taskType,
      samples: window,
      signals: ["history:keep-current"],
      createdAtMs: nowMs,
    });
  }

  return undefined;
}

function appendSignal(existing: string[] | undefined, signal: string) {
  return Array.from(new Set([...(existing ?? []), signal]));
}

function applyPlannerRoute(job: CronJob, route: CronTaskAdaptiveRoute, reason: string) {
  const policy = job.executionPolicy;
  if (!policy?.planner) {
    return;
  }
  if (route === "agent-evidence") {
    const agents = coordinationAgents(job);
    if (agents.length === 0) {
      return;
    }
    job.executionPolicy = withTaskCoordinationRequest({
      policy,
      message:
        job.payload.kind === "agentTurn"
          ? job.payload.message
          : job.payload.kind === "systemEvent"
            ? job.payload.text
            : job.name,
      agents,
      mode: job.executionPolicy?.coordination?.mode === "parallel" ? "parallel" : "consult",
      requireApproval: job.executionPolicy?.coordination?.requireApproval,
    });
    job.executionPolicy.planner = {
      source: "heuristic",
      strategy: job.executionPolicy.planner?.strategy ?? "agent-default",
      ...job.executionPolicy.planner,
      rationale: `Adaptive routing: ${reason}`,
      signals: appendSignal(job.executionPolicy.planner?.signals, "adaptive:agent-evidence"),
    };
    return;
  }

  const strategy: CronTaskPlannerStrategy =
    route === "cheap-model" ||
    route === "strong-model" ||
    route === "skill-only" ||
    route === "no-model"
      ? route
      : "agent-default";

  const manualModel =
    policy.modelPolicy?.mode === "task-override" || Boolean(policy.modelPolicy?.model?.trim());

  if ((strategy === "cheap-model" || strategy === "strong-model") && manualModel) {
    return;
  }

  if (strategy === "skill-only" && policy.skillAction) {
    policy.executionMode = "skill-only";
    policy.memoryScope = "none";
    policy.skillScope = "selected";
    policy.allowedSkills = [policy.skillAction.toolName];
    policy.modelPolicy = { mode: "none" };
    policy.evaluator = undefined;
  } else if (strategy === "no-model" && policy.planner.strategy === "no-model") {
    policy.executionMode = "no-model";
    policy.memoryScope = "none";
    policy.skillScope = "none";
    policy.modelPolicy = { mode: "none" };
    policy.evaluator = undefined;
  } else if (strategy === "cheap-model") {
    policy.executionMode = "agent-turn";
    policy.memoryScope = policy.memoryScope ?? "none";
    policy.skillScope = policy.skillScope ?? "none";
    policy.modelPolicy = { ...policy.modelPolicy, mode: "auto" };
    policy.evaluator = {
      ...policy.evaluator,
      escalateOnSignal: true,
      signalIncludes: policy.evaluator?.signalIncludes ?? ["Needs deeper analysis: yes"],
      maxEscalations: policy.evaluator?.maxEscalations ?? 1,
    };
  } else if (strategy === "strong-model") {
    policy.executionMode = "agent-turn";
    policy.memoryScope = "search";
    policy.skillScope = policy.skillScope ?? "agent-default";
    policy.modelPolicy = { ...policy.modelPolicy, mode: "auto" };
  }

  policy.planner = {
    ...policy.planner,
    strategy,
    rationale: `Adaptive routing: ${reason}`,
    signals: appendSignal(policy.planner.signals, `adaptive:${route}`),
  };
}

export function recordAdaptiveRoutingRun(params: {
  job: CronJob;
  result: AdaptiveRunInput;
}): CronTaskAdaptiveRoutingDecision | undefined {
  const { job, result } = params;
  const route = routeFromRun(job, result);
  const taskType = taskTypeFromRun(job, route);
  const sample: CronTaskAdaptiveRunSample = {
    atMs: result.endedAt,
    status: result.status,
    route,
    taskType,
    durationMs: Math.max(0, result.endedAt - result.startedAt),
    totalTokens: result.usage?.total_tokens,
    model: result.model,
    provider: result.provider,
    resultSource: result.policy?.resultSource,
    resultAdapter: result.policy?.resultAdapter,
    modelUsed: result.policy?.modelUsed,
    deliveryStatus: result.deliveryStatus,
    evaluatorAction: job.state.lastEvaluatorDecision?.action,
  };
  const samples = [...(job.state.adaptiveRouting?.samples ?? []), sample].slice(
    -MAX_ADAPTIVE_SAMPLES,
  );
  const decision = chooseAdaptiveDecision({
    job,
    samples,
    taskType,
    nowMs: result.endedAt,
  });
  const successfulRuns = okSamples(samples).length;
  const failedRuns = samples.filter((entry) => entry.status === "error").length;
  const blockedRuns = samples.filter((entry) => entry.status === "blocked").length;
  job.state.adaptiveRouting = {
    taskType,
    samples,
    totalRuns: samples.length,
    successfulRuns,
    failedRuns,
    blockedRuns,
    modelRuns: samples.filter((entry) => entry.modelUsed === true).length,
    noModelRuns: samples.filter((entry) => entry.route === "no-model").length,
    skillOnlyRuns: samples.filter((entry) => entry.route === "skill-only").length,
    agentEvidenceRuns: samples.filter((entry) => entry.route === "agent-evidence").length,
    totalDurationMs: samples.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0),
    totalTokens: samples.reduce((sum, entry) => sum + (entry.totalTokens ?? 0), 0),
    lastDecision: decision ?? job.state.adaptiveRouting?.lastDecision,
  };
  if (decision) {
    applyPlannerRoute(job, decision.route, decision.reason);
    job.state.adaptiveRouting.lastDecision = decision;
  }
  return decision;
}

export function chooseAdaptivePlannerModelRef(params: {
  strategy?: CronTaskPlannerStrategy;
  decision?: CronTaskAdaptiveRoutingDecision;
  candidates: string[];
}): string | undefined {
  const adaptiveRoute = params.decision?.route;
  if (adaptiveRoute === "cheap-model" || adaptiveRoute === "strong-model") {
    return choosePlannerModelRef({ strategy: adaptiveRoute, candidates: params.candidates });
  }
  return choosePlannerModelRef({ strategy: params.strategy, candidates: params.candidates });
}
