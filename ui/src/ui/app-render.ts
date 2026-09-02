import { html, nothing } from "lit";
import { FASED_AGENT_NAME, FASED_BRAND_NAME } from "../../../src/brand.js";
import { normalizeAgentModelFallbackValues } from "../../../src/config/model-input.js";
import { parseAgentSessionKey } from "../../../src/routing/session-key.js";
import { materializeAgentConfigList } from "./agent-config-entry.ts";
import { formatAgentDisplayLabel } from "./agent-display.ts";
import { refreshChatAvatar } from "./app-chat.ts";
import { DEFAULT_CRON_FORM } from "./app-defaults.ts";
import { renderUsageTab } from "./app-render-usage-tab.ts";
import {
  renderChatComposerControls,
  renderChatControls,
  renderTab,
  renderThemeToggle,
} from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import { buildChatModelOption, formatChatModelDisplay } from "./chat-model-ref.ts";
import { loadAgentFileContent, loadAgentFiles, saveAgentFile } from "./controllers/agent-files.ts";
import { loadAgentIdentities, loadAgentIdentity } from "./controllers/agent-identity.ts";
import { loadAgentSkills } from "./controllers/agent-skills.ts";
import {
  buildToolsEffectiveRequestKey,
  createAgent,
  loadAgents,
  loadToolsCatalog,
  loadToolsEffective,
  resetToolsEffectiveState,
} from "./controllers/agents.ts";
import { loadChannels, startChannelRuntime, stopChannelRuntime } from "./controllers/channels.ts";
import { loadChatHistory, loadCurrentChatSessionUsage } from "./controllers/chat.ts";
import { loadCommandsCatalog, type CommandsCatalogScope } from "./controllers/commands.ts";
import {
  applyConfig,
  clearProviderAuthCredential,
  configureProviderApiKeyCredential,
  loadConfig,
  runInteractiveProviderAuthCredential,
  saveConfig,
  storeProviderAuthCredential,
  submitConfigAuthPrompt,
  cancelConfigAuthPrompt,
  dismissConfigAuthAction,
  updateConfigFormValue,
  removeConfigFormValue,
} from "./controllers/config.ts";
import {
  loadCronRuns,
  loadCronRunDetail,
  loadMoreCronJobs,
  loadMoreCronRuns,
  toggleCronJob,
  runCronJob,
  removeCronJob,
  addCronJob,
  buildCronExecutionPolicy,
  buildCronPayload,
  buildCronSchedule,
  buildCronTaskTemplatePatch,
  buildTaskPolicyPresetPatch,
  addChatScheduleTask,
  cronJobToForm,
  createChatScheduleDraft,
  createChatScheduleDraftFromJob,
  DEFAULT_CHAT_SCHEDULE_DRAFT,
  normalizeCronFormState,
  startCronClone,
  TASK_POLICY_PRESET_OPTIONS,
  updateChatScheduleTask,
  cancelCronEdit,
  controlCronQueueRun,
  repairCronTask,
  approveCronTaskCoordination,
  askCronTaskAgentEvidence,
  updateCronTrustedSource,
  removeCronTrustedSource,
  closeCronRunDetail,
  updateCronJobsFilter,
  updateCronRunsFilter,
  validateCronForm,
} from "./controllers/cron.ts";
import {
  callDebugAdminRpcControl,
  callDebugAcpxPushTest,
  callDebugSatProtocolMaintenance,
  loadDebug,
  callDebugMethod,
  updateDebugAcpxBridgeConfig,
} from "./controllers/debug.ts";
import {
  approveDevicePairing,
  loadDevices,
  rejectDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
} from "./controllers/devices.ts";
import {
  loadExecApprovals,
  removeExecApprovalsFormValue,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "./controllers/exec-approvals.ts";
import { loadLogs } from "./controllers/logs.ts";
import { loadNodes } from "./controllers/nodes.ts";
import {
  installPluginMarketplaceEntry,
  loadExtensionsHooks,
  loadPluginMarketplace,
  restartPluginMarketplaceRuntime,
  selectPluginMarketplaceEntry,
  setExtensionHookEnabled,
  setPluginMarketplaceAdminRpcGrant,
  setPluginMarketplaceSessionHelperGrant,
  uninstallPluginMarketplaceEntry,
  updatePluginMarketplaceEntry,
} from "./controllers/plugins-marketplace.ts";
import { loadPresence } from "./controllers/presence.ts";
import {
  installServiceComponent,
  loadServiceCapabilities,
  provisionGmailService,
  restartServiceComponent,
  testWebSearchService,
} from "./controllers/services.ts";
import {
  branchSessionCheckpoint,
  deleteSessionAndRefresh,
  loadSessions,
  patchSession,
  restoreSessionCheckpoint,
  subscribeActiveSessionMessages,
} from "./controllers/sessions.ts";
import {
  closeClawHubDetail,
  closeClawHubReview,
  closeSkillCreateDialog,
  closeSkillEditor,
  confirmClawHubMarketplaceReview,
  copySkillToWorkspace,
  createSkill,
  installFromClawHub,
  installSkill,
  loadClawHubDetail,
  loadSkills,
  openSkillCreateDialog,
  openSkillEditor,
  previewClawHubUpdate,
  saveSkillApiKey,
  saveSkillConfig,
  saveSkillEnv,
  saveSkillEditor,
  searchClawHub,
  setClawHubInstallTarget,
  setClawHubSearchQuery,
  updateSkillConfigEdit,
  updateSkillCreateDraft,
  updateSkillEditorDraft,
  updateSkillEnvEdit,
  updateSkillEdit,
  updateSkillEnabled,
} from "./controllers/skills.ts";
import { loadUsage } from "./controllers/usage.ts";
import { icons } from "./icons.ts";
import type { SatMainnetSyncStatus } from "./mining-api.ts";
import {
  normalizeBasePath,
  pathForTab,
  TAB_GROUPS,
  subtitleForTab,
  titleForTab,
  type Tab,
} from "./navigation.ts";
import "./components/dashboard-header.ts";
import { resolveTaskLedgerSourceRoute } from "./task-ledger-source-route.ts";
import type { ChannelAccountSnapshot, CronJob, ModelCatalogEntry, TaskRecord } from "./types.ts";
import type { CronFormState } from "./ui-types.ts";
import {
  normalizeModelProviderId,
  resolveAgentConfig,
  resolveAgentModelProviders,
  resolveModelFallbacks,
  resolveModelPrimary,
  resolveTaskModelSlots,
} from "./views/agents-utils.ts";
import { renderAgents } from "./views/agents.ts";
import { renderChannels } from "./views/channels.ts";
import { renderChat, renderChatTopbarPanels } from "./views/chat.ts";
import { renderCron, renderCronRunDetailModal } from "./views/cron.ts";
import { renderDebug } from "./views/debug.ts";
import { renderExecApprovalPrompt } from "./views/exec-approval.ts";
import { renderGatewayUrlConfirmation } from "./views/gateway-url-confirmation.ts";
import { renderInstances } from "./views/instances.ts";
import { renderLogs } from "./views/logs.ts";
import { renderMemory } from "./views/memory.ts";
import { renderNodes } from "./views/nodes.ts";
import { renderNotifications } from "./views/notifications.ts";
import { renderOverview } from "./views/overview.ts";
import { renderPluginsMarketplace } from "./views/plugins-marketplace.ts";
import { renderServices } from "./views/services.ts";
import { renderSessions } from "./views/sessions.ts";
import { renderSkillDialogs, renderSkills, type SkillsProps } from "./views/skills.ts";

const AVATAR_DATA_RE = /^data:/i;
const ADVANCED_TABS: Array<{ tab: Tab; label: string; icon: unknown }> = [
  { tab: "config", label: "Config", icon: icons.settings },
  { tab: "debug", label: "Debug", icon: icons.bug },
  { tab: "nodes", label: "Nodes", icon: icons.monitor },
];
const CONTENT_HEADERLESS_TABS = new Set<Tab>([
  "agents",
  "chat",
  "config",
  "debug",
  "federation",
  "logs",
  "marketplace",
  "mining",
  "nodes",
  "notifications",
  "skills",
  "usage",
  "wallet",
]);
const AVATAR_HTTP_RE = /^https?:\/\//i;
type LazyTabViewKey = "config" | "providers" | "federation" | "wallet" | "mining";
type LazyTabViewModules = {
  config: typeof import("./views/config.ts");
  providers: typeof import("./views/providers.ts");
  federation: typeof import("./views/federation.ts");
  wallet: typeof import("./views/wallet.ts");
  mining: typeof import("./views/mining.ts");
};

const lazyTabViewLoaders: { [K in LazyTabViewKey]: () => Promise<LazyTabViewModules[K]> } = {
  config: () => import("./views/config.ts"),
  providers: () => import("./views/providers.ts"),
  federation: () => import("./views/federation.ts"),
  wallet: () => import("./views/wallet.ts"),
  mining: () => import("./views/mining.ts"),
};
const lazyTabViewCache: Partial<LazyTabViewModules> = {};
const lazyTabViewInflight = new Map<LazyTabViewKey, Promise<void>>();
const lazyTabViewErrors: Partial<Record<LazyTabViewKey, string>> = {};

function isStaleLazyTabChunkError(message: string): boolean {
  return (
    /failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message)
  );
}

function reloadForStaleLazyTabChunk(key: LazyTabViewKey): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const marker = `fased-control-ui:lazy-tab-reload:${key}`;
  try {
    if (window.sessionStorage.getItem(marker) === "1") {
      return false;
    }
    window.sessionStorage.setItem(marker, "1");
  } catch {
    // Continue with reload even if sessionStorage is unavailable.
  }
  window.location.reload();
  return true;
}

function resolveAssistantAvatarUrl(state: AppViewState): string | undefined {
  const list = state.agentsList?.agents ?? [];
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId = parsed?.agentId ?? state.agentsList?.defaultId ?? "main";
  const agent = list.find((entry) => entry.id === agentId);
  const configIdentity = readAgentConfigEntry(state, agentId).entry?.identity;
  const loadedIdentity = state.agentIdentityById[agentId];
  const candidate =
    configIdentity?.avatar ??
    loadedIdentity?.avatar ??
    readCachedAgentAvatar(agentId) ??
    agent?.identity?.avatarUrl ??
    agent?.identity?.avatar;
  if (!candidate) {
    return undefined;
  }
  if (AVATAR_DATA_RE.test(candidate) || AVATAR_HTTP_RE.test(candidate)) {
    return candidate;
  }
  return agent?.identity?.avatarUrl;
}

const AGENT_AVATAR_CACHE_PREFIX = "fased.agentAvatar.";

function agentAvatarCacheKey(agentId: string) {
  return `${AGENT_AVATAR_CACHE_PREFIX}${encodeURIComponent(agentId)}`;
}

function readCachedAgentAvatar(agentId: string): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    const value = window.localStorage.getItem(agentAvatarCacheKey(agentId))?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function writeCachedAgentAvatar(agentId: string, avatar: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const normalized = avatar.trim();
    if (normalized) {
      window.localStorage.setItem(agentAvatarCacheKey(agentId), normalized);
    } else {
      window.localStorage.removeItem(agentAvatarCacheKey(agentId));
    }
  } catch {
    // Avatar cache is best-effort; saved Agent config remains authoritative.
  }
}

function buildSkillsProps(state: AppViewState): SkillsProps {
  const report = state.skillsReport ?? state.agentSkillsReport;
  return {
    connected: state.connected,
    loading: state.skillsLoading,
    report,
    error: state.skillsError,
    libraryPanel: state.skillsLibraryPanel,
    filter: state.skillsFilter,
    statusFilter: state.skillsStatusFilter,
    edits: state.skillEdits,
    envEdits: state.skillEnvEdits,
    configEdits: state.skillConfigEdits,
    messages: state.skillMessages,
    createOpen: state.skillCreateOpen,
    createName: state.skillCreateName,
    createDescription: state.skillCreateDescription,
    createAgentId: state.skillCreateAgentId,
    createTemplate: state.skillCreateTemplate,
    createBusy: state.skillCreateBusy,
    createError: state.skillCreateError,
    busyKey: state.skillsBusyKey,
    skillEditor: state.skillEditor,
    skillEditorDraft: state.skillEditorDraft,
    skillEditorLoading: state.skillEditorLoading,
    skillEditorSaving: state.skillEditorSaving,
    skillEditorError: state.skillEditorError,
    detailKey: state.skillsDetailKey,
    attachAgentId: state.skillsAttachAgentId,
    configForm:
      state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null) ?? null,
    clawhubQuery: state.clawhubSearchQuery,
    clawhubResults: state.clawhubSearchResults,
    clawhubSearchLoading: state.clawhubSearchLoading,
    clawhubSearchError: state.clawhubSearchError,
    clawhubDetail: state.clawhubDetail,
    clawhubDetailSlug: state.clawhubDetailSlug,
    clawhubDetailLoading: state.clawhubDetailLoading,
    clawhubDetailError: state.clawhubDetailError,
    clawhubInstallSlug: state.clawhubInstallSlug,
    clawhubInstallMessage: state.clawhubInstallMessage,
    clawhubReview: state.clawhubReview,
    clawhubReviewLoading: state.clawhubReviewLoading,
    clawhubReviewError: state.clawhubReviewError,
    clawhubInstallTarget: state.clawhubInstallTarget,
    agentsList: state.agentsList,
    onLibraryPanelChange: (panel) => {
      state.skillsLibraryPanel = panel;
    },
    onFilterChange: (next) => (state.skillsFilter = next),
    onStatusFilterChange: (next) => (state.skillsStatusFilter = next),
    onRefresh: () => loadSkills(state, { clearMessages: true }),
    onToggle: (key, enabled) => updateSkillEnabled(state, key, enabled),
    onEdit: (key, value) => updateSkillEdit(state, key, value),
    onEnvEdit: (key, envName, value) => updateSkillEnvEdit(state, key, envName, value),
    onConfigEdit: (key, value) => updateSkillConfigEdit(state, key, value),
    onSaveKey: (key) => saveSkillApiKey(state, key),
    onSaveEnv: (key) => saveSkillEnv(state, key),
    onSaveConfig: (key) => saveSkillConfig(state, key),
    onSaveRootConfig: (skillKey, path, json) => {
      void saveSkillRootConfigFromUi(state, skillKey, path, json);
    },
    onInstall: (skillKey, name, installId) => installSkill(state, skillKey, name, installId),
    onTestSkill: (_skillKey, name) => {
      state.chatMessage = `Use the ${name} skill. Confirm the loaded skill name, then run a smoke test on: "smoke check". Return three lines: Skill, Steps, Result.`;
      closeSkillEditor(state);
      state.skillsDetailKey = null;
      state.tab = "chat";
      state.requestUpdate();
    },
    onCopyToWorkspace: (skillKey, agentId) => void copySkillToWorkspace(state, skillKey, agentId),
    onCreateOpen: () => {
      openSkillCreateDialog(state);
      state.requestUpdate();
    },
    onCreateClose: () => {
      closeSkillCreateDialog(state);
      state.requestUpdate();
    },
    onCreateDraftChange: (patch) =>
      updateSkillCreateDraft(state, {
        ...(patch.createName !== undefined ? { skillCreateName: patch.createName } : {}),
        ...(patch.createDescription !== undefined
          ? { skillCreateDescription: patch.createDescription }
          : {}),
        ...(patch.createAgentId !== undefined ? { skillCreateAgentId: patch.createAgentId } : {}),
        ...(patch.createTemplate !== undefined
          ? { skillCreateTemplate: patch.createTemplate }
          : {}),
      }),
    onCreateSave: () => void createSkill(state),
    onOpenEditor: (skillKey) => void openSkillEditor(state, skillKey),
    onCloseEditor: () => {
      closeSkillEditor(state);
      state.requestUpdate();
    },
    onEditorDraftChange: (draft) => updateSkillEditorDraft(state, draft),
    onSaveEditor: () => void saveSkillEditor(state),
    onDetailOpen: (skillKey) => {
      closeSkillEditor(state);
      state.skillsDetailKey = skillKey;
      state.requestUpdate();
    },
    onDetailClose: () => {
      closeSkillEditor(state);
      state.skillsDetailKey = null;
      state.requestUpdate();
    },
    onAttachAgentChange: (agentId) => (state.skillsAttachAgentId = agentId),
    onAttachToAgent: (skillKey, agentId) => void attachSkillToAgent(state, skillKey, agentId),
    onOpenAgentSkills: (agentId) => {
      state.agentsSelectedId = agentId;
      state.agentsPanel = "skills";
      state.tab = "agents";
      state.requestUpdate();
    },
    onOpenAgentTools: (agentId) => {
      state.agentsSelectedId = agentId;
      state.agentsPanel = "tools";
      state.tab = "agents";
      state.requestUpdate();
    },
    onClawHubQueryChange: (query) => {
      setClawHubSearchQuery(state, query);
      void searchClawHub(state, query.trim());
    },
    onClawHubTargetChange: (target) => setClawHubInstallTarget(state, target),
    onClawHubDetailOpen: (slug) => void loadClawHubDetail(state, slug),
    onClawHubDetailClose: () => closeClawHubDetail(state),
    onClawHubInstall: (slug) => void installFromClawHub(state, slug),
    onClawHubUpdatePreview: (slug) => void previewClawHubUpdate(state, slug),
    onClawHubReviewClose: () => closeClawHubReview(state),
    onClawHubReviewConfirm: () => void confirmClawHubMarketplaceReview(state),
  };
}

async function saveSkillRootConfigFromUi(
  state: AppViewState,
  skillKey: string,
  path: string,
  json: string,
) {
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    const segments = path
      .split(".")
      .map((part) => part.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      throw new Error("Config path is empty.");
    }
    const parsed = json.trim() ? JSON.parse(json) : {};
    updateConfigFormValue(state, segments, parsed);
    await saveConfig(state);
    if (state.lastError) {
      throw new Error(state.lastError);
    }
    state.skillMessages = {
      ...state.skillMessages,
      [skillKey]: {
        kind: "success",
        message: `Saved ${path} in gateway config.`,
      },
    };
    await loadSkills(state);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.skillsError = message;
    state.skillMessages = {
      ...state.skillMessages,
      [skillKey]: { kind: "error", message },
    };
  } finally {
    state.skillsBusyKey = null;
    state.requestUpdate();
  }
}

function resolveChatScheduleAgentId(state: AppViewState): string {
  const fromDraft = state.chatScheduleDraft.agentId?.trim();
  if (fromDraft) {
    return fromDraft;
  }
  const parsed = parseAgentSessionKey(state.sessionKey);
  const fromSession = parsed?.agentId?.trim();
  if (fromSession) {
    return fromSession;
  }
  const selected = state.agentsSelectedId?.trim();
  if (selected) {
    return selected;
  }
  return state.agentsList?.defaultId?.trim() || "main";
}

function resolveChatScheduleSessionKey(state: AppViewState, agentId: string): string {
  const selectedAgentId = agentId.trim() || resolveChatScheduleAgentId(state);
  const parsed = parseAgentSessionKey(state.sessionKey);
  if (!parsed || !parsed.rest) {
    return `agent:${selectedAgentId}:${state.agentsList?.mainKey?.trim() || "main"}`;
  }
  if (parsed.agentId === selectedAgentId) {
    return state.sessionKey;
  }
  return `agent:${selectedAgentId}:${parsed.rest}`;
}

function resolveChatScheduleDelivery(state: AppViewState) {
  const active = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  const context = active?.deliveryContext ?? active?.origin ?? {};
  const channel =
    context.channel?.trim() ||
    active?.lastChannel?.trim() ||
    active?.channel?.trim() ||
    active?.groupChannel?.trim() ||
    "";
  if (!channel || channel === "webchat" || channel === "local") {
    return null;
  }
  const to = context.to?.trim() || active?.lastTo?.trim() || undefined;
  const accountId = context.accountId?.trim() || active?.lastAccountId?.trim() || undefined;
  return {
    label: channel,
    delivery: {
      mode: "announce" as const,
      channel,
      to,
      accountId,
      bestEffort: true,
    },
  };
}

function openChatScheduleTask(state: AppViewState) {
  const delivery = resolveChatScheduleDelivery(state);
  state.chatScheduleDraft = createChatScheduleDraft(state.chatMessage, {
    agentId: resolveChatScheduleAgentId(state),
    deliveryMode: delivery ? "channel" : "local",
  });
}

function switchChatSessionForTaskEdit(state: AppViewState, sessionKey: string) {
  const next = sessionKey.trim();
  if (!next || state.sessionKey === next) {
    return;
  }
  state.sessionKey = next;
  state.chatMessage = "";
  state.chatAttachments = [];
  state.chatTranscriptSearch = "";
  state.chatStream = null;
  state.chatStreamStartedAt = null;
  state.chatRunId = null;
  state.chatQueue = [];
  state.resetToolStream();
  state.resetChatScroll();
  state.applySettings({
    ...state.settings,
    sessionKey: next,
    lastActiveSessionKey: next,
  });
  void state.loadAssistantIdentity();
  void subscribeActiveSessionMessages(state);
  void loadChatHistory(state);
  void loadCurrentChatSessionUsage(state);
  void refreshChatAvatar(state);
}

function setRouteHash(hash?: string) {
  if (typeof window === "undefined" || !hash) {
    return;
  }
  window.location.hash = hash;
  window.requestAnimationFrame(() => {
    document.getElementById(hash)?.scrollIntoView({ block: "center" });
  });
}

function openTaskRunTranscript(state: AppViewState, sessionKey: string, hash?: string) {
  const next = sessionKey.trim();
  if (!next) {
    return;
  }
  switchChatSessionForTaskEdit(state, next);
  const suffix = hash ? `#${hash}` : "";
  window.history.pushState(
    {},
    "",
    `${state.basePath}/chat?session=${encodeURIComponent(next)}${suffix}`,
  );
  state.tab = "chat";
}

export function openTaskLedgerSourceSurface(state: AppViewState, task: TaskRecord) {
  const route = resolveTaskLedgerSourceRoute(task);
  if (route.sessionKey) {
    openTaskRunTranscript(state, route.sessionKey, route.hash);
    return;
  }
  if (route.taskLedgerSourceFilter) {
    state.setTaskLedgerSourceFilter(route.taskLedgerSourceFilter);
  }
  if (route.walletMainPanel) {
    state.walletMainPanel = route.walletMainPanel;
  }
  if (route.walletApprovalsFilter) {
    state.walletApprovalsFilter = route.walletApprovalsFilter;
  }
  if (route.channelsView) {
    state.channelsView = route.channelsView;
  }
  if (route.agentsPanel) {
    state.agentsPanel = route.agentsPanel;
  }
  if (route.miningActivityFilter) {
    state.miningActivityFilter = route.miningActivityFilter;
  }
  if (route.miningActivityWindow) {
    state.miningActivityWindow = route.miningActivityWindow;
  }
  state.setTab(route.tab);
  setRouteHash(route.hash);
  if (route.loadChannels) {
    void loadChannels(state, false);
  }
  if (route.loadCron) {
    void state.loadCron();
  }
}

function openChatTaskEditor(state: AppViewState, job: CronJob) {
  if (job.sessionKey) {
    switchChatSessionForTaskEdit(state, job.sessionKey);
  }
  state.chatScheduleDraft = createChatScheduleDraftFromJob(job);
  state.tab = "chat";
}

function openAgentTaskCreate(state: AppViewState, agentId: string) {
  void loadAgentSkills(state, agentId);
  state.agentTaskEditingJobId = null;
  state.agentTaskForm = {
    ...DEFAULT_CRON_FORM,
    name: "Agent task",
    agentId,
    clearAgent: false,
    deleteAfterRun: false,
    sessionTarget: "isolated",
    wakeMode: "now",
    payloadKind: "agentTurn",
    deliveryMode: "none",
    deliveryChannel: "last",
  };
  state.agentTaskFieldErrors = {};
  state.agentTaskError = null;
  state.agentTaskDialogOpen = true;
}

function openAgentTaskEditor(state: AppViewState, job: CronJob) {
  if (job.agentId) {
    void loadAgentSkills(state, job.agentId);
  }
  state.agentTaskEditingJobId = job.id;
  state.agentTaskForm = cronJobToForm(job, {
    ...DEFAULT_CRON_FORM,
    agentId: job.agentId ?? "",
  });
  state.agentTaskFieldErrors = {};
  state.agentTaskError = null;
  state.agentTaskDialogOpen = true;
}

function openGlobalTaskCreate(state: AppViewState) {
  const defaultAgentId = state.agentsList?.defaultId ?? state.agentsList?.mainKey ?? "main";
  openAgentTaskCreate(state, defaultAgentId);
}

function openMiningAomStrategyTask(state: AppViewState) {
  const defaultAgentId = state.agentsList?.defaultId ?? state.agentsList?.mainKey ?? "main";
  openAgentTaskCreate(state, defaultAgentId);
  patchAgentTaskForm(state, buildCronTaskTemplatePatch("aom-strategy"));
}

function closeAgentTaskDialog(state: AppViewState) {
  state.agentTaskDialogOpen = false;
  state.agentTaskEditingJobId = null;
  state.agentTaskFieldErrors = {};
  state.agentTaskError = null;
}

function patchAgentTaskForm(state: AppViewState, patch: Partial<CronFormState>) {
  state.agentTaskForm = { ...state.agentTaskForm, ...patch };
  state.agentTaskFieldErrors = validateCronForm(state.agentTaskForm);
  state.agentTaskError = null;
}

function normalizeCatalogModelValue(entry: ModelCatalogEntry): string {
  return buildChatModelOption(entry).value;
}

function modelLabelForTask(value: string, catalog: ModelCatalogEntry[]): string {
  const match = catalog.find((entry) => normalizeCatalogModelValue(entry) === value);
  if (match) {
    const option = buildChatModelOption(match);
    return option.label;
  }
  return formatChatModelDisplay(value) || value;
}

function resolveAgentTaskAgentId(state: AppViewState, agentId: string | undefined): string {
  const normalized = agentId?.trim();
  return normalized || state.agentsList?.defaultId || state.agentsList?.mainKey || "main";
}

function resolveAgentTaskConfigSource(state: AppViewState, agentId: string) {
  const resolvedAgentId = resolveAgentTaskAgentId(state, agentId);
  const snapshotConfig = state.configSnapshot?.config as Record<string, unknown> | null;
  const sources = [state.configForm, snapshotConfig].filter(
    (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"),
  );
  const resolvedConfigs = sources.map((source) => resolveAgentConfig(source, resolvedAgentId));
  const entryConfig = resolvedConfigs.find((config) => config.entry);
  if (entryConfig) {
    return entryConfig;
  }
  const defaultsConfig = resolvedConfigs.find((config) => config.defaults);
  if (defaultsConfig) {
    return defaultsConfig;
  }
  return resolveAgentConfig(sources[0] ?? null, resolvedAgentId);
}

function agentTaskModelChoices(state: AppViewState, agentId: string) {
  const resolvedAgentId = resolveAgentTaskAgentId(state, agentId);
  const agent = state.agentsList?.agents?.find((entry) => entry.id === resolvedAgentId);
  const config = resolveAgentTaskConfigSource(state, resolvedAgentId);
  const modelProviders = resolveAgentModelProviders(config.entry?.modelProviders);
  const activeProvider = normalizeModelProviderId(config.entry?.activeModelProvider) ?? "";
  const activeProviderConfig = activeProvider ? (modelProviders[activeProvider] ?? {}) : {};
  const providerModels = Object.values(modelProviders).flatMap((providerConfig) => [
    providerConfig.primary,
    ...(providerConfig.fallbacks ?? []),
    ...Object.values(providerConfig.taskModels ?? {}),
  ]);
  const primary =
    resolveModelPrimary(config.entry?.model) ??
    resolveModelPrimary(config.defaults?.model) ??
    resolveModelPrimary(agent?.model) ??
    activeProviderConfig.primary;
  const fallbacks =
    resolveModelFallbacks(config.entry?.model) ??
    resolveModelFallbacks(config.defaults?.model) ??
    resolveModelFallbacks(agent?.model) ??
    activeProviderConfig.fallbacks ??
    [];
  const taskModels = [
    ...Object.values(resolveTaskModelSlots(config.defaults?.taskModels) ?? {}),
    ...Object.values(resolveTaskModelSlots(config.entry?.taskModels) ?? {}),
  ];
  return Array.from(
    new Set(
      [primary, ...fallbacks, ...taskModels, ...providerModels].filter((entry): entry is string =>
        Boolean(entry?.trim()),
      ),
    ),
  ).map((value) => ({
    value,
    label: modelLabelForTask(value, state.chatModelCatalog ?? []),
  }));
}

type AgentTaskModelDefaults = {
  main?: string;
  cheapCheck?: string;
  strong?: string;
  escalation?: string;
};

function agentTaskModelDefaults(state: AppViewState, agentId: string): AgentTaskModelDefaults {
  const resolvedAgentId = resolveAgentTaskAgentId(state, agentId);
  const agent = state.agentsList?.agents?.find((entry) => entry.id === resolvedAgentId);
  const config = resolveAgentTaskConfigSource(state, resolvedAgentId);
  const modelProviders = resolveAgentModelProviders(config.entry?.modelProviders);
  const activeProvider = normalizeModelProviderId(config.entry?.activeModelProvider) ?? "";
  const activeProviderConfig = activeProvider ? (modelProviders[activeProvider] ?? {}) : {};
  const entryTaskModels = resolveTaskModelSlots(config.entry?.taskModels) ?? {};
  const defaultTaskModels = resolveTaskModelSlots(config.defaults?.taskModels) ?? {};
  const providerTaskModels = activeProviderConfig.taskModels ?? {};
  const main =
    resolveModelPrimary(config.entry?.model) ??
    resolveModelPrimary(config.defaults?.model) ??
    resolveModelPrimary(agent?.model) ??
    activeProviderConfig.primary;
  return {
    main: main?.trim() || undefined,
    cheapCheck:
      entryTaskModels.cheapCheck ?? providerTaskModels.cheapCheck ?? defaultTaskModels.cheapCheck,
    strong: entryTaskModels.strong ?? providerTaskModels.strong ?? defaultTaskModels.strong,
    escalation:
      entryTaskModels.escalation ?? providerTaskModels.escalation ?? defaultTaskModels.escalation,
  };
}

function formatTaskModelDefaultOption(state: AppViewState, model: string | undefined): string {
  const normalized = model?.trim();
  return normalized ? modelLabelForTask(normalized, state.chatModelCatalog ?? []) : "Default";
}

function readAgentConfigEntry(state: AppViewState, agentId: string) {
  const config =
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const agents = config?.agents as { list?: unknown[] | Record<string, unknown> } | undefined;
  const list = agents?.list;
  if (Array.isArray(list)) {
    const index = list.findIndex(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        "id" in entry &&
        (entry as { id?: string }).id === agentId,
    );
    return {
      basePath: index >= 0 ? ["agents", "list", index] : null,
      index,
      entry:
        index >= 0
          ? (list[index] as {
              identity?: { avatar?: string; avatarUrl?: string };
              activeModelProvider?: unknown;
              model?: unknown;
              modelProviders?: unknown;
              skills?: unknown;
              taskModels?: unknown;
            })
          : null,
    };
  }
  if (list && typeof list === "object" && agentId in list) {
    return {
      basePath: ["agents", "list", agentId],
      index: -1,
      entry: list[agentId] as {
        identity?: { avatar?: string; avatarUrl?: string };
        activeModelProvider?: unknown;
        model?: unknown;
        modelProviders?: unknown;
        skills?: unknown;
        taskModels?: unknown;
      },
    };
  }
  return {
    basePath: null,
    index: -1,
    entry: null,
  };
}

function ensureAgentConfigEntry(state: AppViewState, agentId: string) {
  const existing = readAgentConfigEntry(state, agentId);
  if (existing.basePath) {
    return existing;
  }
  const config =
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const materialized = materializeAgentConfigList(config, agentId);
  if (!materialized) {
    return existing;
  }
  if (materialized.changed) {
    updateConfigFormValue(state, ["agents", "list"], materialized.list);
  }
  return readAgentConfigEntry(state, agentId.trim());
}

async function attachSkillToAgent(state: AppViewState, skillKey: string, agentId: string) {
  const skill = state.skillsReport?.skills.find((entry) => entry.skillKey === skillKey);
  const skillName = skill?.name?.trim() || skillKey.trim();
  const resolvedAgentId = agentId.trim() || state.agentsList?.defaultId || "main";
  if (!skillName || !resolvedAgentId) {
    return;
  }
  const { basePath, entry } = readAgentConfigEntry(state, resolvedAgentId);
  if (!basePath) {
    state.skillMessages = {
      ...state.skillMessages,
      [skillKey]: {
        kind: "error",
        message: "Load config before changing Agent skill access.",
      },
    };
    return;
  }
  const existing = Array.isArray(entry?.skills)
    ? entry.skills.map((value) => String(value).trim()).filter(Boolean)
    : null;
  if (existing === null) {
    state.agentsSelectedId = resolvedAgentId;
    state.agentsPanel = "skills";
    state.tab = "agents";
    state.skillMessages = {
      ...state.skillMessages,
      [skillKey]: {
        kind: "success",
        message: "Agent already inherits all enabled skills. Opened Agent > Skills.",
      },
    };
    return;
  }
  if (existing.includes(skillName)) {
    state.skillMessages = {
      ...state.skillMessages,
      [skillKey]: {
        kind: "success",
        message: "Skill is already allowed on this Agent.",
      },
    };
    return;
  }
  state.skillsBusyKey = skillKey;
  state.skillMessages = {
    ...state.skillMessages,
    [skillKey]: { kind: "success", message: `Allowing ${skillName} on ${resolvedAgentId}...` },
  };
  try {
    updateConfigFormValue(state, [...basePath, "skills"], [...existing, skillName]);
    await saveConfig(state);
    if (state.lastError) {
      throw new Error(state.lastError);
    }
    state.skillMessages = {
      ...state.skillMessages,
      [skillKey]: {
        kind: "success",
        message: `Allowed ${skillName} on ${resolvedAgentId}.`,
      },
    };
  } catch (err) {
    state.skillMessages = {
      ...state.skillMessages,
      [skillKey]: {
        kind: "error",
        message: String(err),
      },
    };
  } finally {
    state.skillsBusyKey = null;
  }
}

function isAccountUsable(account: ChannelAccountSnapshot): boolean {
  const probeOk =
    account.probe && typeof account.probe === "object" && "ok" in account.probe
      ? Boolean((account.probe as { ok?: unknown }).ok)
      : false;
  return Boolean(
    account.connected || account.running || probeOk || account.enabled || account.configured,
  );
}

function channelLabelForTask(state: AppViewState, channelId: string): string {
  const meta = state.channelsSnapshot?.channelMeta?.find((entry) => entry.id === channelId);
  return meta?.label || state.channelsSnapshot?.channelLabels?.[channelId] || channelId;
}

function encodeTaskChoicePart(value: string): string {
  return encodeURIComponent(value);
}

function decodeTaskChoicePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function channelDeliveryChoiceValue(channelId: string, accountId: string): string {
  return `channel:${encodeTaskChoicePart(channelId)}:${encodeTaskChoicePart(accountId)}`;
}

function agentTaskDeliveryValue(form: CronFormState): string {
  if (form.deliveryMode === "webhook") {
    return "webhook";
  }
  if (form.deliveryMode === "announce") {
    return channelDeliveryChoiceValue(
      form.deliveryChannel.trim() || "last",
      form.deliveryAccountId.trim(),
    );
  }
  return "none";
}

function agentTaskDeliveryChoices(state: AppViewState, form: CronFormState) {
  const choices: Array<{ value: string; label: string; detail?: string }> = [
    { value: "none", label: "No delivery" },
    { value: "webhook", label: "Webhook" },
  ];
  const snapshot = state.channelsSnapshot;
  const added = new Set(choices.map((choice) => choice.value));
  if (snapshot) {
    const ids = new Set<string>([
      ...(snapshot.channelOrder ?? []),
      ...(snapshot.channelMeta?.map((entry) => entry.id) ?? []),
      ...Object.keys(snapshot.channelAccounts ?? {}),
    ]);
    for (const channelId of ids) {
      const accounts = snapshot.channelAccounts?.[channelId] ?? [];
      for (const account of accounts) {
        if (!isAccountUsable(account)) {
          continue;
        }
        const accountId = account.accountId?.trim() || "";
        const value = channelDeliveryChoiceValue(channelId, accountId);
        if (added.has(value)) {
          continue;
        }
        added.add(value);
        const channelLabel = channelLabelForTask(state, channelId);
        const accountLabel = account.name?.trim() || accountId || "default";
        choices.push({
          value,
          label: `${channelLabel} · ${accountLabel}`,
          detail: accountId,
        });
      }
    }
  }
  const currentValue = agentTaskDeliveryValue(form);
  if (!added.has(currentValue) && form.deliveryMode === "announce") {
    choices.push({
      value: currentValue,
      label: `${channelLabelForTask(state, form.deliveryChannel)} · current account`,
      detail: form.deliveryAccountId,
    });
  }
  return choices;
}

function patchAgentTaskDeliveryChoice(
  patch: (next: Partial<CronFormState>) => void,
  value: string,
) {
  if (value === "none") {
    patch({ deliveryMode: "none", deliveryChannel: "last", deliveryAccountId: "", deliveryTo: "" });
    return;
  }
  if (value === "webhook") {
    patch({ deliveryMode: "webhook", deliveryChannel: "last", deliveryAccountId: "" });
    return;
  }
  const match = value.match(/^channel:([^:]*):(.*)$/);
  if (!match) {
    patch({ deliveryMode: "none" });
    return;
  }
  const channel = decodeTaskChoicePart(match[1] ?? "");
  const accountId = decodeTaskChoicePart(match[2] ?? "");
  patch({
    deliveryMode: "announce",
    deliveryChannel: channel || "last",
    deliveryAccountId: accountId,
    deliveryTo: "",
  });
}

function openAgentChannelsForTask(state: AppViewState) {
  closeAgentTaskDialog(state);
  state.tab = "agents";
  state.agentsPanel = "channels";
}

function agentTaskSkillOptions(state: AppViewState, agentId: string) {
  if (state.agentSkillsAgentId !== agentId || !state.agentSkillsReport?.skills) {
    return [];
  }
  return state.agentSkillsReport.skills
    .map((skill) => {
      const record = skill as {
        skillKey?: string;
        name?: string;
        description?: string;
        disabled?: boolean;
      };
      const id = record.skillKey?.trim() || record.name?.trim() || "";
      return {
        id,
        label: record.name?.trim() || id,
        description: record.description?.trim() || "",
        disabled: record.disabled === true,
      };
    })
    .filter((entry) => entry.id && !entry.disabled)
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

function agentTaskAgentChoices(state: AppViewState) {
  const agents = state.agentsList?.agents ?? [];
  if (agents.length > 0) {
    return agents.map((agent) => ({
      id: agent.id,
      label: formatAgentDisplayLabel(agent),
    }));
  }
  return [{ id: "main", label: "Assistant" }];
}

function csvValues(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function appendAgentTaskSkill(
  state: AppViewState,
  patch: (next: Partial<CronFormState>) => void,
  skillId: string,
) {
  const next = Array.from(
    new Set([...csvValues(state.agentTaskForm.allowedSkills), skillId.trim()].filter(Boolean)),
  );
  patch({ allowedSkills: next.join(", "), skillScope: "selected" });
}

function removeAgentTaskSkill(
  form: CronFormState,
  patch: (next: Partial<CronFormState>) => void,
  skillId: string,
) {
  const next = csvValues(form.allowedSkills).filter((entry) => entry !== skillId);
  patch({ allowedSkills: next.join(", ") });
}

function formatTaskSkillLabel(
  skillId: string,
  skillOptions: Array<{ id: string; label: string; description: string; disabled: boolean }>,
) {
  return skillOptions.find((skill) => skill.id === skillId)?.label ?? skillId;
}

function inheritedAgentTaskSkillIds(
  state: AppViewState,
  form: CronFormState,
  skillOptions: Array<{ id: string; label: string; description: string; disabled: boolean }>,
) {
  const config = resolveAgentTaskConfigSource(state, form.agentId || "main");
  if (Array.isArray(config.entry?.skills)) {
    return config.entry.skills.map((skill) => skill.trim()).filter(Boolean);
  }
  return skillOptions.map((skill) => skill.id);
}

function renderAgentTaskSkillSummary(params: {
  state: AppViewState;
  form: CronFormState;
  patch: (next: Partial<CronFormState>) => void;
  skillOptions: Array<{ id: string; label: string; description: string; disabled: boolean }>;
  selectedSkills: string[];
}) {
  const inheritedSkills = inheritedAgentTaskSkillIds(
    params.state,
    params.form,
    params.skillOptions,
  );
  const inheritedLoaded = params.state.agentSkillsAgentId === (params.form.agentId || "main");
  const inheritedLabel =
    inheritedSkills.length === 0
      ? "No Agent skills"
      : inheritedSkills.length === params.skillOptions.length
        ? `All Agent skills (${inheritedSkills.length})`
        : `${inheritedSkills.length} Agent skills`;
  const inheritedPreview = inheritedSkills.slice(0, 8);
  const hiddenInheritedCount = Math.max(0, inheritedSkills.length - inheritedPreview.length);

  if (params.form.skillScope === "none") {
    return html`
      <div class="agent-task-dialog__skill-summary" data-state="none">
        <div>
          <strong>No skills for this task</strong>
          <span>The task will not receive skill instructions or skill tools.</span>
        </div>
        <button
          class="btn btn--sm"
          type="button"
          @click=${() => params.patch({ skillScope: "agent-default", allowedSkills: "" })}
        >
          Use Agent skills
        </button>
      </div>
    `;
  }

  if (params.form.skillScope === "selected") {
    return html`
      <div class="agent-task-dialog__skill-summary" data-state="selected">
        <div>
          <strong>Narrowed for this task</strong>
          <span>
            Only selected skills are exposed. Agent default stays unchanged.
          </span>
        </div>
        <button
          class="btn btn--sm"
          type="button"
          @click=${() => params.patch({ skillScope: "agent-default", allowedSkills: "" })}
        >
          Use Agent inherited
        </button>
      </div>
      ${
        params.selectedSkills.length > 0
          ? html`
              <div class="agent-task-dialog__chips" aria-label="Selected task skills">
                ${params.selectedSkills.map(
                  (skill) => html`
                    <button
                      class="chip agent-task-dialog__skill-chip"
                      type="button"
                      title=${`Remove ${skill}`}
                      @click=${() => removeAgentTaskSkill(params.form, params.patch, skill)}
                    >
                      ${formatTaskSkillLabel(skill, params.skillOptions)}
                      <span aria-hidden="true">x</span>
                    </button>
                  `,
                )}
              </div>
            `
          : nothing
      }
    `;
  }

  return html`
    <div class="agent-task-dialog__skill-summary" data-state="inherited">
      <div>
        <strong>Inherited from Agent</strong>
        <span>
          ${
            params.state.agentSkillsLoading && !inheritedLoaded
              ? "Loading Agent skills..."
              : inheritedLabel
          }
        </span>
      </div>
      <button
        class="btn btn--sm"
        type="button"
        @click=${() => params.patch({ skillScope: "selected", allowedSkills: "" })}
      >
        Narrow selected skills
      </button>
    </div>
    ${
      inheritedPreview.length > 0
        ? html`
            <div class="agent-task-dialog__chips" aria-label="Inherited Agent skills">
              ${inheritedPreview.map(
                (skill) => html`
                  <span class="chip" title=${skill}>
                    ${formatTaskSkillLabel(skill, params.skillOptions)}
                  </span>
                `,
              )}
              ${
                hiddenInheritedCount > 0
                  ? html`<span class="chip">+${hiddenInheritedCount}</span>`
                  : nothing
              }
            </div>
          `
        : nothing
    }
  `;
}

function toggleAgentTaskCoordinationAgent(
  form: CronFormState,
  patch: (next: Partial<CronFormState>) => void,
  agentId: string,
) {
  const selected = new Set(csvValues(form.coordinationAgents));
  if (selected.has(agentId)) {
    selected.delete(agentId);
  } else {
    selected.add(agentId);
  }
  const agents = Array.from(selected);
  patch({
    coordinationAgents: agents.join(", "),
    coordinationMode:
      agents.length > 0 && form.coordinationMode === "none" ? "consult" : form.coordinationMode,
  });
}

async function submitAgentTaskDialog(state: AppViewState) {
  if (!state.client || !state.connected || state.agentTaskBusy) {
    state.agentTaskError = "Disconnected from gateway.";
    return;
  }
  state.agentTaskBusy = true;
  state.agentTaskError = null;
  try {
    const form = normalizeCronFormState(state.agentTaskForm);
    if (form !== state.agentTaskForm) {
      state.agentTaskForm = form;
    }
    state.agentTaskFieldErrors = validateCronForm(form);
    if (Object.keys(state.agentTaskFieldErrors).length > 0) {
      return;
    }
    const editingJob = state.agentTaskEditingJobId
      ? state.cronJobs.find((job) => job.id === state.agentTaskEditingJobId)
      : undefined;
    const deliveryAccountId = form.deliveryAccountId.trim();
    const selectedDeliveryMode = form.deliveryMode;
    const delivery =
      selectedDeliveryMode && selectedDeliveryMode !== "none"
        ? selectedDeliveryMode === "webhook"
          ? {
              mode: "webhook" as const,
              to: form.deliveryTo.trim(),
              bestEffort: form.deliveryBestEffort,
            }
          : {
              mode: "announce" as const,
              channel: form.deliveryChannel.trim() || "last",
              to: form.deliveryTo.trim() || undefined,
              accountId: deliveryAccountId || undefined,
              bestEffort: form.deliveryBestEffort,
            }
        : selectedDeliveryMode === "none"
          ? ({ mode: "none" } as const)
          : undefined;
    const sessionKeyRaw = form.sessionKey.trim();
    const patch = {
      name: form.name.trim(),
      description: form.description.trim(),
      agentId: form.agentId.trim() || undefined,
      sessionKey: sessionKeyRaw || (editingJob?.sessionKey ? null : undefined),
      enabled: form.enabled,
      deleteAfterRun: form.deleteAfterRun,
      schedule: buildCronSchedule(form),
      sessionTarget: form.sessionTarget === "main" ? "main" : "isolated",
      wakeMode: form.wakeMode,
      payload: buildCronPayload(form),
      delivery,
      executionPolicy: buildCronExecutionPolicy(form),
    };
    if (state.agentTaskEditingJobId) {
      await state.client.request("cron.update", {
        id: state.agentTaskEditingJobId,
        patch,
      });
    } else {
      await state.client.request("cron.add", patch);
    }
    state.agentTaskDialogOpen = false;
    state.agentTaskEditingJobId = null;
    await state.loadCron();
    await loadSessions(state);
  } catch (err) {
    state.agentTaskError = String(err);
  } finally {
    state.agentTaskBusy = false;
  }
}

function agentTaskFieldError(state: AppViewState, key: keyof CronFormState) {
  const message = (state.agentTaskFieldErrors as Record<string, string | undefined>)[key];
  if (!message) {
    return nothing;
  }
  const friendly =
    key === "name"
      ? "Name is required."
      : key === "payloadText"
        ? "Prompt is required."
        : key === "everyAmount"
          ? "Interval must be greater than 0."
          : key === "scheduleAt"
            ? "Run time is invalid."
            : key === "cronExpr"
              ? "Advanced schedule is required."
              : message;
  return html`<div class="agent-task-dialog__field-error">${friendly}</div>`;
}

function renderAgentTaskDialog(state: AppViewState) {
  if (!state.agentTaskDialogOpen) {
    return nothing;
  }
  const form = state.agentTaskForm;
  const editing = Boolean(state.agentTaskEditingJobId);
  const patch = (next: Partial<CronFormState>) => patchAgentTaskForm(state, next);
  const modelChoices = agentTaskModelChoices(state, form.agentId);
  const modelDefaults = agentTaskModelDefaults(state, form.agentId);
  const cheapModelDefaultLabel = formatTaskModelDefaultOption(
    state,
    modelDefaults.cheapCheck ?? modelDefaults.main,
  );
  const escalationModelDefaultLabel = formatTaskModelDefaultOption(
    state,
    modelDefaults.escalation ?? modelDefaults.strong,
  );
  const deliveryChoices = agentTaskDeliveryChoices(state, form);
  const hasChannelDelivery = deliveryChoices.some((choice) => choice.value.startsWith("channel:"));
  const selectedDeliveryValue = agentTaskDeliveryValue(form);
  const skillOptions = agentTaskSkillOptions(state, form.agentId);
  const selectedSkills = csvValues(form.allowedSkills);
  const agentChoices = agentTaskAgentChoices(state);
  const showAgentChoice = state.tab === "cron";
  return html`
    <div
      class="agent-task-dialog"
      role="dialog"
      aria-modal="true"
      aria-label=${editing ? "Edit task" : "Create task"}
      @click=${(event: Event) => {
        if (event.target === event.currentTarget) {
          closeAgentTaskDialog(state);
        }
      }}
    >
      <style>
        .agent-task-dialog {
          align-items: center;
          background: rgb(0 0 0 / 58%);
          box-sizing: border-box;
          color: var(--text);
          display: flex;
          inset: 0;
          justify-content: center;
          overflow: auto;
          padding: 24px;
          position: fixed;
          z-index: 10000;
        }
        .agent-task-dialog__panel {
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 10px;
          box-shadow: 0 24px 80px rgb(0 0 0 / 38%);
          box-sizing: border-box;
          display: grid;
          gap: 14px;
          max-height: min(820px, calc(100dvh - 48px));
          overflow: auto;
          padding: 16px;
          width: min(860px, calc(100vw - 32px));
        }
        .agent-task-dialog__head,
        .agent-task-dialog__actions {
          align-items: flex-start;
          display: flex;
          gap: 12px;
          justify-content: space-between;
        }
        .agent-task-dialog__actions {
          align-items: center;
          border-top: 1px solid var(--border);
          padding-top: 12px;
        }
        .agent-task-dialog__title {
          align-items: center;
          color: var(--text-strong);
          display: inline-flex;
          font-size: 16px;
          font-weight: 750;
          gap: 8px;
        }
        .agent-task-dialog__title svg,
        .agent-task-dialog__close svg {
          fill: none;
          height: 15px;
          stroke: currentColor;
          width: 16px;
        }
        .agent-task-dialog__meta,
        .agent-task-dialog__field-error {
          color: var(--muted);
          font-size: 12px;
        }
        .agent-task-dialog__field-error {
          color: var(--danger);
          margin-top: 4px;
        }
        .agent-task-dialog__grid {
          display: grid;
          gap: 12px;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .agent-task-dialog .field,
        .agent-task-dialog .field input,
        .agent-task-dialog .field select,
        .agent-task-dialog .field textarea {
          box-sizing: border-box;
          min-width: 0;
          max-width: 100%;
          width: 100%;
        }
        .agent-task-dialog__model-select {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .agent-task-dialog__notice {
          align-items: center;
          background: color-mix(in srgb, var(--surface) 70%, transparent);
          border: 1px solid var(--border);
          border-radius: 8px;
          display: flex;
          gap: 10px;
          justify-content: space-between;
          padding: 10px 12px;
        }
        .agent-task-dialog__inline {
          display: grid;
          gap: 10px;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        }
        .agent-task-dialog__chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 6px;
        }
        .agent-task-dialog__grid > .agent-task-dialog__chips,
        .agent-task-dialog__grid > .agent-task-dialog__meta {
          grid-column: 1 / -1;
        }
        .agent-task-dialog__skill-summary {
          align-items: center;
          background: color-mix(in srgb, var(--surface) 70%, transparent);
          border: 1px solid var(--border);
          border-radius: 8px;
          display: flex;
          gap: 12px;
          grid-column: 1 / -1;
          justify-content: space-between;
          padding: 10px 12px;
        }
        .agent-task-dialog__skill-summary > div {
          display: grid;
          gap: 3px;
          min-width: 0;
        }
        .agent-task-dialog__skill-summary strong {
          color: var(--text-strong);
          font-size: 13px;
        }
        .agent-task-dialog__skill-summary span {
          color: var(--muted);
          font-size: 12px;
        }
        .agent-task-dialog__skill-summary[data-state="selected"] {
          border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
        }
        .agent-task-dialog__skill-chip {
          cursor: pointer;
          gap: 6px;
        }
        .agent-task-dialog__skill-chip span {
          color: var(--muted);
          font-size: 11px;
          line-height: 1;
        }
        .agent-task-dialog__coordination {
          border: 1px solid var(--border);
          border-radius: 8px;
          display: grid;
          gap: 10px;
          grid-column: 1 / -1;
          padding: 10px;
        }
        .agent-task-dialog__coordination-head {
          align-items: flex-start;
          display: flex;
          gap: 10px;
          justify-content: space-between;
        }
        .agent-task-dialog__coordination-head > select {
          flex: 0 0 auto;
          max-width: 180px;
          min-width: 110px;
          width: auto;
        }
        .agent-task-dialog__coordination-agents {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .agent-task-dialog__coordination-agents .btn {
          border-radius: 999px;
        }
        .agent-task-dialog__presets {
          align-items: center;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .agent-task-dialog__presets-label {
          color: var(--muted);
          font-size: 12px;
          font-weight: 700;
          margin-right: 2px;
        }
        .agent-task-dialog textarea {
          min-height: 110px;
          resize: vertical;
        }
        .agent-task-dialog__close {
          align-items: center;
          background: transparent;
          border: 0;
          border-radius: var(--radius-full);
          color: var(--muted);
          cursor: pointer;
          display: inline-flex;
          height: 30px;
          justify-content: center;
          padding: 0;
          width: 30px;
        }
        .agent-task-dialog__close:hover,
        .agent-task-dialog__close:focus-visible {
          background: var(--secondary);
          color: var(--text);
          outline: none;
        }
        @media (max-width: 720px) {
          .agent-task-dialog__grid,
          .agent-task-dialog__inline {
            grid-template-columns: 1fr;
          }
          .agent-task-dialog__notice {
            align-items: stretch;
            flex-direction: column;
          }
          .agent-task-dialog__head,
          .agent-task-dialog__actions {
            align-items: stretch;
            flex-direction: column;
          }
        }
      </style>
      <form
        class="agent-task-dialog__panel"
        @submit=${(event: Event) => {
          event.preventDefault();
          void submitAgentTaskDialog(state);
        }}
      >
        <div class="agent-task-dialog__head">
          <div>
            <div class="agent-task-dialog__title">
              ${icons.listChecks} ${editing ? "Edit task" : "Create task"}
            </div>
          </div>
          <button
            class="agent-task-dialog__close"
            type="button"
            title="Close task editor"
            aria-label="Close task editor"
            @click=${() => closeAgentTaskDialog(state)}
          >
            ${icons.x}
          </button>
        </div>

        ${state.agentTaskError ? html`<div class="callout danger">${state.agentTaskError}</div>` : nothing}

        <label class="field">
          <span>Name</span>
          <input
            data-test-id="agent-task-name"
            .value=${form.name}
            @input=${(event: Event) => patch({ name: (event.target as HTMLInputElement).value })}
            placeholder="Agent task"
          />
          ${agentTaskFieldError(state, "name")}
        </label>

        <label class="field">
          <span>Prompt</span>
          <textarea
            data-test-id="agent-task-prompt"
            .value=${form.payloadText}
            @input=${(event: Event) =>
              patch({ payloadText: (event.target as HTMLTextAreaElement).value })}
            placeholder="What should this Agent do when the task runs?"
          ></textarea>
          ${agentTaskFieldError(state, "payloadText")}
        </label>

        <div class="agent-task-dialog__grid">
          ${
            showAgentChoice
              ? html`
                  <label class="field">
                    <span>Agent</span>
                    <select
                      data-test-id="agent-task-agent"
                      .value=${form.agentId || "main"}
                      @change=${(event: Event) => {
                        const agentId = (event.target as HTMLSelectElement).value;
                        patch({ agentId });
                        void loadAgentSkills(state, agentId);
                      }}
                    >
                      ${agentChoices.map(
                        (agent) => html`<option value=${agent.id}>${agent.label}</option>`,
                      )}
                    </select>
                  </label>
                `
              : nothing
          }
          <label class="field">
            <span>Objective</span>
            <input
              data-test-id="agent-task-objective"
              .value=${form.taskObjective}
              @input=${(event: Event) =>
                patch({ taskObjective: (event.target as HTMLInputElement).value })}
              placeholder="What outcome should this task drive?"
            />
          </label>
          <label class="field">
            <span>Success</span>
            <input
              data-test-id="agent-task-success"
              .value=${form.taskSuccessCriteria}
              @input=${(event: Event) =>
                patch({ taskSuccessCriteria: (event.target as HTMLInputElement).value })}
              placeholder="How should the task know it is done?"
            />
          </label>
        </div>

        <div class="agent-task-dialog__grid">
          <label class="field">
            <span>Schedule</span>
            <select
              data-test-id="agent-task-schedule-kind"
              .value=${form.scheduleKind}
              @change=${(event: Event) =>
                patch({
                  scheduleKind: (event.target as HTMLSelectElement)
                    .value as CronFormState["scheduleKind"],
                })}
            >
              <option value="every">Every</option>
              <option value="at">At</option>
              <option value="cron">Advanced</option>
            </select>
          </label>
          ${
            form.scheduleKind === "every"
              ? html`
                  <div class="agent-task-dialog__inline">
                    <label class="field">
                      <span>Interval</span>
                      <input
                        data-test-id="agent-task-every-amount"
                        inputmode="numeric"
                        .value=${form.everyAmount}
                        @input=${(event: Event) =>
                          patch({ everyAmount: (event.target as HTMLInputElement).value })}
                      />
                      ${agentTaskFieldError(state, "everyAmount")}
                    </label>
                    <label class="field">
                      <span>Unit</span>
                      <select
                        data-test-id="agent-task-every-unit"
                        .value=${form.everyUnit}
                        @change=${(event: Event) =>
                          patch({
                            everyUnit: (event.target as HTMLSelectElement)
                              .value as CronFormState["everyUnit"],
                          })}
                      >
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                        <option value="days">days</option>
                      </select>
                    </label>
                  </div>
                `
              : form.scheduleKind === "at"
                ? html`
                    <label class="field">
                      <span>Run at</span>
                      <input
                        data-test-id="agent-task-at"
                        type="datetime-local"
                        .value=${form.scheduleAt}
                        @input=${(event: Event) =>
                          patch({ scheduleAt: (event.target as HTMLInputElement).value })}
                      />
                      ${agentTaskFieldError(state, "scheduleAt")}
                    </label>
                  `
                : html`
                    <label class="field">
                      <span>Advanced schedule</span>
                      <input
                        data-test-id="agent-task-cron-expr"
                        .value=${form.cronExpr}
                        @input=${(event: Event) =>
                          patch({ cronExpr: (event.target as HTMLInputElement).value })}
                        placeholder="0 9 * * *"
                      />
                      ${agentTaskFieldError(state, "cronExpr")}
                    </label>
                  `
          }
        </div>

        <div class="agent-task-dialog__grid">
          <label class="field">
            <span>Session</span>
            <select
              data-test-id="agent-task-session-target"
              .value=${form.sessionTarget}
              @change=${(event: Event) =>
                patch({
                  sessionTarget: (event.target as HTMLSelectElement)
                    .value as CronFormState["sessionTarget"],
                })}
            >
              <option value="isolated">New task session</option>
              <option value="main">Main Agent session</option>
            </select>
          </label>
          <label class="field">
            <span>Delivery target</span>
            <select
              data-test-id="agent-task-delivery"
              .value=${selectedDeliveryValue}
              @change=${(event: Event) =>
                patchAgentTaskDeliveryChoice(patch, (event.target as HTMLSelectElement).value)}
            >
              ${deliveryChoices.map(
                (choice) => html`<option value=${choice.value}>${choice.label}</option>`,
              )}
            </select>
          </label>
          ${
            form.deliveryMode === "webhook"
              ? html`
                  <label class="field">
                    <span>Webhook URL</span>
                    <input
                      data-test-id="agent-task-delivery-to"
                      .value=${form.deliveryTo}
                      @input=${(event: Event) =>
                        patch({ deliveryTo: (event.target as HTMLInputElement).value })}
                      placeholder="https://..."
                    />
                  </label>
                `
              : form.deliveryMode === "announce"
                ? html`
                    <label class="field">
                      <span>Destination</span>
                      <input
                        data-test-id="agent-task-delivery-to"
                        .value=${form.deliveryTo}
                        @input=${(event: Event) =>
                          patch({ deliveryTo: (event.target as HTMLInputElement).value })}
                        placeholder="Optional user, room, thread, or peer id"
                      />
                    </label>
                  `
                : nothing
          }
        </div>
        ${
          hasChannelDelivery
            ? nothing
            : html`
                <div class="agent-task-dialog__notice">
                  <span>No connected channel account is available for delivery.</span>
                  <button class="btn btn--sm" type="button" @click=${() => openAgentChannelsForTask(state)}>
                    Connect channels
                  </button>
                </div>
            `
        }

        <div class="agent-task-dialog__presets" aria-label="Task policy presets">
          <span class="agent-task-dialog__presets-label">Presets</span>
          ${TASK_POLICY_PRESET_OPTIONS.map(
            (preset) => html`
              <button
                class="btn btn--xs btn--ghost"
                type="button"
                @click=${() => patch(buildTaskPolicyPresetPatch(preset.id, form))}
              >
                ${preset.label}
              </button>
            `,
          )}
        </div>

        <div class="agent-task-dialog__grid">
          <label class="field">
            <span>Execution</span>
            <select
              data-test-id="agent-task-execution"
              .value=${form.executionMode}
              @change=${(event: Event) => {
                const executionMode = (event.target as HTMLSelectElement)
                  .value as CronFormState["executionMode"];
                patch({
                  executionMode,
                  ...(executionMode === "no-model" || executionMode === "skill-only"
                    ? { plannerStrategy: "" as const }
                    : {}),
                  ...(executionMode === "skill-only" && form.skillScope === "none"
                    ? { skillScope: "agent-default" as const }
                    : {}),
                });
              }}
            >
              <option value="auto">Auto</option>
              <option value="agent-turn">Agent turn</option>
              <option value="skill-only">Skill-only</option>
              <option value="no-model">No model</option>
            </select>
          </label>
          <label class="field">
            <span>Memory</span>
            <select
              data-test-id="agent-task-memory"
              .value=${form.memoryScope}
              @change=${(event: Event) =>
                patch({
                  memoryScope: (event.target as HTMLSelectElement)
                    .value as CronFormState["memoryScope"],
                })}
            >
              <option value="session-summary">Session summary</option>
              <option value="none">None</option>
              <option value="pinned">Pinned</option>
              <option value="search">Search</option>
              <option value="agent">Agent</option>
            </select>
          </label>
          <label class="field">
            <span>Skill access</span>
            <select
              data-test-id="agent-task-skills"
              .value=${form.skillScope}
              @change=${(event: Event) =>
                patch({
                  skillScope: (event.target as HTMLSelectElement)
                    .value as CronFormState["skillScope"],
                })}
            >
              <option value="agent-default">Inherited from Agent</option>
              <option value="selected">Narrow selected skills</option>
              <option value="none">No skills</option>
            </select>
          </label>
          <label class="field">
            <span>Add selected skill</span>
            <select
              data-test-id="agent-task-skill-add"
              .value=${""}
              ?disabled=${form.skillScope !== "selected"}
              @change=${(event: Event) => {
                const select = event.target as HTMLSelectElement;
                appendAgentTaskSkill(state, patch, select.value);
                select.value = "";
              }}
            >
              <option value="">Choose Agent skill</option>
              ${skillOptions.map(
                (skill) => html`<option value=${skill.id}>${skill.label}</option>`,
              )}
            </select>
          </label>
          ${renderAgentTaskSkillSummary({ state, form, patch, skillOptions, selectedSkills })}
          ${
            form.executionMode === "skill-only"
              ? html`
                  <label class="field">
                    <span>Skill tool</span>
                    <input
                      data-test-id="agent-task-skill-tool"
                      list="agent-task-skill-tool-options"
                      .value=${form.skillToolName}
                      @input=${(event: Event) => {
                        const skillToolName = (event.target as HTMLInputElement).value;
                        patch({
                          skillToolName,
                          ...(skillToolName.trim() &&
                          form.skillScope === "selected" &&
                          !form.allowedSkills.trim()
                            ? { allowedSkills: skillToolName.trim() }
                            : {}),
                        });
                      }}
                      placeholder="wallet"
                    />
                    <datalist id="agent-task-skill-tool-options">
                      ${Array.from(
                        new Set(
                          [...selectedSkills, ...skillOptions.map((skill) => skill.id)].filter(
                            Boolean,
                          ),
                        ),
                      ).map((id) => html`<option value=${id}></option>`)}
                    </datalist>
                  </label>
                  <label class="field">
                    <span>Skill input</span>
                    <textarea
                      data-test-id="agent-task-skill-input"
                      .value=${form.skillToolInputJson}
                      @input=${(event: Event) =>
                        patch({
                          skillToolInputJson: (event.target as HTMLTextAreaElement).value,
                        })}
                      rows="3"
                      placeholder='{"action":"balance"}'
                    ></textarea>
                  </label>
                `
              : nothing
          }
          <label class="field">
            <span>Agent model role</span>
            <select
              data-test-id="agent-task-model-role"
              .value=${form.modelRole}
              ?disabled=${form.executionMode === "no-model"}
              @change=${(event: Event) =>
                patch({
                  modelRole: (event.target as HTMLSelectElement).value as typeof form.modelRole,
                })}
            >
              <option value="">Automatic / Agent default</option>
              <option value="cheapCheck">Cheap/check</option>
              <option value="strong">Strong</option>
              <option value="escalation">Escalation</option>
              <option value="coding">Coding</option>
              <option value="summarizer">Summarizer</option>
            </select>
          </label>
          <label class="field">
            <span>Exact task model</span>
            <select
              class="agent-task-dialog__model-select"
              data-test-id="agent-task-policy-model"
              title=${
                form.policyModel
                  ? modelLabelForTask(form.policyModel, state.chatModelCatalog ?? [])
                  : cheapModelDefaultLabel
              }
              .value=${form.policyModel}
              ?disabled=${form.executionMode === "no-model"}
              @change=${(event: Event) =>
                patch({ policyModel: (event.target as HTMLInputElement).value })}
            >
              <option value="">${cheapModelDefaultLabel}</option>
              ${modelChoices.map(
                (choice) => html`<option value=${choice.value}>${choice.label}</option>`,
              )}
              ${
                form.policyModel &&
                !modelChoices.some((choice) => choice.value === form.policyModel)
                  ? html`<option value=${form.policyModel}>Current (${form.policyModel})</option>`
                  : nothing
              }
            </select>
          </label>
          <label class="field">
            <span>Escalation model</span>
            <select
              class="agent-task-dialog__model-select"
              data-test-id="agent-task-escalation-model"
              title=${
                form.escalationModel
                  ? modelLabelForTask(form.escalationModel, state.chatModelCatalog ?? [])
                  : escalationModelDefaultLabel
              }
              .value=${form.escalationModel}
              ?disabled=${form.executionMode === "no-model"}
              @change=${(event: Event) =>
                patch({ escalationModel: (event.target as HTMLInputElement).value })}
            >
              <option value="">${escalationModelDefaultLabel}</option>
              ${modelChoices.map(
                (choice) => html`<option value=${choice.value}>${choice.label}</option>`,
              )}
              ${
                form.escalationModel &&
                !modelChoices.some((choice) => choice.value === form.escalationModel)
                  ? html`<option value=${form.escalationModel}>Current (${form.escalationModel})</option>`
                  : nothing
              }
            </select>
          </label>
          <div class="agent-task-dialog__coordination">
            <div class="agent-task-dialog__coordination-head">
              <div>
                <div class="agent-task-dialog__title" style="font-size: 14px;">Ask Agents</div>
              </div>
              <select
                data-test-id="agent-task-coordination-mode"
                .value=${form.coordinationMode}
                @change=${(event: Event) =>
                  patch({
                    coordinationMode: (event.target as HTMLSelectElement)
                      .value as CronFormState["coordinationMode"],
                  })}
              >
                <option value="none">Off</option>
                <option value="consult">Consult</option>
                <option value="parallel">Parallel</option>
              </select>
            </div>
            <div class="agent-task-dialog__coordination-agents">
              ${agentChoices.map((agent) => {
                const selected = csvValues(form.coordinationAgents).includes(agent.id);
                return html`
                  <button
                    class="btn btn--xs ${selected ? "primary" : "btn--ghost"}"
                    type="button"
                    ?disabled=${form.coordinationMode === "none"}
                    aria-pressed=${selected ? "true" : "false"}
                    @click=${() => toggleAgentTaskCoordinationAgent(form, patch, agent.id)}
                  >
                    ${agent.label}
                  </button>
                `;
              })}
            </div>
            <div class="agent-task-dialog__grid">
              <label class="field">
                <span>Custom Agent ids</span>
                <input
                  data-test-id="agent-task-coordination-agents"
                  .value=${form.coordinationAgents}
                  ?disabled=${form.coordinationMode === "none"}
                  @input=${(event: Event) =>
                    patch({ coordinationAgents: (event.target as HTMLInputElement).value })}
                  placeholder="research, support"
                />
              </label>
              <label class="field">
                <span>Max Agents</span>
                <input
                  data-test-id="agent-task-coordination-max"
                  inputmode="numeric"
                  .value=${form.coordinationMaxAgents}
                  ?disabled=${form.coordinationMode === "none"}
                  @input=${(event: Event) =>
                    patch({ coordinationMaxAgents: (event.target as HTMLInputElement).value })}
                  placeholder="2"
                />
              </label>
              <label class="field">
                <span>Approval</span>
                <select
                  data-test-id="agent-task-coordination-approval"
                  .value=${form.coordinationRequireApproval ? "true" : "false"}
                  ?disabled=${form.coordinationMode === "none"}
                  @change=${(event: Event) =>
                    patch({
                      coordinationRequireApproval:
                        (event.target as HTMLSelectElement).value === "true",
                    })}
                >
                  <option value="true">Required</option>
                  <option value="false">Optional</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        <div class="agent-task-dialog__grid">
          <label class="field">
            <span>Escalation cue</span>
            <select
              data-test-id="agent-task-evaluator-enabled"
              .value=${form.evaluatorEscalateOnSignal ? "true" : "false"}
              ?disabled=${form.executionMode === "no-model" || form.executionMode === "skill-only"}
              @change=${(event: Event) =>
                patch({
                  evaluatorEscalateOnSignal: (event.target as HTMLSelectElement).value === "true",
                })}
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          </label>
          <label class="field">
            <span>Cue text</span>
            <input
              data-test-id="agent-task-evaluator-signal"
              .value=${form.evaluatorSignalIncludes}
              ?disabled=${
                !form.evaluatorEscalateOnSignal ||
                form.executionMode === "no-model" ||
                form.executionMode === "skill-only"
              }
              @input=${(event: Event) =>
                patch({ evaluatorSignalIncludes: (event.target as HTMLInputElement).value })}
              placeholder="Needs deeper analysis: yes"
            />
          </label>
          <label class="field">
            <span>Max escalations</span>
            <input
              data-test-id="agent-task-max-escalations"
              inputmode="numeric"
              .value=${form.evaluatorMaxEscalations}
              ?disabled=${
                !form.evaluatorEscalateOnSignal ||
                form.executionMode === "no-model" ||
                form.executionMode === "skill-only"
              }
              @input=${(event: Event) =>
                patch({ evaluatorMaxEscalations: (event.target as HTMLInputElement).value })}
              placeholder="1"
            />
          </label>
          <label class="field">
            <span>Auto repair retry</span>
            <select
              .value=${form.repairAutoRetryReplacement ? "true" : "false"}
              @change=${(event: Event) =>
                patch({
                  repairAutoRetryReplacement: (event.target as HTMLSelectElement).value === "true",
                })}
            >
              <option value="true">Enabled</option>
              <option value="false">Manual only</option>
            </select>
          </label>
          <label class="field">
            <span>Auto stop optional sources</span>
            <select
              .value=${form.repairAutoStopOptionalSources ? "true" : "false"}
              @change=${(event: Event) =>
                patch({
                  repairAutoStopOptionalSources:
                    (event.target as HTMLSelectElement).value === "true",
                })}
            >
              <option value="false">Manual</option>
              <option value="true">Enabled</option>
            </select>
          </label>
          <label class="field">
            <span>Max auto repairs/run</span>
            <input
              inputmode="numeric"
              .value=${form.repairMaxAutoRepairsPerRun}
              @input=${(event: Event) =>
                patch({ repairMaxAutoRepairsPerRun: (event.target as HTMLInputElement).value })}
              placeholder="1"
            />
          </label>
          <label class="field">
            <span>Primary source approval</span>
            <select
              .value=${form.repairRequireApprovalForPrimarySource ? "true" : "false"}
              @change=${(event: Event) =>
                patch({
                  repairRequireApprovalForPrimarySource:
                    (event.target as HTMLSelectElement).value === "true",
                })}
            >
              <option value="true">Required</option>
              <option value="false">Allow deterministic repair</option>
            </select>
          </label>
          <label class="field">
            <span>Max tokens/run</span>
            <input
              data-test-id="agent-task-max-tokens"
              inputmode="decimal"
              .value=${form.budgetMaxTokensPerRun}
              @input=${(event: Event) =>
                patch({ budgetMaxTokensPerRun: (event.target as HTMLInputElement).value })}
              placeholder="10000"
            />
          </label>
          <label class="field">
            <span>Max cost/run</span>
            <input
              data-test-id="agent-task-max-cost"
              inputmode="decimal"
              .value=${form.budgetMaxCostUsdPerRun}
              @input=${(event: Event) =>
                patch({ budgetMaxCostUsdPerRun: (event.target as HTMLInputElement).value })}
              placeholder="0.05"
            />
          </label>
          <label class="field">
            <span>Max runs/hour</span>
            <input
              data-test-id="agent-task-max-runs-hour"
              inputmode="decimal"
              .value=${form.budgetMaxRunsPerHour}
              @input=${(event: Event) =>
                patch({ budgetMaxRunsPerHour: (event.target as HTMLInputElement).value })}
              placeholder="12"
            />
          </label>
          <label class="field">
            <span>Stop on success</span>
            <select
              data-test-id="agent-task-stop-on-success"
              .value=${form.stopOnSuccess ? "true" : "false"}
              @change=${(event: Event) =>
                patch({ stopOnSuccess: (event.target as HTMLSelectElement).value === "true" })}
            >
              <option value="false">No</option>
              <option value="true">Yes</option>
            </select>
          </label>
          <label class="field">
            <span>Stop text</span>
            <input
              data-test-id="agent-task-stop-text"
              .value=${form.stopTextIncludes}
              @input=${(event: Event) =>
                patch({ stopTextIncludes: (event.target as HTMLInputElement).value })}
              placeholder="done, complete"
            />
          </label>
          <label class="field">
            <span>Max successes</span>
            <input
              data-test-id="agent-task-max-successes"
              inputmode="numeric"
              .value=${form.stopMaxSuccessfulRuns}
              @input=${(event: Event) =>
                patch({ stopMaxSuccessfulRuns: (event.target as HTMLInputElement).value })}
              placeholder="1"
            />
          </label>
          <label class="field">
            <span>Max total runs</span>
            <input
              data-test-id="agent-task-max-total-runs"
              inputmode="numeric"
              .value=${form.stopMaxTotalRuns}
              @input=${(event: Event) =>
                patch({ stopMaxTotalRuns: (event.target as HTMLInputElement).value })}
              placeholder="10"
            />
          </label>
        </div>

        <div class="agent-task-dialog__actions">
          <button
            class="btn btn--sm"
            type="button"
            @click=${() => closeAgentTaskDialog(state)}
          >
            Cancel
          </button>
          <button
            class="btn btn--sm primary"
            type="submit"
            data-test-id="agent-task-submit"
            ?disabled=${state.agentTaskBusy}
          >
            ${state.agentTaskBusy ? "Saving..." : editing ? "Save task" : "Create task"}
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderChannelActionDialog(state: AppViewState) {
  const action = state.channelConfirmAction;
  if (!action) {
    return nothing;
  }
  const channelLabel = action.accountId
    ? `${action.channelId}/${action.accountId}`
    : action.channelId;
  const title = "Clear Channel";
  const body = `Clear stored credentials or session data for ${channelLabel}. If this channel uses an environment token, the runtime can stop the session but cannot delete the environment variable.`;
  const busyKey = `${action.channelId}:${action.accountId ?? ""}`;
  const busy = Boolean(state.channelRuntimeBusy[busyKey]);
  return html`
    <div
      class="channel-action-dialog"
      role="dialog"
      aria-modal="true"
      aria-label=${title}
      @click=${(event: Event) => {
        if (event.target === event.currentTarget && !busy) {
          state.cancelChannelConfirmAction();
        }
      }}
    >
      <style>
        .channel-action-dialog {
          align-items: center;
          background: color-mix(in srgb, #000 62%, transparent);
          box-sizing: border-box;
          color: var(--text);
          display: flex;
          inset: 0;
          justify-content: center;
          overflow: auto;
          padding: 14px;
          position: fixed;
          z-index: 10020;
        }
        .channel-action-dialog__panel {
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 14px;
          box-shadow: var(--shadow-lg);
          box-sizing: border-box;
          display: grid;
          gap: 14px;
          max-height: calc(100dvh - 28px);
          overflow: auto;
          padding: 18px;
          width: min(480px, calc(100vw - 28px));
        }
        .channel-action-dialog__head,
        .channel-action-dialog__actions {
          align-items: center;
          display: flex;
          gap: 10px;
          justify-content: space-between;
        }
        .channel-action-dialog__title {
          color: var(--text-strong);
          font-size: 18px;
          font-weight: 780;
        }
        .channel-action-dialog__body {
          color: var(--muted);
          font-size: 13px;
          line-height: 1.55;
        }
        .channel-action-dialog__target {
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--secondary);
          color: var(--text-strong);
          font-family: var(--mono-font, ui-monospace, SFMono-Regular, Menlo, monospace);
          font-size: 12px;
          padding: 9px 10px;
          word-break: break-all;
        }
        @media (max-width: 560px) {
          .channel-action-dialog__head,
          .channel-action-dialog__actions {
            align-items: stretch;
            flex-direction: column;
          }
          .channel-action-dialog__actions .btn {
            width: 100%;
          }
        }
      </style>
      <section class="channel-action-dialog__panel" @click=${(event: Event) => event.stopPropagation()}>
        <div class="channel-action-dialog__head">
          <div class="channel-action-dialog__title">${title}</div>
          <button
            class="btn btn--sm btn--ghost"
            type="button"
            ?disabled=${busy}
            @click=${() => state.cancelChannelConfirmAction()}
          >
            Close
          </button>
        </div>
        <div class="channel-action-dialog__body">${body}</div>
        <div class="channel-action-dialog__target">${channelLabel}</div>
        <div class="channel-action-dialog__actions">
          <button
            class="btn danger"
            type="button"
            ?disabled=${busy || !state.connected}
            @click=${() => {
              void state.confirmChannelAction();
            }}
          >
            ${busy ? "Working..." : "Clear"}
          </button>
          <button
            class="btn"
            type="button"
            ?disabled=${busy}
            @click=${() => state.cancelChannelConfirmAction()}
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
  `;
}

function closeChatScheduleTask(state: AppViewState) {
  state.chatScheduleDraft = { ...DEFAULT_CHAT_SCHEDULE_DRAFT };
}

async function submitChatScheduleTask(state: AppViewState) {
  const draft = state.chatScheduleDraft;
  if (!draft.open) {
    return;
  }
  const agentId = resolveChatScheduleAgentId(state);
  const sessionKey = resolveChatScheduleSessionKey(state, agentId);
  const deliveryTarget =
    draft.deliveryMode === "channel" ? resolveChatScheduleDelivery(state)?.delivery : undefined;
  try {
    if (draft.editingJobId) {
      const existingJob = state.cronJobs.find((entry) => entry.id === draft.editingJobId) ?? null;
      await updateChatScheduleTask(state, {
        draft,
        jobId: draft.editingJobId,
        existingJob,
        agentId,
        sessionKey,
        delivery: deliveryTarget,
      });
    } else {
      await addChatScheduleTask(state, {
        draft,
        agentId,
        sessionKey,
        delivery: deliveryTarget,
      });
    }
    state.chatScheduleDraft = { ...DEFAULT_CHAT_SCHEDULE_DRAFT };
    await loadSessions(state);
  } catch (error) {
    state.chatScheduleDraft = {
      ...state.chatScheduleDraft,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runCronTaskAndRefreshSessions(state: AppViewState, job: CronJob) {
  await runCronJob(state, job);
  await loadSessions(state);
}

async function toggleCronTaskAndRefreshSessions(
  state: AppViewState,
  job: CronJob,
  enabled: boolean,
) {
  await toggleCronJob(state, job, enabled);
  await loadSessions(state);
}

async function removeCronTaskAndRefreshSessions(state: AppViewState, job: CronJob) {
  await removeCronJob(state, job);
  await loadSessions(state);
}

function closeOpenTopbarMenus(event: Event) {
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(
    ".topbar details[open], details.chat-topbar-panel[open], details.chat-session-menu[open]",
  )) {
    if (!menu.contains(target)) {
      menu.open = false;
    }
  }
}

async function controlCronQueueRunAndRefreshSessions(
  state: AppViewState,
  action: "cancel" | "retry" | "clear-stale",
  runId: string,
) {
  await controlCronQueueRun(state, action, runId);
  await loadSessions(state);
}

async function repairCronTaskAndRefreshSessions(
  state: AppViewState,
  job: CronJob,
  action: Parameters<typeof repairCronTask>[2],
  opts?: Parameters<typeof repairCronTask>[3],
) {
  await repairCronTask(state, job, action, opts);
  await loadSessions(state);
}

async function approveCronTaskCoordinationAndRefreshSessions(state: AppViewState, job: CronJob) {
  await approveCronTaskCoordination(state, job);
  await loadSessions(state);
}

async function askCronTaskAgentEvidenceAndRefreshSessions(state: AppViewState, job: CronJob) {
  await askCronTaskAgentEvidence(state, job);
  await loadSessions(state);
}

async function updateCronTrustedSourceAndRefreshSessions(
  state: AppViewState,
  sourceId: string,
  active: boolean,
) {
  await updateCronTrustedSource(state, sourceId, active);
  await loadSessions(state);
}

async function removeCronTrustedSourceAndRefreshSessions(state: AppViewState, sourceId: string) {
  await removeCronTrustedSource(state, sourceId);
  await loadSessions(state);
}

function getLazyTabView<K extends LazyTabViewKey>(
  state: AppViewState,
  key: K,
): LazyTabViewModules[K] | null {
  const cached = lazyTabViewCache[key];
  if (cached) {
    return cached as LazyTabViewModules[K];
  }
  if (!lazyTabViewInflight.has(key)) {
    const pending = lazyTabViewLoaders[key]()
      .then((mod) => {
        lazyTabViewCache[key] = mod;
        delete lazyTabViewErrors[key];
        if (typeof window !== "undefined") {
          try {
            window.sessionStorage.removeItem(`fased-control-ui:lazy-tab-reload:${key}`);
          } catch {
            // Ignore storage errors; the tab module is loaded.
          }
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (isStaleLazyTabChunkError(message) && reloadForStaleLazyTabChunk(key)) {
          lazyTabViewErrors[key] = "Dashboard assets changed. Reloading this page…";
          return;
        }
        lazyTabViewErrors[key] = message;
        console.error(`[control-ui] Failed to load ${key} tab`, error);
      })
      .finally(() => {
        lazyTabViewInflight.delete(key);
        state.requestUpdate();
      });
    lazyTabViewInflight.set(key, pending);
  }
  return null;
}

function renderLazyTabPlaceholder(label: string, error?: string) {
  return html`
    <section class="card">
      <div class="stack">
        <div class="page-title">${label}</div>
        <div class="page-sub">
          ${error ? `Could not load this tab: ${error}` : `Loading ${label.toLowerCase()}…`}
        </div>
      </div>
    </section>
  `;
}

function renderAdvancedRouteTabs(state: AppViewState) {
  return html`
    <nav class="advanced-route-tabs" aria-label="Advanced tools">
      ${ADVANCED_TABS.map(
        (entry) => html`
          <a
            class="advanced-route-tab ${state.tab === entry.tab ? "active" : ""}"
            href=${pathForTab(entry.tab, state.basePath)}
            @click=${(event: Event) => {
              event.preventDefault();
              state.setTab(entry.tab);
            }}
          >
            <span class="advanced-route-tab__icon">${entry.icon}</span>
            <span>${entry.label}</span>
          </a>
        `,
      )}
    </nav>
  `;
}

function describeTopbarMainnetSyncState(sync: SatMainnetSyncStatus | null): {
  tone: "neutral" | "success" | "warn" | "danger";
  detail: string;
} {
  if (!sync) {
    return {
      tone: "neutral",
      detail: "Check official SAT mainnet manifest.",
    };
  }
  if (sync.state === "synced") {
    return {
      tone: "success",
      detail: sync.message,
    };
  }
  if (sync.state === "available") {
    return {
      tone: "warn",
      detail: sync.message,
    };
  }
  if (sync.state === "not_live") {
    return {
      tone: "neutral",
      detail: sync.message,
    };
  }
  return {
    tone: "danger",
    detail: sync.error || sync.message || "SAT mainnet manifest verification failed.",
  };
}

function renderMiningTopbarSync(state: AppViewState) {
  if (state.tab !== "mining") {
    return nothing;
  }
  const sync = describeTopbarMainnetSyncState(state.miningMainnetSync);
  return html`
    <button
      class="btn small topbar-mining-sync"
      data-tone=${sync.tone}
      ?disabled=${state.miningMainnetSyncBusy}
      @click=${() => state.handleMiningMainnetSync()}
      title=${sync.detail}
      aria-label=${`SAT mainnet sync: ${sync.detail}`}
    >
      <span class="topbar-mining-sync__dot" aria-hidden="true"></span>
      <span>${state.miningMainnetSyncBusy ? "Syncing" : "Sync"}</span>
    </button>
  `;
}

async function storeProviderApiKeyFromProviders(
  state: AppViewState,
  params: {
    provider: string;
    secret: string;
  },
) {
  await configureProviderApiKeyCredential(state, {
    provider: params.provider,
    secret: params.secret,
    setDefaultModel: false,
  });
}

async function storeManualProviderFromProviders(
  state: AppViewState,
  params: {
    provider: string;
    secret?: string;
    baseUrl?: string;
    modelId?: string;
    compatibility?: "openai" | "anthropic" | "unknown";
    customProviderId?: string;
    alias?: string;
    allowPrivateNetwork?: boolean;
    accountId?: string;
    gatewayId?: string;
  },
) {
  await configureProviderApiKeyCredential(state, {
    provider: params.provider,
    ...(params.secret ? { secret: params.secret } : {}),
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    ...(params.modelId ? { modelId: params.modelId } : {}),
    ...(params.compatibility ? { compatibility: params.compatibility } : {}),
    ...(params.customProviderId ? { customProviderId: params.customProviderId } : {}),
    ...(params.alias ? { alias: params.alias } : {}),
    ...(params.allowPrivateNetwork !== undefined
      ? { allowPrivateNetwork: params.allowPrivateNetwork }
      : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.gatewayId ? { gatewayId: params.gatewayId } : {}),
    setDefaultModel: false,
  });
}

async function runProviderSignInFromProviders(
  state: AppViewState,
  params: {
    provider: string;
    profileId: string;
    methodId?: string;
  },
) {
  await runInteractiveProviderAuthCredential(state, {
    ...params,
    promptMode: "modal",
    browserLocal: true,
  });
}

export function renderApp(state: AppViewState) {
  const presenceCount = state.presenceEntries.length;
  const sessionsCount = state.sessionsResult?.count ?? null;
  const cronNext = state.cronStatus?.nextWakeAtMs ?? null;
  const chatDisabledReason = state.connected ? null : "Disconnected from gateway.";
  const isChat = state.tab === "chat";
  const isDashboard = state.tab === "overview";
  const chatFocus = isChat && (state.settings.chatFocusMode || state.onboarding);
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const providerModelCatalogForSetup =
    state.providerModelCatalog && state.providerModelCatalog.length > 0
      ? state.providerModelCatalog
      : (state.chatModelCatalog ?? []);
  const assistantAvatarUrl = resolveAssistantAvatarUrl(state);
  const chatAvatarUrl = assistantAvatarUrl ?? state.chatAvatarUrl ?? null;
  const configValue =
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const skillsProps = buildSkillsProps(state);
  const basePath = normalizeBasePath(state.basePath ?? "");
  const brandLogoPath = basePath ? `${basePath}/fased-logo.svg` : "/fased-logo.svg";
  const resolvedAgentId =
    state.agentsSelectedId ??
    state.agentsList?.defaultId ??
    state.agentsList?.agents?.[0]?.id ??
    null;
  const runtimeSessionKey = state.sessionKey?.trim() || state.agentsList?.mainKey?.trim() || "main";
  const runtimeSessionAgentId =
    parseAgentSessionKey(runtimeSessionKey)?.agentId ?? state.agentsList?.defaultId ?? null;
  const runtimeSessionMatchesSelectedAgent = Boolean(
    resolvedAgentId && runtimeSessionAgentId && runtimeSessionAgentId === resolvedAgentId,
  );
  const debugMethods = state.hello?.features?.methods ?? [];
  const configView = state.tab === "config" ? getLazyTabView(state, "config") : null;
  const providersView =
    state.tab === "providers" || (state.tab === "agents" && state.agentsPanel === "providers")
      ? getLazyTabView(state, "providers")
      : null;
  const federationView =
    state.tab === "federation" || state.tab === "marketplace"
      ? getLazyTabView(state, "federation")
      : null;
  const walletView = state.tab === "wallet" ? getLazyTabView(state, "wallet") : null;
  const miningView = state.tab === "mining" ? getLazyTabView(state, "mining") : null;
  const savedToken = state.settings.token.trim();
  const hasValidSessionToken = savedToken.length > 20 && !savedToken.startsWith("tok_");
  const showContentHeaderBreadcrumb =
    state.tab !== "overview" &&
    state.tab !== "usage" &&
    state.tab !== "mining" &&
    state.tab !== "notifications" &&
    !isChat;
  // Keep the dashboard visible during reconnects when we already have a session token.
  const canShowSignOut = hasValidSessionToken;
  const ownerLoginRequired = !state.authBootstrapPending && !hasValidSessionToken;
  const gatewayRestarting =
    !state.connected &&
    typeof state.lastError === "string" &&
    state.lastError.startsWith("Restarting:");
  const healthLabel = state.connected ? "Live" : gatewayRestarting ? "Restarting" : "Offline";

  const loadVisibleAgentTools = (agentId: string) => {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) {
      resetToolsEffectiveState(state);
      return;
    }
    if (state.toolsCatalogResult?.agentId !== normalizedAgentId && !state.toolsCatalogLoading) {
      void loadToolsCatalog(state, normalizedAgentId);
    }
    if (runtimeSessionKey && runtimeSessionAgentId === normalizedAgentId) {
      const effectiveParams = {
        agentId: normalizedAgentId,
        sessionKey: runtimeSessionKey,
      };
      const effectiveKey = buildToolsEffectiveRequestKey(state, effectiveParams);
      if (state.toolsEffectiveResultKey !== effectiveKey && !state.toolsEffectiveLoading) {
        void loadToolsEffective(state, effectiveParams);
      }
      return;
    }
    resetToolsEffectiveState(state);
  };

  if (state.authBootstrapPending && !hasValidSessionToken) {
    return html`
      <style>
        .login-page { min-height:100vh; display:flex; align-items:center; justify-content:center; background:#080e1a; font-family:system-ui,-apple-system,sans-serif; padding:24px; box-sizing:border-box; }
        .login-card { width:100%; max-width:420px; background:#0f1929; border:1px solid rgba(255,255,255,0.07); border-radius:16px; padding:40px 36px; box-shadow:0 24px 64px rgba(0,0,0,0.5); }
        .login-logo { width:48px; height:48px; border-radius:12px; background:linear-gradient(135deg,#2563eb,#7c3aed); display:flex; align-items:center; justify-content:center; margin-bottom:24px; font-size:26px; }
        .login-title { font-size:22px; font-weight:700; color:#f0f4ff; margin:0 0 6px; }
        .login-desc { font-size:14px; color:#6b7a99; margin:0; line-height:1.6; }
      </style>
      <div class="login-page">
        <div class="login-card">
          <div class="login-logo">⚡</div>
          <h1 class="login-title">Opening ${FASED_AGENT_NAME}</h1>
          <p class="login-desc">Checking the private dashboard session…</p>
        </div>
      </div>
    `;
  }

  if (ownerLoginRequired) {
    const isPending = state.loginTokenPending;
    const loginError = state.loginTokenError;
    return html`
      <style>
        .login-page { min-height:100vh; display:flex; align-items:center; justify-content:center; background:#080e1a; font-family:system-ui,-apple-system,sans-serif; padding:24px; box-sizing:border-box; }
        .login-card { width:100%; max-width:420px; background:#0f1929; border:1px solid rgba(255,255,255,0.07); border-radius:16px; padding:40px 36px; box-shadow:0 24px 64px rgba(0,0,0,0.5); }
        .login-logo { width:48px; height:48px; border-radius:12px; background:linear-gradient(135deg,#2563eb,#7c3aed); display:flex; align-items:center; justify-content:center; margin-bottom:24px; font-size:26px; }
        .login-title { font-size:22px; font-weight:700; color:#f0f4ff; margin:0 0 6px; }
        .login-desc { font-size:14px; color:#6b7a99; margin:0 0 28px; line-height:1.6; }
        .login-label { display:block; font-size:12px; font-weight:600; color:#9aa5bf; margin-bottom:8px; letter-spacing:0.05em; text-transform:uppercase; }
        .login-input { width:100%; box-sizing:border-box; background:#060d1a; border:1px solid rgba(255,255,255,0.10); border-radius:10px; padding:12px 14px; font-size:14px; font-family:ui-monospace,monospace; color:#c9d4f0; outline:none; transition:border-color 0.2s; margin-bottom:16px; }
        .login-input:focus { border-color:#2563eb; }
        .login-btn { width:100%; padding:13px; background:linear-gradient(135deg,#2563eb,#1d4ed8); border:none; border-radius:10px; color:#fff; font-size:15px; font-weight:600; cursor:pointer; transition:opacity 0.15s,transform 0.1s; }
        .login-btn:hover:not(:disabled) { opacity:0.9; transform:translateY(-1px); }
        .login-btn:disabled { opacity:0.5; cursor:not-allowed; }
        .login-error { margin-top:14px; padding:10px 14px; background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.25); border-radius:8px; color:#f87171; font-size:13px; }
        .login-hint { margin-top:20px; font-size:12px; color:#3a4660; text-align:center; line-height:1.6; }
      </style>
      <div class="login-page">
        <div class="login-card">
          <div class="login-logo">⚡</div>
          <h1 class="login-title">Sign in to ${FASED_AGENT_NAME}</h1>
          <p class="login-desc">Enter your owner gateway token to access the private dashboard. Your session will be authorized with a secure cookie.</p>
          <label class="login-label">Gateway Token</label>
          <input
            class="login-input"
            type="password"
            placeholder="Paste your gateway token"
            value=${state.loginTokenCandidate}
            ?disabled=${isPending}
            @input=${(e: Event) => {
              state.setLoginTokenCandidate((e.target as HTMLInputElement).value.trim());
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" && !isPending) {
                void state.signInWithGatewayToken();
              }
            }}
          />
          <button
            class="login-btn"
            ?disabled=${isPending}
            @click=${() => void state.signInWithGatewayToken()}
          >
            ${isPending ? "Signing in…" : "Sign in"}
          </button>
          ${loginError ? html`<div class="login-error">${loginError}</div>` : ""}
          <p class="login-hint">Token is only used to establish a secure session — it is not stored in your browser.</p>
        </div>
      </div>
    `;
  }

  return html`
    ${renderAgentTaskDialog(state)}
    <div
      class="shell ${isChat ? "shell--chat" : ""} ${chatFocus ? "shell--chat-focus" : ""} ${state.settings.navCollapsed ? "shell--nav-collapsed" : ""} ${state.onboarding ? "shell--onboarding" : ""}"
      @click=${closeOpenTopbarMenus}
    >
      <header class="topbar">
        <div class="topbar-left">
          <div class="topbar-page-title">${titleForTab(state.tab)}</div>
          ${renderMiningTopbarSync(state)}
        </div>
        <div class="topbar-status">
          ${isChat ? html`<div class="topbar-chat-controls">${renderChatControls(state)}</div>` : nothing}
          ${
            isDashboard
              ? html`
                  <div class="topbar-dashboard-actions">
                    <button
                      class="btn primary topbar-dashboard-actions__widget"
                      @click=${() => state.setDashboardWidgetDrawerOpen(true)}
                    >
                      ${icons.plus} Widget
                    </button>
                    <button
                      class="icon-btn topbar-dashboard-actions__refresh"
                      title="Refresh dashboard"
                      aria-label="Refresh dashboard"
                      @click=${() => state.loadOverview()}
                    >
                      ${icons.refresh}
                    </button>
                  </div>
                `
              : nothing
          }
          ${
            isChat
              ? renderChatTopbarPanels({
                  sessionKey: state.sessionKey,
                  sessions: state.sessionsResult,
                  sessionUsage: state.chatSessionUsage,
                  sessionUsageLoading: state.chatSessionUsageLoading,
                  sessionUsageVisible: true,
                  messages: state.chatMessages,
                  taskJobs: state.cronJobs,
                  taskLoading: state.cronLoading,
                  onTaskEdit: (job) => openChatTaskEditor(state, job),
                  onTaskRun: (job) => void runCronTaskAndRefreshSessions(state, job),
                  onTaskOpenRun: (sessionKey) => openTaskRunTranscript(state, sessionKey),
                  onTaskToggle: (job, enabled) =>
                    void toggleCronTaskAndRefreshSessions(state, job, enabled),
                  onTaskCancel: (job) => void removeCronTaskAndRefreshSessions(state, job),
                  deliveryMode: state.settings.chatDeliveryMode,
                  onDeliveryModeChange: (mode) =>
                    state.applySettings({
                      ...state.settings,
                      chatDeliveryMode: mode,
                    }),
                })
              : nothing
          }
          <span
            class="topbar-health"
            tabindex="0"
            aria-label=${`Gateway ${healthLabel}`}
            title=${healthLabel}
          >
            <span class="statusDot ${state.connected ? "ok" : gatewayRestarting ? "warn" : ""}"></span>
            <span class="topbar-health__tooltip">${healthLabel}</span>
          </span>
          <a
            class="topbar-icon-link"
            href="https://docs.fased.ai"
            target="_blank"
            rel="noreferrer"
            title="Docs"
            aria-label="Docs"
          >
            ${icons.book}
          </a>
          <details class="topbar-menu">
            <summary class="topbar-menu__button" aria-label="Open menu" title="Menu">
              ${icons.moreHorizontal}
            </summary>
            <div class="topbar-menu__panel">
              ${renderThemeToggle(state)}
              ${
                canShowSignOut
                  ? html`
                      <button class="topbar-menu__link" @click=${() => void state.signOut()}>
                        Sign out
                      </button>
                    `
                  : nothing
              }
            </div>
          </details>
        </div>
      </header>
      <aside class="nav ${state.settings.navCollapsed ? "nav--collapsed" : ""}">
        <div class="nav-brand">
          <div class="brand nav-brand__identity">
            <div class="brand-logo">
              <img
                class="brand-logo__img"
                src=${brandLogoPath}
                alt=""
                aria-hidden="true"
              />
            </div>
            <div class="brand-text">
              <div class="brand-title">${FASED_BRAND_NAME}</div>
            </div>
          </div>
          <button
            class="nav-collapse-toggle"
            @click=${() =>
              state.applySettings({
                ...state.settings,
                navCollapsed: !state.settings.navCollapsed,
              })}
            title="${state.settings.navCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
            aria-label="${state.settings.navCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
          >
            <span class="nav-collapse-toggle__icon">
              ${state.settings.navCollapsed ? icons.panelLeftOpen : icons.panelLeftClose}
            </span>
          </button>
        </div>
        <div class="nav-list">
          ${TAB_GROUPS.flatMap((group) => group.tabs)
            .filter((tab) => !(state.federationManagedMode && tab === "federation"))
            .map((tab) => renderTab(state, tab))}
        </div>
      </aside>
      <main class="content ${isChat ? "content--chat" : ""} ${isDashboard ? "content--dashboard" : ""}">
        ${
          ownerLoginRequired
            ? html`
                <section class="onboarding-card">
                  <h1>Authentication Required</h1>
                  <p>Please enter your Gateway Token to access the dashboard.</p>
                  <div class="form-group">
                    <label>Gateway Token</label>
                    <input
                      type="password"
                      class="mono"
                      placeholder="Paste token here"
                      @change=${(e: Event) => {
                        const val = (e.target as HTMLInputElement).value.trim();
                        if (val) {
                          state.applySettings({ ...state.settings, token: val });
                          window.location.reload();
                        }
                      }}
                    />
                  </div>
                  <p class="small">
                    Tip: You can find your token in the onboarding report or in
                    <code>~/.fased/gateway-secret</code>.
                  </p>
                </section>
              `
            : nothing
        }
        ${
          CONTENT_HEADERLESS_TABS.has(state.tab)
            ? nothing
            : html`
                <section class="content-header ${state.tab === "overview" ? "content-header--dashboard" : ""}">
                  <div>
                    ${
                      state.tab === "overview"
                        ? nothing
                        : showContentHeaderBreadcrumb
                          ? html`
                              <dashboard-header
                                .tab=${state.tab}
                                .basePath=${state.basePath}
                                @navigate=${(event: CustomEvent<Tab>) => {
                                  state.setTab(event.detail);
                                }}
                              ></dashboard-header>
                            `
                          : html`<div class="page-title">${titleForTab(state.tab)}</div>`
                    }
                    ${
                      showContentHeaderBreadcrumb
                        ? html`<div class="page-sub">${subtitleForTab(state.tab)}</div>`
                        : nothing
                    }
                  </div>
                  <div class="page-meta">
                    ${state.lastError ? html`<div class="pill danger">${state.lastError}</div>` : nothing}
                  </div>
                </section>
              `
        }

        ${
          state.tab === "config" || state.tab === "debug" || state.tab === "nodes"
            ? renderAdvancedRouteTabs(state)
            : nothing
        }

        ${
          state.tab === "overview"
            ? renderOverview({
                onboarding: state.onboarding,
                managedMode: state.federationManagedMode,
                basePath: state.basePath,
                connected: state.connected,
                hello: state.hello,
                settings: state.settings,
                password: state.password,
                canSignOut: Boolean(state.settings.token.trim()),
                loginGrantInput: state.loginGrantInput,
                loginGrantPending: state.loginGrantPending,
                loginGrantError: state.loginGrantError,
                lastError: state.lastError,
                authNotice: state.authNotice,
                authSessionExpiresAt: state.authSessionExpiresAt,
                authSessionIdleTimeoutSeconds: state.authSessionIdleTimeoutSeconds,
                overviewAdvancedUnlocked: state.overviewAdvancedUnlocked,
                overviewSecretsRevealUntilMs: state.overviewSecretsRevealUntilMs,
                presenceCount,
                sessionsCount,
                cronEnabled: state.cronStatus?.enabled ?? null,
                cronJobs: state.cronJobsTotal || state.cronStatus?.jobs || null,
                cronActiveTasks: state.cronStatus
                  ? (state.cronStatus.queue?.activeRuns.length ??
                    state.cronStatus.queue?.running ??
                    0)
                  : null,
                cronNext,
                lastChannelsRefresh: state.channelsLastSuccess,
                federationToken: state.federationToken,
                federationStatus: state.federationStatus,
                walletStatus: state.walletStatus,
                walletNamedWallets: state.walletNamedWallets,
                defaultWalletId: state.walletDefaultWalletId,
                miningAttachedWalletId: state.miningAttachedWalletId,
                miningProfile: state.miningProfile,
                miningReadiness: state.miningReadiness,
                miningStatus: state.miningStatus,
                miningHistory: state.miningHistory,
                modelCatalogStatus: state.debugModelCatalogStatus,
                pluginsMarketplace: state.debugPluginsMarketplace,
                memoryInventory: state.memoryInventory,
                memoryValidation: state.memoryValidation,
                agentsList: state.agentsList,
                usageResult: state.usageResult,
                usageLoading: state.usageLoading,
                dashboardLayout: state.dashboardLayout,
                dashboardWidgetDrawerOpen: state.dashboardWidgetDrawerOpen,
                onSettingsChange: (next) => state.applySettings(next),
                onPasswordChange: (next) => (state.password = next),
                onAuthStorageModeChange: (next) =>
                  state.applySettings({ ...state.settings, authStorage: next }),
                onLoginGrantInputChange: (next) => (state.loginGrantInput = next),
                onLoginGrantExchange: () => {
                  void state.exchangeLoginGrant();
                },
                onSignOut: () => {
                  void state.signOut();
                },
                onUnlockAdvanced: () => state.unlockOverviewAdvanced(),
                onLockAdvanced: () => state.lockOverviewAdvanced(),
                onRevealSecrets: () => state.revealOverviewSecrets(),
                onConnect: () => state.connect(),
                onRefresh: () => state.loadOverview(),
                onNavigate: (tab) => state.setTab(tab),
                onOpenAgentTasks: () => {
                  state.agentsPanel = "cron";
                  state.setTab("agents");
                },
                onOpenAgentSessions: () => {
                  state.agentsPanel = "sessions";
                  state.setTab("agents");
                },
                onOpenAdminControl: () => state.handleOperatorReadinessOpenAdminControl(),
                onOpenTaskPayment: () => state.handleOperatorReadinessOpenTaskPayment(),
                onOpenMining: () => state.handleOperatorReadinessOpenMining(),
                onOpenFederationReview: () => state.handleOperatorReadinessOpenFederationReview(),
                onDashboardLayoutChange: (next) => state.setDashboardLayout(next),
                onDashboardWidgetDrawerOpen: (next) => state.setDashboardWidgetDrawerOpen(next),
              })
            : nothing
        }

        ${
          state.tab === "memory"
            ? renderMemory({
                loading: state.memoryLoading,
                error: state.memoryError,
                configForm: state.configForm,
                configSaving: state.configSaving,
                configDirty: state.configFormDirty,
                inventory: state.memoryInventory,
                validation: state.memoryValidation,
                agentsList: state.agentsList,
                selectedAgentId: state.agentsSelectedId,
                dreamingStatusLoading: state.dreamingStatusLoading,
                dreamingStatusError: state.dreamingStatusError,
                dreamingStatus: state.dreamingStatus,
                dreamDiaryLoading: state.dreamDiaryLoading,
                dreamDiaryError: state.dreamDiaryError,
                dreamDiaryPath: state.dreamDiaryPath,
                dreamDiaryContent: state.dreamDiaryContent,
                onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
                onConfigSave: () => saveConfig(state),
                onSelectAgent: (agentId) => {
                  if (state.agentsSelectedId === agentId) {
                    return;
                  }
                  state.agentsSelectedId = agentId;
                  state.memoryInventory = null;
                  state.memoryValidation = null;
                  state.dreamingStatus = null;
                  state.dreamingStatusError = null;
                  void state.handleMemoryLoad();
                },
                onRefresh: () => {
                  void state.handleMemoryLoad();
                },
                onOpenDebug: () => state.setTab("debug"),
              })
            : nothing
        }

        ${
          state.tab === "channels"
            ? renderChannels({
                connected: state.connected,
                loading: state.channelsLoading,
                snapshot: state.channelsSnapshot,
                agentsList: state.agentsList,
                lastError: state.channelsError,
                notice: state.channelsNotice,
                lastSuccessAt: state.channelsLastSuccess,
                channelRuntimeBusy: state.channelRuntimeBusy,
                channelQrLogin: state.channelQrLogin,
                whatsappMessage: state.whatsappLoginMessage,
                whatsappQrDataUrl: state.whatsappLoginQrDataUrl,
                whatsappConnected: state.whatsappLoginConnected,
                whatsappBusy: state.whatsappBusy,
                configSchema: state.configSchema,
                configSchemaLoading: state.configSchemaLoading,
                configForm: state.configForm,
                configUiHints: state.configUiHints,
                configSaving: state.configSaving,
                configFormDirty: state.configFormDirty,
                activeView: state.channelsView,
                nostrProfileFormState: state.nostrProfileFormState,
                nostrProfileAccountId: state.nostrProfileAccountId,
                onViewChange: (view) => {
                  state.channelsView = view;
                },
                onRefresh: (probe) => loadChannels(state, probe),
                onChannelEnable: (channelId) => state.handleChannelEnable(channelId),
                onChannelStart: (channelId, accountId) =>
                  startChannelRuntime(state, channelId, accountId),
                onChannelStop: (channelId, accountId) =>
                  stopChannelRuntime(state, channelId, accountId),
                onChannelInstall: (channelId) => state.handleChannelInstall(channelId),
                onChannelLogout: (channelId, accountId) =>
                  state.handleChannelLogout(channelId, accountId),
                onChannelQrStart: (channelId, force, accountId) =>
                  state.handleChannelQrStart(channelId, force, accountId),
                onChannelQrWait: (channelId, accountId) =>
                  state.handleChannelQrWait(channelId, accountId),
                onWhatsAppStart: (force) => state.handleWhatsAppStart(force),
                onWhatsAppWait: () => state.handleWhatsAppWait(),
                onWhatsAppLogout: () => state.handleWhatsAppLogout(),
                onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
                onConfigRemove: (path) => removeConfigFormValue(state, path),
                onConfigSave: () => state.handleChannelConfigSave(),
                onConfigReload: () => state.handleChannelConfigReload(),
                onNostrProfileEdit: (accountId, profile) =>
                  state.handleNostrProfileEdit(accountId, profile),
                onNostrProfileCancel: () => state.handleNostrProfileCancel(),
                onNostrProfileFieldChange: (field, value) =>
                  state.handleNostrProfileFieldChange(field, value),
                onNostrProfileSave: () => state.handleNostrProfileSave(),
                onNostrProfileImport: () => state.handleNostrProfileImport(),
                onNostrProfileToggleAdvanced: () => state.handleNostrProfileToggleAdvanced(),
              })
            : nothing
        }

        ${
          state.tab === "services"
            ? renderServices({
                configForm:
                  state.configForm ??
                  (state.configSnapshot?.config as Record<string, unknown> | null),
                skillsReport: state.skillsReport,
                skillsLoading: state.skillsLoading,
                pluginsMarketplace: state.pluginsMarketplaceList,
                capabilities: state.servicesCapabilities,
                capabilitiesLoading: state.servicesCapabilitiesLoading,
                componentBusy: state.servicesComponentBusy,
                componentMessage: state.servicesComponentMessage,
                webSearchProviders: state.servicesWebSearchProviders,
                webSearchProvidersLoading: state.servicesWebSearchProvidersLoading,
                configSaving: state.configSaving,
                configDirty: state.configFormDirty,
                onNavigate: (tab) => state.setTab(tab),
                onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
                onConfigRemove: (path) => removeConfigFormValue(state, path),
                onConfigSave: () => saveConfig(state),
                onConfigReload: () => loadConfig(state),
                onGmailProvision: () => provisionGmailService(state),
                gmailProvisionBusy: state.servicesGmailProvisioning,
                gmailProvisionMessage: state.servicesGmailProvisionMessage,
                onWebSearchTest: () => testWebSearchService(state),
                webSearchTestBusy: state.servicesWebSearchTesting,
                webSearchTestMessage: state.servicesWebSearchTestMessage,
                onComponentInstall: (id) => void installServiceComponent(state, id),
                onComponentRestart: (id) => void restartServiceComponent(state, id),
              })
            : nothing
        }

        ${
          state.tab === "instances"
            ? renderInstances({
                loading: state.presenceLoading,
                entries: state.presenceEntries,
                lastError: state.presenceError,
                statusMessage: state.presenceStatus,
                onRefresh: () => loadPresence(state),
              })
            : nothing
        }

        ${
          state.tab === "sessions"
            ? renderSessions({
                loading: state.sessionsLoading,
                result: state.sessionsResult,
                error: state.sessionsError,
                search: state.sessionsFilterSearch,
                activeMinutes: state.sessionsFilterActive,
                limit: state.sessionsFilterLimit,
                includeGlobal: state.sessionsIncludeGlobal,
                includeUnknown: state.sessionsIncludeUnknown,
                basePath: state.basePath,
                connected: state.connected,
                currentSessionKey: state.sessionKey,
                sessionsSubscriptionActive: state.sessionsSubscriptionActive,
                sessionsLastEventAt: state.sessionsLastEventAt,
                sessionMessagesSubscriptionActive: state.sessionMessagesSubscriptionActive,
                subscribedSessionMessageKey: state.subscribedSessionMessageKey,
                sessionMessageLastEventAt: state.sessionMessageLastEventAt,
                configForm: state.configForm,
                configLoading: state.configLoading,
                configSaving: state.configSaving,
                configDirty: state.configFormDirty,
                onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
                onConfigRemove: (path) => removeConfigFormValue(state, path),
                onConfigSave: () => saveConfig(state),
                onConfigReload: () => loadConfig(state),
                onFiltersChange: (next) => {
                  state.sessionsFilterSearch = next.search;
                  state.sessionsFilterActive = next.activeMinutes;
                  state.sessionsFilterLimit = next.limit;
                  state.sessionsIncludeGlobal = next.includeGlobal;
                  state.sessionsIncludeUnknown = next.includeUnknown;
                  void loadSessions(state);
                },
                onRefresh: () => loadSessions(state),
                onLoadMore: () =>
                  loadSessions(state, {
                    offset: state.sessionsResult?.nextOffset ?? undefined,
                    append: true,
                  }),
                onPatch: (key, patch) => patchSession(state, key, patch),
                onDelete: (key) => deleteSessionAndRefresh(state, key),
                onBranchCheckpoint: (key, checkpointId) =>
                  branchSessionCheckpoint(state, key, checkpointId),
                onRestoreCheckpoint: (key, checkpointId) =>
                  restoreSessionCheckpoint(state, key, checkpointId),
                taskJobs: state.cronJobs,
                taskLoading: state.cronLoading,
                onTaskEdit: (job) => openChatTaskEditor(state, job),
                onTaskRun: (job) => runCronTaskAndRefreshSessions(state, job),
                onTaskOpenRun: (sessionKey) => openTaskRunTranscript(state, sessionKey),
                onTaskToggle: (job, enabled) =>
                  toggleCronTaskAndRefreshSessions(state, job, enabled),
                onTaskCancel: (job) => removeCronTaskAndRefreshSessions(state, job),
              })
            : nothing
        }

        ${renderUsageTab(state)}

        ${
          state.tab === "cron"
            ? renderCron({
                basePath: state.basePath,
                loading: state.cronLoading,
                jobsLoadingMore: state.cronJobsLoadingMore,
                status: state.cronStatus,
                jobs: state.cronJobs,
                jobsTotal: state.cronJobsTotal,
                jobsHasMore: state.cronJobsHasMore,
                jobsQuery: state.cronJobsQuery,
                jobsEnabledFilter: state.cronJobsEnabledFilter,
                jobsScheduleKindFilter: state.cronJobsScheduleKindFilter,
                jobsLastStatusFilter: state.cronJobsLastStatusFilter,
                jobsAdaptiveRouteFilter: state.cronJobsAdaptiveRouteFilter,
                jobsSortBy: state.cronJobsSortBy,
                jobsSortDir: state.cronJobsSortDir,
                error: state.cronError,
                busy: state.cronBusy,
                form: state.cronForm,
                fieldErrors: state.cronFieldErrors,
                canSubmit: Object.keys(validateCronForm(state.cronForm)).length === 0,
                editingJobId: state.cronEditingJobId,
                channels: state.channelsSnapshot?.channelMeta?.length
                  ? state.channelsSnapshot.channelMeta.map((entry) => entry.id)
                  : (state.channelsSnapshot?.channelOrder ?? []),
                channelLabels: state.channelsSnapshot?.channelLabels ?? {},
                channelMeta: state.channelsSnapshot?.channelMeta ?? [],
                runsJobId: state.cronRunsJobId,
                runs: state.cronRuns,
                runsTotal: state.cronRunsTotal,
                runsHasMore: state.cronRunsHasMore,
                runsLoadingMore: state.cronRunsLoadingMore,
                runsScope: state.cronRunsScope,
                runsStatuses: state.cronRunsStatuses,
                runsDeliveryStatuses: state.cronRunsDeliveryStatuses,
                runsStatusFilter: state.cronRunsStatusFilter,
                runsQuery: state.cronRunsQuery,
                runsSortDir: state.cronRunsSortDir,
                agentSuggestions: state.agentsList?.agents?.map((a) => a.id) ?? [],
                agentOptions: state.agentsList?.agents ?? [],
                modelSuggestions: [],
                thinkingSuggestions: [],
                timezoneSuggestions: [],
                deliveryToSuggestions: [],
                accountSuggestions: [],
                configForm: state.configForm,
                configLoading: state.configLoading,
                configSaving: state.configSaving,
                configDirty: state.configFormDirty,
                onFormChange: (patch) => {
                  state.cronForm = { ...state.cronForm, ...patch };
                  state.cronFieldErrors = validateCronForm(state.cronForm);
                },
                onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
                onConfigRemove: (path) => removeConfigFormValue(state, path),
                onConfigSave: () => saveConfig(state),
                onConfigReload: () => loadConfig(state),
                onRefresh: () => state.loadCron(),
                onCreate: () => openGlobalTaskCreate(state),
                onAdd: () => addCronJob(state),
                onEdit: (job) => openAgentTaskEditor(state, job),
                onClone: (job) => startCronClone(state, job),
                onCancelEdit: () => cancelCronEdit(state),
                onToggle: (job, enabled) => toggleCronJob(state, job, enabled),
                onRun: (job) => runCronTaskAndRefreshSessions(state, job),
                onRepair: (job, action, opts) =>
                  repairCronTaskAndRefreshSessions(state, job, action, opts),
                onApproveCoordination: (job) =>
                  approveCronTaskCoordinationAndRefreshSessions(state, job),
                onAskAgentEvidence: (job) => askCronTaskAgentEvidenceAndRefreshSessions(state, job),
                onSourceToggle: (source, active) =>
                  updateCronTrustedSourceAndRefreshSessions(state, source.id, active),
                onSourceRemove: (source) =>
                  removeCronTrustedSourceAndRefreshSessions(state, source.id),
                onNavigate: (tab) => state.setTab(tab),
                onQueueControl: (action, runId) =>
                  controlCronQueueRunAndRefreshSessions(state, action, runId),
                onRunDetail: (runId) => {
                  void loadCronRunDetail(state, runId);
                },
                onRemove: (job) => removeCronTaskAndRefreshSessions(state, job),
                onLoadRuns: (jobId) => loadCronRuns(state, jobId),
                onLoadMoreJobs: () => loadMoreCronJobs(state),
                onJobsFiltersChange: (patch) => updateCronJobsFilter(state, patch),
                onJobsFiltersReset: () =>
                  updateCronJobsFilter(state, {
                    cronJobsQuery: "",
                    cronJobsEnabledFilter: "all",
                    cronJobsScheduleKindFilter: "all",
                    cronJobsLastStatusFilter: "all",
                    cronJobsAdaptiveRouteFilter: "all",
                    cronJobsSortBy: "updatedAtMs",
                    cronJobsSortDir: "desc",
                  }),
                onLoadMoreRuns: () => loadMoreCronRuns(state),
                onRunsFiltersChange: (patch) => updateCronRunsFilter(state, patch),
                onNavigateToChat: (sessionKey) => {
                  const url = `${state.basePath}/chat?session=${encodeURIComponent(sessionKey)}`;
                  window.history.pushState({}, "", url);
                  state.tab = "chat";
                },
              })
            : nothing
        }

        ${
          state.tab === "agents"
            ? renderAgents({
                basePath: state.basePath,
                loading: state.agentsLoading,
                error: state.agentsError,
                agentsList: state.agentsList,
                selectedAgentId: resolvedAgentId,
                agentCreateBusy: state.agentsCreateBusy,
                agentCreateMessage: state.agentsCreateMessage,
                activePanel: state.agentsPanel,
                config: {
                  form: configValue,
                  loading: state.configLoading,
                  saving: state.configSaving,
                  dirty: state.configFormDirty,
                },
                connected: state.connected,
                channelRuntimeBusy: state.channelRuntimeBusy,
                channelsView: state.channelsView,
                configSchema: state.configSchema,
                configSchemaLoading: state.configSchemaLoading,
                configUiHints: state.configUiHints,
                channels: {
                  snapshot: state.channelsSnapshot,
                  loading: state.channelsLoading,
                  error: state.channelsError,
                  lastSuccess: state.channelsLastSuccess,
                },
                sessions: {
                  result: state.sessionsResult,
                  loading: state.sessionsLoading,
                  error: state.sessionsError,
                  search: state.sessionsFilterSearch,
                },
                cron: {
                  status: state.cronStatus,
                  jobs: state.cronJobs,
                  loading: state.cronLoading,
                  error: state.cronError,
                },
                webhookTriggers: {
                  result: state.webhookTriggers,
                  loading: state.webhookTriggersLoading,
                  busy: state.webhookTriggersBusy,
                  error: state.webhookTriggersError,
                  message: state.webhookTriggersMessage,
                  draft: state.webhookTriggerDraft,
                },
                taskLedger: {
                  result: state.taskLedger,
                  loading: state.taskLedgerLoading,
                  busy: state.taskLedgerBusy,
                  error: state.taskLedgerError,
                  sourceFilter: state.taskLedgerSourceFilter,
                  typeFilter: state.taskLedgerTypeFilter,
                  statusFilter: state.taskLedgerStatusFilter,
                  details: state.taskLedgerDetails,
                  detailLoading: state.taskLedgerDetailLoading,
                  detailErrors: state.taskLedgerDetailErrors,
                },
                taskWorkflow: {
                  draft: state.taskWorkflowDraft,
                  graphDraft: state.taskWorkflowGraphDraft,
                  busy: state.taskWorkflowBusy,
                  error: state.taskWorkflowError,
                  message: state.taskWorkflowMessage,
                  definitions: state.taskWorkflowDefinitions,
                  definitionsLoading: state.taskWorkflowDefinitionsLoading,
                  definitionsBusy: state.taskWorkflowDefinitionsBusy,
                  definitionsError: state.taskWorkflowDefinitionsError,
                  templates: state.taskWorkflowTemplates,
                  templatesLoading: state.taskWorkflowTemplatesLoading,
                  templatesError: state.taskWorkflowTemplatesError,
                  runs: state.taskFlowRuns,
                  runsLoading: state.taskFlowRunsLoading,
                  runsBusy: state.taskFlowRunsBusy,
                  runsError: state.taskFlowRunsError,
                },
                taskStandingOrders: {
                  result: state.taskStandingOrders,
                  loading: state.taskStandingOrdersLoading,
                  busy: state.taskStandingOrdersBusy,
                  error: state.taskStandingOrdersError,
                  message: state.taskStandingOrdersMessage,
                  draft: state.taskStandingOrderDraft,
                },
                taskFilters: {
                  query: state.agentTaskQuery,
                  status: state.agentTaskStatusFilter,
                  adaptiveRoute: state.agentTaskAdaptiveRouteFilter,
                  sortDir: state.agentTaskSortDir,
                },
                agentFiles: {
                  list: state.agentFilesList,
                  loading: state.agentFilesLoading,
                  error: state.agentFilesError,
                  active: state.agentFileActive,
                  contents: state.agentFileContents,
                  drafts: state.agentFileDrafts,
                  saving: state.agentFileSaving,
                },
                agentIdentityLoading: state.agentIdentityLoading,
                agentIdentityError: state.agentIdentityError,
                agentIdentityById: state.agentIdentityById,
                agentSkills: {
                  report: state.agentSkillsReport,
                  loading: state.agentSkillsLoading,
                  error: state.agentSkillsError,
                  agentId: state.agentSkillsAgentId,
                  filter: state.skillsFilter,
                },
                toolsCatalog: {
                  loading: state.toolsCatalogLoading,
                  error: state.toolsCatalogError,
                  result: state.toolsCatalogResult,
                },
                toolsEffective: {
                  loading: state.toolsEffectiveLoading,
                  error: state.toolsEffectiveError,
                  result: state.toolsEffectiveResult,
                },
                memory: {
                  inventory: state.memoryInventory,
                  validation: state.memoryValidation,
                  loading: state.memoryLoading,
                  error: state.memoryError,
                  wiki: state.memoryWiki,
                  wikiRebuilding: state.memoryWikiRebuilding,
                  wikiError: state.memoryWikiError,
                  dreamingStatusLoading: state.dreamingStatusLoading,
                  dreamingStatusError: state.dreamingStatusError,
                  dreamingStatus: state.dreamingStatus,
                },
                providers: {
                  catalogStatus: state.configModelCatalogStatus ?? state.debugModelCatalogStatus,
                  authStatus: state.configAuthStatus,
                },
                usage: {
                  result: state.usageResult,
                  loading: state.usageLoading,
                  error: state.usageError,
                },
                providersPanel: providersView
                  ? providersView.renderProviders({
                      connected: state.connected,
                      loading: state.configLoading,
                      error: state.lastError,
                      formValue: state.configForm,
                      originalValue: state.configSnapshot?.config as Record<string, unknown> | null,
                      authStatus: state.configAuthStatus,
                      modelCatalogStatus: state.configModelCatalogStatus,
                      modelCatalog: providerModelCatalogForSetup,
                      configSaving: state.configSaving,
                      configDirty: state.configFormDirty,
                      authActionBusyProfileId: state.configAuthActionBusyProfileId,
                      authAction: state.configAuthAction,
                      onRefresh: () => loadConfig(state),
                      onOpenConfigSection: (section) => {
                        state.configActiveSection = section;
                        state.configActiveSubsection = null;
                        state.setTab("config");
                      },
                      onStoreProviderApiKey: (params) =>
                        void storeProviderApiKeyFromProviders(state, params),
                      onStoreManualProvider: (params) =>
                        void storeManualProviderFromProviders(state, params),
                      onRunProviderSignIn: (params) =>
                        void runProviderSignInFromProviders(state, params),
                      onAuthPromptSubmit: (value) => submitConfigAuthPrompt(state, value),
                      onAuthPromptCancel: () => cancelConfigAuthPrompt(state),
                      onAuthActionDismiss: () => dismissConfigAuthAction(state),
                      onStoreProfileCredential: (params) =>
                        storeProviderAuthCredential(state, params),
                      onRunInteractiveProfileAuth: (params) =>
                        runInteractiveProviderAuthCredential(state, params),
                      onClearProfileCredential: (profileId) =>
                        clearProviderAuthCredential(state, profileId),
                      onDefaultModelChange: (modelId) => {
                        if (modelId) {
                          updateConfigFormValue(state, ["agents", "defaults", "model"], modelId);
                        } else {
                          removeConfigFormValue(state, ["agents", "defaults", "model"]);
                        }
                      },
                      onSaveConfig: async () => {
                        await saveConfig(state);
                        if (state.lastError) {
                          return;
                        }
                        await Promise.all([loadSessions(state), loadAgents(state)]);
                      },
                      onNavigate: (tab) => state.setTab(tab),
                      surface: "agent",
                    })
                  : renderLazyTabPlaceholder("Providers", lazyTabViewErrors.providers),
                plugins: {
                  marketplace: state.debugPluginsMarketplace,
                },
                services: {
                  capabilities: state.servicesCapabilities,
                  capabilitiesLoading: state.servicesCapabilitiesLoading,
                  componentBusy: state.servicesComponentBusy,
                  componentMessage: state.servicesComponentMessage,
                  onComponentInstall: (id) => void installServiceComponent(state, id),
                  onComponentRestart: (id) => void restartServiceComponent(state, id),
                  gmailProvisioning: state.servicesGmailProvisioning,
                  gmailProvisionMessage: state.servicesGmailProvisionMessage,
                  webSearchTesting: state.servicesWebSearchTesting,
                  webSearchTestMessage: state.servicesWebSearchTestMessage,
                  webSearchProviders: state.servicesWebSearchProviders,
                  webSearchProvidersLoading: state.servicesWebSearchProvidersLoading,
                },
                wallet: {
                  status: state.walletStatus,
                  namedWallets: state.walletNamedWallets,
                  defaultWalletId: state.walletDefaultWalletId,
                },
                mining: {
                  attachedWalletId: state.miningAttachedWalletId,
                  profile: state.miningProfile,
                  readiness: state.miningReadiness,
                  status: state.miningStatus,
                },
                federation: {
                  token: state.federationToken,
                  status: state.federationStatus,
                },
                runtimeSessionKey,
                runtimeSessionMatchesSelectedAgent,
                modelCatalog: providerModelCatalogForSetup,
                modelCatalogLoading: state.chatModelsLoading,
                runnableModelCatalog: state.chatModelCatalog ?? [],
                skillEdits: state.skillEdits,
                skillsBusyKey: state.skillsBusyKey,
                skillsLibrary: skillsProps,
                onNavigate: (tab) => state.setTab(tab),
                onOpenUsageForAgent: (agentId) => {
                  const query = agentId ? `agent:${agentId}` : "";
                  state.usageQueryDraft = query;
                  state.usageQuery = query;
                  state.usageSelectedSessions = [];
                  state.usageSelectedDays = [];
                  state.usageSelectedHours = [];
                  state.tab = "usage";
                  void loadUsage(state);
                },
                onGmailProvision: () => provisionGmailService(state),
                onWebSearchTest: () => testWebSearchService(state),
                onRefresh: async () => {
                  await loadAgents(state);
                  const agentIds = state.agentsList?.agents?.map((entry) => entry.id) ?? [];
                  if (agentIds.length > 0) {
                    void loadAgentIdentities(state, agentIds);
                  }
                  if (resolvedAgentId) {
                    loadVisibleAgentTools(resolvedAgentId);
                  }
                },
                onCreateAgent: async (draft) => {
                  const result = await createAgent(state, draft);
                  if (!result?.agentId) {
                    return;
                  }
                  await loadConfig(state);
                  void loadAgentIdentity(state, result.agentId);
                  void loadAgentSkills(state, result.agentId);
                },
                onSelectAgent: (agentId) => {
                  if (state.agentsSelectedId === agentId) {
                    return;
                  }
                  state.agentsSelectedId = agentId;
                  state.agentFilesList = null;
                  state.agentFilesError = null;
                  state.agentFilesLoading = false;
                  state.agentFileActive = null;
                  state.agentFileContents = {};
                  state.agentFileDrafts = {};
                  state.agentSkillsReport = null;
                  state.agentSkillsError = null;
                  state.agentSkillsAgentId = null;
                  void loadAgentIdentity(state, agentId);
                  loadVisibleAgentTools(agentId);
                  if (!state.usageResult && !state.usageLoading) {
                    void loadUsage(state);
                  }
                  if (state.agentsPanel === "files") {
                    void loadAgentFiles(state, agentId);
                  }
                  if (state.agentsPanel === "tools") {
                    loadVisibleAgentTools(agentId);
                  }
                  if (state.agentsPanel === "skills") {
                    void loadAgentSkills(state, agentId);
                  }
                  if (state.agentsPanel === "memory") {
                    state.memoryInventory = null;
                    state.memoryValidation = null;
                    state.dreamingStatus = null;
                    state.dreamingStatusError = null;
                    void state.handleMemoryLoad();
                  }
                  if (state.agentsPanel === "cron") {
                    void state.loadCron();
                  }
                },
                onSelectPanel: (panel) => {
                  state.agentsPanel = panel;
                  if (panel === "files" && resolvedAgentId) {
                    if (state.agentFilesList?.agentId !== resolvedAgentId) {
                      state.agentFilesList = null;
                      state.agentFilesError = null;
                      state.agentFileActive = null;
                      state.agentFileContents = {};
                      state.agentFileDrafts = {};
                      void loadAgentFiles(state, resolvedAgentId);
                    }
                  }
                  if (panel === "tools" && resolvedAgentId) {
                    loadVisibleAgentTools(resolvedAgentId);
                  }
                  if (panel === "skills") {
                    if (resolvedAgentId) {
                      void loadAgentSkills(state, resolvedAgentId);
                    }
                  }
                  if (panel === "providers") {
                    void loadConfig(state);
                  }
                  if (panel === "coordination") {
                    void loadConfig(state);
                  }
                  if (panel === "sessions") {
                    void loadSessions(state);
                  }
                  if (panel === "channels") {
                    void loadChannels(state, false);
                  }
                  if (panel === "services") {
                    void loadServiceCapabilities(state);
                  }
                  if (panel === "cron") {
                    void state.loadCron();
                  }
                  if (panel === "memory") {
                    if (state.memoryInventory?.agentId !== resolvedAgentId) {
                      state.memoryInventory = null;
                      state.memoryValidation = null;
                      state.dreamingStatus = null;
                      state.dreamingStatusError = null;
                    }
                    void state.handleMemoryLoad();
                  }
                },
                onLoadFiles: (agentId) => loadAgentFiles(state, agentId),
                onSelectFile: (name) => {
                  state.agentFileActive = name;
                  if (!resolvedAgentId) {
                    return;
                  }
                  void loadAgentFileContent(state, resolvedAgentId, name);
                },
                onFileDraftChange: (name, content) => {
                  state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
                },
                onFileReset: (name) => {
                  const base = state.agentFileContents[name] ?? "";
                  state.agentFileDrafts = { ...state.agentFileDrafts, [name]: base };
                },
                onFileSave: (name) => {
                  if (!resolvedAgentId) {
                    return;
                  }
                  const content =
                    state.agentFileDrafts[name] ?? state.agentFileContents[name] ?? "";
                  void saveAgentFile(state, resolvedAgentId, name, content);
                },
                onToolsProfileChange: (agentId, profile, clearAllow) => {
                  if (!configValue) {
                    return;
                  }
                  const list = (configValue as { agents?: { list?: unknown[] } }).agents?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  const index = list.findIndex(
                    (entry) =>
                      entry &&
                      typeof entry === "object" &&
                      "id" in entry &&
                      (entry as { id?: string }).id === agentId,
                  );
                  if (index < 0) {
                    return;
                  }
                  const basePath = ["agents", "list", index, "tools"];
                  if (profile) {
                    updateConfigFormValue(state, [...basePath, "profile"], profile);
                  } else {
                    removeConfigFormValue(state, [...basePath, "profile"]);
                  }
                  if (clearAllow) {
                    removeConfigFormValue(state, [...basePath, "allow"]);
                  }
                  void saveConfig(state);
                },
                onToolsOverridesChange: (agentId, alsoAllow, deny) => {
                  if (!configValue) {
                    return;
                  }
                  const list = (configValue as { agents?: { list?: unknown[] } }).agents?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  const index = list.findIndex(
                    (entry) =>
                      entry &&
                      typeof entry === "object" &&
                      "id" in entry &&
                      (entry as { id?: string }).id === agentId,
                  );
                  if (index < 0) {
                    return;
                  }
                  const basePath = ["agents", "list", index, "tools"];
                  if (alsoAllow.length > 0) {
                    updateConfigFormValue(state, [...basePath, "alsoAllow"], alsoAllow);
                  } else {
                    removeConfigFormValue(state, [...basePath, "alsoAllow"]);
                  }
                  if (deny.length > 0) {
                    updateConfigFormValue(state, [...basePath, "deny"], deny);
                  } else {
                    removeConfigFormValue(state, [...basePath, "deny"]);
                  }
                  void saveConfig(state);
                },
                onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
                onConfigRemove: (path) => removeConfigFormValue(state, path),
                onConfigReload: () => loadConfig(state),
                onConfigSave: () => saveConfig(state),
                onSessionsRefresh: () => loadSessions(state),
                onSessionsSearchChange: (search) => {
                  state.sessionsFilterSearch = search;
                  void loadSessions(state);
                },
                onSessionPatch: (key, patch) => patchSession(state, key, patch),
                onSessionDelete: (key) => deleteSessionAndRefresh(state, key),
                onSessionBranchCheckpoint: (key, checkpointId) =>
                  branchSessionCheckpoint(state, key, checkpointId),
                onSessionRestoreCheckpoint: (key, checkpointId) =>
                  restoreSessionCheckpoint(state, key, checkpointId),
                onChannelsViewChange: (view) => {
                  state.channelsView = view;
                },
                onChannelsRefresh: () => loadChannels(state, false),
                onChannelEnable: (channelId) => state.handleChannelEnable(channelId),
                onChannelStart: (channelId, accountId) =>
                  startChannelRuntime(state, channelId, accountId),
                onChannelStop: (channelId, accountId) =>
                  stopChannelRuntime(state, channelId, accountId),
                onChannelLogout: (channelId, accountId) =>
                  state.handleChannelLogout(channelId, accountId),
                onCronRefresh: () => state.loadCron(),
                onCronEdit: (job) => openAgentTaskEditor(state, job),
                onCronRunNow: (jobId) => {
                  const job = state.cronJobs.find((entry) => entry.id === jobId);
                  if (job) {
                    void runCronTaskAndRefreshSessions(state, job);
                  }
                },
                onCronToggle: (job, enabled) => {
                  void toggleCronTaskAndRefreshSessions(state, job, enabled);
                },
                onCronQueueControl: (action, runId) => {
                  void controlCronQueueRunAndRefreshSessions(state, action, runId);
                },
                onTaskLedgerRefresh: () => {
                  void state.loadTaskLedger();
                },
                onTaskLedgerPageChange: (offset: number) => {
                  state.setTaskLedgerPageOffset(offset);
                },
                onTaskLedgerSourceFilterChange: (source) => {
                  state.setTaskLedgerSourceFilter(source);
                },
                onTaskLedgerTypeFilterChange: (type) => {
                  state.setTaskLedgerTypeFilter(type);
                },
                onTaskLedgerStatusFilterChange: (status) => {
                  state.setTaskLedgerStatusFilter(status);
                },
                onTaskLedgerDetailOpen: (taskId) => {
                  void state.loadTaskLedgerDetail(taskId);
                },
                onTaskLedgerControl: (action, taskId) => {
                  void state.controlTaskLedger(action, taskId);
                },
                onTaskLedgerOpenSource: (task) => {
                  if (task.taskKind === "workflow") {
                    const flow = state.taskFlowRuns?.flows.find(
                      (entry) =>
                        entry.currentTaskId === task.taskId ||
                        entry.blockedTaskId === task.taskId ||
                        entry.taskIds.includes(task.taskId),
                    );
                    if (flow?.definitionId) {
                      state.openTaskWorkflowRunGraph(flow);
                      return;
                    }
                  }
                  openTaskLedgerSourceSurface(state, task);
                },
                onTaskLedgerWorkflowReview: (agentId, task) => {
                  state.startTaskWorkflowFromLedgerTask(agentId, task);
                },
                onTaskWorkflowCreate: (agentId) => state.startTaskWorkflowCreate(agentId),
                onTaskWorkflowGraphCreate: (agentId) => state.startTaskWorkflowGraphCreate(agentId),
                onTaskWorkflowUseTemplate: (agentId, template) =>
                  state.startTaskWorkflowFromTemplate(agentId, template),
                onTaskTemplateUse: (agentId, template) => {
                  openAgentTaskCreate(state, agentId);
                  patchAgentTaskForm(state, buildCronTaskTemplatePatch(template));
                },
                onTaskWorkflowPatch: (patch) => state.patchTaskWorkflowDraft(patch),
                onTaskWorkflowGraphPatch: (patch) => state.patchTaskWorkflowGraphDraft(patch),
                onTaskWorkflowGraphAddNode: (type) => state.addTaskWorkflowGraphNode(type),
                onTaskWorkflowGraphUpdateNode: (nodeId, patch) =>
                  state.updateTaskWorkflowGraphNode(nodeId, patch),
                onTaskWorkflowGraphRemoveNode: (nodeId) =>
                  state.removeTaskWorkflowGraphNode(nodeId),
                onTaskWorkflowGraphMoveNode: (nodeId, x, y) =>
                  state.moveTaskWorkflowGraphNode(nodeId, x, y),
                onTaskWorkflowGraphAddEdge: (from, to, on) =>
                  state.addTaskWorkflowGraphEdge(from, to, on),
                onTaskWorkflowGraphUpdateEdge: (edgeId, patch) =>
                  state.updateTaskWorkflowGraphEdge(edgeId, patch),
                onTaskWorkflowGraphRemoveEdge: (edgeId) =>
                  state.removeTaskWorkflowGraphEdge(edgeId),
                onTaskWorkflowGraphAutoLayout: () => state.autoLayoutTaskWorkflowGraph(),
                onTaskWorkflowGraphImportJson: () => state.importTaskWorkflowGraphJson(),
                onTaskWorkflowGraphExportJson: () => state.exportTaskWorkflowGraphJson(),
                onTaskWorkflowPreview: (agentId) => void state.previewTaskWorkflow(agentId),
                onTaskWorkflowGraphPreview: (agentId) =>
                  void state.previewTaskWorkflowGraphDraft(agentId),
                onTaskWorkflowSave: (agentId) =>
                  void state.saveTaskWorkflowDefinitionDraft(agentId),
                onTaskWorkflowGraphSave: (agentId) =>
                  void state.saveTaskWorkflowGraphDefinitionDraft(agentId),
                onTaskWorkflowRun: (agentId) => void state.runTaskWorkflow(agentId),
                onTaskWorkflowGraphRun: (agentId) => void state.runTaskWorkflowGraphDraft(agentId),
                onTaskWorkflowEditDefinition: (definition) =>
                  state.editTaskWorkflowDefinition(definition),
                onTaskWorkflowEditGraphDefinition: (definition) =>
                  state.editTaskWorkflowGraphDefinition(definition),
                onTaskWorkflowRunDefinition: (definition) =>
                  void state.runTaskWorkflowDefinition(definition),
                onTaskWorkflowRemoveDefinition: (definition) =>
                  void state.removeTaskWorkflowDefinition(definition),
                onTaskWorkflowOpenRunGraph: (flow) => state.openTaskWorkflowRunGraph(flow),
                onTaskWorkflowCancelRun: (flow) => void state.cancelTaskFlowRun(flow),
                onTaskWorkflowCancel: () => state.cancelTaskWorkflowDraft(),
                onTaskStandingOrderCreate: (agentId) => state.startTaskStandingOrderCreate(agentId),
                onTaskStandingOrderEdit: (order) => state.editTaskStandingOrder(order),
                onTaskStandingOrderPatch: (patch) => state.patchTaskStandingOrderDraft(patch),
                onTaskStandingOrderSave: (agentId) =>
                  void state.saveTaskStandingOrderDraft(agentId),
                onTaskStandingOrderRemove: (order) => void state.removeTaskStandingOrder(order),
                onTaskStandingOrderPropose: (order) => void state.proposeTaskStandingOrder(order),
                onTaskStandingOrderCancel: () => state.cancelTaskStandingOrderDraft(),
                onCronRepair: (job, action, opts) => {
                  void repairCronTaskAndRefreshSessions(state, job, action, opts);
                },
                onCronApproveCoordination: (job) => {
                  void approveCronTaskCoordinationAndRefreshSessions(state, job);
                },
                onCronAskAgentEvidence: (job) => {
                  void askCronTaskAgentEvidenceAndRefreshSessions(state, job);
                },
                onCronSourceToggle: (source, active) => {
                  void updateCronTrustedSourceAndRefreshSessions(state, source.id, active);
                },
                onCronSourceRemove: (source) => {
                  void removeCronTrustedSourceAndRefreshSessions(state, source.id);
                },
                onCronRunDetail: (runId) => {
                  void loadCronRunDetail(state, runId);
                },
                onCronRemove: (job) => {
                  void removeCronTaskAndRefreshSessions(state, job);
                },
                onCronCreate: (agentId) => openAgentTaskCreate(state, agentId),
                onWebhookTriggerCreate: (agentId) => state.startWebhookTriggerCreate(agentId),
                onWebhookTriggerEdit: (trigger) => state.editWebhookTrigger(trigger),
                onWebhookTriggerPatch: (patch) => state.patchWebhookTriggerDraft(patch),
                onWebhookTriggerSave: () => void state.saveWebhookTriggerDraft(),
                onWebhookTriggerCancel: () => state.cancelWebhookTriggerEdit(),
                onWebhookTriggerRemove: (trigger) => void state.removeWebhookTrigger(trigger),
                onWebhookTriggerToggle: (trigger, enabled) =>
                  void state.toggleWebhookTrigger(trigger, enabled),
                onWebhookTriggerTest: (trigger) => void state.testWebhookTrigger(trigger),
                onCronOpenSession: (sessionKey) => {
                  openTaskRunTranscript(state, sessionKey);
                },
                onMemoryWikiRebuild: () => void state.handleMemoryWikiRebuild(),
                onTaskFiltersChange: (patch) => {
                  if (typeof patch.query === "string") {
                    state.agentTaskQuery = patch.query;
                  }
                  if (patch.status) {
                    state.agentTaskStatusFilter = patch.status;
                  }
                  if (patch.adaptiveRoute) {
                    state.agentTaskAdaptiveRouteFilter = patch.adaptiveRoute;
                  }
                  if (patch.sortDir) {
                    state.agentTaskSortDir = patch.sortDir;
                  }
                },
                onSkillsFilterChange: (next) => (state.skillsFilter = next),
                onSkillsRefresh: () => {
                  if (resolvedAgentId) {
                    void loadAgentSkills(state, resolvedAgentId);
                  }
                },
                onSkillEdit: (skillKey, value) => updateSkillEdit(state, skillKey, value),
                onSkillSaveKey: (skillKey) => {
                  void saveSkillApiKey(state, skillKey);
                },
                onSkillInstall: (skillKey, name, installId) => {
                  void installSkill(state, skillKey, name, installId);
                },
                onSkillEnabledChange: (skillKey, enabled) => {
                  void updateSkillEnabled(state, skillKey, enabled);
                },
                onSessionMemoryEnabledChange: (enabled) => {
                  if (!configValue) {
                    return;
                  }
                  updateConfigFormValue(state, ["hooks", "internal", "enabled"], true);
                  updateConfigFormValue(
                    state,
                    ["hooks", "internal", "entries", "session-memory", "enabled"],
                    enabled,
                  );
                },
                onAgentSkillToggle: (agentId, skillName, enabled) => {
                  if (!configValue) {
                    return;
                  }
                  const list = (configValue as { agents?: { list?: unknown[] } }).agents?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  const index = list.findIndex(
                    (entry) =>
                      entry &&
                      typeof entry === "object" &&
                      "id" in entry &&
                      (entry as { id?: string }).id === agentId,
                  );
                  if (index < 0) {
                    return;
                  }
                  const entry = list[index] as { skills?: unknown };
                  const normalizedSkill = skillName.trim();
                  if (!normalizedSkill) {
                    return;
                  }
                  const allSkills =
                    state.agentSkillsReport?.skills?.map((skill) => skill.name).filter(Boolean) ??
                    [];
                  const existing = Array.isArray(entry.skills)
                    ? entry.skills.map((name) => String(name).trim()).filter(Boolean)
                    : undefined;
                  const base = existing ?? allSkills;
                  const next = new Set(base);
                  if (enabled) {
                    next.add(normalizedSkill);
                  } else {
                    next.delete(normalizedSkill);
                  }
                  updateConfigFormValue(state, ["agents", "list", index, "skills"], [...next]);
                  void saveConfig(state);
                },
                onAgentSkillsClear: (agentId) => {
                  if (!configValue) {
                    return;
                  }
                  const list = (configValue as { agents?: { list?: unknown[] } }).agents?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  const index = list.findIndex(
                    (entry) =>
                      entry &&
                      typeof entry === "object" &&
                      "id" in entry &&
                      (entry as { id?: string }).id === agentId,
                  );
                  if (index < 0) {
                    return;
                  }
                  removeConfigFormValue(state, ["agents", "list", index, "skills"]);
                  void saveConfig(state);
                },
                onAgentSkillsNarrowToSelected: (agentId) => {
                  if (!configValue) {
                    return;
                  }
                  const list = (configValue as { agents?: { list?: unknown[] } }).agents?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  const index = list.findIndex(
                    (entry) =>
                      entry &&
                      typeof entry === "object" &&
                      "id" in entry &&
                      (entry as { id?: string }).id === agentId,
                  );
                  if (index < 0) {
                    return;
                  }
                  const skills = Array.from(
                    new Set(
                      (state.agentSkillsReport?.skills ?? [])
                        .map((skill) => skill.name.trim())
                        .filter(Boolean),
                    ),
                  );
                  updateConfigFormValue(state, ["agents", "list", index, "skills"], skills);
                  void saveConfig(state);
                },
                onAgentSkillsDisableAll: (agentId) => {
                  if (!configValue) {
                    return;
                  }
                  const list = (configValue as { agents?: { list?: unknown[] } }).agents?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  const index = list.findIndex(
                    (entry) =>
                      entry &&
                      typeof entry === "object" &&
                      "id" in entry &&
                      (entry as { id?: string }).id === agentId,
                  );
                  if (index < 0) {
                    return;
                  }
                  updateConfigFormValue(state, ["agents", "list", index, "skills"], []);
                  void saveConfig(state);
                },
                onOpenSkillDetail: (skillKey, agentId) => {
                  closeSkillEditor(state);
                  state.skillsAttachAgentId = agentId;
                  state.skillsLibraryPanel = "skills";
                  state.skillsDetailKey = skillKey;
                  if (!state.skillsReport && state.agentSkillsReport) {
                    state.skillsReport = state.agentSkillsReport;
                  }
                  state.requestUpdate();
                },
                onCreateSkill: (agentId) => {
                  state.skillCreateAgentId = agentId;
                  openSkillCreateDialog(state);
                  state.requestUpdate();
                },
                onModelChange: (agentId, modelId) => {
                  const current = readAgentConfigEntry(state, agentId);
                  const { basePath, entry } = modelId
                    ? ensureAgentConfigEntry(state, agentId)
                    : current;
                  if (!basePath) {
                    return;
                  }
                  const modelPath = [...basePath, "model"];
                  if (!modelId) {
                    removeConfigFormValue(state, modelPath);
                    return;
                  }
                  const existing = entry?.model;
                  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
                    const fallbacks = normalizeAgentModelFallbackValues(
                      (existing as { fallbacks?: unknown }).fallbacks,
                    );
                    const next = {
                      primary: modelId,
                      ...(fallbacks !== undefined ? { fallbacks } : {}),
                    };
                    updateConfigFormValue(state, modelPath, next);
                  } else {
                    updateConfigFormValue(state, modelPath, modelId);
                  }
                },
                onModelFallbacksChange: (agentId, fallbacks) => {
                  const normalized = normalizeAgentModelFallbackValues(fallbacks) ?? [];
                  const current = readAgentConfigEntry(state, agentId);
                  const { basePath, entry } =
                    normalized.length > 0 ? ensureAgentConfigEntry(state, agentId) : current;
                  if (!basePath) {
                    return;
                  }
                  const modelPath = [...basePath, "model"];
                  const existing = entry?.model;
                  const resolvePrimary = () => {
                    if (typeof existing === "string") {
                      return existing.trim() || null;
                    }
                    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
                      const primary = (existing as { primary?: unknown }).primary;
                      if (typeof primary === "string") {
                        const trimmed = primary.trim();
                        return trimmed || null;
                      }
                    }
                    return null;
                  };
                  const primary = resolvePrimary();
                  if (normalized.length === 0) {
                    if (primary) {
                      updateConfigFormValue(state, modelPath, primary);
                    } else {
                      removeConfigFormValue(state, modelPath);
                    }
                    return;
                  }
                  const next = primary
                    ? { primary, fallbacks: normalized }
                    : { fallbacks: normalized };
                  updateConfigFormValue(state, modelPath, next);
                },
                onTaskModelsChange: (agentId, taskModels) => {
                  const normalized = Object.fromEntries(
                    Object.entries(taskModels)
                      .map(([key, value]) => [key, value?.trim?.() ?? ""] as const)
                      .filter(([, value]) => Boolean(value)),
                  );
                  const current = readAgentConfigEntry(state, agentId);
                  const { basePath } =
                    Object.keys(normalized).length > 0
                      ? ensureAgentConfigEntry(state, agentId)
                      : current;
                  if (!basePath) {
                    return;
                  }
                  const taskModelsPath = [...basePath, "taskModels"];
                  if (Object.keys(normalized).length === 0) {
                    removeConfigFormValue(state, taskModelsPath);
                    return;
                  }
                  updateConfigFormValue(state, taskModelsPath, normalized);
                },
                onAgentIdentityAvatarChange: (agentId, avatar) => {
                  const { basePath } = readAgentConfigEntry(state, agentId);
                  if (!basePath) {
                    return;
                  }
                  const avatarPath = [...basePath, "identity", "avatar"];
                  const normalized = avatar?.trim() ?? "";
                  if (!normalized) {
                    removeConfigFormValue(state, avatarPath);
                    writeCachedAgentAvatar(agentId, "");
                    const previous = state.agentIdentityById[agentId];
                    if (previous) {
                      state.agentIdentityById = {
                        ...state.agentIdentityById,
                        [agentId]: { ...previous, avatar: "" },
                      };
                    }
                    return;
                  }
                  updateConfigFormValue(state, avatarPath, normalized);
                  writeCachedAgentAvatar(agentId, normalized);
                  const agentName =
                    state.agentsList?.agents.find((entry) => entry.id === agentId)?.name?.trim() ||
                    agentId;
                  state.agentIdentityById = {
                    ...state.agentIdentityById,
                    [agentId]: {
                      agentId,
                      name: state.agentIdentityById[agentId]?.name || agentName,
                      avatar: normalized,
                      emoji: state.agentIdentityById[agentId]?.emoji,
                    },
                  };
                },
                onActiveModelProviderChange: (agentId, providerId) => {
                  const normalized =
                    typeof providerId === "string" ? providerId.trim().toLowerCase() : "";
                  const current = readAgentConfigEntry(state, agentId);
                  const { basePath } = normalized
                    ? ensureAgentConfigEntry(state, agentId)
                    : current;
                  if (!basePath) {
                    return;
                  }
                  const activeProviderPath = [...basePath, "activeModelProvider"];
                  if (!normalized) {
                    removeConfigFormValue(state, activeProviderPath);
                    return;
                  }
                  updateConfigFormValue(state, activeProviderPath, normalized);
                },
                onModelProviderChange: (agentId, providerId, providerConfig) => {
                  const provider = providerId.trim().toLowerCase();
                  if (!provider) {
                    return;
                  }
                  const normalized = providerConfig
                    ? {
                        ...(providerConfig.profileId?.trim()
                          ? { profileId: providerConfig.profileId.trim() }
                          : {}),
                        ...(providerConfig.primary?.trim()
                          ? { primary: providerConfig.primary.trim() }
                          : {}),
                        ...(Array.isArray(providerConfig.fallbacks)
                          ? {
                              fallbacks:
                                normalizeAgentModelFallbackValues(providerConfig.fallbacks) ?? [],
                            }
                          : {}),
                        ...(providerConfig.taskModels &&
                        Object.values(providerConfig.taskModels).some((entry) => entry?.trim())
                          ? {
                              taskModels: Object.fromEntries(
                                Object.entries(providerConfig.taskModels)
                                  .map(([key, value]) => [key, value?.trim?.() ?? ""] as const)
                                  .filter(([, value]) => Boolean(value)),
                              ),
                            }
                          : {}),
                      }
                    : null;
                  const current = readAgentConfigEntry(state, agentId);
                  const { basePath } =
                    normalized && Object.keys(normalized).length > 0
                      ? ensureAgentConfigEntry(state, agentId)
                      : current;
                  if (!basePath) {
                    return;
                  }
                  const providerPath = [...basePath, "modelProviders", provider];
                  if (!normalized || Object.keys(normalized).length === 0) {
                    removeConfigFormValue(state, providerPath);
                    return;
                  }
                  updateConfigFormValue(state, providerPath, normalized);
                },
                onSetDefault: (agentId) => {
                  const currentConfig =
                    state.configForm ??
                    (state.configSnapshot?.config as Record<string, unknown> | null);
                  const list = (currentConfig as { agents?: { list?: unknown[] } } | null)?.agents
                    ?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  for (const [index, entry] of list.entries()) {
                    if (!entry || typeof entry !== "object" || !("id" in entry)) {
                      continue;
                    }
                    const currentId = String((entry as { id?: string }).id ?? "").trim();
                    if (!currentId) {
                      continue;
                    }
                    if (currentId === agentId) {
                      updateConfigFormValue(state, ["agents", "list", index, "default"], true);
                    } else {
                      removeConfigFormValue(state, ["agents", "list", index, "default"]);
                    }
                  }
                  if (state.agentsList) {
                    state.agentsList = {
                      ...state.agentsList,
                      defaultId: agentId,
                    };
                  }
                },
              })
            : nothing
        }

        ${
          state.tab === "skills"
            ? renderSkills({
                connected: state.connected,
                loading: state.skillsLoading,
                report: state.skillsReport,
                error: state.skillsError,
                libraryPanel: state.skillsLibraryPanel,
                filter: state.skillsFilter,
                statusFilter: state.skillsStatusFilter,
                edits: state.skillEdits,
                envEdits: state.skillEnvEdits,
                configEdits: state.skillConfigEdits,
                messages: state.skillMessages,
                createOpen: state.skillCreateOpen,
                createName: state.skillCreateName,
                createDescription: state.skillCreateDescription,
                createAgentId: state.skillCreateAgentId,
                createTemplate: state.skillCreateTemplate,
                createBusy: state.skillCreateBusy,
                createError: state.skillCreateError,
                busyKey: state.skillsBusyKey,
                skillEditor: state.skillEditor,
                skillEditorDraft: state.skillEditorDraft,
                skillEditorLoading: state.skillEditorLoading,
                skillEditorSaving: state.skillEditorSaving,
                skillEditorError: state.skillEditorError,
                detailKey: state.skillsDetailKey,
                attachAgentId: state.skillsAttachAgentId,
                configForm:
                  state.configForm ??
                  (state.configSnapshot?.config as Record<string, unknown> | null) ??
                  null,
                clawhubQuery: state.clawhubSearchQuery,
                clawhubResults: state.clawhubSearchResults,
                clawhubSearchLoading: state.clawhubSearchLoading,
                clawhubSearchError: state.clawhubSearchError,
                clawhubDetail: state.clawhubDetail,
                clawhubDetailSlug: state.clawhubDetailSlug,
                clawhubDetailLoading: state.clawhubDetailLoading,
                clawhubDetailError: state.clawhubDetailError,
                clawhubInstallSlug: state.clawhubInstallSlug,
                clawhubInstallMessage: state.clawhubInstallMessage,
                clawhubReview: state.clawhubReview,
                clawhubReviewLoading: state.clawhubReviewLoading,
                clawhubReviewError: state.clawhubReviewError,
                clawhubInstallTarget: state.clawhubInstallTarget,
                agentsList: state.agentsList,
                onLibraryPanelChange: (panel) => {
                  state.skillsLibraryPanel = panel;
                },
                onFilterChange: (next) => (state.skillsFilter = next),
                onStatusFilterChange: (next) => (state.skillsStatusFilter = next),
                onRefresh: () => loadSkills(state, { clearMessages: true }),
                onToggle: (key, enabled) => updateSkillEnabled(state, key, enabled),
                onEdit: (key, value) => updateSkillEdit(state, key, value),
                onEnvEdit: (key, envName, value) => updateSkillEnvEdit(state, key, envName, value),
                onConfigEdit: (key, value) => updateSkillConfigEdit(state, key, value),
                onSaveKey: (key) => saveSkillApiKey(state, key),
                onSaveEnv: (key) => saveSkillEnv(state, key),
                onSaveConfig: (key) => saveSkillConfig(state, key),
                onSaveRootConfig: (skillKey, path, json) => {
                  void (async () => {
                    state.skillsBusyKey = skillKey;
                    state.skillsError = null;
                    try {
                      const segments = path
                        .split(".")
                        .map((part) => part.trim())
                        .filter(Boolean);
                      if (segments.length === 0) {
                        throw new Error("Config path is empty.");
                      }
                      const parsed = json.trim() ? JSON.parse(json) : {};
                      updateConfigFormValue(state, segments, parsed);
                      await saveConfig(state);
                      if (state.lastError) {
                        throw new Error(state.lastError);
                      }
                      state.skillMessages = {
                        ...state.skillMessages,
                        [skillKey]: {
                          kind: "success",
                          message: `Saved ${path} in gateway config.`,
                        },
                      };
                      await loadSkills(state);
                    } catch (err) {
                      const message = err instanceof Error ? err.message : String(err);
                      state.skillsError = message;
                      state.skillMessages = {
                        ...state.skillMessages,
                        [skillKey]: { kind: "error", message },
                      };
                    } finally {
                      state.skillsBusyKey = null;
                      state.requestUpdate();
                    }
                  })();
                },
                onInstall: (skillKey, name, installId) =>
                  installSkill(state, skillKey, name, installId),
                onTestSkill: (_skillKey, name) => {
                  state.chatMessage = `Use the ${name} skill. Confirm the loaded skill name, then run a smoke test on: "smoke check". Return three lines: Skill, Steps, Result.`;
                  closeSkillEditor(state);
                  state.skillsDetailKey = null;
                  state.tab = "chat";
                  state.requestUpdate();
                },
                onCopyToWorkspace: (skillKey, agentId) =>
                  void copySkillToWorkspace(state, skillKey, agentId),
                onCreateOpen: () => {
                  openSkillCreateDialog(state);
                  state.requestUpdate();
                },
                onCreateClose: () => {
                  closeSkillCreateDialog(state);
                  state.requestUpdate();
                },
                onCreateDraftChange: (patch) =>
                  updateSkillCreateDraft(state, {
                    ...(patch.createName !== undefined
                      ? { skillCreateName: patch.createName }
                      : {}),
                    ...(patch.createDescription !== undefined
                      ? { skillCreateDescription: patch.createDescription }
                      : {}),
                    ...(patch.createAgentId !== undefined
                      ? { skillCreateAgentId: patch.createAgentId }
                      : {}),
                    ...(patch.createTemplate !== undefined
                      ? { skillCreateTemplate: patch.createTemplate }
                      : {}),
                  }),
                onCreateSave: () => void createSkill(state),
                onOpenEditor: (skillKey) => void openSkillEditor(state, skillKey),
                onCloseEditor: () => {
                  closeSkillEditor(state);
                  state.requestUpdate();
                },
                onEditorDraftChange: (draft) => updateSkillEditorDraft(state, draft),
                onSaveEditor: () => void saveSkillEditor(state),
                onDetailOpen: (skillKey) => {
                  closeSkillEditor(state);
                  state.skillsDetailKey = skillKey;
                  state.requestUpdate();
                },
                onDetailClose: () => {
                  closeSkillEditor(state);
                  state.skillsDetailKey = null;
                  state.requestUpdate();
                },
                onAttachAgentChange: (agentId) => (state.skillsAttachAgentId = agentId),
                onAttachToAgent: (skillKey, agentId) =>
                  void attachSkillToAgent(state, skillKey, agentId),
                onOpenAgentSkills: (agentId) => {
                  state.agentsSelectedId = agentId;
                  state.agentsPanel = "skills";
                  state.tab = "agents";
                  state.requestUpdate();
                },
                onOpenAgentTools: (agentId) => {
                  state.agentsSelectedId = agentId;
                  state.agentsPanel = "tools";
                  state.tab = "agents";
                  state.requestUpdate();
                },
                onClawHubQueryChange: (query) => {
                  setClawHubSearchQuery(state, query);
                  void searchClawHub(state, query.trim());
                },
                onClawHubTargetChange: (target) => setClawHubInstallTarget(state, target),
                onClawHubDetailOpen: (slug) => void loadClawHubDetail(state, slug),
                onClawHubDetailClose: () => closeClawHubDetail(state),
                onClawHubInstall: (slug) => void installFromClawHub(state, slug),
                onClawHubUpdatePreview: (slug) => void previewClawHubUpdate(state, slug),
                onClawHubReviewClose: () => closeClawHubReview(state),
                onClawHubReviewConfirm: () => void confirmClawHubMarketplaceReview(state),
              })
            : nothing
        }

        ${state.tab !== "skills" ? renderSkillDialogs(skillsProps) : nothing}

        ${
          state.tab === "plugins"
            ? renderPluginsMarketplace({
                connected: state.connected,
                loading: state.pluginsMarketplaceLoading,
                detailLoading: state.pluginsMarketplaceDetailLoading,
                error: state.pluginsMarketplaceError,
                message: state.pluginsMarketplaceMessage,
                actionBusy: state.pluginsMarketplaceActionBusy,
                remediation: state.pluginsMarketplaceRemediation,
                hooksLoading: state.extensionsHooksLoading,
                hooksError: state.extensionsHooksError,
                hooksMessage: state.extensionsHooksMessage,
                hooksStatus: state.extensionsHooksStatus,
                hooksBusyKey: state.extensionsHooksBusyKey,
                report: state.pluginsMarketplaceList,
                detail: state.pluginsMarketplaceDetail,
                selectedId: state.pluginsMarketplaceSelectedId,
                onRefresh: () => {
                  void Promise.all([loadPluginMarketplace(state), loadExtensionsHooks(state)]);
                },
                onHooksRefresh: () => loadExtensionsHooks(state),
                onSetHookEnabled: (name, enabled) =>
                  void setExtensionHookEnabled(state, name, enabled),
                onSelect: (id) => selectPluginMarketplaceEntry(state, id),
                onInstall: (id, sourceChoice) =>
                  void installPluginMarketplaceEntry(state, id, sourceChoice),
                onRestartRuntime: (id) => void restartPluginMarketplaceRuntime(state, id),
                onUpdate: (id) => void updatePluginMarketplaceEntry(state, id),
                onUninstall: (id) => void uninstallPluginMarketplaceEntry(state, id),
                onSetSessionHelperGrant: (id, enabled) =>
                  void setPluginMarketplaceSessionHelperGrant(state, id, enabled),
                onSetAdminRpcGrant: (id, method, enabled) =>
                  void setPluginMarketplaceAdminRpcGrant(state, id, method, enabled),
                onOpenConfigSection: (section) => {
                  state.tab = "config";
                  state.configActiveSection = section;
                  state.configActiveSubsection = null;
                },
                onOpenChannels: () => {
                  state.tab = "channels";
                },
                onOpenTab: (tab) => {
                  state.tab = tab;
                },
              })
            : nothing
        }

        ${
          state.tab === "nodes"
            ? renderNodes({
                loading: state.nodesLoading,
                nodes: state.nodes,
                commandsCatalogLoading: state.commandsCatalogLoading,
                commandsCatalogError: state.commandsCatalogError,
                commandsCatalog: state.commandsCatalog,
                commandsCatalogScope: state.commandsCatalogScope,
                devicesLoading: state.devicesLoading,
                devicesError: state.devicesError,
                devicesList: state.devicesList,
                configForm:
                  state.configForm ??
                  (state.configSnapshot?.config as Record<string, unknown> | null),
                configLoading: state.configLoading,
                configSaving: state.configSaving,
                configDirty: state.configFormDirty,
                configFormMode: state.configFormMode,
                execApprovalsLoading: state.execApprovalsLoading,
                execApprovalsSaving: state.execApprovalsSaving,
                execApprovalsDirty: state.execApprovalsDirty,
                execApprovalsSnapshot: state.execApprovalsSnapshot,
                execApprovalsForm: state.execApprovalsForm,
                execApprovalsSelectedAgent: state.execApprovalsSelectedAgent,
                execApprovalsTarget: state.execApprovalsTarget,
                execApprovalsTargetNodeId: state.execApprovalsTargetNodeId,
                onRefresh: () => loadNodes(state),
                onCommandsRefresh: () => loadCommandsCatalog(state),
                onCommandsScopeChange: (scope: CommandsCatalogScope) => {
                  state.commandsCatalogScope = scope;
                  void loadCommandsCatalog(state);
                },
                onDevicesRefresh: () => loadDevices(state),
                onDeviceApprove: (requestId) => approveDevicePairing(state, requestId),
                onDeviceReject: (requestId) => rejectDevicePairing(state, requestId),
                onDeviceRotate: (deviceId, role, scopes) =>
                  rotateDeviceToken(state, { deviceId, role, scopes }),
                onDeviceRevoke: (deviceId, role) => revokeDeviceToken(state, { deviceId, role }),
                onLoadConfig: () => loadConfig(state),
                onLoadExecApprovals: () => {
                  const target =
                    state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                      ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                      : { kind: "gateway" as const };
                  return loadExecApprovals(state, target);
                },
                onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
                onConfigRemove: (path) => removeConfigFormValue(state, path),
                onSaveConfig: () => saveConfig(state),
                onBindDefault: (nodeId) => {
                  if (nodeId) {
                    updateConfigFormValue(state, ["tools", "exec", "node"], nodeId);
                  } else {
                    removeConfigFormValue(state, ["tools", "exec", "node"]);
                  }
                },
                onBindAgent: (agentIndex, nodeId) => {
                  const basePath = ["agents", "list", agentIndex, "tools", "exec", "node"];
                  if (nodeId) {
                    updateConfigFormValue(state, basePath, nodeId);
                  } else {
                    removeConfigFormValue(state, basePath);
                  }
                },
                onSaveBindings: () => saveConfig(state),
                onExecApprovalsTargetChange: (kind, nodeId) => {
                  state.execApprovalsTarget = kind;
                  state.execApprovalsTargetNodeId = nodeId;
                  state.execApprovalsSnapshot = null;
                  state.execApprovalsForm = null;
                  state.execApprovalsDirty = false;
                  state.execApprovalsSelectedAgent = null;
                },
                onExecApprovalsSelectAgent: (agentId) => {
                  state.execApprovalsSelectedAgent = agentId;
                },
                onExecApprovalsPatch: (path, value) =>
                  updateExecApprovalsFormValue(state, path, value),
                onExecApprovalsRemove: (path) => removeExecApprovalsFormValue(state, path),
                onSaveExecApprovals: () => {
                  const target =
                    state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                      ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                      : { kind: "gateway" as const };
                  return saveExecApprovals(state, target);
                },
              })
            : nothing
        }

        ${
          state.tab === "chat"
            ? renderChat({
                sessionKey: state.sessionKey,
                onSessionKeyChange: (next) => {
                  state.sessionKey = next;
                  state.chatMessage = "";
                  state.chatAttachments = [];
                  state.chatTranscriptSearch = "";
                  state.chatStream = null;
                  state.chatStreamStartedAt = null;
                  state.chatRunId = null;
                  state.chatQueue = [];
                  state.resetToolStream();
                  state.resetChatScroll();
                  state.applySettings({
                    ...state.settings,
                    sessionKey: next,
                    lastActiveSessionKey: next,
                  });
                  void state.loadAssistantIdentity();
                  void subscribeActiveSessionMessages(state);
                  void loadChatHistory(state);
                  void loadCurrentChatSessionUsage(state);
                  void refreshChatAvatar(state);
                },
                thinkingLevel: state.chatThinkingLevel,
                showThinking,
                showToolCalls,
                loading: state.chatLoading,
                sending: state.chatSending,
                compactionStatus: state.compactionStatus
                  ? {
                      active: state.compactionStatus.phase !== "complete",
                      startedAt: state.compactionStatus.startedAt,
                      completedAt: state.compactionStatus.completedAt,
                    }
                  : null,
                assistantAvatarUrl: chatAvatarUrl,
                messages: state.chatMessages,
                toolMessages: state.chatToolMessages,
                stream: state.chatStream,
                streamStartedAt: state.chatStreamStartedAt,
                draft: state.chatMessage,
                queue: state.chatQueue,
                connected: state.connected,
                canSend: state.connected,
                disabledReason: chatDisabledReason,
                error: state.lastError,
                sessions: state.sessionsResult,
                sessionUsage: state.chatSessionUsage,
                sessionUsageLoading: state.chatSessionUsageLoading,
                sessionUsageVisible: state.settings.chatSessionUsageVisible,
                onToggleSessionUsage: () =>
                  state.applySettings({
                    ...state.settings,
                    chatSessionUsageVisible: !state.settings.chatSessionUsageVisible,
                  }),
                transcriptSearch: state.chatTranscriptSearch,
                transcriptSearchIndex: state.chatTranscriptSearchIndex,
                onTranscriptSearchChange: (next) => {
                  state.chatTranscriptSearch = next;
                  state.chatTranscriptSearchIndex = 0;
                },
                scheduleTask: state.chatScheduleDraft,
                scheduleTaskBusy: state.cronBusy,
                scheduleDeliveryLabel: resolveChatScheduleDelivery(state)?.label ?? null,
                scheduleAgentId: resolveChatScheduleAgentId(state),
                scheduleAgentOptions: state.agentsList?.agents ?? [],
                onScheduleTaskOpen: () => openChatScheduleTask(state),
                onScheduleTaskClose: () => closeChatScheduleTask(state),
                onScheduleTaskChange: (patch) => {
                  state.chatScheduleDraft = {
                    ...state.chatScheduleDraft,
                    ...patch,
                    error: null,
                  };
                },
                onScheduleTaskSubmit: () => void submitChatScheduleTask(state),
                taskJobs: state.cronJobs,
                taskLoading: state.cronLoading,
                onTaskEdit: (job) => openChatTaskEditor(state, job),
                onTaskRun: (job) => void runCronTaskAndRefreshSessions(state, job),
                onTaskOpenRun: (sessionKey) => openTaskRunTranscript(state, sessionKey),
                onTaskToggle: (job, enabled) =>
                  void toggleCronTaskAndRefreshSessions(state, job, enabled),
                onTaskCancel: (job) => void removeCronTaskAndRefreshSessions(state, job),
                deliveryMode: state.settings.chatDeliveryMode,
                onDeliveryModeChange: (mode) =>
                  state.applySettings({
                    ...state.settings,
                    chatDeliveryMode: mode,
                  }),
                commandEntries: state.commandsCatalog?.commands ?? [],
                commandHelpersCollapsed: state.settings.chatCommandHelpersCollapsed,
                onToggleCommandHelpers: () =>
                  state.applySettings({
                    ...state.settings,
                    chatCommandHelpersCollapsed: !state.settings.chatCommandHelpersCollapsed,
                  }),
                focusMode: chatFocus,
                onRefresh: () => {
                  state.resetToolStream();
                  return Promise.all([
                    loadChatHistory(state),
                    loadCurrentChatSessionUsage(state),
                    refreshChatAvatar(state),
                  ]);
                },
                onToggleFocusMode: () => {
                  if (state.onboarding) {
                    return;
                  }
                  state.applySettings({
                    ...state.settings,
                    chatFocusMode: !state.settings.chatFocusMode,
                  });
                },
                onChatScroll: (event) => state.handleChatScroll(event),
                onDraftChange: (next) => (state.chatMessage = next),
                attachments: state.chatAttachments,
                onAttachmentsChange: (next) => (state.chatAttachments = next),
                composerControls: renderChatComposerControls(state),
                onSend: () => state.handleSendChat(),
                canAbort: Boolean(state.chatRunId),
                onAbort: () => void state.handleAbortChat(),
                onQueueRemove: (id) => state.removeQueuedMessage(id),
                onNewSession: () => state.handleSendChat("/new", { restoreDraft: true }),
                showNewMessages: state.chatNewMessagesBelow && !state.chatManualRefreshInFlight,
                onScrollToBottom: () => state.scrollToBottom(),
                // Sidebar props for tool output viewing
                sidebarOpen: state.sidebarOpen,
                sidebarContent: state.sidebarContent,
                sidebarError: state.sidebarError,
                splitRatio: state.splitRatio,
                onOpenSidebar: (content: string) => state.handleOpenSidebar(content),
                onCloseSidebar: () => state.handleCloseSidebar(),
                onSplitRatioChange: (ratio: number) => state.handleSplitRatioChange(ratio),
                assistantName: state.assistantName,
                assistantAvatar: state.assistantAvatar,
              })
            : nothing
        }

        ${
          state.tab === "providers"
            ? providersView
              ? providersView.renderProviders({
                  connected: state.connected,
                  loading: state.configLoading,
                  error: state.lastError,
                  formValue: state.configForm,
                  originalValue: state.configSnapshot?.config as Record<string, unknown> | null,
                  authStatus: state.configAuthStatus,
                  modelCatalogStatus: state.configModelCatalogStatus,
                  modelCatalog: providerModelCatalogForSetup,
                  configSaving: state.configSaving,
                  configDirty: state.configFormDirty,
                  authActionBusyProfileId: state.configAuthActionBusyProfileId,
                  authAction: state.configAuthAction,
                  onRefresh: () => loadConfig(state),
                  onOpenConfigSection: (section) => {
                    state.configActiveSection = section;
                    state.configActiveSubsection = null;
                    state.setTab("config");
                  },
                  onStoreProviderApiKey: (params) =>
                    void storeProviderApiKeyFromProviders(state, params),
                  onStoreManualProvider: (params) =>
                    void storeManualProviderFromProviders(state, params),
                  onRunProviderSignIn: (params) =>
                    void runProviderSignInFromProviders(state, params),
                  onAuthPromptSubmit: (value) => submitConfigAuthPrompt(state, value),
                  onAuthPromptCancel: () => cancelConfigAuthPrompt(state),
                  onAuthActionDismiss: () => dismissConfigAuthAction(state),
                  onStoreProfileCredential: (params) => storeProviderAuthCredential(state, params),
                  onRunInteractiveProfileAuth: (params) =>
                    runInteractiveProviderAuthCredential(state, params),
                  onClearProfileCredential: (profileId) =>
                    clearProviderAuthCredential(state, profileId),
                  onDefaultModelChange: (modelId) => {
                    if (modelId) {
                      updateConfigFormValue(state, ["agents", "defaults", "model"], modelId);
                    } else {
                      removeConfigFormValue(state, ["agents", "defaults", "model"]);
                    }
                  },
                  onSaveConfig: async () => {
                    await saveConfig(state);
                    if (state.lastError) {
                      return;
                    }
                    await Promise.all([loadSessions(state), loadAgents(state)]);
                  },
                  onNavigate: (tab) => state.setTab(tab),
                })
              : renderLazyTabPlaceholder("Providers", lazyTabViewErrors.providers)
            : nothing
        }

        ${
          state.tab === "config"
            ? configView
              ? configView.renderConfig({
                  raw: state.configRaw,
                  originalRaw: state.configRawOriginal,
                  valid: state.configValid,
                  issues: state.configIssues,
                  error: state.lastError,
                  loading: state.configLoading,
                  saving: state.configSaving,
                  applying: state.configApplying,
                  connected: state.connected,
                  schema: state.configSchema,
                  schemaLoading: state.configSchemaLoading,
                  authStatus: state.configAuthStatus,
                  modelCatalogStatus: state.configModelCatalogStatus,
                  authActionBusyProfileId: state.configAuthActionBusyProfileId,
                  authAction: state.configAuthAction,
                  uiHints: state.configUiHints,
                  formMode: state.configFormMode,
                  formValue: state.configForm,
                  originalValue: state.configFormOriginal,
                  searchQuery: state.configSearchQuery,
                  activeSection: state.configActiveSection,
                  activeSubsection: state.configActiveSubsection,
                  basePath: state.basePath,
                  onNavigate: (tab) => state.setTab(tab),
                  onRawChange: (next) => {
                    state.configRaw = next;
                  },
                  onFormModeChange: (mode) => (state.configFormMode = mode),
                  onFormPatch: (path, value) => updateConfigFormValue(state, path, value),
                  onSearchChange: (query) => (state.configSearchQuery = query),
                  onSectionChange: (section) => {
                    state.configActiveSection = section;
                    state.configActiveSubsection = null;
                  },
                  onSubsectionChange: (section) => (state.configActiveSubsection = section),
                  onReload: () => loadConfig(state),
                  onSave: () => saveConfig(state),
                  onApply: () => applyConfig(state),
                  onStoreProfileCredential: (params) => storeProviderAuthCredential(state, params),
                  onRunInteractiveProfileAuth: (params) =>
                    runInteractiveProviderAuthCredential(state, params),
                  onClearProfileCredential: (profileId) =>
                    clearProviderAuthCredential(state, profileId),
                })
              : renderLazyTabPlaceholder("Advanced Config", lazyTabViewErrors.config)
            : nothing
        }

        ${
          state.tab === "federation" || state.tab === "marketplace"
            ? federationView
              ? federationView.renderFederation({
                  view: state.tab === "marketplace" ? "marketplace" : "federation",
                  loading: state.federationLoading,
                  error: state.federationError,
                  message: state.federationMessage,
                  directory: state.federationDirectory,
                  handle: state.federationHandle,
                  nodeEndpoint: state.federationNodeEndpoint,
                  token: state.federationToken,
                  status: state.federationStatus,
                  managedMode: state.federationManagedMode,
                  adminToken: state.federationAdminToken,
                  reviewReason: state.federationReviewReason,
                  reviewBusyHandle: state.federationReviewBusyHandle,
                  bondWalletIdDraft: state.federationBondWalletIdDraft,
                  bondAmountDraft: state.federationBondAmountDraft,
                  bondTierDraft: state.federationBondTierDraft,
                  bondAutoSubmitProof: state.federationBondAutoSubmitProof,
                  bondActionBusy: state.federationBondActionBusy,
                  bondBusyAction: state.federationBondBusyAction,
                  feeOpsLoading: state.federationOperatorEconomyLoading,
                  feeOpsError: state.federationOperatorEconomyError,
                  feeCollectionStatus: state.federationOperatorEconomyCollectionStatus,
                  feeObjects: state.federationOperatorEconomyFeeObjects,
                  feeBucketJournal: state.federationOperatorEconomyBucketJournal,
                  feeBucketBalances: state.federationOperatorEconomyBucketBalances,
                  feeReconciliationReports: state.federationOperatorEconomyReconciliationReports,
                  feeAutoDecisions: state.federationOperatorEconomyAutoFeeDecisions,
                  feeShowcase: state.federationOperatorEconomyShowcase,
                  localOffers: state.federationLocalOffers,
                  localRequests: state.federationLocalRequests,
                  localOrders: state.federationLocalOrders,
                  localOffersLoading: state.federationLocalOffersLoading,
                  localRequestsLoading: state.federationLocalRequestsLoading,
                  localOrdersLoading: state.federationLocalOrdersLoading,
                  localOffersError: state.federationLocalOffersError,
                  localRequestsError: state.federationLocalRequestsError,
                  localOrdersError: state.federationLocalOrdersError,
                  localOffersMessage: state.federationLocalOffersMessage,
                  localOfferBusy: state.federationLocalOfferBusy,
                  localOrderBusy: state.federationLocalOrderBusy,
                  localOfferDraftOpen: state.federationLocalOfferDraftOpen,
                  localListingDraftKind: state.federationLocalListingDraftKind,
                  localOfferEditingId: state.federationLocalOfferEditingId,
                  localRequestEditingId: state.federationLocalRequestEditingId,
                  localOfferEnabledDraft: state.federationLocalOfferEnabledDraft,
                  localOfferTitleDraft: state.federationLocalOfferTitleDraft,
                  localOfferSummaryDraft: state.federationLocalOfferSummaryDraft,
                  localOfferServiceKindDraft: state.federationLocalOfferServiceKindDraft,
                  localOfferInputShapeDraft: state.federationLocalOfferInputShapeDraft,
                  localOfferDeliveryShapeDraft: state.federationLocalOfferDeliveryShapeDraft,
                  localOfferCapabilitiesDraft: state.federationLocalOfferCapabilitiesDraft,
                  localOfferPriceAmountDraft: state.federationLocalOfferPriceAmountDraft,
                  localOfferPricingModelDraft: state.federationLocalOfferPricingModelDraft,
                  localOfferPriceUnitDraft: state.federationLocalOfferPriceUnitDraft,
                  localOfferCurrencyDraft: state.federationLocalOfferCurrencyDraft,
                  localOfferFulfillmentModeDraft: state.federationLocalOfferFulfillmentModeDraft,
                  localOfferAcceptedAssetsDraft: state.federationLocalOfferAcceptedAssetsDraft,
                  localOfferPaymentRailsDraft: state.federationLocalOfferPaymentRailsDraft,
                  offersLoading: state.federationOffersLoading,
                  offersError: state.federationOffersError,
                  offersHint: state.federationOffersHint,
                  offers: state.federationOffers,
                  offersQuery: state.federationOffersQuery,
                  offersServiceKindFilter: state.federationOffersServiceKindFilter,
                  marketplaceSection: state.federationMarketplaceSection,
                  marketplaceKindFilter: state.federationMarketplaceKindFilter,
                  marketplaceTrustFilter: state.federationMarketplaceTrustFilter,
                  marketplaceStatusFilter: state.federationMarketplaceStatusFilter,
                  marketplaceDateFromFilter: state.federationMarketplaceDateFromFilter,
                  marketplaceDateToFilter: state.federationMarketplaceDateToFilter,
                  marketplaceSort: state.federationMarketplaceSort,
                  selectedOfferId: state.federationSelectedOfferId,
                  marketplaceIndexLoading: state.federationMarketplaceIndexLoading,
                  marketplaceIndexPublishing: state.federationMarketplaceIndexPublishing,
                  marketplaceIndexError: state.federationMarketplaceIndexError,
                  marketplaceIndexMessage: state.federationMarketplaceIndexMessage,
                  marketplaceIndexPreview: state.federationMarketplaceIndexPreview,
                  marketplaceIndexEntries: state.federationMarketplaceIndexEntries,
                  marketplaceIndexSelectedEntryId: state.federationMarketplaceIndexSelectedEntryId,
                  marketplaceIndexDetailTab: state.federationMarketplaceIndexDetailTab,
                  marketplaceFeedbackOrderId: state.federationMarketplaceFeedbackOrderId,
                  marketplaceSellerProfileHandle: state.federationMarketplaceSellerProfileHandle,
                  marketplaceSellerProfileTab: state.federationMarketplaceSellerProfileTab,
                  marketplaceSellerProfileLoading: state.federationMarketplaceSellerProfileLoading,
                  marketplaceSellerProfileError: state.federationMarketplaceSellerProfileError,
                  marketplaceSellerProfileEntries: state.federationMarketplaceSellerProfileEntries,
                  marketplaceSellerProfileReviews: state.federationMarketplaceSellerProfileReviews,
                  marketplaceSellerProfileDisputes:
                    state.federationMarketplaceSellerProfileDisputes,
                  marketplaceSellerProfileNotaryRecords:
                    state.federationMarketplaceSellerProfileNotaryRecords,
                  offerReviewsLoading: state.federationOfferReviewsLoading,
                  offerReviewsError: state.federationOfferReviewsError,
                  offerReviews: state.federationOfferReviews,
                  offerDisputesLoading: state.federationOfferDisputesLoading,
                  offerDisputesError: state.federationOfferDisputesError,
                  offerDisputes: state.federationOfferDisputes,
                  offerFeedbackBusy: state.federationOfferFeedbackBusy,
                  offerFeedbackError: state.federationOfferFeedbackError,
                  offerFeedbackMessage: state.federationOfferFeedbackMessage,
                  offerFeedbackTab: state.federationOfferFeedbackTab,
                  escrowBusyOrderId: state.federationEscrowBusyOrderId,
                  escrowError: state.federationEscrowError,
                  escrowMessage: state.federationEscrowMessage,
                  marketplaceOrderDeliveryDraftOrderId:
                    state.federationMarketplaceOrderDeliveryDraftOrderId,
                  marketplaceOrderDeliveryKindDraft:
                    state.federationMarketplaceOrderDeliveryKindDraft,
                  marketplaceOrderDeliveryWebhookUrlDraft:
                    state.federationMarketplaceOrderDeliveryWebhookUrlDraft,
                  marketplaceOrderDeliveryBusyOrderId:
                    state.federationMarketplaceOrderDeliveryBusyOrderId,
                  marketplaceOrderDeliveryError: state.federationMarketplaceOrderDeliveryError,
                  marketplaceOrderDeliveryMessage: state.federationMarketplaceOrderDeliveryMessage,
                  marketplaceManualOrderBusyId: state.federationMarketplaceManualOrderBusyId,
                  marketplaceManualOrderError: state.federationMarketplaceManualOrderError,
                  marketplaceManualOrderMessage: state.federationMarketplaceManualOrderMessage,
                  marketplaceCapabilityOrderBusyId:
                    state.federationMarketplaceCapabilityOrderBusyId,
                  marketplaceCapabilityOrderError: state.federationMarketplaceCapabilityOrderError,
                  marketplaceCapabilityOrderMessage:
                    state.federationMarketplaceCapabilityOrderMessage,
                  summarizeSourceText: state.federationSummarizeSourceText,
                  summarizeStyle: state.federationSummarizeStyle,
                  summarizeMaxSentences: state.federationSummarizeMaxSentences,
                  summarizeBusy: state.federationSummarizeBusy,
                  summarizeError: state.federationSummarizeError,
                  paidSummarizeBusy: state.federationPaidSummarizeBusy,
                  paidSummarizeError: state.federationPaidSummarizeError,
                  summarizeResult: state.federationSummarizeResult,
                  paidQuoteAmountDraft: state.federationPaidQuoteAmountDraft,
                  paidQuoteAssetDecimalsDraft: state.federationPaidQuoteAssetDecimalsDraft,
                  paidQuoteCurrencyDraft: state.federationPaidQuoteCurrencyDraft,
                  paidQuoteChainDraft: state.federationPaidQuoteChainDraft,
                  paidQuoteAssetKindDraft: state.federationPaidQuoteAssetKindDraft,
                  paidQuoteAssetAddressDraft: state.federationPaidQuoteAssetAddressDraft,
                  paidQuotePayeeAddressDraft: state.federationPaidQuotePayeeAddressDraft,
                  paidQuoteExpiresMinutesDraft: state.federationPaidQuoteExpiresMinutesDraft,
                  reviewRatingDraft: state.federationReviewRatingDraft,
                  reviewOutcomeDraft: state.federationReviewOutcomeDraft,
                  reviewPaymentStatusDraft: state.federationReviewPaymentStatusDraft,
                  reviewInvoiceIdDraft: state.federationReviewInvoiceIdDraft,
                  reviewReceiptIdDraft: state.federationReviewReceiptIdDraft,
                  reviewSummaryDraft: state.federationReviewSummaryDraft,
                  disputeReasonCodeDraft: state.federationDisputeReasonCodeDraft,
                  disputePaymentStatusDraft: state.federationDisputePaymentStatusDraft,
                  disputeInvoiceIdDraft: state.federationDisputeInvoiceIdDraft,
                  disputeReceiptIdDraft: state.federationDisputeReceiptIdDraft,
                  disputeSummaryDraft: state.federationDisputeSummaryDraft,
                  operatorDisputesLoading: state.federationOperatorDisputesLoading,
                  operatorDisputesError: state.federationOperatorDisputesError,
                  operatorDisputes: state.federationOperatorDisputes,
                  operatorDisputeProviderFilter: state.federationOperatorDisputeProviderFilter,
                  operatorDisputeOfferIdFilter: state.federationOperatorDisputeOfferIdFilter,
                  operatorDisputeStatusFilter: state.federationOperatorDisputeStatusFilter,
                  operatorDisputePaymentStatusFilter:
                    state.federationOperatorDisputePaymentStatusFilter,
                  operatorSelectedCaseId: state.federationOperatorSelectedCaseId,
                  operatorDisputeReviewStatusDraft:
                    state.federationOperatorDisputeReviewStatusDraft,
                  operatorDisputeResolutionDraft: state.federationOperatorDisputeResolutionDraft,
                  operatorDisputeReviewBusy: state.federationOperatorDisputeReviewBusy,
                  operatorDisputeReviewError: state.federationOperatorDisputeReviewError,
                  operatorDisputeReviewMessage: state.federationOperatorDisputeReviewMessage,
                  disputeNotaryRecordsLoading: state.federationDisputeNotaryRecordsLoading,
                  disputeNotaryRecordsError: state.federationDisputeNotaryRecordsError,
                  disputeNotaryRecords: state.federationDisputeNotaryRecords,
                  disputeNotaryOpinionDraft: state.federationDisputeNotaryOpinionDraft,
                  disputeNotaryConfidenceDraft: state.federationDisputeNotaryConfidenceDraft,
                  disputeNotaryRecommendedResolutionDraft:
                    state.federationDisputeNotaryRecommendedResolutionDraft,
                  disputeNotarySummaryDraft: state.federationDisputeNotarySummaryDraft,
                  disputeNotaryBusy: state.federationDisputeNotaryBusy,
                  disputeNotaryError: state.federationDisputeNotaryError,
                  disputeNotaryMessage: state.federationDisputeNotaryMessage,
                  walletStatus: state.walletStatus,
                  walletNamedWallets: state.walletNamedWallets,
                  defaultWalletId: state.walletDefaultWalletId,
                  miningAttachedWalletId: state.miningAttachedWalletId,
                  miningProfile: state.miningProfile,
                  miningReadiness: state.miningReadiness,
                  miningStatus: state.miningStatus,
                  onOpenAdminControl: () => state.handleOperatorReadinessOpenAdminControl(),
                  onOpenTaskPayment: () => state.handleOperatorReadinessOpenTaskPayment(),
                  onOpenMining: () => state.handleOperatorReadinessOpenMining(),
                  onOpenFederationReview: () => state.handleOperatorReadinessOpenFederationReview(),
                  onHandleChange: (next) => (state.federationHandle = next),
                  onNodeEndpointChange: (next) => (state.federationNodeEndpoint = next),
                  onAdminTokenChange: (next) => (state.federationAdminToken = next),
                  onReviewReasonChange: (next) => (state.federationReviewReason = next),
                  onRefreshLocalOffers: () => state.handleFederationLoadLocalOffers(),
                  onStartLocalOfferDraft: (offerId) =>
                    state.handleFederationStartLocalOfferDraft(offerId),
                  onStartLocalRequestDraft: (requestId) =>
                    state.handleFederationStartLocalRequestDraft(requestId),
                  onCancelLocalOfferDraft: () => state.handleFederationCancelLocalOfferDraft(),
                  onLocalListingDraftKindChange: (next) => {
                    if (next === "request") {
                      state.handleFederationStartLocalRequestDraft();
                    } else {
                      state.handleFederationStartLocalOfferDraft();
                    }
                  },
                  onLocalOfferEnabledDraftChange: (next) =>
                    (state.federationLocalOfferEnabledDraft = next),
                  onLocalOfferTitleDraftChange: (next) =>
                    (state.federationLocalOfferTitleDraft = next),
                  onLocalOfferSummaryDraftChange: (next) =>
                    (state.federationLocalOfferSummaryDraft = next),
                  onLocalOfferServiceKindDraftChange: (next) =>
                    state.handleFederationApplyMarketplaceServiceKind(next),
                  onLocalOfferInputShapeDraftChange: (next) =>
                    (state.federationLocalOfferInputShapeDraft = next),
                  onLocalOfferDeliveryShapeDraftChange: (next) =>
                    (state.federationLocalOfferDeliveryShapeDraft = next),
                  onLocalOfferCapabilitiesDraftChange: (next) =>
                    (state.federationLocalOfferCapabilitiesDraft = next),
                  onLocalOfferPriceAmountDraftChange: (next) =>
                    (state.federationLocalOfferPriceAmountDraft = next),
                  onLocalOfferPricingModelDraftChange: (next) =>
                    (state.federationLocalOfferPricingModelDraft = next),
                  onLocalOfferPriceUnitDraftChange: (next) =>
                    (state.federationLocalOfferPriceUnitDraft = next),
                  onLocalOfferCurrencyDraftChange: (next) =>
                    (state.federationLocalOfferCurrencyDraft = next),
                  onLocalOfferFulfillmentModeDraftChange: (next) =>
                    (state.federationLocalOfferFulfillmentModeDraft = next),
                  onLocalOfferAcceptedAssetsDraftChange: (next) =>
                    (state.federationLocalOfferAcceptedAssetsDraft = next),
                  onLocalOfferPaymentRailsDraftChange: (next) =>
                    (state.federationLocalOfferPaymentRailsDraft = next),
                  onSaveLocalOffer: () => state.handleFederationSaveLocalOffer(),
                  onToggleLocalOffer: (offerId) => state.handleFederationToggleLocalOffer(offerId),
                  onDeleteLocalOffer: (offerId) => state.handleFederationDeleteLocalOffer(offerId),
                  onToggleLocalRequest: (requestId) =>
                    state.handleFederationToggleLocalRequest(requestId),
                  onDeleteLocalRequest: (requestId) =>
                    state.handleFederationDeleteLocalRequest(requestId),
                  onCreateOrderFromSelectedOffer: () =>
                    state.handleFederationCreateOrderFromSelectedOffer(),
                  onCreateOrderFromMarketplaceIndexEntry: (entryId) =>
                    state.handleFederationCreateOrderFromMarketplaceIndexEntry(entryId),
                  onCreateOrderFromLocalRequest: (requestId) =>
                    state.handleFederationCreateOrderFromLocalRequest(requestId),
                  onDeleteLocalOrder: (orderId) => state.handleFederationDeleteLocalOrder(orderId),
                  onOffersQueryChange: (next) => (state.federationOffersQuery = next),
                  onOffersServiceKindFilterChange: (next) => {
                    state.federationOffersServiceKindFilter = next;
                    void state.handleFederationLoadOffers();
                  },
                  onMarketplaceSectionChange: (next) => {
                    state.federationMarketplaceSection = next;
                    if (next === "listings" || next === "purchases" || next === "sales") {
                      void state.handleFederationLoadLocalOffers();
                    }
                  },
                  onMarketplaceKindFilterChange: (next) => {
                    state.federationMarketplaceKindFilter = next;
                  },
                  onMarketplaceTrustFilterChange: (next) => {
                    state.federationMarketplaceTrustFilter = next;
                    void state.handleFederationLoadMarketplaceIndex();
                  },
                  onMarketplaceStatusFilterChange: (next) => {
                    state.federationMarketplaceStatusFilter = next;
                  },
                  onMarketplaceDateFromFilterChange: (next) => {
                    state.federationMarketplaceDateFromFilter = next;
                  },
                  onMarketplaceDateToFilterChange: (next) => {
                    state.federationMarketplaceDateToFilter = next;
                  },
                  onMarketplaceSortChange: (next) => {
                    state.federationMarketplaceSort = next;
                  },
                  onLoadMarketplaceIndex: () => state.handleFederationLoadMarketplaceIndex(),
                  onPreviewMarketplaceIndex: () => state.handleFederationPreviewMarketplaceIndex(),
                  onPublishMarketplaceIndex: () => state.handleFederationPublishMarketplaceIndex(),
                  onMarketplaceIndexDetailTabChange: (next) => {
                    state.federationMarketplaceIndexDetailTab = next;
                  },
                  onSelectMarketplaceIndexEntry: (entryId) => {
                    state.federationMarketplaceIndexSelectedEntryId = entryId;
                    state.federationMarketplaceFeedbackOrderId = "";
                    state.federationMarketplaceIndexDetailTab = "overview";
                  },
                  onOpenMarketplaceSellerProfile: (handle) =>
                    state.handleFederationOpenMarketplaceSellerProfile(handle),
                  onMarketplaceSellerProfileTabChange: (next) => {
                    state.federationMarketplaceSellerProfileTab = next;
                  },
                  onCloseMarketplaceSellerProfile: () => {
                    state.federationMarketplaceSellerProfileHandle = "";
                    state.federationMarketplaceSellerProfileError = null;
                    state.federationMarketplaceSellerProfileTab = "summary";
                  },
                  onSelectOffer: (offerId) => {
                    state.handleFederationSelectOffer(offerId);
                    void state.handleFederationLoadOfferReputation();
                  },
                  onLoadOfferReputation: () => state.handleFederationLoadOfferReputation(),
                  onSummarizeSourceTextChange: (next) =>
                    (state.federationSummarizeSourceText = next),
                  onSummarizeStyleChange: (next) => (state.federationSummarizeStyle = next),
                  onSummarizeMaxSentencesChange: (next) =>
                    (state.federationSummarizeMaxSentences = next),
                  onMarketplaceOrderDeliveryDraftChange: (orderId, kind, webhookUrl) => {
                    state.federationMarketplaceOrderDeliveryDraftOrderId = orderId;
                    state.federationMarketplaceOrderDeliveryKindDraft = kind;
                    state.federationMarketplaceOrderDeliveryWebhookUrlDraft = webhookUrl ?? "";
                    state.federationMarketplaceOrderDeliveryError = null;
                    state.federationMarketplaceOrderDeliveryMessage = null;
                  },
                  onSaveMarketplaceOrderDeliveryTarget: (orderId) =>
                    state.handleFederationSaveMarketplaceOrderDeliveryTarget(orderId),
                  onPayMarketplaceManualOrder: (orderId) =>
                    state.handleFederationPayMarketplaceManualOrder(orderId),
                  onDeliverMarketplaceManualOrder: (orderId) =>
                    state.handleFederationDeliverMarketplaceManualOrder(orderId),
                  onRunMarketplaceCapabilityOrder: (orderId) =>
                    state.handleFederationRunMarketplaceCapabilityOrder(orderId),
                  onPaidQuoteAmountDraftChange: (next) =>
                    (state.federationPaidQuoteAmountDraft = next),
                  onPaidQuoteAssetDecimalsDraftChange: (next) =>
                    (state.federationPaidQuoteAssetDecimalsDraft = next),
                  onPaidQuoteCurrencyDraftChange: (next) =>
                    (state.federationPaidQuoteCurrencyDraft = next),
                  onPaidQuoteChainDraftChange: (next) =>
                    (state.federationPaidQuoteChainDraft = next),
                  onPaidQuoteAssetKindDraftChange: (next) =>
                    (state.federationPaidQuoteAssetKindDraft = next),
                  onPaidQuoteAssetAddressDraftChange: (next) =>
                    (state.federationPaidQuoteAssetAddressDraft = next),
                  onPaidQuotePayeeAddressDraftChange: (next) =>
                    (state.federationPaidQuotePayeeAddressDraft = next),
                  onPaidQuoteExpiresMinutesDraftChange: (next) =>
                    (state.federationPaidQuoteExpiresMinutesDraft = next),
                  onReviewRatingDraftChange: (next) => (state.federationReviewRatingDraft = next),
                  onReviewOutcomeDraftChange: (next) => (state.federationReviewOutcomeDraft = next),
                  onReviewPaymentStatusDraftChange: (next) =>
                    (state.federationReviewPaymentStatusDraft = next),
                  onReviewInvoiceIdDraftChange: (next) =>
                    (state.federationReviewInvoiceIdDraft = next),
                  onReviewReceiptIdDraftChange: (next) =>
                    (state.federationReviewReceiptIdDraft = next),
                  onReviewSummaryDraftChange: (next) => (state.federationReviewSummaryDraft = next),
                  onDisputeReasonCodeDraftChange: (next) =>
                    (state.federationDisputeReasonCodeDraft = next),
                  onDisputePaymentStatusDraftChange: (next) =>
                    (state.federationDisputePaymentStatusDraft = next),
                  onDisputeInvoiceIdDraftChange: (next) =>
                    (state.federationDisputeInvoiceIdDraft = next),
                  onDisputeReceiptIdDraftChange: (next) =>
                    (state.federationDisputeReceiptIdDraft = next),
                  onDisputeSummaryDraftChange: (next) =>
                    (state.federationDisputeSummaryDraft = next),
                  onOperatorDisputeProviderFilterChange: (next) =>
                    (state.federationOperatorDisputeProviderFilter = next),
                  onOperatorDisputeOfferIdFilterChange: (next) =>
                    (state.federationOperatorDisputeOfferIdFilter = next),
                  onOperatorDisputeStatusFilterChange: (next) =>
                    (state.federationOperatorDisputeStatusFilter = next),
                  onOperatorDisputePaymentStatusFilterChange: (next) =>
                    (state.federationOperatorDisputePaymentStatusFilter = next),
                  onOperatorSelectedCaseIdChange: (next) =>
                    (state.federationOperatorSelectedCaseId = next),
                  onOperatorDisputeReviewStatusDraftChange: (next) =>
                    (state.federationOperatorDisputeReviewStatusDraft = next),
                  onOperatorDisputeResolutionDraftChange: (next) =>
                    (state.federationOperatorDisputeResolutionDraft = next),
                  onDisputeNotaryOpinionDraftChange: (next) =>
                    (state.federationDisputeNotaryOpinionDraft = next),
                  onDisputeNotaryConfidenceDraftChange: (next) =>
                    (state.federationDisputeNotaryConfidenceDraft = next),
                  onDisputeNotaryRecommendedResolutionDraftChange: (next) =>
                    (state.federationDisputeNotaryRecommendedResolutionDraft = next),
                  onDisputeNotarySummaryDraftChange: (next) =>
                    (state.federationDisputeNotarySummaryDraft = next),
                  onRegister: () => state.handleFederationRegister(),
                  onAttest: () => state.handleFederationAttest(),
                  onRenew: () => state.handleFederationRenew(),
                  onRevoke: () => state.handleFederationRevoke(),
                  onSetBondWallet: () => state.handleFederationSetBondWallet(),
                  onClearBondWallet: () => state.handleFederationClearBondWallet(),
                  onBondWalletIdDraftChange: (next) => (state.federationBondWalletIdDraft = next),
                  onBondAmountDraftChange: (next) => (state.federationBondAmountDraft = next),
                  onBondTierDraftChange: (next) => (state.federationBondTierDraft = next),
                  onBondAutoSubmitProofChange: (next) =>
                    (state.federationBondAutoSubmitProof = next),
                  onOpenBond: () => state.handleFederationOpenBond(),
                  onIncreaseBond: () => state.handleFederationIncreaseBond(),
                  onRequestBondUnlock: () => state.handleFederationRequestBondUnlock(),
                  onCancelBondUnlock: () => state.handleFederationCancelBondUnlock(),
                  onFinalizeBondUnlock: () => state.handleFederationFinalizeBondUnlock(),
                  onSubmitBondProof: () => state.handleFederationSubmitBondProof(),
                  onInitBondStaking: () => state.handleFederationInitBondStaking(),
                  onSyncBondStaking: () => state.handleFederationSyncBondStaking(),
                  onClaimBondStaking: () => state.handleFederationClaimBondStaking(),
                  onReview: (handle, status) => state.handleFederationReview(handle, status),
                  onRefresh: () => state.handleFederationLoad(),
                  onRefreshOperatorEconomy: () => state.handleFederationLoadOperatorEconomy(),
                  onRefreshOffers: () => state.handleFederationLoadOffers(),
                  onRunContentSummarize: () => state.handleFederationRunContentSummarize(),
                  onRunPaidContentSummarize: () => state.handleFederationRunPaidContentSummarize(),
                  onRunPaidContentSummarizeOrder: (orderId) =>
                    state.handleFederationRunPaidContentSummarizeOrder(orderId),
                  onFundMarketplaceEscrowOrder: (orderId) =>
                    state.handleFederationFundMarketplaceEscrowOrder(orderId),
                  onReleaseMarketplaceEscrowOrder: (orderId) =>
                    state.handleFederationReleaseMarketplaceEscrowOrder(orderId),
                  onRefundMarketplaceEscrowOrder: (orderId) =>
                    state.handleFederationRefundMarketplaceEscrowOrder(orderId),
                  onCancelMarketplaceEscrowOrder: (orderId) =>
                    state.handleFederationCancelMarketplaceEscrowOrder(orderId),
                  onOpenMarketplaceIndexOrderFeedback: (orderId, tab) =>
                    state.handleFederationOpenMarketplaceIndexOrderFeedback(orderId, tab),
                  onPublishReview: () => state.handleFederationPublishReview(),
                  onPublishDispute: () => state.handleFederationPublishDispute(),
                  onOfferFeedbackTabChange: (next) =>
                    state.handleFederationOfferFeedbackTabChange(next),
                  onLoadOperatorDisputes: () => state.handleFederationLoadOperatorDisputes(),
                  onReviewDispute: () => state.handleFederationReviewDispute(),
                  onLoadDisputeNotaryAttestations: () =>
                    state.handleFederationLoadDisputeNotaryAttestations(),
                  onPublishDisputeNotaryAttestation: () =>
                    state.handleFederationPublishDisputeNotaryAttestation(),
                })
              : renderLazyTabPlaceholder(
                  state.tab === "marketplace" ? "Marketplace" : "Fased Network",
                  lazyTabViewErrors.federation,
                )
            : nothing
        }

        ${
          state.tab === "notifications"
            ? renderNotifications({
                settings: state.settings,
                snapshot: state.channelsSnapshot,
                configForm: state.configForm,
                events: state.notifications ?? [],
                onSettingsChange: (next) => state.applySettings(next),
                onDismiss: (id) => state.dismissAppNotification?.(id),
                onSendTest: () =>
                  state.enqueueAppNotification({
                    code: "wallet.rpc_degraded",
                    category: "wallet",
                    level: "info",
                    title: "Test notification",
                    message: "Control UI notification route test.",
                  }),
              })
            : nothing
        }

        ${
          state.tab === "wallet"
            ? walletView
              ? walletView.renderWallet({
                  loading: state.walletLoading,
                  error: state.walletError,
                  mainPanel: state.walletMainPanel,
                  onMainPanelChange: (panel) => state.handleWalletMainPanelChange(panel),
                  status: state.walletStatus,
                  namedWallets: state.walletNamedWallets,
                  balancesLoading: state.walletBalancesLoading,
                  balancesError: state.walletBalancesError,
                  balances: state.walletBalances,
                  defaultWalletId: state.walletDefaultWalletId,
                  assignments: state.walletAssignments,
                  agents: state.agentsList?.agents,
                  createName: state.walletCreateName,
                  createRole: state.walletCreateRole,
                  createRpcUrl: state.walletCreateRpcUrl,
                  createRpcProfileId: state.walletCreateRpcProfileId,
                  createBusy: state.walletCreateBusy,
                  settingsBusy: state.walletSettingsBusy,
                  settingsError: state.walletSettingsError,
                  settingsMessage: state.walletSettingsMessage,
                  settings: state.walletSettings,
                  skillGrantsLoading: state.walletSkillGrantsLoading,
                  skillGrantsError: state.walletSkillGrantsError,
                  skillGrantsMessage: state.walletSkillGrantsMessage,
                  skillGrantsWorkspace: state.walletSkillGrantsWorkspace,
                  skillGrantRows: state.walletSkillGrantRows,
                  skillGrantDraft: state.walletSkillGrantDraft,
                  skillGrantBusy: state.walletSkillGrantBusy,
                  federationBond: state.federationStatus?.bond ?? null,
                  onNavigate: (tab) => state.setTab(tab),
                  rpcChain: "solana",
                  policySolMaxPerTx: state.walletPolicySolMaxPerTx,
                  policyCapsEnabled: state.walletPolicyCapsEnabled,
                  policyAutoEnabled: state.walletPolicyAutoEnabled,
                  policySkillsEnabled: state.walletPolicySkillsEnabled,
                  policySolMaxDaily: state.walletPolicySolMaxDaily,
                  policySolanaAllowPrograms: state.walletPolicySolanaAllowPrograms,
                  policySolanaTokenCaps: state.walletPolicySolanaTokenCaps,
                  policyTokenCapMint: state.walletPolicyTokenCapMint,
                  policyTokenCapDecimals: state.walletPolicyTokenCapDecimals,
                  policyTokenCapMaxPerTx: state.walletPolicyTokenCapMaxPerTx,
                  policyTokenCapMaxDaily: state.walletPolicyTokenCapMaxDaily,
                  policyTokenSearchQuery: state.walletPolicyTokenSearchQuery,
                  policyTokenSearchLoading: state.walletPolicyTokenSearchLoading,
                  policyTokenSearchError: state.walletPolicyTokenSearchError,
                  policyTokenSearchResults: state.walletPolicyTokenSearchResults,
                  recurringTransferEnabled: state.walletRecurringTransferEnabled,
                  recurringTransferDestination: state.walletRecurringTransferDestination,
                  recurringTransferMint: state.walletRecurringTransferMint,
                  recurringTransferAmountMode: state.walletRecurringTransferAmountMode,
                  recurringTransferAmount: state.walletRecurringTransferAmount,
                  recurringTransferPercentage: state.walletRecurringTransferPercentage,
                  recurringTransferMinAmount: state.walletRecurringTransferMinAmount,
                  recurringTransferKeepAmount: state.walletRecurringTransferKeepAmount,
                  recurringTransferDecimals: state.walletRecurringTransferDecimals,
                  recurringTransferCron: state.walletRecurringTransferCron,
                  recurringTransferTz: state.walletRecurringTransferTz,
                  recurringTransferName: state.walletRecurringTransferName,
                  actionMessage: state.walletActionMessage,
                  actionBusy: state.walletActionBusy,
                  passkeyBusy: state.walletPasskeyBusy,
                  passkeyError: state.walletPasskeyError,
                  passkeyLabel: state.walletPasskeyLabel,
                  auditEntries: state.walletAuditEntries,
                  activityPage: state.walletActivityPage,
                  sendModalVisible: state.sendModalVisible,
                  onSendModalOpen: (id, assetId) => state.handleWalletOpenSendModal(id, assetId),
                  onSendModalClose: () => state.handleWalletCloseSendModal(),
                  sendCreateBusy: state.walletSendCreateBusy,
                  sendCreateError: state.walletSendCreateError,
                  sendCreateForm: state.walletSendCreateForm,
                  walletDetailsWalletId: state.walletDetailsWalletId,
                  balanceWalletId: state.walletBalanceWalletId,
                  expandedWalletId: state.walletExpandedPanelWalletId,
                  expandedPanel: state.walletExpandedPanel,
                  policyPanel: state.walletPolicyPanel,
                  approvalsLoading: state.walletApprovalsLoading,
                  approvalsBusyId: state.walletApprovalsBusyId,
                  approvalsError: state.walletApprovalsError,
                  approvalsFilter: state.walletApprovalsFilter,
                  approvals: state.walletApprovals,
                  onSendCreatePatch: (patch) => state.handleWalletSendCreatePatch(patch),
                  onWalletDetailsWalletChange: (walletId) =>
                    void state.handleWalletSelectDetailsWallet(walletId),
                  onWalletBalanceWalletChange: (walletId) =>
                    void state.handleWalletBalanceWalletChange(walletId),
                  onPolicyPanelChange: (panel) => state.handleWalletPolicyPanelChange(panel),
                  onApprovalsFilterChange: (filter) => state.handleWalletSetApprovalsFilter(filter),
                  onAttachWalletStandardVault: () => state.handleWalletAttachStandardVault(),
                  onCreateNameChange: (next) => (state.walletCreateName = next),
                  onCreateRoleChange: (next) => (state.walletCreateRole = next),
                  onCreateRpcUrlChange: (next) => (state.walletCreateRpcUrl = next),
                  onCreateRpcProfileIdChange: (next) => (state.walletCreateRpcProfileId = next),
                  rpcUrl: state.walletRpcUrl,
                  rpcEditorWalletId: state.walletRpcEditorWalletId,
                  revealedAddressWalletId: state.walletRevealedAddressWalletId,
                  onRpcUrlChange: (next) => (state.walletRpcUrl = next),
                  onToggleWalletRpcEditor: (walletId) =>
                    state.handleWalletToggleRpcEditor(walletId),
                  onCopyWalletRpc: (walletId) => void state.handleWalletCopyRpc(walletId),
                  onToggleWalletAddress: (walletId) => state.handleWalletToggleAddress(walletId),
                  onSaveWalletRpc: () => state.handleWalletSaveRpcSecret(),
                  onCreateWallet: () => state.handleWalletCreateNamedWallet(),
                  onArchiveWallet: (walletId) =>
                    state.handleWalletDeleteNamedWallet(walletId, true),
                  onRemoveWallet: (walletId) =>
                    state.handleWalletDeleteNamedWallet(walletId, false),
                  onApproveRequest: (requestId) => state.handleWalletApproveRequest(requestId),
                  onRejectRequest: (requestId) => state.handleWalletRejectRequest(requestId),
                  onSetDefaultWallet: (walletId) => state.handleWalletSetDefaultWallet(walletId),
                  onAssignAgentIdChange: (agentId) => {
                    state.walletAssignAgentId = agentId;
                    state.walletAssignWalletId = state.walletAssignments[agentId] ?? "";
                  },
                  onAssignWalletIdChange: (walletId) => {
                    state.walletAssignWalletId = walletId;
                  },
                  onAssignAgentWallet: () => void state.handleWalletAssignAgentWallet(),
                  onDeleteAgentAssignment: (agentId) =>
                    void state.handleWalletDeleteAgentAssignment(agentId),
                  onPasskeyLabelChange: (next) => (state.walletPasskeyLabel = next),
                  onEnablePasskeyApproval: () => state.handleWalletEnablePasskeyApproval(),
                  onEnrollPasskey: () => state.handleWalletEnrollPasskey(),
                  onDeletePasskey: (credentialId) => state.handleWalletDeletePasskey(credentialId),
                  onApplyRecommendedPolicy: () => state.handleWalletApplyRecommendedPolicy(),
                  onMiningSatSweepChange: (patch) => state.handleMiningSatSweepChange(patch),
                  onPatchSettings: (patch, opts) => state.handleWalletPatchSettings(patch, opts),
                  onActivityPageChange: (page) => (state.walletActivityPage = page),
                  onRpcChainChange: (next) => (state.walletRpcChain = next),
                  onPolicyDraftChange: (patch) => state.handleWalletPolicyDraftChange(patch),
                  onTokenSearchQueryChange: (next) =>
                    state.handleWalletTokenSearchQueryChange(next),
                  onTokenSearch: () => state.handleWalletTokenSearch(),
                  onTokenSearchSelect: (token) => state.handleWalletTokenSearchSelect(token),
                  onSavePolicy: () => state.handleWalletSavePolicy(),
                  onRefresh: () => state.handleWalletLoad(),
                  onSkillGrantSelect: (row) => state.handleWalletSkillGrantSelect(row),
                  onSkillGrantDraftPatch: (patch) => state.handleWalletSkillGrantDraftPatch(patch),
                  onSkillGrantActionToggle: (action, enabled) =>
                    state.handleWalletSkillGrantActionToggle(action, enabled),
                  onSkillGrantSave: () => state.handleWalletSkillGrantSave(),
                  onSkillGrantClear: (skillId) => state.handleWalletSkillGrantClear(skillId),
                  onCreateSendRequest: () => state.handleWalletCreateSendRequest(),
                  miningProfile: state.miningProfile,
                  miningReadiness: state.miningReadiness,
                  miningStatus: state.miningStatus,
                })
              : renderLazyTabPlaceholder("Wallet", lazyTabViewErrors.wallet)
            : nothing
        }

        ${
          state.tab === "mining"
            ? miningView
              ? miningView.renderMining({
                  loading: state.miningLoading,
                  saving: state.miningSaving,
                  actionBusy: state.miningActionBusy,
                  capitalActionBusy: state.miningCapitalActionBusy,
                  pendingAction: state.miningPendingAction,
                  nowMs: state.miningNowMs,
                  error: state.miningError,
                  message: state.miningMessage,
                  notifications: state.miningNotifications,
                  wallets: state.miningWallets,
                  defaultWalletId: state.walletDefaultWalletId,
                  attachedWalletId: state.miningAttachedWalletId,
                  profile: state.miningProfile,
                  savedProfiles: state.miningSavedProfiles,
                  selectedSavedProfileId: state.miningSelectedSavedProfileId,
                  saveProfileName: state.miningSaveProfileName,
                  readiness: state.miningReadiness,
                  status: state.miningStatus,
                  mainnetSync: state.miningMainnetSync,
                  mainnetSyncBusy: state.miningMainnetSyncBusy,
                  historyLoading: state.miningHistoryLoading,
                  historyError: state.miningHistoryError,
                  history: state.miningHistory,
                  recovery: state.miningRecovery,
                  recoveryDisputeAuthority: state.miningRecoveryDisputeAuthority,
                  recoveryTargetAuthority: state.miningRecoveryTargetAuthority,
                  recoveryEpochId: state.miningRecoveryEpochId,
                  recoveryMicroRoundId: state.miningRecoveryMicroRoundId,
                  recoveryStatusFlag: state.miningRecoveryStatusFlag,
                  recoveryBoardRoot: state.miningRecoveryBoardRoot,
                  recoveryScoreRoot: state.miningRecoveryScoreRoot,
                  recoveryCoordinationRoot: state.miningRecoveryCoordinationRoot,
                  recoveryDraftRestored: state.miningRecoveryDraftRestored,
                  recoveryDraftUpdatedAt: state.miningRecoveryDraftUpdatedAt,
                  recoveryDraftSavedHint: state.miningRecoveryDraftSavedHint,
                  confirmClearHistory: state.miningConfirmClearHistory,
                  recentActionsPage: state.miningRecentActionsPage,
                  historyModalOpen: state.miningHistoryModalOpen,
                  activityFilter: state.miningActivityFilter,
                  activityWindow: state.miningActivityWindow,
                  plannerWindow: state.miningPlannerWindow,
                  chartMetric: state.miningChartMetric,
                  onRefresh: () => state.handleMiningLoad({ forceFresh: true }),
                  onHistoryOpen: () => state.handleMiningOpenHistoryModal(),
                  onHistoryClose: () => state.handleMiningCloseHistoryModal(),
                  onDismissNotification: (id) => state.dismissMiningNotification(id),
                  onSaveLocalProfile: () => state.handleMiningSaveLocalProfile(),
                  onLoadSavedProfile: () => state.handleMiningLoadSavedProfile(),
                  onDeleteSavedProfile: () => state.handleMiningDeleteSavedProfile(),
                  onExportSupportBundle: () => state.handleMiningExportSupportBundle(),
                  onStart: () => state.handleMiningStart(),
                  onStop: () => state.handleMiningStop(),
                  onMainnetSync: () => state.handleMiningMainnetSync(),
                  onTopUpReserve: () => state.handleMiningTopUpReserve(),
                  onDepositCapital: () => state.handleMiningDepositCapital(),
                  onWithdrawCapital: () => state.handleMiningWithdrawCapital(),
                  onUpdateCommit: (lamports) => state.handleMiningUpdateCommit(lamports),
                  onRecentActionsPageChange: (page) =>
                    state.handleMiningRecentActionsPageChange(page),
                  onActivityFilterChange: (filter) =>
                    state.handleMiningActivityFilterChange(filter),
                  onActivityWindowChange: (window) =>
                    state.handleMiningActivityWindowChange(window),
                  onSelectedSavedProfileChange: (id) =>
                    state.handleMiningSelectedSavedProfileChange(id),
                  onSaveProfileNameChange: (value) =>
                    state.handleMiningSaveProfileNameChange(value),
                  onStrategyPresetChange: (preset) =>
                    state.handleMiningStrategyPresetChange(preset),
                  onStrategyExecutionChange: (execution) =>
                    state.handleMiningStrategyExecutionChange(execution),
                  onCycleCadenceChange: (cadence) => state.handleMiningCycleCadenceChange(cadence),
                  onOpenAomStrategyTask: () => openMiningAomStrategyTask(state),
                  onStrategyModeChange: (mode) => state.handleMiningStrategyModeChange(mode),
                  onSkillConfigChange: (patch) => state.handleMiningSkillConfigChange(patch),
                  onRiskModeChange: (riskMode) => state.handleMiningRiskModeChange(riskMode),
                  onCommitLamportsChange: (lamports) =>
                    state.handleMiningCommitLamportsChange(lamports),
                  onReserveLamportsChange: (lamports) =>
                    state.handleMiningReserveLamportsChange(lamports),
                  capitalDepositDraft: state.miningCapitalDepositDraft,
                  capitalWithdrawDraft: state.miningCapitalWithdrawDraft,
                  onCapitalDepositDraftChange: (value) =>
                    state.handleMiningCapitalDepositDraftChange(value),
                  onCapitalWithdrawDraftChange: (value) =>
                    state.handleMiningCapitalWithdrawDraftChange(value),
                  onPayoutChange: (payout) => state.handleMiningPayoutChange(payout),
                  onAutomationChange: (patch) => state.handleMiningAutomationChange(patch),
                  onSatSweepChange: (patch) => state.handleMiningSatSweepChange(patch),
                  onRecoveryDisputeAuthorityChange: (value) =>
                    state.handleMiningRecoveryDisputeAuthorityChange(value),
                  onRecoveryTargetAuthorityChange: (value) =>
                    state.handleMiningRecoveryTargetAuthorityChange(value),
                  onRecoveryEpochIdChange: (value) =>
                    state.handleMiningRecoveryEpochIdChange(value),
                  onRecoveryMicroRoundIdChange: (value) =>
                    state.handleMiningRecoveryMicroRoundIdChange(value),
                  onRecoveryStatusFlagChange: (value) =>
                    state.handleMiningRecoveryStatusFlagChange(value),
                  onRecoveryBoardRootChange: (value) =>
                    state.handleMiningRecoveryBoardRootChange(value),
                  onRecoveryScoreRootChange: (value) =>
                    state.handleMiningRecoveryScoreRootChange(value),
                  onRecoveryCoordinationRootChange: (value) =>
                    state.handleMiningRecoveryCoordinationRootChange(value),
                  onRetryClaim: () => state.handleMiningRetryClaim(),
                  onResolveDispute: () => state.handleMiningResolveDispute(),
                  onRepublishRoots: () => state.handleMiningRepublishRoots(),
                  onClearHistory: () => state.handleMiningClearHistory(),
                  onConfirmClearHistory: () => state.handleMiningConfirmClearHistory(),
                  onCancelClearHistory: () => state.handleMiningCancelClearHistory(),
                  onPlannerWindowChange: (window) => state.handleMiningPlannerWindowChange(window),
                  onChartMetricChange: (metric) => (state.miningChartMetric = metric),
                  onResetRecoveryDraft: () => state.handleMiningResetRecoveryDraft(),
                  onResetToSelectedCandidate: () => state.handleMiningResetToSelectedCandidate(),
                })
              : renderLazyTabPlaceholder("Mining", lazyTabViewErrors.mining)
            : nothing
        }

        ${
          state.tab === "debug"
            ? renderDebug({
                loading: state.debugLoading,
                status: state.debugStatus,
                health: state.debugHealth,
                models: state.debugModels,
                configForm: state.configForm,
                configSaving: state.configSaving,
                configDirty: state.configFormDirty,
                modelCatalogStatus: state.debugModelCatalogStatus,
                commandsCatalog: state.debugCommandsCatalog,
                pluginsMarketplace: state.debugPluginsMarketplace,
                taskLedger: state.taskLedger,
                taskLedgerBusy: state.taskLedgerBusy,
                taskLedgerError: state.taskLedgerError,
                taskLedgerMaintenanceMessage: state.taskLedgerMaintenanceMessage,
                diagnosticsStability: state.debugDiagnosticsStability,
                memoryInventory: state.debugMemoryInventory,
                memoryValidation: state.debugMemoryValidation,
                memoryRepairPreview: state.debugMemoryRepairPreview,
                heartbeat: state.debugHeartbeat,
                eventLog: state.eventLog,
                methods: debugMethods,
                callMethod: state.debugCallMethod || debugMethods[0] || "",
                callParams: state.debugCallParams,
                callResult: state.debugCallResult,
                callError: state.debugCallError,
                adminRpcBusy: state.debugAdminRpcBusy,
                adminRpcResult: state.debugAdminRpcResult,
                adminRpcError: state.debugAdminRpcError,
                adminChatSessionKey: state.debugAdminChatSessionKey,
                adminChatMessage: state.debugAdminChatMessage,
                adminPushNodeId: state.debugAdminPushNodeId,
                adminPushTitle: state.debugAdminPushTitle,
                adminPushBody: state.debugAdminPushBody,
                adminWebAccountId: state.debugAdminWebAccountId,
                acpxBridgeConfigBusy: state.debugAcpxBridgeConfigBusy,
                acpxBridgeConfigResult: state.debugAcpxBridgeConfigResult,
                acpxBridgeConfigError: state.debugAcpxBridgeConfigError,
                acpxPushTestBusy: state.debugAcpxPushTestBusy,
                acpxPushTestPreview: state.debugAcpxPushTestPreview,
                acpxPushTestAuditHistory: state.debugAcpxPushTestAuditHistory,
                acpxPushTestResult: state.debugAcpxPushTestResult,
                acpxPushTestError: state.debugAcpxPushTestError,
                satProtocolMaintenanceBusy: state.debugSatProtocolMaintenanceBusy,
                satProtocolMaintenanceResult: state.debugSatProtocolMaintenanceResult,
                satProtocolMaintenanceError: state.debugSatProtocolMaintenanceError,
                feeOpsLoading: state.federationOperatorEconomyLoading,
                feeOpsError: state.federationOperatorEconomyError,
                feeCollectionStatus: state.federationOperatorEconomyCollectionStatus,
                feeObjects: state.federationOperatorEconomyFeeObjects,
                feeBucketJournal: state.federationOperatorEconomyBucketJournal,
                feeBucketBalances: state.federationOperatorEconomyBucketBalances,
                feeReconciliationReports: state.federationOperatorEconomyReconciliationReports,
                feeAutoDecisions: state.federationOperatorEconomyAutoFeeDecisions,
                onCallMethodChange: (next) => (state.debugCallMethod = next),
                onCallParamsChange: (next) => (state.debugCallParams = next),
                onAdminChatSessionKeyChange: (next) => (state.debugAdminChatSessionKey = next),
                onAdminChatMessageChange: (next) => (state.debugAdminChatMessage = next),
                onAdminPushNodeIdChange: (next) => (state.debugAdminPushNodeId = next),
                onAdminPushTitleChange: (next) => (state.debugAdminPushTitle = next),
                onAdminPushBodyChange: (next) => (state.debugAdminPushBody = next),
                onAdminWebAccountIdChange: (next) => (state.debugAdminWebAccountId = next),
                onAcpxBridgeConfigAction: (action) => updateDebugAcpxBridgeConfig(state, action),
                onAcpxPushTestAction: (action) => callDebugAcpxPushTest(state, action),
                onSatProtocolMaintenance: () => callDebugSatProtocolMaintenance(state),
                onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
                onConfigSave: () => saveConfig(state),
                onConfigReload: () => loadConfig(state),
                onTaskLedgerMaintenance: (opts) => void state.runTaskLedgerMaintenance(opts),
                onRefresh: async () => {
                  await Promise.all([
                    loadDebug(state),
                    state.loadTaskLedger({ quiet: true }),
                    state.handleFederationLoadOperatorEconomy(),
                  ]);
                },
                onCall: () => callDebugMethod(state),
                onAdminRpcAction: (action) => callDebugAdminRpcControl(state, action),
              })
            : nothing
        }

        ${
          state.tab === "logs"
            ? renderLogs({
                loading: state.logsLoading,
                error: state.logsError,
                file: state.logsFile,
                entries: state.logsEntries,
                configForm: state.configForm,
                configSaving: state.configSaving,
                filterText: state.logsFilterText,
                levelFilters: state.logsLevelFilters,
                autoFollow: state.logsAutoFollow,
                truncated: state.logsTruncated,
                onFilterTextChange: (next) => (state.logsFilterText = next),
                onLevelToggle: (level, enabled) => {
                  state.logsLevelFilters = { ...state.logsLevelFilters, [level]: enabled };
                },
                onToggleAutoFollow: (next) => (state.logsAutoFollow = next),
                onConfigPatch: (path, value) => {
                  updateConfigFormValue(state, path, value);
                  void saveConfig(state);
                },
                onRefresh: () => loadLogs(state, { reset: true }),
                onExport: (lines, label) => state.exportLogs(lines, label),
                onScroll: (event) => state.handleLogsScroll(event),
              })
            : nothing
        }
      </main>
      ${renderCronRunDetailModal({
        detail: state.cronRunDetail,
        loading: state.cronRunDetailLoading,
        error: state.cronRunDetailError,
        basePath: state.basePath,
        busy: state.cronBusy,
        onClose: () => closeCronRunDetail(state),
        onOpenTranscript: (sessionKey) => {
          const url = `${state.basePath}/chat?session=${encodeURIComponent(sessionKey)}`;
          window.history.pushState({}, "", url);
          state.tab = "chat";
          closeCronRunDetail(state);
        },
        onQueueControl: (action, runId) => {
          void controlCronQueueRunAndRefreshSessions(state, action, runId);
        },
        onRepair: (job, action, opts) =>
          (async () => {
            await repairCronTaskAndRefreshSessions(state, job, action, opts);
            if (state.cronRunDetail?.runId) {
              await loadCronRunDetail(state, state.cronRunDetail.runId);
            }
          })(),
        onApproveCoordination: (job) =>
          (async () => {
            await approveCronTaskCoordinationAndRefreshSessions(state, job);
            if (state.cronRunDetail?.runId) {
              await loadCronRunDetail(state, state.cronRunDetail.runId);
            }
          })(),
        onAskAgentEvidence: (job) =>
          (async () => {
            await askCronTaskAgentEvidenceAndRefreshSessions(state, job);
            if (state.cronRunDetail?.runId) {
              await loadCronRunDetail(state, state.cronRunDetail.runId);
            }
          })(),
        onNavigate: (tab) => {
          closeCronRunDetail(state);
          state.setTab(tab);
        },
      })}
      ${renderExecApprovalPrompt(state)}
      ${renderGatewayUrlConfirmation(state)}
      ${renderChannelActionDialog(state)}
    </div>
  `;
}
