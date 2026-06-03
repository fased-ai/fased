export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost"
  | "skipped"
  | "blocked";

export type TaskSource =
  | "cron"
  | "webhook"
  | "subagent"
  | "channel"
  | "CLI"
  | "media"
  | "wallet"
  | "marketplace"
  | "mining";

export type TaskRuntime =
  | "cron"
  | "webhook"
  | "subagent"
  | "acp"
  | "channel"
  | "cli"
  | "media"
  | "wallet"
  | "marketplace"
  | "mining";

export type TaskDeliveryStatus = "pending" | "delivered" | "not_delivered" | "not_applicable";

export type TaskNotifyPolicy = "silent" | "done_only" | "state_changes";

export type TaskScopeKind = "agent" | "session" | "channel" | "system";

export type TaskDefinitionKind = "task" | "trigger" | "workflow" | "graph";

export type TaskRegistryStepStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "blocked"
  | "cancelled"
  | "lost";

export type TaskRegistryStep = {
  id: string;
  label?: string;
  status: TaskRegistryStepStatus;
  attempt?: number;
  maxAttempts?: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt?: number;
  error?: string;
};

export type TaskUsageSummary = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  unpriced?: boolean;
};

export type TaskDeliverySummary = {
  channel?: string;
  target?: string;
  messageId?: string;
  deliveredAt?: number;
  error?: string;
};

export type TaskRecord = {
  taskId: string;
  runId?: string;
  source: TaskSource;
  runtime: TaskRuntime;
  taskKind?: string;
  sourceId?: string;
  rootTaskId?: string;
  parentTaskId?: string;
  correlationId?: string;
  definitionId?: string;
  definitionKind?: TaskDefinitionKind;
  workflowRunId?: string;
  workflowNodeId?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  model?: string;
  provider?: string;
  task: string;
  status: TaskStatus;
  deliveryStatus: TaskDeliveryStatus;
  notifyPolicy: TaskNotifyPolicy;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt?: number;
  progressSummary?: string;
  terminalSummary?: string;
  error?: string;
  scopeKind?: TaskScopeKind;
  memoryScope?: string;
  skillScope?: string;
  loadedSkills?: string[];
  loadedTools?: string[];
  toolCount?: number;
  delivery?: TaskDeliverySummary;
  usage?: TaskUsageSummary;
  steps?: TaskRegistryStep[];
  metadata?: Record<string, unknown>;
};

export type TaskAuditSeverity = "info" | "warn" | "error";

export type TaskAuditFinding = {
  code: string;
  severity: TaskAuditSeverity;
  message: string;
  taskId?: string;
  runId?: string;
  source?: TaskSource;
};

export type TaskLedgerSummary = {
  total: number;
  queued: number;
  running: number;
  terminal: number;
  failed: number;
  lost: number;
  bySource: Record<string, number>;
  byStatus: Record<string, number>;
};

export type TaskListResult = {
  generatedAt: number;
  total: number;
  offset?: number;
  limit?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
  tasks: TaskRecord[];
  summary: TaskLedgerSummary;
  audit?: {
    findings: TaskAuditFinding[];
  };
};

export type TaskRegistryStore = {
  version: 1;
  tasks: TaskRecord[];
};
