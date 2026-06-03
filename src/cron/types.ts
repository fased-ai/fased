import type { ChannelId } from "../channels/plugins/types.js";

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | {
      kind: "cron";
      expr: string;
      tz?: string;
      /** Optional deterministic stagger window in milliseconds (0 keeps exact schedule). */
      staggerMs?: number;
    };

export type CronSessionTarget = "main" | "isolated";
export type CronWakeMode = "next-heartbeat" | "now";

export type CronMessageChannel = ChannelId | "last";

export type CronDeliveryMode = "none" | "announce" | "webhook";

export type CronDelivery = {
  mode: CronDeliveryMode;
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
};

export type CronDeliveryPatch = Partial<CronDelivery>;

export type CronFailureAlert = {
  after?: number;
  channel?: CronMessageChannel;
  to?: string;
  cooldownMs?: number;
  mode?: "announce" | "webhook";
  accountId?: string;
};

export type CronTaskTriggerKind =
  | "schedule"
  | "heartbeat"
  | "webhook"
  | "channel"
  | "manual"
  | "event";

export type CronTaskExecutionMode = "auto" | "agent-turn" | "skill-only" | "no-model";
export type CronTaskMemoryScope = "none" | "session-summary" | "pinned" | "search" | "agent";
export type CronTaskSkillScope = "none" | "selected" | "agent-default";

export type CronTaskModelPolicy = {
  mode?: "agent-default" | "task-override" | "auto" | "none";
  model?: string;
  thinking?: string;
  escalationModel?: string;
};

export type CronTaskBudgetPolicy = {
  maxTokensPerRun?: number;
  maxCostUsdPerRun?: number;
  maxRunsPerHour?: number;
};

export type CronTaskStopPolicy = {
  /**
   * Disable the task after the first successful run. Useful for tasks that
   * keep retrying until they produce a valid result.
   */
  onSuccess?: boolean;
  /**
   * Disable the task when the run summary/output includes one of these
   * markers. Comparisons are case-insensitive.
   */
  outputIncludes?: string[];
  /** Disable after this many successful runs. */
  maxSuccessfulRuns?: number;
  /** Disable after this many total terminal runs, including skipped/error. */
  maxTotalRuns?: number;
};

export type CronTaskSkillAction = {
  /** Exact runtime tool name to execute without model inference. */
  toolName: string;
  /** JSON object passed directly to the tool. */
  input?: Record<string, unknown>;
};

export type CronTaskCoordinationMode = "none" | "consult" | "parallel";
export type CronTaskCoordinationEvidenceStatus =
  | "needs_approval"
  | "accepted"
  | "completed"
  | "forbidden"
  | "error"
  | "skipped";

export type CronTaskCoordinationEvidence = {
  agentId: string;
  mode: CronTaskCoordinationMode;
  status: CronTaskCoordinationEvidenceStatus;
  childSessionKey?: string;
  runId?: string;
  summary?: string;
  outputText?: string;
  error?: string;
  createdAtMs?: number;
};

export type CronTaskCoordinationPolicy = {
  /**
   * Stored coordination intent for local task rooms. The coordination graph node
   * consumes this policy and records task-room evidence for any consulted Agent.
   */
  mode?: CronTaskCoordinationMode;
  /** Agent ids to consult or run beside the owner Agent. */
  agents?: string[];
  /** Upper bound for planner-selected helpers when agents are not fully explicit. */
  maxAgents?: number;
  /** Max evaluator/requested coordination rounds for one task. Default: 1. */
  maxRounds?: number;
  /** Require user approval before a task actually delegates work to other Agents. */
  requireApproval?: boolean;
  /** Stop cleanly when consulted Agents provide usable evidence. */
  stopWhenAdvisorsAgree?: boolean;
  /** Use stronger model escalation when consulted Agents disagree or fail. */
  escalateWhenAdvisorsConflict?: boolean;
};

export type CronTaskPlannerStrategy =
  | "agent-default"
  | "cheap-model"
  | "strong-model"
  | "skill-only"
  | "no-model";

export type CronTaskAdaptiveRoute =
  | "agent-default"
  | "cheap-model"
  | "strong-model"
  | "skill-only"
  | "no-model"
  | "agent-evidence";

export type CronTaskAdaptiveRunSample = {
  atMs: number;
  status: CronRunStatus;
  route: CronTaskAdaptiveRoute;
  taskType: string;
  durationMs?: number;
  totalTokens?: number;
  model?: string;
  provider?: string;
  resultSource?: CronRunResultSource;
  resultAdapter?: string;
  modelUsed?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  evaluatorAction?: CronTaskEvaluatorDecision["action"];
};

export type CronTaskAdaptiveRoutingDecision = {
  source: "history";
  route: CronTaskAdaptiveRoute;
  reason: string;
  confidence?: "low" | "medium" | "high";
  taskType: string;
  sampleSize: number;
  successRate?: number;
  failureRate?: number;
  averageDurationMs?: number;
  averageTokens?: number;
  signals?: string[];
  createdAtMs: number;
};

export type CronTaskAdaptiveRoutingState = {
  taskType?: string;
  samples?: CronTaskAdaptiveRunSample[];
  totalRuns?: number;
  successfulRuns?: number;
  failedRuns?: number;
  blockedRuns?: number;
  modelRuns?: number;
  noModelRuns?: number;
  skillOnlyRuns?: number;
  agentEvidenceRuns?: number;
  totalDurationMs?: number;
  totalTokens?: number;
  lastDecision?: CronTaskAdaptiveRoutingDecision;
};

export type CronTaskWorkflowStepKind = "collect" | "analyze" | "evaluate" | "deliver";

export type CronTaskWorkflowSubstep = {
  id: "plan-analysis" | "execute-tool-or-model" | "synthesize";
  label: string;
  description?: string;
  usesModel?: boolean;
  usesTool?: boolean;
  retryable?: boolean;
  checkpointKeys?: string[];
};

export type CronTaskWorkflowStep = {
  id: CronTaskWorkflowStepKind;
  label: string;
  description?: string;
  usesModel?: boolean;
  usesTool?: boolean;
  retryable?: boolean;
  checkpointKeys?: string[];
  substeps?: CronTaskWorkflowSubstep[];
};

export type CronTaskWorkflowGraphNodeKind =
  | "collect"
  | "tool"
  | "model"
  | "coordination"
  | "validation"
  | "synthesize"
  | "deliver";

export type CronTaskSourceRole = "primary" | "verification" | "enrichment";
export type CronTaskSourceVerificationStatus =
  | "compatible"
  | "insufficient_evidence"
  | "conflict_suspected";
export type CronTaskSourceQualityBand = "high" | "medium" | "low" | "unavailable";
export type CronTaskSourceAuthority = "runtime" | "direct" | "live" | "generic" | "unknown";

export type CronTaskWorkflowGraphNode = {
  id: string;
  label: string;
  kind: CronTaskWorkflowGraphNodeKind;
  description?: string;
  dependsOn?: string[];
  /** Optional graph nodes may fail/skipped without blocking downstream analysis. */
  optional?: boolean;
  sourceRole?: CronTaskSourceRole;
  sourcePriority?: number;
  sourceFreshness?: "static" | "runtime" | "live";
  sourceExpectedOutputType?: string;
  /** Concrete URL for trusted/direct source nodes. */
  sourceUrl?: string;
  /** Concrete trusted source text when a URL is not available. */
  sourceText?: string;
  /** Saved trusted-source registry id, when this node came from source memory. */
  trustedSourceId?: string;
  sourceLabel?: string;
  usesModel?: boolean;
  usesTool?: boolean;
  retryable?: boolean;
  checkpointKeys?: string[];
};

export type CronTaskWorkflowGraph = {
  version: 1;
  /** Monotonic workflow graph revision. Repaired graphs increment this. */
  graphRevision?: number;
  /** Previous graph revision when this graph was produced by repair. */
  parentRevision?: number;
  /** Monotonic repair revision applied to this graph. */
  repairRevision?: number;
  entryNodeId: string;
  terminalNodeIds: string[];
  nodes: CronTaskWorkflowGraphNode[];
};

export type CronTaskPlannerDecision = {
  source: "heuristic";
  strategy: CronTaskPlannerStrategy;
  rationale: string;
  confidence?: "low" | "medium" | "high";
  signals?: string[];
  steps?: CronTaskWorkflowStep[];
  graph?: CronTaskWorkflowGraph;
};

export type CronTaskEvaluatorPolicy = {
  /** Enable one-shot escalation when the run output includes an escalation cue. */
  escalateOnSignal?: boolean;
  /** Case-insensitive line-leading cues that request escalation. */
  signalIncludes?: string[];
  /** Max evaluator-triggered escalations for this task. Default: 1. */
  maxEscalations?: number;
};

export type CronTaskRepairPolicy = {
  /** Allow safe automatic retry when the evaluator has already produced a replacement source graph. */
  autoRetryReplacement?: boolean;
  /** Allow optional/enrichment source paths to be stopped automatically after repeated source failures. */
  autoStopOptionalSources?: boolean;
  /** Max automatic source graph repairs from one evaluator decision. Default: 1. */
  maxAutoRepairsPerRun?: number;
  /** Require user approval before replacing primary/verification sources with non-deterministic replacements. */
  requireApprovalForPrimarySource?: boolean;
};

export type CronTaskEvaluatorDecision = {
  source: "heuristic";
  action:
    | "none"
    | "escalate"
    | "needs_access"
    | "request_sources"
    | "retry_sources"
    | "ask_agent"
    | "stop";
  reason: string;
  signal?: string;
  stopCode?: CronTaskRepairStopCode;
  history?: {
    consecutiveNoSignalRuns?: number;
    escalationRuns?: number;
    maxEscalations?: number;
    lastSignalAtMs?: number;
    lastSignal?: string;
    repairAttempts?: number;
    maxRepairAttempts?: number;
    coordinationRuns?: number;
    maxCoordinationRuns?: number;
  };
};

export type CronTaskRepairStopCode =
  | "insufficient_sources"
  | "source_access_missing"
  | "repair_limit_reached"
  | "conflicting_sources"
  | "needs_user_source";

export type CronTaskRepairStop = {
  code: CronTaskRepairStopCode;
  reason: string;
  atMs: number;
  sourceNodeId?: string;
  sourceRole?: CronTaskSourceRole;
  limit?: number;
};

export type CronTaskPendingEscalation = {
  reason: string;
  signal?: string;
  createdAtMs: number;
  sourceRunAtMs: number;
};

export type CronTaskPendingCoordination = {
  reason: string;
  signal?: string;
  agents: string[];
  mode?: CronTaskCoordinationMode;
  createdAtMs: number;
  sourceRunAtMs: number;
};

export type CronTaskGraphRepairPlan = {
  action: "add_source" | "replace_source";
  nodeId: string;
  toolName: "web_search" | "web_fetch" | "gateway" | "wallet" | "mining" | "offers";
  reason: string;
  createdAtMs: number;
  replacesNodeId?: string;
  graphRevision?: number;
  parentRevision?: number;
  repairRevision?: number;
  reusedNodeIds?: string[];
  invalidatedNodeIds?: string[];
  requeuedNodeIds?: string[];
};

export type CronTaskGraphRepairReplay = {
  runId?: string;
  parentRunId?: string;
  graphRevision: number;
  parentRevision?: number;
  repairRevision: number;
  repairAttempt: number;
  maxRepairAttempts: number;
  repairedAtMs: number;
  reusedNodeIds: string[];
  invalidatedNodeIds: string[];
  requeuedNodeIds: string[];
  reason: string;
};

export type CronTaskRepairRecoveryAction =
  | "configure_source"
  | "add_trusted_source"
  | "retry_replacement"
  | "stop_source_path";

export type CronTaskTrustedSourceKind = "url" | "note";

export type CronTaskTrustedSource = {
  id: string;
  source: string;
  kind: CronTaskTrustedSourceKind;
  createdAtMs: number;
  updatedAtMs?: number;
  lastUsedAtMs?: number;
  useCount?: number;
  agentId?: string;
  sessionKey?: string;
  taskType?: string;
  addedFromTaskId?: string;
  label?: string;
  active?: boolean;
  lastRunAtMs?: number;
  lastOutcome?: CronRunStatus;
  lastQualityScore?: number;
  lastQualityBand?: CronTaskSourceQualityBand;
  lastError?: string;
  successCount?: number;
  failureCount?: number;
};

export type CronTaskSourceListFilters = {
  includeInactive?: boolean;
  agentId?: string;
  sessionKey?: string;
  taskType?: string;
  query?: string;
};

export type CronTaskSourceListResult = {
  sources: CronTaskTrustedSource[];
  total: number;
};

export type CronTaskSourceUpdateResult =
  | { ok: true; source: CronTaskTrustedSource }
  | { ok: false; reason: string };

export type CronTaskSourceRemoveResult =
  | { ok: true; id: string; removed: boolean }
  | { ok: false; id: string; removed: false; reason: string };

export type CronTaskExecutionPolicy = {
  /** User-facing objective for planner/evaluator surfaces. */
  objective?: string;
  /** User-facing success condition. Current runtime stores and displays it. */
  successCriteria?: string;
  triggerKind?: CronTaskTriggerKind;
  executionMode?: CronTaskExecutionMode;
  memoryScope?: CronTaskMemoryScope;
  skillScope?: CronTaskSkillScope;
  allowedSkills?: string[];
  skillAction?: CronTaskSkillAction;
  modelPolicy?: CronTaskModelPolicy;
  coordination?: CronTaskCoordinationPolicy;
  budget?: CronTaskBudgetPolicy;
  stop?: CronTaskStopPolicy;
  planner?: CronTaskPlannerDecision;
  evaluator?: CronTaskEvaluatorPolicy;
  repairPolicy?: CronTaskRepairPolicy;
  trustedSources?: CronTaskTrustedSource[];
};

export type CronRunStatus = "ok" | "error" | "skipped" | "blocked";
export type CronDeliveryStatus = "delivered" | "not-delivered" | "unknown" | "not-requested";

export type CronUsageSummary = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
};

export type CronRunTelemetry = {
  model?: string;
  provider?: string;
  usage?: CronUsageSummary;
  policy?: CronRunPolicyTelemetry;
};

export type CronRunResultSource = "model" | "direct-tool" | "direct-text";

export type CronTaskRunCheckpointPhase = "reserved" | "running" | "finalizing";
export type CronTaskRunCheckpointTrigger = "schedule" | "startup" | "manual";

export type CronTaskRunCheckpoint = {
  runId: string;
  phase: CronTaskRunCheckpointPhase;
  trigger: CronTaskRunCheckpointTrigger;
  attempt: number;
  startedAtMs: number;
  heartbeatAtMs: number;
  leaseExpiresAtMs: number;
};

export type CronTaskRunCheckpointSummary = {
  runId?: string;
  phase?: CronTaskRunCheckpointPhase | "finished" | "recovered";
  trigger?: CronTaskRunCheckpointTrigger;
  attempt?: number;
  startedAtMs?: number;
  heartbeatAtMs?: number;
  leaseExpiresAtMs?: number;
  completedAtMs?: number;
  recoveredAtMs?: number;
  reason?: string;
};

export type CronRunPolicyTelemetry = {
  objective?: string;
  successCriteria?: string;
  requestedExecutionMode?: CronTaskExecutionMode;
  effectiveExecutionMode?: Exclude<CronTaskExecutionMode, "auto">;
  memoryScope?: CronTaskMemoryScope;
  skillScope?: CronTaskSkillScope;
  skills?: {
    count: number;
    names: string[];
    skillFilter?: string[];
  };
  modelPolicyMode?: CronTaskModelPolicy["mode"];
  modelOverride?: string;
  escalationModel?: string;
  modelSource?: string;
  budget?: CronTaskBudgetPolicy;
  stop?: CronTaskStopPolicy;
  planner?: CronTaskPlannerDecision;
  evaluator?: CronTaskEvaluatorDecision;
  adaptive?: CronTaskAdaptiveRoutingDecision;
  sourceVerificationStatus?: CronTaskSourceVerificationStatus;
  sourceConflictCount?: number;
  needsSourceReview?: boolean;
  escalatedBecause?: "source_conflict";
  coordination?: {
    total: number;
    completed: number;
    needsApproval: number;
    failed: number;
    agents: string[];
  };
  sourceQuality?: {
    bestSourceId?: string;
    bestScore?: number;
    lowQualityCount?: number;
    lowQualitySourceIds?: string[];
    unavailableCount?: number;
    unavailableSourceIds?: string[];
    sources?: Array<{
      id: string;
      trustedSourceId?: string;
      status?: CronRunStatus;
      role?: CronTaskSourceRole;
      optional?: boolean;
      required?: boolean;
      score?: number;
    }>;
  };
  resultSource?: CronRunResultSource;
  resultAdapter?: string;
  modelUsed?: boolean;
  runCheckpoint?: CronTaskRunCheckpointSummary;
};

export type CronRunOutcome = {
  status: CronRunStatus;
  error?: string;
  /** Optional classifier for execution errors to guide fallback behavior. */
  errorKind?: "delivery-target" | "needs-access";
  summary?: string;
  /** Last non-empty run output. Used by task stop/evaluation policy. */
  outputText?: string;
  sessionId?: string;
  sessionKey?: string;
};

export type CronTaskAccessBlock = {
  code: string;
  service?: string;
  reason: string;
  setupCommand?: string;
  setupPath?: string;
  source?: "preflight" | "run-output";
  detectedAtMs?: number;
};

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | {
      kind: "agentTurn";
      message: string;
      /** Optional model override (provider/model or alias). */
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
      lightContext?: boolean;
      allowUnsafeExternalContent?: boolean;
      deliver?: boolean;
      channel?: CronMessageChannel;
      to?: string;
      bestEffortDeliver?: boolean;
    };

export type CronPayloadPatch =
  | { kind: "systemEvent"; text?: string }
  | {
      kind: "agentTurn";
      message?: string;
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
      lightContext?: boolean;
      allowUnsafeExternalContent?: boolean;
      deliver?: boolean;
      channel?: CronMessageChannel;
      to?: string;
      bestEffortDeliver?: boolean;
    };

export type CronJobState = {
  nextRunAtMs?: number;
  /** Back-compat scalar marker for old stores and read paths. */
  runningAtMs?: number;
  /** Durable active task run lease/checkpoint. */
  activeRun?: CronTaskRunCheckpoint;
  /** Last completed run checkpoint. */
  lastRunCheckpoint?: CronTaskRunCheckpointSummary;
  /** Last interrupted run recovered on startup or maintenance. */
  lastRecoveredRun?: CronTaskRunCheckpointSummary;
  lastRunAtMs?: number;
  /** Preferred execution outcome field. */
  lastRunStatus?: CronRunStatus;
  /** Back-compat alias for lastRunStatus. */
  lastStatus?: CronRunStatus;
  lastError?: string;
  lastDurationMs?: number;
  /** Number of consecutive execution errors (reset on success). Used for backoff. */
  consecutiveErrors?: number;
  /** Number of consecutive schedule computation errors. Auto-disables job after threshold. */
  scheduleErrorCount?: number;
  /** Explicit delivery outcome, separate from execution outcome. */
  lastDeliveryStatus?: CronDeliveryStatus;
  /** Delivery-specific error text when available. */
  lastDeliveryError?: string;
  /** Whether the last run's output was delivered to the target channel. */
  lastDelivered?: boolean;
  /** Start of the current per-task run budget accounting window. */
  budgetWindowStartedAtMs?: number;
  /** Runs reserved in the current per-task run budget accounting window. */
  budgetRunsInWindow?: number;
  /** Total terminal run count. */
  totalRuns?: number;
  /** Total successful run count. */
  successfulRuns?: number;
  /** Why the scheduler disabled this task automatically. */
  stopReason?: string;
  /** Missing credential/access state that blocks recurring execution until fixed. */
  needsAccess?: CronTaskAccessBlock;
  /** One-shot evaluator request to run the next cycle with stronger planning. */
  pendingEscalation?: CronTaskPendingEscalation;
  /** One-shot evaluator/user request to rerun with selected Agent evidence. */
  pendingCoordination?: CronTaskPendingCoordination;
  /** Last dynamic graph repair applied after evaluator source-quality review. */
  lastGraphRepair?: CronTaskGraphRepairPlan & { applied?: boolean };
  /** All dynamic graph repairs applied after the latest evaluator source-quality review. */
  lastGraphRepairs?: Array<CronTaskGraphRepairPlan & { applied?: boolean; applyReason?: string }>;
  /** Current workflow graph revision after dynamic repair. */
  graphRevision?: number;
  /** Current workflow repair revision. */
  repairRevision?: number;
  /** Total graph repair attempts for this task. */
  graphRepairAttempts?: number;
  /** Repair attempts by original/repaired source node id. */
  graphRepairSourceAttempts?: Record<string, number>;
  /** Repair attempts by source role. */
  graphRepairRoleAttempts?: Partial<Record<CronTaskSourceRole, number>>;
  /** Last terminal repair stop state, when repair was not safe to continue. */
  lastGraphRepairStop?: CronTaskRepairStop;
  /** Last planned/applied repair replay metadata. */
  lastGraphRepairReplay?: CronTaskGraphRepairReplay;
  /** Explicit approval marker allowing a coordination graph node to spawn Agents. */
  coordinationApprovedAtMs?: number;
  /** Latest task-room evidence recorded by a coordination graph node. */
  lastCoordinationEvidence?: CronTaskCoordinationEvidence[];
  /** Total evaluator-triggered escalation runs queued for this task. */
  evaluatorEscalationRuns?: number;
  /** Total evaluator/user-triggered Agent coordination runs queued for this task. */
  evaluatorCoordinationRuns?: number;
  /** Consecutive successful cheap checks that did not request escalation. */
  evaluatorConsecutiveNoSignalRuns?: number;
  /** Last escalation signal observed by the evaluator. */
  evaluatorLastSignal?: string;
  /** Timestamp for the last escalation signal observed by the evaluator. */
  evaluatorLastSignalAtMs?: number;
  /** Number of evaluator-requested source retry runs after weak/incomplete evidence. */
  evaluatorSourceRetryRuns?: number;
  /** Last post-run evaluator decision. */
  lastEvaluatorDecision?: CronTaskEvaluatorDecision;
  /** How the last run produced its output: model, direct tool adapter, or direct text. */
  lastRunResultSource?: CronRunResultSource;
  /** Deterministic adapter id used by the last run, when applicable. */
  lastRunResultAdapter?: string;
  /** Whether the last run invoked a model. */
  lastRunModelUsed?: boolean;
  /** Source of the model selected for the last run, when model-backed. */
  lastRunModelSource?: string;
  /** Compact run-history telemetry and next-run adaptive routing decision. */
  adaptiveRouting?: CronTaskAdaptiveRoutingState;
  /** Session id created for the latest isolated task run, when one exists. */
  lastRunSessionId?: string;
  /** Session key created for the latest isolated task run, when one exists. */
  lastRunSessionKey?: string;
};

export type CronJob = {
  id: string;
  agentId?: string;
  /** Origin session namespace for reminder delivery and wake routing. */
  sessionKey?: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  delivery?: CronDelivery;
  executionPolicy?: CronTaskExecutionPolicy;
  failureAlert?: CronFailureAlert | false;
  state: CronJobState;
};

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
  trustedSources?: CronTaskTrustedSource[];
};

export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJobState>;
};

export type CronJobPatch = Partial<
  Omit<CronJob, "id" | "createdAtMs" | "state" | "payload" | "delivery" | "executionPolicy">
> & {
  payload?: CronPayloadPatch;
  delivery?: CronDeliveryPatch;
  executionPolicy?: CronTaskExecutionPolicy | null;
  state?: Partial<CronJobState>;
};

export type CronTaskRepairRecoveryResult =
  | {
      ok: true;
      action: CronTaskRepairRecoveryAction;
      job: CronJob;
      message: string;
      setupPath?: string;
      setupCommand?: string;
    }
  | {
      ok: false;
      action: CronTaskRepairRecoveryAction;
      reason: string;
      job?: CronJob;
      setupPath?: string;
      setupCommand?: string;
    };
