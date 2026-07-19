import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  handleChannelInstall as handleChannelInstallInternal,
  cancelChannelConfirmAction as cancelChannelConfirmActionInternal,
  confirmChannelAction as confirmChannelActionInternal,
  handleChannelEnable as handleChannelEnableInternal,
  handleChannelLogout as handleChannelLogoutInternal,
  handleChannelConfigReload as handleChannelConfigReloadInternal,
  handleChannelConfigSave as handleChannelConfigSaveInternal,
  handleNostrProfileCancel as handleNostrProfileCancelInternal,
  handleNostrProfileEdit as handleNostrProfileEditInternal,
  handleNostrProfileFieldChange as handleNostrProfileFieldChangeInternal,
  handleNostrProfileImport as handleNostrProfileImportInternal,
  handleNostrProfileSave as handleNostrProfileSaveInternal,
  handleNostrProfileToggleAdvanced as handleNostrProfileToggleAdvancedInternal,
  handleChannelQrStart as handleChannelQrStartInternal,
  handleChannelQrWait as handleChannelQrWaitInternal,
  handleWhatsAppLogout as handleWhatsAppLogoutInternal,
  handleWhatsAppStart as handleWhatsAppStartInternal,
  handleWhatsAppWait as handleWhatsAppWaitInternal,
  type ChannelConfirmAction,
} from "./app-channels.ts";
import {
  handleAbortChat as handleAbortChatInternal,
  handleSendChat as handleSendChatInternal,
  removeQueuedMessage as removeQueuedMessageInternal,
} from "./app-chat.ts";
import { DEFAULT_CRON_FORM, DEFAULT_LOG_LEVEL_FILTERS } from "./app-defaults.ts";
import type { EventLogEntry } from "./app-events.ts";
import { connectGateway as connectGatewayInternal } from "./app-gateway.ts";
import {
  handleConnected,
  handleDisconnected,
  handleFirstUpdated,
  handleUpdated,
} from "./app-lifecycle.ts";
import { renderApp } from "./app-render.ts";
import {
  exportLogs as exportLogsInternal,
  handleChatScroll as handleChatScrollInternal,
  handleLogsScroll as handleLogsScrollInternal,
  resetChatScroll as resetChatScrollInternal,
  scheduleChatScroll as scheduleChatScrollInternal,
} from "./app-scroll.ts";
import {
  applySettings as applySettingsInternal,
  applySettingsFromUrl as applySettingsFromUrlInternal,
  loadCron as loadCronInternal,
  loadOverview as loadOverviewInternal,
  setTab as setTabInternal,
  setTheme as setThemeInternal,
  onPopState as onPopStateInternal,
} from "./app-settings.ts";
import {
  resetToolStream as resetToolStreamInternal,
  type ToolStreamEntry,
  type CompactionStatus,
  type FallbackStatus,
} from "./app-tool-stream.ts";
import type { AppViewState } from "./app-view-state.ts";
import { resolveInjectedAssistantIdentity } from "./assistant-identity.ts";
import { markControlUiBootStage } from "./boot-state.ts";
import type { ChatModelOverride } from "./chat-model-ref.ts";
import {
  exchangeControlUiGatewayToken,
  exchangeControlUiLoginGrant,
  revokeControlUiSessionToken,
} from "./control-ui-login.ts";
import { loadAssistantIdentity as loadAssistantIdentityInternal } from "./controllers/assistant-identity.ts";
import type { CommandsCatalogScope } from "./controllers/commands.ts";
import { DEFAULT_CHAT_SCHEDULE_DRAFT } from "./controllers/cron.ts";
import type { DevicePairingList } from "./controllers/devices.ts";
import type { DreamingStatus } from "./controllers/dreaming.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./controllers/exec-approvals.ts";
import {
  attestFederation as attestFederationInternal,
  applyMarketplaceServiceKindDraft as applyMarketplaceServiceKindDraftInternal,
  cancelFederationBondUnlock as cancelFederationBondUnlockInternal,
  cancelMarketplaceEscrowOrder as cancelMarketplaceEscrowOrderInternal,
  claimFederationBondStaking as claimFederationBondStakingInternal,
  cancelLocalFederationOfferDraft as cancelLocalFederationOfferDraftInternal,
  clearFederationBondWallet as clearFederationBondWalletInternal,
  createMarketplaceOrderFromIndexEntry as createMarketplaceOrderFromIndexEntryInternal,
  createMarketplaceOrderFromLocalRequest as createMarketplaceOrderFromLocalRequestInternal,
  createMarketplaceOrderFromSelectedOffer as createMarketplaceOrderFromSelectedOfferInternal,
  deleteLocalMarketplaceOrder as deleteLocalMarketplaceOrderInternal,
  deleteLocalMarketplaceRequest as deleteLocalMarketplaceRequestInternal,
  deleteLocalFederationOffer as deleteLocalFederationOfferInternal,
  deliverMarketplaceManualOrder as deliverMarketplaceManualOrderInternal,
  fundMarketplaceEscrowOrder as fundMarketplaceEscrowOrderInternal,
  finalizeFederationBondUnlock as finalizeFederationBondUnlockInternal,
  increaseFederationBond as increaseFederationBondInternal,
  initFederationBondStaking as initFederationBondStakingInternal,
  loadFederation as loadFederationInternal,
  loadLocalFederationOffers as loadLocalFederationOffersInternal,
  loadLocalMarketplaceOrders as loadLocalMarketplaceOrdersInternal,
  loadLocalMarketplaceRequests as loadLocalMarketplaceRequestsInternal,
  loadFederationOfferReputation as loadFederationOfferReputationInternal,
  loadFederationOffers as loadFederationOffersInternal,
  loadMarketplaceFederationIndex as loadMarketplaceFederationIndexInternal,
  loadFederationOperatorEconomy as loadFederationOperatorEconomyInternal,
  loadFederationOperatorDisputes as loadFederationOperatorDisputesInternal,
  loadFederationDisputeNotaryAttestations as loadFederationDisputeNotaryAttestationsInternal,
  openMarketplaceSellerProfile as openMarketplaceSellerProfileInternal,
  openMarketplaceIndexOrderFeedback as openMarketplaceIndexOrderFeedbackInternal,
  openFederationBond as openFederationBondInternal,
  payMarketplaceManualOrder as payMarketplaceManualOrderInternal,
  previewMarketplaceFederationIndex as previewMarketplaceFederationIndexInternal,
  publishMarketplaceFederationIndex as publishMarketplaceFederationIndexInternal,
  publishFederationDispute as publishFederationDisputeInternal,
  publishFederationDisputeNotaryAttestation as publishFederationDisputeNotaryAttestationInternal,
  publishFederationReview as publishFederationReviewInternal,
  registerFederationHandle as registerFederationHandleInternal,
  requestFederationBondUnlock as requestFederationBondUnlockInternal,
  reviewFederationDispute as reviewFederationDisputeInternal,
  reviewFederationDirectoryEntry as reviewFederationDirectoryEntryInternal,
  releaseMarketplaceEscrowOrder as releaseMarketplaceEscrowOrderInternal,
  refundMarketplaceEscrowOrder as refundMarketplaceEscrowOrderInternal,
  runFederationContentSummarize as runFederationContentSummarizeInternal,
  runPaidFederationContentSummarize as runPaidFederationContentSummarizeInternal,
  runPaidFederationContentSummarizeOrder as runPaidFederationContentSummarizeOrderInternal,
  runMarketplaceCapabilityOrder as runMarketplaceCapabilityOrderInternal,
  saveMarketplaceOrderDeliveryTarget as saveMarketplaceOrderDeliveryTargetInternal,
  saveLocalFederationOffer as saveLocalFederationOfferInternal,
  setFederationBondWallet as setFederationBondWalletInternal,
  selectFederationOffer as selectFederationOfferInternal,
  startLocalFederationOfferDraft as startLocalFederationOfferDraftInternal,
  startLocalMarketplaceRequestDraft as startLocalMarketplaceRequestDraftInternal,
  submitFederationBondProof as submitFederationBondProofInternal,
  syncFederationBondStaking as syncFederationBondStakingInternal,
  toggleLocalMarketplaceRequest as toggleLocalMarketplaceRequestInternal,
  toggleLocalFederationOffer as toggleLocalFederationOfferInternal,
  renewFederationToken as renewFederationTokenInternal,
  revokeFederationToken as revokeFederationTokenInternal,
} from "./controllers/federation.ts";
import {
  loadMemory as loadMemoryInternal,
  rebuildMemoryWiki as rebuildMemoryWikiInternal,
} from "./controllers/memory.ts";
import {
  clearMiningHistory as clearMiningHistoryInternal,
  deleteSavedMiningProfile,
  depositMiningCapital as depositMiningCapitalInternal,
  exportMiningSupportBundle,
  loadMining as loadMiningInternal,
  loadMiningHistory as loadMiningHistoryInternal,
  loadSavedMiningProfileIntoForm,
  persistMiningRecoveryDraft,
  resetMiningRecoveryDraft,
  resetMiningRecoveryToSelectedCandidate,
  republishMiningRoots as republishMiningRootsInternal,
  resolveMiningDispute as resolveMiningDisputeInternal,
  retryMiningClaim as retryMiningClaimInternal,
  saveMiningProfile as saveMiningProfileInternal,
  saveCurrentMiningProfileLocally,
  setMiningActiveCommit as setMiningActiveCommitInternal,
  startMining as startMiningInternal,
  stopMining as stopMiningInternal,
  syncMiningMainnet as syncMiningMainnetInternal,
  topUpMiningReserve as topUpMiningReserveInternal,
  withdrawMiningCapital as withdrawMiningCapitalInternal,
} from "./controllers/mining.ts";
import type { PluginsMarketplaceRemediationState } from "./controllers/plugins-marketplace.ts";
import type {
  ClawHubMarketplaceReview,
  ClawHubInstallTargetValue,
  ClawHubSearchResult,
  ClawHubSkillDetail,
  SkillCreateTemplate,
  SkillMessage,
} from "./controllers/skills.ts";
import {
  clearWalletSkillGrant,
  createEmptyWalletSkillGrantDraft,
  draftFromWalletSkillRow,
  loadWalletSkillGrants,
  patchWalletSkillGrantDraft,
  saveWalletSkillGrant,
  toggleWalletSkillGrantAction,
  type WalletSkillGrantDraft,
  type WalletSkillGrantRow,
} from "./controllers/wallet-skill-grants.ts";
import { loadWallet as loadWalletInternal } from "./controllers/wallet.ts";
import {
  loadWebhookTriggers as loadWebhookTriggersInternal,
  removeWebhookTrigger as removeWebhookTriggerInternal,
  saveWebhookTrigger as saveWebhookTriggerInternal,
  testWebhookTrigger as testWebhookTriggerInternal,
  triggerToDraft,
  type WebhookTriggerDraft,
} from "./controllers/webhook-triggers.ts";
import {
  loadDashboardLayout,
  saveDashboardLayout,
  type DashboardLayout,
} from "./dashboard-layout.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import {
  createDefaultMinerProfile,
  riskModeToStrategyPreset,
  strategyExecutionToMode,
  strategyModeToExecution,
  strategyPresetToRiskMode,
  type MiningUiNotification,
  type SatMainnetSyncStatus,
  type SatMinerProfile,
  type SatMiningHistory,
  type SatMiningReadiness,
  type SatMiningRecoverySummary,
  type SatMiningRuntimeStatus,
  type SatMiningWalletOption,
} from "./mining-api.ts";
import { normalizeMiningCommitLamports } from "./mining-commit.ts";
import type { SavedMiningProfile } from "./mining-profiles.ts";
import type { Tab } from "./navigation.ts";
import {
  buildNotificationDeliveryText,
  isNotificationRoutingEnabled,
  resolveNotificationRouteDefaults,
  resolveNotificationRouteTarget,
  type AppNotification,
  type NotificationCategory,
  type NotificationCode,
  type NotificationLevel,
  type NotificationRouteStatus,
} from "./notifications.ts";
import { installGlobalSelectEnhancer } from "./select-enhancer.ts";
import { loadSettings, type UiSettings } from "./storage.ts";
import type { ResolvedTheme, ThemeMode } from "./theme.ts";
import type {
  AgentsListResult,
  AgentsFilesListResult,
  AgentIdentityResult,
  ConfigSnapshot,
  ConfigUiHints,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  GatewayUpdateStatusResult,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  ModelCatalogEntry,
  ModelsCatalogStatusResult,
  PresenceEntry,
  PluginsMarketplaceInfoResult,
  PluginsMarketplaceListResult,
  PluginMarketplaceMutationAction,
  ExtensionsHooksStatusResult,
  ChannelsStatusSnapshot,
  CommandsListResult,
  DiagnosticStabilitySnapshot,
  DoctorMemoryInventoryPayload,
  DoctorMemoryRepairPreviewPayload,
  DoctorMemoryValidationPayload,
  MemoryWikiStatus,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
  SavedTaskWorkflowDefinition,
  SavedTaskWorkflowDefinitionsResult,
  StandingOrderDraft,
  StandingOrderRecord,
  StandingOrdersResult,
  TaskFlowListResult,
  TaskFlowRecord,
  TaskListResult,
  TaskRecord,
  TaskWorkflowDraft,
  TaskWorkflowTemplate,
  TaskWorkflowTemplatesResult,
  TaskWorkflowGraphDraft,
  TaskWorkflowGraphEdge,
  TaskWorkflowGraphEdgeEvent,
  TaskWorkflowGraphNode,
  TaskWorkflowGraphNodeType,
  TaskWorkflowGraphRunState,
  NostrProfile,
  WebhookTrigger,
  WebhookTriggersResult,
} from "./types.ts";
import { type ChatAttachment, type ChatQueueItem, type CronFormState } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form.ts";
import {
  approveWalletSend,
  createWalletNamedWallet,
  updateWalletNamedWallet,
  createWalletSendRequest,
  deleteWalletAssignment,
  deleteWalletNamedWallet,
  deleteWalletPasskey,
  deleteWalletProviderCredentialsFor,
  executeWalletStandardSend,
  finishWalletSignerReviewApproval,
  rejectWalletSend,
  searchWalletSolanaTokens,
  signerAuthorizationMatchesWalletApproval,
  patchWalletSettings,
  patchWalletProvider,
  putWalletProviderCredentials,
  getWalletSignerDoctor,
  getWalletBalances,
  upsertWalletAssignment,
  validateWalletSettings,
  type WalletNamedWallet,
  type WalletApprovalFilter,
  type WalletAuditEntry,
  type WalletAssetEntry,
  type WalletBalancesResponse,
  type WalletProviderInfo,
  type WalletSendCreateInput,
  type WalletSendApprovalRequest,
  type WalletSettings,
  type WalletSolanaTokenSearchResult,
  type WalletSettingsValidateResponse,
  type WalletStatus,
} from "./wallet-api.ts";
import {
  authorizeSignerReviewWithPasskey,
  authorizeWalletActionWithPasskey,
  enrollWalletPasskey,
} from "./wallet-passkey.ts";
import {
  buildWalletPolicyPatch,
  formatRawTokenPolicyAmount,
  formatWalletPolicyAllowlist,
  toRawTokenPolicyAmount,
  toRawPolicyAmount,
} from "./wallet-policy.ts";
import {
  connectWalletStandardAccount,
  signWalletStandardTransaction,
  type WalletStandardChooser,
} from "./wallet-standard.ts";

declare global {
  interface Window {
    __FASED_CONTROL_UI_BASE_PATH__?: string;
  }
}

type UiWorkflowStepType = "note" | "checkpoint" | "wait" | "approval" | "handoff";

type UiWorkflowStepPayload = {
  id: string;
  label: string;
  type: UiWorkflowStepType;
  durationMs?: number;
};

const WORKFLOW_STEP_TYPES = new Set<UiWorkflowStepType>([
  "note",
  "checkpoint",
  "wait",
  "approval",
  "handoff",
]);

function parseWorkflowDurationMs(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const match = raw.trim().match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const unit = match[2]?.toLowerCase() ?? "m";
  if (unit === "ms") {
    return Math.floor(value);
  }
  if (unit === "s") {
    return Math.floor(value * 1_000);
  }
  if (unit === "h") {
    return Math.floor(value * 60 * 60 * 1_000);
  }
  return Math.floor(value * 60 * 1_000);
}

function parseWorkflowStepLine(line: string, index: number): UiWorkflowStepPayload | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const typed = trimmed.match(/^([a-z]+)(?:\s+(\d+(?:ms|s|m|h)?))?\s*:\s*(.+)$/i);
  if (typed) {
    const rawType = typed[1]?.toLowerCase();
    const rawLabel = typed[3]?.trim();
    if (!rawType || !rawLabel) {
      return null;
    }
    const type = rawType as UiWorkflowStepType;
    if (WORKFLOW_STEP_TYPES.has(type)) {
      const durationMs = type === "wait" ? parseWorkflowDurationMs(typed[2]) : undefined;
      return {
        id: `step-${index + 1}`,
        label: rawLabel,
        type,
        ...(durationMs ? { durationMs } : {}),
      };
    }
  }
  return {
    id: `step-${index + 1}`,
    label: trimmed,
    type: "checkpoint",
  };
}

function formatWorkflowDuration(durationMs: number | undefined): string {
  if (!durationMs || !Number.isFinite(durationMs)) {
    return "";
  }
  if (durationMs % (60 * 60 * 1_000) === 0) {
    return `${durationMs / (60 * 60 * 1_000)}h`;
  }
  if (durationMs % (60 * 1_000) === 0) {
    return `${durationMs / (60 * 1_000)}m`;
  }
  if (durationMs % 1_000 === 0) {
    return `${durationMs / 1_000}s`;
  }
  return `${durationMs}ms`;
}

function workflowStepToDraftLine(step: SavedTaskWorkflowDefinition["steps"][number]): string {
  if (step.type === "wait") {
    const duration = formatWorkflowDuration(step.durationMs);
    return `wait${duration ? ` ${duration}` : ""}: ${step.label}`;
  }
  return `${step.type}: ${step.label}`;
}

function taskWorkflowDefinitionToDraft(definition: SavedTaskWorkflowDefinition): TaskWorkflowDraft {
  return {
    id: definition.id,
    name: definition.name,
    task: definition.task,
    notifyPolicy: definition.notifyPolicy,
    stepsText: definition.steps.map((step) => workflowStepToDraftLine(step)).join("\n"),
  };
}

function normalizeWorkflowGraphId(label: string, fallback: string): string {
  return (
    label
      .trim()
      .replace(/[^a-zA-Z0-9:_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback
  );
}

function defaultGraphNodeLabel(type: TaskWorkflowGraphNodeType): string {
  switch (type) {
    case "approval":
      return "Approval";
    case "condition":
      return "Condition";
    case "handoff":
      return "Handoff";
    case "notify":
      return "Notify";
    case "wait":
      return "Wait";
    case "end":
      return "Done";
    case "start":
      return "Start";
    default:
      return "Task";
  }
}

markControlUiBootStage("custom-element-defined");

function createTaskWorkflowGraphDraft(params?: {
  id?: string;
  name?: string;
  task?: string;
  notifyPolicy?: TaskWorkflowDraft["notifyPolicy"];
}): TaskWorkflowGraphDraft {
  return normalizeTaskWorkflowGraphDraft({
    ...(params?.id ? { id: params.id } : {}),
    name: params?.name ?? "New graph workflow",
    task: params?.task ?? "Run a graph workflow.",
    notifyPolicy: params?.notifyPolicy ?? "done_only",
    graph: {
      version: 2,
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start", label: "Start" },
        { id: "task", type: "task", label: "Run task" },
        { id: "done", type: "end", label: "Done" },
      ],
      edges: [
        { id: "start-success-task", from: "start", to: "task", on: "success" },
        { id: "task-success-done", from: "task", to: "done", on: "success" },
      ],
      layout: {
        nodes: {
          start: { x: 32, y: 76 },
          task: { x: 260, y: 76 },
          done: { x: 488, y: 76 },
        },
      },
    },
    selectedNodeId: "task",
    selectedEdgeId: null,
    connectFromNodeId: null,
  });
}

function taskWorkflowGraphDefinitionToDraft(
  definition: SavedTaskWorkflowDefinition,
  runState?: TaskWorkflowGraphRunState,
): TaskWorkflowGraphDraft {
  const graph = definition.graph ?? createTaskWorkflowGraphDraft().graph;
  return normalizeTaskWorkflowGraphDraft({
    id: definition.id,
    name: definition.name,
    task: definition.task,
    notifyPolicy: definition.notifyPolicy,
    graph,
    selectedNodeId: graph.nodes.find((node) => node.type !== "start")?.id ?? graph.startNodeId,
    selectedEdgeId: null,
    connectFromNodeId: null,
    ...(runState ? { runState } : {}),
  });
}

function graphJsonText(graph: TaskWorkflowGraphDraft["graph"]): string {
  return JSON.stringify(graph, null, 2);
}

function normalizeTaskWorkflowGraphDraft(
  draft: Omit<TaskWorkflowGraphDraft, "jsonText" | "jsonOpen" | "zoom" | "panX" | "panY"> &
    Partial<Pick<TaskWorkflowGraphDraft, "jsonText" | "jsonOpen" | "zoom" | "panX" | "panY">>,
): TaskWorkflowGraphDraft {
  return {
    ...draft,
    zoom: draft.zoom ?? 1,
    panX: draft.panX ?? 0,
    panY: draft.panY ?? 0,
    jsonOpen: draft.jsonOpen ?? false,
    jsonText: draft.jsonText ?? graphJsonText(draft.graph),
  };
}

function taskWorkflowTemplateIdForTask(task: TaskRecord): string | null {
  void task;
  return null;
}

function cloneTaskWorkflowGraph(
  graph: NonNullable<TaskWorkflowTemplate["graph"]>,
): NonNullable<TaskWorkflowTemplate["graph"]> {
  return JSON.parse(JSON.stringify(graph)) as NonNullable<TaskWorkflowTemplate["graph"]>;
}

function truncateWorkflowContext(value: string, maxLength = 1_600): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}

function taskWorkflowContextFromLedgerTask(task: TaskRecord): string {
  const context = {
    taskId: task.taskId,
    runId: task.runId,
    source: task.source,
    runtime: task.runtime,
    taskKind: task.taskKind,
    sourceId: task.sourceId,
    rootTaskId: task.rootTaskId,
    parentTaskId: task.parentTaskId,
    correlationId: task.correlationId,
    definitionId: task.definitionId,
    definitionKind: task.definitionKind,
    workflowRunId: task.workflowRunId,
    workflowNodeId: task.workflowNodeId,
    status: task.status,
    deliveryStatus: task.deliveryStatus,
    notifyPolicy: task.notifyPolicy,
    agentId: task.agentId,
    sessionKey: task.sessionKey,
    requesterSessionKey: task.requesterSessionKey,
    channel: task.channel,
    provider: task.provider,
    model: task.model,
    memoryScope: task.memoryScope,
    skillScope: task.skillScope,
    loadedSkills: task.loadedSkills,
    loadedTools: task.loadedTools,
    delivery: task.delivery,
    usage: task.usage,
    metadata: task.metadata,
  };
  return truncateWorkflowContext(JSON.stringify(context, null, 2));
}

function taskWorkflowRunStateFromLedgerTask(
  task: TaskRecord,
): NonNullable<TaskWorkflowGraphDraft["runState"]> {
  return {
    taskId: task.taskId,
    ...(task.runId ? { runId: task.runId } : {}),
    source: task.source,
    runtime: task.runtime,
    ...(task.taskKind ? { taskKind: task.taskKind } : {}),
    task: task.task,
    status: task.status,
    deliveryStatus: task.deliveryStatus,
    ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
    ...(task.steps?.length ? { steps: task.steps.map((step) => ({ ...step })) } : {}),
  };
}

function taskWorkflowSourceTaskFromLedgerTask(
  task: TaskRecord,
): NonNullable<TaskWorkflowGraphDraft["sourceTask"]> {
  return {
    taskId: task.taskId,
    ...(task.runId ? { runId: task.runId } : {}),
    source: task.source,
    runtime: task.runtime,
    ...(task.taskKind ? { taskKind: task.taskKind } : {}),
    task: task.task,
    ...(task.sourceId ? { sourceId: task.sourceId } : {}),
    ...(task.rootTaskId ? { rootTaskId: task.rootTaskId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.correlationId ? { correlationId: task.correlationId } : {}),
    ...(task.definitionId ? { definitionId: task.definitionId } : {}),
    ...(task.definitionKind ? { definitionKind: task.definitionKind } : {}),
    ...(task.workflowRunId ? { workflowRunId: task.workflowRunId } : {}),
    ...(task.workflowNodeId ? { workflowNodeId: task.workflowNodeId } : {}),
    ...(task.agentId ? { agentId: task.agentId } : {}),
    ...(task.sessionKey ? { sessionKey: task.sessionKey } : {}),
    ...(task.requesterSessionKey ? { requesterSessionKey: task.requesterSessionKey } : {}),
    ...(task.channel ? { channel: task.channel } : {}),
    ...(task.metadata ? { metadata: task.metadata } : {}),
  };
}

function taskRecordMetadataString(task: TaskRecord, key: string): string {
  const value = task.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function taskSortTimestamp(task: TaskRecord): number {
  return task.updatedAt ?? task.endedAt ?? task.startedAt ?? task.createdAt ?? 0;
}

function taskRecordsFromLedgerAndDetails(
  ledger: TaskListResult | null,
  details: Record<string, TaskRecord>,
): TaskRecord[] {
  const taskById = new Map<string, TaskRecord>();
  for (const task of ledger?.tasks ?? []) {
    taskById.set(task.taskId, task);
  }
  for (const task of Object.values(details)) {
    taskById.set(task.taskId, task);
  }
  return Array.from(taskById.values());
}

function latestTaskWorkflowRunStateForDefinition(params: {
  definition: SavedTaskWorkflowDefinition;
  ledger: TaskListResult | null;
  details: Record<string, TaskRecord>;
  flows: TaskFlowListResult | null;
}): TaskWorkflowGraphRunState | undefined {
  const { definition, ledger, details, flows } = params;
  const flowTaskIds = new Set<string>();
  for (const flow of flows?.flows ?? []) {
    if (flow.definitionId === definition.id || flow.sourceId === definition.id) {
      for (const taskId of flow.taskIds) {
        flowTaskIds.add(taskId);
      }
    }
  }
  const candidates = taskRecordsFromLedgerAndDetails(ledger, details)
    .filter((task) => {
      if (task.taskKind !== "workflow") {
        return false;
      }
      if (task.agentId && task.agentId !== definition.agentId) {
        return false;
      }
      const explicitDefinition =
        task.sourceId === definition.id ||
        taskRecordMetadataString(task, "workflowDefinitionId") === definition.id ||
        taskRecordMetadataString(task, "definitionId") === definition.id;
      return explicitDefinition || flowTaskIds.has(task.taskId);
    })
    .toSorted((a, b) => taskSortTimestamp(b) - taskSortTimestamp(a));
  const latest = candidates[0];
  return latest ? taskWorkflowRunStateFromLedgerTask(latest) : undefined;
}

function latestTaskWorkflowRunStateForFlow(params: {
  flow: TaskFlowRecord;
  ledger: TaskListResult | null;
  details: Record<string, TaskRecord>;
}): TaskWorkflowGraphRunState | undefined {
  const { flow, ledger, details } = params;
  const flowTaskIds = new Set(flow.taskIds);
  const currentTaskId = flow.currentTaskId ?? flow.blockedTaskId;
  const candidates = taskRecordsFromLedgerAndDetails(ledger, details)
    .filter((task) => flowTaskIds.has(task.taskId))
    .toSorted((a, b) => {
      if (currentTaskId && a.taskId === currentTaskId) {
        return -1;
      }
      if (currentTaskId && b.taskId === currentTaskId) {
        return 1;
      }
      return taskSortTimestamp(b) - taskSortTimestamp(a);
    });
  const latest = candidates[0];
  return latest ? taskWorkflowRunStateFromLedgerTask(latest) : undefined;
}

function sourceWorkflowTaskText(template: TaskWorkflowTemplate, task: TaskRecord): string {
  return [
    template.task,
    "",
    `Run history item: ${task.task}`,
    `Task id: ${task.taskId}`,
    task.runId ? `Run id: ${task.runId}` : "",
    `Source: ${task.source} / ${task.runtime}`,
    `Status: ${task.status}`,
    `Delivery: ${task.deliveryStatus}`,
    "",
    "Run history context:",
    taskWorkflowContextFromLedgerTask(task),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function sourceWorkflowTemplateFromTask(
  template: TaskWorkflowTemplate,
  task: TaskRecord,
): TaskWorkflowTemplate {
  const context = taskWorkflowContextFromLedgerTask(task);
  const graph = template.graph ? cloneTaskWorkflowGraph(template.graph) : undefined;
  if (graph) {
    const contextNode =
      graph.nodes.find((node) => node.type === "task") ??
      graph.nodes.find((node) => node.type !== "start" && node.type !== "end");
    if (contextNode) {
      contextNode.input = truncateWorkflowContext(
        [contextNode.input, "", "Run history context:", context].filter(Boolean).join("\n"),
      );
    }
  }
  return {
    ...template,
    name: truncateWorkflowContext(`${template.name}: ${task.task}`, 120),
    task: sourceWorkflowTaskText(template, task),
    steps: template.steps.map((step) => ({ ...step })),
    tags: [...template.tags, task.source],
    ...(graph ? { graph } : {}),
  };
}

function formatPolicyDraftValue(raw: string | undefined): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "";
  }
  try {
    const amount = BigInt(value);
    const base = 10n ** 9n;
    const whole = amount / base;
    const fraction = (amount % base).toString().padStart(9, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return value;
  }
}

function formatSolLamportsCompact(raw: string | bigint): string {
  try {
    const lamports = BigInt(raw);
    const sign = lamports < 0n ? "-" : "";
    const value = lamports < 0n ? -lamports : lamports;
    const whole = value / 1_000_000_000n;
    const fraction = (value % 1_000_000_000n).toString().padStart(9, "0").slice(0, 3);
    const trimmedFraction = fraction.replace(/0+$/, "");
    return trimmedFraction ? `${sign}${whole}.${trimmedFraction}` : `${sign}${whole}`;
  } catch {
    return String(raw);
  }
}

function inferWalletPreferredChain(
  wallet:
    | {
        id?: string;
        name?: string;
        addresses?: { solana?: string };
      }
    | null
    | undefined,
): "solana" | null {
  if (!wallet) {
    return null;
  }
  const id = String(wallet.id ?? "")
    .trim()
    .toLowerCase();
  const name = String(wallet.name ?? "")
    .trim()
    .toLowerCase();
  if (id.startsWith("solana-") || name.startsWith("solana ")) {
    return "solana";
  }
  if (wallet.addresses?.solana) {
    return "solana";
  }
  return null;
}

function normalizeSendFormForWallet(
  form: WalletSendCreateInput,
  wallet:
    | {
        id?: string;
        name?: string;
        addresses?: { solana?: string };
      }
    | undefined,
): WalletSendCreateInput {
  const preferred = inferWalletPreferredChain(wallet) ?? "solana";
  const assetId = form.assetId?.trim() || undefined;
  return {
    ...form,
    chain: preferred,
    contract: undefined,
    assetId,
    walletName: wallet?.name?.trim() || undefined,
  };
}

function formatWalletApproveError(error: unknown): string {
  return `Approve failed: ${error instanceof Error ? error.message : String(error)}`;
}

const chooseWalletStandardOption: WalletStandardChooser = ({ title, options }) => {
  const answer = window.prompt(
    `${title}\n\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}\n\nEnter a number:`,
    "1",
  );
  if (answer == null) {
    return null;
  }
  const index = Number.parseInt(answer.trim(), 10) - 1;
  return Number.isInteger(index) && index >= 0 && index < options.length ? index : null;
};

function resolveSendFormAssetMetadata(
  form: WalletSendCreateInput,
  balances: WalletBalancesResponse | null,
): Pick<
  WalletSendCreateInput,
  "assetId" | "assetSymbol" | "assetName" | "assetDecimals" | "amountDisplay"
> {
  const assetId = form.assetId?.trim() || undefined;
  const amountDisplay = form.amount?.trim() || undefined;
  const walletId = form.walletId?.trim() || undefined;
  const solanaAssets =
    balances?.walletId && walletId && balances.walletId === walletId
      ? (balances.assets?.solana ?? [])
      : [];
  const matchedAsset =
    assetId && solanaAssets.length > 0
      ? solanaAssets.find((asset: WalletAssetEntry) => asset.id === assetId)
      : undefined;

  if (matchedAsset) {
    return {
      assetId,
      assetSymbol: matchedAsset.symbol,
      assetName: matchedAsset.name,
      assetDecimals: matchedAsset.decimals,
      amountDisplay,
    };
  }

  if (assetId === "solana:native") {
    return {
      assetId,
      assetSymbol: "SOL",
      assetName: "Solana",
      assetDecimals: 9,
      amountDisplay,
    };
  }
  return {
    assetId,
    assetSymbol: form.program?.trim() ? "SPL" : "SOL",
    assetName: form.program?.trim() ? "SPL Token" : "Solana",
    assetDecimals: undefined,
    amountDisplay,
  };
}

const injectedAssistantIdentity = resolveInjectedAssistantIdentity();

function resolveOnboardingMode(): boolean {
  if (!window.location.search) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("onboarding");
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function formatLocalUsageDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function defaultUsageStartDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 6);
  return formatLocalUsageDate(date);
}

function defaultUsageEndDate(): string {
  return formatLocalUsageDate(new Date());
}

function taskLedgerResultSignature(result: TaskListResult | null): string {
  if (!result) {
    return "";
  }
  const taskSignature = result.tasks
    .map((task) =>
      [
        task.taskId,
        task.task,
        task.source,
        task.runtime,
        task.taskKind ?? "",
        task.sourceId ?? "",
        task.definitionId ?? "",
        task.definitionKind ?? "",
        task.correlationId ?? "",
        task.status,
        task.deliveryStatus,
        task.notifyPolicy,
        task.updatedAt ?? "",
        task.startedAt ?? "",
        task.endedAt ?? "",
        task.provider ?? "",
        task.model ?? "",
        task.sessionKey ?? "",
        task.progressSummary ?? "",
        task.terminalSummary ?? "",
        task.error ?? "",
      ].join(":"),
    )
    .join("|");
  const auditSignature = (result.audit?.findings ?? [])
    .map((finding) =>
      [
        finding.severity,
        finding.code,
        finding.taskId ?? "",
        finding.runId ?? "",
        finding.source ?? "",
      ].join(":"),
    )
    .join("|");
  return [
    result.total,
    result.offset ?? 0,
    result.limit ?? result.tasks.length,
    result.nextOffset ?? "",
    result.hasMore === true ? "more" : "done",
    result.summary.total,
    result.summary.queued,
    result.summary.running,
    result.summary.terminal,
    result.summary.failed,
    result.summary.lost,
    auditSignature,
    taskSignature,
  ].join(";");
}

@customElement("fased-app")
export class FasedAgentApp extends LitElement {
  private miningNotificationTimers = new Map<string, number>();
  private notificationCooldowns = new Map<string, number>();
  private walletReloadAfterSettingsTimer: number | null = null;
  @state() settings: UiSettings = loadSettings();
  @state() password = "";
  @state() loginShowGatewayToken = false;
  @state() loginShowGatewayPassword = false;
  @state() tab: Tab = "chat";
  @state() onboarding = resolveOnboardingMode();
  @state() connected = false;
  @state() theme: ThemeMode = this.settings.theme ?? "system";
  @state() themeResolved: ResolvedTheme = "dark";
  @state() hello: GatewayHelloOk | null = null;
  @state() lastError: string | null = null;
  @state() lastErrorCode: string | null = null;
  @state() uiRuntimeError: string | null = null;
  @state() eventLog: EventLogEntry[] = [];
  private eventLogBuffer: EventLogEntry[] = [];
  private toolStreamSyncTimer: number | null = null;
  private sidebarCloseTimer: number | null = null;
  readonly clientInstanceId = generateUUID();
  @state() serverVersion: string | null = null;
  @state() updateAvailable: import("./types.ts").UpdateAvailable | null = null;

  @state() assistantName = injectedAssistantIdentity.name;
  @state() assistantAvatar = injectedAssistantIdentity.avatar;
  @state() assistantAgentId = injectedAssistantIdentity.agentId ?? null;

  @state() sessionKey = this.settings.sessionKey;
  @state() sessionsSubscriptionActive = false;
  @state() sessionsLastEventAt: number | null = null;
  @state() sessionMessagesSubscriptionActive = false;
  @state() subscribedSessionMessageKey: string | null = null;
  @state() sessionMessageLastEventAt: number | null = null;
  @state() chatLoading = false;
  @state() chatSending = false;
  @state() chatMessage = "";
  @state() chatMessages: unknown[] = [];
  @state() chatToolMessages: unknown[] = [];
  @state() chatStream: string | null = null;
  @state() chatStreamSegments: Array<{ text: string; ts: number }> = [];
  @state() chatStreamStartedAt: number | null = null;
  @state() chatRunId: string | null = null;
  @state() compactionStatus: CompactionStatus | null = null;
  @state() fallbackStatus: FallbackStatus | null = null;
  @state() chatAvatarUrl: string | null = null;
  @state() chatThinkingLevel: string | null = null;
  @state() chatQueue: ChatQueueItem[] = [];
  @state() chatAttachments: ChatAttachment[] = [];
  @state() chatManualRefreshInFlight = false;
  @state() chatModelsLoading = false;
  @state() chatModelCatalog: ModelCatalogEntry[] = [];
  @state() providerModelCatalog: ModelCatalogEntry[] = [];
  @state() chatModelOverrides: Record<string, ChatModelOverride | null> = {};
  chatModelPatchPending: Promise<void> | null = null;
  @state() chatModelPatchInFlight = false;
  @state() chatModelPatchSessionKey: string | null = null;
  @state() chatModelPatchLabel: string | null = null;
  @state() chatSessionSearch = "";
  @state() chatSessionSearchOpen = false;
  @state() chatSessionListLimit = 30;
  @state() chatTranscriptSearch = "";
  @state() chatTranscriptSearchIndex = 0;
  @state() chatScheduleDraft = { ...DEFAULT_CHAT_SCHEDULE_DRAFT };
  @state() chatSessionUsage: import("./types.js").SessionsUsageEntry | null = null;
  @state() chatSessionUsageLoading = false;
  @state() chatSessionUsageError: string | null = null;
  // Sidebar state for tool output viewing
  @state() sidebarOpen = false;
  @state() sidebarContent: string | null = null;
  @state() sidebarError: string | null = null;
  @state() splitRatio = this.settings.splitRatio;

  @state() nodesLoading = false;
  @state() nodes: Array<Record<string, unknown>> = [];
  @state() commandsCatalogLoading = false;
  @state() commandsCatalogError: string | null = null;
  @state() commandsCatalog: CommandsListResult | null = null;
  @state() commandsCatalogScope: CommandsCatalogScope = "both";
  @state() devicesLoading = false;
  @state() devicesError: string | null = null;
  @state() devicesList: DevicePairingList | null = null;
  @state() execApprovalsLoading = false;
  @state() execApprovalsSaving = false;
  @state() execApprovalsDirty = false;
  @state() execApprovalsSnapshot: ExecApprovalsSnapshot | null = null;
  @state() sendModalVisible = false;
  @state() execApprovalsForm: ExecApprovalsFile | null = null;
  @state() execApprovalsSelectedAgent: string | null = null;
  @state() execApprovalsTarget: "gateway" | "node" = "gateway";
  @state() execApprovalsTargetNodeId: string | null = null;
  @state() execApprovalQueue: ExecApprovalRequest[] = [];
  @state() execApprovalBusy = false;
  @state() execApprovalError: string | null = null;
  @state() pendingGatewayUrl: string | null = null;
  @state() pendingGatewayToken: string | null = null;
  @state() loginGrantInput = "";
  @state() loginGrantPending = false;
  @state() loginGrantError: string | null = null;
  @state() loginTokenPending = false;
  @state() loginTokenError: string | null = null;
  @state() loginTokenCandidate = "";
  @state() authBootstrapPending = true;
  @state() authNotice: string | null = null;
  @state() authSessionExpiresAt: string | null = null;
  @state() authSessionIdleTimeoutSeconds: number | null = null;
  @state() overviewAdvancedUnlocked = false;
  @state() overviewSecretsRevealUntilMs = 0;
  @state() dashboardLayout: DashboardLayout = loadDashboardLayout();
  @state() dashboardWidgetDrawerOpen = false;

  @state() configLoading = false;
  @state() configRaw = "{\n}\n";
  @state() configRawOriginal = "";
  @state() configValid: boolean | null = null;
  @state() configIssues: unknown[] = [];
  @state() configSaving = false;
  @state() configApplying = false;
  @state() updateRunning = false;
  @state() applySessionKey = this.settings.lastActiveSessionKey;
  @state() configSnapshot: ConfigSnapshot | null = null;
  @state() configAuthStatus: import("./types.ts").ModelsAuthStatusResult | null = null;
  @state() configModelCatalogStatus: import("./types.ts").ModelsCatalogStatusResult | null = null;
  @state() configAuthActionBusyProfileId: string | null = null;
  @state() configAuthAction: import("./controllers/config.ts").ConfigAuthActionState | null = null;
  configAuthPromptResolver: import("./controllers/config.ts").ConfigAuthPromptResolver | null =
    null;
  configAuthActionRunId = 0;
  @state() configSchema: unknown = null;
  @state() configSchemaVersion: string | null = null;
  @state() configSchemaLoading = false;
  @state() configUiHints: ConfigUiHints = {};
  @state() configForm: Record<string, unknown> | null = null;
  @state() configFormOriginal: Record<string, unknown> | null = null;
  @state() configFormDirty = false;
  @state() configFormMode: "form" | "raw" = "form";
  @state() configSearchQuery = "";
  @state() configActiveSection: string | null = null;
  @state() configActiveSubsection: string | null = null;
  @state() servicesWebSearchTesting = false;
  @state() servicesWebSearchTestMessage: string | null = null;
  @state() servicesCapabilities: import("./types.ts").CapabilityReadinessReport | null = null;
  @state() servicesCapabilitiesLoading = false;
  @state() servicesComponentBusy: Record<string, boolean> = {};
  @state() servicesComponentMessage: string | null = null;
  @state() servicesWebSearchProviders: import("./types.ts").WebSearchServiceProviderOption[] = [];
  @state() servicesWebSearchProvidersLoading = false;
  @state() servicesGmailProvisioning = false;
  @state() servicesGmailProvisionMessage: string | null = null;

  @state() channelsLoading = false;
  @state() channelsSnapshot: ChannelsStatusSnapshot | null = null;
  @state() channelsError: string | null = null;
  @state() channelsNotice: string | null = null;
  @state() channelsLastSuccess: number | null = null;
  @state() channelsView: import("./views/channels.types.ts").ChannelsView = "accounts";
  @state() channelRuntimeBusy: Record<string, boolean> = {};
  @state() channelConfirmAction: ChannelConfirmAction | null = null;
  @state()
  channelQrLogin: import("./controllers/channels.types.ts").ChannelsState["channelQrLogin"] = {};
  @state() whatsappLoginMessage: string | null = null;
  @state() whatsappLoginQrDataUrl: string | null = null;
  @state() whatsappLoginConnected: boolean | null = null;
  @state() whatsappBusy = false;
  @state() nostrProfileFormState: NostrProfileFormState | null = null;
  @state() nostrProfileAccountId: string | null = null;

  @state() presenceLoading = false;
  @state() presenceEntries: PresenceEntry[] = [];
  @state() presenceError: string | null = null;
  @state() presenceStatus: string | null = null;

  @state() agentsLoading = false;
  @state() agentsList: AgentsListResult | null = null;
  @state() agentsError: string | null = null;
  @state() agentsSelectedId: string | null = null;
  @state() agentsCreateBusy = false;
  @state() agentsCreateMessage: string | null = null;
  @state() agentsPanel:
    | "overview"
    | "providers"
    | "sessions"
    | "files"
    | "tools"
    | "skills"
    | "memory"
    | "channels"
    | "services"
    | "coordination"
    | "cron" = "overview";
  @state() agentFilesLoading = false;
  @state() agentFilesError: string | null = null;
  @state() agentFilesList: AgentsFilesListResult | null = null;
  @state() agentFileContents: Record<string, string> = {};
  @state() agentFileDrafts: Record<string, string> = {};
  @state() agentFileActive: string | null = null;
  @state() agentFileSaving = false;
  @state() agentIdentityLoading = false;
  @state() agentIdentityError: string | null = null;
  @state() agentIdentityById: Record<string, AgentIdentityResult> = {};
  @state() agentSkillsLoading = false;
  @state() agentSkillsError: string | null = null;
  @state() agentSkillsReport: SkillStatusReport | null = null;
  @state() agentSkillsAgentId: string | null = null;
  @state() toolsCatalogLoading = false;
  toolsCatalogLoadingAgentId: string | null = null;
  @state() toolsCatalogError: string | null = null;
  @state() toolsCatalogResult: import("./types.ts").ToolsCatalogResult | null = null;
  @state() toolsEffectiveLoading = false;
  toolsEffectiveLoadingKey: string | null = null;
  toolsEffectiveResultKey: string | null = null;
  @state() toolsEffectiveError: string | null = null;
  @state() toolsEffectiveResult: import("./types.ts").ToolsEffectiveResult | null = null;

  @state() sessionsLoading = false;
  @state() sessionsResult: SessionsListResult | null = null;
  @state() sessionsError: string | null = null;
  @state() sessionsFilterActive = "";
  @state() sessionsFilterLimit = "120";
  @state() sessionsFilterSearch = "";
  @state() sessionsIncludeGlobal = true;
  @state() sessionsIncludeUnknown = false;
  @state() sessionsHideCron = true;

  @state() usageLoading = false;
  @state() usageResult: import("./types.js").SessionsUsageResult | null = null;
  @state() usageCostSummary: import("./types.js").CostUsageSummary | null = null;
  @state() usageError: string | null = null;
  @state() usageStartDate = defaultUsageStartDate();
  @state() usageEndDate = defaultUsageEndDate();
  @state() usageSelectedSessions: string[] = [];
  @state() usageSelectedDays: string[] = [];
  @state() usageSelectedHours: number[] = [];
  @state() usageChartMode: "tokens" | "cost" = "tokens";
  @state() usageDailyChartMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeriesMode: "cumulative" | "per-turn" = "per-turn";
  @state() usageTimeSeriesBreakdownMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeries: import("./types.js").SessionUsageTimeSeries | null = null;
  @state() usageTimeSeriesLoading = false;
  @state() usageTimeSeriesCursorStart: number | null = null;
  @state() usageTimeSeriesCursorEnd: number | null = null;
  @state() usageSessionLogs: import("./views/usage.js").SessionLogEntry[] | null = null;
  @state() usageSessionLogsLoading = false;
  @state() usageSessionLogsExpanded = false;
  // Applied query (used to filter the already-loaded sessions list client-side).
  @state() usageQuery = "";
  // Draft query text (updates immediately as the user types; applied via debounce or "Search").
  @state() usageQueryDraft = "";
  @state() usageSessionSort: "tokens" | "cost" | "recent" | "messages" | "errors" = "recent";
  @state() usageSessionSortDir: "desc" | "asc" = "desc";
  @state() usageRecentSessions: string[] = [];
  @state() usageTimeZone: "local" | "utc" = "local";
  @state() usageContextExpanded = false;
  @state() usageHeaderPinned = false;
  @state() usageSessionsTab: "all" | "recent" = "all";
  @state() usageVisibleColumns: string[] = [
    "source",
    "channel",
    "agent",
    "provider",
    "model",
    "messages",
    "tools",
    "errors",
    "duration",
  ];
  @state() usageLogFilterRoles: import("./views/usage.js").SessionLogRole[] = [];
  @state() usageLogFilterTools: string[] = [];
  @state() usageLogFilterHasTools = false;
  @state() usageLogFilterQuery = "";

  // Non-reactive (don’t trigger renders just for timer bookkeeping).
  usageQueryDebounceTimer: number | null = null;

  @state() cronLoading = false;
  @state() cronJobsLoadingMore = false;
  @state() cronJobs: CronJob[] = [];
  @state() cronJobsTotal = 0;
  @state() cronJobsHasMore = false;
  @state() cronJobsNextOffset: number | null = null;
  @state() cronJobsLimit = 25;
  @state() cronJobsQuery = "";
  @state() cronJobsEnabledFilter: import("./types.js").CronJobsEnabledFilter = "all";
  @state() cronJobsScheduleKindFilter: import("./controllers/cron.js").CronJobsScheduleKindFilter =
    "all";
  @state() cronJobsLastStatusFilter: import("./controllers/cron.js").CronJobsLastStatusFilter =
    "all";
  @state()
  cronJobsAdaptiveRouteFilter: import("./controllers/cron.js").CronJobsAdaptiveRouteFilter = "all";
  @state() cronJobsSortBy: import("./types.js").CronJobsSortBy = "updatedAtMs";
  @state() cronJobsSortDir: import("./types.js").CronSortDir = "desc";
  @state() cronStatus: CronStatus | null = null;
  @state() cronError: string | null = null;
  @state() cronForm: CronFormState = { ...DEFAULT_CRON_FORM };
  @state() cronFieldErrors: import("./controllers/cron.js").CronFieldErrors = {};
  @state() agentTaskDialogOpen = false;
  @state() agentTaskForm: CronFormState = { ...DEFAULT_CRON_FORM };
  @state() agentTaskFieldErrors: import("./controllers/cron.js").CronFieldErrors = {};
  @state() agentTaskEditingJobId: string | null = null;
  @state() agentTaskError: string | null = null;
  @state() agentTaskBusy = false;
  @state() agentTaskQuery = "";
  @state() agentTaskStatusFilter: "all" | "enabled" | "disabled" | "needs-access" = "all";
  @state()
  agentTaskAdaptiveRouteFilter: import("./controllers/cron.js").CronJobsAdaptiveRouteFilter = "all";
  @state() agentTaskSortDir: "desc" | "asc" = "desc";
  @state() taskLedgerLoading = false;
  @state() taskLedgerBusy = false;
  @state() taskLedgerError: string | null = null;
  @state() taskLedgerMaintenanceMessage: string | null = null;
  @state() taskLedger: TaskListResult | null = null;
  @state() taskLedgerOffset = 0;
  @state() taskLedgerSourceFilter: import("./types.js").TaskSource | "all" = "all";
  @state() taskLedgerTypeFilter:
    | "all"
    | "task"
    | "trigger"
    | "workflow"
    | "graph"
    | "program"
    | "history" = "all";
  @state() taskLedgerStatusFilter: "all" | "active" | "terminal" | TaskRecord["status"] = "all";
  @state() taskLedgerDetails: Record<string, TaskRecord> = {};
  @state() taskLedgerDetailLoading: Record<string, boolean> = {};
  @state() taskLedgerDetailErrors: Record<string, string> = {};
  @state() taskWorkflowDraft: TaskWorkflowDraft | null = null;
  @state() taskWorkflowGraphDraft: TaskWorkflowGraphDraft | null = null;
  @state() taskWorkflowBusy = false;
  @state() taskWorkflowError: string | null = null;
  @state() taskWorkflowMessage: string | null = null;
  @state() taskWorkflowDefinitionsLoading = false;
  @state() taskWorkflowDefinitionsBusy = false;
  @state() taskWorkflowDefinitionsError: string | null = null;
  @state() taskWorkflowDefinitions: SavedTaskWorkflowDefinitionsResult | null = null;
  @state() taskWorkflowTemplatesLoading = false;
  @state() taskWorkflowTemplatesError: string | null = null;
  @state() taskWorkflowTemplates: TaskWorkflowTemplatesResult | null = null;
  @state() taskStandingOrdersLoading = false;
  @state() taskStandingOrdersBusy = false;
  @state() taskStandingOrdersError: string | null = null;
  @state() taskStandingOrdersMessage: string | null = null;
  @state() taskStandingOrders: StandingOrdersResult | null = null;
  @state() taskStandingOrderDraft: StandingOrderDraft | null = null;
  @state() taskFlowRunsLoading = false;
  @state() taskFlowRunsBusy = false;
  @state() taskFlowRunsError: string | null = null;
  @state() taskFlowRuns: TaskFlowListResult | null = null;
  @state() webhookTriggersLoading = false;
  @state() webhookTriggersBusy = false;
  @state() webhookTriggersError: string | null = null;
  @state() webhookTriggersMessage: string | null = null;
  @state() webhookTriggers: WebhookTriggersResult | null = null;
  @state() webhookTriggerDraft: WebhookTriggerDraft | null = null;
  @state() cronEditingJobId: string | null = null;
  @state() cronRunsJobId: string | null = null;
  @state() cronRunsLoadingMore = false;
  @state() cronRuns: CronRunLogEntry[] = [];
  @state() cronRunsTotal = 0;
  @state() cronRunsHasMore = false;
  @state() cronRunsNextOffset: number | null = null;
  @state() cronRunsLimit = 50;
  @state() cronRunsScope: import("./types.js").CronRunScope = "all";
  @state() cronRunsStatuses: import("./types.js").CronRunsStatusValue[] = [];
  @state() cronRunsDeliveryStatuses: import("./types.js").CronDeliveryStatus[] = [];
  @state() cronRunsStatusFilter: import("./types.js").CronRunsStatusFilter = "all";
  @state() cronRunsQuery = "";
  @state() cronRunsSortDir: import("./types.js").CronSortDir = "desc";
  @state() cronRunDetail: import("./types.js").CronTaskRunDetail | null = null;
  @state() cronRunDetailLoading = false;
  @state() cronRunDetailError: string | null = null;
  @state() cronBusy = false;

  @state() federationLoading = false;
  @state() federationError: string | null = null;
  @state() federationMessage: string | null = null;
  @state() federationDirectory: import("./federation-api.js").FederationDirectoryEntry[] = [];
  @state() federationHandle = "";
  @state() federationNodeEndpoint = typeof window !== "undefined" ? window.location.origin : "";
  @state() federationToken: import("./federation-api.js").FederationToken | null = null;
  @state() federationStatus: import("./federation-api.js").FederationStatus | null = null;
  @state() federationManagedMode = false;
  @state() federationAdminToken = "";
  @state() federationReviewReason = "";
  @state() federationReviewBusyHandle: string | null = null;
  @state() federationBondWalletIdDraft = "";
  @state() federationBondAmountDraft = "1";
  @state() federationBondTierDraft: "basic-bond" | "operator-bond" = "basic-bond";
  @state() federationBondAutoSubmitProof = true;
  @state() federationBondActionBusy = false;
  @state() federationBondBusyAction: string | null = null;
  @state() federationOperatorEconomyLoading = false;
  @state() federationOperatorEconomyError: string | null = null;
  @state()
  federationOperatorEconomyCollectionStatus: import("./federation-api.js").FederationOperatorEconomyFeeCollectionStatus[] =
    [];
  @state()
  federationOperatorEconomyFeeObjects: import("./federation-api.js").FederationOperatorEconomyFeeObjectRecord[] =
    [];
  @state()
  federationOperatorEconomyBucketJournal: import("./federation-api.js").FederationOperatorEconomyFeeBucketJournalRow[] =
    [];
  @state()
  federationOperatorEconomyBucketBalances: import("./federation-api.js").FederationOperatorEconomyFeeBucketBalanceView[] =
    [];
  @state()
  federationOperatorEconomyReconciliationReports: import("./federation-api.js").FederationOperatorEconomyFeeReconciliationReport[] =
    [];
  @state()
  federationOperatorEconomyAutoFeeDecisions: import("./federation-api.js").FederationOperatorEconomyAutoFeeDecisionRecord[] =
    [];
  @state()
  federationOperatorEconomyShowcase:
    | import("./federation-api.js").FederationOperatorEconomyShowcaseMeta
    | null = null;
  @state()
  federationLocalOffers: import("./federation-api.js").FederationLocalOfferEntry[] = [];
  @state()
  federationLocalRequests: import("./federation-api.js").FederationLocalRequestEntry[] = [];
  @state()
  federationLocalOrders: import("./federation-api.js").FederationLocalOrderEntry[] = [];
  @state() federationLocalOffersLoading = false;
  @state() federationLocalRequestsLoading = false;
  @state() federationLocalOrdersLoading = false;
  @state() federationLocalRequestsError: string | null = null;
  @state() federationLocalOrdersError: string | null = null;
  @state() federationLocalOffersError: string | null = null;
  @state() federationLocalOffersMessage: string | null = null;
  @state() federationLocalOfferBusy = false;
  @state() federationLocalOrderBusy = false;
  @state() federationEscrowBusyOrderId: string | null = null;
  @state() federationEscrowError: string | null = null;
  @state() federationEscrowMessage: string | null = null;
  @state() federationMarketplaceOrderDeliveryDraftOrderId = "";
  @state() federationMarketplaceOrderDeliveryKindDraft: "app-inbox" | "webhook" = "app-inbox";
  @state() federationMarketplaceOrderDeliveryWebhookUrlDraft = "";
  @state() federationMarketplaceOrderDeliveryBusyOrderId: string | null = null;
  @state() federationMarketplaceOrderDeliveryError: string | null = null;
  @state() federationMarketplaceOrderDeliveryMessage: string | null = null;
  @state() federationMarketplaceManualOrderBusyId: string | null = null;
  @state() federationMarketplaceManualOrderError: string | null = null;
  @state() federationMarketplaceManualOrderMessage: string | null = null;
  @state() federationMarketplaceCapabilityOrderBusyId: string | null = null;
  @state() federationMarketplaceCapabilityOrderError: string | null = null;
  @state() federationMarketplaceCapabilityOrderMessage: string | null = null;
  @state() federationLocalOfferDraftOpen = false;
  @state() federationLocalListingDraftKind: "offer" | "request" = "offer";
  @state() federationLocalOfferEditingId: string | null = null;
  @state() federationLocalRequestEditingId: string | null = null;
  @state() federationLocalOfferEnabledDraft = true;
  @state() federationLocalOfferTitleDraft = "";
  @state() federationLocalOfferSummaryDraft = "";
  @state() federationLocalOfferServiceKindDraft = "";
  @state() federationLocalOfferInputShapeDraft = "";
  @state() federationLocalOfferDeliveryShapeDraft = "";
  @state() federationLocalOfferCapabilitiesDraft = "";
  @state() federationLocalOfferPriceAmountDraft = "";
  @state() federationLocalOfferPricingModelDraft = "quote";
  @state()
  federationLocalOfferPriceUnitDraft: import("./federation-api.js").FederationMarketplacePriceUnit =
    "per-job";
  @state() federationLocalOfferCurrencyDraft = "USDC";
  @state()
  federationLocalOfferFulfillmentModeDraft: import("./federation-api.js").FederationMarketplaceFulfillmentMode =
    "agent-approval";
  @state() federationLocalOfferAcceptedAssetsDraft = "USDC, SOL, SAT, FCOD";
  @state() federationLocalOfferPaymentRailsDraft = "agent-wallet";
  @state() federationOffersLoading = false;
  @state() federationOffersError: string | null = null;
  @state() federationOffersHint: string | null = null;
  @state() federationOffers: import("./federation-api.js").FederationOfferDirectoryEntry[] = [];
  @state() federationOffersQuery = "";
  @state() federationOffersServiceKindFilter = "all";
  @state()
  federationMarketplaceSection: import("./views/federation.ts").FederationMarketplaceSection =
    "market";
  @state() federationMarketplaceKindFilter: "all" | "offer" | "request" = "all";
  @state() federationMarketplaceTrustFilter = "all";
  @state() federationMarketplaceStatusFilter = "all";
  @state() federationMarketplaceDateFromFilter = "";
  @state() federationMarketplaceDateToFilter = "";
  @state()
  federationMarketplaceSort: import("./views/federation.ts").FederationMarketplaceSort = "latest";
  @state() federationSelectedOfferId = "";
  @state() federationMarketplaceIndexLoading = false;
  @state() federationMarketplaceIndexPublishing = false;
  @state() federationMarketplaceIndexError: string | null = null;
  @state() federationMarketplaceIndexMessage: string | null = null;
  @state()
  federationMarketplaceIndexPreview:
    | import("./federation-api.js").FederationMarketplaceIndexPreview
    | null = null;
  @state()
  federationMarketplaceIndexEntries: import("./federation-api.js").FederationMarketplaceIndexEntry[] =
    [];
  @state() federationMarketplaceIndexSelectedEntryId = "";
  @state()
  federationMarketplaceIndexDetailTab: import("./views/federation.ts").FederationMarketplaceIndexDetailTab =
    "overview";
  @state() federationMarketplaceFeedbackOrderId = "";
  @state() federationMarketplaceSellerProfileHandle = "";
  @state()
  federationMarketplaceSellerProfileTab: import("./views/federation.ts").FederationMarketplaceSellerProfileTab =
    "summary";
  @state() federationMarketplaceSellerProfileLoading = false;
  @state() federationMarketplaceSellerProfileError: string | null = null;
  @state()
  federationMarketplaceSellerProfileEntries: import("./federation-api.js").FederationMarketplaceIndexEntry[] =
    [];
  @state()
  federationMarketplaceSellerProfileReviews: import("./federation-api.js").FederationReviewRecord[] =
    [];
  @state()
  federationMarketplaceSellerProfileDisputes: import("./federation-api.js").FederationDisputeRecord[] =
    [];
  @state()
  federationMarketplaceSellerProfileNotaryRecords: import("./federation-api.js").FederationDisputeNotaryRecord[] =
    [];
  @state() federationOfferReviewsLoading = false;
  @state() federationOfferReviewsError: string | null = null;
  @state() federationOfferReviews: import("./federation-api.js").FederationReviewRecord[] = [];
  @state() federationOfferDisputesLoading = false;
  @state() federationOfferDisputesError: string | null = null;
  @state() federationOfferDisputes: import("./federation-api.js").FederationDisputeRecord[] = [];
  @state() federationOfferFeedbackBusy = false;
  @state() federationOfferFeedbackError: string | null = null;
  @state() federationOfferFeedbackMessage: string | null = null;
  @state() federationOfferFeedbackTab: "review" | "dispute" = "review";
  @state() federationSummarizeSourceText = "";
  @state() federationSummarizeStyle: "plain" | "bullets" = "bullets";
  @state() federationSummarizeMaxSentences = "2";
  @state() federationSummarizeBusy = false;
  @state() federationSummarizeError: string | null = null;
  @state() federationPaidSummarizeBusy = false;
  @state() federationPaidSummarizeError: string | null = null;
  @state() federationSummarizeResult:
    | import("./federation-api.js").FederationContentSummarizeRunResult
    | null = null;
  @state() federationPaidQuoteAmountDraft = "0.01";
  @state() federationPaidQuoteAssetDecimalsDraft = "";
  @state() federationPaidQuoteCurrencyDraft = "SOL";
  @state()
  federationPaidQuoteChainDraft: import("./federation-api.js").FederationPaidContentSummarizeRunRequest["quote"]["chain"] =
    "solana";
  @state()
  federationPaidQuoteAssetKindDraft: import("./federation-api.js").FederationPaidContentSummarizeRunRequest["quote"]["assetKind"] =
    "native";
  @state() federationPaidQuoteAssetAddressDraft = "";
  @state() federationPaidQuotePayeeAddressDraft = "";
  @state() federationPaidQuoteExpiresMinutesDraft = "5";
  @state() federationReviewRatingDraft = "5";
  @state()
  federationReviewOutcomeDraft: import("./federation-api.js").FederationReviewDeliveryOutcome =
    "satisfied";
  @state()
  federationReviewPaymentStatusDraft: import("./federation-api.js").FederationReviewPaymentStatus =
    "unpaid";
  @state() federationReviewInvoiceIdDraft = "";
  @state() federationReviewReceiptIdDraft = "";
  @state() federationReviewSummaryDraft = "";
  @state()
  federationDisputeReasonCodeDraft: import("./federation-api.js").FederationDisputeReasonCode =
    "delivery_mismatch";
  @state()
  federationDisputePaymentStatusDraft: import("./federation-api.js").FederationReviewPaymentStatus =
    "unpaid";
  @state() federationDisputeInvoiceIdDraft = "";
  @state() federationDisputeReceiptIdDraft = "";
  @state() federationDisputeSummaryDraft = "";
  @state() federationOperatorDisputesLoading = false;
  @state() federationOperatorDisputesError: string | null = null;
  @state()
  federationOperatorDisputes: import("./federation-api.js").FederationDisputeRecord[] = [];
  @state() federationOperatorDisputeProviderFilter = "";
  @state() federationOperatorDisputeOfferIdFilter = "";
  @state()
  federationOperatorDisputeStatusFilter:
    | "all"
    | import("./federation-api.js").FederationDisputeStatus = "open";
  @state()
  federationOperatorDisputePaymentStatusFilter:
    | "all"
    | import("./federation-api.js").FederationReviewPaymentStatus = "all";
  @state() federationOperatorSelectedCaseId = "";
  @state()
  federationOperatorDisputeReviewStatusDraft: import("./federation-api.js").FederationDisputeReviewRequest["status"] =
    "under_review";
  @state() federationOperatorDisputeResolutionDraft = "";
  @state() federationOperatorDisputeReviewBusy = false;
  @state() federationOperatorDisputeReviewError: string | null = null;
  @state() federationOperatorDisputeReviewMessage: string | null = null;
  @state() federationDisputeNotaryRecordsLoading = false;
  @state() federationDisputeNotaryRecordsError: string | null = null;
  @state()
  federationDisputeNotaryRecords: import("./federation-api.js").FederationDisputeNotaryRecord[] =
    [];
  @state()
  federationDisputeNotaryOpinionDraft: import("./federation-api.js").FederationDisputeNotaryOpinion =
    "requires-manual-review";
  @state()
  federationDisputeNotaryConfidenceDraft: import("./federation-api.js").FederationDecisionConfidence =
    "medium";
  @state()
  federationDisputeNotaryRecommendedResolutionDraft: Exclude<
    import("./federation-api.js").FederationDisputeStatus,
    "open"
  > = "under_review";
  @state() federationDisputeNotarySummaryDraft = "";
  @state() federationDisputeNotaryBusy = false;
  @state() federationDisputeNotaryError: string | null = null;
  @state() federationDisputeNotaryMessage: string | null = null;
  @state() walletLoading = false;
  @state() walletError: string | null = null;
  @state() walletStatus: WalletStatus | null = null;
  @state() walletBalancesLoading = false;
  @state() walletBalancesError: string | null = null;
  @state() walletBalances: WalletBalancesResponse | null = null;

  @state() miningLoading = false;
  @state() miningSaving = false;
  @state() miningActionBusy = false;
  @state() miningCapitalActionBusy: "deposit" | "withdraw" | null = null;
  @state() miningPendingAction: "starting" | "stopping" | null = null;
  @state() miningError: string | null = null;
  @state() miningMessage: string | null = null;
  @state() miningWallets: SatMiningWalletOption[] = [];
  @state() miningAttachedWalletId: string | null = null;
  @state() miningProfile: SatMinerProfile | null = createDefaultMinerProfile();
  @state() miningSavedProfiles: SavedMiningProfile[] = [];
  @state() miningSelectedSavedProfileId = "";
  @state() miningSaveProfileName = "";
  @state() miningCapitalDepositDraft = "0.25";
  @state() miningCapitalWithdrawDraft = "0";
  @state() miningReadiness: SatMiningReadiness | null = null;
  @state() miningStatus: SatMiningRuntimeStatus | null = null;
  @state() miningMainnetSync: SatMainnetSyncStatus | null = null;
  @state() miningMainnetSyncBusy = false;
  @state() miningHistoryLoading = false;
  @state() miningHistoryError: string | null = null;
  @state() miningHistory: SatMiningHistory | null = null;
  @state() miningRecovery: SatMiningRecoverySummary | null = null;
  @state() miningRecoveryDisputeAuthority = "";
  @state() miningRecoveryTargetAuthority = "";
  @state() miningRecoveryEpochId = "";
  @state() miningRecoveryMicroRoundId = "";
  @state() miningRecoveryStatusFlag = "2";
  @state() miningRecoveryBoardRoot = "";
  @state() miningRecoveryScoreRoot = "";
  @state() miningRecoveryCoordinationRoot = "";
  @state() miningRecoveryDraftRestored = false;
  @state() miningRecoveryDraftUpdatedAt: string | null = null;
  @state() miningRecoveryDraftSavedHint: string | null = null;
  @state() miningLastNotifiedAction: string | null = null;
  @state() miningNotifications: MiningUiNotification[] = [];
  @state() notifications: AppNotification[] = [];
  @state() miningConfirmClearHistory = false;
  @state() miningRecentActionsPage = 1;
  @state() miningHistoryModalOpen = false;
  @state() miningActivityFilter: import("./views/mining.js").MiningActivityFilter = "all";
  @state() miningActivityWindow: import("./views/mining.js").MiningPlannerWindow = "24h";
  @state() miningPlannerWindow: import("./views/mining.js").MiningPlannerWindow = "24h";
  @state() miningChartMetric: import("./views/mining.js").MiningChartMetric = "both";
  @state() miningNowMs = Date.now();
  @state() walletSettingsLoading = false;
  @state() walletSettingsBusy = false;
  @state() walletSettingsError: string | null = null;
  @state() walletSettingsMessage: string | null = null;
  @state() walletSettings: WalletSettings | null = null;
  @state() walletSettingsValidation: WalletSettingsValidateResponse | null = null;
  @state() walletSkillGrantsLoading = false;
  @state() walletSkillGrantsError: string | null = null;
  @state() walletSkillGrantsMessage: string | null = null;
  @state() walletSkillGrantsWorkspace: string | null = null;
  @state() walletSkillGrantRows: WalletSkillGrantRow[] = [];
  @state() walletSkillGrantDraft: WalletSkillGrantDraft = createEmptyWalletSkillGrantDraft();
  @state() walletSkillGrantBusy = false;
  @state() walletProvidersLoading = false;
  @state() walletProviders: WalletProviderInfo[] = [];
  @state() walletNamedWallets: WalletNamedWallet[] = [];
  @state() walletAssignments: Record<string, string> = {};
  @state() walletDefaultWalletId: string | null = null;
  @state() walletProviderSelection: WalletProviderInfo["id"] = "local-socket-signer";
  @state() walletProviderTab: WalletProviderInfo["id"] = "local-socket-signer";
  @state() walletMainPanel: "wallets" | "access" | "skill-grants" = "wallets";
  @state() walletDetailsWalletId = "";
  @state() walletBalanceWalletId = "";
  @state() walletExpandedPanelWalletId = "";
  @state() walletExpandedPanel: "balance" | "security" | "" = "";
  @state() walletPolicyPanel: "caps" | "schedule" | "automation" | "skills" | "sweep" = "caps";
  @state() walletCreateName = "";
  @state() walletCreateId = "";
  @state() walletCreateProvider: WalletProviderInfo["id"] = "local-socket-signer";
  @state() walletCreateRole: "" | "agent" | "mining" | "vault" = "";
  @state() walletCreateRpcUrl = "";
  @state() walletAssignAgentId = "";
  @state() walletAssignWalletId = "";
  @state() walletRpcChain = "solana" as const;
  @state() walletPolicyCapsEnabled = false;
  @state() walletPolicyAutoEnabled = true;
  @state() walletPolicySkillsEnabled = false;
  @state() walletPolicySolMaxPerTx = "";
  @state() walletPolicySolMaxDaily = "";
  @state() walletPolicySolanaAllowPrograms = "";
  @state() walletPolicySolanaTokenCaps: Record<
    string,
    { maxPerTx?: string; maxDaily?: string; decimals: number }
  > = {};
  @state() walletPolicyTokenCapMint = "";
  @state() walletPolicyTokenCapDecimals = "";
  @state() walletPolicyTokenCapMaxPerTx = "";
  @state() walletPolicyTokenCapMaxDaily = "";
  @state() walletPolicyTokenSearchQuery = "";
  @state() walletPolicyTokenSearchLoading = false;
  @state() walletPolicyTokenSearchError: string | null = null;
  @state() walletPolicyTokenSearchResults: WalletSolanaTokenSearchResult[] = [];
  @state() walletRecurringTransferEnabled = false;
  @state() walletRecurringTransferDestination = "";
  @state() walletRecurringTransferMint = "";
  @state() walletRecurringTransferAmountMode: "fixed" | "percentage" = "fixed";
  @state() walletRecurringTransferAmount = "";
  @state() walletRecurringTransferPercentage = "100";
  @state() walletRecurringTransferMinAmount = "";
  @state() walletRecurringTransferKeepAmount = "";
  @state() walletRecurringTransferDecimals = "9";
  @state() walletRecurringTransferCron = "0 9 * * *";
  @state() walletRecurringTransferTz = "";
  @state() walletRecurringTransferName = "";
  @state() walletSecuritySetupWalletId = "";
  @state() walletSecuritySetupRole: "agent" | "mining" | "vault" | null = null;
  @state() walletRpcProvider = "";
  @state() walletRpcApiKey = "";
  @state() walletRpcUrl = "";
  @state() walletProviderApiKey = "";
  @state() walletProviderServerSignerAccessKey = "";
  @state() walletProviderServerSignerAccountId = "";
  @state() walletProviderWalletApiBaseUrl = "";
  @state() walletProviderSignerApiBaseUrl = "";
  @state() walletProviderDefaultSolanaAddress = "";
  @state() walletProviderCredentialsJson = '{\n  "apiKey": ""\n}';
  @state() walletActionBusy = false;
  @state() walletActionMessage: string | null = null;
  @state() walletApprovalsLoading = false;
  @state() walletApprovalsBusyId: string | null = null;
  @state() walletApprovalsError: string | null = null;
  @state() walletApprovalsFilter: WalletApprovalFilter = "pending";
  @state() walletApprovals: WalletSendApprovalRequest[] = [];
  @state() walletAuditLoading = false;
  @state() walletAuditError: string | null = null;
  @state() walletAuditEntries: WalletAuditEntry[] = [];
  @state() walletActivityPage = 1;
  @state() walletResetConfirmText = "";
  @state() walletSendCreateBusy = false;
  @state() walletSendCreateError: string | null = null;
  @state() walletSendCreateForm: WalletSendCreateInput = {
    chain: "solana",
    walletId: "",
    assetId: "",
    to: "",
    amount: "",
    contract: "",
    program: "",
    memo: "",
  };
  @state() walletPasskeyBusy = false;
  @state() walletPasskeyError: string | null = null;
  @state() walletPasskeyLabel = "";

  @state() skillsLoading = false;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillsFilter = "";
  @state() skillsStatusFilter: "all" | "ready" | "needs-setup" | "disabled" = "all";
  @state() skillsLibraryPanel: import("./views/skills.ts").SkillsLibraryPanel = "skills";
  @state() skillEdits: Record<string, string> = {};
  @state() skillsBusyKey: string | null = null;
  @state() skillMessages: Record<string, SkillMessage> = {};
  @state() skillEnvEdits: Record<string, Record<string, string>> = {};
  @state() skillConfigEdits: Record<string, string> = {};
  @state() skillCreateOpen = false;
  @state() skillCreateName = "";
  @state() skillCreateDescription = "";
  @state() skillCreateAgentId = "";
  @state() skillCreateTemplate: SkillCreateTemplate = "general";
  @state() skillCreateBusy = false;
  @state() skillCreateError: string | null = null;
  @state() skillEditor: import("./controllers/skills.ts").SkillEditorState | null = null;
  @state() skillEditorDraft = "";
  @state() skillEditorLoading = false;
  @state() skillEditorSaving = false;
  @state() skillEditorError: string | null = null;
  @state() skillsDetailKey: string | null = null;
  @state() skillsAttachAgentId = "";
  @state() clawhubSearchQuery = "";
  @state() clawhubSearchResults: ClawHubSearchResult[] | null = null;
  @state() clawhubSearchLoading = false;
  @state() clawhubSearchError: string | null = null;
  @state() clawhubDetail: ClawHubSkillDetail | null = null;
  @state() clawhubDetailSlug: string | null = null;
  @state() clawhubDetailLoading = false;
  @state() clawhubDetailError: string | null = null;
  @state() clawhubInstallSlug: string | null = null;
  @state() clawhubInstallMessage: { kind: "success" | "error"; text: string } | null = null;
  @state() clawhubReview: ClawHubMarketplaceReview | null = null;
  @state() clawhubReviewLoading = false;
  @state() clawhubReviewError: string | null = null;
  @state() clawhubInstallTarget: ClawHubInstallTargetValue = "default-agent";
  @state() pluginsMarketplaceLoading = false;
  @state() pluginsMarketplaceDetailLoading = false;
  @state() pluginsMarketplaceError: string | null = null;
  @state() pluginsMarketplaceList: PluginsMarketplaceListResult | null = null;
  @state() pluginsMarketplaceSelectedId: string | null = null;
  @state() pluginsMarketplaceDetail: PluginsMarketplaceInfoResult | null = null;
  @state() pluginsMarketplaceActionBusy: PluginMarketplaceMutationAction | null = null;
  @state() pluginsMarketplaceMessage: string | null = null;
  @state() pluginsMarketplaceRemediation: PluginsMarketplaceRemediationState | null = null;
  @state() extensionsHooksLoading = false;
  @state() extensionsHooksError: string | null = null;
  @state() extensionsHooksStatus: ExtensionsHooksStatusResult | null = null;
  @state() extensionsHooksBusyKey: string | null = null;
  @state() extensionsHooksMessage: string | null = null;

  @state() memoryLoading = false;
  @state() memoryError: string | null = null;
  @state() memoryInventory: DoctorMemoryInventoryPayload | null = null;
  @state() memoryValidation: DoctorMemoryValidationPayload | null = null;
  @state() memoryWiki: MemoryWikiStatus | null = null;
  @state() memoryWikiRebuilding = false;
  @state() memoryWikiError: string | null = null;
  @state() dreamingStatusLoading = false;
  @state() dreamingStatusError: string | null = null;
  @state() dreamingStatus: DreamingStatus | null = null;
  @state() dreamingModeSaving = false;
  @state() dreamDiaryLoading = false;
  @state() dreamDiaryError: string | null = null;
  @state() dreamDiaryPath: string | null = null;
  @state() dreamDiaryContent: string | null = null;

  @state() debugLoading = false;
  @state() debugStatus: StatusSummary | null = null;
  @state() debugHealth: HealthSnapshot | null = null;
  @state() debugModels: unknown[] = [];
  @state() debugModelCatalogStatus: ModelsCatalogStatusResult | null = null;
  @state() debugCommandsCatalog: CommandsListResult | null = null;
  @state() debugUpdateStatus: GatewayUpdateStatusResult | null = null;
  @state() debugPluginsMarketplace: PluginsMarketplaceListResult | null = null;
  @state() debugDiagnosticsStability: DiagnosticStabilitySnapshot | null = null;
  @state() debugMemoryInventory: DoctorMemoryInventoryPayload | null = null;
  @state() debugMemoryValidation: DoctorMemoryValidationPayload | null = null;
  @state() debugMemoryRepairPreview: DoctorMemoryRepairPreviewPayload | null = null;
  @state() debugHeartbeat: unknown = null;
  @state() debugCallMethod = "";
  @state() debugCallParams = "{}";
  @state() debugCallResult: string | null = null;
  @state() debugCallError: string | null = null;
  @state() debugAdminRpcBusy: string | null = null;
  @state() debugAdminRpcResult: string | null = null;
  @state() debugAdminRpcError: string | null = null;
  @state() debugAdminChatSessionKey = "";
  @state() debugAdminChatMessage = "";
  @state() debugAdminPushNodeId = "";
  @state() debugAdminPushTitle = "Fased test push";
  @state() debugAdminPushBody = "Operator test push";
  @state() debugAdminWebAccountId = "main";
  @state() debugAcpxBridgeConfigBusy:
    | import("./controllers/debug.ts").DebugAcpxBridgeConfigAction
    | null = null;
  @state() debugAcpxBridgeConfigResult: string | null = null;
  @state() debugAcpxBridgeConfigError: string | null = null;
  @state() debugAcpxPushTestBusy: import("./controllers/debug.ts").DebugAcpxPushTestAction | null =
    null;
  @state() debugAcpxPushTestPreview:
    | import("./controllers/debug.ts").DebugAcpxPushTestPreviewPayload
    | null = null;
  @state() debugAcpxPushTestAuditHistory:
    | import("./controllers/debug.ts").DebugAcpxPushTestAuditHistoryPayload
    | null = null;
  @state() debugAcpxPushTestResult: string | null = null;
  @state() debugAcpxPushTestError: string | null = null;
  @state() debugSatProtocolMaintenanceBusy = false;
  @state() debugSatProtocolMaintenanceResult: string | null = null;
  @state() debugSatProtocolMaintenanceError: string | null = null;

  @state() logsLoading = false;
  @state() logsError: string | null = null;
  @state() logsFile: string | null = null;
  @state() logsEntries: LogEntry[] = [];
  @state() logsFilterText = "";
  @state() logsLevelFilters: Record<LogLevel, boolean> = {
    ...DEFAULT_LOG_LEVEL_FILTERS,
  };
  @state() logsAutoFollow = true;
  @state() logsTruncated = false;
  @state() logsCursor: number | null = null;
  @state() logsLastFetchAt: number | null = null;
  @state() logsLimit = 500;
  @state() logsMaxBytes = 250_000;
  @state() logsAtBottom = true;

  client: GatewayBrowserClient | null = null;
  private chatScrollFrame: number | null = null;
  private chatScrollTimeout: number | null = null;
  private chatHasAutoScrolled = false;
  private chatUserNearBottom = true;
  private walletSecuritySetupScrollKey = "";
  @state() chatNewMessagesBelow = false;
  private nodesPollInterval: number | null = null;
  private logsPollInterval: number | null = null;
  private debugPollInterval: number | null = null;
  private federationPollInterval: number | null = null;
  private miningPollInterval: number | null = null;
  private miningClockInterval: number | null = null;
  private logsScrollFrame: number | null = null;
  private toolStreamById = new Map<string, ToolStreamEntry>();
  private toolStreamOrder: string[] = [];
  refreshSessionsAfterChat = new Set<string>();
  basePath = "";
  private popStateHandler = () =>
    onPopStateInternal(this as unknown as Parameters<typeof onPopStateInternal>[0]);
  private hashChangeHandler = () => {
    void applySettingsFromUrlInternal();
  };
  private runtimeErrorHandler = (event: ErrorEvent) => {
    const message =
      event.error instanceof Error
        ? (event.error.stack ?? event.error.message)
        : event.message || "Unknown browser runtime error.";
    this.reportUiRuntimeError(message);
  };
  private runtimeRejectionHandler = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : typeof reason === "string"
          ? reason
          : "Unhandled browser promise rejection.";
    this.reportUiRuntimeError(message);
  };
  private themeMedia: MediaQueryList | null = null;
  private themeMediaHandler: ((event: MediaQueryListEvent) => void) | null = null;
  private topbarObserver: ResizeObserver | null = null;
  private overviewSecretsRevealTimer: number | null = null;
  private taskRefreshTimer: number | null = null;
  private selectEnhancerCleanup: (() => void) | null = null;

  createRenderRoot() {
    return this;
  }

  private removeStaticBootShell() {
    for (const child of Array.from(this.children)) {
      if (child.hasAttribute("data-fased-boot-shell")) {
        child.remove();
      }
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this.removeStaticBootShell();
    markControlUiBootStage("connected");
    window.addEventListener("error", this.runtimeErrorHandler);
    window.addEventListener("unhandledrejection", this.runtimeRejectionHandler);
    handleConnected(this as unknown as Parameters<typeof handleConnected>[0]);
  }

  protected firstUpdated() {
    markControlUiBootStage("first-updated");
    this.selectEnhancerCleanup = installGlobalSelectEnhancer(this);
    handleFirstUpdated(this as unknown as Parameters<typeof handleFirstUpdated>[0]);
  }

  disconnectedCallback() {
    if (this.overviewSecretsRevealTimer != null) {
      window.clearTimeout(this.overviewSecretsRevealTimer);
      this.overviewSecretsRevealTimer = null;
    }
    if (this.walletReloadAfterSettingsTimer != null) {
      window.clearTimeout(this.walletReloadAfterSettingsTimer);
      this.walletReloadAfterSettingsTimer = null;
    }
    if (this.taskRefreshTimer != null) {
      window.clearInterval(this.taskRefreshTimer);
      this.taskRefreshTimer = null;
    }
    this.selectEnhancerCleanup?.();
    this.selectEnhancerCleanup = null;
    window.removeEventListener("error", this.runtimeErrorHandler);
    window.removeEventListener("unhandledrejection", this.runtimeRejectionHandler);
    handleDisconnected(this as unknown as Parameters<typeof handleDisconnected>[0]);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    if (changed.size === 0) {
      markControlUiBootStage("rendered");
    }
    handleUpdated(this as unknown as Parameters<typeof handleUpdated>[0], changed);
    if (changed.has("tab") || changed.has("agentsPanel")) {
      this.syncTaskRefreshTimer();
    }
    if (changed.has("channelsSnapshot") || changed.has("configForm")) {
      this.applyNotificationRouteDefaultsFromChannels();
    }
  }

  private syncTaskRefreshTimer() {
    const taskViewActive =
      this.tab === "cron" || (this.tab === "agents" && this.agentsPanel === "cron");
    if (!taskViewActive) {
      if (this.taskRefreshTimer != null) {
        window.clearInterval(this.taskRefreshTimer);
        this.taskRefreshTimer = null;
      }
      return;
    }
    if (this.taskRefreshTimer != null) {
      return;
    }
    this.taskRefreshTimer = window.setInterval(() => {
      if (this.cronLoading || this.cronBusy) {
        return;
      }
      void this.loadCron({ quiet: true });
    }, 10_000);
  }

  connect() {
    this.uiRuntimeError = null;
    connectGatewayInternal(this as unknown as Parameters<typeof connectGatewayInternal>[0]);
  }

  private reportUiRuntimeError(message: string) {
    const cleaned = message.trim() || "Unknown browser runtime error.";
    if (this.uiRuntimeError !== cleaned) {
      this.uiRuntimeError = cleaned;
    }
    console.error("[control-ui] runtime error", cleaned);
  }

  private resetBrowserSessionAndReload() {
    try {
      window.localStorage.removeItem("fased.control.settings.v1");
      window.localStorage.removeItem("fased.control.token.local.v1");
      window.sessionStorage.removeItem("fased.control.token.session.v1");
      for (const key of Object.keys(window.sessionStorage)) {
        if (key.startsWith("fased-control-ui:lazy-tab-reload:")) {
          window.sessionStorage.removeItem(key);
        }
      }
    } catch {
      // Reload anyway; storage can be blocked by browser privacy settings.
    }
    window.location.reload();
  }

  private renderUiRuntimeError(message: string) {
    return html`
      <style>
        .fatal-page {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #080e1a;
          color: #e2e8f0;
          font-family: system-ui, -apple-system, sans-serif;
          padding: 24px;
          box-sizing: border-box;
        }
        .fatal-card {
          width: 100%;
          max-width: 560px;
          background: #0f1929;
          border: 1px solid rgba(248, 113, 113, 0.28);
          border-radius: 16px;
          padding: 32px;
          box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
        }
        .fatal-title {
          margin: 0 0 8px;
          font-size: 22px;
          font-weight: 700;
          color: #f0f4ff;
        }
        .fatal-desc {
          margin: 0 0 18px;
          color: #9aa5bf;
          line-height: 1.6;
        }
        .fatal-error {
          max-height: 180px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
          background: #060d1a;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 10px;
          padding: 12px;
          color: #fca5a5;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 12px;
        }
        .fatal-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 20px;
        }
        .fatal-btn {
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          background: #1d4ed8;
          color: white;
          padding: 10px 14px;
          font-weight: 650;
          cursor: pointer;
        }
        .fatal-btn.secondary {
          background: #111827;
        }
      </style>
      <div class="fatal-page">
        <section class="fatal-card">
          <h1 class="fatal-title">Dashboard could not finish opening</h1>
          <p class="fatal-desc">
            The gateway is reachable, but the browser app hit a runtime error. Reload first. If it
            keeps happening after an update, reset only this browser session and sign in again.
          </p>
          <div class="fatal-error">${message}</div>
          <div class="fatal-actions">
            <button class="fatal-btn" @click=${() => window.location.reload()}>Reload</button>
            <button class="fatal-btn secondary" @click=${() => this.resetBrowserSessionAndReload()}>
              Reset browser session
            </button>
          </div>
        </section>
      </div>
    `;
  }

  async exchangeLoginGrant(grant?: string) {
    const value = (grant ?? this.loginGrantInput).trim();
    if (!value) {
      this.loginGrantError = "Login grant is required.";
      return;
    }
    this.loginGrantPending = true;
    this.loginGrantError = null;
    const exchanged = await exchangeControlUiLoginGrant(value);
    this.loginGrantPending = false;
    if (!exchanged.ok) {
      this.loginGrantError = `Login link failed: ${exchanged.message}`;
      this.authNotice = null;
      return;
    }
    this.applySettings({
      ...this.settings,
      token: exchanged.sessionToken,
    });
    this.authSessionExpiresAt = exchanged.expiresAt ?? null;
    this.authSessionIdleTimeoutSeconds = exchanged.idleTimeoutSeconds ?? null;
    this.authNotice = "Signed in with one-time login link.";
    this.loginGrantInput = "";
    this.loginGrantError = null;
    this.connect();
  }

  async signInWithGatewayToken() {
    const token = this.loginTokenCandidate.trim();
    if (!token) {
      this.loginTokenError = "Gateway token is required.";
      this.authNotice = null;
      return;
    }
    this.loginTokenPending = true;
    this.loginTokenError = null;
    const exchanged = await exchangeControlUiGatewayToken(token);
    this.loginTokenPending = false;
    if (!exchanged.ok) {
      this.loginTokenError = `Sign in failed: ${exchanged.message}`;
      this.authNotice = null;
      return;
    }
    this.loginTokenError = null;
    this.loginTokenCandidate = "";
    this.applySettings({
      ...this.settings,
      token: exchanged.sessionToken,
    });
    this.authSessionExpiresAt = exchanged.expiresAt ?? null;
    this.authSessionIdleTimeoutSeconds = exchanged.idleTimeoutSeconds ?? null;
    this.authNotice = "Signed in with gateway token.";
    this.connect();
  }

  async signOut() {
    const token = this.settings.token.trim();
    const tokenLooksLikeSession = token.length >= 24 && !token.startsWith("tok_");
    if (token && tokenLooksLikeSession) {
      const revoked = await revokeControlUiSessionToken(token);
      if (!revoked.ok && revoked.code !== "invalid_session_token") {
        this.lastError = `sign out warning: ${revoked.message}`;
        this.authNotice = "Signed out locally. Session revocation warning logged.";
      }
    }
    this.client?.stop();
    this.client = null;
    this.connected = false;
    this.hello = null;
    this.password = "";
    this.loginGrantInput = "";
    this.loginTokenCandidate = "";
    this.loginGrantError = null;
    this.authSessionExpiresAt = null;
    this.authSessionIdleTimeoutSeconds = null;
    this.applySettings({
      ...this.settings,
      token: "",
    });
    if (!this.lastError || !this.lastError.toLowerCase().includes("sign out warning")) {
      this.authNotice = "Signed out.";
    }
  }

  unlockOverviewAdvanced() {
    if (this.overviewAdvancedUnlocked) {
      return;
    }
    const ok = window.confirm(
      "Advanced connection settings can break remote access if changed incorrectly. Continue?",
    );
    if (!ok) {
      return;
    }
    this.overviewAdvancedUnlocked = true;
  }

  lockOverviewAdvanced() {
    this.overviewAdvancedUnlocked = false;
    this.overviewSecretsRevealUntilMs = 0;
    if (this.overviewSecretsRevealTimer != null) {
      window.clearTimeout(this.overviewSecretsRevealTimer);
      this.overviewSecretsRevealTimer = null;
    }
  }

  revealOverviewSecrets(ms = 15_000) {
    const until = Date.now() + Math.max(1_000, ms);
    this.overviewSecretsRevealUntilMs = until;
    if (this.overviewSecretsRevealTimer != null) {
      window.clearTimeout(this.overviewSecretsRevealTimer);
    }
    this.overviewSecretsRevealTimer = window.setTimeout(() => {
      this.overviewSecretsRevealUntilMs = 0;
      this.overviewSecretsRevealTimer = null;
    }, ms + 50);
  }

  setDashboardLayout(next: DashboardLayout) {
    this.dashboardLayout = next;
    saveDashboardLayout(next);
  }

  setDashboardWidgetDrawerOpen(next: boolean) {
    this.dashboardWidgetDrawerOpen = next;
  }

  handleChatScroll(event: Event) {
    handleChatScrollInternal(
      this as unknown as Parameters<typeof handleChatScrollInternal>[0],
      event,
    );
  }

  handleLogsScroll(event: Event) {
    handleLogsScrollInternal(
      this as unknown as Parameters<typeof handleLogsScrollInternal>[0],
      event,
    );
  }

  exportLogs(lines: string[], label: string) {
    exportLogsInternal(lines, label);
  }

  resetToolStream() {
    resetToolStreamInternal(this as unknown as Parameters<typeof resetToolStreamInternal>[0]);
  }

  resetChatScroll() {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
  }

  scrollToBottom(opts?: { smooth?: boolean }) {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
    scheduleChatScrollInternal(
      this as unknown as Parameters<typeof scheduleChatScrollInternal>[0],
      true,
      Boolean(opts?.smooth),
    );
  }

  async loadAssistantIdentity() {
    await loadAssistantIdentityInternal(this);
  }

  applySettings(next: UiSettings) {
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], next);
  }

  setTab(next: Tab) {
    if (next === "wallet" && typeof window !== "undefined") {
      const hash = window.location.hash.replace(/^#/, "");
      if (hash === "wallet-skill-grants") {
        this.walletMainPanel = "skill-grants";
      } else if (hash === "wallet-access" || hash === "wallet-admin-control") {
        this.walletMainPanel = "access";
      }
    }
    setTabInternal(this as unknown as Parameters<typeof setTabInternal>[0], next);
  }

  private openTabSection(tab: Tab, sectionId: string) {
    this.setTab(tab);
    void this.updateComplete.then(() => {
      const focusSection = () => {
        const selector = `#${sectionId}`;
        const section = this.renderRoot.querySelector<HTMLElement>(selector);
        section?.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(focusSection);
      } else {
        setTimeout(focusSection, 0);
      }
    });
  }

  handleOperatorReadinessOpenAdminControl() {
    this.walletMainPanel = "access";
    if (typeof window !== "undefined") {
      window.location.hash = "wallet-admin-control";
    }
    this.openTabSection("wallet", "wallet-admin-control");
  }

  handleOperatorReadinessOpenTaskPayment() {
    this.walletMainPanel = "wallets";
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.hash = "";
      window.history.replaceState({}, "", url.toString());
    }
    this.openTabSection("wallet", "wallet-wallets");
  }

  handleOperatorReadinessOpenMining() {
    this.openTabSection("mining", "mining-dashboard");
  }

  handleOperatorReadinessOpenFederationReview() {
    this.openTabSection("federation", "federation-directory");
  }

  setTheme(next: ThemeMode, context?: Parameters<typeof setThemeInternal>[2]) {
    setThemeInternal(this as unknown as Parameters<typeof setThemeInternal>[0], next, context);
  }

  async loadOverview() {
    await loadOverviewInternal(this as unknown as Parameters<typeof loadOverviewInternal>[0]);
  }

  async handleMemoryLoad() {
    await loadMemoryInternal(this as unknown as Parameters<typeof loadMemoryInternal>[0]);
  }

  async handleMemoryWikiRebuild() {
    await rebuildMemoryWikiInternal(
      this as unknown as Parameters<typeof rebuildMemoryWikiInternal>[0],
    );
  }

  async loadCron(opts?: { quiet?: boolean }) {
    await Promise.all([
      loadCronInternal(this as unknown as Parameters<typeof loadCronInternal>[0], opts),
      this.loadTaskWorkflowDefinitions(opts),
      this.loadTaskWorkflowTemplates(opts),
      this.loadTaskStandingOrders(opts),
      this.loadTaskFlowRuns(opts),
    ]);
  }

  async loadTaskLedger(opts?: { quiet?: boolean }) {
    if (!this.client || !this.connected) {
      return;
    }
    const agentId = this.agentsSelectedId ?? this.agentsList?.defaultId ?? this.agentsList?.mainKey;
    if (!opts?.quiet) {
      this.taskLedgerLoading = true;
    }
    this.taskLedgerError = null;
    try {
      const result = await this.client.request<TaskListResult>("tasks.list", {
        ...(agentId ? { agentId } : {}),
        ...(this.taskLedgerSourceFilter !== "all" ? { source: this.taskLedgerSourceFilter } : {}),
        ...(this.taskLedgerStatusFilter !== "all" ? { status: this.taskLedgerStatusFilter } : {}),
        includeAudit: true,
        offset: this.taskLedgerOffset,
        limit: 200,
      });
      if (taskLedgerResultSignature(result) !== taskLedgerResultSignature(this.taskLedger)) {
        this.taskLedger = result;
      }
    } catch (err) {
      this.taskLedgerError = String(err);
    } finally {
      if (!opts?.quiet) {
        this.taskLedgerLoading = false;
      }
    }
  }

  setTaskLedgerSourceFilter(source: import("./types.js").TaskSource | "all") {
    this.taskLedgerSourceFilter = source;
    this.taskLedgerOffset = 0;
    if (this.taskLedgerTypeFilter === "history") {
      void this.loadTaskLedger();
    }
  }

  setTaskLedgerTypeFilter(
    type: "all" | "task" | "trigger" | "workflow" | "graph" | "program" | "history",
  ) {
    this.taskLedgerTypeFilter = type;
    if (type === "history") {
      this.taskLedgerOffset = 0;
    }
    if (type === "history" && !this.taskLedgerLoading) {
      void this.loadTaskLedger();
    }
  }

  setTaskLedgerStatusFilter(status: "all" | "active" | "terminal" | TaskRecord["status"]) {
    this.taskLedgerStatusFilter = status;
    this.taskLedgerOffset = 0;
    if (this.taskLedgerTypeFilter === "history") {
      void this.loadTaskLedger();
    }
  }

  setTaskLedgerPageOffset(offset: number) {
    this.taskLedgerOffset = Math.max(0, Math.floor(offset));
    if (this.taskLedgerTypeFilter === "history") {
      void this.loadTaskLedger();
    }
  }

  async loadTaskLedgerDetail(taskId: string, opts?: { force?: boolean }) {
    const key = taskId.trim();
    if (!key || !this.client || !this.connected) {
      return;
    }
    if (!opts?.force && this.taskLedgerDetails[key]) {
      return;
    }
    this.taskLedgerDetailLoading = { ...this.taskLedgerDetailLoading, [key]: true };
    const nextErrors = { ...this.taskLedgerDetailErrors };
    delete nextErrors[key];
    this.taskLedgerDetailErrors = nextErrors;
    try {
      const agentId =
        this.agentsSelectedId ?? this.agentsList?.defaultId ?? this.agentsList?.mainKey;
      const result = await this.client.request<{ task?: TaskRecord }>("tasks.detail", {
        taskId: key,
        ...(agentId ? { agentId } : {}),
      });
      if (result.task) {
        this.taskLedgerDetails = { ...this.taskLedgerDetails, [key]: result.task };
      }
    } catch (err) {
      this.taskLedgerDetailErrors = { ...this.taskLedgerDetailErrors, [key]: String(err) };
    } finally {
      const rest = { ...this.taskLedgerDetailLoading };
      delete rest[key];
      this.taskLedgerDetailLoading = rest;
    }
  }

  async loadTaskWorkflowDefinitions(opts?: { quiet?: boolean }) {
    if (!this.client || !this.connected) {
      return;
    }
    const agentId = this.agentsSelectedId ?? this.agentsList?.defaultId ?? this.agentsList?.mainKey;
    if (!opts?.quiet) {
      this.taskWorkflowDefinitionsLoading = true;
    }
    this.taskWorkflowDefinitionsError = null;
    try {
      this.taskWorkflowDefinitions = await this.client.request<SavedTaskWorkflowDefinitionsResult>(
        "tasks.workflow.definitions.list",
        agentId ? { agentId } : {},
      );
    } catch (err) {
      this.taskWorkflowDefinitionsError = String(err);
    } finally {
      if (!opts?.quiet) {
        this.taskWorkflowDefinitionsLoading = false;
      }
    }
  }

  async loadTaskWorkflowTemplates(opts?: { quiet?: boolean }) {
    if (!this.client || !this.connected) {
      return;
    }
    if (!opts?.quiet) {
      this.taskWorkflowTemplatesLoading = true;
    }
    this.taskWorkflowTemplatesError = null;
    try {
      this.taskWorkflowTemplates = await this.client.request<TaskWorkflowTemplatesResult>(
        "tasks.workflow.templates.list",
        {},
      );
    } catch (err) {
      this.taskWorkflowTemplatesError = String(err);
    } finally {
      if (!opts?.quiet) {
        this.taskWorkflowTemplatesLoading = false;
      }
    }
  }

  async loadTaskStandingOrders(opts?: { quiet?: boolean }) {
    if (!this.client || !this.connected) {
      return;
    }
    const agentId = this.agentsSelectedId ?? this.agentsList?.defaultId ?? this.agentsList?.mainKey;
    if (!opts?.quiet) {
      this.taskStandingOrdersLoading = true;
    }
    this.taskStandingOrdersError = null;
    try {
      this.taskStandingOrders = await this.client.request<StandingOrdersResult>(
        "tasks.standingOrders.list",
        agentId ? { agentId } : {},
      );
    } catch (err) {
      this.taskStandingOrdersError = String(err);
    } finally {
      if (!opts?.quiet) {
        this.taskStandingOrdersLoading = false;
      }
    }
  }

  startTaskStandingOrderCreate(_agentId: string) {
    this.taskStandingOrderDraft = {
      name: "New program",
      instructions: "Propose a task or workflow when this standing order should act.",
      triggerHint: "",
      proposalKind: "workflow",
      status: "enabled",
    };
    this.taskStandingOrdersError = null;
    this.taskStandingOrdersMessage = null;
  }

  editTaskStandingOrder(order: StandingOrderRecord) {
    this.taskStandingOrderDraft = {
      id: order.id,
      name: order.name,
      instructions: order.instructions,
      triggerHint: order.triggerHint ?? "",
      proposalKind: order.proposalKind,
      status: order.status,
    };
    this.taskStandingOrdersError = null;
    this.taskStandingOrdersMessage = null;
  }

  patchTaskStandingOrderDraft(patch: Partial<StandingOrderDraft>) {
    const current =
      this.taskStandingOrderDraft ??
      ({
        name: "New program",
        instructions: "",
        triggerHint: "",
        proposalKind: "workflow",
        status: "enabled",
      } satisfies StandingOrderDraft);
    this.taskStandingOrderDraft = { ...current, ...patch };
  }

  cancelTaskStandingOrderDraft() {
    this.taskStandingOrderDraft = null;
    this.taskStandingOrdersError = null;
  }

  async saveTaskStandingOrderDraft(agentId: string) {
    if (!this.client || !this.connected || !this.taskStandingOrderDraft) {
      return;
    }
    this.taskStandingOrdersBusy = true;
    this.taskStandingOrdersError = null;
    this.taskStandingOrdersMessage = null;
    try {
      const result = await this.client.request<{
        order?: StandingOrderRecord;
        result?: StandingOrdersResult;
      }>("tasks.standingOrders.save", {
        ...this.taskStandingOrderDraft,
        agentId,
      });
      if (result.result) {
        this.taskStandingOrders = result.result;
      } else {
        await this.loadTaskStandingOrders({ quiet: true });
      }
      this.taskStandingOrderDraft = null;
      this.taskStandingOrdersMessage = result.order
        ? `Saved program ${result.order.name}.`
        : "Saved program.";
    } catch (err) {
      this.taskStandingOrdersError = String(err);
    } finally {
      this.taskStandingOrdersBusy = false;
    }
  }

  async removeTaskStandingOrder(order: StandingOrderRecord) {
    if (!this.client || !this.connected) {
      return;
    }
    this.taskStandingOrdersBusy = true;
    this.taskStandingOrdersError = null;
    this.taskStandingOrdersMessage = null;
    try {
      const result = await this.client.request<{ result?: StandingOrdersResult }>(
        "tasks.standingOrders.remove",
        { agentId: order.agentId, id: order.id },
      );
      if (result.result) {
        this.taskStandingOrders = result.result;
      } else {
        await this.loadTaskStandingOrders({ quiet: true });
      }
      this.taskStandingOrdersMessage = `Removed program ${order.name}.`;
    } catch (err) {
      this.taskStandingOrdersError = String(err);
    } finally {
      this.taskStandingOrdersBusy = false;
    }
  }

  async proposeTaskStandingOrder(order: StandingOrderRecord) {
    if (!this.client || !this.connected) {
      return;
    }
    this.taskStandingOrdersBusy = true;
    this.taskStandingOrdersError = null;
    this.taskStandingOrdersMessage = null;
    try {
      const result = await this.client.request<{ task?: TaskRecord; order?: StandingOrderRecord }>(
        "tasks.standingOrders.propose",
        { agentId: order.agentId, id: order.id },
      );
      this.taskStandingOrdersMessage = result.task
        ? `Program proposal added to run history: ${result.task.task}.`
        : "Program proposal added to run history.";
      await this.loadTaskStandingOrders({ quiet: true });
      await this.loadTaskLedger({ quiet: true });
      await this.loadTaskFlowRuns({ quiet: true });
    } catch (err) {
      this.taskStandingOrdersError = String(err);
    } finally {
      this.taskStandingOrdersBusy = false;
    }
  }

  async loadTaskFlowRuns(opts?: { quiet?: boolean }) {
    if (!this.client || !this.connected) {
      return;
    }
    const agentId = this.agentsSelectedId ?? this.agentsList?.defaultId ?? this.agentsList?.mainKey;
    if (!opts?.quiet) {
      this.taskFlowRunsLoading = true;
    }
    this.taskFlowRunsError = null;
    try {
      this.taskFlowRuns = await this.client.request<TaskFlowListResult>("tasks.flow.list", {
        ...(agentId ? { agentId } : {}),
        limit: 100,
      });
    } catch (err) {
      this.taskFlowRunsError = String(err);
    } finally {
      if (!opts?.quiet) {
        this.taskFlowRunsLoading = false;
      }
    }
  }

  async controlTaskLedger(
    action: "approve" | "reject" | "cancel" | "retry" | "notify",
    taskId: string,
  ) {
    if (!this.client || !this.connected) {
      return;
    }
    this.taskLedgerBusy = true;
    this.taskLedgerError = null;
    const agentId = this.agentsSelectedId ?? this.agentsList?.defaultId ?? this.agentsList?.mainKey;
    const agentScope = agentId ? { agentId } : {};
    try {
      if (action === "cancel") {
        await this.client.request("tasks.cancel", {
          taskId,
          reason: "Cancelled from Agent Tasks.",
          ...agentScope,
        });
      } else if (action === "retry") {
        await this.client.request("tasks.retry", {
          taskId,
          reason: "Retried from Agent Tasks.",
          ...agentScope,
        });
      } else if (action === "approve") {
        await this.client.request("tasks.workflow.resume", {
          taskId,
          actor: "Control UI",
          reason: "Approved from Agent Tasks.",
          ...agentScope,
        });
      } else if (action === "reject") {
        await this.client.request("tasks.workflow.resume", {
          taskId,
          decision: "rejected",
          actor: "Control UI",
          reason: "Rejected from Agent Tasks.",
          ...agentScope,
        });
      } else {
        await this.client.request("tasks.notify", {
          taskId,
          notifyPolicy: "state_changes",
          ...agentScope,
        });
      }
      const details = { ...this.taskLedgerDetails };
      const detailErrors = { ...this.taskLedgerDetailErrors };
      delete details[taskId];
      delete detailErrors[taskId];
      this.taskLedgerDetails = details;
      this.taskLedgerDetailErrors = detailErrors;
      await this.loadTaskLedger({ quiet: true });
      await this.loadTaskFlowRuns({ quiet: true });
      await loadCronInternal(this as unknown as Parameters<typeof loadCronInternal>[0], {
        quiet: true,
      });
    } catch (err) {
      this.taskLedgerError = String(err);
    } finally {
      this.taskLedgerBusy = false;
    }
  }

  async runTaskLedgerMaintenance(opts?: {
    cleanupOrphanedCronRuns?: boolean;
    staleRunningMs?: number;
  }) {
    if (!this.client || !this.connected) {
      return;
    }
    this.taskLedgerBusy = true;
    this.taskLedgerError = null;
    this.taskLedgerMaintenanceMessage = null;
    try {
      const result = await this.client.request<{
        updated?: number;
        findings?: Array<{ severity?: string }>;
      }>("tasks.maintenance", {
        ...(opts?.cleanupOrphanedCronRuns ? { cleanupOrphanedCronRuns: true } : {}),
        ...(opts?.staleRunningMs ? { staleRunningMs: opts.staleRunningMs } : {}),
      });
      const updated = result.updated ?? 0;
      const warnings = (result.findings ?? []).filter((finding) => finding.severity !== "info");
      this.taskLedgerMaintenanceMessage = opts?.cleanupOrphanedCronRuns
        ? `Task maintenance cleaned ${updated} stale record${
            updated === 1 ? "" : "s"
          }; ${warnings.length} warning${warnings.length === 1 ? "" : "s"} remain.`
        : opts?.staleRunningMs
          ? `Task maintenance marked ${updated} stuck record${
              updated === 1 ? "" : "s"
            } lost; ${warnings.length} warning${warnings.length === 1 ? "" : "s"} remain.`
          : `Task maintenance updated ${updated} record${
              updated === 1 ? "" : "s"
            }; ${warnings.length} warning${warnings.length === 1 ? "" : "s"} remain.`;
      await this.loadTaskLedger({ quiet: true });
      await this.loadTaskFlowRuns({ quiet: true });
      await loadCronInternal(this as unknown as Parameters<typeof loadCronInternal>[0], {
        quiet: true,
      });
    } catch (err) {
      this.taskLedgerError = String(err);
    } finally {
      this.taskLedgerBusy = false;
    }
  }

  startTaskWorkflowCreate(agentId: string) {
    this.taskWorkflowDraft = {
      name: "New workflow",
      task: "Run a simple operator workflow.",
      stepsText: "note: Prepare context\ncheckpoint: Run check\nhandoff: Record follow-up",
      notifyPolicy: "done_only",
    };
    this.taskWorkflowGraphDraft = null;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = `Workflow will run as ${agentId}.`;
  }

  startTaskWorkflowGraphCreate(agentId: string) {
    this.taskWorkflowGraphDraft = createTaskWorkflowGraphDraft();
    this.taskWorkflowDraft = null;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = `Graph workflow will run as ${agentId}.`;
  }

  startTaskWorkflowFromTemplate(agentId: string, template: TaskWorkflowTemplate) {
    if (template.graph) {
      this.taskWorkflowGraphDraft = normalizeTaskWorkflowGraphDraft({
        name: template.name,
        task: template.task,
        notifyPolicy: template.notifyPolicy,
        graph: template.graph,
        selectedNodeId:
          template.graph.nodes.find((node) => node.type !== "start")?.id ??
          template.graph.startNodeId,
        selectedEdgeId: null,
        connectFromNodeId: null,
      });
      this.taskWorkflowDraft = null;
      this.taskWorkflowError = null;
      this.taskWorkflowMessage = `${template.name} graph template will run as ${agentId}.`;
      return;
    }
    this.taskWorkflowDraft = {
      name: template.name,
      task: template.task,
      notifyPolicy: template.notifyPolicy,
      stepsText: template.steps.map((step) => workflowStepToDraftLine(step)).join("\n"),
    };
    this.taskWorkflowGraphDraft = null;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = `${template.name} template will run as ${agentId}.`;
  }

  startTaskWorkflowFromLedgerTask(agentId: string, task: TaskRecord) {
    const templateId = taskWorkflowTemplateIdForTask(task);
    const template = this.taskWorkflowTemplates?.templates.find((entry) => entry.id === templateId);
    if (!templateId || !template) {
      this.taskWorkflowError = `No workflow template is available for ${task.source} tasks.`;
      this.taskWorkflowMessage = null;
      return;
    }
    this.startTaskWorkflowFromTemplate(agentId, sourceWorkflowTemplateFromTask(template, task));
    if (this.taskWorkflowGraphDraft) {
      this.taskWorkflowGraphDraft = normalizeTaskWorkflowGraphDraft({
        ...this.taskWorkflowGraphDraft,
        runState: taskWorkflowRunStateFromLedgerTask(task),
        sourceTask: taskWorkflowSourceTaskFromLedgerTask(task),
      });
    }
    this.taskWorkflowMessage = `${template.name} opened for run history item ${task.taskId}.`;
  }

  editTaskWorkflowDefinition(definition: SavedTaskWorkflowDefinition) {
    this.taskWorkflowDraft = taskWorkflowDefinitionToDraft(definition);
    this.taskWorkflowGraphDraft = null;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = `Editing ${definition.name}.`;
  }

  editTaskWorkflowGraphDefinition(definition: SavedTaskWorkflowDefinition) {
    const runState = latestTaskWorkflowRunStateForDefinition({
      definition,
      ledger: this.taskLedger,
      details: this.taskLedgerDetails,
      flows: this.taskFlowRuns,
    });
    this.taskWorkflowGraphDraft = taskWorkflowGraphDefinitionToDraft(definition, runState);
    this.taskWorkflowDraft = null;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = runState
      ? `Editing graph ${definition.name}. Latest run ${runState.status.replace("_", " ")}.`
      : `Editing graph ${definition.name}.`;
  }

  openTaskWorkflowRunGraph(flow: TaskFlowRecord) {
    const definition = this.taskWorkflowDefinitions?.definitions.find(
      (entry) => entry.mode === "graph" && entry.graph && entry.id === flow.definitionId,
    );
    if (!definition) {
      this.taskWorkflowError = `No graph workflow definition is available for ${flow.goal}.`;
      this.taskWorkflowMessage = null;
      return;
    }
    const runState = latestTaskWorkflowRunStateForFlow({
      flow,
      ledger: this.taskLedger,
      details: this.taskLedgerDetails,
    });
    this.taskWorkflowGraphDraft = taskWorkflowGraphDefinitionToDraft(definition, runState);
    this.taskWorkflowDraft = null;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = runState
      ? `Viewing graph ${definition.name}. Run ${flow.flowId} is ${runState.status.replace("_", " ")}.`
      : `Viewing graph ${definition.name}. Run ${flow.flowId} has no loaded ledger detail yet.`;
  }

  patchTaskWorkflowDraft(patch: Partial<TaskWorkflowDraft>) {
    this.taskWorkflowDraft = {
      ...(this.taskWorkflowDraft ?? {
        name: "New workflow",
        task: "",
        stepsText: "",
        notifyPolicy: "done_only" as const,
      }),
      ...patch,
    };
  }

  patchTaskWorkflowGraphDraft(patch: Partial<TaskWorkflowGraphDraft>) {
    const current = this.taskWorkflowGraphDraft ?? createTaskWorkflowGraphDraft();
    this.taskWorkflowGraphDraft = normalizeTaskWorkflowGraphDraft({
      ...current,
      ...patch,
      jsonText:
        patch.graph && patch.jsonText === undefined
          ? graphJsonText(patch.graph)
          : (patch.jsonText ?? current.jsonText),
    });
  }

  private updateTaskWorkflowGraph(
    updater: (draft: TaskWorkflowGraphDraft) => TaskWorkflowGraphDraft,
  ) {
    const next = updater(this.taskWorkflowGraphDraft ?? createTaskWorkflowGraphDraft());
    this.taskWorkflowGraphDraft = normalizeTaskWorkflowGraphDraft({
      ...next,
      jsonText: graphJsonText(next.graph),
    });
  }

  addTaskWorkflowGraphNode(type: TaskWorkflowGraphNodeType) {
    this.updateTaskWorkflowGraph((draft) => {
      const count = draft.graph.nodes.length + 1;
      const label = defaultGraphNodeLabel(type);
      const id = normalizeWorkflowGraphId(`${type}-${count}`, `${type}-${generateUUID()}`);
      const layoutNodes = draft.graph.layout?.nodes ? { ...draft.graph.layout.nodes } : {};
      const node: TaskWorkflowGraphNode = {
        id,
        type,
        label,
        ...(type === "approval" ? { input: "Approve this workflow step." } : {}),
        ...(type === "condition" ? { condition: { kind: "always" as const } } : {}),
      };
      return {
        ...draft,
        selectedNodeId: id,
        selectedEdgeId: null,
        graph: {
          ...draft.graph,
          nodes: [...draft.graph.nodes, node],
          layout: {
            nodes: {
              ...layoutNodes,
              [id]: { x: 80 + ((count - 1) % 4) * 272, y: 90 + Math.floor((count - 1) / 4) * 142 },
            },
          },
        },
      };
    });
  }

  updateTaskWorkflowGraphNode(nodeId: string, patch: Partial<TaskWorkflowGraphNode>) {
    this.updateTaskWorkflowGraph((draft) => ({
      ...draft,
      graph: {
        ...draft.graph,
        nodes: draft.graph.nodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                ...patch,
                id: node.id,
                type: patch.type ?? node.type,
              }
            : node,
        ),
      },
    }));
  }

  removeTaskWorkflowGraphNode(nodeId: string) {
    this.updateTaskWorkflowGraph((draft) => {
      const nodes = draft.graph.nodes.filter((node) => node.id !== nodeId);
      if (!nodes.length) {
        return draft;
      }
      const nextStartNodeId =
        draft.graph.startNodeId === nodeId ? nodes[0].id : draft.graph.startNodeId;
      const layoutNodes = draft.graph.layout?.nodes ? { ...draft.graph.layout.nodes } : {};
      delete layoutNodes[nodeId];
      return {
        ...draft,
        selectedNodeId: draft.selectedNodeId === nodeId ? nextStartNodeId : draft.selectedNodeId,
        selectedEdgeId: null,
        connectFromNodeId: draft.connectFromNodeId === nodeId ? null : draft.connectFromNodeId,
        graph: {
          ...draft.graph,
          startNodeId: nextStartNodeId,
          nodes,
          edges: draft.graph.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
          layout: { nodes: layoutNodes },
        },
      };
    });
  }

  moveTaskWorkflowGraphNode(nodeId: string, x: number, y: number) {
    this.updateTaskWorkflowGraph((draft) => {
      const layoutNodes = draft.graph.layout?.nodes ? { ...draft.graph.layout.nodes } : {};
      return {
        ...draft,
        graph: {
          ...draft.graph,
          layout: {
            nodes: {
              ...layoutNodes,
              [nodeId]: {
                x: Math.max(0, Math.min(2_000, Math.round(x))),
                y: Math.max(0, Math.min(2_000, Math.round(y))),
              },
            },
          },
        },
      };
    });
  }

  addTaskWorkflowGraphEdge(from: string, to: string, on?: TaskWorkflowGraphEdgeEvent) {
    this.updateTaskWorkflowGraph((draft) => {
      if (from === to) {
        return { ...draft, connectFromNodeId: null };
      }
      const event = on ?? "success";
      const id = normalizeWorkflowGraphId(`${from}-${event}-${to}`, `edge-${generateUUID()}`);
      const edge: TaskWorkflowGraphEdge = { id, from, to, on: event };
      return {
        ...draft,
        selectedEdgeId: id,
        selectedNodeId: null,
        connectFromNodeId: null,
        graph: {
          ...draft.graph,
          edges: [...draft.graph.edges.filter((entry) => entry.id !== id), edge],
        },
      };
    });
  }

  updateTaskWorkflowGraphEdge(edgeId: string, patch: Partial<TaskWorkflowGraphEdge>) {
    this.updateTaskWorkflowGraph((draft) => ({
      ...draft,
      graph: {
        ...draft.graph,
        edges: draft.graph.edges.map((edge) =>
          edge.id === edgeId
            ? {
                ...edge,
                ...patch,
                id: edge.id,
              }
            : edge,
        ),
      },
    }));
  }

  removeTaskWorkflowGraphEdge(edgeId: string) {
    this.updateTaskWorkflowGraph((draft) => ({
      ...draft,
      selectedEdgeId: draft.selectedEdgeId === edgeId ? null : draft.selectedEdgeId,
      graph: {
        ...draft.graph,
        edges: draft.graph.edges.filter((edge) => edge.id !== edgeId),
      },
    }));
  }

  autoLayoutTaskWorkflowGraph() {
    this.updateTaskWorkflowGraph((draft) => {
      const incoming = new Map<string, number>();
      const outgoing = new Map<string, string[]>();
      for (const node of draft.graph.nodes) {
        incoming.set(node.id, 0);
        outgoing.set(node.id, []);
      }
      for (const edge of draft.graph.edges) {
        incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
        outgoing.get(edge.from)?.push(edge.to);
      }
      const levels = new Map<string, number>([[draft.graph.startNodeId, 0]]);
      const queue = [draft.graph.startNodeId];
      while (queue.length) {
        const current = queue.shift()!;
        const level = levels.get(current) ?? 0;
        for (const next of outgoing.get(current) ?? []) {
          if (!levels.has(next) || (levels.get(next) ?? 0) < level + 1) {
            levels.set(next, level + 1);
            queue.push(next);
          }
        }
      }
      for (const node of draft.graph.nodes) {
        if (!levels.has(node.id)) {
          levels.set(node.id, Math.max(0, ...levels.values()) + 1);
        }
      }
      const grouped = new Map<number, TaskWorkflowGraphNode[]>();
      for (const node of draft.graph.nodes) {
        const level = levels.get(node.id) ?? 0;
        grouped.set(level, [...(grouped.get(level) ?? []), node]);
      }
      const layoutNodes: Record<string, { x: number; y: number }> = {};
      for (const [level, nodes] of grouped.entries()) {
        nodes
          .toSorted(
            (a, b) =>
              (incoming.get(a.id) ?? 0) - (incoming.get(b.id) ?? 0) ||
              a.label.localeCompare(b.label),
          )
          .forEach((node, index) => {
            layoutNodes[node.id] = { x: 48 + level * 280, y: 64 + index * 136 };
          });
      }
      return {
        ...draft,
        panX: 0,
        panY: 0,
        zoom: 1,
        graph: {
          ...draft.graph,
          layout: { nodes: layoutNodes },
        },
      };
    });
  }

  importTaskWorkflowGraphJson() {
    const draft = this.taskWorkflowGraphDraft;
    if (!draft) {
      return;
    }
    try {
      const parsed = JSON.parse(draft.jsonText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Graph JSON must be an object.");
      }
      const graph = parsed as TaskWorkflowGraphDraft["graph"];
      if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        throw new Error("Graph JSON requires nodes and edges arrays.");
      }
      this.taskWorkflowGraphDraft = normalizeTaskWorkflowGraphDraft({
        ...draft,
        graph,
        selectedNodeId: graph.nodes[0]?.id ?? null,
        selectedEdgeId: null,
        connectFromNodeId: null,
        jsonText: graphJsonText(graph),
      });
      this.taskWorkflowError = null;
      this.taskWorkflowMessage = "Graph JSON imported.";
    } catch (err) {
      this.taskWorkflowError = `Graph JSON import failed: ${String(err)}`;
    }
  }

  exportTaskWorkflowGraphJson() {
    const draft = this.taskWorkflowGraphDraft;
    if (!draft) {
      return;
    }
    const jsonText = graphJsonText(draft.graph);
    this.taskWorkflowGraphDraft = { ...draft, jsonText, jsonOpen: true };
    void navigator.clipboard?.writeText(jsonText).catch(() => {});
    this.taskWorkflowMessage = "Graph JSON refreshed and copied when clipboard is available.";
  }

  cancelTaskWorkflowDraft() {
    this.taskWorkflowDraft = null;
    this.taskWorkflowGraphDraft = null;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = null;
  }

  private buildTaskWorkflowPayload(agentId: string) {
    const draft = this.taskWorkflowDraft;
    if (!draft) {
      return null;
    }
    const steps = draft.stepsText
      .split(/\r?\n/g)
      .map((line, index) => parseWorkflowStepLine(line, index))
      .filter((step): step is UiWorkflowStepPayload => Boolean(step));
    return {
      agentId,
      ...(draft.id ? { id: draft.id } : {}),
      ...(draft.id ? { definitionId: draft.id } : {}),
      sessionKey: `agent:${agentId}:main`,
      name: draft.name,
      task: draft.task || draft.name,
      notifyPolicy: draft.notifyPolicy,
      steps,
    };
  }

  private buildTaskWorkflowGraphPayload(agentId: string) {
    const draft = this.taskWorkflowGraphDraft;
    if (!draft) {
      return null;
    }
    return {
      agentId,
      ...(draft.id ? { id: draft.id } : {}),
      ...(draft.id ? { definitionId: draft.id } : {}),
      sessionKey: `agent:${agentId}:main`,
      name: draft.name,
      task: draft.task || draft.name,
      notifyPolicy: draft.notifyPolicy,
      graph: draft.graph,
      ...(draft.sourceTask ? { sourceTask: draft.sourceTask } : {}),
    };
  }

  private notifyTaskWorkflowState(params: {
    policy: TaskWorkflowDraft["notifyPolicy"];
    task?: TaskRecord | null;
    title: string;
    message: string;
    stateChange?: boolean;
  }) {
    if (params.policy === "silent") {
      return;
    }
    if (params.stateChange && params.policy !== "state_changes") {
      return;
    }
    const status = params.task?.status;
    const failed =
      status === "failed" ||
      status === "timed_out" ||
      status === "lost" ||
      status === "blocked" ||
      status === "cancelled";
    this.enqueueAppNotification({
      code: params.stateChange ? "task.state_changed" : failed ? "task.failed" : "task.completed",
      category: "task",
      level: params.stateChange ? "info" : failed ? "error" : "success",
      title: params.title,
      message: params.message,
      dedupeKey: `task:${params.task?.taskId ?? params.title}:${params.stateChange ? "state" : "done"}`,
    });
  }

  async previewTaskWorkflow(agentId: string) {
    if (!this.client || !this.connected || !this.taskWorkflowDraft) {
      return;
    }
    const payload = this.buildTaskWorkflowPayload(agentId);
    if (!payload) {
      return;
    }
    this.taskWorkflowBusy = true;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = null;
    try {
      const result = await this.client.request<{ steps?: unknown[] }>(
        "tasks.workflow.preview",
        payload,
      );
      const previewSteps = Array.isArray(result.steps) ? result.steps : payload.steps;
      const approvalGates = previewSteps.filter(
        (step) =>
          step &&
          typeof step === "object" &&
          !Array.isArray(step) &&
          (step as { type?: unknown }).type === "approval",
      ).length;
      this.taskWorkflowMessage = `Preview ok: ${previewSteps.length} steps${
        approvalGates ? ` · ${approvalGates} approval gate${approvalGates === 1 ? "" : "s"}` : ""
      }.`;
    } catch (err) {
      this.taskWorkflowError = String(err);
    } finally {
      this.taskWorkflowBusy = false;
    }
  }

  async previewTaskWorkflowGraphDraft(agentId: string) {
    if (!this.client || !this.connected || !this.taskWorkflowGraphDraft) {
      return;
    }
    const payload = this.buildTaskWorkflowGraphPayload(agentId);
    if (!payload) {
      return;
    }
    this.taskWorkflowBusy = true;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = null;
    try {
      const result = await this.client.request<{
        graph?: { nodes?: unknown[]; edges?: unknown[] };
        warnings?: string[];
      }>("tasks.workflow.graph.preview", payload);
      const nodeCount = Array.isArray(result.graph?.nodes)
        ? result.graph.nodes.length
        : payload.graph.nodes.length;
      const edgeCount = Array.isArray(result.graph?.edges)
        ? result.graph.edges.length
        : payload.graph.edges.length;
      const warningCount = Array.isArray(result.warnings) ? result.warnings.length : 0;
      this.taskWorkflowMessage = `Graph preview ok: ${nodeCount} nodes · ${edgeCount} edges${
        warningCount ? ` · ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""
      }.`;
    } catch (err) {
      this.taskWorkflowError = String(err);
    } finally {
      this.taskWorkflowBusy = false;
    }
  }

  async saveTaskWorkflowDefinitionDraft(agentId: string) {
    if (!this.client || !this.connected || !this.taskWorkflowDraft) {
      return;
    }
    const payload = this.buildTaskWorkflowPayload(agentId);
    if (!payload) {
      return;
    }
    this.taskWorkflowDefinitionsBusy = true;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = null;
    try {
      const result = await this.client.request<{
        definition?: SavedTaskWorkflowDefinition;
        result?: SavedTaskWorkflowDefinitionsResult;
      }>("tasks.workflow.definitions.save", payload);
      if (result.result) {
        this.taskWorkflowDefinitions = result.result;
      } else {
        await this.loadTaskWorkflowDefinitions({ quiet: true });
      }
      this.taskWorkflowMessage = `${result.definition?.name ?? payload.name} saved.`;
      this.taskWorkflowDraft = null;
    } catch (err) {
      this.taskWorkflowError = String(err);
    } finally {
      this.taskWorkflowDefinitionsBusy = false;
    }
  }

  async saveTaskWorkflowGraphDefinitionDraft(agentId: string) {
    if (!this.client || !this.connected || !this.taskWorkflowGraphDraft) {
      return;
    }
    const payload = this.buildTaskWorkflowGraphPayload(agentId);
    if (!payload) {
      return;
    }
    this.taskWorkflowDefinitionsBusy = true;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = null;
    try {
      const result = await this.client.request<{
        definition?: SavedTaskWorkflowDefinition;
        result?: SavedTaskWorkflowDefinitionsResult;
      }>("tasks.workflow.definitions.save", payload);
      if (result.result) {
        this.taskWorkflowDefinitions = result.result;
      } else {
        await this.loadTaskWorkflowDefinitions({ quiet: true });
      }
      this.taskWorkflowMessage = `${result.definition?.name ?? payload.name} graph saved.`;
      this.taskWorkflowGraphDraft = null;
    } catch (err) {
      this.taskWorkflowError = String(err);
    } finally {
      this.taskWorkflowDefinitionsBusy = false;
    }
  }

  async runTaskWorkflowDefinition(definition: SavedTaskWorkflowDefinition) {
    if (!this.client || !this.connected) {
      return;
    }
    this.taskWorkflowBusy = true;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = null;
    this.notifyTaskWorkflowState({
      policy: definition.notifyPolicy,
      title: "Workflow started",
      message: definition.name,
      stateChange: true,
    });
    try {
      const payload = {
        agentId: definition.agentId,
        sessionKey: `agent:${definition.agentId}:main`,
        name: definition.name,
        task: definition.task,
        definitionId: definition.id,
        sourceId: definition.id,
        notifyPolicy: definition.notifyPolicy,
        ...(definition.graph ? { graph: definition.graph } : { steps: definition.steps }),
      };
      const result = await this.client.request<{ task?: TaskRecord }>(
        definition.graph ? "tasks.workflow.graph.run" : "tasks.workflow.run",
        payload,
      );
      this.taskWorkflowMessage =
        result.task?.status === "blocked"
          ? "Workflow paused for approval."
          : "Workflow run recorded in run history.";
      this.notifyTaskWorkflowState({
        policy: definition.notifyPolicy,
        task: result.task ?? null,
        title:
          result.task?.status === "succeeded" ? "Workflow completed" : "Workflow state changed",
        message:
          result.task?.terminalSummary ??
          result.task?.progressSummary ??
          result.task?.error ??
          definition.name,
      });
      await Promise.all([
        this.loadTaskLedger({ quiet: true }),
        this.loadTaskFlowRuns({ quiet: true }),
      ]);
    } catch (err) {
      this.taskWorkflowError = String(err);
      this.notifyTaskWorkflowState({
        policy: definition.notifyPolicy,
        title: "Workflow failed",
        message: String(err),
      });
    } finally {
      this.taskWorkflowBusy = false;
    }
  }

  async removeTaskWorkflowDefinition(definition: SavedTaskWorkflowDefinition) {
    if (!this.client || !this.connected) {
      return;
    }
    this.taskWorkflowDefinitionsBusy = true;
    this.taskWorkflowDefinitionsError = null;
    try {
      const result = await this.client.request<{ result?: SavedTaskWorkflowDefinitionsResult }>(
        "tasks.workflow.definitions.remove",
        { agentId: definition.agentId, id: definition.id },
      );
      if (result.result) {
        this.taskWorkflowDefinitions = result.result;
      } else {
        await this.loadTaskWorkflowDefinitions({ quiet: true });
      }
      if (this.taskWorkflowDraft?.id === definition.id) {
        this.taskWorkflowDraft = null;
      }
      this.taskWorkflowMessage = `${definition.name} deleted.`;
    } catch (err) {
      this.taskWorkflowDefinitionsError = String(err);
    } finally {
      this.taskWorkflowDefinitionsBusy = false;
    }
  }

  async cancelTaskFlowRun(flow: TaskFlowRecord) {
    if (!this.client || !this.connected) {
      return;
    }
    this.taskFlowRunsBusy = true;
    this.taskFlowRunsError = null;
    try {
      const agentId = flow.agentId ?? this.agentsSelectedId ?? this.agentsList?.defaultId;
      await this.client.request("tasks.flow.cancel", {
        flowId: flow.flowId,
        reason: "Cancelled from Agent Tasks.",
        ...(agentId ? { agentId } : {}),
      });
      this.taskWorkflowMessage = `${flow.goal} cancelled.`;
      await Promise.all([
        this.loadTaskFlowRuns({ quiet: true }),
        this.loadTaskLedger({ quiet: true }),
      ]);
    } catch (err) {
      this.taskFlowRunsError = String(err);
    } finally {
      this.taskFlowRunsBusy = false;
    }
  }

  async runTaskWorkflow(agentId: string) {
    if (!this.client || !this.connected || !this.taskWorkflowDraft) {
      return;
    }
    const payload = this.buildTaskWorkflowPayload(agentId);
    if (!payload) {
      return;
    }
    this.taskWorkflowBusy = true;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = null;
    this.notifyTaskWorkflowState({
      policy: payload.notifyPolicy,
      title: "Workflow started",
      message: payload.name,
      stateChange: true,
    });
    try {
      const result = await this.client.request<{ task?: TaskRecord }>(
        "tasks.workflow.run",
        payload,
      );
      this.taskWorkflowMessage =
        result.task?.status === "blocked"
          ? "Workflow paused for approval."
          : "Workflow run recorded in run history.";
      this.notifyTaskWorkflowState({
        policy: payload.notifyPolicy,
        task: result.task ?? null,
        title:
          result.task?.status === "succeeded" ? "Workflow completed" : "Workflow state changed",
        message:
          result.task?.terminalSummary ??
          result.task?.progressSummary ??
          result.task?.error ??
          payload.name,
      });
      this.taskWorkflowDraft = null;
      await Promise.all([
        this.loadTaskLedger({ quiet: true }),
        this.loadTaskFlowRuns({ quiet: true }),
      ]);
    } catch (err) {
      this.taskWorkflowError = String(err);
      this.notifyTaskWorkflowState({
        policy: payload.notifyPolicy,
        title: "Workflow failed",
        message: String(err),
      });
    } finally {
      this.taskWorkflowBusy = false;
    }
  }

  async runTaskWorkflowGraphDraft(agentId: string) {
    if (!this.client || !this.connected || !this.taskWorkflowGraphDraft) {
      return;
    }
    const payload = this.buildTaskWorkflowGraphPayload(agentId);
    if (!payload) {
      return;
    }
    this.taskWorkflowBusy = true;
    this.taskWorkflowError = null;
    this.taskWorkflowMessage = null;
    this.notifyTaskWorkflowState({
      policy: payload.notifyPolicy,
      title: "Graph workflow started",
      message: payload.name,
      stateChange: true,
    });
    try {
      const result = await this.client.request<{ task?: TaskRecord }>(
        "tasks.workflow.graph.run",
        payload,
      );
      this.taskWorkflowMessage =
        result.task?.status === "blocked"
          ? "Graph workflow paused for approval."
          : "Graph workflow run recorded in run history.";
      this.notifyTaskWorkflowState({
        policy: payload.notifyPolicy,
        task: result.task ?? null,
        title:
          result.task?.status === "succeeded"
            ? "Graph workflow completed"
            : "Graph workflow state changed",
        message:
          result.task?.terminalSummary ??
          result.task?.progressSummary ??
          result.task?.error ??
          payload.name,
      });
      this.taskWorkflowGraphDraft = null;
      await Promise.all([
        this.loadTaskLedger({ quiet: true }),
        this.loadTaskFlowRuns({ quiet: true }),
      ]);
    } catch (err) {
      this.taskWorkflowError = String(err);
      this.notifyTaskWorkflowState({
        policy: payload.notifyPolicy,
        title: "Graph workflow failed",
        message: String(err),
      });
    } finally {
      this.taskWorkflowBusy = false;
    }
  }

  async loadWebhookTriggers(opts?: { quiet?: boolean }) {
    await loadWebhookTriggersInternal(
      this as unknown as Parameters<typeof loadWebhookTriggersInternal>[0],
      opts,
    );
  }

  startWebhookTriggerCreate(agentId: string) {
    const slug = `agent-${agentId}`.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
    this.webhookTriggerDraft = {
      name: "New webhook trigger",
      path: slug,
      action: "agent",
      agentId,
      wakeMode: "now",
      messageTemplate: "Webhook {{path}} received at {{now}}.\n\nPayload:\n{{payload}}",
      deliver: false,
      channel: "last",
      notifyPolicy: "done_only",
    };
    this.webhookTriggersMessage = null;
    this.webhookTriggersError = null;
  }

  editWebhookTrigger(trigger: WebhookTrigger) {
    this.webhookTriggerDraft = triggerToDraft(trigger);
    this.webhookTriggersMessage = null;
    this.webhookTriggersError = null;
  }

  cancelWebhookTriggerEdit() {
    this.webhookTriggerDraft = null;
  }

  patchWebhookTriggerDraft(patch: Partial<WebhookTriggerDraft>) {
    this.webhookTriggerDraft = {
      ...(this.webhookTriggerDraft ?? {
        name: "",
        path: "",
        action: "agent",
      }),
      ...patch,
    };
  }

  async saveWebhookTriggerDraft() {
    if (!this.webhookTriggerDraft) {
      return;
    }
    await saveWebhookTriggerInternal(
      this as unknown as Parameters<typeof saveWebhookTriggerInternal>[0],
      this.webhookTriggerDraft,
    );
    if (!this.webhookTriggersError) {
      this.webhookTriggerDraft = null;
    }
  }

  async removeWebhookTrigger(trigger: WebhookTrigger) {
    await removeWebhookTriggerInternal(
      this as unknown as Parameters<typeof removeWebhookTriggerInternal>[0],
      trigger,
    );
  }

  async toggleWebhookTrigger(trigger: WebhookTrigger, enabled: boolean) {
    await saveWebhookTriggerInternal(
      this as unknown as Parameters<typeof saveWebhookTriggerInternal>[0],
      { ...triggerToDraft(trigger), enabled },
    );
  }

  async testWebhookTrigger(trigger: WebhookTrigger) {
    const result = await testWebhookTriggerInternal(
      this as unknown as Parameters<typeof testWebhookTriggerInternal>[0],
      trigger,
    );
    if (result) {
      await this.loadTaskLedger({ quiet: true });
    }
  }

  async handleFederationLoad() {
    await loadFederationInternal(this);
  }

  async handleFederationLoadLocalOffers() {
    await loadLocalFederationOffersInternal(this);
    await loadLocalMarketplaceRequestsInternal(this);
    await loadLocalMarketplaceOrdersInternal(this);
    await previewMarketplaceFederationIndexInternal(this);
  }

  async handleFederationLoadOffers() {
    await loadFederationOffersInternal(this);
    await loadMarketplaceFederationIndexInternal(this);
  }

  async handleFederationLoadMarketplaceIndex() {
    await loadMarketplaceFederationIndexInternal(this);
  }

  async handleFederationOpenMarketplaceSellerProfile(handle: string) {
    await openMarketplaceSellerProfileInternal(this, handle);
  }

  async handleFederationPreviewMarketplaceIndex() {
    await previewMarketplaceFederationIndexInternal(this);
  }

  async handleFederationPublishMarketplaceIndex() {
    await publishMarketplaceFederationIndexInternal(this);
  }

  async handleFederationLoadOperatorEconomy() {
    await loadFederationOperatorEconomyInternal(this);
  }

  handleFederationStartLocalOfferDraft(offerId?: string) {
    startLocalFederationOfferDraftInternal(this, offerId);
  }

  handleFederationStartLocalRequestDraft(requestId?: string) {
    startLocalMarketplaceRequestDraftInternal(this, requestId);
  }

  handleFederationCancelLocalOfferDraft() {
    cancelLocalFederationOfferDraftInternal(this);
  }

  handleFederationApplyMarketplaceServiceKind(next: string) {
    applyMarketplaceServiceKindDraftInternal(this, next);
  }

  async handleFederationSaveLocalOffer() {
    await saveLocalFederationOfferInternal(this);
  }

  async handleFederationToggleLocalOffer(offerId: string) {
    await toggleLocalFederationOfferInternal(this, offerId);
  }

  async handleFederationDeleteLocalOffer(offerId: string) {
    await deleteLocalFederationOfferInternal(this, offerId);
  }

  async handleFederationToggleLocalRequest(requestId: string) {
    await toggleLocalMarketplaceRequestInternal(this, requestId);
  }

  async handleFederationDeleteLocalRequest(requestId: string) {
    await deleteLocalMarketplaceRequestInternal(this, requestId);
  }

  async handleFederationCreateOrderFromSelectedOffer() {
    await createMarketplaceOrderFromSelectedOfferInternal(this);
  }

  async handleFederationCreateOrderFromMarketplaceIndexEntry(entryId: string) {
    await createMarketplaceOrderFromIndexEntryInternal(this, entryId);
  }

  async handleFederationCreateOrderFromLocalRequest(requestId: string) {
    await createMarketplaceOrderFromLocalRequestInternal(this, requestId);
  }

  async handleFederationDeleteLocalOrder(orderId: string) {
    await deleteLocalMarketplaceOrderInternal(this, orderId);
  }

  async handleFederationLoadOfferReputation() {
    await loadFederationOfferReputationInternal(this);
  }

  async handleFederationLoadOperatorDisputes() {
    await loadFederationOperatorDisputesInternal(this);
  }

  async handleFederationLoadDisputeNotaryAttestations() {
    await loadFederationDisputeNotaryAttestationsInternal(this);
  }

  async handleFederationRegister() {
    await registerFederationHandleInternal(this);
  }

  async handleFederationAttest() {
    if (this.federationManagedMode) {
      this.federationError = "Managed mode: manual federation attestation is disabled.";
      return;
    }
    await attestFederationInternal(this);
  }

  async handleFederationRenew() {
    await renewFederationTokenInternal(this);
  }

  async handleFederationRevoke() {
    if (this.federationManagedMode) {
      this.federationError = "Managed mode: manual federation revoke is disabled.";
      return;
    }
    await revokeFederationTokenInternal(this);
  }

  async handleFederationSetBondWallet() {
    await setFederationBondWalletInternal(this);
  }

  async handleFederationClearBondWallet() {
    await clearFederationBondWalletInternal(this);
  }

  async handleFederationOpenBond() {
    await openFederationBondInternal(this);
  }

  async handleFederationIncreaseBond() {
    await increaseFederationBondInternal(this);
  }

  async handleFederationRequestBondUnlock() {
    await requestFederationBondUnlockInternal(this);
  }

  async handleFederationCancelBondUnlock() {
    await cancelFederationBondUnlockInternal(this);
  }

  async handleFederationFinalizeBondUnlock() {
    await finalizeFederationBondUnlockInternal(this);
  }

  async handleFederationSubmitBondProof() {
    await submitFederationBondProofInternal(this);
  }

  async handleFederationInitBondStaking() {
    await initFederationBondStakingInternal(this);
  }

  async handleFederationSyncBondStaking() {
    await syncFederationBondStakingInternal(this);
  }

  async handleFederationClaimBondStaking() {
    await claimFederationBondStakingInternal(this);
  }

  async handleFederationReview(
    handle: string,
    status: import("./federation-api.js").FederationDirectoryEntry["status"],
  ) {
    await reviewFederationDirectoryEntryInternal(this, { handle, status });
  }

  async handleFederationRunContentSummarize() {
    await runFederationContentSummarizeInternal(this);
  }

  async handleFederationRunPaidContentSummarize() {
    await runPaidFederationContentSummarizeInternal(this);
  }

  async handleFederationRunPaidContentSummarizeOrder(orderId: string) {
    await runPaidFederationContentSummarizeOrderInternal(this, orderId);
  }

  async handleFederationPayMarketplaceManualOrder(orderId: string) {
    await payMarketplaceManualOrderInternal(this, orderId);
  }

  async handleFederationDeliverMarketplaceManualOrder(orderId: string) {
    await deliverMarketplaceManualOrderInternal(this, orderId);
  }

  async handleFederationRunMarketplaceCapabilityOrder(orderId: string) {
    await runMarketplaceCapabilityOrderInternal(this, orderId);
  }

  async handleFederationSaveMarketplaceOrderDeliveryTarget(orderId: string) {
    await saveMarketplaceOrderDeliveryTargetInternal(this, orderId);
  }

  async handleFederationFundMarketplaceEscrowOrder(orderId: string) {
    await fundMarketplaceEscrowOrderInternal(this, orderId);
  }

  async handleFederationReleaseMarketplaceEscrowOrder(orderId: string) {
    await releaseMarketplaceEscrowOrderInternal(this, orderId);
  }

  async handleFederationRefundMarketplaceEscrowOrder(orderId: string) {
    await refundMarketplaceEscrowOrderInternal(this, orderId);
  }

  async handleFederationCancelMarketplaceEscrowOrder(orderId: string) {
    await cancelMarketplaceEscrowOrderInternal(this, orderId);
  }

  handleFederationOpenMarketplaceIndexOrderFeedback(orderId: string, tab: "dispute" | "review") {
    openMarketplaceIndexOrderFeedbackInternal(this, orderId, tab);
  }

  handleFederationSelectOffer(offerId: string) {
    this.federationMarketplaceFeedbackOrderId = "";
    this.federationOfferFeedbackTab = "review";
    selectFederationOfferInternal(this, offerId);
  }

  handleFederationOfferFeedbackTabChange(next: "review" | "dispute") {
    this.federationOfferFeedbackTab = next;
  }

  async handleFederationPublishReview() {
    await publishFederationReviewInternal(this);
  }

  async handleFederationPublishDispute() {
    await publishFederationDisputeInternal(this);
  }

  async handleFederationReviewDispute() {
    await reviewFederationDisputeInternal(this);
  }

  async handleFederationPublishDisputeNotaryAttestation() {
    await publishFederationDisputeNotaryAttestationInternal(this);
  }

  async handleWalletLoad() {
    await loadWalletInternal(this);
    await loadWalletSkillGrants(this);
    this.syncWalletPolicyDraftsFromSettings();
    this.focusWalletSecuritySetupIfNeeded();
  }

  handleWalletMainPanelChange(panel: "wallets" | "access" | "skill-grants") {
    this.walletMainPanel = panel;
    if (typeof window === "undefined" || this.tab !== "wallet") {
      return;
    }
    const url = new URL(window.location.href);
    url.hash =
      panel === "skill-grants" ? "wallet-skill-grants" : panel === "access" ? "wallet-access" : "";
    window.history.replaceState({}, "", url.toString());
  }

  handleWalletSkillGrantDraftPatch(patch: Partial<WalletSkillGrantDraft>) {
    patchWalletSkillGrantDraft(this, patch);
  }

  handleWalletSkillGrantActionToggle(action: string, enabled: boolean) {
    toggleWalletSkillGrantAction(this, action, enabled);
  }

  handleWalletSkillGrantSelect(row: WalletSkillGrantRow) {
    this.walletSkillGrantDraft = draftFromWalletSkillRow(row);
    this.walletSkillGrantsError = null;
    this.walletSkillGrantsMessage = null;
  }

  async handleWalletSkillGrantSave() {
    await saveWalletSkillGrant(this);
  }

  async handleWalletSkillGrantClear(skillId: string) {
    await clearWalletSkillGrant(this, skillId);
  }

  private currentWalletPolicyRole(): "agent" | "mining" | "vault" {
    const walletId =
      this.walletDetailsWalletId.trim() || this.walletSendCreateForm.walletId?.trim() || undefined;
    const wallet = walletId
      ? this.walletNamedWallets.find((entry) => entry.id === walletId)
      : undefined;
    const metadataRoleRaw =
      typeof wallet?.metadata?.purpose === "string"
        ? wallet.metadata.purpose
        : typeof wallet?.metadata?.role === "string"
          ? wallet.metadata.role
          : "";
    const metadataRole = metadataRoleRaw.toLowerCase();
    if (metadataRole === "mining") {
      return "mining";
    }
    if (metadataRole === "agent") {
      return "agent";
    }
    if (metadataRole === "vault") {
      return "vault";
    }
    return walletId && walletId === String(this.walletDefaultWalletId ?? "").trim()
      ? "agent"
      : "vault";
  }

  private resolveRecurringTransferDecimals(mint: string): number {
    const normalizedMint = mint.trim();
    if (!normalizedMint) {
      return 9;
    }
    const asset = (this.walletBalances?.assets?.solana ?? []).find(
      (entry) => entry.program === normalizedMint,
    );
    if (asset && Number.isFinite(asset.decimals)) {
      return asset.decimals;
    }
    const capDecimals = this.walletPolicySolanaTokenCaps[normalizedMint]?.decimals;
    return typeof capDecimals === "number" && capDecimals >= 0 ? capDecimals : -1;
  }

  private formatRecurringTransferAmount(raw: string | undefined, decimals: number): string {
    return formatRawTokenPolicyAmount(raw, decimals);
  }

  private normalizeRecurringTransferAmount(human: string, decimals: number): string | undefined {
    const value = human.trim();
    return value ? toRawTokenPolicyAmount(value, decimals) : undefined;
  }

  private focusWalletSecuritySetupIfNeeded() {
    const walletId = this.walletSecuritySetupWalletId.trim();
    const role = this.walletSecuritySetupRole;
    if (
      this.tab !== "wallet" ||
      !walletId ||
      (role !== "agent" && role !== "mining" && role !== "vault")
    ) {
      return;
    }
    if (this.walletDetailsWalletId !== walletId) {
      this.walletDetailsWalletId = walletId;
    }
    this.walletExpandedPanelWalletId = walletId;
    this.walletExpandedPanel = "security";
    this.walletBalanceWalletId = "";
    const nextKey = `${walletId}:${role}`;
    if (this.walletSecuritySetupScrollKey === nextKey) {
      return;
    }
    this.walletSecuritySetupScrollKey = nextKey;
    void this.updateComplete.then(() => {
      const focusSection = () => {
        const section = this.renderRoot.querySelector<HTMLElement>("#wallet-security-card");
        section?.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(focusSection);
      } else {
        setTimeout(focusSection, 0);
      }
    });
  }

  private syncWalletPolicyDraftsFromSettings() {
    if (!this.walletSettings) {
      return;
    }
    this.walletPolicyCapsEnabled = this.walletSettings.policy.capsEnabled === true;
    this.walletPolicyAutoEnabled = this.walletSettings.policy.directSigning;
    this.walletPolicySkillsEnabled = this.walletSettings.policy.skillsEnabled === true;
    this.walletPolicySolMaxPerTx = formatPolicyDraftValue(
      this.walletSettings.policy.solana.maxPerTx,
    );
    this.walletPolicySolMaxDaily = formatPolicyDraftValue(
      this.walletSettings.policy.solana.maxDaily,
    );
    this.walletPolicySolanaAllowPrograms = formatWalletPolicyAllowlist(
      this.walletSettings.policy.solana.allowPrograms,
    );
    this.walletPolicySolanaTokenCaps = Object.fromEntries(
      Object.entries(this.walletSettings.policy.solana.tokenCaps ?? {}).map(([mint, cap]) => [
        mint,
        {
          maxPerTx: cap.maxPerTx,
          maxDaily: cap.maxDaily,
          decimals: -1,
        },
      ]),
    );
    const recurring = this.walletSettings.policy.recurringTransfer;
    const recurringMint = recurring?.program ?? "";
    const recurringDecimals = this.resolveRecurringTransferDecimals(recurringMint);
    this.walletRecurringTransferEnabled = recurring?.enabled === true;
    this.walletRecurringTransferDestination = recurring?.to ?? "";
    this.walletRecurringTransferMint = recurringMint;
    this.walletRecurringTransferAmountMode = recurring?.amountMode ?? "fixed";
    this.walletRecurringTransferAmount = this.formatRecurringTransferAmount(
      recurring?.amount,
      recurringDecimals,
    );
    this.walletRecurringTransferPercentage = String(recurring?.percentage ?? 100);
    this.walletRecurringTransferMinAmount = this.formatRecurringTransferAmount(
      recurring?.minAmount,
      recurringDecimals,
    );
    this.walletRecurringTransferKeepAmount = this.formatRecurringTransferAmount(
      recurring?.keepAmount,
      recurringDecimals,
    );
    this.walletRecurringTransferDecimals =
      recurringDecimals >= 0 ? String(recurringDecimals) : recurringMint ? "" : "9";
    this.walletRecurringTransferCron =
      typeof recurring?.schedule?.expr === "string" ? recurring.schedule.expr : "0 9 * * *";
    this.walletRecurringTransferTz =
      typeof recurring?.schedule?.tz === "string" ? recurring.schedule.tz : "";
    this.walletRecurringTransferName = recurring?.name ?? "";
  }

  private gatewayRestartExpected() {
    return (
      !this.connected &&
      typeof this.lastError === "string" &&
      this.lastError.startsWith("Restarting:")
    );
  }

  private walletReloadHitTransientRestartError() {
    const combined = [
      this.walletError,
      this.walletSettingsError,
      this.walletApprovalsError,
      this.walletAuditError,
      this.walletBalancesError,
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n");
    return /Request failed \(502\)|Failed to fetch|fetch failed/i.test(combined);
  }

  private clearTransientWalletReloadErrors() {
    const clearIfTransient = (value: string | null) =>
      typeof value === "string" &&
      /Request failed \(502\)|Failed to fetch|fetch failed/i.test(value)
        ? null
        : value;
    this.walletError = clearIfTransient(this.walletError);
    this.walletSettingsError = clearIfTransient(this.walletSettingsError);
    this.walletApprovalsError = clearIfTransient(this.walletApprovalsError);
    this.walletAuditError = clearIfTransient(this.walletAuditError);
    this.walletBalancesError = clearIfTransient(this.walletBalancesError);
  }

  private scheduleWalletReloadAfterSettingsSave(attempt = 0) {
    if (this.walletReloadAfterSettingsTimer != null) {
      window.clearTimeout(this.walletReloadAfterSettingsTimer);
      this.walletReloadAfterSettingsTimer = null;
    }
    const delayMs = attempt === 0 ? 2200 : 1400;
    this.walletReloadAfterSettingsTimer = window.setTimeout(() => {
      this.walletReloadAfterSettingsTimer = null;
      if (this.gatewayRestartExpected()) {
        if (attempt < 5) {
          this.scheduleWalletReloadAfterSettingsSave(attempt + 1);
        }
        return;
      }
      void this.handleWalletLoad().then(() => {
        if (this.walletReloadHitTransientRestartError()) {
          this.clearTransientWalletReloadErrors();
          if (attempt < 5) {
            this.scheduleWalletReloadAfterSettingsSave(attempt + 1);
          }
        }
      });
    }, delayMs);
  }

  async handleMiningLoad(opts?: { forceFresh?: boolean }) {
    await loadMiningInternal(this, opts);
  }

  async handleMiningSave() {
    if (!this.miningProfile) {
      return;
    }
    const normalizedCommit = this.normalizeMiningCommitTarget(
      String(this.miningProfile.funding.commitLamports ?? "250000000"),
      { enforceSafeMax: false },
    );
    if (normalizedCommit.kind === "blocked") {
      this.miningError = normalizedCommit.message;
      this.miningMessage = null;
      this.enqueueMiningNotification("warning", normalizedCommit.message);
      return;
    }
    const nextProfile =
      normalizedCommit.kind === "clamped"
        ? {
            ...this.miningProfile,
            funding: {
              ...this.miningProfile.funding,
              commitLamports: normalizedCommit.commitLamports,
            },
          }
        : this.miningProfile;
    if (normalizedCommit.kind === "clamped") {
      this.miningProfile = nextProfile;
      this.miningMessage = normalizedCommit.message;
      this.miningError = null;
      this.enqueueMiningNotification("warning", normalizedCommit.message);
    }
    await saveMiningProfileInternal(this, nextProfile);
  }

  handleMiningSaveLocalProfile() {
    saveCurrentMiningProfileLocally(this);
  }

  handleMiningLoadSavedProfile() {
    loadSavedMiningProfileIntoForm(this);
  }

  handleMiningDeleteSavedProfile() {
    deleteSavedMiningProfile(this);
  }

  async handleMiningStart() {
    this.miningPendingAction = "starting";
    try {
      await startMiningInternal(this);
    } finally {
      this.miningPendingAction = null;
    }
  }

  async handleMiningStop() {
    this.miningPendingAction = "stopping";
    try {
      await stopMiningInternal(this);
    } finally {
      this.miningPendingAction = null;
    }
  }

  async handleMiningMainnetSync() {
    await syncMiningMainnetInternal(this);
  }

  handleMiningCapitalDepositDraftChange(value: string) {
    this.miningCapitalDepositDraft = value;
  }

  handleMiningCapitalWithdrawDraftChange(value: string) {
    this.miningCapitalWithdrawDraft = value;
  }

  async handleMiningTopUpReserve() {
    try {
      const approvalToken = await this.resolveWalletApprovalToken({
        operation: "mining.capital",
      });
      await topUpMiningReserveInternal(this, approvalToken);
    } catch (error) {
      this.miningError = `Failed to authorize mining buffer top-up: ${String(error)}`;
      this.enqueueMiningNotification("error", this.miningError);
    }
  }

  async handleMiningDepositCapital() {
    this.miningActionBusy = true;
    this.miningCapitalActionBusy = "deposit";
    this.miningError = null;
    try {
      const approvalToken = await this.resolveWalletApprovalToken({
        operation: "mining.capital",
      });
      await depositMiningCapitalInternal(
        this,
        toRawPolicyAmount(this.miningCapitalDepositDraft, "solana"),
        approvalToken,
      );
    } catch (error) {
      this.miningError = `Failed to authorize mining fund action: ${String(error)}`;
      this.enqueueMiningNotification("error", this.miningError);
    } finally {
      this.miningActionBusy = false;
      this.miningCapitalActionBusy = null;
    }
  }

  async handleMiningWithdrawCapital() {
    this.miningActionBusy = true;
    this.miningCapitalActionBusy = "withdraw";
    this.miningError = null;
    try {
      const approvalToken = await this.resolveWalletApprovalToken({
        operation: "mining.capital",
      });
      await withdrawMiningCapitalInternal(
        this,
        toRawPolicyAmount(this.miningCapitalWithdrawDraft, "solana"),
        approvalToken,
      );
    } catch (error) {
      this.miningError = `Failed to authorize mining withdraw action: ${String(error)}`;
      this.enqueueMiningNotification("error", this.miningError);
    } finally {
      this.miningActionBusy = false;
      this.miningCapitalActionBusy = null;
    }
  }

  async handleMiningSetActiveCommit() {
    const requestedCommitLamports = String(
      this.miningProfile?.funding.commitLamports ?? "250000000",
    );
    const normalizedCommit = this.normalizeMiningCommitTarget(requestedCommitLamports, {
      enforceSafeMax: true,
    });
    if (normalizedCommit.kind === "blocked") {
      this.miningError = normalizedCommit.message;
      this.miningMessage = null;
      this.enqueueMiningNotification("warning", normalizedCommit.message);
      return;
    }
    if (normalizedCommit.kind === "clamped") {
      this.miningMessage = normalizedCommit.message;
      this.enqueueMiningNotification("warning", normalizedCommit.message);
    }
    this.miningActionBusy = true;
    this.miningError = null;
    try {
      const approvalToken = await this.resolveWalletApprovalToken({
        operation: "mining.capital",
      });
      await setMiningActiveCommitInternal(this, normalizedCommit.commitLamports, approvalToken);
    } catch (error) {
      this.miningError = `Failed to authorize mining commit action: ${String(error)}`;
      this.enqueueMiningNotification("error", this.miningError);
    } finally {
      this.miningActionBusy = false;
    }
  }

  async handleMiningUpdateCommit(lamports: string) {
    const normalizedTarget = this.normalizeMiningCommitTarget(String(lamports || "250000000"), {
      enforceSafeMax: false,
    });
    const currentProfile = this.miningProfile ?? createDefaultMinerProfile();
    const nextProfile = {
      ...currentProfile,
      funding: {
        ...currentProfile.funding,
        commitLamports: normalizedTarget.commitLamports,
      },
    };
    this.miningProfile = nextProfile;
    await saveMiningProfileInternal(this, nextProfile);
    if (this.miningError?.startsWith("Mining profile save failed")) {
      return;
    }
    await this.handleMiningSetActiveCommit();
  }

  private miningCommitInputLabel() {
    const execution =
      this.miningProfile?.strategyExecution ??
      strategyModeToExecution(this.miningProfile?.strategyMode);
    return execution === "auto" ? "target max" : "target";
  }

  private normalizeMiningCommitTarget(
    requestedCommitLamports: string,
    opts?: { enforceSafeMax?: boolean },
  ) {
    const selectedWalletId = String(
      this.miningProfile?.walletId ??
        this.miningStatus?.walletId ??
        this.miningReadiness?.selectedWalletId ??
        "",
    ).trim();
    const selectedWallet = this.miningWallets.find(
      (wallet) => wallet.walletId === selectedWalletId,
    );
    const normalized = normalizeMiningCommitLamports({
      requestedCommitLamports,
      walletLamports:
        this.miningReadiness?.balances.solBalanceLamports ??
        selectedWallet?.solBalanceLamports ??
        this.miningStatus?.currentSolBalanceLamports ??
        "0",
      capitalFundedLamports: this.miningStatus?.currentCapitalFundedLamports ?? "0",
      capitalFreeLamports: this.miningStatus?.currentCapitalFreeLamports ?? "0",
      capitalLockedLamports: this.miningStatus?.currentCapitalLockedLamports ?? "0",
      pendingCycleCount: this.miningStatus?.currentCapitalPendingCycleCount,
      signerReserveLamports: this.miningStatus?.signerReserveLamports,
      signerFeeBufferLamports: this.miningStatus?.signerFeeBufferLamports,
      enforceSafeMax: opts?.enforceSafeMax,
    });
    const label = this.miningCommitInputLabel();
    if (normalized.kind === "blocked") {
      return {
        ...normalized,
        message: `Cannot apply ${label} yet. Need ${formatSolLamportsCompact(normalized.minimumCapitalForMinimumCommitLamports)} SOL free for the minimum 0.25 SOL commit.`,
      };
    }
    if (normalized.kind === "clamped") {
      return {
        ...normalized,
        message: `Using safe commit: ${formatSolLamportsCompact(normalized.commitLamports)} SOL.`,
      };
    }
    return {
      ...normalized,
      message: null,
    };
  }

  private async persistMiningProfileUpdate(mutate: (current: SatMinerProfile) => SatMinerProfile) {
    const current = this.miningProfile ?? createDefaultMinerProfile();
    const next = mutate(current);
    this.miningProfile = next;
    await saveMiningProfileInternal(this, next);
  }

  handleMiningSelectedSavedProfileChange(id: string) {
    this.miningSelectedSavedProfileId = id;
  }

  handleMiningSaveProfileNameChange(value: string) {
    this.miningSaveProfileName = value;
  }

  handleMiningStrategyPresetChange(preset: SatMinerProfile["strategyPreset"]) {
    void this.persistMiningProfileUpdate((current) => ({
      ...current,
      strategyPreset: preset,
      riskMode: strategyPresetToRiskMode(preset),
    }));
  }

  handleMiningStrategyExecutionChange(execution: SatMinerProfile["strategyExecution"]) {
    void this.persistMiningProfileUpdate((current) => ({
      ...current,
      strategyExecution: execution,
      strategyMode: strategyExecutionToMode(execution),
      skillConfig: {
        useAgentDefaultModel: true,
        fallbackToBaseOnFailure: true,
        ...current.skillConfig,
        enabled: execution === "auto",
      },
    }));
  }

  handleMiningCycleCadenceChange(cycleCadence: SatMinerProfile["cycleCadence"]) {
    void this.persistMiningProfileUpdate((current) => ({
      ...current,
      cycleCadence,
    }));
  }

  handleMiningStrategyModeChange(mode: SatMinerProfile["strategyMode"]) {
    void this.persistMiningProfileUpdate((current) => ({
      ...current,
      strategyExecution: strategyModeToExecution(mode),
      strategyMode: mode,
      skillConfig: {
        useAgentDefaultModel: true,
        fallbackToBaseOnFailure: true,
        ...current.skillConfig,
        enabled: mode === "skill",
      },
    }));
  }

  handleMiningSkillConfigChange(patch: Partial<NonNullable<SatMinerProfile["skillConfig"]>>) {
    void this.persistMiningProfileUpdate((current) => ({
      ...current,
      skillConfig: {
        enabled: current.skillConfig?.enabled ?? false,
        useAgentDefaultModel: true,
        fallbackToBaseOnFailure: true,
        ...current.skillConfig,
        ...patch,
      },
    }));
  }

  handleMiningRiskModeChange(riskMode: SatMinerProfile["riskMode"]) {
    void this.persistMiningProfileUpdate((current) => ({
      ...current,
      riskMode,
      strategyPreset: riskModeToStrategyPreset(riskMode),
    }));
  }

  handleMiningCommitLamportsChange(lamports: string) {
    const normalizedCommit = this.normalizeMiningCommitTarget(String(lamports || "250000000"), {
      enforceSafeMax: false,
    });
    if (normalizedCommit.kind === "blocked") {
      this.miningError = normalizedCommit.message;
      this.miningMessage = null;
      this.enqueueMiningNotification("warning", normalizedCommit.message);
      return;
    }
    if (normalizedCommit.kind === "clamped") {
      this.miningMessage = normalizedCommit.message;
      this.miningError = null;
      this.enqueueMiningNotification("warning", normalizedCommit.message);
    } else {
      this.miningError = null;
    }
    void this.persistMiningProfileUpdate((current) => ({
      ...current,
      funding: {
        ...current.funding,
        commitLamports: normalizedCommit.commitLamports,
      },
    }));
  }

  handleMiningReserveLamportsChange(lamports: string) {
    void this.persistMiningProfileUpdate((current) => ({
      ...current,
      funding: {
        ...current.funding,
        minSolBalanceLamports: String(lamports || "150000000"),
      },
    }));
  }

  handleMiningPayoutChange(payout: boolean) {
    void this.persistMiningProfileUpdate((current) => ({ ...current, payout }));
  }

  handleMiningAutomationChange(patch: Partial<SatMinerProfile["automation"]>) {
    void this.persistMiningProfileUpdate((current) => ({
      ...current,
      automation: {
        ...current.automation,
        ...patch,
      },
    }));
  }

  handleMiningSatSweepChange(
    patch: Partial<NonNullable<SatMinerProfile["automation"]["satSweep"]>>,
  ) {
    void this.persistMiningProfileUpdate((current) => ({
      ...current,
      automation: {
        ...current.automation,
        satSweep: {
          enabled: false,
          mode: "all",
          percentage: 100,
          minRaw: "1",
          keepRaw: "0",
          ...current.automation.satSweep,
          ...patch,
        },
      },
    }));
  }

  handleMiningRecentActionsPageChange(nextPage: number) {
    this.miningRecentActionsPage = Math.max(1, nextPage);
  }

  handleMiningActivityFilterChange(nextFilter: import("./views/mining.js").MiningActivityFilter) {
    if (this.miningActivityFilter === nextFilter) {
      return;
    }
    this.miningActivityFilter = nextFilter;
    this.miningRecentActionsPage = 1;
  }

  handleMiningActivityWindowChange(window: import("./views/mining.js").MiningPlannerWindow) {
    if (this.miningActivityWindow === window) {
      return;
    }
    this.miningActivityWindow = window;
    this.miningRecentActionsPage = 1;
    void loadMiningHistoryInternal(this, {
      window: this.miningPlannerWindow,
      activityWindow: window,
    });
  }

  handleMiningOpenHistoryModal() {
    this.miningHistoryModalOpen = true;
  }

  handleMiningCloseHistoryModal() {
    this.miningHistoryModalOpen = false;
  }

  handleMiningPlannerWindowChange(window: import("./views/mining.js").MiningPlannerWindow) {
    if (this.miningPlannerWindow === window) {
      return;
    }
    this.miningPlannerWindow = window;
    void loadMiningHistoryInternal(this, {
      window,
      activityWindow: this.miningActivityWindow,
    });
  }

  handleMiningRecoveryDisputeAuthorityChange(value: string) {
    this.miningRecoveryDisputeAuthority = value;
    persistMiningRecoveryDraft(this);
  }

  handleMiningRecoveryTargetAuthorityChange(value: string) {
    this.miningRecoveryTargetAuthority = value;
    persistMiningRecoveryDraft(this);
  }

  handleMiningRecoveryEpochIdChange(value: string) {
    this.miningRecoveryEpochId = value;
    persistMiningRecoveryDraft(this);
  }

  handleMiningRecoveryMicroRoundIdChange(value: string) {
    this.miningRecoveryMicroRoundId = value;
    persistMiningRecoveryDraft(this);
  }

  handleMiningRecoveryStatusFlagChange(value: string) {
    this.miningRecoveryStatusFlag = value;
    persistMiningRecoveryDraft(this);
  }

  handleMiningRecoveryBoardRootChange(value: string) {
    this.miningRecoveryBoardRoot = value;
    persistMiningRecoveryDraft(this);
  }

  handleMiningRecoveryScoreRootChange(value: string) {
    this.miningRecoveryScoreRoot = value;
    persistMiningRecoveryDraft(this);
  }

  handleMiningRecoveryCoordinationRootChange(value: string) {
    this.miningRecoveryCoordinationRoot = value;
    persistMiningRecoveryDraft(this);
  }

  async handleMiningRetryClaim() {
    const epochId = Number(this.miningRecovery?.epochId ?? this.miningStatus?.currentEpochId ?? 0);
    if (!epochId) {
      this.miningError = "Missing epoch id for retry claim.";
      return;
    }
    await retryMiningClaimInternal(this, epochId);
  }

  async handleMiningResolveDispute() {
    await resolveMiningDisputeInternal(this);
  }

  async handleMiningRepublishRoots() {
    await republishMiningRootsInternal(this);
  }

  async handleMiningClearHistory() {
    this.miningConfirmClearHistory = false;
    await clearMiningHistoryInternal(this);
  }

  handleMiningConfirmClearHistory() {
    this.miningConfirmClearHistory = true;
  }

  handleMiningCancelClearHistory() {
    this.miningConfirmClearHistory = false;
  }

  handleMiningResetRecoveryDraft() {
    resetMiningRecoveryDraft(this);
  }

  handleMiningResetToSelectedCandidate() {
    resetMiningRecoveryToSelectedCandidate(this);
  }

  handleMiningExportSupportBundle() {
    exportMiningSupportBundle(this);
  }

  enqueueMiningNotification(level: MiningUiNotification["level"], message: string) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const notification: MiningUiNotification = {
      id,
      level,
      message,
      createdAt: new Date().toISOString(),
    };
    this.miningNotifications = [notification, ...this.miningNotifications].slice(0, 5);
    const timer = window.setTimeout(() => {
      this.dismissMiningNotification(id);
    }, 8000);
    this.miningNotificationTimers.set(id, timer);
  }

  dismissMiningNotification(id: string) {
    const timer = this.miningNotificationTimers.get(id);
    if (timer != null) {
      window.clearTimeout(timer);
      this.miningNotificationTimers.delete(id);
    }
    this.miningNotifications = this.miningNotifications.filter((item) => item.id !== id);
  }

  enqueueAppNotification(input: {
    code: NotificationCode;
    category: NotificationCategory;
    level: NotificationLevel;
    title: string;
    message: string;
    cooldownMs?: number;
    dedupeKey?: string;
  }) {
    const dedupeKey = input.dedupeKey ?? `${input.code}:${input.message}`;
    const cooldownMs = Math.max(0, Number(input.cooldownMs ?? 0));
    const now = Date.now();
    if (cooldownMs > 0) {
      const lastAt = this.notificationCooldowns.get(dedupeKey) ?? 0;
      if (now - lastAt < cooldownMs) {
        return;
      }
      this.notificationCooldowns.set(dedupeKey, now);
    }

    const routeMode = this.settings.notificationRouteMode;
    const routeChannel = this.settings.notificationRouteChannel.trim();
    const routeAccountId = this.settings.notificationRouteAccountId.trim();
    const routeTo =
      this.settings.notificationRouteTo.trim() ||
      resolveNotificationRouteTarget(
        this.channelsSnapshot,
        routeChannel,
        routeAccountId,
        this.configForm,
      );
    const routeEnabled = isNotificationRoutingEnabled(
      this.settings.notificationEventPrefs,
      input.code,
    );
    let routeStatus: NotificationRouteStatus = "ui-only";
    let routeError: string | null = null;
    if (routeMode === "channel") {
      if (!routeEnabled) {
        routeStatus = "disabled";
        routeError = "External routing disabled for this event type.";
      } else if (!routeChannel || !routeAccountId || !routeTo) {
        routeStatus = "disabled";
        routeError = "Notification route is incomplete.";
      } else {
        routeStatus = "pending";
      }
    }

    const event: AppNotification = {
      id: generateUUID(),
      code: input.code,
      category: input.category,
      level: input.level,
      title: input.title,
      message: input.message,
      createdAt: new Date(now).toISOString(),
      routeStatus,
      routeChannel: routeChannel || null,
      routeAccountId: routeAccountId || null,
      routeTo: routeTo || null,
      routeError,
      routedAt: null,
    };

    this.notifications = [event, ...this.notifications].slice(0, 120);
    if (routeStatus === "pending") {
      void this.routeAppNotification(event);
    }
  }

  dismissAppNotification(id: string) {
    this.notifications = this.notifications.filter((entry) => entry.id !== id);
  }

  private applyNotificationRouteDefaultsFromChannels() {
    const snapshot = this.channelsSnapshot;
    if (!snapshot) {
      return;
    }
    const defaults = resolveNotificationRouteDefaults(snapshot, this.configForm);
    if (
      !defaults.notificationRouteChannel &&
      !defaults.notificationRouteAccountId &&
      !defaults.notificationRouteTo
    ) {
      return;
    }
    const next = { ...this.settings };
    let changed = false;
    if (!next.notificationRouteChannel.trim() && defaults.notificationRouteChannel) {
      next.notificationRouteChannel = defaults.notificationRouteChannel;
      changed = true;
    }
    if (!next.notificationRouteAccountId.trim() && defaults.notificationRouteAccountId) {
      next.notificationRouteAccountId = defaults.notificationRouteAccountId;
      changed = true;
    }
    if (!next.notificationRouteTo.trim() && defaults.notificationRouteTo) {
      next.notificationRouteTo = defaults.notificationRouteTo;
      changed = true;
    }
    if (changed) {
      this.applySettings(next);
    }
  }

  private updateAppNotification(id: string, patch: Partial<AppNotification>) {
    this.notifications = this.notifications.map((entry) =>
      entry.id === id ? { ...entry, ...patch } : entry,
    );
  }

  private async routeAppNotification(event: AppNotification) {
    const routeChannel = event.routeChannel?.trim() ?? "";
    const routeAccountId = event.routeAccountId?.trim() ?? "";
    const routeTo = event.routeTo?.trim() ?? "";
    const routedAt = new Date().toISOString();
    if (!this.client || !this.connected) {
      this.updateAppNotification(event.id, {
        routeStatus: "failed",
        routeError: "Gateway is offline.",
        routedAt,
      });
      return;
    }
    try {
      await this.client.request("send", {
        channel: routeChannel,
        accountId: routeAccountId,
        to: routeTo,
        message: buildNotificationDeliveryText(event),
        idempotencyKey: `notification:${event.id}`,
      });
      this.updateAppNotification(event.id, {
        routeStatus: "sent",
        routeError: null,
        routedAt,
      });
    } catch (err) {
      this.updateAppNotification(event.id, {
        routeStatus: "failed",
        routeError: err instanceof Error ? err.message : String(err),
        routedAt,
      });
    }
  }

  async handleWalletRefreshSignerDoctor() {
    try {
      const result = await getWalletSignerDoctor();
      if (!this.walletStatus) {
        return;
      }
      this.walletStatus = {
        ...this.walletStatus,
        signerDaemon: result.report,
        chainWallets: result.chainWallets,
      };
    } catch (err) {
      this.walletError = `Signer doctor refresh failed: ${String(err)}`;
    }
  }

  async handleWalletPatchSettings(
    patch: Parameters<typeof patchWalletSettings>[0],
    opts?: { requireExecutionApproval?: boolean },
  ) {
    if (this.walletSettingsBusy) {
      return;
    }
    this.walletSettingsBusy = true;
    this.walletSettingsError = null;
    this.walletSettingsMessage = null;
    try {
      const selectedWalletId =
        this.walletDetailsWalletId.trim() ||
        this.walletSendCreateForm.walletId?.trim() ||
        undefined;
      const scopedPatch = {
        ...patch,
        ...(patch.walletId !== undefined
          ? {}
          : selectedWalletId
            ? { walletId: selectedWalletId }
            : {}),
      };
      const policyPatch =
        scopedPatch.policyTemplate !== undefined ||
        scopedPatch.approvalAuthMode !== undefined ||
        scopedPatch.approvalChallengeTtlSeconds !== undefined ||
        scopedPatch.approvalGrantTtlSeconds !== undefined ||
        scopedPatch.capsEnabled !== undefined ||
        scopedPatch.directSigning !== undefined ||
        scopedPatch.skillsEnabled !== undefined ||
        scopedPatch.solanaAllowPrograms !== undefined ||
        scopedPatch.solanaMaxPerTx !== undefined ||
        scopedPatch.solanaMaxDaily !== undefined ||
        scopedPatch.solanaTokenCaps !== undefined ||
        scopedPatch.recurringTransfer !== undefined ||
        scopedPatch.toolAccessMode !== undefined ||
        scopedPatch.toolAccessAllowAgents !== undefined;
      if (policyPatch && this.walletSettings?.signerPolicy) {
        this.walletSettingsMessage =
          "Signer policy update pending; settings remain unchanged until the signer acknowledges the exact next version and hash.";
      }
      let approvalToken: string | null = null;
      if (opts?.requireExecutionApproval) {
        approvalToken = await this.resolveWalletApprovalToken({
          operation: "wallet.execution-mode",
        });
      } else {
        approvalToken = await this.resolveWalletApprovalToken({
          operation: policyPatch ? "wallet.policy" : "wallet.settings",
        });
      }
      const response = await patchWalletSettings(scopedPatch, approvalToken ?? undefined);
      this.walletSettings = response.settings;
      const signerPolicy = response.settings.signerPolicy;
      this.walletSettingsMessage =
        policyPatch && signerPolicy?.version && signerPolicy.hash
          ? `Signer policy ${signerPolicy.state}: version ${signerPolicy.version}, hash ${signerPolicy.hash}. Wallet settings were saved after this acknowledgement.`
          : "Wallet settings updated.";
      this.syncWalletPolicyDraftsFromSettings();
      this.scheduleWalletReloadAfterSettingsSave();
    } catch (err) {
      this.walletSettingsMessage = null;
      this.walletSettingsError = `Wallet settings update failed: ${String(err)}`;
    } finally {
      this.walletSettingsBusy = false;
    }
  }

  handleWalletPolicyDraftChange(
    patch: Partial<{
      solMaxPerTx: string;
      capsEnabled: boolean;
      directSigning: boolean;
      skillsEnabled: boolean;
      solMaxDaily: string;
      solanaAllowPrograms: string;
      solanaTokenCaps: Record<string, { maxPerTx?: string; maxDaily?: string; decimals: number }>;
      tokenCapMint: string;
      tokenCapDecimals: string;
      tokenCapMaxPerTx: string;
      tokenCapMaxDaily: string;
      recurringTransferEnabled: boolean;
      recurringTransferDestination: string;
      recurringTransferMint: string;
      recurringTransferAmountMode: "fixed" | "percentage";
      recurringTransferAmount: string;
      recurringTransferPercentage: string;
      recurringTransferMinAmount: string;
      recurringTransferKeepAmount: string;
      recurringTransferDecimals: string;
      recurringTransferCron: string;
      recurringTransferTz: string;
      recurringTransferName: string;
    }>,
  ) {
    if (patch.capsEnabled !== undefined) {
      this.walletPolicyCapsEnabled = patch.capsEnabled;
    }
    if (patch.directSigning !== undefined) {
      this.walletPolicyAutoEnabled = patch.directSigning;
    }
    if (patch.skillsEnabled !== undefined) {
      this.walletPolicySkillsEnabled = patch.skillsEnabled;
    }
    if (patch.solMaxPerTx !== undefined) {
      this.walletPolicySolMaxPerTx = patch.solMaxPerTx;
    }
    if (patch.solMaxDaily !== undefined) {
      this.walletPolicySolMaxDaily = patch.solMaxDaily;
    }
    if (patch.solanaAllowPrograms !== undefined) {
      this.walletPolicySolanaAllowPrograms = patch.solanaAllowPrograms;
    }
    if (patch.solanaTokenCaps !== undefined) {
      this.walletPolicySolanaTokenCaps = patch.solanaTokenCaps;
    }
    if (patch.tokenCapMint !== undefined) {
      this.walletPolicyTokenCapMint = patch.tokenCapMint;
    }
    if (patch.tokenCapDecimals !== undefined) {
      this.walletPolicyTokenCapDecimals = patch.tokenCapDecimals;
    }
    if (patch.tokenCapMaxPerTx !== undefined) {
      this.walletPolicyTokenCapMaxPerTx = patch.tokenCapMaxPerTx;
    }
    if (patch.tokenCapMaxDaily !== undefined) {
      this.walletPolicyTokenCapMaxDaily = patch.tokenCapMaxDaily;
    }
    if (patch.recurringTransferEnabled !== undefined) {
      this.walletRecurringTransferEnabled = patch.recurringTransferEnabled;
    }
    if (patch.recurringTransferDestination !== undefined) {
      this.walletRecurringTransferDestination = patch.recurringTransferDestination;
    }
    if (patch.recurringTransferMint !== undefined) {
      this.walletRecurringTransferMint = patch.recurringTransferMint;
      const decimals = this.resolveRecurringTransferDecimals(patch.recurringTransferMint);
      this.walletRecurringTransferDecimals =
        decimals >= 0 ? String(decimals) : patch.recurringTransferMint.trim() ? "" : "9";
    }
    if (patch.recurringTransferAmountMode !== undefined) {
      this.walletRecurringTransferAmountMode = patch.recurringTransferAmountMode;
    }
    if (patch.recurringTransferAmount !== undefined) {
      this.walletRecurringTransferAmount = patch.recurringTransferAmount;
    }
    if (patch.recurringTransferPercentage !== undefined) {
      this.walletRecurringTransferPercentage = patch.recurringTransferPercentage;
    }
    if (patch.recurringTransferMinAmount !== undefined) {
      this.walletRecurringTransferMinAmount = patch.recurringTransferMinAmount;
    }
    if (patch.recurringTransferKeepAmount !== undefined) {
      this.walletRecurringTransferKeepAmount = patch.recurringTransferKeepAmount;
    }
    if (patch.recurringTransferDecimals !== undefined) {
      this.walletRecurringTransferDecimals = patch.recurringTransferDecimals;
    }
    if (patch.recurringTransferCron !== undefined) {
      this.walletRecurringTransferCron = patch.recurringTransferCron;
    }
    if (patch.recurringTransferTz !== undefined) {
      this.walletRecurringTransferTz = patch.recurringTransferTz;
    }
    if (patch.recurringTransferName !== undefined) {
      this.walletRecurringTransferName = patch.recurringTransferName;
    }
  }

  handleWalletTokenSearchQueryChange(next: string) {
    this.walletPolicyTokenSearchQuery = next;
    this.walletPolicyTokenSearchError = null;
  }

  async handleWalletTokenSearch() {
    const query = this.walletPolicyTokenSearchQuery.trim();
    if (!query || this.walletPolicyTokenSearchLoading) {
      return;
    }
    this.walletPolicyTokenSearchLoading = true;
    this.walletPolicyTokenSearchError = null;
    try {
      const response = await searchWalletSolanaTokens({
        query,
        walletId: this.walletDetailsWalletId || this.walletDefaultWalletId || undefined,
      });
      this.walletPolicyTokenSearchResults = response.tokens;
      if (response.tokens.length === 0) {
        this.walletPolicyTokenSearchError = "No token matches. Paste the exact mint instead.";
      }
    } catch (error) {
      this.walletPolicyTokenSearchError =
        error instanceof Error ? error.message : "Token search failed";
    } finally {
      this.walletPolicyTokenSearchLoading = false;
    }
  }

  handleWalletTokenSearchSelect(token: WalletSolanaTokenSearchResult) {
    this.walletPolicyTokenCapMint = token.mint;
    this.walletPolicyTokenCapDecimals = String(token.decimals);
    this.walletPolicyTokenSearchQuery = token.symbol || token.name || token.mint;
    this.walletPolicyTokenSearchError = null;
  }

  async handleWalletSavePolicy() {
    const recurringMint = this.walletRecurringTransferMint.trim();
    const recurringDecimals = recurringMint
      ? Number.parseInt(this.walletRecurringTransferDecimals.trim(), 10)
      : 9;
    if (
      this.currentWalletPolicyRole() === "agent" &&
      recurringMint &&
      (!Number.isInteger(recurringDecimals) || recurringDecimals < 0 || recurringDecimals > 18)
    ) {
      this.walletSettingsError =
        "Set token decimals between 0 and 18 before saving a token schedule.";
      return;
    }
    await this.handleWalletPatchSettings(
      buildWalletPolicyPatch({
        capsEnabled: this.walletPolicyCapsEnabled,
        directSigning:
          this.currentWalletPolicyRole() === "agent" ? this.walletPolicyAutoEnabled : false,
        skillsEnabled:
          this.currentWalletPolicyRole() === "agent" ? this.walletPolicySkillsEnabled : false,
        solanaMaxPerTx: this.walletPolicySolMaxPerTx,
        solanaMaxDaily: this.walletPolicySolMaxDaily,
        solanaAllowPrograms: this.walletPolicySolanaAllowPrograms,
        solanaTokenCaps: this.walletPolicySolanaTokenCaps,
        recurringTransfer:
          this.currentWalletPolicyRole() === "agent"
            ? {
                enabled: this.walletRecurringTransferEnabled,
                to: this.walletRecurringTransferDestination,
                program: recurringMint,
                amountMode: this.walletRecurringTransferAmountMode,
                amount:
                  this.walletRecurringTransferAmountMode === "fixed"
                    ? this.normalizeRecurringTransferAmount(
                        this.walletRecurringTransferAmount,
                        recurringDecimals,
                      )
                    : undefined,
                percentage: Number.parseInt(this.walletRecurringTransferPercentage || "100", 10),
                minAmount: this.normalizeRecurringTransferAmount(
                  this.walletRecurringTransferMinAmount,
                  recurringDecimals,
                ),
                keepAmount: this.normalizeRecurringTransferAmount(
                  this.walletRecurringTransferKeepAmount,
                  recurringDecimals,
                ),
                cron: this.walletRecurringTransferCron,
                tz: this.walletRecurringTransferTz,
                name: this.walletRecurringTransferName,
              }
            : undefined,
      }),
    );
  }

  async handleWalletValidateSettings() {
    if (this.walletSettingsBusy) {
      return;
    }
    this.walletSettingsBusy = true;
    this.walletSettingsError = null;
    this.walletSettingsMessage = null;
    try {
      const validation = await validateWalletSettings({ providerId: this.walletProviderTab });
      this.walletSettingsValidation = validation;
      this.walletSettingsMessage = validation.valid
        ? "Wallet settings validation passed."
        : "Wallet settings validation reported issues.";
    } catch (err) {
      this.walletSettingsError = `Wallet validation failed: ${String(err)}`;
    } finally {
      this.walletSettingsBusy = false;
    }
  }

  async handleWalletSaveRpcSecret() {
    if (this.walletSettingsBusy) {
      return;
    }
    const walletId = this.walletDetailsWalletId.trim();
    const rpcUrl = this.walletRpcUrl.trim();
    const wallet = this.walletNamedWallets.find((entry) => entry.id === walletId);
    if (!walletId || wallet?.providerId !== "local-socket-signer") {
      this.walletSettingsError = "Select a native signer wallet before updating its RPC.";
      return;
    }
    if (!rpcUrl) {
      this.walletSettingsError = "Enter one primary Solana RPC URL.";
      return;
    }
    this.walletSettingsBusy = true;
    this.walletSettingsError = null;
    this.walletSettingsMessage = null;
    try {
      await updateWalletNamedWallet({ walletId, rpcUrl });
      this.walletRpcUrl = "";
      this.walletSettingsMessage =
        "Signer-owned primary RPC updated and verified against the wallet's pinned genesis.";
      await this.handleWalletLoad();
    } catch (err) {
      this.walletSettingsError = `Updating wallet RPC failed: ${String(err)}`;
    } finally {
      this.walletSettingsBusy = false;
    }
  }

  async handleWalletSaveProviderCredentials() {
    if (this.walletSettingsBusy) {
      return;
    }
    if (!this.walletSettings) {
      this.walletSettingsError = "Wallet settings are not loaded.";
      return;
    }
    const providerId = this.walletProviderTab;
    if (providerId !== "alchemy") {
      const payloadText = this.walletProviderCredentialsJson.trim();
      let credentialsPayload: Record<string, unknown> = {};
      try {
        credentialsPayload = payloadText
          ? (JSON.parse(payloadText) as Record<string, unknown>)
          : {};
      } catch {
        this.walletSettingsError = "Provider credentials JSON is invalid.";
        return;
      }
      const credentials: Record<string, string> = {};
      for (const [key, value] of Object.entries(credentialsPayload)) {
        if (typeof value !== "string") {
          continue;
        }
        const normalizedKey = key.trim();
        const normalizedValue = value.trim();
        if (!normalizedKey || !normalizedValue) {
          continue;
        }
        credentials[normalizedKey] = normalizedValue;
      }
      if (Object.keys(credentials).length === 0) {
        this.walletSettingsError =
          "Provider credentials JSON must include at least one non-empty string field.";
        return;
      }
      this.walletSettingsBusy = true;
      this.walletSettingsError = null;
      this.walletSettingsMessage = null;
      try {
        const approvalToken = await this.resolveWalletApprovalToken({
          operation: "wallet.provider-credentials",
        });
        await putWalletProviderCredentials(
          {
            providerId,
            credentials,
          },
          approvalToken ?? undefined,
        );
        this.walletSettingsMessage = "Provider credentials saved.";
        await this.handleWalletLoad();
      } catch (err) {
        this.walletSettingsError = `Saving provider credentials failed: ${String(err)}`;
      } finally {
        this.walletSettingsBusy = false;
      }
      return;
    }
    const apiKey = this.walletProviderApiKey.trim();
    const serverSignerAccessKey = this.walletProviderServerSignerAccessKey.trim();
    if (!apiKey || !serverSignerAccessKey) {
      this.walletSettingsError = "Alchemy API key and Server Signer Access Key are required.";
      return;
    }
    this.walletSettingsBusy = true;
    this.walletSettingsError = null;
    this.walletSettingsMessage = null;
    try {
      const approvalToken = await this.resolveWalletApprovalToken({
        operation: "wallet.provider-credentials",
      });
      await putWalletProviderCredentials(
        {
          providerId,
          apiKey,
          serverSignerAccessKey,
          serverSignerAccountId: this.walletProviderServerSignerAccountId.trim() || undefined,
          walletApiBaseUrl: this.walletProviderWalletApiBaseUrl.trim() || undefined,
          signerApiBaseUrl: this.walletProviderSignerApiBaseUrl.trim() || undefined,
          defaultSolanaAddress: this.walletProviderDefaultSolanaAddress.trim() || undefined,
        },
        approvalToken ?? undefined,
      );
      this.walletProviderApiKey = "";
      this.walletProviderServerSignerAccessKey = "";
      this.walletSettingsMessage = "Provider credentials saved.";
      await this.handleWalletLoad();
    } catch (err) {
      this.walletSettingsError = `Saving provider credentials failed: ${String(err)}`;
    } finally {
      this.walletSettingsBusy = false;
    }
  }

  async handleWalletDeleteProviderCredentials() {
    if (this.walletSettingsBusy) {
      return;
    }
    this.walletSettingsBusy = true;
    this.walletSettingsError = null;
    this.walletSettingsMessage = null;
    try {
      const approvalToken = await this.resolveWalletApprovalToken({
        operation: "wallet.provider-credentials",
      });
      await deleteWalletProviderCredentialsFor(this.walletProviderTab, approvalToken ?? undefined);
      this.walletSettingsMessage = "Provider credentials removed.";
      await this.handleWalletLoad();
    } catch (err) {
      this.walletSettingsError = `Removing provider credentials failed: ${String(err)}`;
    } finally {
      this.walletSettingsBusy = false;
    }
  }

  async handleWalletDeleteRpcSecret() {
    this.walletSettingsError =
      "RPC settings are signer/provider-owned and are not stored by the Gateway UI.";
  }

  async handleWalletSelectProvider(providerId: WalletProviderInfo["id"]) {
    if (this.walletSettingsBusy) {
      return;
    }
    this.walletSettingsBusy = true;
    this.walletSettingsError = null;
    this.walletSettingsMessage = null;
    try {
      await patchWalletProvider({
        providerId,
        enabled: true,
        setDefault: true,
      });
      this.walletProviderSelection = providerId;
      this.walletProviderTab = providerId;
      const providerWallets = this.walletNamedWallets.filter(
        (wallet) => wallet.providerId === providerId,
      );
      this.walletDetailsWalletId = providerWallets[0]?.id ?? "";
      this.walletRpcUrl = "";
      this.walletCreateProvider = providerId;
      this.walletSettingsMessage = `Default wallet provider set to ${providerId}.`;
      await this.handleWalletLoad();
    } catch (err) {
      this.walletSettingsError = `Selecting wallet provider failed: ${String(err)}`;
    } finally {
      this.walletSettingsBusy = false;
    }
  }

  async handleWalletProviderTabChange(providerId: WalletProviderInfo["id"]) {
    this.walletProviderTab = providerId;
    this.walletCreateProvider = providerId;
    const providerWallets = this.walletNamedWallets.filter(
      (wallet) => wallet.providerId === providerId,
    );
    const stillValid = providerWallets.some((wallet) => wallet.id === this.walletDetailsWalletId);
    if (!stillValid) {
      this.walletDetailsWalletId = providerWallets[0]?.id ?? "";
      this.walletRpcUrl = "";
    }
    const balanceStillValid = providerWallets.some(
      (wallet) => wallet.id === this.walletBalanceWalletId,
    );
    if (!balanceStillValid) {
      this.walletBalanceWalletId = "";
    }
    const expandedStillValid = providerWallets.some(
      (wallet) => wallet.id === this.walletExpandedPanelWalletId,
    );
    if (!expandedStillValid) {
      this.walletExpandedPanelWalletId = "";
      this.walletExpandedPanel = "";
    }
    await this.handleWalletLoad();
  }

  async handleWalletDetailsWalletChange(walletId: string) {
    const nextWalletId = walletId.trim();
    if (nextWalletId !== this.walletDetailsWalletId) {
      this.walletRpcUrl = "";
    }
    this.walletDetailsWalletId = nextWalletId;
    await this.handleWalletLoad();
  }

  async handleWalletBalanceWalletChange(walletId: string) {
    const nextWalletId = walletId.trim();
    if (!nextWalletId) {
      return;
    }
    if (
      this.walletExpandedPanelWalletId === nextWalletId &&
      this.walletExpandedPanel === "balance"
    ) {
      this.walletExpandedPanelWalletId = "";
      this.walletExpandedPanel = "";
      this.walletBalanceWalletId = "";
      return;
    }
    this.walletExpandedPanelWalletId = nextWalletId;
    this.walletExpandedPanel = "balance";
    this.walletBalanceWalletId = nextWalletId;
    await this.handleWalletLoad();
  }

  handleWalletPolicyPanelChange(panel: "caps" | "schedule" | "automation" | "skills" | "sweep") {
    this.walletPolicyPanel = panel;
  }

  async handleWalletSetProviderEnabled(providerId: WalletProviderInfo["id"], enabled: boolean) {
    if (this.walletSettingsBusy) {
      return;
    }
    this.walletSettingsBusy = true;
    this.walletSettingsError = null;
    this.walletSettingsMessage = null;
    try {
      await patchWalletProvider({
        providerId,
        enabled,
      });
      this.walletSettingsMessage = `${providerId} ${enabled ? "enabled" : "disabled"}.`;
      await this.handleWalletLoad();
    } catch (err) {
      this.walletSettingsError = `Updating provider state failed: ${String(err)}`;
    } finally {
      this.walletSettingsBusy = false;
    }
  }

  async handleWalletCreateNamedWallet() {
    if (this.walletSettingsBusy) {
      return;
    }
    const name = this.walletCreateName.trim();
    if (!name) {
      this.walletSettingsError = "Wallet name is required.";
      return;
    }
    if (!this.walletCreateRole) {
      this.walletSettingsError =
        "Choose Agent, Mining, or Vault. No wallet role is selected automatically.";
      return;
    }
    this.walletSettingsBusy = true;
    this.walletSettingsError = null;
    this.walletSettingsMessage = null;
    try {
      const providerId = this.walletCreateProvider || this.walletProviderTab;
      if (providerId === "wallet-standard") {
        throw new Error(
          "Use Attach Wallet Standard Vault so the browser wallet supplies and confirms the public account.",
        );
      }
      const walletId = this.walletCreateId.trim() || undefined;
      if (providerId === "local-socket-signer" && !walletId) {
        throw new Error(
          "Wallet ID is required for a native signer wallet (for example agent-primary or vault-reserve).",
        );
      }
      if (providerId === "local-socket-signer" && !this.walletCreateRpcUrl.trim()) {
        throw new Error("One primary Solana RPC URL is required for a native signer wallet.");
      }
      const created = await createWalletNamedWallet({
        name,
        walletId,
        providerId,
        role: this.walletCreateRole,
        chain: "solana",
        rpcUrl: providerId === "local-socket-signer" ? this.walletCreateRpcUrl.trim() : undefined,
      });
      this.walletProviderTab = providerId;
      this.walletCreateName = "";
      this.walletCreateId = "";
      this.walletCreateRole = "";
      this.walletCreateRpcUrl = "";
      this.walletSendCreateForm = {
        ...this.walletSendCreateForm,
        walletId: created.wallet.id,
      };
      this.walletDetailsWalletId = created.wallet.id;
      this.walletExpandedPanelWalletId = created.wallet.id;
      this.walletExpandedPanel = "security";
      this.walletSettingsMessage =
        providerId === "local-socket-signer"
          ? `Wallet created: ${created.wallet.name}. Its signer-owned RPC is active; sending remains disabled until the exact role policy is ready.`
          : `Wallet created: ${created.wallet.name}. Verify provider policy and review readiness before funding it.`;
      await this.handleWalletLoad();
    } catch (err) {
      this.walletSettingsError = `Creating wallet failed: ${String(err)}`;
    } finally {
      this.walletSettingsBusy = false;
    }
  }

  async handleWalletAttachStandardVault() {
    if (this.walletSettingsBusy) {
      return;
    }
    this.walletSettingsBusy = true;
    this.walletSettingsError = null;
    this.walletSettingsMessage = null;
    try {
      const selection = await connectWalletStandardAccount({
        chooser: chooseWalletStandardOption,
      });
      const suggestedName = `${selection.wallet.name} Vault`;
      const name = window.prompt("Name this Wallet Standard Vault", suggestedName)?.trim();
      if (!name) {
        throw new Error("Wallet Standard Vault attachment was cancelled");
      }
      const created = await createWalletNamedWallet({
        name,
        providerId: "wallet-standard",
        role: "vault",
        address: selection.account.address,
      });
      this.walletProviderTab = "wallet-standard";
      this.walletSendCreateForm = {
        ...this.walletSendCreateForm,
        walletId: created.wallet.id,
      };
      this.walletSettingsMessage =
        `Attached ${created.wallet.name}. Fased stores only its public address; ` +
        "each send still requires the connected wallet to review and sign. " +
        "For reserve custody, verify on the device that this account is hardware-backed.";
      await this.handleWalletLoad();
    } catch (err) {
      this.walletSettingsError = `Attaching Wallet Standard Vault failed: ${String(err)}`;
    } finally {
      this.walletSettingsBusy = false;
    }
  }

  async handleWalletDeleteNamedWallet(walletId: string, archive = false) {
    if (this.walletSettingsBusy) {
      return;
    }
    const confirmation = archive
      ? window.prompt(
          `Archive ${walletId}? The server checks Mining runtime obligations and locks the signer key deny-all. You must confirm external balances and recovery before continuing. Type the exact wallet ID to continue.`,
        )
      : window.confirm("Delete this named wallet?")
        ? walletId
        : null;
    if (confirmation !== walletId) {
      return;
    }
    this.walletSettingsBusy = true;
    this.walletSettingsError = null;
    this.walletSettingsMessage = null;
    try {
      await deleteWalletNamedWallet({
        walletId,
        ...(archive ? { archive: true, confirmWalletId: walletId } : {}),
      });
      if ((this.walletSendCreateForm.walletId ?? "") === walletId) {
        this.walletSendCreateForm = { ...this.walletSendCreateForm, walletId: "" };
      }
      if (this.walletDetailsWalletId === walletId) {
        this.walletDetailsWalletId = "";
      }
      if (this.walletBalanceWalletId === walletId) {
        this.walletBalanceWalletId = "";
      }
      if (this.walletExpandedPanelWalletId === walletId) {
        this.walletExpandedPanelWalletId = "";
        this.walletExpandedPanel = "";
      }
      this.walletSettingsMessage = archive
        ? "Wallet archived from Fased; the signer-owned key remains encrypted and permanently deny-all."
        : "Wallet deleted.";
      await this.handleWalletLoad();
    } catch (err) {
      this.walletSettingsError = `${archive ? "Archiving" : "Deleting"} wallet failed: ${String(err)}`;
    } finally {
      this.walletSettingsBusy = false;
    }
  }

  async handleWalletSetDefaultWallet(walletId: string | null) {
    if (this.walletSettingsBusy) {
      return;
    }
    const nextWalletId = String(walletId ?? "").trim() || null;
    const miningWalletId =
      String(
        this.miningProfile?.walletId ||
          this.miningStatus?.walletId ||
          this.miningReadiness?.selectedWalletId ||
          "",
      ).trim() || null;
    if (
      nextWalletId &&
      nextWalletId === miningWalletId &&
      nextWalletId !== (String(this.walletDefaultWalletId ?? "").trim() || null)
    ) {
      this.walletSettingsError =
        "Agent wallet must stay separate from SAT Mining. Clear the Agent default or choose a dedicated Agent wallet; @wallet:mining is reserved for SAT mining.";
      this.walletSettingsMessage = null;
      return;
    }
    this.walletSettingsBusy = true;
    this.walletSettingsError = null;
    this.walletSettingsMessage = null;
    try {
      await upsertWalletAssignment({ defaultWalletId: nextWalletId });
      this.walletSettingsMessage = nextWalletId
        ? "Primary Agent wallet set."
        : "Primary Agent wallet cleared. Agent role stays on wallet handles.";
      await this.handleWalletLoad();
    } catch (err) {
      this.walletSettingsError = `Updating default wallet failed: ${String(err)}`;
    } finally {
      this.walletSettingsBusy = false;
    }
  }

  async handleWalletAssignAgentWallet() {
    if (this.walletSettingsBusy) {
      return;
    }
    const agentId = this.walletAssignAgentId.trim();
    if (!agentId) {
      this.walletSettingsError = "Agent ID is required.";
      return;
    }
    const walletId = this.walletAssignWalletId.trim() || undefined;
    this.walletSettingsBusy = true;
    this.walletSettingsError = null;
    this.walletSettingsMessage = null;
    try {
      await upsertWalletAssignment({ agentId, walletId });
      this.walletSettingsMessage = walletId
        ? `Assigned ${agentId} to wallet ${walletId}.`
        : `Cleared wallet assignment for ${agentId}.`;
      await this.handleWalletLoad();
    } catch (err) {
      this.walletSettingsError = `Updating assignment failed: ${String(err)}`;
    } finally {
      this.walletSettingsBusy = false;
    }
  }

  async handleWalletDeleteAgentAssignment(agentId: string) {
    if (this.walletSettingsBusy) {
      return;
    }
    this.walletSettingsBusy = true;
    this.walletSettingsError = null;
    this.walletSettingsMessage = null;
    try {
      await deleteWalletAssignment({ agentId });
      this.walletSettingsMessage = `Assignment removed for ${agentId}.`;
      await this.handleWalletLoad();
    } catch (err) {
      this.walletSettingsError = `Removing assignment failed: ${String(err)}`;
    } finally {
      this.walletSettingsBusy = false;
    }
  }

  private async resolveWalletApprovalToken(params: {
    operation:
      | "wallet.rotate"
      | "wallet.reset"
      | "wallet.approve"
      | "wallet.policy"
      | "wallet.settings"
      | "wallet.provider-credentials"
      | "wallet.passkey-enroll"
      | "wallet.passkey-remove"
      | "wallet.execution-mode"
      | "wallet.send"
      | "mining.capital"
      | "mining.policy";
    requestId?: string;
  }): Promise<string | null> {
    if (!this.walletStatus) {
      await this.handleWalletLoad();
    }
    const mode = this.walletStatus?.approvalAuth?.mode ?? "none";
    if (mode !== "webauthn") {
      return null;
    }
    const passkeyCount = this.walletStatus?.approvalAuth?.passkeyCount ?? 0;
    if (passkeyCount <= 0) {
      throw new Error(
        "Wallet Control Passkey is enabled but no passkey is enrolled. Enroll a passkey or turn passkey approval off.",
      );
    }
    const auth = await authorizeWalletActionWithPasskey({
      operation: params.operation,
      requestId: params.requestId,
    });
    return auth.approvalToken;
  }

  async handleWalletEnrollPasskey() {
    if (this.walletPasskeyBusy) {
      return;
    }
    const mode = this.walletStatus?.approvalAuth?.mode ?? "none";
    if (mode !== "webauthn") {
      this.walletPasskeyError =
        "Passkey enrollment is disabled. Set wallet approval auth mode to webauthn in Policy and Safety.";
      return;
    }
    this.walletPasskeyBusy = true;
    this.walletPasskeyError = null;
    this.walletActionMessage = null;
    try {
      let approvalToken: string | null = null;
      const passkeyCount = this.walletStatus?.approvalAuth?.passkeyCount ?? 0;
      if (passkeyCount > 0) {
        approvalToken = await this.resolveWalletApprovalToken({
          operation: "wallet.passkey-enroll",
        });
      }
      await enrollWalletPasskey(
        this.walletPasskeyLabel.trim() || undefined,
        approvalToken ?? undefined,
      );
      this.walletPasskeyLabel = "";
      this.walletActionMessage = "Passkey enrolled for wallet approvals.";
      await this.handleWalletLoad();
    } catch (err) {
      this.walletPasskeyError = `Passkey enrollment failed: ${String(err)}`;
    } finally {
      this.walletPasskeyBusy = false;
    }
  }

  async handleWalletDeletePasskey(credentialId: string) {
    if (this.walletPasskeyBusy) {
      return;
    }
    const normalized = credentialId.trim();
    if (!normalized) {
      return;
    }
    this.walletPasskeyBusy = true;
    this.walletPasskeyError = null;
    this.walletActionMessage = null;
    try {
      const approvalToken = await this.resolveWalletApprovalToken({
        operation: "wallet.passkey-remove",
      });
      const result = await deleteWalletPasskey(normalized, approvalToken ?? undefined);
      this.walletActionMessage = `Removed passkey ${result.passkey.label || normalized}.`;
      await this.handleWalletLoad();
    } catch (err) {
      this.walletPasskeyError = `Passkey removal failed: ${String(err)}`;
    } finally {
      this.walletPasskeyBusy = false;
    }
  }

  async handleWalletEnablePasskeyApproval() {
    if (this.walletSettingsBusy) {
      return;
    }
    this.walletPasskeyError = null;
    await this.handleWalletPatchSettings({
      approvalAuthMode: "webauthn",
    });
    if (!this.walletSettingsError) {
      this.walletActionMessage = "Passkey approval enabled. Enroll a passkey next.";
    }
  }

  async handleWalletRotateKeys() {
    this.walletError =
      "Wallet key rotation is signer/provider-owned and is unavailable through the Gateway UI.";
  }

  async handleWalletResetKeys() {
    this.walletError =
      "Wallet reset is unavailable through the Gateway UI. Create/import only in the signer, provider, or hardware-wallet authority surface.";
  }

  async handleWalletSetApprovalsFilter(filter: WalletApprovalFilter) {
    this.walletApprovalsFilter = filter;
    await this.handleWalletLoad();
  }

  async handleWalletApproveRequest(requestId: string) {
    if (this.walletApprovalsBusyId) {
      return;
    }
    const request = this.walletApprovals.find((entry) => entry.id === requestId);
    this.walletApprovalsBusyId = requestId;
    this.walletApprovalsError = null;
    try {
      const usesSignerWebAuthn =
        request?.payload.providerId === "local-socket-signer" &&
        Boolean(request.payload.signerReviewId?.trim());
      const approvalToken = usesSignerWebAuthn
        ? null
        : await this.resolveWalletApprovalToken({
            operation: "wallet.approve",
            requestId,
          });
      let response = await approveWalletSend(requestId, approvalToken ?? undefined);
      if (response.mode === "signer-webauthn") {
        const authorization = response.signerAuthorization;
        if (!request || !authorization) {
          throw new Error("Gateway returned an incomplete signer WebAuthn review");
        }
        if (!signerAuthorizationMatchesWalletApproval(authorization, request)) {
          throw new Error("Signer WebAuthn binding does not match the reviewed approval");
        }
        const assertion = await authorizeSignerReviewWithPasskey(authorization);
        response = await finishWalletSignerReviewApproval({
          requestId,
          challengeId: assertion.challengeId,
          credential: assertion.credential,
        });
      } else if (response.mode === "browser") {
        const review = response.browserReview;
        if (!review) {
          throw new Error("Gateway returned an incomplete browser signing review");
        }
        if (Date.parse(review.expiresAt) <= Date.now()) {
          throw new Error("The reviewed transaction expired before signing; approve it again");
        }
        const signed = await signWalletStandardTransaction({
          unsignedTxBase64: review.unsignedTxBase64,
          expectedAddress: review.signer,
          chain: review.chain,
          chooser: chooseWalletStandardOption,
        });
        response = await executeWalletStandardSend({
          requestId,
          preparedId: review.preparedId,
          intentDigest: review.intentDigest,
          signedTxBase64: signed.signedTxBase64,
        });
      }
      const txHash =
        typeof (response.tx as { txHash?: unknown } | undefined)?.txHash === "string"
          ? (response.tx as { txHash: string }).txHash
          : null;
      const actionLabel =
        request?.payload.actionKind === "signer_review" ? "Reviewed operation" : "Send";
      this.walletActionMessage = txHash
        ? `${actionLabel} approved and executed (${txHash}).`
        : `${actionLabel} approved.`;
      await this.handleWalletLoad();
    } catch (err) {
      this.walletApprovalsError = formatWalletApproveError(err);
    } finally {
      this.walletApprovalsBusyId = null;
    }
  }

  async handleWalletRejectRequest(requestId: string) {
    if (this.walletApprovalsBusyId) {
      return;
    }
    this.walletApprovalsBusyId = requestId;
    this.walletApprovalsError = null;
    try {
      const approvalToken = await this.resolveWalletApprovalToken({
        operation: "wallet.approve",
        requestId,
      });
      await rejectWalletSend(requestId, "rejected by operator", approvalToken ?? undefined);
      this.walletActionMessage = "Send request rejected.";
      await this.handleWalletLoad();
    } catch (err) {
      this.walletApprovalsError = `Reject failed: ${String(err)}`;
    } finally {
      this.walletApprovalsBusyId = null;
    }
  }

  handleWalletOpenSendModal(walletId: string, assetId?: string) {
    const wallet = this.walletNamedWallets.find((entry) => entry.id === walletId);
    const normalizedAssetId = assetId?.trim() || undefined;
    const assetPatch =
      normalizedAssetId === "solana:native"
        ? {
            chain: "solana" as const,
            assetId: normalizedAssetId,
            contract: undefined,
            program: undefined,
          }
        : normalizedAssetId?.startsWith("solana:spl-token:")
          ? {
              chain: "solana" as const,
              assetId: normalizedAssetId,
              contract: undefined,
              program: normalizedAssetId.slice("solana:spl-token:".length) || undefined,
            }
          : {
              assetId:
                inferWalletPreferredChain(wallet) === "solana"
                  ? "solana:native"
                  : this.walletSendCreateForm.assetId,
            };
    this.handleWalletSendCreatePatch(
      normalizeSendFormForWallet(
        {
          ...this.walletSendCreateForm,
          walletId,
          ...assetPatch,
        },
        wallet,
      ),
    );
    this.sendModalVisible = true;
    this.walletBalanceWalletId = walletId;
    void this.loadWalletSendAssets(walletId);
  }

  private async loadWalletSendAssets(walletId: string) {
    const requestedWalletId = walletId.trim();
    if (!requestedWalletId) {
      return;
    }
    this.walletBalancesLoading = true;
    try {
      const balances = await getWalletBalances("all", {
        walletId: requestedWalletId,
        includeAssets: true,
      });
      if (
        this.sendModalVisible &&
        this.walletSendCreateForm.walletId?.trim() === requestedWalletId
      ) {
        const solanaBalance = balances.balances.solana as
          | { ok?: boolean; balance?: string }
          | undefined;
        this.walletBalances = balances;
        this.walletBalancesError = null;
        this.walletNamedWallets = this.walletNamedWallets.map((wallet) =>
          wallet.id === requestedWalletId
            ? {
                ...wallet,
                addresses: {
                  ...wallet.addresses,
                  ...balances.addresses,
                },
                balances: {
                  ...wallet.balances,
                  solana: solanaBalance?.ok ? solanaBalance.balance : wallet.balances?.solana,
                },
                readiness: {
                  ...wallet.readiness,
                  keystore: Boolean(wallet.readiness?.keystore),
                  rpc: Boolean(wallet.readiness?.rpc || solanaBalance?.ok),
                },
              }
            : wallet,
        );
      }
    } catch (err) {
      if (
        this.sendModalVisible &&
        this.walletSendCreateForm.walletId?.trim() === requestedWalletId
      ) {
        this.walletBalancesError = String(err);
      }
    } finally {
      if (this.walletSendCreateForm.walletId?.trim() === requestedWalletId) {
        this.walletBalancesLoading = false;
      }
    }
  }

  handleWalletCloseSendModal() {
    this.sendModalVisible = false;
  }

  handleWalletSendCreatePatch(patch: Partial<WalletSendCreateInput>) {
    const next = {
      ...this.walletSendCreateForm,
      ...patch,
    };
    const walletId = next.walletId?.trim();
    const wallet = walletId
      ? this.walletNamedWallets.find((entry) => entry.id === walletId)
      : undefined;
    this.walletSendCreateForm = normalizeSendFormForWallet(next, wallet);
  }

  async handleWalletSelectDetailsWallet(walletId: string) {
    const nextWalletId = walletId.trim();
    if (!nextWalletId) {
      return;
    }
    if (
      this.walletExpandedPanelWalletId === nextWalletId &&
      this.walletExpandedPanel === "security"
    ) {
      this.walletExpandedPanelWalletId = "";
      this.walletExpandedPanel = "";
      return;
    }
    this.walletExpandedPanelWalletId = nextWalletId;
    this.walletExpandedPanel = "security";
    this.walletBalanceWalletId = "";
    if (nextWalletId !== this.walletDetailsWalletId) {
      this.walletDetailsWalletId = nextWalletId;
      this.walletRpcUrl = "";
      await this.handleWalletLoad();
    }
    void this.updateComplete.then(() => {
      const focusSection = () => {
        const section = this.renderRoot.querySelector<HTMLElement>("#wallet-security-card");
        section?.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(focusSection);
      } else {
        setTimeout(focusSection, 0);
      }
    });
  }

  async handleWalletCreateSendRequest() {
    if (this.walletSendCreateBusy) {
      return;
    }
    const rawForm = this.walletSendCreateForm;
    const rawSelectedWalletId = rawForm.walletId?.trim() || undefined;
    const rawSelectedWallet = rawSelectedWalletId
      ? this.walletNamedWallets.find((wallet) => wallet.id === rawSelectedWalletId)
      : undefined;
    const form = normalizeSendFormForWallet(rawForm, rawSelectedWallet);
    this.walletSendCreateBusy = true;
    this.walletSendCreateError = null;
    this.walletActionMessage = null;
    try {
      const selectedWalletId = form.walletId?.trim() || undefined;
      const selectedWallet = selectedWalletId
        ? this.walletNamedWallets.find((wallet) => wallet.id === selectedWalletId)
        : undefined;
      const assetMetadata = resolveSendFormAssetMetadata(form, this.walletBalances);
      const payload: WalletSendCreateInput = {
        chain: form.chain,
        amountFormat: "human",
        providerId: selectedWallet?.providerId,
        walletId: selectedWalletId,
        walletName: selectedWallet?.name,
        assetId: assetMetadata.assetId,
        assetSymbol: assetMetadata.assetSymbol,
        assetName: assetMetadata.assetName,
        assetDecimals: assetMetadata.assetDecimals,
        amountDisplay: assetMetadata.amountDisplay,
        to: form.to?.trim() || undefined,
        amount: form.amount?.trim() || undefined,
        contract: form.contract?.trim() || undefined,
        program: form.program?.trim() || undefined,
        memo: form.memo?.trim() || undefined,
      };
      const response = await createWalletSendRequest(payload);
      if (response.mode === "manual" && response.request?.id) {
        this.walletApprovalsFilter = "pending";
        this.sendModalVisible = false;
        this.walletActionMessage = `Created send request ${response.request.id}. Open Wallet Approvals below to approve and broadcast.`;
      } else if (response.mode === "autonomous" && response.tx?.txHash) {
        this.sendModalVisible = false;
        this.walletActionMessage = `Autonomous send executed (${response.tx.txHash}).`;
      } else {
        this.sendModalVisible = false;
        this.walletActionMessage = "Wallet send submitted.";
      }
      this.walletSendCreateForm = {
        ...this.walletSendCreateForm,
        to: "",
        amount: "",
        memo: "",
      };
      await this.handleWalletLoad();
      if (response.mode === "manual" && response.request?.id) {
        const jump = () =>
          document.getElementById("wallet-approvals")?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(jump);
        } else {
          setTimeout(jump, 0);
        }
      }
    } catch (err) {
      this.walletSendCreateError = `Create request failed: ${String(err)}`;
    } finally {
      this.walletSendCreateBusy = false;
    }
  }

  async handleWalletApplyRecommendedPolicy() {
    await this.handleWalletPatchSettings({ policyTemplate: "recommended" });
  }

  async handleAbortChat() {
    await handleAbortChatInternal(this as unknown as Parameters<typeof handleAbortChatInternal>[0]);
  }

  removeQueuedMessage(id: string) {
    removeQueuedMessageInternal(
      this as unknown as Parameters<typeof removeQueuedMessageInternal>[0],
      id,
    );
  }

  async handleSendChat(
    messageOverride?: string,
    opts?: Parameters<typeof handleSendChatInternal>[2],
  ) {
    await handleSendChatInternal(
      this as unknown as Parameters<typeof handleSendChatInternal>[0],
      messageOverride,
      opts,
    );
  }

  async handleWhatsAppStart(force: boolean) {
    await handleWhatsAppStartInternal(this, force);
  }

  async handleWhatsAppWait() {
    await handleWhatsAppWaitInternal(this);
  }

  async handleWhatsAppLogout() {
    await handleWhatsAppLogoutInternal(this);
  }

  async handleChannelQrStart(channelId: string, force = false, accountId?: string) {
    await handleChannelQrStartInternal(this, channelId, force, accountId);
  }

  async handleChannelQrWait(channelId: string, accountId?: string) {
    await handleChannelQrWaitInternal(this, channelId, accountId);
  }

  async handleChannelLogout(channelId: string, accountId?: string) {
    await handleChannelLogoutInternal(this, channelId, accountId);
  }

  async handleChannelInstall(channelId: string) {
    await handleChannelInstallInternal(this, channelId);
  }

  cancelChannelConfirmAction() {
    cancelChannelConfirmActionInternal(this);
  }

  async confirmChannelAction() {
    await confirmChannelActionInternal(this);
  }

  async handleChannelEnable(channelId: string) {
    await handleChannelEnableInternal(this, channelId);
  }

  async handleChannelConfigSave() {
    await handleChannelConfigSaveInternal(this);
  }

  async handleChannelConfigReload() {
    await handleChannelConfigReloadInternal(this);
  }

  handleNostrProfileEdit(accountId: string, profile: NostrProfile | null) {
    handleNostrProfileEditInternal(this, accountId, profile);
  }

  handleNostrProfileCancel() {
    handleNostrProfileCancelInternal(this);
  }

  handleNostrProfileFieldChange(field: keyof NostrProfile, value: string) {
    handleNostrProfileFieldChangeInternal(this, field, value);
  }

  async handleNostrProfileSave() {
    await handleNostrProfileSaveInternal(this);
  }

  async handleNostrProfileImport() {
    await handleNostrProfileImportInternal(this);
  }

  handleNostrProfileToggleAdvanced() {
    handleNostrProfileToggleAdvancedInternal(this);
  }

  async handleExecApprovalDecision(decision: "allow-once" | "allow-always" | "deny") {
    const active = this.execApprovalQueue[0];
    if (!active || !this.client || this.execApprovalBusy) {
      return;
    }
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      await this.client.request("exec.approval.resolve", {
        id: active.id,
        decision,
      });
      this.execApprovalQueue = this.execApprovalQueue.filter((entry) => entry.id !== active.id);
    } catch (err) {
      this.execApprovalError = `Exec approval failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  handleGatewayUrlConfirm() {
    const nextGatewayUrl = this.pendingGatewayUrl;
    if (!nextGatewayUrl) {
      return;
    }
    const nextToken = this.pendingGatewayToken?.trim() ?? "";
    this.pendingGatewayUrl = null;
    this.pendingGatewayToken = null;
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      gatewayUrl: nextGatewayUrl,
      ...(nextToken ? { token: nextToken } : {}),
    });
    this.connect();
  }

  handleGatewayUrlCancel() {
    this.pendingGatewayUrl = null;
    this.pendingGatewayToken = null;
  }

  // Sidebar handlers for tool output viewing
  handleOpenSidebar(content: string) {
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
      this.sidebarCloseTimer = null;
    }
    this.sidebarContent = content;
    this.sidebarError = null;
    this.sidebarOpen = true;
  }

  handleCloseSidebar() {
    this.sidebarOpen = false;
    // Clear content after transition
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
    }
    this.sidebarCloseTimer = window.setTimeout(() => {
      if (this.sidebarOpen) {
        return;
      }
      this.sidebarContent = null;
      this.sidebarError = null;
      this.sidebarCloseTimer = null;
    }, 200);
  }

  handleSplitRatioChange(ratio: number) {
    const newRatio = Math.max(0.4, Math.min(0.7, ratio));
    this.splitRatio = newRatio;
    this.applySettings({ ...this.settings, splitRatio: newRatio });
  }

  setLoginTokenCandidate(token: string) {
    this.loginTokenCandidate = token;
  }

  render() {
    if (this.uiRuntimeError) {
      return this.renderUiRuntimeError(this.uiRuntimeError);
    }
    try {
      return renderApp(this as unknown as AppViewState);
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      queueMicrotask(() => this.reportUiRuntimeError(message));
      return this.renderUiRuntimeError(message);
    }
  }
}
