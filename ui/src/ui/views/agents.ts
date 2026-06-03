import { html, nothing } from "lit";
import {
  getProviderBrandManifest,
  getProviderBrandManifestForRoute,
  isStandardProviderCatalogEntry,
} from "../../../../src/providers/registry.ts";
import type {
  CronJobsAdaptiveRouteFilter,
  CronRepairAction,
  TaskTemplatePreset,
} from "../controllers/cron.ts";
import type { DreamingStatus } from "../controllers/dreaming.ts";
import { closeDialogOnBackdropClick } from "../dialog.ts";
import type { FederationStatus, FederationToken } from "../federation-api.ts";
import { icons } from "../icons.ts";
import type { SatMinerProfile, SatMiningReadiness, SatMiningRuntimeStatus } from "../mining-api.ts";
import type { Tab } from "../navigation.ts";
import { parseAgentSessionKey } from "../session-key.ts";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  ChannelsStatusSnapshot,
  ConfigUiHints,
  CronJob,
  CronStatus,
  CronTaskTrustedSource,
  WebhookTrigger,
  WebhookTriggersResult,
  ModelCatalogEntry,
  ModelsAuthStatusResult,
  ModelsCatalogStatusResult,
  PluginsMarketplaceListResult,
  DoctorMemoryInventoryPayload,
  DoctorMemoryValidationPayload,
  MemoryWikiStatus,
  SessionsListResult,
  SessionsUsageResult,
  SkillStatusReport,
  TaskListResult,
  ToolsCatalogResult,
  ToolsEffectiveResult,
  WebSearchServiceProviderOption,
} from "../types.ts";
import type { WalletNamedWallet, WalletStatus } from "../wallet-api.ts";
import { renderAgentCoordination } from "./agents-panels-coordination.ts";
import { renderAgentMemory } from "./agents-panels-memory.ts";
import { renderAgentOverview } from "./agents-panels-overview.ts";
import {
  renderAgentFiles,
  renderAgentChannels,
  renderAgentCron,
} from "./agents-panels-status-files.ts";
import { renderAgentTools, renderAgentSkills } from "./agents-panels-tools-skills.ts";
import {
  agentBadgeText,
  buildAgentContext,
  normalizeAgentLabel,
  type AgentTaskModelSlots,
} from "./agents-utils.ts";
import type { ChannelsView } from "./channels.types.ts";
import { renderServices } from "./services.ts";
import { renderSessions, type SessionsProps as RenderSessionsProps } from "./sessions.ts";
import type { SkillsProps } from "./skills.ts";

export type AgentsPanel =
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
  | "cron";

export type ConfigState = {
  form: Record<string, unknown> | null;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
};

export type ChannelsState = {
  snapshot: ChannelsStatusSnapshot | null;
  loading: boolean;
  error: string | null;
  lastSuccess: number | null;
};

export type CronState = {
  status: CronStatus | null;
  jobs: CronJob[];
  loading: boolean;
  error: string | null;
};

export type SessionsState = {
  result: SessionsListResult | null;
  loading: boolean;
  error: string | null;
  search?: string;
};

function countActiveChannels(snapshot: ChannelsStatusSnapshot | null): number | null {
  if (!snapshot) {
    return null;
  }
  const ids = new Set<string>();
  for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts ?? {})) {
    if (
      accounts.some(
        (account) => account.enabled || account.configured || account.running || account.connected,
      )
    ) {
      ids.add(channelId);
    }
  }
  for (const [channelId, status] of Object.entries(snapshot.channels ?? {})) {
    if (
      status &&
      typeof status === "object" &&
      ((status as { configured?: unknown }).configured === true ||
        (status as { running?: unknown }).running === true ||
        (status as { connected?: unknown }).connected === true)
    ) {
      ids.add(channelId);
    }
  }
  return ids.size || null;
}

export type AgentFilesState = {
  list: AgentsFilesListResult | null;
  loading: boolean;
  error: string | null;
  active: string | null;
  contents: Record<string, string>;
  drafts: Record<string, string>;
  saving: boolean;
};

export type AgentSkillsState = {
  report: SkillStatusReport | null;
  loading: boolean;
  error: string | null;
  agentId: string | null;
  filter: string;
};

export type ToolsCatalogState = {
  loading: boolean;
  error: string | null;
  result: ToolsCatalogResult | null;
};

export type ToolsEffectiveState = {
  loading: boolean;
  error: string | null;
  result: ToolsEffectiveResult | null;
};

export type MemoryState = {
  inventory: DoctorMemoryInventoryPayload | null;
  validation: DoctorMemoryValidationPayload | null;
  loading: boolean;
  error: string | null;
  wiki?: MemoryWikiStatus | null;
  wikiRebuilding?: boolean;
  wikiError?: string | null;
  dreamingStatusLoading?: boolean;
  dreamingStatusError?: string | null;
  dreamingStatus?: DreamingStatus | null;
};

export type AgentsProps = {
  basePath: string;
  loading: boolean;
  error: string | null;
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  agentCreateBusy: boolean;
  agentCreateMessage: string | null;
  activePanel: AgentsPanel;
  config: ConfigState;
  connected: boolean;
  channelRuntimeBusy: Record<string, boolean>;
  channelsView?: ChannelsView;
  configSchema: unknown;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  channels: ChannelsState;
  sessions: SessionsState;
  cron: CronState;
  webhookTriggers?: {
    result: WebhookTriggersResult | null;
    loading: boolean;
    busy: boolean;
    error: string | null;
    message: string | null;
    draft: import("../controllers/webhook-triggers.ts").WebhookTriggerDraft | null;
  };
  taskLedger?: {
    result: TaskListResult | null;
    loading: boolean;
    busy: boolean;
    error: string | null;
    sourceFilter?: import("../types.ts").TaskSource | "all";
    typeFilter?: "all" | "task" | "trigger" | "workflow" | "graph" | "program" | "history";
    statusFilter?: "all" | "active" | "terminal" | import("../types.ts").TaskRecord["status"];
    details?: Record<string, import("../types.ts").TaskRecord>;
    detailLoading?: Record<string, boolean>;
    detailErrors?: Record<string, string>;
  };
  taskWorkflow?: {
    draft: import("../types.ts").TaskWorkflowDraft | null;
    graphDraft: import("../types.ts").TaskWorkflowGraphDraft | null;
    busy: boolean;
    error: string | null;
    message: string | null;
    definitions: import("../types.ts").SavedTaskWorkflowDefinitionsResult | null;
    definitionsLoading: boolean;
    definitionsBusy: boolean;
    definitionsError: string | null;
    templates?: import("../types.ts").TaskWorkflowTemplatesResult | null;
    templatesLoading?: boolean;
    templatesError?: string | null;
    runs: import("../types.ts").TaskFlowListResult | null;
    runsLoading: boolean;
    runsBusy: boolean;
    runsError: string | null;
  };
  taskStandingOrders?: {
    result: import("../types.ts").StandingOrdersResult | null;
    loading: boolean;
    busy: boolean;
    error: string | null;
    message: string | null;
    draft: import("../types.ts").StandingOrderDraft | null;
  };
  taskFilters: {
    query: string;
    status: "all" | "enabled" | "disabled" | "needs-access";
    adaptiveRoute: CronJobsAdaptiveRouteFilter;
    sortDir: "desc" | "asc";
  };
  agentFiles: AgentFilesState;
  agentIdentityLoading: boolean;
  agentIdentityError: string | null;
  agentIdentityById: Record<string, AgentIdentityResult>;
  agentSkills: AgentSkillsState;
  toolsCatalog: ToolsCatalogState;
  toolsEffective: ToolsEffectiveState;
  memory: MemoryState;
  providers: {
    catalogStatus: ModelsCatalogStatusResult | null;
    authStatus: ModelsAuthStatusResult | null;
  };
  usage?: {
    result: SessionsUsageResult | null;
    loading: boolean;
    error: string | null;
  };
  providersPanel?: unknown;
  plugins: {
    marketplace: PluginsMarketplaceListResult | null;
  };
  services?: {
    gmailProvisioning?: boolean;
    gmailProvisionMessage?: string | null;
    webSearchTesting?: boolean;
    webSearchTestMessage?: string | null;
    webSearchProviders?: WebSearchServiceProviderOption[];
    webSearchProvidersLoading?: boolean;
  };
  wallet: {
    status: WalletStatus | null;
    namedWallets: WalletNamedWallet[];
    defaultWalletId: string | null;
  };
  mining: {
    attachedWalletId: string | null;
    profile: SatMinerProfile | null;
    readiness: SatMiningReadiness | null;
    status: SatMiningRuntimeStatus | null;
  };
  federation: {
    token: FederationToken | null;
    status: FederationStatus | null;
  };
  runtimeSessionKey: string;
  runtimeSessionMatchesSelectedAgent: boolean;
  modelCatalog: ModelCatalogEntry[];
  skillEdits: Record<string, string>;
  skillsBusyKey: string | null;
  skillsLibrary?: SkillsProps;
  onNavigate: (tab: Tab) => void;
  onOpenUsageForAgent?: (agentId: string) => void;
  onRefresh: () => void;
  onCreateAgent: (draft: {
    name: string;
    workspace: string;
    model?: string | null;
    avatar?: string | null;
  }) => void;
  onSelectAgent: (agentId: string) => void;
  onSelectPanel: (panel: AgentsPanel) => void;
  onLoadFiles: (agentId: string) => void;
  onSelectFile: (name: string) => void;
  onFileDraftChange: (name: string, content: string) => void;
  onFileReset: (name: string) => void;
  onFileSave: (name: string) => void;
  onToolsProfileChange: (agentId: string, profile: string | null, clearAllow: boolean) => void;
  onToolsOverridesChange: (agentId: string, alsoAllow: string[], deny: string[]) => void;
  onConfigPatch: (path: Array<string | number>, value: unknown) => void;
  onConfigRemove: (path: Array<string | number>) => void;
  onConfigReload: () => void;
  onConfigSave: () => void;
  onGmailProvision?: () => void;
  onWebSearchTest?: () => void;
  onModelChange: (agentId: string, modelId: string | null) => void;
  onModelFallbacksChange: (agentId: string, fallbacks: string[]) => void;
  onTaskModelsChange: (agentId: string, taskModels: AgentTaskModelSlots) => void;
  onAgentIdentityAvatarChange: (agentId: string, avatar: string | null) => void;
  onActiveModelProviderChange: (agentId: string, providerId: string | null) => void;
  onModelProviderChange: (
    agentId: string,
    providerId: string,
    providerConfig: import("./agents-utils.ts").AgentModelProviderSettings | null,
  ) => void;
  onSessionsRefresh: () => void;
  onSessionsSearchChange?: (search: string) => void;
  onSessionPatch: RenderSessionsProps["onPatch"];
  onSessionDelete: RenderSessionsProps["onDelete"];
  onSessionBranchCheckpoint: RenderSessionsProps["onBranchCheckpoint"];
  onSessionRestoreCheckpoint: RenderSessionsProps["onRestoreCheckpoint"];
  onChannelsRefresh: () => void;
  onChannelsViewChange?: (view: ChannelsView) => void;
  onChannelEnable: (channelId: string) => void;
  onChannelStart: (channelId: string, accountId?: string) => void;
  onChannelStop: (channelId: string, accountId?: string) => void;
  onChannelLogout: (channelId: string, accountId?: string) => void;
  onCronRefresh: () => void;
  onCronEdit: (job: CronJob) => void;
  onCronRunNow: (jobId: string) => void;
  onCronToggle: (job: CronJob, enabled: boolean) => void;
  onCronRepair?: (
    job: CronJob,
    action: CronRepairAction,
    opts?: { source?: string; sourceNodeId?: string },
  ) => void | Promise<void>;
  onCronApproveCoordination?: (job: CronJob) => void | Promise<void>;
  onCronAskAgentEvidence?: (job: CronJob) => void | Promise<void>;
  onCronSourceToggle?: (source: CronTaskTrustedSource, active: boolean) => void | Promise<void>;
  onCronSourceRemove?: (source: CronTaskTrustedSource) => void | Promise<void>;
  onCronQueueControl: (action: "cancel" | "retry" | "clear-stale", runId: string) => void;
  onTaskLedgerRefresh?: () => void;
  onTaskLedgerSourceFilterChange?: (source: import("../types.ts").TaskSource | "all") => void;
  onTaskLedgerTypeFilterChange?: (
    type: "all" | "task" | "trigger" | "workflow" | "graph" | "program" | "history",
  ) => void;
  onTaskLedgerStatusFilterChange?: (
    status: "all" | "active" | "terminal" | import("../types.ts").TaskRecord["status"],
  ) => void;
  onTaskLedgerPageChange?: (offset: number) => void;
  onTaskLedgerDetailOpen?: (taskId: string) => void;
  onTaskLedgerControl?: (
    action: "approve" | "reject" | "cancel" | "retry" | "notify",
    taskId: string,
  ) => void;
  onTaskLedgerOpenSource?: (task: import("../types.ts").TaskRecord) => void;
  onTaskLedgerWorkflowReview?: (agentId: string, task: import("../types.ts").TaskRecord) => void;
  onTaskWorkflowCreate?: (agentId: string) => void;
  onTaskWorkflowGraphCreate?: (agentId: string) => void;
  onTaskWorkflowUseTemplate?: (
    agentId: string,
    template: import("../types.ts").TaskWorkflowTemplate,
  ) => void;
  onTaskTemplateUse?: (agentId: string, template: TaskTemplatePreset) => void;
  onTaskWorkflowPatch?: (patch: Partial<import("../types.ts").TaskWorkflowDraft>) => void;
  onTaskWorkflowGraphPatch?: (patch: Partial<import("../types.ts").TaskWorkflowGraphDraft>) => void;
  onTaskWorkflowGraphAddNode?: (type: import("../types.ts").TaskWorkflowGraphNodeType) => void;
  onTaskWorkflowGraphUpdateNode?: (
    nodeId: string,
    patch: Partial<import("../types.ts").TaskWorkflowGraphNode>,
  ) => void;
  onTaskWorkflowGraphRemoveNode?: (nodeId: string) => void;
  onTaskWorkflowGraphMoveNode?: (nodeId: string, x: number, y: number) => void;
  onTaskWorkflowGraphAddEdge?: (
    from: string,
    to: string,
    on?: import("../types.ts").TaskWorkflowGraphEdgeEvent,
  ) => void;
  onTaskWorkflowGraphUpdateEdge?: (
    edgeId: string,
    patch: Partial<import("../types.ts").TaskWorkflowGraphEdge>,
  ) => void;
  onTaskWorkflowGraphRemoveEdge?: (edgeId: string) => void;
  onTaskWorkflowGraphAutoLayout?: () => void;
  onTaskWorkflowGraphImportJson?: () => void;
  onTaskWorkflowGraphExportJson?: () => void;
  onTaskWorkflowPreview?: (agentId: string) => void;
  onTaskWorkflowGraphPreview?: (agentId: string) => void;
  onTaskWorkflowSave?: (agentId: string) => void;
  onTaskWorkflowGraphSave?: (agentId: string) => void;
  onTaskWorkflowRun?: (agentId: string) => void;
  onTaskWorkflowGraphRun?: (agentId: string) => void;
  onTaskWorkflowEditDefinition?: (
    definition: import("../types.ts").SavedTaskWorkflowDefinition,
  ) => void;
  onTaskWorkflowEditGraphDefinition?: (
    definition: import("../types.ts").SavedTaskWorkflowDefinition,
  ) => void;
  onTaskWorkflowRunDefinition?: (
    definition: import("../types.ts").SavedTaskWorkflowDefinition,
  ) => void;
  onTaskWorkflowRemoveDefinition?: (
    definition: import("../types.ts").SavedTaskWorkflowDefinition,
  ) => void;
  onTaskWorkflowOpenRunGraph?: (flow: import("../types.ts").TaskFlowRecord) => void;
  onTaskWorkflowCancelRun?: (flow: import("../types.ts").TaskFlowRecord) => void;
  onTaskWorkflowCancel?: () => void;
  onTaskStandingOrderCreate?: (agentId: string) => void;
  onTaskStandingOrderEdit?: (order: import("../types.ts").StandingOrderRecord) => void;
  onTaskStandingOrderPatch?: (patch: Partial<import("../types.ts").StandingOrderDraft>) => void;
  onTaskStandingOrderSave?: (agentId: string) => void;
  onTaskStandingOrderRemove?: (order: import("../types.ts").StandingOrderRecord) => void;
  onTaskStandingOrderPropose?: (order: import("../types.ts").StandingOrderRecord) => void;
  onTaskStandingOrderCancel?: () => void;
  onCronRunDetail?: (runId: string) => void;
  onCronRemove: (job: CronJob) => void;
  onCronCreate: (agentId: string) => void;
  onCronOpenSession?: (sessionKey: string) => void;
  onWebhookTriggerCreate?: (agentId: string) => void;
  onWebhookTriggerEdit?: (trigger: WebhookTrigger) => void;
  onWebhookTriggerPatch?: (
    patch: Partial<import("../controllers/webhook-triggers.ts").WebhookTriggerDraft>,
  ) => void;
  onWebhookTriggerSave?: () => void;
  onWebhookTriggerCancel?: () => void;
  onWebhookTriggerRemove?: (trigger: WebhookTrigger) => void;
  onWebhookTriggerToggle?: (trigger: WebhookTrigger, enabled: boolean) => void;
  onWebhookTriggerTest?: (trigger: WebhookTrigger) => void;
  onTaskFiltersChange: (patch: Partial<AgentsProps["taskFilters"]>) => void;
  onSkillsFilterChange: (next: string) => void;
  onSkillsRefresh: () => void;
  onAgentSkillToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  onAgentSkillsClear: (agentId: string) => void;
  onAgentSkillsNarrowToSelected: (agentId: string) => void;
  onAgentSkillsDisableAll: (agentId: string) => void;
  onOpenSkillDetail?: (skillKey: string, agentId: string) => void;
  onCreateSkill?: (agentId: string) => void;
  onSkillEdit: (skillKey: string, value: string) => void;
  onSkillSaveKey: (skillKey: string) => void;
  onSkillInstall: (skillKey: string, name: string, installId: string) => void;
  onSkillEnabledChange: (skillKey: string, enabled: boolean) => void;
  onSessionMemoryEnabledChange: (enabled: boolean) => void;
  onMemoryWikiRebuild?: () => void;
  onSetDefault: (agentId: string) => void;
};

function slugifyAgentName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function defaultWorkspaceForAgentSlug(slug: string): string {
  return `~/.fased/workspace/agents/${slug || "new-agent"}`;
}

function providerLabel(provider: string): string {
  const manifest = getProviderBrandManifest(provider) ?? getProviderBrandManifestForRoute(provider);
  if (manifest) {
    return manifest.label;
  }
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerBrandId(provider: string): string {
  return getProviderBrandManifestForRoute(provider)?.id ?? provider;
}

type AgentCreateModelOption = {
  provider: string;
  brandId: string;
  value: string;
  label: string;
};

function addAgentCreateModelOption(
  options: Map<string, AgentCreateModelOption>,
  params: { provider: string; id: string; label?: string },
) {
  const provider = params.provider.trim();
  const id = params.id.trim();
  if (!provider || !id) {
    return;
  }
  const value = id.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
    ? id
    : `${provider}/${id}`;
  if (options.has(value)) {
    return;
  }
  options.set(value, {
    provider,
    brandId: providerBrandId(provider),
    value,
    label: params.label?.trim() || id,
  });
}

function buildAgentCreateModelOptions(props: AgentsProps) {
  const options = new Map<string, AgentCreateModelOption>();
  for (const entry of props.modelCatalog) {
    const provider = entry.provider?.trim();
    if (!provider) {
      continue;
    }
    if (!isStandardProviderCatalogEntry(entry)) {
      continue;
    }
    addAgentCreateModelOption(options, {
      provider,
      id: entry.id,
      label: modelLabel(entry),
    });
  }
  return Array.from(options.values()).toSorted(
    (a, b) =>
      providerLabel(a.brandId).localeCompare(providerLabel(b.brandId)) ||
      a.label.localeCompare(b.label),
  );
}

function isAuthReadyProviderStatus(status: string): boolean {
  return status === "ok" || status === "expiring" || status === "static";
}

function providerEntriesFromSetup(props: AgentsProps) {
  const providers = new Map<string, string>();
  for (const provider of props.providers.authStatus?.providers ?? []) {
    if (isAuthReadyProviderStatus(provider.status)) {
      providers.set(providerBrandId(provider.provider), providerLabel(provider.provider));
    }
  }
  return Array.from(providers.entries())
    .map(([id, label]) => ({ id, label }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

function modelLabel(entry: ModelCatalogEntry): string {
  return entry.name && entry.name !== entry.id ? `${entry.name} (${entry.id})` : entry.id;
}

function renderProviderModelOptions(
  providerEntries: Array<{ id: string; label: string }>,
  options: AgentCreateModelOption[],
) {
  const byProvider = new Map<string, AgentCreateModelOption[]>();
  for (const entry of options) {
    const current = byProvider.get(entry.brandId) ?? [];
    current.push(entry);
    byProvider.set(entry.brandId, current);
  }
  const priority = (entry: AgentCreateModelOption) =>
    entry.value === `${entry.provider}/auto` || entry.value === "openrouter/auto" ? 0 : 1;
  return providerEntries.map((providerEntry) => {
    const provider = providerEntry.id;
    const providerModels = (byProvider.get(provider) ?? [])
      .slice()
      .toSorted((a, b) => priority(a) - priority(b) || a.label.localeCompare(b.label));
    return html`
    <optgroup label=${providerLabel(provider)} data-provider=${provider}>
      ${
        providerModels.length > 0
          ? providerModels.map(
              (entry) => html`
                <option value=${entry.value} data-provider=${provider} hidden disabled>
                  ${entry.label}
                </option>
              `,
            )
          : html`
              <option value=${`__no-models__:${provider}`} data-provider=${provider} data-no-models="true" hidden disabled>
                No models yet
              </option>
            `
      }
    </optgroup>
  `;
  });
}

function renderProviderModelButtons(options: AgentCreateModelOption[]) {
  return options.map(
    (entry) => html`
    <button
      class="chat-select__option agent-create-select__model-option"
      type="button"
      role="option"
      aria-selected="false"
      title=${entry.label}
      data-agent-create-model-option="true"
      data-provider=${entry.brandId}
      data-value=${entry.value}
      hidden
      @click=${(event: Event) => {
        const button = event.currentTarget as HTMLButtonElement;
        const form = button.closest("form");
        const select = form?.querySelector<HTMLSelectElement>('select[name="model"]');
        if (!form || !select) {
          return;
        }
        select.value = button.dataset.value ?? "";
        select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        const details = button.closest("details");
        if (details instanceof HTMLDetailsElement) {
          details.open = false;
        }
        syncAgentCreateModelProviderFilter(form);
      }}
    >
      ${entry.label}
    </button>
  `,
  );
}

function updateAgentCreateSelectLabels(form: HTMLFormElement) {
  const providerSelect = form.querySelector<HTMLSelectElement>('select[name="provider"]');
  const modelSelect = form.querySelector<HTMLSelectElement>('select[name="model"]');
  const providerLabel = form.querySelector<HTMLElement>('[data-agent-provider-selected="true"]');
  const modelLabel = form.querySelector<HTMLElement>('[data-agent-model-selected="true"]');
  if (providerSelect && providerLabel) {
    providerLabel.textContent =
      providerSelect.selectedOptions[0]?.textContent?.trim() || "Inherit default";
  }
  if (modelSelect && modelLabel) {
    modelLabel.textContent =
      modelSelect.selectedOptions[0]?.textContent?.trim() || "Inherit default";
  }
}

function updateAgentCreateActiveOptions(form: HTMLFormElement) {
  const providerSelect = form.querySelector<HTMLSelectElement>('select[name="provider"]');
  const modelSelect = form.querySelector<HTMLSelectElement>('select[name="model"]');
  for (const button of Array.from(
    form.querySelectorAll<HTMLButtonElement>('[data-agent-create-provider-option="true"]'),
  )) {
    const active = button.dataset.value === (providerSelect?.value ?? "");
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  for (const button of Array.from(
    form.querySelectorAll<HTMLButtonElement>('[data-agent-create-model-option="true"]'),
  )) {
    const active = button.dataset.value === (modelSelect?.value ?? "");
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
}

function syncAgentCreateModelProviderFilter(form: HTMLFormElement) {
  const providerSelect = form.querySelector<HTMLSelectElement>('select[name="provider"]');
  const modelSelect = form.querySelector<HTMLSelectElement>('select[name="model"]');
  if (!providerSelect || !modelSelect) {
    return;
  }
  const provider = providerSelect.value;
  let selectedStillVisible = !provider && modelSelect.value === "";
  let firstAvailableModel = "";
  for (const group of Array.from(
    modelSelect.querySelectorAll<HTMLOptGroupElement>("optgroup[data-provider]"),
  )) {
    const groupProvider = group.dataset.provider;
    group.hidden = Boolean(provider) && groupProvider !== provider;
  }
  for (const option of Array.from(modelSelect.options)) {
    const optionProvider = option.dataset.provider;
    if (!optionProvider) {
      option.hidden = false;
      option.disabled = false;
      continue;
    }
    const visible = Boolean(provider) && optionProvider === provider;
    const isNotice = option.dataset.noModels === "true";
    option.hidden = !visible;
    option.disabled = !visible || isNotice;
    if (visible && !isNotice && !firstAvailableModel) {
      firstAvailableModel = option.value;
    }
    if (visible && !isNotice && option.value === modelSelect.value) {
      selectedStillVisible = true;
    }
  }
  for (const button of Array.from(
    form.querySelectorAll<HTMLButtonElement>(
      '[data-agent-create-model-option="true"][data-provider]',
    ),
  )) {
    const visible = Boolean(provider) && button.dataset.provider === provider;
    button.hidden = !visible;
    button.disabled = !visible;
  }
  if (!selectedStillVisible) {
    modelSelect.value = provider ? firstAvailableModel : "";
  }
  updateAgentCreateSelectLabels(form);
  updateAgentCreateActiveOptions(form);
}

function openAgentCreateDialog(event: Event) {
  const root = (event.currentTarget as HTMLElement).closest(".agents-toolbar");
  const dialog = root?.querySelector<HTMLDialogElement>('dialog[data-agent-create-dialog="true"]');
  if (!dialog) {
    return;
  }
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function openAgentSelectDialog(event: Event) {
  const root = (event.currentTarget as HTMLElement).closest(".agents-toolbar");
  const dialog = root?.querySelector<HTMLDialogElement>('dialog[data-agent-select-dialog="true"]');
  if (!dialog) {
    return;
  }
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function readAgentCreateAvatarFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Avatar read failed.")),
    );
    reader.readAsDataURL(file);
  });
}

function handleAgentCreateAvatarFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  if (!file || !file.type.startsWith("image/")) {
    input.value = "";
    return;
  }
  const form = input.closest("form");
  const avatarInput = form?.querySelector<HTMLInputElement>('input[name="avatar"]');
  void readAgentCreateAvatarFile(file).then((result) => {
    if (result && avatarInput) {
      avatarInput.value = result;
      avatarInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }
    input.value = "";
  });
}

function renderAgentCreateForm(props: AgentsProps) {
  const providerEntries = providerEntriesFromSetup(props);
  const modelOptions = buildAgentCreateModelOptions(props);
  const readFormText = (value: FormDataEntryValue | null) =>
    typeof value === "string" ? value : "";
  const updateSlugPreview = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const slug = slugifyAgentName(input.value);
    const preview = input.form?.querySelector<HTMLInputElement>(
      'input[data-agent-id-preview="true"]',
    );
    if (preview) {
      preview.value = slug;
    }
    const workspace = input.form?.querySelector<HTMLInputElement>(
      'input[data-agent-workspace-input="true"]',
    );
    if (workspace && workspace.dataset.agentWorkspaceTouched !== "true") {
      workspace.value = defaultWorkspaceForAgentSlug(slug);
    }
  };
  return html`
    <dialog
      class="agents-create-dialog"
      data-agent-create-dialog="true"
      @click=${closeDialogOnBackdropClick}
    >
      <form
        id="agent-create-form"
        data-agent-create-form="true"
        class="agents-create-form"
        method="dialog"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const form = event.currentTarget as HTMLFormElement;
          const data = new FormData(form);
          const name = readFormText(data.get("name"));
          const workspace =
            readFormText(data.get("workspace")) ||
            defaultWorkspaceForAgentSlug(slugifyAgentName(name));
          const avatar = readFormText(data.get("avatar"));
          props.onCreateAgent({
            name,
            workspace,
            model: readFormText(data.get("model")) || null,
            ...(avatar ? { avatar } : {}),
          });
        }}
      >
        <div class="agents-create-form__head">
          <div>
            <div class="agents-create-form__title">Create Agent</div>
          </div>
          <button
            type="button"
            class="btn btn--sm btn--ghost"
            @click=${(event: Event) =>
              (event.currentTarget as HTMLElement).closest("dialog")?.close()}
          >
            Close
          </button>
        </div>

        <div class="agents-create-form__grid">
          <label class="field">
            <span>Name</span>
            <input
              name="name"
              autocomplete="off"
              placeholder="Research Ops"
              required
              @input=${updateSlugPreview}
            />
          </label>
          <div class="field agents-avatar-field">
            <span>Avatar</span>
            <div class="agents-avatar-row">
              <input
                name="avatar"
                autocomplete="off"
                placeholder="A, image URL, or uploaded avatar"
              />
              <label class="btn btn--sm btn--ghost agents-avatar-upload">
                ${icons.image} Upload
                <input type="file" accept="image/*" @change=${handleAgentCreateAvatarFile} />
              </label>
            </div>
          </div>
          <label class="field">
            <span>Generated ID</span>
            <input
              data-agent-id-preview="true"
              autocomplete="off"
              readonly
              placeholder="research-ops"
            />
          </label>
          <label class="field">
            <span>Provider</span>
            <div class="chat-select agent-create-select agent-create-select--provider">
              <label class="field chat-select__native-wrap">
                <select
                  class="chat-select__native"
                  name="provider"
                  ?disabled=${providerEntries.length === 0}
                  @change=${(event: Event) =>
                    syncAgentCreateModelProviderFilter(
                      (event.currentTarget as HTMLSelectElement).form!,
                    )}
                >
                  <option value="">Inherit default</option>
                  ${providerEntries.map(
                    (provider) => html`
                    <option value=${provider.id}>${provider.label}</option>
                  `,
                  )}
                </select>
              </label>
              <details class="chat-select__popover">
                <summary
                  class="chat-select__button"
                  aria-label="Provider"
                  aria-disabled=${providerEntries.length === 0}
                  @click=${(event: Event) => {
                    if (providerEntries.length === 0) {
                      event.preventDefault();
                    }
                  }}
                >
                  <span data-agent-provider-selected="true">Inherit default</span>
                  ${icons.chevronDown}
                </summary>
                <div class="chat-select__panel" role="listbox" aria-label="Provider">
                  <button
                    class="chat-select__option active"
                    type="button"
                    role="option"
                    aria-selected="true"
                    data-agent-create-provider-option="true"
                    data-value=""
                    @click=${(event: Event) => {
                      const button = event.currentTarget as HTMLButtonElement;
                      const form = button.closest("form");
                      const select =
                        form?.querySelector<HTMLSelectElement>('select[name="provider"]');
                      if (!form || !select) {
                        return;
                      }
                      select.value = "";
                      select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
                      select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
                      const details = button.closest("details");
                      if (details instanceof HTMLDetailsElement) {
                        details.open = false;
                      }
                      syncAgentCreateModelProviderFilter(form);
                    }}
                  >
                    Inherit default
                  </button>
                  ${providerEntries.map(
                    (provider) => html`
                    <button
                      class="chat-select__option"
                      type="button"
                      role="option"
                      aria-selected="false"
                      title=${provider.label}
                      data-agent-create-provider-option="true"
                      data-value=${provider.id}
                      @click=${(event: Event) => {
                        const button = event.currentTarget as HTMLButtonElement;
                        const form = button.closest("form");
                        const select =
                          form?.querySelector<HTMLSelectElement>('select[name="provider"]');
                        if (!form || !select) {
                          return;
                        }
                        select.value = provider.id;
                        select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
                        select.dispatchEvent(
                          new Event("change", { bubbles: true, composed: true }),
                        );
                        const details = button.closest("details");
                        if (details instanceof HTMLDetailsElement) {
                          details.open = false;
                        }
                        syncAgentCreateModelProviderFilter(form);
                      }}
                    >
                      ${provider.label}
                    </button>
                  `,
                  )}
                </div>
              </details>
            </div>
          </label>
          <label class="field">
            <span>Default model</span>
            <div class="chat-select agent-create-select agent-create-select--model">
              <label class="field chat-select__native-wrap">
                <select
                  class="chat-select__native"
                  name="model"
                  ?disabled=${providerEntries.length === 0}
                  @change=${(event: Event) =>
                    syncAgentCreateModelProviderFilter(
                      (event.currentTarget as HTMLSelectElement).form!,
                    )}
                >
                  <option value="">Inherit default</option>
                  ${renderProviderModelOptions(providerEntries, modelOptions)}
                </select>
              </label>
              <details class="chat-select__popover">
                <summary
                  class="chat-select__button"
                  aria-label="Default model"
                  aria-disabled=${providerEntries.length === 0}
                  @click=${(event: Event) => {
                    if (providerEntries.length === 0) {
                      event.preventDefault();
                    }
                  }}
                >
                  <span data-agent-model-selected="true">Inherit default</span>
                  ${icons.chevronDown}
                </summary>
                <div class="chat-select__panel" role="listbox" aria-label="Default model">
                  <button
                    class="chat-select__option active"
                    type="button"
                    role="option"
                    aria-selected="true"
                    data-agent-create-model-option="true"
                    data-value=""
                    @click=${(event: Event) => {
                      const button = event.currentTarget as HTMLButtonElement;
                      const form = button.closest("form");
                      const select = form?.querySelector<HTMLSelectElement>('select[name="model"]');
                      if (!form || !select) {
                        return;
                      }
                      select.value = "";
                      select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
                      select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
                      const details = button.closest("details");
                      if (details instanceof HTMLDetailsElement) {
                        details.open = false;
                      }
                      syncAgentCreateModelProviderFilter(form);
                    }}
                  >
                    Inherit default
                  </button>
                  ${renderProviderModelButtons(modelOptions)}
                </div>
              </details>
            </div>
          </label>
          <div class="field agents-create-form__advanced-field">
            <span>Workspace</span>
            <details class="agents-create-form__advanced">
              <summary>Advanced</summary>
              <input
                name="workspace"
                autocomplete="off"
                data-agent-workspace-input="true"
                placeholder="~/.fased/workspace/agents/research-ops"
                @input=${(event: Event) => {
                  (event.currentTarget as HTMLInputElement).dataset.agentWorkspaceTouched = "true";
                }}
              />
            </details>
          </div>
        </div>

        ${
          props.agentCreateMessage
            ? html`<div class="agents-create-form__message">${props.agentCreateMessage}</div>`
            : nothing
        }
        <div class="agents-create-form__footer">
          <button
            type="submit"
            class="btn btn--sm primary"
            ?disabled=${props.agentCreateBusy}
          >
            ${props.agentCreateBusy ? "Creating..." : html`${icons.plus} Agent`}
          </button>
        </div>
      </form>
    </dialog>
  `;
}

export function renderAgents(props: AgentsProps) {
  const agents = props.agentsList?.agents ?? [];
  const defaultId = props.agentsList?.defaultId ?? null;
  const selectedId = props.selectedAgentId ?? defaultId ?? agents[0]?.id ?? null;
  const selectedAgent = selectedId
    ? (agents.find((agent) => agent.id === selectedId) ?? null)
    : null;
  const summarizeAgent = (agent: AgentsListResult["agents"][number]) => {
    const context = buildAgentContext(
      agent,
      props.config.form,
      props.agentFiles.list,
      defaultId,
      props.agentIdentityById[agent.id] ?? null,
    );
    return {
      label: normalizeAgentLabel(agent),
      meta: `${agent.id}${context.isDefault ? " · default" : ""}`,
      workspace: context.workspace,
    };
  };
  const selectedAgentSummary = selectedAgent ? summarizeAgent(selectedAgent) : null;
  const selectedAgentLabel = selectedAgentSummary?.label ?? "No agents";
  const selectedAgentMeta = selectedAgentSummary?.meta ?? "Create an Agent to start";
  const selectedSkillCount =
    selectedId && props.agentSkills.agentId === selectedId
      ? (props.agentSkills.report?.skills?.length ?? null)
      : null;

  const channelEntryCount = countActiveChannels(props.channels.snapshot);
  const selectedAgentTaskJobs = selectedId
    ? props.cron.jobs.filter((job) => job.agentId === selectedId)
    : [];
  const selectedAgentTriggers = selectedId
    ? (props.webhookTriggers?.result?.triggers.filter((trigger) => trigger.agentId === selectedId)
        .length ?? 0)
    : 0;
  const selectedAgentWorkflowDefinitions = selectedId
    ? (props.taskWorkflow?.definitions?.definitions.filter(
        (definition) => definition.agentId === selectedId && definition.mode !== "graph",
      ).length ?? 0)
    : 0;
  const selectedAgentGraphDefinitions = selectedId
    ? (props.taskWorkflow?.definitions?.definitions.filter(
        (definition) => definition.agentId === selectedId && definition.mode === "graph",
      ).length ?? 0)
    : 0;
  const selectedAgentPrograms = selectedId
    ? (props.taskStandingOrders?.result?.orders.filter((order) => order.agentId === selectedId)
        .length ?? 0)
    : 0;
  const agentWorkDefinitionCount = selectedId
    ? selectedAgentTaskJobs.length +
      selectedAgentTriggers +
      selectedAgentWorkflowDefinitions +
      selectedAgentGraphDefinitions +
      selectedAgentPrograms
    : null;
  const tabCounts: Record<string, number | null> = {
    providers: props.providers.authStatus?.providers.length ?? null,
    sessions:
      selectedId && props.sessions.result
        ? props.sessions.result.sessions.filter(
            (row) =>
              parseAgentSessionKey(row.key)?.agentId?.toLowerCase() === selectedId.toLowerCase(),
          ).length
        : null,
    files: props.agentFiles.list?.files?.length ?? null,
    skills: selectedSkillCount,
    channels: channelEntryCount,
    services: null,
    memory: props.memory.inventory?.sessionMemory?.enabled ? 1 : null,
    cron: agentWorkDefinitionCount,
  };

  return html`
    <div class="agents-layout">
      <style>
        .agents-toolbar {
          display: grid;
          gap: 10px;
        }

        .agents-toolbar-row {
          align-items: center;
          justify-content: flex-start;
        }

        .agents-control-select {
          flex: 0 1 min(320px, 100%);
          min-width: min(240px, 100%);
          max-width: 340px;
        }

        .agents-select-native-wrap {
          border: 0;
          clip: rect(0 0 0 0);
          clip-path: inset(50%);
          height: 1px;
          margin: -1px;
          overflow: hidden;
          padding: 0;
          position: absolute;
          white-space: nowrap;
          width: 1px;
        }

        .agents-select-trigger {
          align-items: center;
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text);
          cursor: pointer;
          display: flex;
          gap: 10px;
          min-height: 36px;
          padding: 6px 10px;
          text-align: left;
          width: 100%;
        }

        .agents-select-trigger:hover,
        .agents-select-trigger:focus-visible {
          background: var(--bg-hover);
          border-color: var(--border-strong);
        }

        .agents-select-trigger__text {
          align-items: baseline;
          display: flex;
          gap: 8px;
          min-width: 0;
          overflow: hidden;
        }

        .agents-select-trigger__name,
        .agents-select-option__name {
          color: var(--text-strong);
          font-size: 13px;
          font-weight: 800;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .agents-select-trigger__meta,
        .agents-select-option__meta,
        .agents-select-trigger__space,
        .agents-select-option__space {
          color: var(--muted);
          font-size: 11px;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .agents-select-trigger svg {
          color: var(--muted);
          flex: 0 0 auto;
          height: 16px;
          margin-left: auto;
          width: 16px;
        }

        .agents-select-dialog {
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          box-shadow: 0 22px 60px rgba(0, 0, 0, 0.42);
          color: var(--text);
          max-height: min(640px, calc(100vh - 28px));
          overflow: hidden;
          padding: 0;
          width: min(540px, calc(100vw - 28px));
        }

        .agents-select-dialog::backdrop {
          background: rgba(0, 0, 0, 0.58);
        }

        .agents-select-dialog__body {
          display: grid;
          gap: 8px;
          max-height: min(560px, calc(100vh - 92px));
          overflow: auto;
          padding: 12px;
        }

        .agents-select-option {
          align-items: center;
          background: transparent;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text);
          cursor: pointer;
          display: flex;
          gap: 8px;
          min-width: 0;
          padding: 10px;
          text-align: left;
        }

        .agents-select-option:hover,
        .agents-select-option:focus-visible {
          background: var(--bg-hover);
          border-color: var(--border-strong);
        }

        .agents-select-option.active {
          background: var(--text-strong);
          border-color: var(--text-strong);
          color: var(--bg);
        }

        .agents-select-option.active .agents-select-option__name,
        .agents-select-option.active .agents-select-option__meta,
        .agents-select-option.active .agents-select-option__space {
          color: inherit;
        }

        .agents-create-dialog {
          width: min(560px, calc(100vw - 28px));
          max-height: min(760px, calc(100vh - 28px));
          overflow: visible;
          padding: 0;
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          background: var(--panel);
          color: var(--text);
          box-shadow: 0 22px 60px rgba(0, 0, 0, 0.42);
        }

        .agents-create-dialog::backdrop {
          background: rgba(0, 0, 0, 0.58);
        }

        .agents-create-form {
          display: grid;
          gap: 13px;
          padding: 16px;
        }

        .agents-create-form__head {
          align-items: flex-start;
          display: flex;
          gap: 10px;
          justify-content: space-between;
        }

        .agents-create-form__eyebrow {
          color: var(--muted);
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .agents-create-form__title {
          color: var(--text-strong);
          font-size: 16px;
          font-weight: 800;
          margin-top: 2px;
        }

        .agents-create-form__sub,
        .agents-create-form__message {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.45;
          margin-top: 3px;
        }

        .agents-create-form__grid {
          display: grid;
          gap: 10px;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .agents-create-form .field {
          min-width: 0;
        }

        .agents-create-form .field input,
        .agents-create-form .field select {
          min-width: 0;
          width: 100%;
        }

        .agents-avatar-row {
          align-items: center;
          display: grid;
          gap: 6px;
          grid-template-columns: minmax(0, 1fr) auto;
        }

        .agents-avatar-upload {
          align-items: center;
          display: inline-flex;
          gap: 6px;
          min-height: 36px;
        }

        .agents-avatar-upload input {
          border: 0;
          clip: rect(0 0 0 0);
          clip-path: inset(50%);
          height: 1px;
          margin: -1px;
          overflow: hidden;
          padding: 0;
          position: absolute;
          white-space: nowrap;
          width: 1px;
        }

        .agents-avatar-upload svg {
          height: 15px;
          width: 15px;
        }

        .agents-create-form .chat-select {
          position: relative;
          width: 100%;
        }

        .agents-create-form .chat-select__native-wrap {
          position: absolute;
          width: 1px;
          height: 1px;
          margin: 0;
          opacity: 0;
          overflow: hidden;
          pointer-events: none;
        }

        .agents-create-form .chat-select__native {
          width: 1px;
          height: 1px;
          min-height: 0;
          padding: 0;
          border: 0;
        }

        .agents-create-form .chat-select__panel {
          z-index: 140;
        }

        .agents-create-select--provider .chat-select__panel {
          width: min(260px, calc(100vw - 54px));
        }

        .agents-create-select--model .chat-select__panel {
          width: min(420px, calc(100vw - 54px));
        }

        .agents-create-form__advanced {
          align-self: start;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 10px;
        }

        .agents-create-form__advanced summary {
          color: var(--text-strong);
          cursor: pointer;
          font-size: 12px;
          font-weight: 800;
        }

        .agents-create-form__advanced input {
          margin-top: 10px;
        }

        .agents-create-form__footer {
          align-items: center;
          display: flex;
          gap: 10px;
          justify-content: flex-end;
        }

        .agent-task-subtabs {
          align-items: center;
          display: inline-flex;
          gap: 4px;
          margin-bottom: 10px;
        }

        .agent-task-subtab {
          align-items: center;
          background: transparent;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--muted);
          cursor: pointer;
          display: inline-flex;
          gap: 6px;
          min-height: 34px;
          padding: 6px 10px;
        }

        .agent-task-subtab:hover,
        .agent-task-subtab:focus-visible {
          background: var(--bg-hover);
          color: var(--text-strong);
          outline: none;
        }

        .agent-task-subtab.active {
          background: var(--button-bg);
          border-color: var(--button-bg);
          color: var(--button-text);
        }

        .agent-task-subtab-count {
          color: currentColor;
          opacity: 0.72;
        }

        @media (max-width: 820px) {
          .agents-create-form__grid {
            grid-template-columns: 1fr;
          }

          .agents-create-form__footer {
            align-items: flex-start;
            flex-direction: column;
          }
        }
      </style>
      <section class="agents-toolbar">
        <div class="agents-toolbar-row">
          <div class="agents-control-select">
            <div class="agents-select-native-wrap">
              <select
                class="agents-select"
                data-agent-select="true"
                .value=${selectedId ?? ""}
                ?disabled=${props.loading || agents.length === 0}
                @change=${(e: Event) => props.onSelectAgent((e.target as HTMLSelectElement).value)}
              >
                ${
                  agents.length === 0
                    ? html`
                        <option value="">No agents</option>
                      `
                    : agents.map(
                        (agent) => html`
                        <option value=${agent.id} ?selected=${agent.id === selectedId}>
                          ${normalizeAgentLabel(agent)}${
                            agentBadgeText(agent.id, defaultId)
                              ? ` (${agentBadgeText(agent.id, defaultId)})`
                              : ""
                          }
                        </option>
                      `,
                      )
                }
              </select>
            </div>
            <button
              type="button"
              class="agents-select-trigger"
              @click=${openAgentSelectDialog}
              ?disabled=${props.loading || agents.length === 0}
              title=${
                selectedAgent
                  ? `${selectedAgentLabel} · ${selectedAgent.id} · ${selectedAgentSummary?.workspace}`
                  : selectedAgentMeta
              }
            >
              <span class="agents-select-trigger__text">
                <span class="agents-select-trigger__name">${selectedAgentLabel}</span>
                <span
                  class="agents-select-trigger__meta"
                  title=${selectedAgentSummary?.workspace ?? ""}
                >
                  ${selectedAgentMeta}
                </span>
                ${
                  selectedAgentSummary
                    ? html`
                        <span
                          class="agents-select-trigger__space"
                          title=${selectedAgentSummary.workspace}
                        >
                          Space
                        </span>
                      `
                    : nothing
                }
              </span>
              ${icons.chevronDown}
            </button>
            <dialog
              class="agents-select-dialog"
              data-agent-select-dialog="true"
              @click=${closeDialogOnBackdropClick}
            >
              <div class="agents-select-dialog__body">
                ${agents.map((agent) => {
                  const summary = summarizeAgent(agent);
                  return html`
                    <button
                      type="button"
                      class="agents-select-option ${agent.id === selectedId ? "active" : ""}"
                      title=${`${summary.label} · ${agent.id} · ${summary.workspace}`}
                      @click=${(event: Event) => {
                        props.onSelectAgent(agent.id);
                        const dialog = (event.currentTarget as HTMLElement).closest("dialog");
                        if (dialog instanceof HTMLDialogElement) {
                          dialog.close();
                        }
                      }}
                    >
                      <span class="agents-select-option__name">${summary.label}</span>
                      <span class="agents-select-option__meta" title=${summary.workspace}>
                        ${summary.meta}
                      </span>
                      <span class="agents-select-option__space" title=${summary.workspace}>
                        Space
                      </span>
                    </button>
                  `;
                })}
              </div>
            </dialog>
          </div>
          <button
            type="button"
            class="btn btn--sm primary"
            @click=${openAgentCreateDialog}
          >
            ${icons.plus} Agent
          </button>
          <div class="agents-toolbar-actions">
            ${
              selectedAgent && (!defaultId || selectedAgent.id !== defaultId)
                ? html`
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    @click=${() => props.onSetDefault(selectedAgent.id)}
                    title="Set as the default agent"
                  >
                    Set Default
                  </button>
                `
                : nothing
            }
          </div>
        </div>
        ${renderAgentCreateForm(props)}
        ${
          props.error
            ? html`<div class="callout danger" style="margin-top: 8px;">${props.error}</div>`
            : nothing
        }
      </section>
      <section class="agents-main">
        ${
          !selectedAgent
            ? html`
                <div class="card">
                  <div class="card-title">Choose Agent</div>
                  <div class="card-sub">Choose an Agent or create one.</div>
                </div>
              `
            : html`
              ${renderAgentTabs(
                props.activePanel,
                (panel) => props.onSelectPanel(panel),
                tabCounts,
              )}
              ${
                props.activePanel === "overview"
                  ? renderAgentOverview({
                      agent: selectedAgent,
                      basePath: props.basePath,
                      defaultId,
                      configForm: props.config.form,
                      agentFilesList: props.agentFiles.list,
                      agentIdentity: props.agentIdentityById[selectedAgent.id] ?? null,
                      agentIdentityError: props.agentIdentityError,
                      agentIdentityLoading: props.agentIdentityLoading,
                      configLoading: props.config.loading,
                      configSaving: props.config.saving,
                      configDirty: props.config.dirty,
                      channels: props.channels,
                      sessions: props.sessions,
                      cron: props.cron,
                      webhookTriggers: props.webhookTriggers,
                      taskLedger: props.taskLedger,
                      taskWorkflow: props.taskWorkflow,
                      taskStandingOrders: props.taskStandingOrders,
                      agentSkills: props.agentSkills,
                      memory: props.memory,
                      providers: props.providers,
                      usage: props.usage,
                      toolsCatalog: props.toolsCatalog,
                      toolsEffective: {
                        ...props.toolsEffective,
                        runtimeSessionMatchesSelectedAgent:
                          props.runtimeSessionMatchesSelectedAgent,
                      },
                      plugins: props.plugins,
                      wallet: props.wallet,
                      mining: props.mining,
                      federation: props.federation,
                      modelCatalog: props.modelCatalog,
                      skillEdits: props.skillEdits,
                      skillsBusyKey: props.skillsBusyKey,
                      onConfigReload: props.onConfigReload,
                      onConfigSave: props.onConfigSave,
                      onModelChange: props.onModelChange,
                      onModelFallbacksChange: props.onModelFallbacksChange,
                      onTaskModelsChange: props.onTaskModelsChange,
                      onAgentIdentityAvatarChange: props.onAgentIdentityAvatarChange,
                      onActiveModelProviderChange: props.onActiveModelProviderChange,
                      onModelProviderChange: props.onModelProviderChange,
                      onSelectPanel: props.onSelectPanel,
                      onNavigate: props.onNavigate,
                      onOpenUsageForAgent: props.onOpenUsageForAgent,
                      onAgentSkillToggle: props.onAgentSkillToggle,
                      onToolsOverridesChange: props.onToolsOverridesChange,
                      onSkillEdit: props.onSkillEdit,
                      onSkillSaveKey: props.onSkillSaveKey,
                      onSkillInstall: props.onSkillInstall,
                      onSkillEnabledChange: props.onSkillEnabledChange,
                      onSessionMemoryEnabledChange: props.onSessionMemoryEnabledChange,
                    })
                  : nothing
              }
              ${
                props.activePanel === "files"
                  ? renderAgentFiles({
                      agentId: selectedAgent.id,
                      agentFilesList: props.agentFiles.list,
                      agentFilesLoading: props.agentFiles.loading,
                      agentFilesError: props.agentFiles.error,
                      agentFileActive: props.agentFiles.active,
                      agentFileContents: props.agentFiles.contents,
                      agentFileDrafts: props.agentFiles.drafts,
                      agentFileSaving: props.agentFiles.saving,
                      onLoadFiles: props.onLoadFiles,
                      onSelectFile: props.onSelectFile,
                      onFileDraftChange: props.onFileDraftChange,
                      onFileReset: props.onFileReset,
                      onFileSave: props.onFileSave,
                    })
                  : nothing
              }
              ${
                props.activePanel === "providers"
                  ? html`
                      ${renderAgentOverview({
                        surface: "providers",
                        agent: selectedAgent,
                        basePath: props.basePath,
                        defaultId,
                        configForm: props.config.form,
                        agentFilesList: props.agentFiles.list,
                        agentIdentity: props.agentIdentityById[selectedAgent.id] ?? null,
                        agentIdentityError: props.agentIdentityError,
                        agentIdentityLoading: props.agentIdentityLoading,
                        configLoading: props.config.loading,
                        configSaving: props.config.saving,
                        configDirty: props.config.dirty,
                        channels: props.channels,
                        sessions: props.sessions,
                        cron: props.cron,
                        agentSkills: props.agentSkills,
                        memory: props.memory,
                        providers: props.providers,
                        usage: props.usage,
                        toolsCatalog: props.toolsCatalog,
                        toolsEffective: {
                          ...props.toolsEffective,
                          runtimeSessionMatchesSelectedAgent:
                            props.runtimeSessionMatchesSelectedAgent,
                        },
                        plugins: props.plugins,
                        wallet: props.wallet,
                        mining: props.mining,
                        federation: props.federation,
                        modelCatalog: props.modelCatalog,
                        skillEdits: props.skillEdits,
                        skillsBusyKey: props.skillsBusyKey,
                        onConfigReload: props.onConfigReload,
                        onConfigSave: props.onConfigSave,
                        onModelChange: props.onModelChange,
                        onModelFallbacksChange: props.onModelFallbacksChange,
                        onTaskModelsChange: props.onTaskModelsChange,
                        onAgentIdentityAvatarChange: props.onAgentIdentityAvatarChange,
                        onActiveModelProviderChange: props.onActiveModelProviderChange,
                        onModelProviderChange: props.onModelProviderChange,
                        onSelectPanel: props.onSelectPanel,
                        onNavigate: props.onNavigate,
                        onOpenUsageForAgent: props.onOpenUsageForAgent,
                        onAgentSkillToggle: props.onAgentSkillToggle,
                        onToolsOverridesChange: props.onToolsOverridesChange,
                        onSkillEdit: props.onSkillEdit,
                        onSkillSaveKey: props.onSkillSaveKey,
                        onSkillInstall: props.onSkillInstall,
                        onSkillEnabledChange: props.onSkillEnabledChange,
                        onSessionMemoryEnabledChange: props.onSessionMemoryEnabledChange,
                      })}
                      ${props.providersPanel ?? nothing}
                    `
                  : nothing
              }
              ${
                props.activePanel === "sessions"
                  ? renderSessions({
                      loading: props.sessions.loading,
                      result: props.sessions.result,
                      error: props.sessions.error,
                      search: props.sessions.search ?? "",
                      activeMinutes: "",
                      limit: "",
                      includeGlobal: false,
                      includeUnknown: false,
                      basePath: props.basePath,
                      agentId: selectedAgent.id,
                      currentSessionKey: props.runtimeSessionKey,
                      title: "Sessions",
                      subtitle: "Conversations and task contexts for this Agent.",
                      showFilters: "auto",
                      filterControls: "search",
                      showLiveStatus: false,
                      showStorePath: false,
                      emptyText: "No sessions for this Agent yet.",
                      onFiltersChange: (next) => props.onSessionsSearchChange?.(next.search),
                      onRefresh: props.onSessionsRefresh,
                      onPatch: props.onSessionPatch,
                      onDelete: props.onSessionDelete,
                      onBranchCheckpoint: props.onSessionBranchCheckpoint,
                      onRestoreCheckpoint: props.onSessionRestoreCheckpoint,
                      taskJobs: props.cron.jobs,
                      taskLoading: props.cron.loading,
                      onTaskEdit: props.onCronEdit,
                      onTaskRun: (job) => props.onCronRunNow(job.id),
                      onTaskOpenRun: props.onCronOpenSession,
                      onTaskActivityOpen: () => props.onSelectPanel("cron"),
                      onTaskToggle: props.onCronToggle,
                      onTaskCancel: props.onCronRemove,
                    })
                  : nothing
              }
              ${
                props.activePanel === "tools"
                  ? renderAgentTools({
                      agentId: selectedAgent.id,
                      configForm: props.config.form,
                      configLoading: props.config.loading,
                      configSaving: props.config.saving,
                      configDirty: props.config.dirty,
                      toolsCatalogLoading: props.toolsCatalog.loading,
                      toolsCatalogError: props.toolsCatalog.error,
                      toolsCatalogResult: props.toolsCatalog.result,
                      toolsEffectiveLoading: props.toolsEffective.loading,
                      toolsEffectiveError: props.toolsEffective.error,
                      toolsEffectiveResult: props.toolsEffective.result,
                      runtimeSessionKey: props.runtimeSessionKey,
                      runtimeSessionMatchesSelectedAgent: props.runtimeSessionMatchesSelectedAgent,
                      onProfileChange: props.onToolsProfileChange,
                      onOverridesChange: props.onToolsOverridesChange,
                      onConfigReload: props.onConfigReload,
                      onConfigSave: props.onConfigSave,
                    })
                  : nothing
              }
              ${
                props.activePanel === "skills"
                  ? renderAgentSkills({
                      agentId: selectedAgent.id,
                      report: props.agentSkills.report,
                      loading: props.agentSkills.loading,
                      error: props.agentSkills.error,
                      activeAgentId: props.agentSkills.agentId,
                      configForm: props.config.form,
                      configLoading: props.config.loading,
                      configSaving: props.config.saving,
                      configDirty: props.config.dirty,
                      filter: props.agentSkills.filter,
                      onFilterChange: props.onSkillsFilterChange,
                      onRefresh: props.onSkillsRefresh,
                      onToggle: props.onAgentSkillToggle,
                      onClear: props.onAgentSkillsClear,
                      onNarrowToSelected: props.onAgentSkillsNarrowToSelected,
                      onDisableAll: props.onAgentSkillsDisableAll,
                      onOpenSkillDetail: props.onOpenSkillDetail
                        ? (skillKey) => props.onOpenSkillDetail?.(skillKey, selectedAgent.id)
                        : undefined,
                      onCreateSkill: props.onCreateSkill
                        ? () => props.onCreateSkill?.(selectedAgent.id)
                        : undefined,
                      skillsLibrary: props.skillsLibrary,
                      onConfigReload: props.onConfigReload,
                      onConfigSave: props.onConfigSave,
                    })
                  : nothing
              }
              ${
                props.activePanel === "memory"
                  ? renderAgentMemory({
                      agentId: selectedAgent.id,
                      configForm: props.config.form,
                      configLoading: props.config.loading,
                      configSaving: props.config.saving,
                      configDirty: props.config.dirty,
                      memory: props.memory,
                      onSessionMemoryEnabledChange: props.onSessionMemoryEnabledChange,
                      onMemoryWikiRebuild: props.onMemoryWikiRebuild,
                      onConfigPatch: props.onConfigPatch,
                      onConfigSave: props.onConfigSave,
                      onNavigate: props.onNavigate,
                    })
                  : nothing
              }
              ${
                props.activePanel === "channels"
                  ? renderAgentChannels({
                      context: buildAgentContext(
                        selectedAgent,
                        props.config.form,
                        props.agentFiles.list,
                        defaultId,
                        props.agentIdentityById[selectedAgent.id] ?? null,
                      ),
                      configForm: props.config.form,
                      configSchema: props.configSchema,
                      configSchemaLoading: props.configSchemaLoading,
                      configUiHints: props.configUiHints,
                      snapshot: props.channels.snapshot,
                      connected: props.connected,
                      loading: props.channels.loading,
                      error: props.channels.error,
                      lastSuccess: props.channels.lastSuccess,
                      channelRuntimeBusy: props.channelRuntimeBusy,
                      agentId: selectedAgent.id,
                      agentsList: props.agentsList,
                      configSaving: props.config.saving,
                      configDirty: props.config.dirty,
                      activeView: props.channelsView,
                      onViewChange: props.onChannelsViewChange,
                      onRefresh: props.onChannelsRefresh,
                      onChannelEnable: props.onChannelEnable,
                      onChannelStart: props.onChannelStart,
                      onChannelStop: props.onChannelStop,
                      onChannelLogout: props.onChannelLogout,
                      onConfigPatch: props.onConfigPatch,
                      onConfigRemove: props.onConfigRemove,
                      onConfigSave: props.onConfigSave,
                      onConfigReload: props.onConfigReload,
                      onOpenChannels: () => props.onNavigate("channels"),
                    })
                  : nothing
              }
              ${
                props.activePanel === "coordination"
                  ? html`
                      ${renderAgentTaskSubtabs(
                        "coordination",
                        props.onSelectPanel,
                        agentWorkDefinitionCount,
                      )}
                      ${renderAgentCoordination({
                        agentId: selectedAgent.id,
                        agentsList: props.agentsList,
                        configForm: props.config.form,
                        configLoading: props.config.loading,
                        configSaving: props.config.saving,
                        configDirty: props.config.dirty,
                        onConfigPatch: props.onConfigPatch,
                        onConfigRemove: props.onConfigRemove,
                        onConfigReload: props.onConfigReload,
                        onConfigSave: props.onConfigSave,
                      })}
                    `
                  : nothing
              }
              ${
                props.activePanel === "services"
                  ? html`
                      ${renderServices({
                        configForm: props.config.form,
                        skillsReport: props.agentSkills.report,
                        skillsLoading: props.agentSkills.loading,
                        pluginsMarketplace: props.plugins.marketplace,
                        webSearchProviders: props.services?.webSearchProviders,
                        webSearchProvidersLoading: props.services?.webSearchProvidersLoading,
                        configSaving: props.config.saving,
                        configDirty: props.config.dirty,
                        onNavigate: props.onNavigate,
                        onConfigPatch: props.onConfigPatch,
                        onConfigRemove: props.onConfigRemove,
                        onConfigSave: props.onConfigSave,
                        onConfigReload: props.onConfigReload,
                        onGmailProvision: props.onGmailProvision,
                        gmailProvisionBusy: props.services?.gmailProvisioning ?? false,
                        gmailProvisionMessage: props.services?.gmailProvisionMessage ?? null,
                        onWebSearchTest: props.onWebSearchTest,
                        webSearchTestBusy: props.services?.webSearchTesting ?? false,
                        webSearchTestMessage: props.services?.webSearchTestMessage ?? null,
                      })}
                    `
                  : nothing
              }
              ${
                props.activePanel === "cron"
                  ? html`
                      ${renderAgentTaskSubtabs("cron", props.onSelectPanel, agentWorkDefinitionCount)}
                      ${renderAgentCron({
                        context: buildAgentContext(
                          selectedAgent,
                          props.config.form,
                          props.agentFiles.list,
                          defaultId,
                          props.agentIdentityById[selectedAgent.id] ?? null,
                        ),
                        agentId: selectedAgent.id,
                        jobs: props.cron.jobs,
                        status: props.cron.status,
                        webhookTriggers: props.webhookTriggers,
                        taskLedger: props.taskLedger,
                        taskWorkflow: props.taskWorkflow,
                        taskStandingOrders: props.taskStandingOrders,
                        loading: props.cron.loading,
                        error: props.cron.error,
                        taskFilters: props.taskFilters,
                        onRefresh: props.onCronRefresh,
                        onEdit: props.onCronEdit,
                        onRunNow: props.onCronRunNow,
                        onToggle: props.onCronToggle,
                        onRepair: props.onCronRepair,
                        onApproveCoordination: props.onCronApproveCoordination,
                        onAskAgentEvidence: props.onCronAskAgentEvidence,
                        onSourceToggle: props.onCronSourceToggle,
                        onSourceRemove: props.onCronSourceRemove,
                        onQueueControl: props.onCronQueueControl,
                        onTaskLedgerRefresh: props.onTaskLedgerRefresh,
                        onTaskLedgerSourceFilterChange: props.onTaskLedgerSourceFilterChange,
                        onTaskLedgerTypeFilterChange: props.onTaskLedgerTypeFilterChange,
                        onTaskLedgerStatusFilterChange: props.onTaskLedgerStatusFilterChange,
                        onTaskLedgerPageChange: props.onTaskLedgerPageChange,
                        onTaskLedgerDetailOpen: props.onTaskLedgerDetailOpen,
                        onTaskLedgerControl: props.onTaskLedgerControl,
                        onTaskLedgerOpenSource: props.onTaskLedgerOpenSource,
                        onTaskLedgerWorkflowReview: props.onTaskLedgerWorkflowReview,
                        onTaskWorkflowCreate: props.onTaskWorkflowCreate,
                        onTaskWorkflowGraphCreate: props.onTaskWorkflowGraphCreate,
                        onTaskWorkflowUseTemplate: props.onTaskWorkflowUseTemplate,
                        onTaskTemplateUse: props.onTaskTemplateUse,
                        onTaskWorkflowPatch: props.onTaskWorkflowPatch,
                        onTaskWorkflowGraphPatch: props.onTaskWorkflowGraphPatch,
                        onTaskWorkflowGraphAddNode: props.onTaskWorkflowGraphAddNode,
                        onTaskWorkflowGraphUpdateNode: props.onTaskWorkflowGraphUpdateNode,
                        onTaskWorkflowGraphRemoveNode: props.onTaskWorkflowGraphRemoveNode,
                        onTaskWorkflowGraphMoveNode: props.onTaskWorkflowGraphMoveNode,
                        onTaskWorkflowGraphAddEdge: props.onTaskWorkflowGraphAddEdge,
                        onTaskWorkflowGraphUpdateEdge: props.onTaskWorkflowGraphUpdateEdge,
                        onTaskWorkflowGraphRemoveEdge: props.onTaskWorkflowGraphRemoveEdge,
                        onTaskWorkflowGraphAutoLayout: props.onTaskWorkflowGraphAutoLayout,
                        onTaskWorkflowGraphImportJson: props.onTaskWorkflowGraphImportJson,
                        onTaskWorkflowGraphExportJson: props.onTaskWorkflowGraphExportJson,
                        onTaskWorkflowPreview: props.onTaskWorkflowPreview,
                        onTaskWorkflowGraphPreview: props.onTaskWorkflowGraphPreview,
                        onTaskWorkflowSave: props.onTaskWorkflowSave,
                        onTaskWorkflowGraphSave: props.onTaskWorkflowGraphSave,
                        onTaskWorkflowRun: props.onTaskWorkflowRun,
                        onTaskWorkflowGraphRun: props.onTaskWorkflowGraphRun,
                        onTaskWorkflowEditDefinition: props.onTaskWorkflowEditDefinition,
                        onTaskWorkflowEditGraphDefinition: props.onTaskWorkflowEditGraphDefinition,
                        onTaskWorkflowRunDefinition: props.onTaskWorkflowRunDefinition,
                        onTaskWorkflowRemoveDefinition: props.onTaskWorkflowRemoveDefinition,
                        onTaskWorkflowOpenRunGraph: props.onTaskWorkflowOpenRunGraph,
                        onTaskWorkflowCancelRun: props.onTaskWorkflowCancelRun,
                        onTaskWorkflowCancel: props.onTaskWorkflowCancel,
                        onTaskStandingOrderCreate: props.onTaskStandingOrderCreate,
                        onTaskStandingOrderEdit: props.onTaskStandingOrderEdit,
                        onTaskStandingOrderPatch: props.onTaskStandingOrderPatch,
                        onTaskStandingOrderSave: props.onTaskStandingOrderSave,
                        onTaskStandingOrderRemove: props.onTaskStandingOrderRemove,
                        onTaskStandingOrderPropose: props.onTaskStandingOrderPropose,
                        onTaskStandingOrderCancel: props.onTaskStandingOrderCancel,
                        onRunDetail: props.onCronRunDetail,
                        onRemove: props.onCronRemove,
                        onCreate: props.onCronCreate,
                        onWebhookTriggerCreate: props.onWebhookTriggerCreate,
                        onWebhookTriggerEdit: props.onWebhookTriggerEdit,
                        onWebhookTriggerPatch: props.onWebhookTriggerPatch,
                        onWebhookTriggerSave: props.onWebhookTriggerSave,
                        onWebhookTriggerCancel: props.onWebhookTriggerCancel,
                        onWebhookTriggerRemove: props.onWebhookTriggerRemove,
                        onWebhookTriggerToggle: props.onWebhookTriggerToggle,
                        onWebhookTriggerTest: props.onWebhookTriggerTest,
                        onOpenSession: props.onCronOpenSession,
                        onTaskFiltersChange: props.onTaskFiltersChange,
                        onSelectPanel: props.onSelectPanel,
                        onNavigate: props.onNavigate,
                      })}
                    `
                  : nothing
              }
            `
        }
      </section>
    </div>
  `;
}

function renderAgentTabs(
  active: AgentsPanel,
  onSelect: (panel: AgentsPanel) => void,
  counts: Record<string, number | null>,
) {
  const tabs: Array<{ id: AgentsPanel; label: string }> = [
    { id: "overview", label: "Setup" },
    { id: "providers", label: "Providers" },
    { id: "channels", label: "Channels" },
    { id: "services", label: "Services" },
    { id: "cron", label: "Tasks" },
    { id: "sessions", label: "Sessions" },
    { id: "memory", label: "Memory" },
    { id: "files", label: "Files" },
    { id: "tools", label: "Tools" },
    { id: "skills", label: "Skills" },
  ];
  return html`
    <div class="agent-tabs">
      ${tabs.map((tab) => {
        const isActive = active === tab.id || (tab.id === "cron" && active === "coordination");
        return html`
          <button
            class="agent-tab ${isActive ? "active" : ""}"
            type="button"
            @click=${() => onSelect(tab.id)}
          >
            ${tab.label}${
              counts[tab.id] != null
                ? html`<span class="agent-tab-count">(${counts[tab.id]})</span>`
                : nothing
            }
          </button>
        `;
      })}
    </div>
  `;
}

function renderAgentTaskSubtabs(
  active: "cron" | "coordination",
  onSelect: (panel: AgentsPanel) => void,
  taskCount: number | null,
) {
  const count = taskCount == null ? null : taskCount;
  return html`
    <div class="agent-task-subtabs" aria-label="Task sections">
      <button
        class="agent-task-subtab ${active === "cron" ? "active" : ""}"
        type="button"
        @click=${() => onSelect("cron")}
      >
        Tasks${count != null ? html`<span class="agent-task-subtab-count">(${count})</span>` : nothing}
      </button>
      <button
        class="agent-task-subtab ${active === "coordination" ? "active" : ""}"
        type="button"
        @click=${() => onSelect("coordination")}
      >
        Coordination
      </button>
    </div>
  `;
}
