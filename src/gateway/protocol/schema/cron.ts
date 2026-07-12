import { Type, type TSchema } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

function cronAgentTurnPayloadSchema(params: { message: TSchema }) {
  return Type.Object(
    {
      kind: Type.Literal("agentTurn"),
      message: params.message,
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
      lightContext: Type.Optional(Type.Boolean()),
      allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
      deliver: Type.Optional(Type.Boolean()),
      channel: Type.Optional(Type.String()),
      to: Type.Optional(Type.String()),
      bestEffortDeliver: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );
}

const CronSessionTargetSchema = Type.Union([Type.Literal("main"), Type.Literal("isolated")]);
const CronWakeModeSchema = Type.Union([Type.Literal("next-heartbeat"), Type.Literal("now")]);
const CronRunStatusSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("error"),
  Type.Literal("skipped"),
  Type.Literal("blocked"),
]);
const CronSortDirSchema = Type.Union([Type.Literal("asc"), Type.Literal("desc")]);
const CronJobsEnabledFilterSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("enabled"),
  Type.Literal("disabled"),
]);
const CronJobsSortBySchema = Type.Union([
  Type.Literal("nextRunAtMs"),
  Type.Literal("updatedAtMs"),
  Type.Literal("name"),
]);
const CronRunsStatusFilterSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("ok"),
  Type.Literal("error"),
  Type.Literal("skipped"),
  Type.Literal("blocked"),
]);
const CronRunsStatusValueSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("error"),
  Type.Literal("skipped"),
  Type.Literal("blocked"),
]);
const CronDeliveryStatusSchema = Type.Union([
  Type.Literal("delivered"),
  Type.Literal("not-delivered"),
  Type.Literal("unknown"),
  Type.Literal("not-requested"),
]);
const CronFailureAlertSchema = Type.Object(
  {
    after: Type.Optional(Type.Integer({ minimum: 1 })),
    channel: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    cooldownMs: Type.Optional(Type.Integer({ minimum: 0 })),
    mode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("webhook")])),
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CronTaskAccessBlockSchema = Type.Object(
  {
    code: NonEmptyString,
    service: Type.Optional(Type.String()),
    reason: NonEmptyString,
    setupCommand: Type.Optional(Type.String()),
    setupPath: Type.Optional(Type.String()),
    source: Type.Optional(Type.Union([Type.Literal("preflight"), Type.Literal("run-output")])),
    detectedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
const CronCommonOptionalFields = {
  agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  sessionKey: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  description: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  deleteAfterRun: Type.Optional(Type.Boolean()),
  failureAlert: Type.Optional(Type.Union([CronFailureAlertSchema, Type.Literal(false)])),
};

function cronIdOrJobIdParams(extraFields: Record<string, TSchema>) {
  return Type.Union([
    Type.Object(
      {
        id: NonEmptyString,
        ...extraFields,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        jobId: NonEmptyString,
        ...extraFields,
      },
      { additionalProperties: false },
    ),
  ]);
}

const CronRunLogJobIdSchema = Type.String({
  minLength: 1,
  // Prevent path traversal via separators in cron.runs id/jobId.
  pattern: "^[^/\\\\]+$",
});

export const CronScheduleSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("at"),
      at: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("every"),
      everyMs: Type.Integer({ minimum: 1 }),
      anchorMs: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("cron"),
      expr: NonEmptyString,
      tz: Type.Optional(Type.String()),
      staggerMs: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
]);

export const CronPayloadSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("systemEvent"),
      text: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  cronAgentTurnPayloadSchema({ message: NonEmptyString }),
]);

export const CronPayloadPatchSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("systemEvent"),
      text: Type.Optional(NonEmptyString),
    },
    { additionalProperties: false },
  ),
  cronAgentTurnPayloadSchema({ message: Type.Optional(NonEmptyString) }),
]);

const CronDeliverySharedProperties = {
  channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
  accountId: Type.Optional(NonEmptyString),
  bestEffort: Type.Optional(Type.Boolean()),
};

const CronDeliveryNoopSchema = Type.Object(
  {
    mode: Type.Literal("none"),
    ...CronDeliverySharedProperties,
    to: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CronDeliveryAnnounceSchema = Type.Object(
  {
    mode: Type.Literal("announce"),
    ...CronDeliverySharedProperties,
    to: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CronDeliveryWebhookSchema = Type.Object(
  {
    mode: Type.Literal("webhook"),
    ...CronDeliverySharedProperties,
    to: NonEmptyString,
  },
  { additionalProperties: false },
);

export const CronDeliverySchema = Type.Union([
  CronDeliveryNoopSchema,
  CronDeliveryAnnounceSchema,
  CronDeliveryWebhookSchema,
]);

export const CronDeliveryPatchSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("none"), Type.Literal("announce"), Type.Literal("webhook")]),
    ),
    ...CronDeliverySharedProperties,
    to: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CronTaskTriggerKindSchema = Type.Union([
  Type.Literal("schedule"),
  Type.Literal("heartbeat"),
  Type.Literal("webhook"),
  Type.Literal("channel"),
  Type.Literal("manual"),
  Type.Literal("event"),
]);

const CronTaskExecutionModeSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("agent-turn"),
  Type.Literal("skill-only"),
  Type.Literal("no-model"),
]);

const CronTaskMemoryScopeSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("session-summary"),
  Type.Literal("pinned"),
  Type.Literal("search"),
  Type.Literal("agent"),
]);

const CronTaskSkillScopeSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("selected"),
  Type.Literal("agent-default"),
]);

const CronTaskSkillActionSchema = Type.Object(
  {
    toolName: NonEmptyString,
    input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

const CronTaskPlannerStrategySchema = Type.Union([
  Type.Literal("agent-default"),
  Type.Literal("cheap-model"),
  Type.Literal("strong-model"),
  Type.Literal("skill-only"),
  Type.Literal("no-model"),
]);

const CronTaskAdaptiveRouteSchema = Type.Union([
  Type.Literal("agent-default"),
  Type.Literal("cheap-model"),
  Type.Literal("strong-model"),
  Type.Literal("skill-only"),
  Type.Literal("no-model"),
  Type.Literal("agent-evidence"),
]);

const CronTaskSourceRoleSchema = Type.Union([
  Type.Literal("primary"),
  Type.Literal("verification"),
  Type.Literal("enrichment"),
]);

const CronTaskPlannerDecisionSchema = Type.Object(
  {
    source: Type.Literal("heuristic"),
    strategy: CronTaskPlannerStrategySchema,
    rationale: NonEmptyString,
    confidence: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    ),
    signals: Type.Optional(Type.Array(NonEmptyString)),
    steps: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.Union([
              Type.Literal("collect"),
              Type.Literal("analyze"),
              Type.Literal("evaluate"),
              Type.Literal("deliver"),
            ]),
            label: NonEmptyString,
            description: Type.Optional(NonEmptyString),
            usesModel: Type.Optional(Type.Boolean()),
            usesTool: Type.Optional(Type.Boolean()),
            retryable: Type.Optional(Type.Boolean()),
            checkpointKeys: Type.Optional(Type.Array(NonEmptyString)),
            substeps: Type.Optional(
              Type.Array(
                Type.Object(
                  {
                    id: Type.Union([
                      Type.Literal("plan-analysis"),
                      Type.Literal("execute-tool-or-model"),
                      Type.Literal("synthesize"),
                    ]),
                    label: NonEmptyString,
                    description: Type.Optional(NonEmptyString),
                    usesModel: Type.Optional(Type.Boolean()),
                    usesTool: Type.Optional(Type.Boolean()),
                    retryable: Type.Optional(Type.Boolean()),
                    checkpointKeys: Type.Optional(Type.Array(NonEmptyString)),
                  },
                  { additionalProperties: false },
                ),
              ),
            ),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    graph: Type.Optional(
      Type.Object(
        {
          version: Type.Literal(1),
          graphRevision: Type.Optional(Type.Integer({ minimum: 0 })),
          parentRevision: Type.Optional(Type.Integer({ minimum: 0 })),
          repairRevision: Type.Optional(Type.Integer({ minimum: 0 })),
          entryNodeId: NonEmptyString,
          terminalNodeIds: Type.Array(NonEmptyString),
          nodes: Type.Array(
            Type.Object(
              {
                id: NonEmptyString,
                label: NonEmptyString,
                kind: Type.Union([
                  Type.Literal("collect"),
                  Type.Literal("tool"),
                  Type.Literal("model"),
                  Type.Literal("coordination"),
                  Type.Literal("validation"),
                  Type.Literal("synthesize"),
                  Type.Literal("deliver"),
                ]),
                description: Type.Optional(NonEmptyString),
                dependsOn: Type.Optional(Type.Array(NonEmptyString)),
                optional: Type.Optional(Type.Boolean()),
                sourceRole: Type.Optional(CronTaskSourceRoleSchema),
                sourcePriority: Type.Optional(Type.Number()),
                sourceFreshness: Type.Optional(
                  Type.Union([
                    Type.Literal("static"),
                    Type.Literal("runtime"),
                    Type.Literal("live"),
                  ]),
                ),
                sourceExpectedOutputType: Type.Optional(NonEmptyString),
                sourceUrl: Type.Optional(NonEmptyString),
                sourceText: Type.Optional(NonEmptyString),
                trustedSourceId: Type.Optional(NonEmptyString),
                sourceLabel: Type.Optional(NonEmptyString),
                usesModel: Type.Optional(Type.Boolean()),
                usesTool: Type.Optional(Type.Boolean()),
                retryable: Type.Optional(Type.Boolean()),
                checkpointKeys: Type.Optional(Type.Array(NonEmptyString)),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const CronTaskEvaluatorPolicySchema = Type.Object(
  {
    escalateOnSignal: Type.Optional(Type.Boolean()),
    signalIncludes: Type.Optional(Type.Array(NonEmptyString)),
    maxEscalations: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const CronTaskRepairPolicySchema = Type.Object(
  {
    autoRetryReplacement: Type.Optional(Type.Boolean()),
    autoStopOptionalSources: Type.Optional(Type.Boolean()),
    maxAutoRepairsPerRun: Type.Optional(Type.Integer({ minimum: 1 })),
    requireApprovalForPrimarySource: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const CronTaskPendingCoordinationSchema = Type.Object(
  {
    reason: NonEmptyString,
    signal: Type.Optional(NonEmptyString),
    agents: Type.Array(NonEmptyString),
    mode: Type.Optional(
      Type.Union([Type.Literal("none"), Type.Literal("consult"), Type.Literal("parallel")]),
    ),
    createdAtMs: Type.Integer({ minimum: 0 }),
    sourceRunAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const CronTaskEvaluatorDecisionSchema = Type.Object(
  {
    source: Type.Literal("heuristic"),
    action: Type.Union([
      Type.Literal("none"),
      Type.Literal("escalate"),
      Type.Literal("needs_access"),
      Type.Literal("request_sources"),
      Type.Literal("retry_sources"),
      Type.Literal("ask_agent"),
      Type.Literal("stop"),
    ]),
    reason: NonEmptyString,
    signal: Type.Optional(NonEmptyString),
    stopCode: Type.Optional(
      Type.Union([
        Type.Literal("insufficient_sources"),
        Type.Literal("source_access_missing"),
        Type.Literal("repair_limit_reached"),
        Type.Literal("conflicting_sources"),
        Type.Literal("needs_user_source"),
      ]),
    ),
    history: Type.Optional(
      Type.Object(
        {
          consecutiveNoSignalRuns: Type.Optional(Type.Integer({ minimum: 0 })),
          escalationRuns: Type.Optional(Type.Integer({ minimum: 0 })),
          maxEscalations: Type.Optional(Type.Integer({ minimum: 0 })),
          lastSignalAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
          lastSignal: Type.Optional(NonEmptyString),
          repairAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
          maxRepairAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
          coordinationRuns: Type.Optional(Type.Integer({ minimum: 0 })),
          maxCoordinationRuns: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const CronTaskAdaptiveRunSampleSchema = Type.Object(
  {
    atMs: Type.Integer({ minimum: 0 }),
    status: CronRunStatusSchema,
    route: CronTaskAdaptiveRouteSchema,
    taskType: NonEmptyString,
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    totalTokens: Type.Optional(Type.Number({ minimum: 0 })),
    model: Type.Optional(NonEmptyString),
    provider: Type.Optional(NonEmptyString),
    resultSource: Type.Optional(
      Type.Union([Type.Literal("model"), Type.Literal("direct-tool"), Type.Literal("direct-text")]),
    ),
    resultAdapter: Type.Optional(NonEmptyString),
    modelUsed: Type.Optional(Type.Boolean()),
    deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    evaluatorAction: Type.Optional(
      Type.Union([
        Type.Literal("none"),
        Type.Literal("escalate"),
        Type.Literal("needs_access"),
        Type.Literal("request_sources"),
        Type.Literal("retry_sources"),
        Type.Literal("ask_agent"),
        Type.Literal("stop"),
      ]),
    ),
  },
  { additionalProperties: false },
);

const CronTaskAdaptiveRoutingDecisionSchema = Type.Object(
  {
    source: Type.Literal("history"),
    route: CronTaskAdaptiveRouteSchema,
    reason: NonEmptyString,
    confidence: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    ),
    taskType: NonEmptyString,
    sampleSize: Type.Integer({ minimum: 0 }),
    successRate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    failureRate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    averageDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
    averageTokens: Type.Optional(Type.Number({ minimum: 0 })),
    signals: Type.Optional(Type.Array(NonEmptyString)),
    createdAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const CronTaskAdaptiveRoutingStateSchema = Type.Object(
  {
    taskType: Type.Optional(NonEmptyString),
    samples: Type.Optional(Type.Array(CronTaskAdaptiveRunSampleSchema)),
    totalRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    successfulRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    failedRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    blockedRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    modelRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    noModelRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    skillOnlyRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    agentEvidenceRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    totalDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    totalTokens: Type.Optional(Type.Number({ minimum: 0 })),
    lastDecision: Type.Optional(CronTaskAdaptiveRoutingDecisionSchema),
  },
  { additionalProperties: false },
);

const CronTaskGraphRepairPlanSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("add_source"), Type.Literal("replace_source")]),
    nodeId: NonEmptyString,
    toolName: Type.Union([
      Type.Literal("web_search"),
      Type.Literal("web_fetch"),
      Type.Literal("gateway"),
      Type.Literal("wallet"),
      Type.Literal("mining"),
      Type.Literal("offers"),
    ]),
    reason: NonEmptyString,
    createdAtMs: Type.Integer({ minimum: 0 }),
    replacesNodeId: Type.Optional(NonEmptyString),
    graphRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    parentRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    repairRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    reusedNodeIds: Type.Optional(Type.Array(NonEmptyString)),
    invalidatedNodeIds: Type.Optional(Type.Array(NonEmptyString)),
    requeuedNodeIds: Type.Optional(Type.Array(NonEmptyString)),
    applied: Type.Optional(Type.Boolean()),
    applyReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CronTaskRepairStopSchema = Type.Object(
  {
    code: Type.Union([
      Type.Literal("insufficient_sources"),
      Type.Literal("source_access_missing"),
      Type.Literal("repair_limit_reached"),
      Type.Literal("conflicting_sources"),
      Type.Literal("needs_user_source"),
    ]),
    reason: NonEmptyString,
    atMs: Type.Integer({ minimum: 0 }),
    sourceNodeId: Type.Optional(NonEmptyString),
    sourceRole: Type.Optional(CronTaskSourceRoleSchema),
    limit: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const CronTaskGraphRepairReplaySchema = Type.Object(
  {
    runId: Type.Optional(NonEmptyString),
    parentRunId: Type.Optional(NonEmptyString),
    graphRevision: Type.Integer({ minimum: 0 }),
    parentRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    repairRevision: Type.Integer({ minimum: 0 }),
    repairAttempt: Type.Integer({ minimum: 0 }),
    maxRepairAttempts: Type.Integer({ minimum: 0 }),
    repairedAtMs: Type.Integer({ minimum: 0 }),
    reusedNodeIds: Type.Array(NonEmptyString),
    invalidatedNodeIds: Type.Array(NonEmptyString),
    requeuedNodeIds: Type.Array(NonEmptyString),
    reason: NonEmptyString,
  },
  { additionalProperties: false },
);

const CronTaskPendingEscalationSchema = Type.Object(
  {
    reason: NonEmptyString,
    signal: Type.Optional(NonEmptyString),
    createdAtMs: Type.Integer({ minimum: 0 }),
    sourceRunAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const CronTaskStopPolicySchema = Type.Object(
  {
    onSuccess: Type.Optional(Type.Boolean()),
    outputIncludes: Type.Optional(Type.Array(NonEmptyString)),
    maxSuccessfulRuns: Type.Optional(Type.Integer({ minimum: 1 })),
    maxTotalRuns: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const CronTaskCoordinationPolicySchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("none"), Type.Literal("consult"), Type.Literal("parallel")]),
    ),
    agents: Type.Optional(Type.Array(NonEmptyString)),
    maxAgents: Type.Optional(Type.Integer({ minimum: 1 })),
    maxRounds: Type.Optional(Type.Integer({ minimum: 1 })),
    requireApproval: Type.Optional(Type.Boolean()),
    stopWhenAdvisorsAgree: Type.Optional(Type.Boolean()),
    escalateWhenAdvisorsConflict: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const CronTaskExecutionPolicySchema = Type.Object(
  {
    objective: Type.Optional(NonEmptyString),
    successCriteria: Type.Optional(NonEmptyString),
    triggerKind: Type.Optional(CronTaskTriggerKindSchema),
    executionMode: Type.Optional(CronTaskExecutionModeSchema),
    memoryScope: Type.Optional(CronTaskMemoryScopeSchema),
    skillScope: Type.Optional(CronTaskSkillScopeSchema),
    allowedSkills: Type.Optional(Type.Array(NonEmptyString)),
    skillAction: Type.Optional(CronTaskSkillActionSchema),
    modelPolicy: Type.Optional(
      Type.Object(
        {
          mode: Type.Optional(
            Type.Union([
              Type.Literal("agent-default"),
              Type.Literal("task-override"),
              Type.Literal("auto"),
              Type.Literal("none"),
            ]),
          ),
          role: Type.Optional(
            Type.Union([
              Type.Literal("cheapCheck"),
              Type.Literal("strong"),
              Type.Literal("escalation"),
              Type.Literal("coding"),
              Type.Literal("summarizer"),
            ]),
          ),
          model: Type.Optional(NonEmptyString),
          thinking: Type.Optional(NonEmptyString),
          escalationModel: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
    coordination: Type.Optional(CronTaskCoordinationPolicySchema),
    budget: Type.Optional(
      Type.Object(
        {
          maxTokensPerRun: Type.Optional(Type.Number({ minimum: 0 })),
          maxCostUsdPerRun: Type.Optional(Type.Number({ minimum: 0 })),
          maxRunsPerHour: Type.Optional(Type.Number({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
    stop: Type.Optional(CronTaskStopPolicySchema),
    planner: Type.Optional(CronTaskPlannerDecisionSchema),
    evaluator: Type.Optional(CronTaskEvaluatorPolicySchema),
    repairPolicy: Type.Optional(CronTaskRepairPolicySchema),
  },
  { additionalProperties: false },
);

const CronRunPolicyTelemetrySchema = Type.Object(
  {
    objective: Type.Optional(Type.String()),
    successCriteria: Type.Optional(Type.String()),
    requestedExecutionMode: Type.Optional(CronTaskExecutionModeSchema),
    effectiveExecutionMode: Type.Optional(
      Type.Union([
        Type.Literal("agent-turn"),
        Type.Literal("skill-only"),
        Type.Literal("no-model"),
      ]),
    ),
    memoryScope: Type.Optional(CronTaskMemoryScopeSchema),
    skillScope: Type.Optional(CronTaskSkillScopeSchema),
    skills: Type.Optional(
      Type.Object(
        {
          count: Type.Integer({ minimum: 0 }),
          names: Type.Array(NonEmptyString),
          skillFilter: Type.Optional(Type.Array(NonEmptyString)),
        },
        { additionalProperties: false },
      ),
    ),
    modelPolicyMode: Type.Optional(
      Type.Union([
        Type.Literal("agent-default"),
        Type.Literal("task-override"),
        Type.Literal("auto"),
        Type.Literal("none"),
      ]),
    ),
    modelOverride: Type.Optional(NonEmptyString),
    escalationModel: Type.Optional(NonEmptyString),
    modelSource: Type.Optional(NonEmptyString),
    budget: Type.Optional(
      Type.Object(
        {
          maxTokensPerRun: Type.Optional(Type.Number({ minimum: 0 })),
          maxCostUsdPerRun: Type.Optional(Type.Number({ minimum: 0 })),
          maxRunsPerHour: Type.Optional(Type.Number({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
    stop: Type.Optional(CronTaskStopPolicySchema),
    planner: Type.Optional(CronTaskPlannerDecisionSchema),
    evaluator: Type.Optional(CronTaskEvaluatorDecisionSchema),
    adaptive: Type.Optional(CronTaskAdaptiveRoutingDecisionSchema),
    resultSource: Type.Optional(
      Type.Union([Type.Literal("model"), Type.Literal("direct-tool"), Type.Literal("direct-text")]),
    ),
    resultAdapter: Type.Optional(NonEmptyString),
    modelUsed: Type.Optional(Type.Boolean()),
    runCheckpoint: Type.Optional(
      Type.Object(
        {
          runId: Type.Optional(NonEmptyString),
          phase: Type.Optional(
            Type.Union([
              Type.Literal("reserved"),
              Type.Literal("running"),
              Type.Literal("finalizing"),
              Type.Literal("finished"),
              Type.Literal("recovered"),
            ]),
          ),
          trigger: Type.Optional(
            Type.Union([Type.Literal("schedule"), Type.Literal("startup"), Type.Literal("manual")]),
          ),
          attempt: Type.Optional(Type.Integer({ minimum: 0 })),
          startedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
          heartbeatAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
          leaseExpiresAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
          completedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
          recoveredAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
          reason: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const CronTaskRunCheckpointSchema = Type.Object(
  {
    runId: NonEmptyString,
    phase: Type.Union([
      Type.Literal("reserved"),
      Type.Literal("running"),
      Type.Literal("finalizing"),
    ]),
    trigger: Type.Union([
      Type.Literal("schedule"),
      Type.Literal("startup"),
      Type.Literal("manual"),
    ]),
    attempt: Type.Integer({ minimum: 0 }),
    startedAtMs: Type.Integer({ minimum: 0 }),
    heartbeatAtMs: Type.Integer({ minimum: 0 }),
    leaseExpiresAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const CronTaskRunCheckpointSummarySchema = Type.Object(
  {
    runId: Type.Optional(NonEmptyString),
    phase: Type.Optional(
      Type.Union([
        Type.Literal("reserved"),
        Type.Literal("running"),
        Type.Literal("finalizing"),
        Type.Literal("finished"),
        Type.Literal("recovered"),
      ]),
    ),
    trigger: Type.Optional(
      Type.Union([Type.Literal("schedule"), Type.Literal("startup"), Type.Literal("manual")]),
    ),
    attempt: Type.Optional(Type.Integer({ minimum: 0 })),
    startedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    heartbeatAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    leaseExpiresAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    completedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    recoveredAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const CronJobStateSchema = Type.Object(
  {
    nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    runningAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    activeRun: Type.Optional(CronTaskRunCheckpointSchema),
    lastRunCheckpoint: Type.Optional(CronTaskRunCheckpointSummarySchema),
    lastRecoveredRun: Type.Optional(CronTaskRunCheckpointSummarySchema),
    lastRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunStatus: Type.Optional(CronRunStatusSchema),
    lastStatus: Type.Optional(CronRunStatusSchema),
    lastError: Type.Optional(Type.String()),
    lastDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    consecutiveErrors: Type.Optional(Type.Integer({ minimum: 0 })),
    lastDelivered: Type.Optional(Type.Boolean()),
    lastDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    lastDeliveryError: Type.Optional(Type.String()),
    budgetWindowStartedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    budgetRunsInWindow: Type.Optional(Type.Integer({ minimum: 0 })),
    totalRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    successfulRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    stopReason: Type.Optional(Type.String()),
    needsAccess: Type.Optional(CronTaskAccessBlockSchema),
    pendingEscalation: Type.Optional(CronTaskPendingEscalationSchema),
    pendingCoordination: Type.Optional(CronTaskPendingCoordinationSchema),
    lastGraphRepair: Type.Optional(CronTaskGraphRepairPlanSchema),
    lastGraphRepairs: Type.Optional(Type.Array(CronTaskGraphRepairPlanSchema)),
    graphRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    repairRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    graphRepairAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
    graphRepairSourceAttempts: Type.Optional(
      Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
    ),
    graphRepairRoleAttempts: Type.Optional(
      Type.Partial(
        Type.Object(
          {
            primary: Type.Integer({ minimum: 0 }),
            verification: Type.Integer({ minimum: 0 }),
            enrichment: Type.Integer({ minimum: 0 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    lastGraphRepairStop: Type.Optional(CronTaskRepairStopSchema),
    lastGraphRepairReplay: Type.Optional(CronTaskGraphRepairReplaySchema),
    coordinationApprovedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastCoordinationEvidence: Type.Optional(
      Type.Array(
        Type.Object(
          {
            agentId: NonEmptyString,
            mode: Type.Union([
              Type.Literal("none"),
              Type.Literal("consult"),
              Type.Literal("parallel"),
            ]),
            status: Type.Union([
              Type.Literal("needs_approval"),
              Type.Literal("accepted"),
              Type.Literal("completed"),
              Type.Literal("forbidden"),
              Type.Literal("error"),
              Type.Literal("skipped"),
            ]),
            childSessionKey: Type.Optional(NonEmptyString),
            runId: Type.Optional(NonEmptyString),
            summary: Type.Optional(Type.String()),
            outputText: Type.Optional(Type.String()),
            error: Type.Optional(Type.String()),
            createdAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    evaluatorEscalationRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    evaluatorCoordinationRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    evaluatorConsecutiveNoSignalRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    evaluatorLastSignal: Type.Optional(NonEmptyString),
    evaluatorLastSignalAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastEvaluatorDecision: Type.Optional(CronTaskEvaluatorDecisionSchema),
    lastRunResultSource: Type.Optional(
      Type.Union([Type.Literal("model"), Type.Literal("direct-tool"), Type.Literal("direct-text")]),
    ),
    lastRunResultAdapter: Type.Optional(NonEmptyString),
    lastRunModelUsed: Type.Optional(Type.Boolean()),
    lastRunModelSource: Type.Optional(NonEmptyString),
    adaptiveRouting: Type.Optional(CronTaskAdaptiveRoutingStateSchema),
    lastRunSessionId: Type.Optional(NonEmptyString),
    lastRunSessionKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const CronJobSchema = Type.Object(
  {
    id: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    enabled: Type.Boolean(),
    deleteAfterRun: Type.Optional(Type.Boolean()),
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
    schedule: CronScheduleSchema,
    sessionTarget: CronSessionTargetSchema,
    wakeMode: CronWakeModeSchema,
    payload: CronPayloadSchema,
    delivery: Type.Optional(CronDeliverySchema),
    executionPolicy: Type.Optional(CronTaskExecutionPolicySchema),
    failureAlert: Type.Optional(Type.Union([CronFailureAlertSchema, Type.Literal(false)])),
    state: CronJobStateSchema,
  },
  { additionalProperties: false },
);

export const CronListParamsSchema = Type.Object(
  {
    includeDisabled: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    query: Type.Optional(Type.String()),
    enabled: Type.Optional(CronJobsEnabledFilterSchema),
    sortBy: Type.Optional(CronJobsSortBySchema),
    sortDir: Type.Optional(CronSortDirSchema),
  },
  { additionalProperties: false },
);

export const CronStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const CronAddParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    ...CronCommonOptionalFields,
    schedule: CronScheduleSchema,
    sessionTarget: CronSessionTargetSchema,
    wakeMode: CronWakeModeSchema,
    payload: CronPayloadSchema,
    delivery: Type.Optional(CronDeliverySchema),
    executionPolicy: Type.Optional(CronTaskExecutionPolicySchema),
  },
  { additionalProperties: false },
);

export const CronJobPatchSchema = Type.Object(
  {
    name: Type.Optional(NonEmptyString),
    ...CronCommonOptionalFields,
    schedule: Type.Optional(CronScheduleSchema),
    sessionTarget: Type.Optional(CronSessionTargetSchema),
    wakeMode: Type.Optional(CronWakeModeSchema),
    payload: Type.Optional(CronPayloadPatchSchema),
    delivery: Type.Optional(CronDeliveryPatchSchema),
    executionPolicy: Type.Optional(Type.Union([CronTaskExecutionPolicySchema, Type.Null()])),
    state: Type.Optional(Type.Partial(CronJobStateSchema)),
  },
  { additionalProperties: false },
);

export const CronUpdateParamsSchema = cronIdOrJobIdParams({
  patch: CronJobPatchSchema,
});

export const CronRemoveParamsSchema = cronIdOrJobIdParams({});

export const CronRunParamsSchema = cronIdOrJobIdParams({
  mode: Type.Optional(Type.Union([Type.Literal("due"), Type.Literal("force")])),
});

export const CronQueueControlParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CronTaskRepairRecoveryActionSchema = Type.Union([
  Type.Literal("configure_source"),
  Type.Literal("add_trusted_source"),
  Type.Literal("retry_replacement"),
  Type.Literal("stop_source_path"),
]);

export const CronRepairParamsSchema = cronIdOrJobIdParams({
  action: CronTaskRepairRecoveryActionSchema,
  source: Type.Optional(Type.String()),
  sourceNodeId: Type.Optional(Type.String()),
});

export const CronSourcesListParamsSchema = Type.Object(
  {
    includeInactive: Type.Optional(Type.Boolean()),
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    taskType: Type.Optional(NonEmptyString),
    query: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const CronSourcesUpdateParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    active: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CronSourcesRemoveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const CronRunDetailParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const CronRunsParamsSchema = Type.Object(
  {
    scope: Type.Optional(Type.Union([Type.Literal("job"), Type.Literal("all")])),
    id: Type.Optional(CronRunLogJobIdSchema),
    jobId: Type.Optional(CronRunLogJobIdSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    statuses: Type.Optional(Type.Array(CronRunsStatusValueSchema, { minItems: 1, maxItems: 4 })),
    status: Type.Optional(CronRunsStatusFilterSchema),
    deliveryStatuses: Type.Optional(
      Type.Array(CronDeliveryStatusSchema, { minItems: 1, maxItems: 4 }),
    ),
    deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    query: Type.Optional(Type.String()),
    sortDir: Type.Optional(CronSortDirSchema),
  },
  { additionalProperties: false },
);

export const CronRunLogEntrySchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    jobId: NonEmptyString,
    action: Type.Literal("finished"),
    status: Type.Optional(CronRunStatusSchema),
    error: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    delivered: Type.Optional(Type.Boolean()),
    deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    deliveryError: Type.Optional(Type.String()),
    sessionId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    runAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    model: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    usage: Type.Optional(
      Type.Object(
        {
          input_tokens: Type.Optional(Type.Number()),
          output_tokens: Type.Optional(Type.Number()),
          total_tokens: Type.Optional(Type.Number()),
          cache_read_tokens: Type.Optional(Type.Number()),
          cache_write_tokens: Type.Optional(Type.Number()),
        },
        { additionalProperties: false },
      ),
    ),
    policy: Type.Optional(CronRunPolicyTelemetrySchema),
    jobName: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
