import type { EventLogEntry } from "./app-events.ts";
import type { CompactionStatus, FallbackStatus } from "./app-tool-stream.ts";
import type { ChatModelOverride } from "./chat-model-ref.ts";
import type { CommandsCatalogScope } from "./controllers/commands.ts";
import type { ChatScheduleDraft } from "./controllers/cron.ts";
import type { DevicePairingList } from "./controllers/devices.ts";
import type { DreamingStatus } from "./controllers/dreaming.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./controllers/exec-approvals.ts";
import type { PluginsMarketplaceRemediationState } from "./controllers/plugins-marketplace.ts";
import type {
  ClawHubMarketplaceReview,
  ClawHubInstallTargetValue,
  ClawHubSearchResult,
  ClawHubSkillDetail,
  SkillMessage,
} from "./controllers/skills.ts";
import type {
  WalletSkillGrantDraft,
  WalletSkillGrantRow,
} from "./controllers/wallet-skill-grants.ts";
import type {
  FederationDirectoryEntry,
  FederationStatus,
  FederationToken,
} from "./federation-api.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import type {
  AppNotification,
  NotificationCategory,
  NotificationCode,
  NotificationLevel,
} from "./notifications.ts";
import type { UiSettings } from "./storage.ts";
import type { ThemeTransitionContext } from "./theme-transition.ts";
import type { ThemeMode } from "./theme.ts";
import type {
  AgentsListResult,
  AgentsFilesListResult,
  AgentIdentityResult,
  ChannelsStatusSnapshot,
  CommandsListResult,
  DiagnosticStabilitySnapshot,
  DoctorMemoryInventoryPayload,
  DoctorMemoryRepairPreviewPayload,
  DoctorMemoryValidationPayload,
  ConfigSnapshot,
  ConfigUiHints,
  CronJob,
  CronDeliveryStatus,
  CronJobsEnabledFilter,
  CronJobsSortBy,
  CronRunLogEntry,
  CronRunScope,
  CronRunsStatusFilter,
  CronRunsStatusValue,
  CronSortDir,
  CronStatus,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  MemoryWikiStatus,
  ModelCatalogEntry,
  ModelsCatalogStatusResult,
  NostrProfile,
  PluginsMarketplaceInfoResult,
  PluginsMarketplaceListResult,
  PluginMarketplaceMutationAction,
  ExtensionsHooksStatusResult,
  PresenceEntry,
  SessionsUsageEntry,
  SessionsUsageResult,
  SavedTaskWorkflowDefinition,
  SavedTaskWorkflowDefinitionsResult,
  CostUsageSummary,
  SessionUsageTimeSeries,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
  StandingOrderDraft,
  StandingOrderRecord,
  StandingOrdersResult,
  TaskFlowListResult,
  TaskFlowRecord,
  TaskListResult,
  TaskRecord,
  TaskWorkflowDraft,
  TaskWorkflowGraphDraft,
  TaskWorkflowGraphEdge,
  TaskWorkflowGraphEdgeEvent,
  TaskWorkflowGraphNode,
  TaskWorkflowGraphNodeType,
  TaskWorkflowTemplate,
  TaskWorkflowTemplatesResult,
  ToolsCatalogResult,
  WebhookTrigger,
  WebhookTriggersResult,
} from "./types.ts";
import type { ChatAttachment, ChatQueueItem, CronFormState } from "./ui-types.ts";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form.ts";
import type { SessionLogEntry } from "./views/usage.ts";
import type {
  WalletApprovalFilter,
  WalletAuditEntry,
  WalletBalancesResponse,
  WalletNamedWallet,
  WalletProviderInfo,
  WalletSendCreateInput,
  WalletSendApprovalRequest,
  WalletSettingsPatch,
  WalletSettings,
  WalletSolanaTokenSearchResult,
  WalletSettingsValidateResponse,
  WalletStatus,
} from "./wallet-api.ts";

export type AppViewState = {
  requestUpdate: () => void;
  settings: UiSettings;
  password: string;
  loginShowGatewayToken: boolean;
  loginShowGatewayPassword: boolean;
  tab: Tab;
  onboarding: boolean;
  basePath: string;
  connected: boolean;
  theme: ThemeMode;
  themeResolved: "light" | "dark";
  hello: GatewayHelloOk | null;
  lastError: string | null;
  eventLog: EventLogEntry[];
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  sessionKey: string;
  sessionsSubscriptionActive?: boolean;
  sessionsLastEventAt?: number | null;
  sessionMessagesSubscriptionActive?: boolean;
  subscribedSessionMessageKey: string | null;
  sessionMessageLastEventAt?: number | null;
  chatLoading: boolean;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string | null;
  chatStreamSegments: Array<{ text: string; ts: number }>;
  chatStreamStartedAt: number | null;
  chatRunId: string | null;
  compactionStatus: CompactionStatus | null;
  fallbackStatus?: FallbackStatus | null;
  chatAvatarUrl: string | null;
  chatThinkingLevel: string | null;
  chatQueue: ChatQueueItem[];
  chatManualRefreshInFlight: boolean;
  chatModelsLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
  providerModelCatalog?: ModelCatalogEntry[];
  chatModelOverrides: Record<string, ChatModelOverride | null>;
  chatModelPatchPending: Promise<void> | null;
  chatModelPatchInFlight: boolean;
  chatModelPatchSessionKey: string | null;
  chatModelPatchLabel: string | null;
  chatSessionSearch: string;
  chatSessionSearchOpen: boolean;
  chatSessionListLimit: number;
  chatTranscriptSearch: string;
  chatTranscriptSearchIndex: number;
  chatScheduleDraft: ChatScheduleDraft;
  chatSessionUsage: SessionsUsageEntry | null;
  chatSessionUsageLoading: boolean;
  chatSessionUsageError: string | null;
  nodesLoading: boolean;
  nodes: Array<Record<string, unknown>>;
  commandsCatalogLoading: boolean;
  commandsCatalogError: string | null;
  commandsCatalog: CommandsListResult | null;
  commandsCatalogScope: CommandsCatalogScope;
  chatNewMessagesBelow: boolean;
  sidebarOpen: boolean;
  sidebarContent: string | null;
  sidebarError: string | null;
  splitRatio: number;
  sendModalVisible: boolean; // New: control the integrated send modal
  scrollToBottom: (opts?: { smooth?: boolean }) => void;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  execApprovalsTarget: "gateway" | "node";
  execApprovalsTargetNodeId: string | null;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalBusy: boolean;
  execApprovalError: string | null;
  pendingGatewayUrl: string | null;
  pendingGatewayToken?: string | null;
  loginGrantInput: string;
  loginGrantPending: boolean;
  loginGrantError: string | null;
  loginTokenPending: boolean;
  loginTokenError: string | null;
  loginTokenCandidate: string;
  authBootstrapPending: boolean;
  authNotice: string | null;
  authSessionExpiresAt: string | null;
  authSessionIdleTimeoutSeconds: number | null;
  overviewAdvancedUnlocked: boolean;
  overviewSecretsRevealUntilMs: number;
  dashboardLayout: import("./dashboard-layout.ts").DashboardLayout;
  dashboardWidgetDrawerOpen: boolean;
  configLoading: boolean;
  configRaw: string;
  configRawOriginal: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  applySessionKey: string;
  configSnapshot: ConfigSnapshot | null;
  configAuthStatus: import("./types.ts").ModelsAuthStatusResult | null;
  configModelCatalogStatus: import("./types.ts").ModelsCatalogStatusResult | null;
  configAuthActionBusyProfileId: string | null;
  configAuthAction: import("./controllers/config.ts").ConfigAuthActionState | null;
  configAuthPromptResolver?: import("./controllers/config.ts").ConfigAuthPromptResolver | null;
  configAuthActionRunId?: number;
  configSchema: unknown;
  configSchemaVersion: string | null;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  configFormMode: "form" | "raw";
  configSearchQuery: string;
  configActiveSection: string | null;
  configActiveSubsection: string | null;
  channelsLoading: boolean;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  channelsNotice: string | null;
  channelsLastSuccess: number | null;
  channelsView: import("./views/channels.types.ts").ChannelsView;
  channelRuntimeBusy: Record<string, boolean>;
  channelConfirmAction: import("./app-channels.ts").ChannelConfirmAction | null;
  channelQrLogin: import("./controllers/channels.types.ts").ChannelsState["channelQrLogin"];
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
  nostrProfileFormState: NostrProfileFormState | null;
  nostrProfileAccountId: string | null;
  configFormDirty: boolean;
  servicesWebSearchTesting: boolean;
  servicesWebSearchTestMessage: string | null;
  servicesCapabilities: import("./types.ts").CapabilityReadinessReport | null;
  servicesCapabilitiesLoading: boolean;
  servicesComponentBusy: Record<string, boolean>;
  servicesComponentMessage: string | null;
  servicesWebSearchProviders: import("./types.ts").WebSearchServiceProviderOption[];
  servicesWebSearchProvidersLoading: boolean;
  servicesGmailProvisioning: boolean;
  servicesGmailProvisionMessage: string | null;
  presenceLoading: boolean;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: string | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  agentsSelectedId: string | null;
  agentsCreateBusy: boolean;
  agentsCreateMessage: string | null;
  agentsPanel:
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
  toolsCatalogLoading: boolean;
  toolsCatalogError: string | null;
  toolsCatalogResult: ToolsCatalogResult | null;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFilesList: AgentsFilesListResult | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileActive: string | null;
  agentFileSaving: boolean;
  agentIdentityLoading: boolean;
  agentIdentityError: string | null;
  agentIdentityById: Record<string, AgentIdentityResult>;
  agentSkillsLoading: boolean;
  agentSkillsError: string | null;
  agentSkillsReport: SkillStatusReport | null;
  agentSkillsAgentId: string | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveError: string | null;
  toolsEffectiveResult: import("./types.ts").ToolsEffectiveResult | null;
  toolsEffectiveResultKey: string | null;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsHideCron?: boolean;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsFilterSearch: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  usageLoading: boolean;
  usageResult: SessionsUsageResult | null;
  usageCostSummary: CostUsageSummary | null;
  usageError: string | null;
  usageStartDate: string;
  usageEndDate: string;
  usageSelectedSessions: string[];
  usageSelectedDays: string[];
  usageSelectedHours: number[];
  usageChartMode: "tokens" | "cost";
  usageDailyChartMode: "total" | "by-type";
  usageTimeSeriesMode: "cumulative" | "per-turn";
  usageTimeSeriesBreakdownMode: "total" | "by-type";
  usageTimeSeries: SessionUsageTimeSeries | null;
  usageTimeSeriesLoading: boolean;
  usageTimeSeriesCursorStart: number | null;
  usageTimeSeriesCursorEnd: number | null;
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsLoading: boolean;
  usageSessionLogsExpanded: boolean;
  usageQuery: string;
  usageQueryDraft: string;
  usageQueryDebounceTimer: number | null;
  usageSessionSort: "tokens" | "cost" | "recent" | "messages" | "errors";
  usageSessionSortDir: "asc" | "desc";
  usageRecentSessions: string[];
  usageTimeZone: "local" | "utc";
  usageContextExpanded: boolean;
  usageHeaderPinned: boolean;
  usageSessionsTab: "all" | "recent";
  usageVisibleColumns: string[];
  usageLogFilterRoles: import("./views/usage.js").SessionLogRole[];
  usageLogFilterTools: string[];
  usageLogFilterHasTools: boolean;
  usageLogFilterQuery: string;
  cronLoading: boolean;
  cronJobsLoadingMore: boolean;
  cronJobs: CronJob[];
  cronJobsTotal: number;
  cronJobsHasMore: boolean;
  cronJobsNextOffset: number | null;
  cronJobsLimit: number;
  cronJobsQuery: string;
  cronJobsEnabledFilter: CronJobsEnabledFilter;
  cronJobsScheduleKindFilter: import("./controllers/cron.js").CronJobsScheduleKindFilter;
  cronJobsLastStatusFilter: import("./controllers/cron.js").CronJobsLastStatusFilter;
  cronJobsAdaptiveRouteFilter: import("./controllers/cron.js").CronJobsAdaptiveRouteFilter;
  cronJobsSortBy: CronJobsSortBy;
  cronJobsSortDir: CronSortDir;
  cronStatus: CronStatus | null;
  cronError: string | null;
  cronForm: CronFormState;
  cronFieldErrors: import("./controllers/cron.js").CronFieldErrors;
  agentTaskDialogOpen: boolean;
  agentTaskForm: CronFormState;
  agentTaskFieldErrors: import("./controllers/cron.js").CronFieldErrors;
  agentTaskEditingJobId: string | null;
  agentTaskError: string | null;
  agentTaskBusy: boolean;
  agentTaskQuery: string;
  agentTaskStatusFilter: "all" | "enabled" | "disabled" | "needs-access";
  agentTaskAdaptiveRouteFilter: import("./controllers/cron.js").CronJobsAdaptiveRouteFilter;
  agentTaskSortDir: "desc" | "asc";
  taskLedgerLoading: boolean;
  taskLedgerBusy: boolean;
  taskLedgerError: string | null;
  taskLedgerMaintenanceMessage: string | null;
  taskLedger: TaskListResult | null;
  taskLedgerOffset: number;
  taskLedgerSourceFilter: import("./types.js").TaskSource | "all";
  taskLedgerTypeFilter: "all" | "task" | "trigger" | "workflow" | "graph" | "program" | "history";
  taskLedgerStatusFilter: "all" | "active" | "terminal" | TaskRecord["status"];
  taskLedgerDetails: Record<string, TaskRecord>;
  taskLedgerDetailLoading: Record<string, boolean>;
  taskLedgerDetailErrors: Record<string, string>;
  taskWorkflowDraft: TaskWorkflowDraft | null;
  taskWorkflowGraphDraft: TaskWorkflowGraphDraft | null;
  taskWorkflowBusy: boolean;
  taskWorkflowError: string | null;
  taskWorkflowMessage: string | null;
  taskWorkflowDefinitionsLoading: boolean;
  taskWorkflowDefinitionsBusy: boolean;
  taskWorkflowDefinitionsError: string | null;
  taskWorkflowDefinitions: SavedTaskWorkflowDefinitionsResult | null;
  taskWorkflowTemplatesLoading: boolean;
  taskWorkflowTemplatesError: string | null;
  taskWorkflowTemplates: TaskWorkflowTemplatesResult | null;
  taskStandingOrdersLoading: boolean;
  taskStandingOrdersBusy: boolean;
  taskStandingOrdersError: string | null;
  taskStandingOrdersMessage: string | null;
  taskStandingOrders: StandingOrdersResult | null;
  taskStandingOrderDraft: StandingOrderDraft | null;
  taskFlowRunsLoading: boolean;
  taskFlowRunsBusy: boolean;
  taskFlowRunsError: string | null;
  taskFlowRuns: TaskFlowListResult | null;
  webhookTriggersLoading: boolean;
  webhookTriggersBusy: boolean;
  webhookTriggersError: string | null;
  webhookTriggersMessage: string | null;
  webhookTriggers: WebhookTriggersResult | null;
  webhookTriggerDraft: import("./controllers/webhook-triggers.ts").WebhookTriggerDraft | null;
  cronEditingJobId: string | null;
  cronRunsJobId: string | null;
  cronRunsLoadingMore: boolean;
  cronRuns: CronRunLogEntry[];
  cronRunsTotal: number;
  cronRunsHasMore: boolean;
  cronRunsNextOffset: number | null;
  cronRunsLimit: number;
  cronRunsScope: CronRunScope;
  cronRunsStatuses: CronRunsStatusValue[];
  cronRunsDeliveryStatuses: CronDeliveryStatus[];
  cronRunsStatusFilter: CronRunsStatusFilter;
  cronRunsQuery: string;
  cronRunsSortDir: CronSortDir;
  cronRunDetail: import("./types.js").CronTaskRunDetail | null;
  cronRunDetailLoading: boolean;
  cronRunDetailError: string | null;
  cronBusy: boolean;
  federationLoading: boolean;
  federationError: string | null;
  federationMessage: string | null;
  federationDirectory: FederationDirectoryEntry[];
  federationHandle: string;
  federationNodeEndpoint: string;
  federationToken: FederationToken | null;
  federationStatus: FederationStatus | null;
  federationManagedMode: boolean;
  walletLoading: boolean;
  walletError: string | null;
  walletStatus: WalletStatus | null;
  walletProvidersLoading: boolean;
  walletProviders: WalletProviderInfo[];
  walletNamedWallets: WalletNamedWallet[];
  walletAssignments: Record<string, string>;
  walletDefaultWalletId: string | null;
  walletProviderSelection: WalletProviderInfo["id"];
  walletProviderTab: WalletProviderInfo["id"];
  walletMainPanel: "wallets" | "access" | "skill-grants";
  walletDetailsWalletId: string;
  walletBalanceWalletId: string;
  walletExpandedPanelWalletId: string;
  walletExpandedPanel: "balance" | "security" | "";
  walletPolicyPanel: "caps" | "schedule" | "automation" | "skills" | "sweep";
  walletCreateName: string;
  walletCreateId: string;
  walletCreateProvider: WalletProviderInfo["id"];
  walletCreateRpcUrl: string;
  walletCreateRpcProfileId: string;
  walletCreateBusy: boolean;
  walletAssignAgentId: string;
  walletAssignWalletId: string;
  walletSettingsLoading: boolean;
  walletSettingsBusy: boolean;
  walletSettingsError: string | null;
  walletSettingsMessage: string | null;
  walletSettings: WalletSettings | null;
  walletSettingsValidation: WalletSettingsValidateResponse | null;
  walletSkillGrantsLoading: boolean;
  walletSkillGrantsError: string | null;
  walletSkillGrantsMessage: string | null;
  walletSkillGrantsWorkspace: string | null;
  walletSkillGrantRows: WalletSkillGrantRow[];
  walletSkillGrantDraft: WalletSkillGrantDraft;
  walletSkillGrantBusy: boolean;
  walletRpcChain: "solana" | "multi";
  walletPolicyCapsEnabled: boolean;
  walletPolicyAutoEnabled: boolean;
  walletPolicySkillsEnabled: boolean;
  walletPolicySolMaxPerTx: string;
  walletPolicySolMaxDaily: string;
  walletPolicySolanaAllowPrograms: string;
  walletPolicySolanaTokenCaps: Record<
    string,
    { maxPerTx?: string; maxDaily?: string; decimals: number }
  >;
  walletPolicyTokenCapMint: string;
  walletPolicyTokenCapDecimals: string;
  walletPolicyTokenCapMaxPerTx: string;
  walletPolicyTokenCapMaxDaily: string;
  walletPolicyTokenSearchQuery: string;
  walletPolicyTokenSearchLoading: boolean;
  walletPolicyTokenSearchError: string | null;
  walletPolicyTokenSearchResults: WalletSolanaTokenSearchResult[];
  walletRecurringTransferEnabled: boolean;
  walletRecurringTransferDestination: string;
  walletRecurringTransferMint: string;
  walletRecurringTransferAmountMode: "fixed" | "percentage";
  walletRecurringTransferAmount: string;
  walletRecurringTransferPercentage: string;
  walletRecurringTransferMinAmount: string;
  walletRecurringTransferKeepAmount: string;
  walletRecurringTransferDecimals: string;
  walletRecurringTransferCron: string;
  walletRecurringTransferTz: string;
  walletRecurringTransferName: string;
  walletSecuritySetupWalletId: string;
  walletSecuritySetupRole: "agent" | null;
  walletRpcProvider: string;
  walletRpcApiKey: string;
  walletRpcUrl: string;
  walletRpcEditorWalletId: string;
  walletRevealedAddressWalletId: string;
  walletProviderApiKey: string;
  walletProviderServerSignerAccessKey: string;
  walletProviderServerSignerAccountId: string;
  walletProviderWalletApiBaseUrl: string;
  walletProviderSignerApiBaseUrl: string;
  walletProviderDefaultSolanaAddress: string;
  walletProviderCredentialsJson: string;
  walletActionBusy: boolean;
  walletActionMessage: string | null;
  walletApprovalsLoading: boolean;
  walletApprovalsBusyId: string | null;
  walletApprovalsError: string | null;
  walletApprovalsFilter: WalletApprovalFilter;
  walletApprovals: WalletSendApprovalRequest[];
  walletAuditLoading: boolean;
  walletAuditError: string | null;
  walletAuditEntries: WalletAuditEntry[];
  walletActivityPage: number;
  walletResetConfirmText: string;
  walletSendCreateBusy: boolean;
  walletSendCreateError: string | null;
  walletSendCreateForm: WalletSendCreateInput;
  walletPasskeyBusy: boolean;
  walletPasskeyError: string | null;
  walletPasskeyLabel: string;
  walletBalancesLoading: boolean;
  walletBalancesError: string | null;
  walletBalances: WalletBalancesResponse | null;
  notifications?: AppNotification[];
  skillsLoading: boolean;
  skillsReport: SkillStatusReport | null;
  skillsError: string | null;
  skillsFilter: string;
  skillsStatusFilter: "all" | "ready" | "needs-setup" | "disabled";
  skillsLibraryPanel: import("./views/skills.ts").SkillsLibraryPanel;
  skillEdits: Record<string, string>;
  skillMessages: Record<string, SkillMessage>;
  skillEnvEdits: Record<string, Record<string, string>>;
  skillConfigEdits: Record<string, string>;
  skillCreateOpen: boolean;
  skillCreateName: string;
  skillCreateDescription: string;
  skillCreateAgentId: string;
  skillCreateTemplate: import("./controllers/skills.ts").SkillCreateTemplate;
  skillCreateBusy: boolean;
  skillCreateError: string | null;
  skillsBusyKey: string | null;
  skillEditor: import("./controllers/skills.ts").SkillEditorState | null;
  skillEditorDraft: string;
  skillEditorLoading: boolean;
  skillEditorSaving: boolean;
  skillEditorError: string | null;
  skillsDetailKey: string | null;
  skillsAttachAgentId: string;
  clawhubSearchQuery: string;
  clawhubSearchResults: ClawHubSearchResult[] | null;
  clawhubSearchLoading: boolean;
  clawhubSearchError: string | null;
  clawhubDetail: ClawHubSkillDetail | null;
  clawhubDetailSlug: string | null;
  clawhubDetailLoading: boolean;
  clawhubDetailError: string | null;
  clawhubInstallSlug: string | null;
  clawhubInstallMessage: { kind: "success" | "error"; text: string } | null;
  clawhubReview: ClawHubMarketplaceReview | null;
  clawhubReviewLoading: boolean;
  clawhubReviewError: string | null;
  clawhubInstallTarget: ClawHubInstallTargetValue;
  pluginsMarketplaceLoading: boolean;
  pluginsMarketplaceDetailLoading: boolean;
  pluginsMarketplaceError: string | null;
  pluginsMarketplaceList: PluginsMarketplaceListResult | null;
  pluginsMarketplaceSelectedId: string | null;
  pluginsMarketplaceDetail: PluginsMarketplaceInfoResult | null;
  pluginsMarketplaceActionBusy: PluginMarketplaceMutationAction | null;
  pluginsMarketplaceMessage: string | null;
  pluginsMarketplaceRemediation: PluginsMarketplaceRemediationState | null;
  extensionsHooksLoading: boolean;
  extensionsHooksError: string | null;
  extensionsHooksStatus: ExtensionsHooksStatusResult | null;
  extensionsHooksBusyKey: string | null;
  extensionsHooksMessage: string | null;
  memoryLoading: boolean;
  memoryError: string | null;
  memoryInventory: DoctorMemoryInventoryPayload | null;
  memoryValidation: DoctorMemoryValidationPayload | null;
  memoryWiki: MemoryWikiStatus | null;
  memoryWikiRebuilding: boolean;
  memoryWikiError: string | null;
  dreamingStatusLoading: boolean;
  dreamingStatusError: string | null;
  dreamingStatus: DreamingStatus | null;
  dreamingModeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
  debugLoading: boolean;
  debugStatus: StatusSummary | null;
  debugHealth: HealthSnapshot | null;
  debugModels: unknown[];
  debugModelCatalogStatus: ModelsCatalogStatusResult | null;
  debugCommandsCatalog: CommandsListResult | null;
  debugPluginsMarketplace: PluginsMarketplaceListResult | null;
  debugDiagnosticsStability: DiagnosticStabilitySnapshot | null;
  debugMemoryInventory: DoctorMemoryInventoryPayload | null;
  debugMemoryValidation: DoctorMemoryValidationPayload | null;
  debugMemoryRepairPreview: DoctorMemoryRepairPreviewPayload | null;
  debugHeartbeat: unknown;
  debugCallMethod: string;
  debugCallParams: string;
  debugCallResult: string | null;
  debugCallError: string | null;
  debugAdminRpcBusy: string | null;
  debugAdminRpcResult: string | null;
  debugAdminRpcError: string | null;
  debugAdminChatSessionKey: string;
  debugAdminChatMessage: string;
  debugAdminPushNodeId: string;
  debugAdminPushTitle: string;
  debugAdminPushBody: string;
  debugAdminWebAccountId: string;
  debugAcpxBridgeConfigBusy: import("./controllers/debug.ts").DebugAcpxBridgeConfigAction | null;
  debugAcpxBridgeConfigResult: string | null;
  debugAcpxBridgeConfigError: string | null;
  debugAcpxPushTestBusy: import("./controllers/debug.ts").DebugAcpxPushTestAction | null;
  debugAcpxPushTestPreview: import("./controllers/debug.ts").DebugAcpxPushTestPreviewPayload | null;
  debugAcpxPushTestAuditHistory:
    | import("./controllers/debug.ts").DebugAcpxPushTestAuditHistoryPayload
    | null;
  debugAcpxPushTestResult: string | null;
  debugAcpxPushTestError: string | null;
  logsLoading: boolean;
  logsError: string | null;
  logsFile: string | null;
  logsEntries: LogEntry[];
  logsFilterText: string;
  logsLevelFilters: Record<LogLevel, boolean>;
  logsAutoFollow: boolean;
  logsTruncated: boolean;
  logsCursor: number | null;
  logsLastFetchAt: number | null;
  logsLimit: number;
  logsMaxBytes: number;
  logsAtBottom: boolean;
  client: GatewayBrowserClient | null;
  refreshSessionsAfterChat: Set<string>;
  connect: () => void;
  setTab: (tab: Tab) => void;
  setTheme: (theme: ThemeMode, context?: ThemeTransitionContext) => void;
  loadTaskLedger: (opts?: { quiet?: boolean }) => Promise<void>;
  loadTaskLedgerDetail: (taskId: string, opts?: { force?: boolean }) => Promise<void>;
  setTaskLedgerSourceFilter: (source: import("./types.js").TaskSource | "all") => void;
  setTaskLedgerTypeFilter: (
    type: "all" | "task" | "trigger" | "workflow" | "graph" | "program" | "history",
  ) => void;
  setTaskLedgerStatusFilter: (status: "all" | "active" | "terminal" | TaskRecord["status"]) => void;
  setTaskLedgerPageOffset: (offset: number) => void;
  loadTaskWorkflowDefinitions: (opts?: { quiet?: boolean }) => Promise<void>;
  loadTaskWorkflowTemplates: (opts?: { quiet?: boolean }) => Promise<void>;
  loadTaskStandingOrders: (opts?: { quiet?: boolean }) => Promise<void>;
  startTaskStandingOrderCreate: (agentId: string) => void;
  editTaskStandingOrder: (order: StandingOrderRecord) => void;
  patchTaskStandingOrderDraft: (patch: Partial<StandingOrderDraft>) => void;
  saveTaskStandingOrderDraft: (agentId: string) => Promise<void>;
  removeTaskStandingOrder: (order: StandingOrderRecord) => Promise<void>;
  proposeTaskStandingOrder: (order: StandingOrderRecord) => Promise<void>;
  cancelTaskStandingOrderDraft: () => void;
  loadTaskFlowRuns: (opts?: { quiet?: boolean }) => Promise<void>;
  controlTaskLedger: (
    action: "approve" | "reject" | "cancel" | "retry" | "notify",
    taskId: string,
  ) => Promise<void>;
  runTaskLedgerMaintenance: (opts?: {
    cleanupOrphanedCronRuns?: boolean;
    staleRunningMs?: number;
  }) => Promise<void>;
  startTaskWorkflowCreate: (agentId: string) => void;
  startTaskWorkflowGraphCreate: (agentId: string) => void;
  startTaskWorkflowFromTemplate: (agentId: string, template: TaskWorkflowTemplate) => void;
  startTaskWorkflowFromLedgerTask: (agentId: string, task: TaskRecord) => void;
  editTaskWorkflowDefinition: (definition: SavedTaskWorkflowDefinition) => void;
  editTaskWorkflowGraphDefinition: (definition: SavedTaskWorkflowDefinition) => void;
  openTaskWorkflowRunGraph: (flow: TaskFlowRecord) => void;
  patchTaskWorkflowDraft: (patch: Partial<TaskWorkflowDraft>) => void;
  patchTaskWorkflowGraphDraft: (patch: Partial<TaskWorkflowGraphDraft>) => void;
  addTaskWorkflowGraphNode: (type: TaskWorkflowGraphNodeType) => void;
  updateTaskWorkflowGraphNode: (nodeId: string, patch: Partial<TaskWorkflowGraphNode>) => void;
  removeTaskWorkflowGraphNode: (nodeId: string) => void;
  moveTaskWorkflowGraphNode: (nodeId: string, x: number, y: number) => void;
  addTaskWorkflowGraphEdge: (from: string, to: string, on?: TaskWorkflowGraphEdgeEvent) => void;
  updateTaskWorkflowGraphEdge: (edgeId: string, patch: Partial<TaskWorkflowGraphEdge>) => void;
  removeTaskWorkflowGraphEdge: (edgeId: string) => void;
  autoLayoutTaskWorkflowGraph: () => void;
  importTaskWorkflowGraphJson: () => void;
  exportTaskWorkflowGraphJson: () => void;
  previewTaskWorkflow: (agentId: string) => Promise<void>;
  previewTaskWorkflowGraphDraft: (agentId: string) => Promise<void>;
  saveTaskWorkflowDefinitionDraft: (agentId: string) => Promise<void>;
  saveTaskWorkflowGraphDefinitionDraft: (agentId: string) => Promise<void>;
  runTaskWorkflowDefinition: (definition: SavedTaskWorkflowDefinition) => Promise<void>;
  removeTaskWorkflowDefinition: (definition: SavedTaskWorkflowDefinition) => Promise<void>;
  cancelTaskFlowRun: (flow: TaskFlowRecord) => Promise<void>;
  runTaskWorkflow: (agentId: string) => Promise<void>;
  runTaskWorkflowGraphDraft: (agentId: string) => Promise<void>;
  cancelTaskWorkflowDraft: () => void;
  startWebhookTriggerCreate: (agentId: string) => void;
  editWebhookTrigger: (trigger: WebhookTrigger) => void;
  patchWebhookTriggerDraft: (
    patch: Partial<import("./controllers/webhook-triggers.ts").WebhookTriggerDraft>,
  ) => void;
  saveWebhookTriggerDraft: () => Promise<void>;
  cancelWebhookTriggerEdit: () => void;
  removeWebhookTrigger: (trigger: WebhookTrigger) => Promise<void>;
  toggleWebhookTrigger: (trigger: WebhookTrigger, enabled: boolean) => Promise<void>;
  testWebhookTrigger: (trigger: WebhookTrigger) => Promise<void>;
  applySettings: (next: UiSettings) => void;
  loadOverview: () => Promise<void>;
  loadAssistantIdentity: () => Promise<void>;
  loadCron: (opts?: { quiet?: boolean }) => Promise<void>;
  handleWhatsAppStart: (force: boolean) => Promise<void>;
  handleWhatsAppWait: () => Promise<void>;
  handleWhatsAppLogout: () => Promise<void>;
  handleChannelQrStart: (channelId: string, force?: boolean, accountId?: string) => Promise<void>;
  handleChannelQrWait: (channelId: string, accountId?: string) => Promise<void>;
  handleChannelEnable: (channelId: string) => Promise<void>;
  handleChannelLogout: (channelId: string, accountId?: string) => Promise<void>;
  handleChannelInstall: (channelId: string) => Promise<void>;
  cancelChannelConfirmAction: () => void;
  confirmChannelAction: () => Promise<void>;
  handleChannelConfigSave: () => Promise<void>;
  handleChannelConfigReload: () => Promise<void>;
  handleNostrProfileEdit: (accountId: string, profile: NostrProfile | null) => void;
  handleNostrProfileCancel: () => void;
  handleNostrProfileFieldChange: (field: keyof NostrProfile, value: string) => void;
  handleNostrProfileSave: () => Promise<void>;
  handleNostrProfileImport: () => Promise<void>;
  handleNostrProfileToggleAdvanced: () => void;
  handleExecApprovalDecision: (decision: "allow-once" | "allow-always" | "deny") => Promise<void>;
  handleGatewayUrlConfirm: () => void;
  handleGatewayUrlCancel: () => void;
  exchangeLoginGrant: (grant?: string) => Promise<void>;
  signInWithGatewayToken: () => Promise<void>;
  signOut: () => Promise<void>;
  unlockOverviewAdvanced: () => void;
  lockOverviewAdvanced: () => void;
  revealOverviewSecrets: (ms?: number) => void;
  setDashboardLayout: (next: import("./dashboard-layout.ts").DashboardLayout) => void;
  setDashboardWidgetDrawerOpen: (next: boolean) => void;
  handleConfigLoad: () => Promise<void>;
  handleConfigSave: () => Promise<void>;
  handleConfigApply: () => Promise<void>;
  handleConfigFormUpdate: (path: string, value: unknown) => void;
  handleConfigFormModeChange: (mode: "form" | "raw") => void;
  handleConfigRawChange: (raw: string) => void;
  handleInstallSkill: (key: string) => Promise<void>;
  handleUpdateSkill: (key: string) => Promise<void>;
  handleToggleSkillEnabled: (key: string, enabled: boolean) => Promise<void>;
  handleUpdateSkillEdit: (key: string, value: string) => void;
  handleSaveSkillApiKey: (key: string, apiKey: string) => Promise<void>;
  handleCronToggle: (jobId: string, enabled: boolean) => Promise<void>;
  handleCronRun: (jobId: string) => Promise<void>;
  handleCronRemove: (jobId: string) => Promise<void>;
  handleCronAdd: () => Promise<void>;
  handleCronRunsLoad: (jobId: string) => Promise<void>;
  handleCronFormUpdate: (path: string, value: unknown) => void;
  handleFederationLoad: () => Promise<void>;
  handleFederationRegister: () => Promise<void>;
  handleFederationAttest: () => Promise<void>;
  handleFederationRenew: () => Promise<void>;
  handleFederationRevoke: () => Promise<void>;
  handleWalletLoad: () => Promise<void>;
  handleWalletMainPanelChange: (panel: "wallets" | "access" | "skill-grants") => void;
  handleWalletRefreshSignerDoctor: () => Promise<void>;
  handleWalletRotateKeys: () => Promise<void>;
  handleWalletResetKeys: () => Promise<void>;
  handleWalletSetApprovalsFilter: (filter: WalletApprovalFilter) => Promise<void>;
  handleWalletAttachStandard: () => Promise<void>;
  handleWalletApproveRequest: (requestId: string) => Promise<void>;
  handleWalletRejectRequest: (requestId: string) => Promise<void>;
  handleWalletSendCreatePatch: (patch: Partial<WalletSendCreateInput>) => void;
  handleWalletOpenSendModal: (walletId: string, assetId?: string) => void;
  handleWalletCloseSendModal: () => void;
  handleWalletCreateSendRequest: () => Promise<void>;
  handleWalletSelectDetailsWallet: (walletId: string) => Promise<void>;
  handleWalletEnablePasskeyApproval: () => Promise<void>;
  handleWalletDeletePasskey: (credentialId: string) => Promise<void>;
  handleWalletPrintEnrolledDeviceShare: () => void;
  handleWalletTokenSearchQueryChange: (next: string) => void;
  handleWalletTokenSearch: () => Promise<void>;
  handleWalletTokenSearchSelect: (token: WalletSolanaTokenSearchResult) => void;
  handleWalletSkillGrantSelect: (row: WalletSkillGrantRow) => void;
  handleWalletSkillGrantDraftPatch: (patch: Partial<WalletSkillGrantDraft>) => void;
  handleWalletSkillGrantActionToggle: (action: string, enabled: boolean) => void;
  handleWalletSkillGrantSave: () => Promise<void>;
  handleWalletSkillGrantClear: (skillId: string) => Promise<void>;
  enqueueAppNotification: (input: {
    code: NotificationCode;
    category: NotificationCategory;
    level: NotificationLevel;
    title: string;
    message: string;
    cooldownMs?: number;
    dedupeKey?: string;
  }) => void;
  dismissAppNotification?: (id: string) => void;
  handleWalletEnrollPasskey: () => Promise<void>;
  handleWalletPatchSettings: (
    patch: WalletSettingsPatch,
    opts?: { requireExecutionApproval?: boolean },
  ) => Promise<void>;
  handleWalletPolicyDraftChange: (patch: {
    capsEnabled?: boolean;
    directSigning?: boolean;
    skillsEnabled?: boolean;
    solMaxPerTx?: string;
    solMaxDaily?: string;
    solanaAllowPrograms?: string;
    solanaTokenCaps?: Record<string, { maxPerTx?: string; maxDaily?: string; decimals: number }>;
    tokenCapMint?: string;
    tokenCapDecimals?: string;
    tokenCapMaxPerTx?: string;
    tokenCapMaxDaily?: string;
    recurringTransferEnabled?: boolean;
    recurringTransferDestination?: string;
    recurringTransferMint?: string;
    recurringTransferAmountMode?: "fixed" | "percentage";
    recurringTransferAmount?: string;
    recurringTransferPercentage?: string;
    recurringTransferMinAmount?: string;
    recurringTransferKeepAmount?: string;
    recurringTransferDecimals?: string;
    recurringTransferCron?: string;
    recurringTransferTz?: string;
    recurringTransferName?: string;
  }) => void;
  handleWalletSavePolicy: () => Promise<void>;
  handleWalletValidateSettings: () => Promise<void>;
  handleWalletSaveRpcSecret: () => Promise<void>;
  handleWalletToggleRpcEditor: (walletId: string) => void;
  handleWalletCopyRpc: (walletId: string) => Promise<void>;
  handleWalletToggleAddress: (walletId: string) => void;
  handleWalletSaveProviderCredentials: () => Promise<void>;
  handleWalletDeleteProviderCredentials: () => Promise<void>;
  handleWalletDeleteRpcSecret: () => Promise<void>;
  handleWalletSelectProvider: (providerId: WalletProviderInfo["id"]) => Promise<void>;
  handleWalletProviderTabChange: (providerId: WalletProviderInfo["id"]) => Promise<void>;
  handleWalletDetailsWalletChange: (walletId: string) => Promise<void>;
  handleWalletBalanceWalletChange: (walletId: string) => Promise<void>;
  handleWalletPolicyPanelChange: (
    panel: "caps" | "schedule" | "automation" | "skills" | "sweep",
  ) => void;
  handleWalletSetProviderEnabled: (
    providerId: WalletProviderInfo["id"],
    enabled: boolean,
  ) => Promise<void>;
  handleWalletCreateNamedWallet: () => Promise<void>;
  handleWalletDeleteNamedWallet: (walletId: string, archive?: boolean) => Promise<void>;
  handleWalletSetDefaultWallet: (walletId: string | null) => Promise<void>;
  handleWalletAssignAgentWallet: () => Promise<void>;
  handleWalletDeleteAgentAssignment: (agentId: string) => Promise<void>;
  handleWalletDownloadEnrolledDeviceShare: () => void;
  handleWalletApplyRecommendedPolicy: () => Promise<void>;
  handleOperatorReadinessOpenAdminControl: () => void;
  handleOperatorReadinessOpenTaskPayment: () => void;
  handleOperatorReadinessOpenFederationReview: () => void;
  handleSessionsLoad: () => Promise<void>;
  handleSessionsPatch: (key: string, patch: unknown) => Promise<void>;
  handleLoadNodes: () => Promise<void>;
  handleLoadPresence: () => Promise<void>;
  handleLoadSkills: () => Promise<void>;
  handleMemoryLoad: () => Promise<void>;
  handleMemoryWikiRebuild: () => Promise<void>;
  handleLoadDebug: () => Promise<void>;
  handleLoadLogs: () => Promise<void>;
  handleDebugCall: () => Promise<void>;
  handleRunUpdate: () => Promise<void>;
  setPassword: (next: string) => void;
  setSessionKey: (next: string) => void;
  setChatMessage: (next: string) => void;
  handleSendChat: (messageOverride?: string, opts?: { restoreDraft?: boolean }) => Promise<void>;
  handleAbortChat: () => Promise<void>;
  removeQueuedMessage: (id: string) => void;
  handleChatScroll: (event: Event) => void;
  resetToolStream: () => void;
  resetChatScroll: () => void;
  exportLogs: (lines: string[], label: string) => void;
  handleLogsScroll: (event: Event) => void;
  handleOpenSidebar: (content: string) => void;
  handleCloseSidebar: () => void;
  handleSplitRatioChange: (ratio: number) => void;
  setLoginTokenCandidate: (token: string) => void;
};
