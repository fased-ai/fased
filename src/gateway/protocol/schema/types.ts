import type { Static } from "@sinclair/typebox";
import type {
  AgentEventSchema,
  AgentIdentityParamsSchema,
  AgentIdentityResultSchema,
  AgentWaitParamsSchema,
  PollParamsSchema,
  WakeParamsSchema,
} from "./agent.js";
import type {
  AgentSummarySchema,
  AgentsFileEntrySchema,
  AgentsCreateParamsSchema,
  AgentsCreateResultSchema,
  AgentsDeleteParamsSchema,
  AgentsDeleteResultSchema,
  AgentsFilesGetParamsSchema,
  AgentsFilesGetResultSchema,
  AgentsFilesListParamsSchema,
  AgentsFilesListResultSchema,
  AgentsFilesSetParamsSchema,
  AgentsFilesSetResultSchema,
  AgentsListParamsSchema,
  AgentsListResultSchema,
  AgentsUpdateParamsSchema,
  AgentsUpdateResultSchema,
  ModelChoiceSchema,
  ModelsAuthClearParamsSchema,
  ModelsAuthClearResultSchema,
  ModelsAuthConfigureParamsSchema,
  ModelsAuthConfigureResultSchema,
  ModelsAuthInteractiveStartParamsSchema,
  ModelsAuthInteractiveStartResultSchema,
  ModelsAuthStatusEffectiveSchema,
  ModelsAuthStatusParamsSchema,
  ModelsAuthStatusProfileSchema,
  ModelsAuthStatusProviderSchema,
  ModelsAuthStatusResultSchema,
  ModelsAuthStoreModeSchema,
  ModelsAuthStoreParamsSchema,
  ModelsAuthStoreResultSchema,
  ModelsCatalogStatusParamsSchema,
  ModelsCatalogStatusProviderSchema,
  ModelsCatalogStatusResultSchema,
  ModelsListParamsSchema,
  ModelsListResultSchema,
  PluginMarketplaceActionSchema,
  PluginMarketplaceAdminRpcActionGrantStatusSchema,
  PluginMarketplaceAdminRpcActionMethodSchema,
  PluginMarketplaceAdminRpcActionsSchema,
  PluginMarketplaceChannelCatalogMetaSchema,
  PluginMarketplaceDiagnosticSchema,
  PluginMarketplaceEntrySchema,
  PluginMarketplaceInstallChoiceSchema,
  PluginMarketplaceInstallOptionsSchema,
  PluginMarketplaceInstallRecordSchema,
  PluginMarketplacePermissionDiffSchema,
  PluginMarketplaceRuntimeHelpersSchema,
  PluginMarketplaceMutationActionSchema,
  PluginMarketplaceMutationResultSchema,
  PluginMarketplaceSourceTrustSchema,
  PluginMarketplaceUpdatePreviewResultSchema,
  PluginMarketplaceUpdateReviewSchema,
  PluginsMarketplaceInfoParamsSchema,
  PluginsMarketplaceInfoResultSchema,
  PluginsMarketplaceAdminRpcGrantSetParamsSchema,
  PluginsMarketplaceInstallParamsSchema,
  PluginsMarketplaceListParamsSchema,
  PluginsMarketplaceListResultSchema,
  PluginsMarketplaceRestartParamsSchema,
  PluginsMarketplaceRuntimeHelperSetParamsSchema,
  PluginsMarketplaceUninstallParamsSchema,
  PluginsMarketplaceUpdatePreviewParamsSchema,
  PluginsMarketplaceUpdateParamsSchema,
  SkillsBinsParamsSchema,
  SkillsBinsResultSchema,
  SkillsCopyParamsSchema,
  SkillsCopyResultSchema,
  SkillsCreateParamsSchema,
  SkillsCreateResultSchema,
  SkillsDetailParamsSchema,
  SkillsDetailResultSchema,
  SkillsFileGetParamsSchema,
  SkillsFileGetResultSchema,
  SkillsFileSetParamsSchema,
  SkillsFileSetResultSchema,
  SkillsInstallParamsSchema,
  SkillsMarketplaceInstallPreviewParamsSchema,
  SkillsMarketplaceInstallPreviewResultSchema,
  SkillsMarketplaceInstallParamsSchema,
  SkillsMarketplaceInstallResultSchema,
  SkillsMarketplaceUpdateParamsSchema,
  SkillsMarketplaceUpdatePreviewParamsSchema,
  SkillsMarketplaceUpdatePreviewResultSchema,
  SkillsMarketplaceUpdateResultSchema,
  SkillsSearchParamsSchema,
  SkillsSearchResultSchema,
  SkillsStatusParamsSchema,
  SkillsUpdateParamsSchema,
  SkillsWalletGrantClearParamsSchema,
  SkillsWalletGrantClearResultSchema,
  SkillsWalletGrantsParamsSchema,
  SkillsWalletGrantsResultSchema,
  SkillsWalletGrantSetParamsSchema,
  SkillsWalletGrantSetResultSchema,
  ToolCatalogEntrySchema,
  ToolCatalogGroupSchema,
  ToolCatalogProfileSchema,
  ToolEffectiveEntrySchema,
  ToolEffectiveGroupSchema,
  ToolEffectiveSourceSchema,
  ToolsCatalogParamsSchema,
  ToolsCatalogResultSchema,
  ToolsEffectiveParamsSchema,
  ToolsEffectiveResultSchema,
} from "./agents-models-skills.js";
import type {
  ChannelsLogoutParamsSchema,
  ChannelsRuntimeControlParamsSchema,
  ChannelsRuntimeControlResultSchema,
  TalkConfigParamsSchema,
  TalkConfigResultSchema,
  ChannelsStatusParamsSchema,
  ChannelsStatusResultSchema,
  TalkModeParamsSchema,
  WebLoginStartParamsSchema,
  WebLoginWaitParamsSchema,
} from "./channels.js";
import type {
  CommandArgChoiceSchema,
  CommandArgSchema,
  CommandCategorySchema,
  CommandEntrySchema,
  CommandsListParamsSchema,
  CommandsListResultSchema,
  CommandScopeSchema,
  CommandSourceSchema,
} from "./commands.js";
import type {
  ConfigApplyParamsSchema,
  ConfigGetParamsSchema,
  ConfigPatchParamsSchema,
  ConfigSchemaLookupParamsSchema,
  ConfigSchemaLookupResultSchema,
  ConfigSchemaParamsSchema,
  ConfigSchemaResponseSchema,
  ConfigSetParamsSchema,
  UpdateRunParamsSchema,
  UpdateStatusParamsSchema,
} from "./config.js";
import type {
  CronAddParamsSchema,
  CronJobSchema,
  CronListParamsSchema,
  CronRepairParamsSchema,
  CronRemoveParamsSchema,
  CronQueueControlParamsSchema,
  CronRunDetailParamsSchema,
  CronRunLogEntrySchema,
  CronRunParamsSchema,
  CronRunsParamsSchema,
  CronSourcesListParamsSchema,
  CronSourcesRemoveParamsSchema,
  CronSourcesUpdateParamsSchema,
  CronStatusParamsSchema,
  CronUpdateParamsSchema,
} from "./cron.js";
import type {
  DevicePairApproveParamsSchema,
  DevicePairListParamsSchema,
  DevicePairRemoveParamsSchema,
  DevicePairRejectParamsSchema,
  DeviceTokenRevokeParamsSchema,
  DeviceTokenRotateParamsSchema,
} from "./devices.js";
import type {
  ExecApprovalsGetParamsSchema,
  ExecApprovalsNodeGetParamsSchema,
  ExecApprovalsNodeSetParamsSchema,
  ExecApprovalsSetParamsSchema,
  ExecApprovalsSnapshotSchema,
  ExecApprovalGetParamsSchema,
  ExecApprovalListParamsSchema,
  ExecApprovalRequestParamsSchema,
  ExecApprovalResolveParamsSchema,
} from "./exec-approvals.js";
import type {
  ConnectParamsSchema,
  ErrorShapeSchema,
  EventFrameSchema,
  GatewayFrameSchema,
  HelloOkSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  ShutdownEventSchema,
  TickEventSchema,
} from "./frames.js";
import type {
  ChatAbortParamsSchema,
  ChatEventSchema,
  ChatInjectParamsSchema,
  LogsTailParamsSchema,
  LogsTailResultSchema,
} from "./logs-chat.js";
import type {
  NodeDescribeParamsSchema,
  NodeEventParamsSchema,
  NodeInvokeParamsSchema,
  NodeInvokeResultParamsSchema,
  NodeListParamsSchema,
  NodePendingAckParamsSchema,
  NodePendingDrainParamsSchema,
  NodePendingEnqueueParamsSchema,
  NodePendingPullParamsSchema,
  NodePairApproveParamsSchema,
  NodePairListParamsSchema,
  NodePairRejectParamsSchema,
  NodePairRemoveParamsSchema,
  NodePairRequestParamsSchema,
  NodePairVerifyParamsSchema,
  NodeRenameParamsSchema,
} from "./nodes.js";
import type { PushTestParamsSchema, PushTestResultSchema } from "./push.js";
import type {
  SessionCompactionCheckpointReasonSchema,
  SessionCompactionCheckpointSchema,
  SessionCompactionTranscriptReferenceSchema,
  SessionsCompactParamsSchema,
  SessionsCompactionBranchParamsSchema,
  SessionsCompactionGetParamsSchema,
  SessionsCompactionListParamsSchema,
  SessionsCompactionRestoreParamsSchema,
  SessionsDeleteParamsSchema,
  SessionsListParamsSchema,
  SessionsMessagesSubscribeParamsSchema,
  SessionsMessagesUnsubscribeParamsSchema,
  SessionsPatchParamsSchema,
  SessionsPreviewParamsSchema,
  SessionsResetParamsSchema,
  SessionsResolveParamsSchema,
  SessionsUsageParamsSchema,
} from "./sessions.js";
import type { PresenceEntrySchema, SnapshotSchema, StateVersionSchema } from "./snapshot.js";
import type {
  WizardCancelParamsSchema,
  WizardNextParamsSchema,
  WizardNextResultSchema,
  WizardStartParamsSchema,
  WizardStartResultSchema,
  WizardStatusParamsSchema,
  WizardStatusResultSchema,
  WizardStepSchema,
} from "./wizard.js";

export type ConnectParams = Static<typeof ConnectParamsSchema>;
export type HelloOk = Static<typeof HelloOkSchema>;
export type RequestFrame = Static<typeof RequestFrameSchema>;
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
export type EventFrame = Static<typeof EventFrameSchema>;
export type GatewayFrame = Static<typeof GatewayFrameSchema>;
export type Snapshot = Static<typeof SnapshotSchema>;
export type PresenceEntry = Static<typeof PresenceEntrySchema>;
export type ErrorShape = Static<typeof ErrorShapeSchema>;
export type StateVersion = Static<typeof StateVersionSchema>;
export type AgentEvent = Static<typeof AgentEventSchema>;
export type AgentIdentityParams = Static<typeof AgentIdentityParamsSchema>;
export type AgentIdentityResult = Static<typeof AgentIdentityResultSchema>;
export type PollParams = Static<typeof PollParamsSchema>;
export type AgentWaitParams = Static<typeof AgentWaitParamsSchema>;
export type WakeParams = Static<typeof WakeParamsSchema>;
export type NodePairRequestParams = Static<typeof NodePairRequestParamsSchema>;
export type NodePairListParams = Static<typeof NodePairListParamsSchema>;
export type NodePairApproveParams = Static<typeof NodePairApproveParamsSchema>;
export type NodePairRejectParams = Static<typeof NodePairRejectParamsSchema>;
export type NodePairRemoveParams = Static<typeof NodePairRemoveParamsSchema>;
export type NodePairVerifyParams = Static<typeof NodePairVerifyParamsSchema>;
export type NodeRenameParams = Static<typeof NodeRenameParamsSchema>;
export type NodeListParams = Static<typeof NodeListParamsSchema>;
export type NodeDescribeParams = Static<typeof NodeDescribeParamsSchema>;
export type NodePendingDrainParams = Static<typeof NodePendingDrainParamsSchema>;
export type NodePendingPullParams = Static<typeof NodePendingPullParamsSchema>;
export type NodePendingAckParams = Static<typeof NodePendingAckParamsSchema>;
export type NodePendingEnqueueParams = Static<typeof NodePendingEnqueueParamsSchema>;
export type NodeInvokeParams = Static<typeof NodeInvokeParamsSchema>;
export type NodeInvokeResultParams = Static<typeof NodeInvokeResultParamsSchema>;
export type NodeEventParams = Static<typeof NodeEventParamsSchema>;
export type PushTestParams = Static<typeof PushTestParamsSchema>;
export type PushTestResult = Static<typeof PushTestResultSchema>;
export type SessionsListParams = Static<typeof SessionsListParamsSchema>;
export type SessionsPreviewParams = Static<typeof SessionsPreviewParamsSchema>;
export type SessionsResolveParams = Static<typeof SessionsResolveParamsSchema>;
export type SessionsMessagesSubscribeParams = Static<typeof SessionsMessagesSubscribeParamsSchema>;
export type SessionsMessagesUnsubscribeParams = Static<
  typeof SessionsMessagesUnsubscribeParamsSchema
>;
export type SessionsPatchParams = Static<typeof SessionsPatchParamsSchema>;
export type SessionsResetParams = Static<typeof SessionsResetParamsSchema>;
export type SessionsDeleteParams = Static<typeof SessionsDeleteParamsSchema>;
export type SessionsCompactParams = Static<typeof SessionsCompactParamsSchema>;
export type SessionCompactionCheckpointReason = Static<
  typeof SessionCompactionCheckpointReasonSchema
>;
export type SessionCompactionTranscriptReference = Static<
  typeof SessionCompactionTranscriptReferenceSchema
>;
export type SessionCompactionCheckpoint = Static<typeof SessionCompactionCheckpointSchema>;
export type SessionsCompactionListParams = Static<typeof SessionsCompactionListParamsSchema>;
export type SessionsCompactionGetParams = Static<typeof SessionsCompactionGetParamsSchema>;
export type SessionsCompactionBranchParams = Static<typeof SessionsCompactionBranchParamsSchema>;
export type SessionsCompactionRestoreParams = Static<typeof SessionsCompactionRestoreParamsSchema>;
export type SessionsUsageParams = Static<typeof SessionsUsageParamsSchema>;
export type ConfigGetParams = Static<typeof ConfigGetParamsSchema>;
export type ConfigSetParams = Static<typeof ConfigSetParamsSchema>;
export type ConfigApplyParams = Static<typeof ConfigApplyParamsSchema>;
export type ConfigPatchParams = Static<typeof ConfigPatchParamsSchema>;
export type ConfigSchemaParams = Static<typeof ConfigSchemaParamsSchema>;
export type ConfigSchemaLookupParams = Static<typeof ConfigSchemaLookupParamsSchema>;
export type ConfigSchemaLookupResult = Static<typeof ConfigSchemaLookupResultSchema>;
export type ConfigSchemaResponse = Static<typeof ConfigSchemaResponseSchema>;
export type CommandSource = Static<typeof CommandSourceSchema>;
export type CommandScope = Static<typeof CommandScopeSchema>;
export type CommandCategory = Static<typeof CommandCategorySchema>;
export type CommandArgChoice = Static<typeof CommandArgChoiceSchema>;
export type CommandArg = Static<typeof CommandArgSchema>;
export type CommandEntry = Static<typeof CommandEntrySchema>;
export type CommandsListParams = Static<typeof CommandsListParamsSchema>;
export type CommandsListResult = Static<typeof CommandsListResultSchema>;
export type WizardStartParams = Static<typeof WizardStartParamsSchema>;
export type WizardNextParams = Static<typeof WizardNextParamsSchema>;
export type WizardCancelParams = Static<typeof WizardCancelParamsSchema>;
export type WizardStatusParams = Static<typeof WizardStatusParamsSchema>;
export type WizardStep = Static<typeof WizardStepSchema>;
export type WizardNextResult = Static<typeof WizardNextResultSchema>;
export type WizardStartResult = Static<typeof WizardStartResultSchema>;
export type WizardStatusResult = Static<typeof WizardStatusResultSchema>;
export type TalkModeParams = Static<typeof TalkModeParamsSchema>;
export type TalkConfigParams = Static<typeof TalkConfigParamsSchema>;
export type TalkConfigResult = Static<typeof TalkConfigResultSchema>;
export type ChannelsStatusParams = Static<typeof ChannelsStatusParamsSchema>;
export type ChannelsStatusResult = Static<typeof ChannelsStatusResultSchema>;
export type ChannelsLogoutParams = Static<typeof ChannelsLogoutParamsSchema>;
export type ChannelsRuntimeControlParams = Static<typeof ChannelsRuntimeControlParamsSchema>;
export type ChannelsRuntimeControlResult = Static<typeof ChannelsRuntimeControlResultSchema>;
export type WebLoginStartParams = Static<typeof WebLoginStartParamsSchema>;
export type WebLoginWaitParams = Static<typeof WebLoginWaitParamsSchema>;
export type AgentSummary = Static<typeof AgentSummarySchema>;
export type AgentsFileEntry = Static<typeof AgentsFileEntrySchema>;
export type AgentsCreateParams = Static<typeof AgentsCreateParamsSchema>;
export type AgentsCreateResult = Static<typeof AgentsCreateResultSchema>;
export type AgentsUpdateParams = Static<typeof AgentsUpdateParamsSchema>;
export type AgentsUpdateResult = Static<typeof AgentsUpdateResultSchema>;
export type AgentsDeleteParams = Static<typeof AgentsDeleteParamsSchema>;
export type AgentsDeleteResult = Static<typeof AgentsDeleteResultSchema>;
export type AgentsFilesListParams = Static<typeof AgentsFilesListParamsSchema>;
export type AgentsFilesListResult = Static<typeof AgentsFilesListResultSchema>;
export type AgentsFilesGetParams = Static<typeof AgentsFilesGetParamsSchema>;
export type AgentsFilesGetResult = Static<typeof AgentsFilesGetResultSchema>;
export type AgentsFilesSetParams = Static<typeof AgentsFilesSetParamsSchema>;
export type AgentsFilesSetResult = Static<typeof AgentsFilesSetResultSchema>;
export type AgentsListParams = Static<typeof AgentsListParamsSchema>;
export type AgentsListResult = Static<typeof AgentsListResultSchema>;
export type ModelChoice = Static<typeof ModelChoiceSchema>;
export type ModelsAuthStoreMode = Static<typeof ModelsAuthStoreModeSchema>;
export type ModelsAuthStoreParams = Static<typeof ModelsAuthStoreParamsSchema>;
export type ModelsAuthStoreResult = Static<typeof ModelsAuthStoreResultSchema>;
export type ModelsAuthConfigureParams = Static<typeof ModelsAuthConfigureParamsSchema>;
export type ModelsAuthConfigureResult = Static<typeof ModelsAuthConfigureResultSchema>;
export type ModelsAuthClearParams = Static<typeof ModelsAuthClearParamsSchema>;
export type ModelsAuthClearResult = Static<typeof ModelsAuthClearResultSchema>;
export type ModelsAuthInteractiveStartParams = Static<
  typeof ModelsAuthInteractiveStartParamsSchema
>;
export type ModelsAuthInteractiveStartResult = Static<
  typeof ModelsAuthInteractiveStartResultSchema
>;
export type ModelsAuthStatusParams = Static<typeof ModelsAuthStatusParamsSchema>;
export type ModelsAuthStatusEffective = Static<typeof ModelsAuthStatusEffectiveSchema>;
export type ModelsAuthStatusProfile = Static<typeof ModelsAuthStatusProfileSchema>;
export type ModelsAuthStatusProvider = Static<typeof ModelsAuthStatusProviderSchema>;
export type ModelsAuthStatusResult = Static<typeof ModelsAuthStatusResultSchema>;
export type ModelsCatalogStatusParams = Static<typeof ModelsCatalogStatusParamsSchema>;
export type ModelsCatalogStatusProvider = Static<typeof ModelsCatalogStatusProviderSchema>;
export type ModelsCatalogStatusResult = Static<typeof ModelsCatalogStatusResultSchema>;
export type ModelsListParams = Static<typeof ModelsListParamsSchema>;
export type ModelsListResult = Static<typeof ModelsListResultSchema>;
export type PluginMarketplaceAction = Static<typeof PluginMarketplaceActionSchema>;
export type PluginMarketplaceMutationAction = Static<typeof PluginMarketplaceMutationActionSchema>;
export type PluginMarketplaceAdminRpcActionMethod = Static<
  typeof PluginMarketplaceAdminRpcActionMethodSchema
>;
export type PluginMarketplaceAdminRpcActionGrantStatus = Static<
  typeof PluginMarketplaceAdminRpcActionGrantStatusSchema
>;
export type PluginMarketplaceAdminRpcActions = Static<
  typeof PluginMarketplaceAdminRpcActionsSchema
>;
export type PluginMarketplaceInstallRecord = Static<typeof PluginMarketplaceInstallRecordSchema>;
export type PluginMarketplaceInstallChoice = Static<typeof PluginMarketplaceInstallChoiceSchema>;
export type PluginMarketplaceInstallOptions = Static<typeof PluginMarketplaceInstallOptionsSchema>;
export type PluginMarketplaceChannelCatalogMeta = Static<
  typeof PluginMarketplaceChannelCatalogMetaSchema
>;
export type PluginMarketplaceRuntimeHelpers = Static<typeof PluginMarketplaceRuntimeHelpersSchema>;
export type PluginMarketplaceSourceTrust = Static<typeof PluginMarketplaceSourceTrustSchema>;
export type PluginMarketplacePermissionDiff = Static<typeof PluginMarketplacePermissionDiffSchema>;
export type PluginMarketplaceUpdateReview = Static<typeof PluginMarketplaceUpdateReviewSchema>;
export type PluginMarketplaceDiagnostic = Static<typeof PluginMarketplaceDiagnosticSchema>;
export type PluginMarketplaceEntry = Static<typeof PluginMarketplaceEntrySchema>;
export type PluginsMarketplaceListParams = Static<typeof PluginsMarketplaceListParamsSchema>;
export type PluginsMarketplaceListResult = Static<typeof PluginsMarketplaceListResultSchema>;
export type PluginsMarketplaceInfoParams = Static<typeof PluginsMarketplaceInfoParamsSchema>;
export type PluginsMarketplaceInfoResult = Static<typeof PluginsMarketplaceInfoResultSchema>;
export type PluginsMarketplaceAdminRpcGrantSetParams = Static<
  typeof PluginsMarketplaceAdminRpcGrantSetParamsSchema
>;
export type PluginsMarketplaceInstallParams = Static<typeof PluginsMarketplaceInstallParamsSchema>;
export type PluginsMarketplaceRestartParams = Static<typeof PluginsMarketplaceRestartParamsSchema>;
export type PluginsMarketplaceRuntimeHelperSetParams = Static<
  typeof PluginsMarketplaceRuntimeHelperSetParamsSchema
>;
export type PluginsMarketplaceUpdateParams = Static<typeof PluginsMarketplaceUpdateParamsSchema>;
export type PluginsMarketplaceUpdatePreviewParams = Static<
  typeof PluginsMarketplaceUpdatePreviewParamsSchema
>;
export type PluginsMarketplaceUninstallParams = Static<
  typeof PluginsMarketplaceUninstallParamsSchema
>;
export type PluginMarketplaceMutationResult = Static<typeof PluginMarketplaceMutationResultSchema>;
export type PluginMarketplaceUpdatePreviewResult = Static<
  typeof PluginMarketplaceUpdatePreviewResultSchema
>;
export type SkillsStatusParams = Static<typeof SkillsStatusParamsSchema>;
export type ToolsCatalogParams = Static<typeof ToolsCatalogParamsSchema>;
export type ToolCatalogProfile = Static<typeof ToolCatalogProfileSchema>;
export type ToolCatalogEntry = Static<typeof ToolCatalogEntrySchema>;
export type ToolCatalogGroup = Static<typeof ToolCatalogGroupSchema>;
export type ToolsCatalogResult = Static<typeof ToolsCatalogResultSchema>;
export type ToolsEffectiveParams = Static<typeof ToolsEffectiveParamsSchema>;
export type ToolEffectiveSource = Static<typeof ToolEffectiveSourceSchema>;
export type ToolEffectiveEntry = Static<typeof ToolEffectiveEntrySchema>;
export type ToolEffectiveGroup = Static<typeof ToolEffectiveGroupSchema>;
export type ToolsEffectiveResult = Static<typeof ToolsEffectiveResultSchema>;
export type SkillsBinsParams = Static<typeof SkillsBinsParamsSchema>;
export type SkillsBinsResult = Static<typeof SkillsBinsResultSchema>;
export type SkillsCopyParams = Static<typeof SkillsCopyParamsSchema>;
export type SkillsCopyResult = Static<typeof SkillsCopyResultSchema>;
export type SkillsCreateParams = Static<typeof SkillsCreateParamsSchema>;
export type SkillsCreateResult = Static<typeof SkillsCreateResultSchema>;
export type SkillsSearchParams = Static<typeof SkillsSearchParamsSchema>;
export type SkillsSearchResult = Static<typeof SkillsSearchResultSchema>;
export type SkillsDetailParams = Static<typeof SkillsDetailParamsSchema>;
export type SkillsDetailResult = Static<typeof SkillsDetailResultSchema>;
export type SkillsFileGetParams = Static<typeof SkillsFileGetParamsSchema>;
export type SkillsFileGetResult = Static<typeof SkillsFileGetResultSchema>;
export type SkillsFileSetParams = Static<typeof SkillsFileSetParamsSchema>;
export type SkillsFileSetResult = Static<typeof SkillsFileSetResultSchema>;
export type SkillsMarketplaceInstallPreviewParams = Static<
  typeof SkillsMarketplaceInstallPreviewParamsSchema
>;
export type SkillsMarketplaceInstallPreviewResult = Static<
  typeof SkillsMarketplaceInstallPreviewResultSchema
>;
export type SkillsMarketplaceInstallParams = Static<typeof SkillsMarketplaceInstallParamsSchema>;
export type SkillsMarketplaceInstallResult = Static<typeof SkillsMarketplaceInstallResultSchema>;
export type SkillsMarketplaceUpdatePreviewParams = Static<
  typeof SkillsMarketplaceUpdatePreviewParamsSchema
>;
export type SkillsMarketplaceUpdatePreviewResult = Static<
  typeof SkillsMarketplaceUpdatePreviewResultSchema
>;
export type SkillsMarketplaceUpdateParams = Static<typeof SkillsMarketplaceUpdateParamsSchema>;
export type SkillsMarketplaceUpdateResult = Static<typeof SkillsMarketplaceUpdateResultSchema>;
export type SkillsWalletGrantsParams = Static<typeof SkillsWalletGrantsParamsSchema>;
export type SkillsWalletGrantsResult = Static<typeof SkillsWalletGrantsResultSchema>;
export type SkillsWalletGrantSetParams = Static<typeof SkillsWalletGrantSetParamsSchema>;
export type SkillsWalletGrantSetResult = Static<typeof SkillsWalletGrantSetResultSchema>;
export type SkillsWalletGrantClearParams = Static<typeof SkillsWalletGrantClearParamsSchema>;
export type SkillsWalletGrantClearResult = Static<typeof SkillsWalletGrantClearResultSchema>;
export type SkillsInstallParams = Static<typeof SkillsInstallParamsSchema>;
export type SkillsUpdateParams = Static<typeof SkillsUpdateParamsSchema>;
export type CronJob = Static<typeof CronJobSchema>;
export type CronListParams = Static<typeof CronListParamsSchema>;
export type CronStatusParams = Static<typeof CronStatusParamsSchema>;
export type CronAddParams = Static<typeof CronAddParamsSchema>;
export type CronUpdateParams = Static<typeof CronUpdateParamsSchema>;
export type CronRepairParams = Static<typeof CronRepairParamsSchema>;
export type CronRemoveParams = Static<typeof CronRemoveParamsSchema>;
export type CronQueueControlParams = Static<typeof CronQueueControlParamsSchema>;
export type CronRunDetailParams = Static<typeof CronRunDetailParamsSchema>;
export type CronRunParams = Static<typeof CronRunParamsSchema>;
export type CronRunsParams = Static<typeof CronRunsParamsSchema>;
export type CronSourcesListParams = Static<typeof CronSourcesListParamsSchema>;
export type CronSourcesUpdateParams = Static<typeof CronSourcesUpdateParamsSchema>;
export type CronSourcesRemoveParams = Static<typeof CronSourcesRemoveParamsSchema>;
export type CronRunLogEntry = Static<typeof CronRunLogEntrySchema>;
export type LogsTailParams = Static<typeof LogsTailParamsSchema>;
export type LogsTailResult = Static<typeof LogsTailResultSchema>;
export type ExecApprovalsGetParams = Static<typeof ExecApprovalsGetParamsSchema>;
export type ExecApprovalsSetParams = Static<typeof ExecApprovalsSetParamsSchema>;
export type ExecApprovalsNodeGetParams = Static<typeof ExecApprovalsNodeGetParamsSchema>;
export type ExecApprovalsNodeSetParams = Static<typeof ExecApprovalsNodeSetParamsSchema>;
export type ExecApprovalsSnapshot = Static<typeof ExecApprovalsSnapshotSchema>;
export type ExecApprovalGetParams = Static<typeof ExecApprovalGetParamsSchema>;
export type ExecApprovalListParams = Static<typeof ExecApprovalListParamsSchema>;
export type ExecApprovalRequestParams = Static<typeof ExecApprovalRequestParamsSchema>;
export type ExecApprovalResolveParams = Static<typeof ExecApprovalResolveParamsSchema>;
export type DevicePairListParams = Static<typeof DevicePairListParamsSchema>;
export type DevicePairApproveParams = Static<typeof DevicePairApproveParamsSchema>;
export type DevicePairRejectParams = Static<typeof DevicePairRejectParamsSchema>;
export type DevicePairRemoveParams = Static<typeof DevicePairRemoveParamsSchema>;
export type DeviceTokenRotateParams = Static<typeof DeviceTokenRotateParamsSchema>;
export type DeviceTokenRevokeParams = Static<typeof DeviceTokenRevokeParamsSchema>;
export type ChatAbortParams = Static<typeof ChatAbortParamsSchema>;
export type ChatInjectParams = Static<typeof ChatInjectParamsSchema>;
export type ChatEvent = Static<typeof ChatEventSchema>;
export type UpdateRunParams = Static<typeof UpdateRunParamsSchema>;
export type UpdateStatusParams = Static<typeof UpdateStatusParamsSchema>;
export type TickEvent = Static<typeof TickEventSchema>;
export type ShutdownEvent = Static<typeof ShutdownEventSchema>;
