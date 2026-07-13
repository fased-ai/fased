export type UpdateAvailable = import("../../../src/infra/update-startup.js").UpdateAvailable;
import type { ConfigUiHints } from "../../../src/config/schema.hints.js";
import type { SessionEntry } from "../../../src/config/sessions.js";
export type { ConfigUiHint, ConfigUiHints } from "../../../src/config/schema.hints.js";
export type CapabilityReadinessEntry =
  import("../../../src/capabilities/catalog.js").CapabilityReadinessEntry;
export type CapabilityReadinessReport =
  import("../../../src/capabilities/catalog.js").CapabilityReadinessReport;
export type PluginMarketplaceAction =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceAction;
export type PluginMarketplaceMutationAction =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceMutationAction;
export type PluginMarketplaceAdminRpcActionMethod =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceAdminRpcActionMethod;
export type PluginMarketplaceAdminRpcActionGrantStatus =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceAdminRpcActionGrantStatus;
export type PluginMarketplaceAdminRpcActions =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceAdminRpcActions;
export type PluginMarketplaceChannelCatalogMeta =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceChannelCatalogMeta;
export type PluginMarketplaceDiagnostic =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceDiagnostic;
export type PluginMarketplaceEntry =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceEntry;
export type PluginMarketplaceMutationResult =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceMutationResult;
export type PluginMarketplaceUpdatePreviewResult =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceUpdatePreviewResult;
export type PluginMarketplaceUpdateReview =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceUpdateReview;
export type PluginMarketplaceInstallOptions =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceInstallOptions;
export type PluginMarketplaceInstallChoice =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceInstallChoice;
export type PluginMarketplaceInstallRecord =
  import("../../../src/gateway/protocol/schema/types.js").PluginMarketplaceInstallRecord;
export type PluginsMarketplaceInfoResult =
  import("../../../src/gateway/protocol/schema/types.js").PluginsMarketplaceInfoResult;
export type PluginsMarketplaceListResult =
  import("../../../src/gateway/protocol/schema/types.js").PluginsMarketplaceListResult;
export type ExtensionHookStatusEntry = {
  name: string;
  hookKey: string;
  description: string;
  source: string;
  pluginId?: string;
  emoji?: string;
  homepage?: string;
  events: string[];
  always: boolean;
  disabled: boolean;
  eligible: boolean;
  managedByPlugin: boolean;
  missing: string[];
  configChecks: Array<{ path: string; satisfied: boolean }>;
  install: Array<{ id: string; kind: string; label: string; bins: string[] }>;
};
export type ExtensionsHooksStatusResult = {
  agentId: string;
  workspaceDir: string;
  managedHooksDir: string;
  hooks: ExtensionHookStatusEntry[];
};
export type ExtensionsHookToggleResult = {
  changed: boolean;
  hookName: string;
  hookKey: string;
  enabled: boolean;
  report: ExtensionsHooksStatusResult;
};
export type WebSearchServiceProviderOption = {
  id: string;
  label: string;
  hint?: string;
  pluginId: string;
  envVars: string[];
  placeholder?: string;
  signupUrl?: string;
  credentialPath: string;
  requiresCredential: boolean;
};
export type WebSearchServiceProvidersResult = {
  providers: WebSearchServiceProviderOption[];
};
export type ModelsAuthStatusEffective =
  import("../../../src/gateway/protocol/schema/types.js").ModelsAuthStatusEffective;
export type ModelsAuthStoreMode =
  import("../../../src/gateway/protocol/schema/types.js").ModelsAuthStoreMode;
export type ModelsAuthStoreResult =
  import("../../../src/gateway/protocol/schema/types.js").ModelsAuthStoreResult;
export type ModelsAuthConfigureResult =
  import("../../../src/gateway/protocol/schema/types.js").ModelsAuthConfigureResult;
export type ModelsAuthClearResult =
  import("../../../src/gateway/protocol/schema/types.js").ModelsAuthClearResult;
export type ModelsAuthInteractiveStartResult =
  import("../../../src/gateway/protocol/schema/types.js").ModelsAuthInteractiveStartResult;
export type ModelsAuthStatusProfile =
  import("../../../src/gateway/protocol/schema/types.js").ModelsAuthStatusProfile;
export type ModelsAuthStatusProvider =
  import("../../../src/gateway/protocol/schema/types.js").ModelsAuthStatusProvider;
export type ModelsAuthStatusResult =
  import("../../../src/gateway/protocol/schema/types.js").ModelsAuthStatusResult;
export type ModelsCatalogStatusResult =
  import("../../../src/gateway/protocol/schema/types.js").ModelsCatalogStatusResult;
export type GatewayUpdateStatusResult =
  import("../../../src/gateway/update-status.js").GatewayUpdateStatusResult;
export type DiagnosticStabilitySnapshot =
  import("../../../src/logging/diagnostic-stability.js").DiagnosticStabilitySnapshot;
export type TaskRecord = import("../../../src/tasks/task-registry.types.js").TaskRecord;
export type TaskAuditFinding = import("../../../src/tasks/task-registry.types.js").TaskAuditFinding;
export type TaskListResult = import("../../../src/tasks/task-registry.types.js").TaskListResult;
export type TaskStatus = import("../../../src/tasks/task-registry.types.js").TaskStatus;
export type TaskSource = import("../../../src/tasks/task-registry.types.js").TaskSource;
export type TaskNotifyPolicy = import("../../../src/tasks/task-registry.types.js").TaskNotifyPolicy;
export type SavedTaskWorkflowDefinition =
  import("../../../src/tasks/workflow-definitions.js").SavedTaskWorkflowDefinition;
export type SavedTaskWorkflowDefinitionsResult =
  import("../../../src/tasks/workflow-definitions.js").SavedTaskWorkflowDefinitionsResult;
export type TaskFlowRecord = import("../../../src/tasks/task-flow-registry.js").TaskFlowRecord;
export type TaskFlowListResult =
  import("../../../src/tasks/task-flow-registry.js").TaskFlowListResult;
export type TaskWorkflowTemplate =
  import("../../../src/tasks/workflow-templates.js").TaskWorkflowTemplate;
export type TaskWorkflowTemplatesResult =
  import("../../../src/tasks/workflow-templates.js").TaskWorkflowTemplatesResult;
export type StandingOrderRecord =
  import("../../../src/tasks/standing-orders.js").StandingOrderRecord;
export type StandingOrdersResult =
  import("../../../src/tasks/standing-orders.js").StandingOrdersResult;
export type StandingOrderDraft = {
  id?: string;
  name: string;
  instructions: string;
  triggerHint: string;
  proposalKind: StandingOrderRecord["proposalKind"];
  status: StandingOrderRecord["status"];
};
export type TaskWorkflowGraphDefinition =
  import("../../../src/tasks/workflow-graph.js").TaskWorkflowGraphDefinition;
export type TaskWorkflowGraphNode =
  import("../../../src/tasks/workflow-graph.js").TaskWorkflowGraphNode;
export type TaskWorkflowGraphEdge =
  import("../../../src/tasks/workflow-graph.js").TaskWorkflowGraphEdge;
export type TaskWorkflowGraphNodeType =
  import("../../../src/tasks/workflow-graph.js").TaskWorkflowGraphNodeType;
export type TaskWorkflowGraphEdgeEvent =
  import("../../../src/tasks/workflow-graph.js").TaskWorkflowGraphEdgeEvent;
export type TaskWorkflowDraft = {
  id?: string;
  name: string;
  task: string;
  stepsText: string;
  notifyPolicy: TaskNotifyPolicy;
};
export type TaskWorkflowGraphRunState = Pick<
  TaskRecord,
  | "taskId"
  | "runId"
  | "source"
  | "runtime"
  | "taskKind"
  | "task"
  | "status"
  | "deliveryStatus"
  | "updatedAt"
  | "steps"
>;
export type TaskWorkflowGraphDraft = {
  id?: string;
  name: string;
  task: string;
  notifyPolicy: TaskNotifyPolicy;
  graph: TaskWorkflowGraphDefinition;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  connectFromNodeId: string | null;
  zoom: number;
  panX: number;
  panY: number;
  jsonText: string;
  jsonOpen: boolean;
  runState?: TaskWorkflowGraphRunState;
  sourceTask?: Pick<
    TaskRecord,
    | "taskId"
    | "runId"
    | "source"
    | "runtime"
    | "taskKind"
    | "task"
    | "sourceId"
    | "rootTaskId"
    | "parentTaskId"
    | "correlationId"
    | "definitionId"
    | "definitionKind"
    | "workflowRunId"
    | "workflowNodeId"
    | "agentId"
    | "sessionKey"
    | "requesterSessionKey"
    | "channel"
    | "metadata"
  >;
};
export type DoctorMemoryInventoryPayload =
  import("../../../src/memory/inventory.js").DoctorMemoryInventoryPayload;
export type DoctorMemoryRepairPreviewPayload =
  import("../../../src/memory/inventory.js").DoctorMemoryRepairPreviewPayload;
export type DoctorMemoryValidationPayload =
  import("../../../src/memory/inventory.js").DoctorMemoryValidationPayload;
export type MemoryWikiStatus = import("../../../src/memory/wiki.js").MemoryWikiStatus;
export type MemoryWikiBuildResult = import("../../../src/memory/wiki.js").MemoryWikiBuildResult;
export type CommandEntry = import("../../../src/gateway/protocol/schema/types.js").CommandEntry;
export type CommandsListResult =
  import("../../../src/gateway/protocol/schema/types.js").CommandsListResult;
export type WizardNextResult =
  import("../../../src/gateway/protocol/schema/types.js").WizardNextResult;
export type WizardStatusResult =
  import("../../../src/gateway/protocol/schema/types.js").WizardStatusResult;
export type WizardStep = import("../../../src/gateway/protocol/schema/types.js").WizardStep;

export type ChannelsStatusSnapshot = {
  ts: number;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  channelDetailLabels?: Record<string, string>;
  channelSystemImages?: Record<string, string>;
  channelMeta?: ChannelUiMetaEntry[];
  channelSetup?: Record<string, ChannelOnboardingUiSetup>;
  channels: Record<string, unknown>;
  channelAccounts: Record<string, ChannelAccountSnapshot[]>;
  channelDefaultAccountId: Record<string, string>;
};

export type ChannelOnboardingUiField = {
  label: string;
  path: Array<string | number>;
  placeholder?: string;
  kind?: "text" | "password" | "number" | "list" | "select" | "boolean";
  options?: Array<{ label: string; value: string }>;
};

export type ChannelOnboardingUiAccess =
  | { kind: "whatsapp-dm"; label?: string; note?: string }
  | { kind: "discord-channels"; label?: string; note?: string; placeholder?: string }
  | { kind: "slack-channels"; label?: string; note?: string; placeholder?: string }
  | { kind: "msteams-channels"; label?: string; note?: string; placeholder?: string }
  | { kind: "irc-channels"; label?: string; note?: string; placeholder?: string }
  | { kind: "matrix-rooms"; label?: string; note?: string; placeholder?: string }
  | { kind: "zalouser-groups"; label?: string; note?: string; placeholder?: string };

export type ChannelOnboardingUiDmPolicy = {
  label: string;
  policyKey: string;
  allowFromKey: string;
};

export type ChannelOnboardingUiSetup = {
  title: string;
  detail: string;
  notes?: string[];
  fields: ChannelOnboardingUiField[];
  qrLogin?: {
    startLabel?: string;
    waitLabel?: string;
    alt?: string;
  };
  access?: ChannelOnboardingUiAccess;
  dmPolicy?: ChannelOnboardingUiDmPolicy;
};

export type ChannelUiMetaEntry = {
  id: string;
  label: string;
  detailLabel: string;
  systemImage?: string;
};

export const CRON_CHANNEL_LAST = "last";

export type ChannelAccountSnapshot = {
  accountId: string;
  name?: string | null;
  enabled?: boolean | null;
  configured?: boolean | null;
  linked?: boolean | null;
  running?: boolean | null;
  connected?: boolean | null;
  reconnectAttempts?: number | null;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastProbeAt?: number | null;
  mode?: string | null;
  dmPolicy?: string | null;
  allowFrom?: string[] | null;
  tokenSource?: string | null;
  botTokenSource?: string | null;
  appTokenSource?: string | null;
  credentialSource?: string | null;
  audienceType?: string | null;
  audience?: string | null;
  webhookPath?: string | null;
  webhookUrl?: string | null;
  baseUrl?: string | null;
  allowUnmentionedGroups?: boolean | null;
  cliPath?: string | null;
  dbPath?: string | null;
  port?: number | null;
  probe?: unknown;
  audit?: unknown;
  application?: unknown;
};

export type WhatsAppSelf = {
  e164?: string | null;
  jid?: string | null;
};

export type WhatsAppDisconnect = {
  at: number;
  status?: number | null;
  error?: string | null;
  loggedOut?: boolean | null;
};

export type WhatsAppStatus = {
  configured: boolean;
  linked: boolean;
  authAgeMs?: number | null;
  self?: WhatsAppSelf | null;
  running: boolean;
  connected: boolean;
  lastConnectedAt?: number | null;
  lastDisconnect?: WhatsAppDisconnect | null;
  reconnectAttempts: number;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
};

export type TelegramBot = {
  id?: number | null;
  username?: string | null;
};

export type TelegramWebhook = {
  url?: string | null;
  hasCustomCert?: boolean | null;
};

export type TelegramProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  bot?: TelegramBot | null;
  webhook?: TelegramWebhook | null;
};

export type TelegramStatus = {
  configured: boolean;
  tokenSource?: string | null;
  running: boolean;
  mode?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: TelegramProbe | null;
  lastProbeAt?: number | null;
};

export type DiscordBot = {
  id?: string | null;
  username?: string | null;
};

export type DiscordProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  bot?: DiscordBot | null;
};

export type DiscordStatus = {
  configured: boolean;
  tokenSource?: string | null;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: DiscordProbe | null;
  lastProbeAt?: number | null;
};

export type GoogleChatProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
};

export type GoogleChatStatus = {
  configured: boolean;
  credentialSource?: string | null;
  audienceType?: string | null;
  audience?: string | null;
  webhookPath?: string | null;
  webhookUrl?: string | null;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: GoogleChatProbe | null;
  lastProbeAt?: number | null;
};

export type SlackBot = {
  id?: string | null;
  name?: string | null;
};

export type SlackTeam = {
  id?: string | null;
  name?: string | null;
};

export type SlackProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  bot?: SlackBot | null;
  team?: SlackTeam | null;
};

export type SlackStatus = {
  configured: boolean;
  botTokenSource?: string | null;
  appTokenSource?: string | null;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: SlackProbe | null;
  lastProbeAt?: number | null;
};

export type SignalProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  version?: string | null;
};

export type SignalStatus = {
  configured: boolean;
  baseUrl: string;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: SignalProbe | null;
  lastProbeAt?: number | null;
};

export type IMessageProbe = {
  ok: boolean;
  error?: string | null;
};

export type IMessageStatus = {
  configured: boolean;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  cliPath?: string | null;
  dbPath?: string | null;
  probe?: IMessageProbe | null;
  lastProbeAt?: number | null;
};

export type NostrProfile = {
  name?: string | null;
  displayName?: string | null;
  about?: string | null;
  picture?: string | null;
  banner?: string | null;
  website?: string | null;
  nip05?: string | null;
  lud16?: string | null;
};

export type NostrStatus = {
  configured: boolean;
  publicKey?: string | null;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  profile?: NostrProfile | null;
};

export type MSTeamsProbe = {
  ok: boolean;
  error?: string | null;
  appId?: string | null;
};

export type MSTeamsStatus = {
  configured: boolean;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  port?: number | null;
  probe?: MSTeamsProbe | null;
  lastProbeAt?: number | null;
};

export type ConfigSnapshotIssue = {
  path: string;
  message: string;
};

export type ConfigSnapshot = {
  path?: string | null;
  exists?: boolean | null;
  raw?: string | null;
  hash?: string | null;
  parsed?: unknown;
  valid?: boolean | null;
  config?: Record<string, unknown> | null;
  issues?: ConfigSnapshotIssue[] | null;
};

export type ConfigSchemaResponse = {
  schema: unknown;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

export type PresenceEntry = {
  instanceId?: string | null;
  host?: string | null;
  ip?: string | null;
  version?: string | null;
  runtimeSource?: string | null;
  platform?: string | null;
  deviceFamily?: string | null;
  modelIdentifier?: string | null;
  roles?: string[] | null;
  scopes?: string[] | null;
  mode?: string | null;
  lastInputSeconds?: number | null;
  reason?: string | null;
  text?: string | null;
  ts?: number | null;
};

export type GatewaySessionsDefaults = {
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
};

export type ChatModelOverride = import("./chat-model-ref.ts").ChatModelOverride;

export type GatewayAgentRow = {
  id: string;
  name?: string;
  workspace?: string;
  model?: unknown;
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
    avatarUrl?: string;
  };
};

export type AgentsListResult = {
  defaultId: string;
  mainKey: string;
  scope: string;
  agents: GatewayAgentRow[];
};

export type AgentIdentityResult = {
  agentId: string;
  name: string;
  avatar: string;
  emoji?: string;
};

export type AgentFileEntry = {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
  content?: string;
};

export type AgentsFilesListResult = {
  agentId: string;
  workspace: string;
  files: AgentFileEntry[];
};

export type AgentsFilesGetResult = {
  agentId: string;
  workspace: string;
  file: AgentFileEntry;
};

export type AgentsFilesSetResult = {
  ok: true;
  agentId: string;
  workspace: string;
  file: AgentFileEntry;
};

export type SessionRunStatus = "running" | "done" | "failed" | "killed" | "timeout";

export type GatewaySessionCompactionCheckpointSummary = {
  checkpointId: string;
  createdAt: number;
  reason: "manual" | "auto-threshold" | "overflow-retry" | "timeout-retry";
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
};

export type GatewaySessionRow = {
  key: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string;
  };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  channel?: string;
  subject?: string;
  groupChannel?: string;
  chatType?: string;
  origin?: {
    channel?: string;
    to?: string;
    accountId?: string;
    label?: string;
  };
  spawnedBy?: string;
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  surface?: string;
  room?: string;
  space?: string;
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  sendPolicy?: "allow" | "deny";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  responseUsage?: "on" | "off" | "tokens" | "full";
  status?: SessionRunStatus;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  childSessions?: string[];
  model?: string;
  modelProvider?: string;
  skills?: {
    count: number;
    names: string[];
    skillFilter?: string[];
  };
  contextTokens?: number;
  compactionCheckpointCount?: number;
  compactionCheckpoints?: GatewaySessionCompactionCheckpointSummary[];
  hasActiveRun?: boolean;
  activeRunIds?: string[];
};

export type SessionsListResult = {
  ts: number;
  path: string;
  count: number;
  totalCount?: number;
  limitApplied?: number;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
  defaults: GatewaySessionsDefaults;
  sessions: GatewaySessionRow[];
};

export type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: SessionEntry;
  resolved?: {
    modelProvider?: string;
    model?: string;
  };
};

export type {
  CostUsageDailyEntry,
  CostUsageSummary,
  SessionsUsageEntry,
  SessionsUsageResult,
  SessionsUsageTotals,
  SessionUsageTimePoint,
  SessionUsageTimeSeries,
} from "./usage-types.ts";

export type CronRunStatus = "ok" | "error" | "skipped" | "blocked";
export type CronDeliveryStatus = "delivered" | "not-delivered" | "unknown" | "not-requested";
export type CronJobsEnabledFilter = "all" | "enabled" | "disabled";
export type CronJobsSortBy = "nextRunAtMs" | "updatedAtMs" | "name";
export type CronRunScope = "job" | "all";
export type CronRunsStatusValue = CronRunStatus;
export type CronRunsStatusFilter = "all" | CronRunStatus;
export type CronSortDir = "asc" | "desc";
export type CronTaskAdaptiveRoute =
  | "agent-default"
  | "cheap-model"
  | "strong-model"
  | "skill-only"
  | "no-model"
  | "agent-evidence";

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number };

export type CronSessionTarget = "main" | "isolated" | "current" | `session:${string}`;
export type CronWakeMode = "next-heartbeat" | "now";

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | {
      kind: "agentTurn";
      message: string;
      model?: string;
      fallbacks?: string[];
      thinking?: string;
      timeoutSeconds?: number;
      allowUnsafeExternalContent?: boolean;
      lightContext?: boolean;
      deliver?: boolean;
      channel?: string;
      to?: string;
      bestEffortDeliver?: boolean;
    };

export type CronDelivery = {
  mode: "none" | "announce" | "webhook";
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
  failureDestination?: CronFailureDestination;
};

export type CronTaskExecutionPolicy = {
  objective?: string;
  successCriteria?: string;
  triggerKind?: "schedule" | "heartbeat" | "webhook" | "channel" | "manual" | "event";
  executionMode?: "auto" | "agent-turn" | "skill-only" | "no-model";
  memoryScope?: "none" | "session-summary" | "pinned" | "search" | "agent";
  skillScope?: "none" | "selected" | "agent-default";
  allowedSkills?: string[];
  skillAction?: {
    toolName: string;
    input?: Record<string, unknown>;
  };
  modelPolicy?: {
    mode?: "agent-default" | "task-override" | "auto" | "none";
    role?: "cheapCheck" | "strong" | "escalation" | "coding" | "summarizer";
    model?: string;
    thinking?: string;
    escalationModel?: string;
  };
  coordination?: {
    mode?: "none" | "consult" | "parallel";
    agents?: string[];
    maxAgents?: number;
    maxRounds?: number;
    requireApproval?: boolean;
    stopWhenAdvisorsAgree?: boolean;
    escalateWhenAdvisorsConflict?: boolean;
  };
  budget?: {
    maxTokensPerRun?: number;
    maxCostUsdPerRun?: number;
    maxRunsPerHour?: number;
  };
  stop?: {
    onSuccess?: boolean;
    outputIncludes?: string[];
    maxSuccessfulRuns?: number;
    maxTotalRuns?: number;
  };
  planner?: CronTaskPlannerDecision;
  evaluator?: {
    escalateOnSignal?: boolean;
    signalIncludes?: string[];
    maxEscalations?: number;
  };
  repairPolicy?: {
    autoRetryReplacement?: boolean;
    autoStopOptionalSources?: boolean;
    maxAutoRepairsPerRun?: number;
    requireApprovalForPrimarySource?: boolean;
  };
  trustedSources?: CronTaskTrustedSource[];
};

export type CronTaskSourceRole = "primary" | "verification" | "enrichment";
export type CronTaskSourceQualityBand = "high" | "medium" | "low" | "unavailable";

export type CronTaskTrustedSource = {
  id: string;
  source: string;
  kind: "url" | "note";
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

export type CronTaskWorkflowGraphNode = {
  id: string;
  label?: string;
  kind?: string;
  description?: string;
  dependsOn?: string[];
  optional?: boolean;
  sourceRole?: CronTaskSourceRole;
  sourcePriority?: number;
  sourceFreshness?: "static" | "runtime" | "live";
  sourceExpectedOutputType?: string;
  sourceUrl?: string;
  sourceText?: string;
  trustedSourceId?: string;
  sourceLabel?: string;
  usesModel?: boolean;
  usesTool?: boolean;
  retryable?: boolean;
  checkpointKeys?: string[];
};

export type CronTaskWorkflowGraph = {
  version?: 1;
  graphRevision?: number;
  parentRevision?: number;
  repairRevision?: number;
  entryNodeId?: string;
  terminalNodeIds?: string[];
  nodes: CronTaskWorkflowGraphNode[];
};

export type CronTaskPlannerDecision = {
  source: "heuristic";
  strategy: "agent-default" | "cheap-model" | "strong-model" | "skill-only" | "no-model";
  rationale: string;
  confidence?: "low" | "medium" | "high";
  signals?: string[];
  graph?: CronTaskWorkflowGraph;
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
  stopCode?:
    | "insufficient_sources"
    | "source_access_missing"
    | "repair_limit_reached"
    | "conflicting_sources"
    | "needs_user_source";
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

export type CronTaskAdaptiveRunSample = {
  atMs: number;
  route: CronTaskAdaptiveRoute;
  taskType: string;
  status: CronRunStatus;
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

export type CronRunResultSource = "model" | "direct-tool" | "direct-text";

export type CronTaskPendingEscalation = {
  reason: string;
  signal?: string;
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

export type CronFailureDestination = {
  channel?: string;
  to?: string;
  mode?: "announce" | "webhook";
  accountId?: string;
};

export type CronFailureAlert = {
  after?: number;
  channel?: string;
  to?: string;
  cooldownMs?: number;
  mode?: "announce" | "webhook";
  accountId?: string;
};

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: CronRunStatus;
  lastStatus?: CronRunStatus;
  lastError?: string;
  lastErrorReason?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  lastDelivered?: boolean;
  lastDeliveryStatus?: CronDeliveryStatus;
  lastDeliveryError?: string;
  lastFailureAlertAtMs?: number;
  budgetWindowStartedAtMs?: number;
  budgetRunsInWindow?: number;
  totalRuns?: number;
  successfulRuns?: number;
  stopReason?: string;
  needsAccess?: {
    code: string;
    service?: string;
    reason: string;
    setupCommand?: string;
    setupPath?: string;
    source?: "preflight" | "run-output";
    detectedAtMs?: number;
  };
  pendingEscalation?: CronTaskPendingEscalation;
  pendingCoordination?: {
    reason: string;
    signal?: string;
    agents: string[];
    mode?: "none" | "consult" | "parallel";
    createdAtMs: number;
    sourceRunAtMs: number;
  };
  lastGraphRepair?: CronTaskGraphRepairPlan & { applied?: boolean };
  lastGraphRepairs?: Array<CronTaskGraphRepairPlan & { applied?: boolean; applyReason?: string }>;
  graphRevision?: number;
  repairRevision?: number;
  graphRepairAttempts?: number;
  graphRepairSourceAttempts?: Record<string, number>;
  graphRepairRoleAttempts?: Partial<Record<"primary" | "verification" | "enrichment", number>>;
  lastGraphRepairStop?: {
    code:
      | "insufficient_sources"
      | "source_access_missing"
      | "repair_limit_reached"
      | "conflicting_sources"
      | "needs_user_source";
    reason: string;
    atMs: number;
    sourceNodeId?: string;
    sourceRole?: "primary" | "verification" | "enrichment";
    limit?: number;
  };
  lastGraphRepairReplay?: CronTaskGraphRepairReplay;
  coordinationApprovedAtMs?: number;
  lastCoordinationEvidence?: Array<{
    agentId: string;
    mode: "none" | "consult" | "parallel";
    status: "needs_approval" | "accepted" | "completed" | "forbidden" | "error" | "skipped";
    childSessionKey?: string;
    runId?: string;
    summary?: string;
    outputText?: string;
    error?: string;
    createdAtMs?: number;
  }>;
  evaluatorEscalationRuns?: number;
  evaluatorCoordinationRuns?: number;
  evaluatorSourceRetryRuns?: number;
  lastEvaluatorDecision?: CronTaskEvaluatorDecision;
  adaptiveRouting?: CronTaskAdaptiveRoutingState;
  lastRunResultSource?: CronRunResultSource;
  lastRunResultAdapter?: string;
  lastRunModelUsed?: boolean;
  lastRunModelSource?: string;
  lastRunCheckpoint?: {
    runId?: string;
    phase?: string;
    trigger?: string;
    attempt?: number;
    startedAtMs?: number;
    heartbeatAtMs?: number;
    leaseExpiresAtMs?: number;
    completedAtMs?: number;
    recoveredAtMs?: number;
    reason?: string;
  };
  lastRunSessionId?: string;
  lastRunSessionKey?: string;
};

export type CronJob = {
  id: string;
  agentId?: string;
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
  state?: CronJobState;
};

export type CronStatus = {
  enabled: boolean;
  jobs: number;
  nextWakeAtMs?: number | null;
  queue?: {
    path: string;
    total: number;
    queued: number;
    running: number;
    terminal: number;
    cancelRequested: number;
    expiredLeases: number;
    byStatus?: Record<string, number>;
    workers: Array<{
      workerId: string;
      running: number;
      expired: number;
      runIds: string[];
      nextLeaseExpiresAtMs?: number;
      lastLeaseAtMs?: number;
    }>;
    activeRuns: Array<{
      runId: string;
      jobId: string;
      jobName: string;
      agentId?: string;
      sessionKey?: string;
      status: string;
      stepId: string;
      attempt: number;
      maxAttempts: number;
      leaseOwner?: string;
      leaseExpiresAtMs?: number;
      leaseExpired: boolean;
      queuedAtMs: number;
      startedAtMs?: number;
      updatedAtMs: number;
    }>;
    recentRuns: Array<{
      runId: string;
      jobId: string;
      jobName: string;
      agentId?: string;
      sessionKey?: string;
      status: string;
      error?: string;
      resultStatus?: string;
      queuedAtMs: number;
      startedAtMs?: number;
      completedAtMs?: number;
      updatedAtMs: number;
    }>;
  };
};

export type WebhookTrigger = {
  id: string;
  enabled: boolean;
  name: string;
  path: string;
  urlPath: string;
  action: "agent" | "wake" | "workflow";
  agentId?: string;
  wakeMode: "now" | "next-heartbeat";
  messageTemplate?: string;
  textTemplate?: string;
  workflowDefinitionId?: string;
  deliver: boolean;
  channel: string;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  notifyPolicy: "silent" | "done_only" | "state_changes";
  allowUnsafeExternalContent: boolean;
};

export type WebhookTriggersResult = {
  enabled: boolean;
  basePath: string;
  hasToken: boolean;
  tokenCreated?: boolean;
  token?: string;
  changed?: boolean;
  removed?: boolean;
  triggers: WebhookTrigger[];
};

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action?: "finished";
  status?: CronRunStatus;
  durationMs?: number;
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  policy?: {
    objective?: string;
    successCriteria?: string;
    requestedExecutionMode?: "auto" | "agent-turn" | "skill-only" | "no-model";
    effectiveExecutionMode?: "agent-turn" | "skill-only" | "no-model";
    memoryScope?: "none" | "session-summary" | "pinned" | "search" | "agent";
    skillScope?: "none" | "selected" | "agent-default";
    skills?: {
      count: number;
      names: string[];
      skillFilter?: string[];
    };
    modelPolicyMode?: "agent-default" | "task-override" | "auto" | "none";
    modelOverride?: string;
    escalationModel?: string;
    modelSource?: string;
    budget?: {
      maxTokensPerRun?: number;
      maxCostUsdPerRun?: number;
      maxRunsPerHour?: number;
    };
    stop?: {
      onSuccess?: boolean;
      outputIncludes?: string[];
      maxSuccessfulRuns?: number;
      maxTotalRuns?: number;
    };
    planner?: CronTaskPlannerDecision;
    evaluator?: CronTaskEvaluatorDecision;
    resultSource?: CronRunResultSource;
    resultAdapter?: string;
    modelUsed?: boolean;
  };
  jobName?: string;
};

export type CronJobsListResult = {
  jobs: CronJob[];
  total?: number;
  limit?: number;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
};

export type CronRunsResult = {
  entries: CronRunLogEntry[];
  total?: number;
  limit?: number;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
};

export type CronTaskRunDetail = import("../../../src/cron/run-detail.js").CronTaskRunDetail;

export type SkillsStatusConfigCheck = {
  path: string;
  satisfied: boolean;
};

export type SkillInstallOption = {
  id: string;
  kind: "brew" | "node" | "go" | "uv" | "download";
  label: string;
  bins: string[];
  external?: boolean;
  pinned?: boolean;
  integrityPinned?: boolean;
  trustWarnings?: string[];
  plan?: {
    manager: string;
    packageRef: string;
    command: string[] | null;
    commandPreview: string;
    toolchainAvailable: boolean;
    toolchainMessage?: string;
    pathTargets: string[];
    bins: Array<{
      bin: string;
      available: boolean;
      outsidePath?: string;
      pathTargets: string[];
    }>;
  };
};

export type SkillMarketplaceStatus = {
  source: "clawhub";
  registry: string;
  slug: string;
  installedVersion: string;
  installedAt: number;
  requestedRisky: boolean;
  requestedWalletActions: boolean;
  requestedToolAccess: string[];
  requestedInstallKinds: string[];
  scanBlocked: boolean;
  scanWarnings: number;
  scanBlocks: number;
  updateApprovalRequired: boolean;
  updateReviewReasons: string[];
};

export type SkillConfigFieldSpec = {
  key?: string;
  path?: string;
  label?: string;
  type?: "string" | "secret" | "number" | "boolean" | "textarea";
  placeholder?: string;
  required?: boolean;
};

export type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
  skillKey: string;
  bundled?: boolean;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: {
    bins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  configChecks: SkillsStatusConfigCheck[];
  configFields?: SkillConfigFieldSpec[];
  install: SkillInstallOption[];
  marketplace?: SkillMarketplaceStatus;
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
};

export type StatusSummary = Record<string, unknown>;

export type HealthSnapshot = Record<string, unknown>;

/** Strongly-typed health response from the gateway (richer than HealthSnapshot). */
export type HealthSummary = {
  ok: boolean;
  ts: number;
  durationMs: number;
  heartbeatSeconds: number;
  defaultAgentId: string;
  agents: Array<{ id: string; name?: string }>;
  sessions: {
    path: string;
    count: number;
    recent: Array<{
      key: string;
      updatedAt: number | null;
      age: number | null;
    }>;
  };
};

/** A model entry returned by the gateway model-catalog endpoint. */
export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "document">;
  baseUrl?: string;
  api?: string;
  catalogSource?:
    | "configured"
    | "runtime"
    | "provider-api"
    | "current-preview"
    | "provider-index"
    | "manifest";
  available?: boolean;
  runnable?: boolean;
  recommended?: boolean;
  assignedRoles?: Array<
    "primary" | "fallback" | "cheapCheck" | "strong" | "escalation" | "coding" | "summarizer"
  >;
  metadata?: {
    ref?: string;
    provider: string;
    publicProviderId?: string;
    publicProviderLabel?: string;
    model: string;
    label: string;
    contextWindow?: number;
    maxTokens?: number;
    apiRoute?: string;
    features: Array<
      "text" | "vision" | "reasoning" | "tools" | "json" | "audio" | "video" | "speech"
    >;
    thinkingLevels?: Array<
      "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    >;
    defaultThinkingLevel?:
      | "off"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | "max"
      | "ultra";
    thinkingMode?:
      | "openai-reasoning-effort"
      | "anthropic-thinking-budget"
      | "anthropic-adaptive"
      | "google-thinking-budget"
      | "xai-reasoning-effort"
      | "xai-multi-agent-effort"
      | "mistral-reasoning-effort"
      | "volcengine-reasoning-effort"
      | "byteplus-thinking-type"
      | "zai-binary"
      | "qwen-thinking"
      | "moonshot-thinking"
      | "generic-reasoning";
    reasoningBudgetSupported?: boolean;
    streaming: boolean;
    capabilityConfidence: "verified" | "declared" | "inferred" | "unknown";
    capabilitySource?:
      | "provider-api"
      | "official-docs"
      | "runtime"
      | "configured"
      | "inferred"
      | "unknown";
    capabilityRetrievedAt?: string;
    retrievedAt?: string;
    availabilitySource?:
      | "provider-api"
      | "runtime-catalog"
      | "configured"
      | "provider-plugin"
      | "reviewed-catalog"
      | "curated-recommendation";
    authRoute?: string;
    authMode: string;
    credentialRoute?: {
      id: string;
      label: string;
      authMode: string;
    };
    price?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      unit: "usd-per-million-tokens";
    };
    privateNetwork: boolean;
    privateNetworkAllowed: boolean;
    recommended?: boolean;
    recommendationRank?: number;
    default?: boolean;
  };
};

export type ModelCatalogSnapshot = {
  generatedAt?: string;
  agentId?: string;
  models: ModelCatalogEntry[];
  providers?: Array<{
    id: string;
    label: string;
    routes: string[];
    credentialRoutes: Array<{ id: string; label: string; authMode: string }>;
    available: number;
    recommended: number;
    assigned: number;
  }>;
  assignments?: Array<{
    role: "primary" | "fallback" | "cheapCheck" | "strong" | "escalation" | "coding" | "summarizer";
    ref: string;
    available: boolean;
  }>;
};

export type ToolCatalogProfile =
  import("../../../src/gateway/protocol/schema/types.js").ToolCatalogProfile;
export type ToolCatalogEntry =
  import("../../../src/gateway/protocol/schema/types.js").ToolCatalogEntry;
export type ToolCatalogGroup =
  import("../../../src/gateway/protocol/schema/types.js").ToolCatalogGroup;
export type ToolsCatalogResult =
  import("../../../src/gateway/protocol/schema/types.js").ToolsCatalogResult;
export type ToolsEffectiveEntry = {
  id: string;
  label: string;
  description?: string | null;
  rawDescription?: string | null;
  source: "core" | "plugin" | "channel";
  pluginId?: string | null;
  channelId?: string | null;
};
export type ToolsEffectiveGroup = {
  id: string;
  label: string;
  source?: string | null;
  pluginId?: string | null;
  channelId?: string | null;
  tools: ToolsEffectiveEntry[];
};
export type ToolsEffectiveResult = {
  agentId: string;
  profile?: string | null;
  groups: ToolsEffectiveGroup[];
};

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogEntry = {
  raw: string;
  time?: string | null;
  level?: LogLevel | null;
  subsystem?: string | null;
  message?: string | null;
  meta?: Record<string, unknown> | null;
};

// ── Attention ───────────────────────────────────────

export type AttentionSeverity = "error" | "warning" | "info";

export type AttentionItem = {
  severity: AttentionSeverity;
  icon: string;
  title: string;
  description: string;
  href?: string;
  external?: boolean;
};
